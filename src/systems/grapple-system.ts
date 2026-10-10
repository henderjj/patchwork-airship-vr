import { createSystem, type Mesh, Quaternion, Vector3 } from '@iwsdk/core';
import { GRAPPLE_UNKNOWN } from '../net/pose-codec.js';
import {
  createGrapple,
  createLineSpan,
  GRAPPLE_GRIP,
  GRAPPLE_HOOK,
  GRAPPLE_REACH,
} from '../scene-assets/rope.scene-asset.js';
import {
  FAIRLEAD,
  GRAPPLE_PHASES,
  type GrapplePhase,
  type GrappleThrow,
  SHORTEST_LINE,
  shipDirToWorld,
  shipToWorld,
  STOW_LINE,
  STRAIN_HEIGHT,
  THROW_SPEED,
  worldToShip,
} from '../sim/docking.js';
import { ReleaseVelocityTracker } from '../sim/release-velocity.js';
import { GRAVITY } from '../sim/ship-motion.js';
import { ROUTE_ISLANDS } from '../world/route-world.js';
import { sounds } from './audio-system.js';
import { grip, handUse } from './grip-system.js';
import { HoldKind } from './hand-lock.js';
import { FLAG_LEFT_CRANK, FLAG_LEFT_ROPE, FLAG_RIGHT_CRANK, FLAG_RIGHT_ROPE, netLink } from './net-system.js';
import { RopeSystem } from './rope-system.js';
import { docking, ship } from './ship-system.js';

/**
 * Docking (Phase 3, docs/docking.md): the grapple on the end of the mooring
 * line. It hangs on a hook on the bow rail by the fairlead; squeeze near
 * its shank to take it, and throw it at island B's mooring post. It flies
 * in world space (src/sim/docking.ts), paying line out as it goes, and
 * either catches on the post or falls to hang over the side on the line,
 * to be hauled back in and go back on its hook. Let go of it gently and it
 * goes back on its hook.
 *
 * This system also sets how hard the line pulls back for what is on its
 * end: a hanging grapple's weight; once the grapple is on the post, the
 * ship itself while the line is tight (it is belayed between pulls, so it
 * doesn't run back out), and very little while it is slack. The haul is
 * RopeSystem's; ShipSystem holds the ship on the line.
 *
 * Two players: whoever throws sends the throw as a reliable event and both
 * pages fly it from that; the host decides what it catches, and its line
 * packets carry the grapple's phase, which the guest takes. A crewmate
 * holding the grapple is drawn holding it (their pose packet's hold kind).
 *
 * Feedback: a pulse on taking it, a thump and pulse when it catches, and
 * while it is on the post with the deck too high or low, the line creaks
 * and both controllers buzz; a hard pulse when it tears off.
 */

const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];

/** How the grapple sits in a hand: its eye this far out of the thumb end of the fist (grip space -Z), shank down through the fist. */
const HOLD_OFFSET = new Vector3(0, 0, -GRAPPLE_GRIP);
const HOLD_QUAT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
/** On the post: its eye this far out from the post's middle towards the ship, and above its top, m. */
const ON_POST_OUT = 0.22;
const ON_POST_UP = 0.04;
/** While the line strains, it creaks and the controllers buzz this often, ms. */
const STRAIN_EVERY_MS = 420;
/** The haul's load (src/sim/rope-haul.ts) for what the line pulls. */
const LOAD_HANGING = 0.3;
const LOAD_SLACK = 0.12;
const LOAD_TIGHT = 0.6;

interface DockDebug {
  sim: typeof docking;
  state(): {
    phase: GrapplePhase;
    held: Side | null;
    crewHolds: boolean;
    lineOut: number;
    heightOff: number;
    across: number;
    tight: boolean;
    tears: number;
    throws: number;
  };
  /** Where a hand takes the grapple off its hook (ship space). */
  grabPoint(): [number, number, number];
  /** Throw the grapple from where it is (in a hand or on its hook) so it reaches the post's top after `seconds`. */
  throwAt(seconds: number): boolean;
}

export class GrappleSystem extends createSystem({}) {
  private rope!: RopeSystem;
  private grapple!: Mesh;
  private span!: Mesh;
  /** Which of this player's hands holds the grapple. */
  private held: Side | null = null;
  private tracker = new ReleaseVelocityTracker();
  private seenResets = -1;
  private shownPhase: GrapplePhase = 'stowed';
  private lastStrain = 0;
  private fastLine = 0;
  private handPos = new Vector3();
  private handQuat = new Quaternion();
  private eye = new Vector3();
  private dir = new Vector3();
  private up = new Vector3(0, 1, 0);
  private down = new Vector3(0, -1, 0);
  private tmp = { x: 0, y: 0, z: 0 };
  private tmp2 = { x: 0, y: 0, z: 0 };
  private velocity: [number, number, number] = [0, 0, 0];
  private launch: GrappleThrow = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, time: 0 };

  init(): void {
    this.rope = this.world.getSystem(RopeSystem)!;
    this.grapple = createGrapple();
    this.span = createLineSpan();
    this.world.createTransformEntity(this.grapple);
    this.world.createTransformEntity(this.span);

    // The crewmate threw it: fly it here from the same throw.
    netLink.events.set('grapple-throw', (event) => {
      const t = this.launch;
      t.x = Number(event.x);
      t.y = Number(event.y);
      t.z = Number(event.z);
      t.vx = Number(event.vx);
      t.vy = Number(event.vy);
      t.vz = Number(event.vz);
      t.time = Number(event.time);
      if (![t.x, t.y, t.z, t.vx, t.vy, t.vz, t.time].every(Number.isFinite)) {
        return;
      }
      this.letGo();
      docking.throwGrapple(t, Number(event.n) & 255);
    });
    this.cleanupFuncs.push(() => netLink.events.delete('grapple-throw'));

    const debug: DockDebug = {
      sim: docking,
      state: () => ({
        phase: docking.phase,
        held: this.held,
        crewHolds: this.crewHand() !== null,
        lineOut: docking.lineOut,
        heightOff: docking.heightOff,
        across: docking.across,
        tight: docking.tight,
        tears: docking.tears,
        throws: docking.throws,
      }),
      grabPoint: () => [GRAPPLE_HOOK[0], GRAPPLE_HOOK[1] - GRAPPLE_GRIP, GRAPPLE_HOOK[2]],
      throwAt: (seconds) => this.throwAt(seconds),
    };
    (window as unknown as { __dock: DockDebug }).__dock = debug;
  }

  update(delta: number): void {
    const now = performance.now();
    const dt = Math.min(delta, 0.1);
    const sim = this.rope.sim;
    const host = !netLink.connected || netLink.isHost;

    if (docking.resets !== this.seenResets) {
      // A fresh run: the grapple back on its hook and all the line in.
      this.seenResets = docking.resets;
      this.letGo();
      sim.reset();
      sim.setOut(0);
    }
    if (!host) {
      this.followHost();
    }

    this.updateHands(now);

    if (docking.phase === 'flying') {
      // The line pays out after it as it flies, and stays out wherever it ends up.
      docking.stepFlight(ship, ship.time, ROUTE_ISLANDS);
      sim.setOut((docking.phase as GrapplePhase) === 'stowed' ? 0 : docking.flightLine);
    }
    docking.measure(ship);

    // What the line pulls against.
    const phase = docking.phase;
    sim.ratchet = phase === 'hooked' || phase === 'fast';
    sim.load = phase === 'hanging' ? LOAD_HANGING : phase === 'hooked' ? (docking.tight ? LOAD_TIGHT : LOAD_SLACK) : LOAD_SLACK;
    if (phase === 'fast') {
      // Made fast: the line is tied off.
      sim.setOut(this.fastLine);
    } else if (phase === 'hooked' && sim.params.length - sim.hauled < SHORTEST_LINE) {
      sim.setOut(SHORTEST_LINE);
    }
    docking.lineOut = sim.params.length - sim.hauled;
    if (phase !== 'fast') {
      this.fastLine = docking.lineOut;
    }
    if (host && docking.stowIfIn(docking.lineOut)) {
      sim.setOut(0);
      docking.lineOut = 0;
    } else if (!host && phase === 'hanging' && docking.lineOut <= STOW_LINE) {
      // (The host's packet will say so too.)
      docking.adopt('stowed');
    }

    this.feedback(now);
    this.draw();
  }

  /** The guest: take the host's word for what the grapple is doing. */
  private followHost(): void {
    const h = this.rope.hostState;
    if (h.grapple === GRAPPLE_UNKNOWN || h.grapple >= GRAPPLE_PHASES.length) {
      return;
    }
    const phase = GRAPPLE_PHASES[h.grapple];
    const ahead = (h.throws - docking.throws) & 255;
    if (ahead === 0) {
      docking.adopt(phase);
    } else if (ahead < 128 && phase !== 'flying') {
      // Throws this page never saw (it joined late): just take where it is now.
      docking.throws = h.throws;
      docking.adopt(phase);
    }
    // Otherwise this page has thrown since, and the host hasn't heard yet; or the host's throw is on its way.
  }

  private updateHands(now: number): void {
    const busy = (netLink.extraFlags.crank ?? 0) | (netLink.extraFlags.rope ?? 0);
    if (this.held) {
      const side = this.held;
      if (docking.phase !== 'stowed' || this.crewHolds()) {
        // It was thrown or taken meanwhile (the crewmate's throw, or the host had it first).
        this.letGo();
      } else {
        this.gripPose(side);
        this.holdPoint(this.handPos, this.handQuat, this.eye);
        this.tracker.push(now, this.eye.x, this.eye.y, this.eye.z);
        if (!grip[side].pressed) {
          this.release();
        }
      }
      return;
    }
    if (docking.phase !== 'stowed' || this.crewHolds()) {
      return;
    }
    for (const side of SIDES) {
      const sideBusy = busy & (side === 'left' ? FLAG_LEFT_CRANK | FLAG_LEFT_ROPE : FLAG_RIGHT_CRANK | FLAG_RIGHT_ROPE);
      if (!grip[side].down || sideBusy || handUse[side]) {
        continue;
      }
      this.player.gripSpaces[side].getWorldPosition(this.handPos);
      const p = this.handPos;
      if (Math.hypot(p.x - GRAPPLE_HOOK[0], p.y - (GRAPPLE_HOOK[1] - GRAPPLE_GRIP), p.z - GRAPPLE_HOOK[2]) < GRAPPLE_REACH) {
        this.held = side;
        handUse[side] = 'grapple';
        this.tracker.reset();
        this.pulse(side, 0.4, 30);
        return;
      }
    }
  }

  /** Let go: thrown if the hand was moving briskly, else back on its hook. */
  private release(): void {
    const side = this.held;
    this.letGo();
    if (!side) {
      return;
    }
    this.tracker.velocity(this.velocity);
    const [vx, vy, vz] = this.velocity;
    if (Math.hypot(vx, vy, vz) <= THROW_SPEED) {
      return;
    }
    // From ship space (where the hand is) to the world the grapple flies in.
    shipToWorld(ship, this.eye.x, this.eye.y, this.eye.z, this.tmp);
    shipDirToWorld(ship, vx, vy, vz, this.tmp2);
    this.throwFrom(this.tmp, this.tmp2.x + ship.vx, this.tmp2.y + ship.vy, this.tmp2.z + ship.vz);
  }

  private letGo(): void {
    if (this.held) {
      handUse[this.held] = null;
    }
    this.held = null;
  }

  /** Throw from world point `from` at world velocity (vx, vy, vz), and tell the crewmate. */
  private throwFrom(from: { x: number; y: number; z: number }, vx: number, vy: number, vz: number): void {
    const t = this.launch;
    t.x = from.x;
    t.y = from.y;
    t.z = from.z;
    t.vx = vx;
    t.vy = vy;
    t.vz = vz;
    t.time = ship.time;
    docking.throwGrapple(t);
    console.info(`[Grapple] thrown at ${Math.hypot(vx - ship.vx, vy - ship.vy, vz - ship.vz).toFixed(1)} m/s`);
    if (netLink.connected) {
      netLink.sendEvent({ t: 'grapple-throw', x: t.x, y: t.y, z: t.z, vx, vy, vz, time: t.time, n: docking.throws } as { t: string });
    }
  }

  /** Test hook: throw from where the grapple is now so that it reaches the post's top after `seconds`. */
  private throwAt(seconds: number): boolean {
    if (docking.phase !== 'stowed' || !(seconds > 0)) {
      return false;
    }
    this.draw();
    const p = this.grapple.position;
    shipToWorld(ship, p.x, p.y, p.z, this.tmp);
    const from = this.tmp;
    this.letGo();
    const t = seconds;
    const vx = (docking.post.x - from.x) / t;
    const vz = (docking.post.z - from.z) / t;
    const vy = (docking.postTop - 0.3 - from.y) / t + 0.5 * GRAVITY * t;
    this.throwFrom(from, vx, vy, vz);
    return true;
  }

  /** Feedback on what the grapple just did, and while the line strains. */
  private feedback(now: number): void {
    const phase = docking.phase;
    const was = this.shownPhase;
    if (phase !== was) {
      this.shownPhase = phase;
      if (phase === 'hooked') {
        console.info('[Grapple] caught on the post');
        sounds.thump(0.6);
        this.pulseBoth(0.7, 60);
      } else if (phase === 'hanging' && (was === 'hooked' || was === 'flying')) {
        // The line swings down from where the grapple was.
        this.draw();
        const g = this.grapple.position;
        this.rope.pointOverside(g.x - FAIRLEAD[0], g.y - FAIRLEAD[1], g.z - FAIRLEAD[2]);
        if (was === 'hooked') {
          console.info('[Grapple] torn off the post');
          sounds.creak(FAIRLEAD, 1);
          this.pulseBoth(1, 120);
        }
      } else if (phase === 'fast') {
        console.info('[Grapple] made fast');
        sounds.thump(0.4);
        this.pulseBoth(0.8, 50);
      }
    }
    if (phase === 'hooked' && Math.abs(docking.heightOff) > STRAIN_HEIGHT && now - this.lastStrain > STRAIN_EVERY_MS) {
      this.lastStrain = now;
      sounds.creak(FAIRLEAD, Math.min(1, Math.abs(docking.heightOff) / 2.5));
      this.pulseBoth(0.35, 60);
    }
  }

  /** Put the grapple and the line out to it where they are this frame. */
  private draw(): void {
    const g = this.grapple;
    const phase = docking.phase;
    const crew = this.crewHand();
    if (this.held && phase === 'stowed') {
      this.gripPose(this.held);
      this.holdPoint(this.handPos, this.handQuat, g.position);
      g.quaternion.copy(this.handQuat).multiply(HOLD_QUAT);
    } else if (crew && phase === 'stowed') {
      this.handPos.set(crew.px, crew.py, crew.pz);
      this.handQuat.set(crew.qx, crew.qy, crew.qz, crew.qw);
      this.holdPoint(this.handPos, this.handQuat, g.position);
      g.quaternion.copy(this.handQuat).multiply(HOLD_QUAT);
    } else if (phase === 'stowed') {
      g.position.set(GRAPPLE_HOOK[0], GRAPPLE_HOOK[1], GRAPPLE_HOOK[2]);
      g.quaternion.identity();
    } else if (phase === 'flying') {
      // Prongs first along its path.
      const p = docking.pos;
      worldToShip(ship, p.x, p.y, p.z, this.tmp);
      g.position.set(this.tmp.x, this.tmp.y, this.tmp.z);
      const l = docking.launch;
      const t = Math.max(0, ship.time - l.time);
      this.worldDirToShip(l.vx - ship.vx, l.vy - GRAVITY * t - ship.vy, l.vz - ship.vz, this.dir);
      g.quaternion.setFromUnitVectors(this.down, this.dir);
    } else if (phase === 'hooked' || phase === 'fast') {
      // Over the post's top, its shank running from the ship's side across it.
      const post = docking.post;
      shipToWorld(ship, FAIRLEAD[0], FAIRLEAD[1], FAIRLEAD[2], this.tmp2);
      const ax = this.tmp2.x - post.x;
      const az = this.tmp2.z - post.z;
      const a = Math.hypot(ax, az) || 1;
      worldToShip(ship, post.x + (ax / a) * ON_POST_OUT, docking.postTop + ON_POST_UP, post.z + (az / a) * ON_POST_OUT, this.tmp);
      g.position.set(this.tmp.x, this.tmp.y, this.tmp.z);
      this.worldDirToShip(-ax / a, -0.35, -az / a, this.dir);
      g.quaternion.setFromUnitVectors(this.down, this.dir);
    } else {
      // Hanging: on the end of the line over the side.
      const o = this.rope.overside;
      this.dir.set(0, -1, 0).applyEuler(o.rotation);
      g.position.copy(o.position).addScaledVector(this.dir, o.scale.y);
      g.quaternion.setFromUnitVectors(this.down, this.dir);
    }

    // The line out, from the fairlead to the grapple's eye (while it hangs, RopeSystem's line over the side).
    const s = this.span;
    s.visible = phase !== 'hanging';
    if (s.visible) {
      this.dir.set(g.position.x - FAIRLEAD[0], g.position.y - FAIRLEAD[1], g.position.z - FAIRLEAD[2]);
      const length = this.dir.length();
      s.position.set(FAIRLEAD[0], FAIRLEAD[1], FAIRLEAD[2]);
      s.scale.set(1, Math.max(0.01, length), 1);
      if (length > 1e-4) {
        s.quaternion.setFromUnitVectors(this.up, this.dir.multiplyScalar(1 / length));
      }
    }
  }

  /** Where the grapple's eye is for a hand at `pos`/`quat` holding it by its shank. */
  private holdPoint(pos: Vector3, quat: Quaternion, out: Vector3): void {
    out.copy(HOLD_OFFSET).applyQuaternion(quat).add(pos);
  }

  private gripPose(side: Side): void {
    const space = this.player.gripSpaces[side];
    space.getWorldPosition(this.handPos);
    space.getWorldQuaternion(this.handQuat);
  }

  /** A world direction in ship space, normalised, into `out`. */
  private worldDirToShip(x: number, y: number, z: number, out: Vector3): void {
    worldToShip(ship, ship.x + x, ship.y + y, ship.z + z, this.tmp2);
    out.set(this.tmp2.x, this.tmp2.y, this.tmp2.z);
    if (out.lengthSq() < 1e-12) {
      out.set(0, -1, 0);
    }
    out.normalize();
  }

  /** The crewmate's hand holding the grapple, as drawn, or null. */
  private crewHand(): { px: number; py: number; pz: number; qx: number; qy: number; qz: number; qw: number } | null {
    if (!netLink.connected || !netLink.haveRemote) {
      return null;
    }
    const r = netLink.remote;
    if ((r.holds & 15) === HoldKind.Grapple) return r.left;
    if (((r.holds >> 4) & 15) === HoldKind.Grapple) return r.right;
    return null;
  }

  /** The crewmate has it (the host's hold wins if both took it at once). */
  private crewHolds(): boolean {
    if (this.crewHand() === null) {
      return false;
    }
    return !this.held || !netLink.isHost;
  }

  private pulseBoth(intensity: number, ms: number): void {
    this.pulse('left', intensity, ms);
    this.pulse('right', intensity, ms);
  }

  private pulse(side: Side, intensity: number, ms: number): void {
    const actuator = this.input.xr.gamepads[side]?.gamepad.hapticActuators?.[0] as
      | { pulse?: (value: number, duration: number) => Promise<boolean> }
      | undefined;
    void actuator?.pulse?.(intensity, ms)?.catch(() => undefined);
  }
}
