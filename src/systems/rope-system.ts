import {
  CanvasTexture,
  createSystem,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { decodeRope, encodeRope, PacketType, type PoseSample, ROPE_PACKET_BYTES, type RopeStatePacket } from '../net/pose-codec.js';
import {
  createRope,
  HAUL_LAMP,
  HAUL_LAMP_RADIUS,
  nearestOnRope,
  ROPE_OVERSIDE,
  ROPE_REACH,
  ROPE_RUN,
  ROPE_X,
  ROPE_Y,
  ROPE_Z0,
  setRopeHauled,
} from '../scene-assets/rope.scene-asset.js';
import { groundBelow } from '../sim/islands.js';
import { KEEL_DEPTH } from '../sim/gondola-layout.js';
import { callLampLevel, HaulCall, haulCallFraction, haulCallPhase, lineTension, msToNextHeave, ropeBuzz } from '../sim/crew-sync.js';
import { createRopeHandInput, ROPE_SLOTS, RopeHaulSim } from '../sim/rope-haul.js';
import { wrapNear } from '../sim/world-tile.js';
import { ROUTE_ISLANDS, sceneryIslands } from '../world/route-world.js';
import { GRAPPLE_PHASES, STRAIN_HEIGHT } from '../sim/docking.js';
import { FLAG_LEFT_ROPE, FLAG_LEFT_TRACKED, FLAG_RIGHT_ROPE, FLAG_RIGHT_TRACKED, netLink } from './net-system.js';
import { grip, handUse } from './grip-system.js';
import { HoldKind, lockResolvers } from './hand-lock.js';
import { docking, flightInfo, ship } from './ship-system.js';
import { sounds } from './audio-system.js';

/**
 * Spike S6, part 2: hauling the mooring line hand over hand. Squeeze the grip
 * near the line along the port rail to take hold, pull towards the stern,
 * let go and reach forward again. The host runs the haul simulation
 * (src/sim/rope-haul.ts) with both players' hands and sends the line's
 * state 45 times a second; the guest predicts and blends, as for the crank.
 *
 * Feedback: a buzz in the hand that grows with how hard it pulls on the
 * line (steeply near the point the line slips, easing when the crewmate
 * pulls too), a double pulse on a heave (both players' strokes starting
 * together) and a sharp pulse when the line slips through a hand. A sign at
 * the stern end shows the line out and what the grapple on its end is
 * doing.
 *
 * The haul call (src/sim/crew-sync.ts): while both players have a hand on
 * the line, a drum beats "heave" once a second on the shared clock, with a
 * soft tock on the off-beat to reach forward. Both hear it at the same
 * moment whatever the network delay, so starting strokes on it heaves. A
 * lamp on the rail flashes on each heave and the controllers tick with it.
 *
 * The grapple itself (taking it off its hook, throwing it, its flight and
 * what it catches) is GrappleSystem's, which also sets how hard the line
 * pulls back (`sim.load`) for what is on its end. The line's state packet
 * carries the grapple's phase too, so the guest learns what the host
 * decided it caught.
 */

const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];
const SEND_HZ = 45;
const BLEND_RATE = 0.12;
/** The hanging line trails aft with speed: tan(angle) per (m/s)², and the most it trails, radians. */
const TRAIL_PER_SPEED2 = 0.008;
const TRAIL_MAX = 0.5;
/** How fast the hanging line swings to a new lean, per second. */
const OVERSIDE_RATE = 1.5;
/** Time between the buzzes that make up the line's pull in the hand, ms (each runs a little longer, so they join up). */
const BUZZ_GAP_MS = 80;

type TestHand = (nowMs: number) => number | null;

interface RopeDebug {
  sim: RopeHaulSim;
  /** All the line out, with the grapple hanging over the side (for haul tests). */
  reset(): void;
  /** Hold the line with this player's `side` hand at a scripted position along it (m), or let go with null. */
  setTestHand(side: Side, hand: TestHand | null): void;
  holding(): Record<Side, boolean>;
  hostError(): number;
  /** The haul call: whether it is sounding, and the latest heave's number and time since it (ms) on the shared clock (NaN without one). */
  call(nowMs: number): { running: boolean; index: number; sinceMs: number };
}

export class RopeSystem extends createSystem({}) {
  readonly sim = new RopeHaulSim();
  private texture!: CanvasTexture;
  /** The line hanging over the side, while the grapple hangs on it (GrappleSystem draws the grapple at its end). */
  overside!: Mesh;
  private lean = { x: 0, z: 0 };
  private hands = Array.from({ length: ROPE_SLOTS }, () => createRopeHandInput());
  private hold: Record<Side, boolean> = { left: false, right: false };
  private testHands: Record<Side, TestHand | null> = { left: null, right: null };
  private testRests: Record<Side, TestHand | null> = { left: null, right: null };
  private handPos = new Vector3();
  private lastTestAlong: Record<Side, number> = { left: 0, right: 0 };
  private overrides: Record<Side, PoseSample> = {
    left: { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    right: { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
  };
  private sendBuffer = new ArrayBuffer(ROPE_PACKET_BYTES);
  private sendAccumulator = 0;
  private outState: RopeStatePacket = { timeMs: 0, hauled: 0, speed: 0, flags: 0, heaves: 0, grapple: 0, throws: 0 };
  /** The host's line state as last heard (the guest's GrappleSystem reads its grapple phase). */
  readonly hostState: RopeStatePacket = { timeMs: 0, hauled: 0, speed: 0, flags: 0, heaves: 0, grapple: 0, throws: 0 };
  private hostStateFresh = false;
  private blendError = Number.NaN;
  private wasHeave = false;
  private lastBuzz = 0;
  /** The haul call, and its lamp. */
  readonly call = new HaulCall();
  private lamp!: Mesh<SphereGeometry, MeshBasicMaterial>;
  /** When this player last had a hand on the line, local ms (the call's beat ticks in the controllers while they haul). */
  private atLineMs = Number.NEGATIVE_INFINITY;
  private sign!: { ctx: CanvasRenderingContext2D; texture: CanvasTexture };
  private lastSignDraw = 0;

  init(): void {
    const rope = createRope();
    this.texture = rope.texture;
    this.world.createTransformEntity(rope.run);
    this.world.createTransformEntity(rope.fittings);
    this.overside = rope.overside;
    this.world.createTransformEntity(rope.overside);
    this.createSign();
    this.lamp = new Mesh(new SphereGeometry(HAUL_LAMP_RADIUS, 10, 6), new MeshBasicMaterial({ color: 0x5a4524, toneMapped: false }));
    this.lamp.name = 'Haul Call Lamp';
    this.lamp.position.set(HAUL_LAMP[0], HAUL_LAMP[1], HAUL_LAMP[2]);
    this.world.createTransformEntity(this.lamp);

    netLink.handlers.set(PacketType.Rope, (view) => {
      if (decodeRope(view, this.hostState)) {
        this.hostStateFresh = true;
      }
    });

    const debug: RopeDebug = {
      sim: this.sim,
      setTestHand: (side, hand) => this.setScriptedHand(side, hand),
      holding: () => ({ ...this.hold }),
      hostError: () => this.blendError,
      call: (nowMs) => {
        const { index, phase } = haulCallPhase(this.sharedClock(nowMs), this.call.periodMs);
        return { running: this.call.running, index, sinceMs: phase * this.call.periodMs };
      },
      reset: () => {
        this.sim.reset();
        docking.phase = 'hanging';
        this.hostStateFresh = false;
      },
    };
    (window as unknown as { __rope: RopeDebug }).__rope = debug;
    this.cleanupFuncs.push(() => netLink.handlers.delete(PacketType.Rope));
    // Grip locking: a hand on the line is drawn round it, level with where the real hand is along it.
    lockResolvers.set(HoldKind.Rope, (hand, point, axis) => {
      point.set(ROPE_X, ROPE_Y, ROPE_Z0 + Math.max(0, Math.min(ROPE_RUN, hand.z - ROPE_Z0)));
      axis.set(0, 0, 1);
    });
    this.cleanupFuncs.push(() => lockResolvers.delete(HoldKind.Rope));
  }

  /**
   * Time on the clock both players share (the host's), for local time
   * `nowMs`, or NaN while the guest doesn't yet know the offset to it.
   */
  sharedClock(nowMs: number): number {
    if (!netLink.connected || netLink.isHost) {
      return nowMs;
    }
    return netLink.clockSynced ? nowMs - netLink.toLocal(0) : Number.NaN;
  }

  /** Local time of the haul call's next heave, ms (NaN without a crewmate to haul with): the practice crewmate strokes on it. */
  nextHeaveAt(nowMs: number): number {
    const clock = netLink.connected ? this.sharedClock(nowMs) : Number.NaN;
    return nowMs + msToNextHeave(clock, this.call.periodMs);
  }

  /**
   * Hold the line with this player's `side` hand at the position along it
   * that `hand` gives for a time (m; null lets go but keeps the script), or
   * stop scripting that hand with null: for tests and the practice crewmate.
   * `rest` says where along the line the hand waits while it isn't holding
   * (by default, where it let go).
   */
  setScriptedHand(side: Side, hand: TestHand | null, rest: TestHand | null = null): void {
    this.testHands[side] = hand;
    this.testRests[side] = rest;
    if (!hand) {
      netLink.handOverride[side] = null;
    }
  }

  update(delta: number): void {
    const now = performance.now();
    const dt = Math.min(delta, 0.2);
    const me = netLink.isHost ? 0 : 1;

    this.updateLocalHands();

    for (const hand of this.hands) {
      hand.holding = false;
    }
    let flags = 0;
    for (const side of SIDES) {
      if (!this.hold[side]) {
        continue;
      }
      const hand = this.hands[me * 2 + (side === 'left' ? 0 : 1)];
      hand.holding = true;
      hand.along = this.localAlong(side, now);
      hand.atMs = now;
      flags |= side === 'left' ? FLAG_LEFT_ROPE : FLAG_RIGHT_ROPE;
      if (this.testHands[side]) {
        flags |= side === 'left' ? FLAG_LEFT_TRACKED : FLAG_RIGHT_TRACKED;
      }
    }
    netLink.extraFlags.rope = flags;
    if (netLink.connected && netLink.haveRemote) {
      const r = netLink.remote;
      for (const side of SIDES) {
        if ((r.flags & (side === 'left' ? FLAG_LEFT_ROPE : FLAG_RIGHT_ROPE)) === 0) {
          continue;
        }
        const pose = side === 'left' ? r.left : r.right;
        const hand = this.hands[(1 - me) * 2 + (side === 'left' ? 0 : 1)];
        hand.holding = true;
        hand.along = nearestOnRope(pose.px, pose.py, pose.pz).along;
        hand.atMs = netLink.remoteAtMs;
      }
    }

    const steps = Math.min(20, Math.max(1, Math.ceil(dt * 90)));
    for (let i = 1; i <= steps; i++) {
      this.sim.step(dt / steps, now - (dt * 1000 * (steps - i)) / steps, this.hands);
    }

    if (!netLink.connected || netLink.isHost) {
      if (netLink.connected) {
        this.sendState(dt, now);
      }
    } else if (this.hostStateFresh) {
      const h = this.hostState;
      const age = Math.max(0, (now - netLink.toLocal(h.timeMs)) / 1000);
      const target = h.hauled + h.speed * age;
      this.blendError = target - this.sim.hauled;
      this.sim.blendToward(target, h.speed, BLEND_RATE);
      this.sim.heaves = h.heaves;
      this.sim.allIn = (h.flags & 2) !== 0;
    }

    for (const side of SIDES) {
      if (this.hold[side] && this.sim.slipped[me * 2 + (side === 'left' ? 0 : 1)]) {
        console.info(`[Rope] the line slipped through the ${side} hand`);
        this.release(side);
        this.pulse(side, 1, 90);
      }
    }

    setRopeHauled(this.texture, this.sim.hauled);
    this.hangOverside(dt);
    this.haulCall(now);
    this.feedback(now, me);
    if (now - this.lastSignDraw > 200) {
      this.lastSignDraw = now;
      this.drawSign();
    }
  }

  /**
   * Swing the hanging line to point along ship-space direction (x, y, z)
   * (towards a grapple that has just fallen or been torn off its post);
   * from there it swings down to hang.
   */
  pointOverside(x: number, y: number, z: number): void {
    const length = Math.hypot(x, y, z);
    if (length < 1e-6) {
      return;
    }
    // The line's end is at (sin lz, -cos lz cos lx, -cos lz sin lx); it never points above the rail.
    const dx = x / length;
    const dy = Math.min(-0.05, y / length);
    const dz = z / length;
    this.lean.z = Math.asin(Math.max(-1, Math.min(1, dx)));
    this.lean.x = Math.atan2(-dz, -dy);
    this.overside.rotation.set(this.lean.x, 0, this.lean.z);
  }

  /**
   * The line out hangs over the side along the felt gravity, trailing aft
   * with speed, and stops where it reaches an island below the ship. Only
   * while the grapple hangs on it: otherwise the line out runs to the
   * grapple (GrappleSystem).
   */
  private hangOverside(dt: number): void {
    if (docking.phase !== 'hanging') {
      this.overside.visible = false;
      return;
    }
    let length = this.sim.params.length - this.sim.hauled;
    if (flightInfo.flying) {
      const ground = Math.max(
        groundBelow(ROUTE_ISLANDS, ship.x, ship.z, ship.y),
        groundBelow(sceneryIslands, ship.x, ship.z, ship.y, wrapNear),
      );
      // groundBelow gives the deck height of a ship resting there; the rock is a keel's depth lower.
      length = Math.min(length, ROPE_OVERSIDE[1] + KEEL_DEPTH + ship.y - ground);
    }
    this.overside.visible = length > 0.02;
    this.overside.scale.y = Math.max(0.02, length);
    const gy = Math.min(-0.1, ship.gy);
    const speed2 = ship.vx * ship.vx + ship.vz * ship.vz;
    const trail = Math.min(TRAIL_MAX, Math.atan(TRAIL_PER_SPEED2 * speed2));
    // Same convention as the lantern: rotation.x leans the bottom towards ±Z, rotation.z towards ±X.
    const targetX = -Math.atan2(ship.gz, -gy) - trail;
    const targetZ = Math.atan2(ship.gx, -gy);
    const k = Math.min(1, OVERSIDE_RATE * dt);
    this.lean.x += (targetX - this.lean.x) * k;
    this.lean.z += (targetZ - this.lean.z) * k;
    this.overside.rotation.set(this.lean.x, 0, this.lean.z);
  }

  private updateLocalHands(): void {
    if (this.testHands.left || this.testHands.right) {
      for (const side of SIDES) {
        this.hold[side] = this.testHands[side] !== null && this.testHands[side](performance.now()) !== null;
      }
      return;
    }
    for (const side of SIDES) {
      if (this.hold[side]) {
        if (!grip[side].pressed) {
          this.release(side);
        }
        continue;
      }
      if (!grip[side].down || handUse[side]) {
        continue;
      }
      this.player.gripSpaces[side].getWorldPosition(this.handPos);
      if (nearestOnRope(this.handPos.x, this.handPos.y, this.handPos.z).distance < ROPE_REACH) {
        this.hold[side] = true;
        this.pulse(side, 0.4, 30);
      }
    }
  }

  private localAlong(side: Side, now: number): number {
    const test = this.testHands[side];
    if (test) {
      const o = this.overrides[side];
      netLink.handOverride[side] ??= (sendMs) => {
        // A scripted hand that has let go stays where it was, like a real one reaching back.
        const along = this.testHands[side]?.(sendMs) ?? this.testRests[side]?.(sendMs) ?? this.lastTestAlong[side];
        this.lastTestAlong[side] = along;
        o.px = ROPE_X;
        o.py = ROPE_Y;
        o.pz = ROPE_Z0 + Math.max(0, Math.min(ROPE_RUN, along));
        return o;
      };
      return test(now) ?? 0;
    }
    this.player.gripSpaces[side].getWorldPosition(this.handPos);
    return this.handPos.z - ROPE_Z0;
  }

  private release(side: Side): void {
    this.hold[side] = false;
  }

  private sendState(dt: number, now: number): void {
    this.sendAccumulator += dt;
    if (this.sendAccumulator < 1 / SEND_HZ) {
      return;
    }
    this.sendAccumulator = Math.min(this.sendAccumulator - 1 / SEND_HZ, 1 / SEND_HZ);
    const s = this.outState;
    s.timeMs = now;
    s.hauled = this.sim.hauled;
    s.speed = this.sim.speed;
    s.flags = (this.sim.heave ? 1 : 0) | (this.sim.allIn ? 2 : 0);
    s.heaves = this.sim.heaves;
    s.grapple = GRAPPLE_PHASES.indexOf(docking.phase);
    s.throws = docking.throws;
    netLink.send(this.sendBuffer, encodeRope(this.sendBuffer, s));
  }

  /**
   * The haul call: sounds while both players have a hand on the line (on
   * either page, from the hands both simulations see), beats on the shared
   * clock, and lights its lamp.
   */
  private haulCall(now: number): void {
    const clock = netLink.connected ? this.sharedClock(now) : Number.NaN;
    if (this.hold.left || this.hold.right) {
      this.atLineMs = now;
    }
    if (Number.isNaN(clock)) {
      this.call.stop();
    } else {
      const h = this.hands;
      const both = (h[0].holding || h[1].holding) && (h[2].holding || h[3].holding);
      const beat = this.call.update(now, clock, both);
      if (beat) {
        sounds.haulCall(beat);
        if (now - this.atLineMs < this.call.lingerMs) {
          for (const side of SIDES) {
            this.pulse(side, beat === 'heave' ? 0.6 : 0.15, beat === 'heave' ? 35 : 10);
          }
        }
      }
    }
    const level = this.call.running ? callLampLevel(haulCallFraction(clock, this.call.periodMs)) : 0;
    // Dull brass when quiet; a warm flash on each heave.
    this.lamp.material.color.setRGB(0.35 + 0.65 * level, 0.27 + 0.65 * level, 0.14 + 0.45 * level);
  }

  private feedback(now: number, me: number): void {
    const heave = this.sim.heave || (!netLink.isHost && (this.hostState.flags & 1) !== 0);
    if (heave && !this.wasHeave) {
      for (const side of SIDES) {
        if (this.hold[side]) this.pulse(side, 0.8, 70);
      }
    }
    this.wasHeave = heave;
    if (now - this.lastBuzz > BUZZ_GAP_MS) {
      this.lastBuzz = now;
      for (const side of SIDES) {
        if (!this.hold[side]) continue;
        const buzz = ropeBuzz(lineTension(this.sim.lead[me * 2 + (side === 'left' ? 0 : 1)], this.sim.params.slipDistance), this.sim.speed);
        if (buzz > 0) this.pulse(side, buzz, BUZZ_GAP_MS + 15);
      }
    }
  }

  private pulse(side: Side, intensity: number, ms: number): void {
    const actuator = this.input.xr.gamepads[side]?.gamepad.hapticActuators?.[0] as
      | { pulse?: (value: number, duration: number) => Promise<boolean> }
      | undefined;
    void actuator?.pulse?.(intensity, ms)?.catch(() => undefined);
  }

  private createSign(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const sign = new Mesh(new PlaneGeometry(0.36, 0.135), new MeshBasicMaterial({ map: texture, toneMapped: false }));
    sign.name = 'Mooring Sign';
    // On the port rail at the stern end of the hauling run, facing inboard.
    sign.position.set(ROPE_X - 0.08, ROPE_Y + 0.25, ROPE_Z0 + ROPE_RUN + 0.05);
    sign.rotation.set(0, Math.PI / 2, 0);
    this.world.createTransformEntity(sign);
    this.sign = { ctx, texture };
    this.drawSign();
  }

  private drawSign(): void {
    const { ctx, texture } = this.sign;
    const s = this.sim;
    ctx.fillStyle = '#2b1d12';
    ctx.fillRect(0, 0, 256, 96);
    ctx.strokeStyle = '#c9a03a';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 252, 92);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#f3e3c3';
    ctx.font = 'bold 28px sans-serif';
    const phase = docking.phase;
    const out = s.params.length - s.hauled;
    ctx.fillText(phase === 'stowed' ? 'grapple on hook' : `line out ${out.toFixed(1)} m`, 128, 40);
    ctx.font = 'bold 24px sans-serif';
    const off = docking.heightOff;
    const [text, colour] =
      phase === 'fast' ? ['MADE FAST!', '#7fd17f']
      : phase === 'hooked' && Math.abs(off) > STRAIN_HEIGHT ? [off > 0 ? 'HIGH! vent' : 'LOW! burn', '#f08a5d']
      : this.wasHeave ? ['HEAVE!', '#f4c542']
      : phase === 'hooked' ? [docking.tight ? 'on the post: haul!' : 'on the post', '#a8d08a']
      : phase === 'flying' ? ['...', '#a89878']
      : phase === 'hanging' ? ['haul it back in', '#a89878']
      : ['throw it at the post', '#a89878'];
    ctx.fillStyle = colour;
    ctx.fillText(text, 128, 78);
    texture.needsUpdate = true;
  }
}
