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
  tearStand,
  throwFlightTime,
  throwVelocity,
  viaLadder,
} from '../sim/crew-bot.js';
import { EDGE_DROP, type Point, slitPoint, TEAR_SPOTS } from '../sim/envelope.js';
import { type LookoutCall, lookoutCall, toPassage } from '../sim/passages.js';
import { ROUTE } from '../world/route-world.js';
import { LADDER_X, LADDER_Z, LOFT_EYE, LOFT_FLOOR } from '../sim/loft.js';
import { CrankSystem } from './crank-system.js';
import { FLAG_LEFT_CRANK, FLAG_LEFT_ROPE, FLAG_RIGHT_CRANK, FLAG_RIGHT_ROPE, netLink } from './net-system.js';
import { RopeSystem } from './rope-system.js';
import { bell } from './route-system.js';
import { type RepairHand, type RepairHandPose, RepairSystem } from './repair-system.js';
import { cargo, crewReady, docking, envelope, moored, route, ship, storm, yard } from './ship-system.js';
import { type ScriptHand, StowageSystem } from './stowage-system.js';
import { type ObjectView, type TestHand, ThrowablesSystem } from './throwables-system.js';
import { handleAt } from '../sim/stowage.js';
import { DECK_LENGTH, DECK_WIDTH, PUMP, PUMP_LEVER, PUMP_SWING, pumpHandle } from '../sim/gondola-layout.js';
import { type PumpHand, type PumpHandPose, PumpSystem, pumpView } from './pump-system.js';

type Vec3 = [number, number, number];
type Mode = 'idle' | 'crank' | 'rope' | 'crate' | 'repair' | 'lookout' | 'pump';
type ThrowPhase = 'ready' | 'catching' | 'holding' | 'windup' | 'swing';
const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];

/** Eye height, m, and how fast the bot walks about the deck, m/s. */
const EYE_HEIGHT = 1.6;
const WALK_SPEED = 1.5;
/** How fast it climbs the ladder to the patch loft, m/s. */
const CLIMB_SPEED = 0.8;
/** Where the bot waits for a throw: the starboard bow, or the port stern when the player stands there. */
const WAIT_SPOTS: readonly Vec3[] = [
  [0.55, EYE_HEIGHT, -0.7],
  [-0.45, EYE_HEIGHT, 0.95],
];
/** How long the player must have let go of the crank or line before the bot does, ms (packets can drop a frame). */
const LET_GO_MS = 400;
/** The same for the line, longer: hauling on the call, a player can have both hands off it between strokes, ms. */
const ROPE_LET_GO_MS = 1500;
/** How long the bot holds a caught brick before throwing it back, and the throw's wind-up and swing, ms. */
const HOLD_MS = 1500;
const WINDUP_MS = 300;
const SWING_MS = 250;
/** A brick counts as thrown when it moves faster than this, m/s. */
const FLYING_SPEED = 1.5;
const HAND_SPEED = 4;
const CATCH_TIMEOUT_MS = 1000;
/** Where along a tear's slit the bot's hands hold it shut (0 to 1), wide enough apart to close the shortest. */
const TEAR_HOLD_T = [0.15, 0.85] as const;
/**
 * The bilge (docs/storms-and-night.md): the bot starts pumping at this many
 * litres and keeps on until it is down to the next; with this many it
 * pumps rather than cranks. It works the lever this many strokes a second,
 * standing inboard of the handle.
 */
const PUMP_FROM = 25;
const PUMP_UNTIL = 3;
const PUMP_URGENT = 60;
const PUMP_STROKES = 0.9;
const PUMP_STAND = [PUMP[0] - PUMP_LEVER - 0.38, PUMP[1]] as const;
/** A hand squeezing on a tear's edge that doesn't take hold in this long lets go to try again, ms. */
const REGRAB_MS = 300;
/** Where the lookout stands: at the bow rail, in the middle. */
const LOOKOUT_SPOT: Vec3 = [0, EYE_HEIGHT, -1.15];
/** The lookout calls no more often than this, and calls the same thing again after this long, ms. */
const CALL_GAP_MS = 900;
const CALL_REPEAT_MS = 2500;
/** Where the lookout's right hand points for each call, from its head (facing the bow, starboard +x). */
const POINT: Record<LookoutCall, Vec3> = {
  UP: [0.2, 0.3, -0.15],
  DOWN: [0.2, -0.75, -0.45],
  PORT: [-0.6, -0.15, -0.3],
  STARBOARD: [0.6, -0.15, -0.3],
  STEADY: [0.15, -0.4, -0.4],
};

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
 *   the ship's haul call (src/sim/crew-bot.ts, HaulRhythm), so a player who
 *   strokes on the call heaves with it;
 * - takes the other handle of a crate the player holds by one, and moves
 *   its hand as the player's does, so the two of them carry it together;
 * - climbs to the patch loft when the player goes up while the envelope is
 *   torn, and holds the tear nearest them shut with both hands, so the
 *   player can patch and rivet it (docs/repairs.md);
 * - approaching a narrow passage or a rock arch, lets go of the crank and
 *   looks out from the bow rail, calling (and pointing) up, down, port,
 *   starboard or steady as the ship lines up and goes through
 *   (docs/passages.md);
 * - with water in the bilge (a storm, docs/storms-and-night.md), works
 *   the bilge pump from 25 litres until it is nearly dry, before the crank
 *   once it is deep (60 litres);
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
  private stowage: StowageSystem | undefined;
  private throws: ThrowablesSystem | undefined;
  private repairs: RepairSystem | undefined;
  private pump: PumpSystem | undefined;
  private mode: Mode = 'idle';
  /** What the bot has done, for tests and the console. */
  private stats = { rings: 0, catches: 0, throws: 0, calls: 0, pumped: 0 };
  private modeSet = false;
  private lastRing = Number.NEGATIVE_INFINITY;

  // The bot's head, where it's walking to, and the way it faces.
  private head: Vec3 = [WAIT_SPOTS[0][0], WAIT_SPOTS[0][1], WAIT_SPOTS[0][2]];
  private headTarget: Vec3 = [WAIT_SPOTS[0][0], WAIT_SPOTS[0][1], WAIT_SPOTS[0][2]];
  private waypoint: Vec3 = [0, 0, 0];
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

  // Crates: the one the player holds by one handle, which handle is theirs, and their hand on it as last drawn.
  private lastCrateMs = Number.NEGATIVE_INFINITY;
  private crate = -1;
  private crateHandle = 0;
  // Looking out: the call it last made, and when.
  private call: LookoutCall | null = null;
  private lastCall: LookoutCall | null = null;
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private pointGoal: Vec3 = [0, 0, 0];
  private where = { u: 0, w: 0 };
  private playerHand: Vec3 = [0, 0, 0];
  private cratePose = { x: 0, y: 0, z: 0, yaw: 0 };
  private handleA = { x: 0, y: 0, z: 0 };
  private handleB = { x: 0, y: 0, z: 0 };
  private crateOut: ScriptHand[] = [{ crate: 0, handle: 0, x: 0, y: 0, z: 0 }];
  private crateHandPose: PoseSample = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  private readonly crateHands = (): ScriptHand[] => this.crateHand();
  private readonly crateHandOverride = (): PoseSample => {
    const out = this.crateOut[0];
    const p = this.crateHandPose;
    p.px = out.x;
    p.py = out.y;
    p.pz = out.z;
    return p;
  };

  // Holding a tear shut on the patch loft.
  private lastRepairMs = Number.NEGATIVE_INFINITY;
  private repairSpot = -1;
  private stand: [number, number] = [0, 0];
  private edge: Point = { x: 0, y: 0, z: 0 };
  private repairGoal: Vec3 = [0, 0, 0];
  private repairPos: Record<Side, Vec3> = { left: [0, 0, 0], right: [0, 0, 0] };
  private repairOut: Record<Side, RepairHandPose> = { left: { x: 0, y: 0, z: 0, squeeze: false }, right: { x: 0, y: 0, z: 0, squeeze: false } };
  private squeezeSince: Record<Side, number> = { left: 0, right: 0 };
  private repairPose: Record<Side, PoseSample> = {
    left: { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    right: { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
  };
  private readonly repairHands: Record<Side, RepairHand> = { left: () => this.repairOut.left, right: () => this.repairOut.right };
  private readonly repairOverrides: Record<Side, () => PoseSample> = {
    left: () => this.repairHandPose('left'),
    right: () => this.repairHandPose('right'),
  };

  // Catching and throwing.
  private phase: ThrowPhase = 'ready';
  private phaseSince = 0;
  private catching = -1;
  private rest: Vec3 = [0, 0, 0];
  // Pump: whether it is bailing, where its right hand is and is going, and the stroke's start.
  private pumping = false;
  private pumpPos: Vec3 = [0, 0, 0];
  private pumpGoal: Vec3 = [0, 0, 0];
  private pumpStart = 0;
  private handlePoint = { x: 0, y: 0, z: 0 };
  private pumpOut: PumpHandPose = { x: 0, y: 0, z: 0, squeeze: false };
  private pumpPose: PoseSample = { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
  private readonly pumpHand: PumpHand = () => this.pumpOut;
  private readonly pumpOverride = (): PoseSample => {
    const p = this.pumpPose;
    p.px = this.pumpOut.x;
    p.py = this.pumpOut.y;
    p.pz = this.pumpOut.z;
    return p;
  };
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
    // Its legs stand on the deck, the rungs or the loft's floor, from where its head is.
    netLink.feetOverride = () => Math.min(LOFT_FLOOR, Math.max(0, this.head[1] - EYE_HEIGHT));
    this.cleanupFuncs.push(() => {
      netLink.headOverride = null;
      netLink.feetOverride = null;
    });
    const self = this;
    (window as { __bot?: unknown }).__bot = {
      get mode() { return self.mode; },
      get head() { return [...self.head]; },
      get crank() { return { angle: self.crankAngle, age: performance.now() - self.crankAtMs, handle: self.botHandle }; },
      get repair() { return { spot: self.repairSpot, held: { left: self.repairs?.heldKind('left') ?? null, right: self.repairs?.heldKind('right') ?? null } }; },
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
    this.stowage ??= this.world.getSystem(StowageSystem);
    this.repairs ??= this.world.getSystem(RepairSystem);
    this.pump ??= this.world.getSystem(PumpSystem);
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
    this.call = this.lookFor();
    // Bail from a few buckets' worth until it is nearly dry; a deep bilge comes before the crank.
    this.pumping = storm.water >= PUMP_FROM || (this.pumping && storm.water > PUMP_UNTIL);
    const mode: Mode = this.call !== null
      ? 'lookout'
      : now - this.lastCrankMs < LET_GO_MS && storm.water < PUMP_URGENT
        ? 'crank'
        : now - this.lastRopeMs < ROPE_LET_GO_MS
          ? 'rope'
          : now - this.lastCrateMs < LET_GO_MS
            ? 'crate'
            : now - this.lastRepairMs < ROPE_LET_GO_MS
              ? 'repair'
              : this.pumping
                ? 'pump'
                : 'idle';
    this.setMode(mode);
    if (mode === 'idle') {
      this.chooseWaitSpot();
    }
    if (mode === 'rope') {
      this.haul.setCall(this.rope?.nextHeaveAt(now) ?? Number.NaN, this.rope?.call.periodMs ?? 0);
      this.haul.update(now);
    }
    this.holdOn();
    this.walk(dt);
    this.placeHands();
    if (mode === 'idle') {
      this.catchAndThrow(now, dt);
    } else if (mode === 'repair') {
      this.holdTear(now, dt);
    } else if (mode === 'lookout') {
      this.lookOut(now, dt);
    } else if (mode === 'pump') {
      this.workPump(now, dt);
    }
  }

  /** Inboard of the pump facing it, its right hand on the handle working it up and down. */
  private workPump(now: number, dt: number): void {
    const there = Math.hypot(this.head[0] - PUMP_STAND[0], this.head[2] - PUMP_STAND[1]) < 0.05;
    const out = this.pumpOut;
    const goal = this.pumpGoal;
    if (there) {
      // On the handle where the lever is, then strokes from top to bottom and back.
      const angle = out.squeeze ? -PUMP_SWING * 0.92 * Math.cos(((now - this.pumpStart) / 1000) * PUMP_STROKES * 2 * Math.PI) : pumpView.angle;
      pumpHandle(angle, this.handlePoint);
      goal[0] = this.handlePoint.x;
      goal[1] = this.handlePoint.y;
      goal[2] = this.handlePoint.z;
    } else {
      goal[0] = this.rest[0];
      goal[1] = this.rest[1];
      goal[2] = this.rest[2];
    }
    const left = stepTowards(this.pumpPos, goal, HAND_SPEED * dt);
    out.x = this.pumpPos[0];
    out.y = this.pumpPos[1];
    out.z = this.pumpPos[2];
    if (!there) {
      out.squeeze = false;
    } else if (!out.squeeze && left < 0.01) {
      out.squeeze = true;
      // Start the stroke where the handle is: at the bottom, from cos(0).
      this.pumpStart = now;
    }
    netLink.scriptedSqueeze.right = out.squeeze;
    this.stats.pumped = Math.round(pumpView.pumped * 10) / 10;
  }

  /**
   * In flight and not made fast, the call for the first passage the ship
   * is approaching or in (null when there is none): looking out takes
   * priority over cranking, so one player flies while the other watches.
   */
  private lookFor(): LookoutCall | null {
    if (route.phase !== 'flying' || docking.phase === 'fast') {
      return null;
    }
    for (let i = 0; i < ROUTE.passages.length; i++) {
      const p = ROUTE.passages[i];
      const call = lookoutCall(p, ship.x, ship.y, ship.z, ship.vx, ship.vz);
      if (call === null) continue;
      // Flown through and out the other side: on to the next.
      if (route.passMask & (1 << i) && toPassage(p, ship.x, ship.z, this.where).w > 0 && call === 'STEADY') continue;
      return call;
    }
    return null;
  }

  /** At the bow rail facing ahead, pointing the way and calling it out (as a 'crew-call' the player's page shows and whistles). */
  private lookOut(now: number, dt: number): void {
    this.setHeadTarget(LOOKOUT_SPOT[0], LOOKOUT_SPOT[2]);
    this.yaw = 0;
    const call = this.call;
    if (call === null) return;
    const point = POINT[call];
    this.pointGoal[0] = this.head[0] + point[0];
    this.pointGoal[1] = this.head[1] + point[1];
    this.pointGoal[2] = this.head[2] + point[2];
    stepTowards(this.hand, this.pointGoal, HAND_SPEED * dt);
    if (now - this.lastCallAt < CALL_GAP_MS || (call === this.lastCall && now - this.lastCallAt < CALL_REPEAT_MS)) {
      return;
    }
    this.lastCall = call;
    this.lastCallAt = now;
    this.stats.calls++;
    console.info(`[Bot] lookout: ${call}`);
    netLink.sendEvent({ t: 'crew-call', c: call } as { t: string });
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
    this.readCrates(now);
    this.readRepairs(now);
  }

  /** The player gone up the ladder or on the patch loft while the envelope is torn: the bot holds the tear nearest them. */
  private readRepairs(now: number): void {
    const r = netLink.remote;
    if (r.feet < 0.5 && r.head.py < 3) return;
    let best = Number.POSITIVE_INFINITY;
    let spot = -1;
    for (let i = 0; i < TEAR_SPOTS.length; i++) {
      if (!envelope.tears[i].unmended) continue;
      const d = Math.hypot(r.head.px - TEAR_SPOTS[i].x, r.head.pz - TEAR_SPOTS[i].z);
      if (d < best) {
        best = d;
        spot = i;
      }
    }
    if (spot < 0) return;
    if (spot !== this.repairSpot || this.mode !== 'repair') {
      // Pick where to stand once, so the bot doesn't hop about as the player moves.
      tearStand(TEAR_SPOTS[spot], r.head.px, r.head.pz, this.stand);
    }
    this.repairSpot = spot;
    this.lastRepairMs = now;
  }

  /** A crate the player (the host, crew 0) holds by one handle only, with the other free or the bot's: the bot takes that one. */
  private readCrates(now: number): void {
    const r = netLink.remote;
    for (let i = 0; i < yard.crates.length; i++) {
      const [a, b] = yard.crates[i].holders;
      if ((a === 0) === (b === 0)) continue;
      const theirs = a === 0 ? 0 : 1;
      // The player's hand on it: the drawn hand nearer their handle.
      yard.shipPose(i, ship, cargo, this.cratePose);
      handleAt(this.cratePose.x, this.cratePose.y, this.cratePose.z, this.cratePose.yaw, theirs, this.handleA);
      const dl = Math.hypot(r.left.px - this.handleA.x, r.left.py - this.handleA.y, r.left.pz - this.handleA.z);
      const dr = Math.hypot(r.right.px - this.handleA.x, r.right.py - this.handleA.y, r.right.pz - this.handleA.z);
      const hand = dl < dr ? r.left : r.right;
      this.playerHand[0] = hand.px;
      this.playerHand[1] = hand.py;
      this.playerHand[2] = hand.pz;
      if (this.mode === 'crate' && (i !== this.crate || theirs !== this.crateHandle)) {
        // On to another crate or handle: take hold afresh.
        this.modeSet = false;
      }
      this.crate = i;
      this.crateHandle = theirs;
      this.lastCrateMs = now;
      return;
    }
  }

  /** The bot's hand on the crate's other handle: as far from it as the player's is from theirs, so the crate goes where they take it. */
  private crateHand(): ScriptHand[] {
    const out = this.crateOut[0];
    if (this.crate < 0) return [];
    yard.shipPose(this.crate, ship, cargo, this.cratePose);
    const p = this.cratePose;
    handleAt(p.x, p.y, p.z, p.yaw, this.crateHandle, this.handleA);
    handleAt(p.x, p.y, p.z, p.yaw, 1 - this.crateHandle, this.handleB);
    out.crate = this.crate;
    out.handle = 1 - this.crateHandle;
    out.x = this.handleB.x + this.playerHand[0] - this.handleA.x;
    out.y = this.handleB.y + this.playerHand[1] - this.handleA.y;
    out.z = this.handleB.z + this.playerHand[2] - this.handleA.z;
    return this.crateOut;
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
      bell.knock();
    }
  }

  private setMode(mode: Mode): void {
    if (mode === this.mode && this.modeSet) {
      return;
    }
    this.modeSet = true;
    const doing = {
      crank: 'cranking with you',
      rope: 'hauling the line with you',
      crate: 'carrying a crate with you',
      repair: 'holding the tear shut for you',
      lookout: 'looking out from the bow',
      pump: 'pumping out the bilge',
      idle: 'waiting for a throw',
    };
    console.info(`[Bot] ${doing[mode]}`);
    this.mode = mode;
    for (let h = 0; h < 2; h++) {
      this.crank?.setScriptedHand(h, null);
    }
    for (const side of SIDES) {
      this.rope?.setScriptedHand(side, null);
      this.throws?.setScriptedHand(side, null);
    }
    this.stowage?.setScriptedHands(null);
    for (const side of SIDES) {
      this.repairs?.setScriptedHand(side, null);
      if (netLink.handOverride[side] === this.repairOverrides[side]) netLink.handOverride[side] = null;
      netLink.scriptedSqueeze[side] = false;
    }
    this.pump?.setScriptedHand('right', null);
    if (netLink.handOverride.right === this.pumpOverride) netLink.handOverride.right = null;
    this.phase = 'ready';
    this.squeeze = false;
    this.catching = -1;
    this.lastCall = null;
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
    } else if (mode === 'crate') {
      this.stowage?.setScriptedHands(this.crateHands);
      netLink.handOverride.right = this.crateHandOverride;
      netLink.scriptedSqueeze.right = true;
    } else if (mode === 'repair') {
      for (const side of SIDES) {
        const from = side === 'left' ? this.leftRest : this.rest;
        const pos = this.repairPos[side];
        pos[0] = from[0];
        pos[1] = from[1];
        pos[2] = from[2];
        this.repairOut[side].squeeze = false;
        this.repairs?.setScriptedHand(side, this.repairHands[side]);
        netLink.handOverride[side] = this.repairOverrides[side];
      }
    } else if (mode === 'pump') {
      this.copyRest(this.pumpPos);
      this.pumpOut.squeeze = false;
      this.pump?.setScriptedHand('right', this.pumpHand);
      netLink.handOverride.right = this.pumpOverride;
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

  private setHeadTarget(x: number, z: number, eye = EYE_HEIGHT): void {
    this.headTarget[0] = x;
    this.headTarget[1] = eye;
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
    } else if (this.mode === 'crate') {
      // On deck behind its hand, facing the crate.
      const out = this.crateOut[0];
      const dx = out.x - this.cratePose.x;
      const dz = out.z - this.cratePose.z;
      const d = Math.hypot(dx, dz) || 1;
      const x = Math.max(-DECK_WIDTH / 2 + 0.2, Math.min(DECK_WIDTH / 2 - 0.2, out.x + (dx / d) * 0.35));
      const z = Math.max(-DECK_LENGTH / 2 + 0.2, Math.min(DECK_LENGTH / 2 - 0.2, out.z + (dz / d) * 0.35));
      this.setHeadTarget(x, z);
      this.yaw = Math.atan2(-(out.x - x), -(out.z - z));
    } else if (this.mode === 'pump') {
      // Inboard of the handle, facing outboard (+X) over the pump.
      this.setHeadTarget(PUMP_STAND[0], PUMP_STAND[1]);
      this.yaw = -Math.PI / 2;
    } else if (this.mode === 'repair' && this.repairSpot >= 0) {
      // Beside the tear on the loft, facing it.
      const spot = TEAR_SPOTS[this.repairSpot];
      this.setHeadTarget(this.stand[0], this.stand[1], LOFT_EYE);
      if (Math.hypot(spot.x - this.head[0], spot.z - this.head[2]) > 0.05) {
        this.yaw = Math.atan2(-(spot.x - this.head[0]), -(spot.z - this.head[2]));
      }
    }
    // Up or down the ladder when the job is on the other level (facing it as it climbs).
    viaLadder(this.head, this.headTarget, EYE_HEIGHT, LOFT_EYE, this.waypoint);
    const climbing = this.waypoint[1] !== this.head[1];
    if (climbing) this.yaw = Math.PI / 2;
    stepTowards(this.head, this.waypoint, (climbing ? CLIMB_SPEED : WALK_SPEED) * dt);
  }

  /** On the loft beside the tear, a hand on each end of its slit, squeezing; on the ladder, hands on its stiles. */
  private holdTear(now: number, dt: number): void {
    const tear = this.repairSpot >= 0 ? envelope.tears[this.repairSpot] : null;
    const spot = TEAR_SPOTS[Math.max(0, this.repairSpot)];
    const there = this.head[1] >= LOFT_EYE - 0.01 && Math.hypot(this.head[0] - this.stand[0], this.head[2] - this.stand[1]) < 0.05;
    const climbing = this.head[1] > EYE_HEIGHT + 0.01 && this.head[1] < LOFT_EYE - 0.01;
    // Which end of the slit is on its right: right of facing is (−fz, fx).
    const rightEnd = spot.ax * Math.cos(this.yaw) - spot.az * Math.sin(this.yaw) > 0 ? 1 : 0;
    for (const side of SIDES) {
      const goal = this.repairGoal;
      const holding = there && tear !== null && tear.unmended;
      if (holding) {
        const t = TEAR_HOLD_T[side === 'right' ? rightEnd : 1 - rightEnd];
        slitPoint(envelope.canvas, spot, tear.length, t, EDGE_DROP, this.edge);
        goal[0] = this.edge.x;
        goal[1] = this.edge.y;
        goal[2] = this.edge.z;
      } else if (climbing) {
        // Facing the ladder (-X), its right hand is on the fore stile.
        goal[0] = LADDER_X + 0.04;
        goal[1] = this.head[1] - (side === 'right' ? 0.25 : 0.4);
        goal[2] = LADDER_Z[side === 'right' ? 0 : 1];
      } else {
        const from = side === 'left' ? this.leftRest : this.rest;
        goal[0] = from[0];
        goal[1] = from[1];
        goal[2] = from[2];
      }
      const pos = this.repairPos[side];
      const left = stepTowards(pos, goal, HAND_SPEED * dt);
      const out = this.repairOut[side];
      out.x = pos[0];
      out.y = pos[1];
      out.z = pos[2];
      if (!holding || left > 0.02) {
        out.squeeze = false;
      } else if (!out.squeeze) {
        out.squeeze = true;
        this.squeezeSince[side] = now;
      } else if (this.repairs?.heldKind(side) !== 'edge' && now - this.squeezeSince[side] > REGRAB_MS) {
        // Slipped, or squeezed before the edge was there: let go, and take hold again next frame.
        out.squeeze = false;
      }
      netLink.scriptedSqueeze[side] = out.squeeze || climbing;
    }
  }

  private repairHandPose(side: Side): PoseSample {
    const out = this.repairOut[side];
    const p = this.repairPose[side];
    p.px = out.x;
    p.py = out.y;
    p.pz = out.z;
    return p;
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
