import {
  createSystem,
  Grabbed,
  PhysicsManipulation,
  PhysicsSystem,
  Quaternion,
  Vector3,
  VisibilityState,
  type Entity,
} from '@iwsdk/core';
import { ObjectBuffer } from '../net/object-buffer.js';
import { Accept, Change, GUEST, HOST, Ownership, type OwnershipEvent } from '../net/ownership.js';
import {
  createPoseSample,
  decodeObject,
  encodeObject,
  OBJECT_PACKET_BYTES,
  type ObjectStatePacket,
  PacketType,
  type PoseSample,
} from '../net/pose-codec.js';
import { FUEL_CRATE_POSITION } from '../scene-assets/gondola.scene-asset.js';
import { ReleaseVelocityTracker } from '../sim/release-velocity.js';
import { GondolaSystem } from './gondola-system.js';
import {
  FLAG_LEFT_CRANK,
  FLAG_LEFT_ROPE,
  FLAG_LEFT_TRACKED,
  FLAG_RIGHT_CRANK,
  FLAG_RIGHT_ROPE,
  FLAG_RIGHT_TRACKED,
  netLink,
} from './net-system.js';
import { grip, handUse } from './grip-system.js';
import { inHopper } from '../sim/gondola-controls.js';
import { feedBurner } from './ship-system.js';

/**
 * Spike S7: picking up, throwing and catching loose objects (the fuel
 * bricks), alone or with a crewmate.
 *
 * Grabbing: squeeze the grip within 15 cm of an object. Catching: with the
 * grip squeezed and the hand empty, an object flying past within 20 cm of
 * the hand is caught (so a catch doesn't need a perfectly timed squeeze).
 * Letting go throws the object with the hand's velocity over the last 80 ms.
 *
 * Why the throw velocity is measured here: IWSDK drives a held body with a
 * per-frame target transform, but the physics worker can take several fixed
 * steps per rendered frame and only the first sees the target, so after any
 * slow frame the held body carries a spurious velocity (measured in the
 * emulator at 15 fps: −6 m/s while held still, 13 m/s on release; see the S2
 * record). On release the body is put back where the player sees it and given
 * the hand's velocity instead.
 *
 * With a crewmate, ownership follows the hand (src/net/ownership.ts): the
 * owner simulates the object and sends its pose 45 times a second while it
 * moves (twice a second at rest); the other player draws it from those
 * packets with the same delay as the owner's avatar, so a throw leaves the
 * thrower's drawn hand at the right moment. Grabbing or catching an object
 * takes ownership at once, so a catch that looks caught is caught. When an
 * object this player was simulating passes to the crewmate, its drawn
 * position slides to the crewmate's version over about a tenth of a second
 * instead of jumping.
 */

const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];

/** Grab reach from the grip point to an object's centre, m. */
const GRAB_REACH = 0.15;
/** A flying object passing this close to an empty, squeezed hand is caught, m. */
const CATCH_RADIUS = 0.2;
/** Slower than this an object isn't flying (m/s). */
const FLYING_SPEED = 1.5;
/** A caught object is pulled to within this distance of the grip point, m... */
const MAX_HOLD_OFFSET = 0.08;
/** ...with this time constant, ms. */
const CATCH_PULL_MS = 50;
const SEND_HZ = 45;
const KEEPALIVE_MS = 500;
/** Time constant of the slide after a hand-over, ms. */
const BLEND_MS = 60;
/**
 * Time shifts for thrown objects (see drawRemote and shiftThrownObjects) are
 * complete within SHIFT_NEAR of the catcher's hands or head and ease in from
 * SHIFT_FAR, m.
 */
const SHIFT_FAR = 3.5;
const SHIFT_NEAR = 0.5;
/** How fast the display delay may change: 0.5 means the object is drawn at 50–150% speed meanwhile. */
const SHIFT_RATE = 0.5;
/** Below this an object has fallen overboard and returns to the crate, m. */
const OVERBOARD_Y = -3;

/** A scripted hand for tests without a headset: grip position and squeeze. */
export interface TestHand {
  x: number;
  y: number;
  z: number;
  squeeze: boolean;
}
type TestHandFn = (nowMs: number) => TestHand | null;

interface Throwable {
  id: number;
  entity: Entity;
  heldBy: Side | null;
  /** Hold offset in hand space. */
  offsetPos: Vector3;
  offsetQuat: Quaternion;
  tracker: ReleaseVelocityTracker;
  /** Drawn from the crewmate's packets rather than simulated here. */
  remote: boolean;
  buffer: ObjectBuffer;
  /** Visual offset after a hand-over, decaying to zero. */
  blend: Vector3;
  blendPending: boolean;
  /** Count this hand-over's jump in the stats (not ones from joining a crew). */
  measureBlend: boolean;
  prev: Vector3;
  speed: number;
  /** Recent simulated poses, for drawing a thrown object a little in the past. */
  history: ObjectBuffer;
  /** How far in the past it is drawn, ms. */
  shiftMs: number;
  /** shiftMs when it was handed over to the crewmate. */
  handoverShiftMs: number;
  /** Crewmate's object flying towards this player: how far ahead of their timeline it is drawn, ms. */
  aheadMs: number;
  lastSentMs: number;
  lastSent: PoseSample;
}

interface HandState {
  pos: Vector3;
  quat: Quaternion;
  present: boolean;
  pressed: boolean;
  down: boolean;
}

export interface ThrowStats {
  grabs: number;
  /** Grabs of a flying object. */
  catches: number;
  throws: number;
  /** Claims the host refused (guest only): the guest's hand let go. */
  refused: number;
  /** Objects this player was simulating that passed to the crewmate or back. */
  handovers: number;
  /** Largest jump between this player's version and the crewmate's at a hand-over, m. */
  maxHandoverOffset: number;
  /** Every hand-over's jump, m, newest last (the last 64). */
  handoverOffsets: number[];
}

interface ThrowDebug {
  setTestHand(side: Side, hand: TestHandFn | null): void;
  objects(): {
    id: number;
    owner: number;
    epoch: number;
    pending: boolean;
    remote: boolean;
    heldBy: Side | null;
    remoteHeld: boolean;
    pos: [number, number, number];
    speed: number;
  }[];
  /** Owner only: put an object somewhere, at rest. */
  place(id: number, x: number, y: number, z: number): boolean;
  stats: ThrowStats;
}

export class ThrowablesSystem extends createSystem({}) {
  private objects: Throwable[] = [];
  private ownership!: Ownership;
  private physics: PhysicsSystem | undefined;
  private hands: Record<Side, HandState> = {
    left: { pos: new Vector3(), quat: new Quaternion(), present: false, pressed: false, down: false },
    right: { pos: new Vector3(), quat: new Quaternion(), present: false, pressed: false, down: false },
  };
  private held: Record<Side, Throwable | null> = { left: null, right: null };
  private testHands: Record<Side, TestHandFn | null> = { left: null, right: null };
  private testPressed: Record<Side, boolean> = { left: false, right: false };
  private testPoses: Record<Side, PoseSample> = { left: createPoseSample(), right: createPoseSample() };
  private session = '';
  private sendAccumulator = 0;
  private sendBuffer = new ArrayBuffer(OBJECT_PACKET_BYTES);
  private packet: ObjectStatePacket = { id: 0, epoch: 0, flags: 0, timeMs: 0, pose: createPoseSample() };
  private incoming: ObjectStatePacket = { id: 0, epoch: 0, flags: 0, timeMs: 0, pose: createPoseSample() };
  private sample = createPoseSample();
  private velocity: [number, number, number] = [0, 0, 0];
  private tmpQuat = new Quaternion();
  private headPos = new Vector3();
  private oldSample = createPoseSample();
  private catchOld = createPoseSample();
  private catchNew = createPoseSample();
  private stats: ThrowStats = { grabs: 0, catches: 0, throws: 0, refused: 0, handovers: 0, maxHandoverOffset: 0, handoverOffsets: [] };

  init(): void {
    if (!Grabbed.bitmask) {
      this.world.registerComponent(Grabbed);
    }
    this.physics = this.world.getSystem(PhysicsSystem);
    const bricks = this.world.getSystem(GondolaSystem)?.bricks ?? [];
    bricks.forEach((entity, id) => {
      this.objects.push({
        id,
        entity,
        heldBy: null,
        offsetPos: new Vector3(),
        offsetQuat: new Quaternion(),
        tracker: new ReleaseVelocityTracker(),
        remote: false,
        buffer: new ObjectBuffer(),
        blend: new Vector3(),
        blendPending: false,
        measureBlend: false,
        prev: new Vector3().copy(entity.object3D!.position),
        speed: 0,
        history: new ObjectBuffer(),
        shiftMs: 0,
        handoverShiftMs: 0,
        aheadMs: 0,
        lastSentMs: Number.NEGATIVE_INFINITY,
        lastSent: createPoseSample(),
      });
    });
    this.ownership = new Ownership(this.objects.length, (event: OwnershipEvent) => {
      if (netLink.connected) {
        netLink.sendEvent(event);
      }
    });

    netLink.handlers.set(PacketType.Object, (view) => this.onPacket(view));
    netLink.events.set('claim', (e) => this.onClaim(e));
    netLink.events.set('own', (e) => this.onOwn(e));
    this.cleanupFuncs.push(() => {
      netLink.handlers.delete(PacketType.Object);
      netLink.events.delete('claim');
      netLink.events.delete('own');
    });

    const debug: ThrowDebug = {
      setTestHand: (side, hand) => {
        this.testHands[side] = hand;
        const pose = this.testPoses[side];
        netLink.handOverride[side] = hand
          ? (sendMs) => {
              const h = this.testHands[side]?.(sendMs);
              if (h) {
                pose.px = h.x;
                pose.py = h.y;
                pose.pz = h.z;
              }
              return pose;
            }
          : null;
        const bit = side === 'left' ? FLAG_LEFT_TRACKED : FLAG_RIGHT_TRACKED;
        const flags = netLink.extraFlags.throw ?? 0;
        netLink.extraFlags.throw = hand ? flags | bit : flags & ~bit;
      },
      objects: () =>
        this.objects.map((o) => {
          const s = this.ownership.objects[o.id];
          const p = o.entity.object3D!.position;
          return {
            id: o.id,
            owner: s.owner,
            epoch: s.epoch,
            pending: s.pending,
            remote: o.remote,
            heldBy: o.heldBy,
            remoteHeld: s.remoteHeld,
            pos: [p.x, p.y, p.z] as [number, number, number],
            speed: o.speed,
          };
        }),
      place: (id, x, y, z) => {
        const o = this.objects[id];
        if (!o || o.remote || o.heldBy) {
          return false;
        }
        o.entity.object3D!.position.set(x, y, z);
        o.entity.object3D!.quaternion.identity();
        o.prev.set(x, y, z);
        this.physics?.setBodyTransform(o.entity, { position: o.entity.object3D!.position, quaternion: o.entity.object3D!.quaternion });
        return true;
      },
      stats: this.stats,
    };
    (window as unknown as { __throw: ThrowDebug }).__throw = debug;
  }

  update(delta: number): void {
    const now = performance.now();
    const dt = Math.min(delta, 0.1);
    this.checkSession();
    this.readHands(now);
    this.drawRemote(now, dt);

    for (const o of this.objects) {
      const p = o.entity.object3D!.position;
      o.speed = dt > 0 ? o.prev.distanceTo(p) / dt : 0;
    }

    const busy = (netLink.extraFlags.crank ?? 0) | (netLink.extraFlags.rope ?? 0);
    for (const side of SIDES) {
      const hand = this.hands[side];
      const holding = this.held[side];
      if (holding) {
        if (!hand.present || !hand.pressed) {
          if (hand.present) {
            this.follow(holding, hand, now, 0); // the hand's pose as it let go
          }
          this.release(side, now);
        } else {
          this.follow(holding, hand, now, dt);
        }
        continue;
      }
      const sideBusy = busy & (side === 'left' ? FLAG_LEFT_CRANK | FLAG_LEFT_ROPE : FLAG_RIGHT_CRANK | FLAG_RIGHT_ROPE);
      if (hand.present && hand.pressed && !sideBusy && !handUse[side]) {
        this.tryGrab(side, hand, now);
      }
    }

    for (const o of this.objects) {
      const p = o.entity.object3D!.position;
      if (!o.remote && !o.heldBy && p.y < OVERBOARD_Y) {
        // Fell overboard: back to the crate.
        this.placeAtRest(o, FUEL_CRATE_POSITION[0], 0.45 + o.id * 0.1, FUEL_CRATE_POSITION[2]);
      } else if (!o.remote && !o.heldBy && inHopper(p.x, p.y, p.z)) {
        // Phase 2: into the burner. A fresh brick takes its place in the crate.
        feedBurner();
        this.placeAtRest(o, FUEL_CRATE_POSITION[0], 0.45 + o.id * 0.1, FUEL_CRATE_POSITION[2]);
      }
      o.prev.copy(o.entity.object3D!.position);
    }

    if (netLink.connected) {
      this.sendStates(dt, now);
    }
    this.shiftThrownObjects(now, dt);
  }

  /**
   * The crewmate is drawn `delay` ms in the past, so an object this player
   * throws to them would reach their drawn hand early, fly on past it, and
   * slide back once the catch arrives (up to 85 cm at 150 ms RTT). Instead,
   * as a thrown object nears the crewmate it is drawn a little further in the
   * past, until it is on the crewmate's timeline when it reaches them. (The
   * catcher meanwhile draws it ahead, so it is drawn where it really is when
   * they catch it.) Display only: physics, catching and the packets use the
   * real pose.
   */
  private shiftThrownObjects(now: number, dt: number): void {
    const delay = netLink.connected && netLink.haveRemote ? Math.max(0, now - netLink.remoteAtMs) : 0;
    const r = netLink.remote;
    const maxStep = SHIFT_RATE * dt * 1000;
    for (const o of this.objects) {
      const object = o.entity.object3D!;
      if (o.remote || o.heldBy) {
        o.shiftMs = 0;
        if (o.heldBy) {
          o.history.clear(); // (a remote object keeps it until drawRemote is done with it)
        }
        continue;
      }
      const p = object.position;
      const q = object.quaternion;
      const pose = this.sample;
      pose.px = p.x; pose.py = p.y; pose.pz = p.z;
      pose.qx = q.x; pose.qy = q.y; pose.qz = q.z; pose.qw = q.w;
      o.history.push(now, pose, 0);
      let target = 0;
      if (delay > 0 && o.speed > FLYING_SPEED) {
        // The crewmate's hands, or their head when no hands are tracked.
        let d = Number.POSITIVE_INFINITY;
        if (r.flags & FLAG_LEFT_TRACKED) d = Math.hypot(p.x - r.left.px, p.y - r.left.py, p.z - r.left.pz);
        if (r.flags & FLAG_RIGHT_TRACKED) d = Math.min(d, Math.hypot(p.x - r.right.px, p.y - r.right.py, p.z - r.right.pz));
        if (d === Number.POSITIVE_INFINITY) d = Math.hypot(p.x - r.head.px, p.y - r.head.py, p.z - r.head.pz);
        target = delay * Math.min(1, Math.max(0, (SHIFT_FAR - d) / (SHIFT_FAR - SHIFT_NEAR)));
      }
      o.shiftMs += Math.max(-maxStep, Math.min(maxStep, target - o.shiftMs));
      if (o.shiftMs > 0.5 && o.history.sample(now - o.shiftMs, pose) >= 0) {
        object.position.set(pose.px, pose.py, pose.pz);
        object.quaternion.set(pose.qx, pose.qy, pose.qz, pose.qw);
      }
    }
  }

  /** On joining, leaving or changing role, the host owns everything again. */
  private checkSession(): void {
    const key = netLink.connected ? (netLink.isHost ? 'host' : 'guest') : 'solo';
    if (key === this.session) {
      return;
    }
    this.session = key;
    this.ownership.reset(key === 'guest' ? GUEST : HOST);
    for (const o of this.objects) {
      o.lastSentMs = Number.NEGATIVE_INFINITY;
      o.history.clear();
      if (key === 'guest') {
        this.makeRemote(o);
        o.measureBlend = false;
      } else if (o.remote) {
        this.makeLocal(o);
      }
    }
  }

  private readHands(now: number): void {
    for (const side of SIDES) {
      const hand = this.hands[side];
      const test = this.testHands[side];
      if (test) {
        const h = test(now);
        hand.present = h !== null;
        const pressed = h?.squeeze ?? false;
        hand.down = pressed && !this.testPressed[side];
        hand.pressed = pressed;
        this.testPressed[side] = pressed;
        if (h) {
          hand.pos.set(h.x, h.y, h.z);
          hand.quat.identity();
        }
        continue;
      }
      const pad = this.input.xr.gamepads[side];
      hand.present = !!pad;
      hand.pressed = grip[side].pressed;
      hand.down = grip[side].down;
      if (pad) {
        const grip = this.player.gripSpaces[side];
        grip.getWorldPosition(hand.pos);
        grip.getWorldQuaternion(hand.quat);
      }
    }
  }

  /**
   * Objects the crewmate owns, drawn as they were when the crewmate's drawn
   * avatar was. The exception is an object flying towards this player: as it
   * comes near, it is drawn progressively further ahead (extrapolated as free
   * flight from the latest packets), until it is drawn where it really is
   * now. A catch then happens where the thrower's physics has the object too,
   * and the thrower's matching slow-down (shiftThrownObjects) keeps both
   * views of the hand-over in step.
   */
  private drawRemote(now: number, dt: number): void {
    const renderTime = netLink.haveRemote ? netLink.remoteAtMs : now - 100;
    const delay = now - renderTime;
    const decay = Math.exp((-dt * 1000) / BLEND_MS);
    const maxStep = SHIFT_RATE * dt * 1000;
    const gravity = this.physics?.config.gravity.peek();
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    (immersive ? this.player.head : this.camera).getWorldPosition(this.headPos);
    for (const o of this.objects) {
      if (!o.remote) {
        o.aheadMs = 0;
        continue;
      }
      let target = 0;
      if (netLink.connected && o.speed > FLYING_SPEED && !this.ownership.objects[o.id].remoteHeld) {
        // This player's hands, or their head when no hands are tracked.
        const p = o.entity.object3D!.position;
        let d = Number.POSITIVE_INFINITY;
        for (const side of SIDES) {
          if (this.hands[side].present) {
            d = Math.min(d, p.distanceTo(this.hands[side].pos));
          }
        }
        if (d === Number.POSITIVE_INFINITY) {
          d = p.distanceTo(this.headPos);
        }
        target = delay * Math.min(1, Math.max(0, (SHIFT_FAR - d) / (SHIFT_FAR - SHIFT_NEAR)));
      }
      o.aheadMs += Math.max(-maxStep, Math.min(maxStep, target - o.aheadMs));
      const t = renderTime + o.aheadMs;
      const object = o.entity.object3D!;
      const s = this.sample;
      const old = this.oldSample;
      // What was drawn before a hand-over, at this same moment (so the slide
      // measures the disagreement, not the object's own motion this frame).
      let oldValid = false;
      if (o.history.count > 0 && !(o.buffer.count > 0 && o.buffer.oldestTime() <= t)) {
        // Just handed over: until the drawn time reaches the crewmate's first
        // packet (their catch), carry on along this player's own recent flight.
        o.history.sample(t, s);
        if (o.blendPending) {
          oldValid = o.history.sample(now - o.handoverShiftMs, old) >= 0;
        }
      } else {
        if (o.history.count > 0) {
          oldValid = o.history.sample(t, old) >= 0;
          // How far apart the two versions are at the moment of the catch
          // (measured there, so the frame rate doesn't add to it).
          const first = o.buffer.oldestTime();
          if (o.measureBlend && o.history.sample(first, this.catchOld) >= 0 && o.buffer.sample(first, this.catchNew) >= 0) {
            const gap = Math.hypot(this.catchOld.px - this.catchNew.px, this.catchOld.py - this.catchNew.py, this.catchOld.pz - this.catchNew.pz);
            this.recordHandover(gap);
          }
          o.history.clear();
          o.blendPending = true;
        }
        if (o.buffer.sample(t, s, gravity, o.aheadMs + 50) < 0) {
          continue;
        }
      }
      this.tmpQuat.set(s.qx, s.qy, s.qz, s.qw);
      if (o.blendPending) {
        o.blendPending = false;
        if (oldValid) {
          o.blend.set(old.px - s.px, old.py - s.py, old.pz - s.pz);
        } else {
          o.blend.set(object.position.x - s.px, object.position.y - s.py, object.position.z - s.pz);
        }
        if (o.measureBlend && !oldValid) {
          // A hand-over with no flight to compare (for example a refused claim).
          this.recordHandover(o.blend.length());
        }
      } else {
        o.blend.multiplyScalar(decay);
      }
      object.position.set(s.px + o.blend.x, s.py + o.blend.y, s.pz + o.blend.z);
      if (o.blend.lengthSq() > 1e-6) {
        object.quaternion.slerp(this.tmpQuat, 1 - decay);
      } else {
        object.quaternion.copy(this.tmpQuat);
      }
    }
  }

  /** Grab what's within reach on a fresh squeeze, or catch something flying past a squeezed hand. */
  private tryGrab(side: Side, hand: HandState, now: number): void {
    let best: Throwable | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const o of this.objects) {
      if (o.heldBy || this.ownership.objects[o.id].remoteHeld) {
        continue;
      }
      const flying = o.speed > FLYING_SPEED;
      if (!flying && !hand.down) {
        continue;
      }
      const d = flying
        ? segmentDistance(o.prev, o.entity.object3D!.position, hand.pos)
        : o.entity.object3D!.position.distanceTo(hand.pos);
      if (d < (flying ? CATCH_RADIUS : GRAB_REACH) && d < bestDistance) {
        best = o;
        bestDistance = d;
      }
    }
    if (!best || !this.ownership.grab(best.id)) {
      return;
    }
    const caught = best.speed > FLYING_SPEED;
    if (best.remote) {
      best.remote = false;
      best.buffer.clear();
    }
    best.history.clear();
    best.heldBy = side;
    this.held[side] = best;
    const object = best.entity.object3D!;
    // Hold offset in hand space; a catch pulls the object into the hand.
    this.tmpQuat.copy(hand.quat).invert();
    best.offsetPos.copy(object.position).sub(hand.pos).applyQuaternion(this.tmpQuat);
    best.offsetQuat.copy(this.tmpQuat).multiply(object.quaternion);
    if (!best.entity.hasComponent(Grabbed)) {
      best.entity.addComponent(Grabbed);
    }
    best.tracker.reset();
    best.lastSentMs = Number.NEGATIVE_INFINITY;
    this.follow(best, hand, now, 0);
    this.stats.grabs++;
    if (caught) {
      this.stats.catches++;
      console.info(`[Throw] caught brick ${best.id} with the ${side} hand at ${bestDistance.toFixed(2)} m`);
    }
    this.pulse(side, caught ? 0.8 : 0.4, caught ? 60 : 30);
  }

  /** Hand-overs are rare (one per catch), so keeping a short list costs nothing per frame. */
  private recordHandover(gap: number): void {
    this.stats.maxHandoverOffset = Math.max(this.stats.maxHandoverOffset, gap);
    this.stats.handoverOffsets.push(gap);
    if (this.stats.handoverOffsets.length > 64) {
      this.stats.handoverOffsets.shift();
    }
  }

  private follow(o: Throwable, hand: HandState, now: number, dt: number): void {
    const object = o.entity.object3D!;
    // A caught object eases into the hand rather than jumping there.
    const length = o.offsetPos.length();
    if (length > MAX_HOLD_OFFSET && dt > 0) {
      o.offsetPos.setLength(Math.max(MAX_HOLD_OFFSET, length * Math.exp((-dt * 1000) / CATCH_PULL_MS)));
    }
    object.position.copy(o.offsetPos).applyQuaternion(hand.quat).add(hand.pos);
    object.quaternion.copy(hand.quat).multiply(o.offsetQuat);
    o.tracker.push(now, object.position.x, object.position.y, object.position.z);
  }

  /** Let go: the body goes where the player sees it, moving as the hand was. */
  private release(side: Side, now: number): void {
    const o = this.held[side];
    this.held[side] = null;
    if (!o) {
      return;
    }
    o.heldBy = null;
    const object = o.entity.object3D!;
    o.tracker.velocity(this.velocity);
    if (o.entity.hasComponent(Grabbed)) {
      o.entity.removeComponent(Grabbed);
    }
    this.physics?.setBodyTransform(o.entity, { position: object.position, quaternion: object.quaternion });
    const v = this.velocity;
    // A zero vector is ignored by PhysicsManipulation, so a still release
    // sends a negligible velocity instead to overwrite Havok's.
    if (v[0] === 0 && v[1] === 0 && v[2] === 0) {
      v[1] = -1e-4;
    }
    o.entity.addComponent(PhysicsManipulation, { linearVelocity: v, angularVelocity: [0, 0, 1e-4] });
    const speed = Math.hypot(v[0], v[1], v[2]);
    if (speed > FLYING_SPEED) {
      this.stats.throws++;
      console.info(`[Throw] threw brick ${o.id} at ${speed.toFixed(1)} m/s`);
    }
    o.lastSentMs = Number.NEGATIVE_INFINITY; // send the release at once
  }

  /** The crewmate owns it now: draw it from their packets (a hand holding it lets go). */
  private makeRemote(o: Throwable): void {
    if (o.heldBy) {
      this.held[o.heldBy] = null;
      o.heldBy = null;
    }
    if (!o.remote) {
      this.stats.handovers++;
    }
    o.remote = true;
    o.buffer.clear();
    o.handoverShiftMs = o.shiftMs;
    o.blendPending = true;
    o.measureBlend = true;
    o.blend.set(0, 0, 0);
    // A grabbed body follows its Object3D instead of driving it.
    if (!o.entity.hasComponent(Grabbed)) {
      o.entity.addComponent(Grabbed);
    }
  }

  /** Simulate it here again, starting at rest where it is drawn. */
  private makeLocal(o: Throwable): void {
    o.remote = false;
    o.buffer.clear();
    o.history.clear();
    o.blend.set(0, 0, 0);
    if (!o.heldBy && o.entity.hasComponent(Grabbed)) {
      o.entity.removeComponent(Grabbed);
    }
    const object = o.entity.object3D!;
    this.physics?.setBodyTransform(o.entity, { position: object.position, quaternion: object.quaternion });
  }

  private placeAtRest(o: Throwable, x: number, y: number, z: number): void {
    const object = o.entity.object3D!;
    object.position.set(x, y, z);
    object.quaternion.identity();
    this.physics?.setBodyTransform(o.entity, { position: object.position, quaternion: object.quaternion });
  }

  private sendStates(dt: number, now: number): void {
    this.sendAccumulator += dt;
    const due = this.sendAccumulator >= 1 / SEND_HZ;
    if (due) {
      this.sendAccumulator = Math.min(this.sendAccumulator - 1 / SEND_HZ, 1 / SEND_HZ);
    }
    const states = this.ownership.objects;
    for (const o of this.objects) {
      const state = states[o.id];
      // Between regular sends, only a grab or release just now (sent at once,
      // so the crewmate learns the exact moment).
      const urgent = o.lastSentMs === Number.NEGATIVE_INFINITY;
      if (o.remote || state.owner !== this.ownership.me || (!due && !urgent)) {
        continue;
      }
      const object = o.entity.object3D!;
      const p = object.position;
      const q = object.quaternion;
      const last = o.lastSent;
      const moved =
        Math.abs(p.x - last.px) + Math.abs(p.y - last.py) + Math.abs(p.z - last.pz) > 0.001 ||
        Math.abs(q.x - last.qx) + Math.abs(q.y - last.qy) + Math.abs(q.z - last.qz) + Math.abs(q.w - last.qw) > 0.002;
      if (!o.heldBy && !moved && now - o.lastSentMs < KEEPALIVE_MS) {
        continue;
      }
      const pose = this.packet.pose;
      pose.px = p.x; pose.py = p.y; pose.pz = p.z;
      pose.qx = q.x; pose.qy = q.y; pose.qz = q.z; pose.qw = q.w;
      last.px = p.x; last.py = p.y; last.pz = p.z;
      last.qx = q.x; last.qy = q.y; last.qz = q.z; last.qw = q.w;
      this.packet.id = o.id;
      this.packet.epoch = state.epoch;
      this.packet.flags = o.heldBy ? 1 : 0;
      this.packet.timeMs = now;
      netLink.send(this.sendBuffer, encodeObject(this.sendBuffer, this.packet));
      o.lastSentMs = now;
    }
  }

  private onPacket(view: DataView): void {
    const s = this.incoming;
    // Without a clock offset yet, the packet's time can't be placed.
    if (!netLink.clockSynced || !decodeObject(view, s) || s.id >= this.objects.length) {
      return;
    }
    const o = this.objects[s.id];
    const verdict = this.ownership.acceptState(s.id, s.epoch, (s.flags & 1) !== 0);
    if (verdict === Accept.Drop) {
      return;
    }
    if (verdict === Accept.UseAndLost || !o.remote) {
      this.makeRemote(o);
    }
    o.buffer.push(netLink.toLocal(s.timeMs), s.pose, s.flags);
  }

  /** Host: the guest grabbed or caught something. */
  private onClaim(e: Record<string, unknown>): void {
    const o = this.objects[Number(e.id)];
    if (!o) {
      return;
    }
    if (this.ownership.onClaim(o.id, Number(e.epoch), o.heldBy !== null) === Change.Lost) {
      this.makeRemote(o);
    }
  }

  /** Guest: the host confirmed, refused or took an object. */
  private onOwn(e: Record<string, unknown>): void {
    const o = this.objects[Number(e.id)];
    if (!o) {
      return;
    }
    const refusedBefore = this.ownership.refused;
    const change = this.ownership.onOwn(o.id, Number(e.owner), Number(e.epoch));
    if (change === Change.Lost) {
      if (this.ownership.refused > refusedBefore) {
        this.stats.refused++;
        console.info(`[Throw] the host had brick ${o.id} first`);
      }
      this.makeRemote(o);
    } else if (change === Change.Gained && o.remote) {
      this.makeLocal(o);
    }
  }

  private pulse(side: Side, intensity: number, ms: number): void {
    if (this.testHands[side]) {
      return;
    }
    const actuator = this.input.xr.gamepads[side]?.gamepad.hapticActuators?.[0] as
      | { pulse?: (value: number, duration: number) => Promise<boolean> }
      | undefined;
    void actuator?.pulse?.(intensity, ms)?.catch(() => undefined);
  }
}

/** Distance from `point` to the segment a–b. */
function segmentDistance(a: Vector3, b: Vector3, point: Vector3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? ((point.x - a.x) * abx + (point.y - a.y) * aby + (point.z - a.z) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = a.x + abx * t - point.x, dy = a.y + aby * t - point.y, dz = a.z + abz * t - point.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
