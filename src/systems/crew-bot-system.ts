import { createSystem } from '@iwsdk/core';
import type { PoseSample } from '../net/pose-codec.js';
import { angleAroundAxle, CRANK_CENTER, HANDLE_X } from '../scene-assets/crank.scene-asset.js';
import { nearestOnRope, ROPE_RUN, ROPE_X, ROPE_Z0 } from '../scene-assets/rope.scene-asset.js';
import { settings } from '../settings.js';
import {
  crankFollowAngle,
  interceptPoint,
  HaulRhythm,
  stepTowards,
  throwFlightTime,
  throwVelocity,
} from '../sim/crew-bot.js';
import { CrankSystem } from './crank-system.js';
import { FLAG_LEFT_CRANK, FLAG_LEFT_ROPE, FLAG_RIGHT_CRANK, FLAG_RIGHT_ROPE, netLink } from './net-system.js';
import { RopeSystem } from './rope-system.js';
import { bell } from './route-system.js';
import { crewReady, moored, route } from './ship-system.js';
import { type ObjectView, type TestHand, ThrowablesSystem } from './throwables-system.js';

type Vec3 = [number, number, number];
type Mode = 'idle' | 'crank' | 'rope';
type ThrowPhase = 'ready' | 'catching' | 'holding' | 'windup' | 'swing';
const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];

/** Eye height, m, and how fast the bot walks about the deck, m/s. */
const EYE_HEIGHT = 1.6;
const WALK_SPEED = 1.5;
/** Where the bot waits for a throw: the starboard bow, or the port stern when the player stands there. */
const WAIT_SPOTS: readonly Vec3[] = [
  [0.55, EYE_HEIGHT, -0.7],
  [-0.45, EYE_HEIGHT, 0.95],
];
/** How long the player must have let go of the crank or line before the bot does, ms (packets can drop a frame). */
const LET_GO_MS = 400;
/** How long the bot holds a caught brick before throwing it back, and the throw's wind-up and swing, ms. */
const HOLD_MS = 1500;
const WINDUP_MS = 300;
const SWING_MS = 250;
/** A brick counts as thrown when it moves faster than this, m/s. */
const FLYING_SPEED = 1.5;
const HAND_SPEED = 4;
const CATCH_TIMEOUT_MS = 1000;

/**
 * The practice crewmate: with "This page plays as: Practice crewmate" in
 * Settings, this page joins the crew as a bot second player, so one person
 * can test the parts of the game that need two (with the bot's page on a PC
 * and the player in the headset). It
 *
 * - rings the bell on island A once the player has, so the ship casts off;
 * - takes the other crank handle whenever the player cranks, and turns it in
 *   step (the player's hand angle plus half a turn, moved on by the crank's
 *   speed since that hand was drawn), so the crank clicks into high gear;
 * - hauls the mooring line beside the player's hands, keeping time with
 *   their strokes (src/sim/crew-bot.ts, HaulRhythm), so the pair heaves;
 * - otherwise stands on deck facing the player, reaches for a brick thrown
 *   near it, and throws it back to their chest after a moment.
 *
 * It works the controls through the same scripted hands the two-player tests
 * use, so the player sees its hands on the handles and the line, and its
 * avatar walks to each job. The page must stay showing (a hidden tab counts
 * as a crewmate who stepped away, and stops).
 */
export class CrewBotSystem extends createSystem({}) {
  private crank: CrankSystem | undefined;
  private rope: RopeSystem | undefined;
  private throws: ThrowablesSystem | undefined;
  private mode: Mode = 'idle';
  /** What the bot has done, for tests and the console. */
  private stats = { rings: 0, catches: 0, throws: 0 };
  private modeSet = false;
  private lastRing = Number.NEGATIVE_INFINITY;

  // The bot's head, where it's walking to, and the way it faces.
  private head: Vec3 = [WAIT_SPOTS[0][0], WAIT_SPOTS[0][1], WAIT_SPOTS[0][2]];
  private headTarget: Vec3 = [WAIT_SPOTS[0][0], WAIT_SPOTS[0][1], WAIT_SPOTS[0][2]];
  private yaw = 0;
  private headPose: PoseSample = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };

  // Crank: the player's hand as last drawn.
  private lastCrankMs = Number.NEGATIVE_INFINITY;
  private botHandle = -1;
  private crankAngle = 0;
  private crankAtMs = 0;
  private readonly crankHand = (nowMs: number): number =>
    crankFollowAngle(this.crankAngle, this.crank?.sim.omega ?? 0, nowMs - this.crankAtMs);

  // Line: the player's hands as last drawn, and where the bot's go.
  private lastRopeMs = Number.NEGATIVE_INFINITY;
  private haul = new HaulRhythm(ROPE_RUN);
  private readonly ropeHands: Record<Side, (nowMs: number) => number | null> = {
    left: (nowMs) => this.haul.botAlong('left', nowMs),
    right: (nowMs) => this.haul.botAlong('right', nowMs),
  };
  private readonly ropeRests: Record<Side, (nowMs: number) => number | null> = {
    left: (nowMs) => this.haul.botRest('left', nowMs),
    right: (nowMs) => this.haul.botRest('right', nowMs),
  };

  // Catching and throwing.
  private phase: ThrowPhase = 'ready';
  private phaseSince = 0;
  private catching = -1;
  private rest: Vec3 = [0, 0, 0];
  private leftRest: Vec3 = [0, 0, 0];
  private hand: Vec3 = [0, 0, 0];
  private handGoal: Vec3 = [0, 0, 0];
  private squeeze = false;
  private throwFrom: Vec3 = [0, 0, 0];
  private throwStart: Vec3 = [0, 0, 0];
  private throwVel: Vec3 = [0, 0, 0];
  private released = false;
  private view: ObjectView = { remote: false, heldBy: null, remoteHeld: false, pos: [0, 0, 0], speed: 0 };
  private prevPos: Vec3[] = [];
  private vel: Vec3 = [0, 0, 0];
  private aim: Vec3 = [0, 0, 0];
  private rightOut: TestHand = { x: 0, y: 0, z: 0, squeeze: false };
  private leftOut: TestHand = { x: 0, y: 0, z: 0, squeeze: false };
  private readonly rightHand = (nowMs: number): TestHand => this.throwHand(nowMs);
  private readonly leftHand = (): TestHand => {
    this.leftOut.x = this.leftRest[0];
    this.leftOut.y = this.leftRest[1];
    this.leftOut.z = this.leftRest[2];
    return this.leftOut;
  };

  init(): void {
    if (!settings.bot) {
      return;
    }
    console.info('[Bot] this page plays as the practice crewmate');
    netLink.headOverride = () => {
      const p = this.headPose;
      p.px = this.head[0];
      p.py = this.head[1];
      p.pz = this.head[2];
      p.qx = 0;
      p.qy = Math.sin(this.yaw / 2);
      p.qz = 0;
      p.qw = Math.cos(this.yaw / 2);
      return p;
    };
    this.cleanupFuncs.push(() => {
      netLink.headOverride = null;
    });
    const self = this;
    (window as { __bot?: unknown }).__bot = {
      get mode() { return self.mode; },
      get head() { return [...self.head]; },
      get crank() { return { angle: self.crankAngle, age: performance.now() - self.crankAtMs, handle: self.botHandle }; },
      haul: this.haul,
      stats: this.stats,
    };
  }

  update(delta: number): void {
    if (!settings.bot) {
      return;
    }
    this.crank ??= this.world.getSystem(CrankSystem);
    this.rope ??= this.world.getSystem(RopeSystem);
    this.throws ??= this.world.getSystem(ThrowablesSystem);
    const now = performance.now();
    const dt = Math.min(delta, 0.1);
    if (!netLink.connected) {
      this.setMode('idle');
      return;
    }
    if (netLink.haveRemote) {
      this.readPlayer(now);
    }
    this.ringWhenReady(now);
    const mode: Mode = now - this.lastCrankMs < LET_GO_MS ? 'crank' : now - this.lastRopeMs < LET_GO_MS ? 'rope' : 'idle';
    this.setMode(mode);
    if (mode === 'idle') {
      this.chooseWaitSpot();
    }
    if (mode === 'rope') {
      this.haul.update(now);
    }
    this.holdOn();
    this.walk(dt);
    this.placeHands();
    if (mode === 'idle') {
      this.catchAndThrow(now, dt);
    }
  }

  /** What the player is doing with the crank and the line, from their latest drawn pose. */
  private readPlayer(now: number): void {
    const r = netLink.remote;
    const at = netLink.remoteAtMs;
    const crankBits = r.flags & (FLAG_LEFT_CRANK | FLAG_RIGHT_CRANK);
    if (crankBits) {
      const hand = crankBits & FLAG_LEFT_CRANK ? r.left : r.right;
      // The handle the player holds is the one their hand is beside (a hand
      // drawn mid-way as it lets go keeps the last one).
      const near = Math.abs(hand.px - CRANK_CENTER[0] - HANDLE_X[0]) < 0.2 ? 0 : Math.abs(hand.px - CRANK_CENTER[0] - HANDLE_X[1]) < 0.2 ? 1 : -1;
      if (near >= 0) {
        const handle = 1 - near;
        this.crankAngle = angleAroundAxle(hand.py, hand.pz);
        this.crankAtMs = at;
        this.lastCrankMs = now;
        if (handle !== this.botHandle && this.mode === 'crank') {
          // The player moved to the other handle: swap.
          this.crank?.setScriptedHand(this.botHandle, null);
          this.crank?.setScriptedHand(handle, this.crankHand);
        }
        this.botHandle = handle;
      }
    }
    for (const side of SIDES) {
      const bit = side === 'left' ? FLAG_LEFT_ROPE : FLAG_RIGHT_ROPE;
      const pose = side === 'left' ? r.left : r.right;
      const holding = (r.flags & bit) !== 0;
      this.haul.observe(side, holding, holding ? nearestOnRope(pose.px, pose.py, pose.pz).along : 0, at);
      if (holding) {
        this.lastRopeMs = now;
      }
    }
  }

  /** On island A, ring the bell once the player has, so the ship casts off when they're ready. */
  private ringWhenReady(now: number): void {
    if (route.phase !== 'ready' || !moored() || now - this.lastRing < 1500) {
      return;
    }
    const mine = netLink.isHost ? crewReady.host : crewReady.guest;
    const theirs = netLink.isHost ? crewReady.guest : crewReady.host;
    if (theirs && !mine) {
      this.lastRing = now;
      this.stats.rings++;
      console.info('[Bot] ringing the bell: ready to cast off');
      bell.ring();
    }
  }

  private setMode(mode: Mode): void {
    if (mode === this.mode && this.modeSet) {
      return;
    }
    this.modeSet = true;
    console.info(`[Bot] ${mode === 'crank' ? 'cranking with you' : mode === 'rope' ? 'hauling the line with you' : 'waiting for a throw'}`);
    this.mode = mode;
    for (let h = 0; h < 2; h++) {
      this.crank?.setScriptedHand(h, null);
    }
    for (const side of SIDES) {
      this.rope?.setScriptedHand(side, null);
      this.throws?.setScriptedHand(side, null);
    }
    this.phase = 'ready';
    this.squeeze = false;
    this.catching = -1;
    if (mode === 'crank' && this.botHandle >= 0) {
      this.crank?.setScriptedHand(this.botHandle, this.crankHand);
      // Beside its handle, facing the axle.
      const side = this.botHandle === 0 ? -1 : 1;
      this.setHeadTarget(CRANK_CENTER[0] + side * 0.8, CRANK_CENTER[2]);
      this.yaw = Math.atan2(side, 0);
    } else if (mode === 'rope') {
      for (const side of SIDES) {
        this.rope?.setScriptedHand(side, this.ropeHands[side], this.ropeRests[side]);
      }
    } else {
      this.copyRest(this.hand);
      this.throws?.setScriptedHand('right', this.rightHand);
      this.throws?.setScriptedHand('left', this.leftHand);
    }
  }

  /** Take hold again of a crank handle or the line that slipped from the bot's hand. */
  private holdOn(): void {
    if (this.mode === 'crank' && this.botHandle >= 0) {
      this.crank?.setScriptedHand(this.botHandle, this.crankHand);
    } else if (this.mode === 'rope') {
      for (const side of SIDES) {
        this.rope?.setScriptedHand(side, this.ropeHands[side], this.ropeRests[side]);
      }
    }
  }

  private setHeadTarget(x: number, z: number): void {
    this.headTarget[0] = x;
    this.headTarget[1] = EYE_HEIGHT;
    this.headTarget[2] = z;
  }

  /** While waiting for throws, stand at the end of the deck away from the player, facing them. */
  private chooseWaitSpot(): void {
    const p = netLink.remote.head;
    const near = Math.hypot(p.px - WAIT_SPOTS[0][0], p.pz - WAIT_SPOTS[0][2]) < 1;
    const spot = WAIT_SPOTS[near ? 1 : 0];
    this.setHeadTarget(spot[0], spot[2]);
    this.yaw = Math.atan2(-(p.px - this.head[0]), -(p.pz - this.head[2]));
  }

  private walk(dt: number): void {
    if (this.mode === 'rope') {
      // Inboard of the line, level with the bot's hands on it.
      let sum = 0;
      let n = 0;
      for (const side of SIDES) {
        const along = this.haul.botAlong(side, performance.now()) ?? this.haul.botRest(side, performance.now());
        if (along !== null) {
          sum += along;
          n++;
        }
      }
      if (n > 0) {
        this.setHeadTarget(ROPE_X + 0.45, ROPE_Z0 + sum / n);
      }
      this.yaw = Math.PI / 2;
    }
    stepTowards(this.head, this.headTarget, WALK_SPEED * dt);
  }

  /** Resting hands: in front of the chest, the right a little out. */
  private placeHands(): void {
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    // Right of facing is (−fz, fx).
    this.rest[0] = this.head[0] + fx * 0.4 - fz * 0.15;
    this.rest[1] = this.head[1] - 0.4;
    this.rest[2] = this.head[2] + fz * 0.4 + fx * 0.15;
    this.leftRest[0] = this.head[0] + fx * 0.3 + fz * 0.2;
    this.leftRest[1] = this.head[1] - 0.45;
    this.leftRest[2] = this.head[2] + fz * 0.3 - fx * 0.2;
  }

  private copyRest(out: Vec3): void {
    out[0] = this.rest[0];
    out[1] = this.rest[1];
    out[2] = this.rest[2];
  }

  /** Reach for a brick thrown its way, hold it a moment, throw it back to the player's chest. */
  private catchAndThrow(now: number, dt: number): void {
    const throws = this.throws;
    if (!throws) {
      return;
    }
    const t = now - this.phaseSince;
    // Each brick's velocity from its last two positions.
    for (let id = 0; id < throws.objectCount; id++) {
      this.prevPos[id] ??= [Number.NaN, 0, 0];
    }
    let holding = -1;
    let target = -1;
    for (let id = 0; id < throws.objectCount; id++) {
      throws.readObject(id, this.view);
      const v = this.view;
      const prev = this.prevPos[id];
      if (v.heldBy === 'right') {
        holding = id;
      }
      if (!Number.isNaN(prev[0]) && dt > 0 && (this.phase === 'ready' || id === this.catching) && target < 0) {
        this.vel[0] = (v.pos[0] - prev[0]) / dt;
        this.vel[1] = (v.pos[1] - prev[1]) / dt;
        this.vel[2] = (v.pos[2] - prev[2]) / dt;
        if (v.remote && !v.remoteHeld && v.speed > FLYING_SPEED && interceptPoint(v.pos, this.vel, this.rest, this.aim)) {
          target = id;
          this.handGoal[0] = this.aim[0];
          this.handGoal[1] = this.aim[1];
          this.handGoal[2] = this.aim[2];
        }
      }
      prev[0] = v.pos[0];
      prev[1] = v.pos[1];
      prev[2] = v.pos[2];
    }

    switch (this.phase) {
      case 'ready':
        this.copyRest(this.handGoal);
        if (holding >= 0) {
          this.setPhase(now, 'holding');
        } else if (target >= 0) {
          this.catching = target;
          this.squeeze = true;
          this.setPhase(now, 'catching');
        }
        break;
      case 'catching':
        if (holding >= 0) {
          this.stats.catches++;
          console.info('[Bot] caught it');
          this.setPhase(now, 'holding');
        } else if (t > CATCH_TIMEOUT_MS) {
          this.squeeze = false;
          this.catching = -1;
          this.setPhase(now, 'ready');
        } else if (target < 0) {
          this.copyRest(this.handGoal);
        }
        break;
      case 'holding':
        this.copyRest(this.handGoal);
        if (holding < 0) {
          this.squeeze = false;
          this.setPhase(now, 'ready');
        } else if (t > HOLD_MS) {
          this.aimThrow();
          this.throwFrom[0] = this.hand[0];
          this.throwFrom[1] = this.hand[1];
          this.throwFrom[2] = this.hand[2];
          this.setPhase(now, 'windup');
        }
        break;
      case 'windup':
        if (t > WINDUP_MS) {
          this.setPhase(now, 'swing');
        }
        break;
      case 'swing':
        if (this.released) {
          this.released = false;
          this.squeeze = false;
          this.catching = -1;
          this.copyRest(this.hand);
          this.stats.throws++;
          console.info('[Bot] threw it back');
          this.setPhase(now, 'ready');
        }
        break;
    }
    if (this.phase === 'ready' || this.phase === 'catching' || this.phase === 'holding') {
      stepTowards(this.hand, this.handGoal, HAND_SPEED * dt);
    }
  }

  private setPhase(now: number, phase: ThrowPhase): void {
    this.phase = phase;
    this.phaseSince = now;
  }

  /** Throw from the resting hand to just in front of the player's chest. */
  private aimThrow(): void {
    const p = netLink.remote.head;
    const dx = this.head[0] - p.px;
    const dz = this.head[2] - p.pz;
    const flat = Math.hypot(dx, dz) || 1;
    this.aim[0] = p.px + (dx / flat) * 0.3;
    this.aim[1] = p.py - 0.45;
    this.aim[2] = p.pz + (dz / flat) * 0.3;
    const distance = Math.hypot(this.aim[0] - this.rest[0], this.aim[1] - this.rest[1], this.aim[2] - this.rest[2]);
    throwVelocity(this.rest, this.aim, throwFlightTime(distance), this.throwVel);
    for (let i = 0; i < 3; i++) {
      this.throwStart[i] = this.rest[i] - (this.throwVel[i] * SWING_MS) / 1000;
    }
  }

  /** The right hand as the throwables system reads it: resting, reaching, winding up or swinging through the release. */
  private throwHand(nowMs: number): TestHand {
    const o = this.rightOut;
    const t = nowMs - this.phaseSince;
    let squeeze = this.squeeze;
    if (this.phase === 'windup') {
      const k = Math.min(1, t / WINDUP_MS);
      o.x = this.throwFrom[0] + (this.throwStart[0] - this.throwFrom[0]) * k;
      o.y = this.throwFrom[1] + (this.throwStart[1] - this.throwFrom[1]) * k;
      o.z = this.throwFrom[2] + (this.throwStart[2] - this.throwFrom[2]) * k;
      squeeze = true;
    } else if (this.phase === 'swing') {
      // The hand keeps moving through the release, as a real arm does, and
      // lets go in the frame the game reads it.
      const k = t / 1000;
      o.x = this.throwStart[0] + this.throwVel[0] * k;
      o.y = this.throwStart[1] + this.throwVel[1] * k;
      o.z = this.throwStart[2] + this.throwVel[2] * k;
      squeeze = t < SWING_MS;
      if (!squeeze) {
        this.released = true;
      }
    } else {
      o.x = this.hand[0];
      o.y = this.hand[1];
      o.z = this.hand[2];
    }
    o.squeeze = squeeze;
    return o;
  }
}
