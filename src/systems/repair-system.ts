import {
  BufferAttribute,
  CanvasTexture,
  Color,
  createSystem,
  DoubleSide,
  type InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import { onSettingChange } from '../live-settings.js';
import type { PoseSample } from '../net/pose-codec.js';
import { FIST_AXIS, FIST_CENTRE } from '../scene-assets/hand.scene-asset.js';
import {
  createHammer,
  createLeakPuffs,
  createPatch,
  createPatchInHand,
  createRivets,
  createTear,
  layPatch,
  layTear,
  RIVET_COLORS,
  type TearShape,
} from '../scene-assets/repairs.scene-asset.js';
import { settings } from '../settings.js';
import {
  EDGE_DROP,
  EDGE_REACH,
  LEAK_PER_METRE,
  PATCH_DROP,
  PEEL_SECONDS,
  type Point,
  patchTouches,
  RIVET_REACH,
  RIVETS,
  rivetPoint,
  slitPoint,
  STRIKE_SPEED,
  TEAR_RATES,
  TEAR_SPOTS,
  type TearRate,
} from '../sim/envelope.js';
import { HAMMER_HEAD, HAMMER_REACH, HAMMER_REST, LOFT, PATCH_BOX, PATCH_BOX_REACH } from '../sim/loft.js';
import { sounds } from './audio-system.js';
import { grip, handUse } from './grip-system.js';
import { HoldKind, lockResolvers } from './hand-lock.js';
import { FLAG_LEFT_CRANK, FLAG_LEFT_ROPE, FLAG_RIGHT_CRANK, FLAG_RIGHT_ROPE, netLink } from './net-system.js';
import { docking, envelope, flightInfo, route, ship, shipInfo } from './ship-system.js';

const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];

/** What one of this player's hands holds of the repair gear. */
type Held = { kind: 'edge'; spot: number; t: number } | { kind: 'patch' } | { kind: 'hammer' } | null;

/** A scripted hand (tests and the practice crewmate): where it is, ship space, and whether it squeezes; null lets go of it. */
export interface RepairHandPose {
  x: number;
  y: number;
  z: number;
  squeeze: boolean;
}
export type RepairHand = (nowMs: number) => RepairHandPose | null;

/** While a guest is connected, the host repeats the tears this often, ms (a late joiner catches up). */
const RESEND_MS = 1000;
/** A hand holding a tear's edge lets go once it is this far from it, m. */
const HOLD_SLIP = EDGE_REACH * 1.6;
/** A carried patch's middle is this far along the fist from its middle (on top of the fist), m. */
const PAD_ALONG = 0.05;
/** A hammer stroke sets at most one rivet in this long, ms. */
const STRIKE_COOLDOWN_MS = 200;
/** How far the escaping air carries from a tear, m, and how many puffs show it. */
const PUFFS_PER_TEAR = 14;
const PUFF_TRAVEL = 0.4;
/** Envelope sign: its size, m, and canvas, px; it is redrawn this often, ms. */
const SIGN_SIZE = [0.3, 0.15] as const;
const SIGN_PX = [256, 128] as const;
const SIGN_MS = 250;

/** Practice → Tear it now (set by RepairSystem; the guest asks the host). */
const repairControl = { tearNow: (): void => undefined };

/** Tear the envelope now at a sound spot (the game menu's Practice → Repairs). */
export function tearNow(): void {
  if (netLink.connected && !netLink.isHost) {
    netLink.sendEvent({ t: 'route-tear' });
  } else {
    repairControl.tearNow();
  }
}

interface RepairsDebug {
  sim: typeof envelope;
  state(): {
    tears: { phase: string; length: number; rushed: boolean; rivets: number; life: number; closed: boolean; hands: number; patchLength: number; patches: number }[];
    leak: number;
    unmended: number;
    rate: TearRate;
    held: Record<Side, string | null>;
  };
  /** What Practice → Tear it now does. */
  tearNow(): void;
  /** Host or solo: tear spot `i` open now (tests pick the spot). */
  open(i: number): void;
  setRate(rate: TearRate): void;
  /** Work the repair gear with a scripted hand (ship space), or let it go with null. */
  setHand(side: Side, hand: RepairHand | [number, number, number, boolean] | null): void;
  /** Where on tear `spot`'s edge `t` (0 to 1) along a hand holds it. */
  edgePoint(spot: number, t: number): [number, number, number];
  /** Where a scripted hand carrying a patch presses it onto tear `spot`. */
  patchHand(spot: number): [number, number, number];
  /** Where a scripted hand holding the hammer has its head on rivet `r` of tear `spot`'s patch. */
  rivetHand(spot: number, r: number): [number, number, number];
  /** Where a hand takes a patch from the box, and the hammer from its rack. */
  boxPoint(): [number, number, number];
  hammerPoint(): [number, number, number];
  /** What the envelope signs say. */
  signText(): string[];
}

/**
 * Envelope repairs (Phase 3, docs/repairs.md): tears in the envelope's belly
 * over the patch loft, and mending them from the loft (ClimbSystem takes the
 * crew up its ladder). Squeeze near a tear's torn edge to hold it; two hands
 * (anyone's) far enough apart along it hold it shut. Squeeze at the box of
 * patches to take one and press it up onto the tear: on a tear held shut it
 * waits for its rivets, and four rivets hammered up into its corners (take
 * the hammer from its rack) make it sound; otherwise it is a rushed patch
 * that peels off a minute later.
 *
 * The host (or a solo page) runs the tears (src/sim/envelope.ts, stepped
 * here and leaking in ShipSystem's flight) and sends them on every change
 * and once a second; the guest sends where its hands hold the edges, and
 * each patch and rivet it puts on (shown at once on its own page). Sounds
 * follow the tears as both pages have them: a rip, a hiss while one leaks,
 * a slap for a patch and a clink for each rivet. A sign under the loft and
 * one on it say what to do next.
 */
export class RepairSystem extends createSystem({}) {
  private canvas = envelope.canvas;
  private tears: Mesh[] = [];
  private patches: Mesh[] = [];
  private rivets!: InstancedMesh;
  private hammer!: Mesh;
  private pads: Record<Side, Mesh> = {} as Record<Side, Mesh>;
  private crewPads: Record<Side, Mesh> = {} as Record<Side, Mesh>;
  private puffs!: Points;
  private puffPositions!: Float32Array;
  private sign!: { ctx: CanvasRenderingContext2D; texture: CanvasTexture; lines: string[] };
  private lastSignDraw = 0;

  private held: Record<Side, Held> = { left: null, right: null };
  private scripted: Record<Side, RepairHand | null> = { left: null, right: null };
  private scriptedPose: Record<Side, RepairHandPose | null> = { left: null, right: null };
  private squeezed: Record<Side, boolean> = { left: false, right: false };
  private headPrev: Record<Side, Vector3> = { left: new Vector3(), right: new Vector3() };
  private headValid: Record<Side, boolean> = { left: false, right: false };
  private lastStrike: Record<Side, number> = { left: 0, right: 0 };
  private myHolds: [number, number][] = [];
  private sentHolds = '';
  private holdsSentAt = 0;
  private sentAt = Number.NEGATIVE_INFINITY;
  private changed = false;
  private seenResets = -1;
  private heard = TEAR_SPOTS.map(() => ({ phase: 'whole', rivets: 0, patches: 0 }));
  private heldShown = TEAR_SPOTS.map(() => 0);
  private laidPatch = TEAR_SPOTS.map(() => ({ length: -1, peel: -1 }));
  private shape: TearShape = { length: 0, held: 0, time: 0 };

  private hand = new Vector3();
  private handQuat = new Quaternion();
  private point = new Vector3();
  private tmp: Point = { x: 0, y: 0, z: 0 };
  private matrix = new Matrix4();
  private scale = new Vector3();
  private pos = new Vector3();
  private noTurn = new Quaternion();
  private color = new Color();
  /** The fist's middle and hole axis in each hand's grip space (a left hand's mirrored). */
  private fistCentre: Record<Side, Vector3> = {
    left: new Vector3(-FIST_CENTRE[0], FIST_CENTRE[1], FIST_CENTRE[2]),
    right: new Vector3(FIST_CENTRE[0], FIST_CENTRE[1], FIST_CENTRE[2]),
  };
  private fistAxis: Record<Side, Vector3> = {
    left: new Vector3(-FIST_AXIS[0], FIST_AXIS[1], FIST_AXIS[2]).normalize(),
    right: new Vector3(FIST_AXIS[0], FIST_AXIS[1], FIST_AXIS[2]).normalize(),
  };
  /** The hammer's handle (-Z) and a patch's face (+Y) turned onto each fist's hole, and both onto straight up for a scripted hand. */
  private hammerInFist: Record<Side, Quaternion> = { left: new Quaternion(), right: new Quaternion() };
  private padInFist: Record<Side, Quaternion> = { left: new Quaternion(), right: new Quaternion() };
  private hammerUp = new Quaternion().setFromUnitVectors(new Vector3(0, 0, -1), new Vector3(0, 1, 0));
  private crewQuat = new Quaternion();

  init(): void {
    for (const side of SIDES) {
      this.hammerInFist[side].setFromUnitVectors(new Vector3(0, 0, -1), this.fistAxis[side]);
      this.padInFist[side].setFromUnitVectors(new Vector3(0, 1, 0), this.fistAxis[side]);
    }
    for (let i = 0; i < TEAR_SPOTS.length; i++) {
      this.tears.push(this.place(createTear(), false));
      this.patches.push(this.place(createPatch(), false));
    }
    this.rivets = createRivets();
    this.world.createTransformEntity(this.rivets);
    this.hammer = this.place(createHammer(), true);
    for (const side of SIDES) {
      this.pads[side] = this.place(createPatchInHand(), false);
      this.crewPads[side] = this.place(createPatchInHand(), false);
    }
    const puffs = createLeakPuffs(PUFFS_PER_TEAR * TEAR_SPOTS.length);
    this.puffPositions = puffs.positions;
    this.puffs = new Points(puffs.geometry, new PointsMaterial({ color: 0xffffff, size: 0.035, transparent: true, opacity: 0.4, depthWrite: false }));
    this.puffs.name = 'Leaking Air';
    this.puffs.frustumCulled = false;
    this.puffs.visible = false;
    this.world.createTransformEntity(this.puffs);
    this.createSigns();

    repairControl.tearNow = () => {
      const i = envelope.tearNow();
      if (i >= 0) {
        console.info(`[Repairs] practice: the envelope tore at spot ${i}`);
        this.changed = true;
      }
    };
    envelope.rate = settings.tears;
    this.cleanupFuncs.push(
      onSettingChange((key) => {
        if (key === 'tears') {
          envelope.rate = settings.tears;
        }
      }),
    );

    // The host's tears, and the guest's hands and repairs.
    netLink.events.set('envelope', (event) => {
      if (!netLink.isHost) {
        envelope.adopt(event);
      }
    });
    netLink.events.set('repair-holds', (event) => {
      if (!netLink.isHost || event.r !== envelope.resets || !Array.isArray(event.h)) return;
      const holds = (event.h as unknown[]).filter(
        (h): h is [number, number] => Array.isArray(h) && h.length === 2 && Number.isInteger(h[0]) && typeof h[1] === 'number',
      );
      envelope.setHolds(1, holds.slice(0, 2));
    });
    netLink.events.set('repair-patch', (event) => {
      if (netLink.isHost && event.r === envelope.resets && typeof event.s === 'number' && envelope.press(event.s) !== null) {
        this.changed = true;
      }
    });
    netLink.events.set('repair-rivet', (event) => {
      if (netLink.isHost && event.r === envelope.resets && typeof event.s === 'number' && typeof event.i === 'number' && envelope.rivet(event.s, event.i)) {
        this.changed = true;
      }
    });
    netLink.events.set('route-tear', () => {
      if (netLink.isHost) repairControl.tearNow();
    });
    this.cleanupFuncs.push(() => {
      for (const name of ['envelope', 'repair-holds', 'repair-patch', 'repair-rivet', 'route-tear']) netLink.events.delete(name);
    });

    // Grip locking: a hand on a torn edge is drawn round its nearest point, along the slit.
    lockResolvers.set(HoldKind.Edge, (hand, point, axis) => {
      let best = Number.POSITIVE_INFINITY;
      for (let i = 0; i < TEAR_SPOTS.length; i++) {
        const tear = envelope.tears[i];
        if (!tear.unmended) continue;
        const spot = TEAR_SPOTS[i];
        const t = this.alongEdge(i, hand.x, hand.z);
        slitPoint(this.canvas, spot, tear.length, t, EDGE_DROP, this.tmp);
        const d = Math.hypot(hand.x - this.tmp.x, hand.y - this.tmp.y, hand.z - this.tmp.z);
        if (d < best) {
          best = d;
          point.set(this.tmp.x, this.tmp.y, this.tmp.z);
          axis.set(spot.ax, 0, spot.az);
        }
      }
      if (!Number.isFinite(best)) {
        point.copy(hand);
        axis.set(1, 0, 0);
      }
    });
    this.cleanupFuncs.push(() => lockResolvers.delete(HoldKind.Edge));

    const at = (p: Point): [number, number, number] => [p.x, p.y, p.z];
    const debug: RepairsDebug = {
      sim: envelope,
      state: () => ({
        tears: envelope.tears.map((t) => ({
          phase: t.phase,
          length: t.length,
          rushed: t.rushed,
          rivets: t.rivets,
          life: t.life,
          closed: t.closed,
          hands: t.hands,
          patchLength: t.patchLength,
          patches: t.patches,
        })),
        leak: envelope.leak,
        unmended: envelope.unmended,
        rate: envelope.rate,
        held: { left: this.held.left?.kind ?? null, right: this.held.right?.kind ?? null },
      }),
      tearNow: () => tearNow(),
      open: (i) => {
        envelope.open(i);
        this.changed = true;
      },
      setRate: (rate) => {
        if ((TEAR_RATES as readonly string[]).includes(rate)) envelope.rate = rate;
      },
      setHand: (side, hand) => {
        if (hand === null || typeof hand === 'function') {
          this.setScriptedHand(side, hand);
        } else {
          const pose: RepairHandPose = { x: hand[0], y: hand[1], z: hand[2], squeeze: hand[3] };
          this.setScriptedHand(side, () => pose);
        }
      },
      edgePoint: (spot, t) => at(slitPoint(this.canvas, TEAR_SPOTS[spot], envelope.tears[spot].length, t, EDGE_DROP, this.tmp)),
      patchHand: (spot) => {
        const s = TEAR_SPOTS[spot];
        return [s.x, this.canvas(s.x, s.z) - PATCH_DROP - PAD_ALONG, s.z];
      },
      rivetHand: (spot, r) => {
        rivetPoint(this.canvas, TEAR_SPOTS[spot], envelope.tears[spot].patchLength, r, this.tmp);
        return [this.tmp.x, this.tmp.y - HAMMER_HEAD, this.tmp.z];
      },
      boxPoint: () => [PATCH_BOX[0], PATCH_BOX[1], PATCH_BOX[2]],
      hammerPoint: () => [HAMMER_REST[0], HAMMER_REST[1], HAMMER_REST[2]],
      signText: () => [...this.sign.lines],
    };
    (window as unknown as { __repairs: RepairsDebug }).__repairs = debug;
  }

  /** Work the repair gear with a scripted hand (tests, the practice crewmate), or give the hand back with null. */
  setScriptedHand(side: Side, hand: RepairHand | null): void {
    this.scripted[side] = hand;
  }

  /** What a hand holds of the repair gear. */
  heldKind(side: Side): 'edge' | 'patch' | 'hammer' | null {
    return this.held[side]?.kind ?? null;
  }

  update(delta: number): void {
    const now = performance.now();
    const dt = Math.min(delta, 0.1);
    const host = !netLink.connected || netLink.isHost;
    if (envelope.resets !== this.seenResets) {
      // A fresh run: the envelope sound again, and whatever the hands held of it let go.
      this.seenResets = envelope.resets;
      this.letGoAll();
    }
    this.updateHands(now, dt, host);
    envelope.setHolds(0, this.myHolds);
    if (host) {
      if (!netLink.connected) {
        envelope.setHolds(1, []);
      }
      if (flightInfo.flying && !shipInfo.paused) {
        const underWay = route.phase === 'flying' && docking.phase !== 'fast';
        if (envelope.step(ship.time, underWay, dt)) {
          this.changed = true;
        }
      }
      if (netLink.connected && (this.changed || now - this.sentAt > RESEND_MS)) {
        this.sentAt = now;
        netLink.sendEvent({ t: 'envelope', ...envelope.toWire() });
      }
      this.changed = false;
    } else {
      this.sendHolds(now);
      // Between the host's reports, a rushed patch's last minute runs down here too, so it peels smoothly.
      for (const tear of envelope.tears) {
        if (tear.phase === 'patched' && tear.rushed) tear.life = Math.max(0, tear.life - dt);
      }
    }
    this.hear();
    this.draw(now, dt);
    if (now - this.lastSignDraw > SIGN_MS) {
      this.lastSignDraw = now;
      this.drawSign();
    }
  }

  /** Take, work and let go of the edges, patches and hammer with this player's hands (real or scripted). */
  private updateHands(now: number, dt: number, host: boolean): void {
    const busy = (netLink.extraFlags.crank ?? 0) | (netLink.extraFlags.rope ?? 0);
    this.myHolds.length = 0;
    for (const side of SIDES) {
      const present = this.readHand(side, now);
      const held = this.held[side];
      const pressed = present && this.pressed(side);
      if (held) {
        if (!pressed) {
          this.release(side);
          continue;
        }
        if (held.kind === 'edge') {
          this.workEdge(side, held);
        } else if (held.kind === 'patch') {
          this.carryPatch(side, host);
        } else {
          this.swingHammer(side, now, dt, host);
        }
        continue;
      }
      const sideBusy = busy & (side === 'left' ? FLAG_LEFT_CRANK | FLAG_LEFT_ROPE : FLAG_RIGHT_CRANK | FLAG_RIGHT_ROPE);
      if (!present || !this.down(side) || sideBusy || (handUse[side] && this.scripted[side] === null)) {
        continue;
      }
      this.take(side);
    }
    for (const side of SIDES) {
      const held = this.held[side];
      if (held?.kind === 'edge') this.myHolds.push([held.spot, held.t]);
    }
  }

  /** Where a hand is this frame (into `hand`, and its grip rotation into `handQuat`); false if there is no hand. */
  private readHand(side: Side, now: number): boolean {
    const script = this.scripted[side];
    if (script) {
      const pose = script(now);
      if (pose === null) {
        this.scripted[side] = null;
        this.scriptedPose[side] = null;
        if (this.held[side]) this.release(side);
        return false;
      }
      this.scriptedPose[side] = pose;
      this.hand.set(pose.x, pose.y, pose.z);
      this.handQuat.identity();
      return true;
    }
    this.scriptedPose[side] = null;
    if (!this.world.session || !this.input.xr.getPrimaryInputSource(side)) {
      return false;
    }
    const space = this.player.gripSpaces[side];
    space.getWorldPosition(this.hand);
    space.getWorldQuaternion(this.handQuat);
    return true;
  }

  private pressed(side: Side): boolean {
    const pose = this.scriptedPose[side];
    return pose ? pose.squeeze : grip[side].pressed;
  }

  /** The squeeze started this frame. */
  private down(side: Side): boolean {
    const pose = this.scriptedPose[side];
    if (pose) {
      const down = pose.squeeze && !this.squeezed[side];
      this.squeezed[side] = pose.squeeze;
      return down;
    }
    return grip[side].down;
  }

  /** A point `along` the fist's hole from its middle (thumb side), for the hand read last; a scripted hand's fist points straight up. */
  private alongFist(side: Side, along: number, out: Vector3): Vector3 {
    if (this.scriptedPose[side]) {
      return out.copy(this.hand).setY(this.hand.y + along);
    }
    return out.copy(this.fistAxis[side]).multiplyScalar(along).add(this.fistCentre[side]).applyQuaternion(this.handQuat).add(this.hand);
  }

  /** How far along tear `i`'s slit (0 to 1) a hand above (x, z) is. */
  private alongEdge(i: number, x: number, z: number): number {
    const spot = TEAR_SPOTS[i];
    const along = (x - spot.x) * spot.ax + (z - spot.z) * spot.az;
    return Math.min(1, Math.max(0, along / Math.max(envelope.tears[i].length, 1e-3) + 0.5));
  }

  /** A free hand squeezed: a torn edge in reach, else a patch from the box, else the hammer from its rack. */
  private take(side: Side): void {
    const h = this.hand;
    let best = EDGE_REACH;
    let bestSpot = -1;
    let bestT = 0;
    for (let i = 0; i < TEAR_SPOTS.length; i++) {
      const tear = envelope.tears[i];
      if (!tear.unmended) continue;
      const t = this.alongEdge(i, h.x, h.z);
      slitPoint(this.canvas, TEAR_SPOTS[i], tear.length, t, EDGE_DROP, this.tmp);
      const d = Math.hypot(h.x - this.tmp.x, h.y - this.tmp.y, h.z - this.tmp.z);
      if (d <= best) {
        best = d;
        bestSpot = i;
        bestT = t;
      }
    }
    if (bestSpot >= 0) {
      this.held[side] = { kind: 'edge', spot: bestSpot, t: bestT };
      handUse[side] = 'edge';
      this.pulse(side, 0.5, 40);
      return;
    }
    if (Math.hypot(h.x - PATCH_BOX[0], h.y - PATCH_BOX[1], h.z - PATCH_BOX[2]) <= PATCH_BOX_REACH) {
      this.held[side] = { kind: 'patch' };
      handUse[side] = 'patch';
      this.pulse(side, 0.3, 25);
      return;
    }
    const other = side === 'left' ? 'right' : 'left';
    if (
      Math.hypot(h.x - HAMMER_REST[0], h.y - HAMMER_REST[1], h.z - HAMMER_REST[2]) <= HAMMER_REACH &&
      this.held[other]?.kind !== 'hammer' &&
      this.crewHand(HoldKind.Hammer) === null
    ) {
      this.held[side] = { kind: 'hammer' };
      handUse[side] = 'hammer';
      this.headValid[side] = false;
      this.pulse(side, 0.4, 30);
    }
  }

  /** A hand on a torn edge slides along it with the hand, and lets go if pulled away (or once the tear is mended). */
  private workEdge(side: Side, held: { kind: 'edge'; spot: number; t: number }): void {
    const tear = envelope.tears[held.spot];
    if (!tear.unmended) {
      this.release(side);
      return;
    }
    const t = this.alongEdge(held.spot, this.hand.x, this.hand.z);
    slitPoint(this.canvas, TEAR_SPOTS[held.spot], tear.length, t, EDGE_DROP, this.tmp);
    if (Math.hypot(this.hand.x - this.tmp.x, this.hand.y - this.tmp.y, this.hand.z - this.tmp.z) > HOLD_SLIP) {
      this.release(side);
      this.pulse(side, 0.6, 50);
      return;
    }
    held.t = t;
  }

  /** A carried patch sticks to the first tear it touches that needs one. */
  private carryPatch(side: Side, host: boolean): void {
    this.alongFist(side, PAD_ALONG, this.point);
    const p = this.point;
    for (let i = 0; i < TEAR_SPOTS.length; i++) {
      const tear = envelope.tears[i];
      if (!(tear.phase === 'open' || (tear.phase === 'patched' && tear.rushed))) continue;
      if (!patchTouches(this.canvas, TEAR_SPOTS[i], p.x, p.y, p.z)) continue;
      const result = envelope.press(i);
      if (result === null) continue;
      console.info(`[Repairs] patch on tear ${i}: ${result === 'held' ? 'held shut, rivet it' : 'rushed, it will peel'}`);
      this.held[side] = null;
      handUse[side] = null;
      this.pulse(side, 0.7, 60);
      if (host) {
        this.changed = true;
      } else {
        netLink.sendEvent({ t: 'repair-patch', r: envelope.resets, s: i } as { t: string });
      }
      return;
    }
  }

  /** The hammer's head struck upwards into a rivet's place on a patch sets it (on a patch held shut and waiting for them). */
  private swingHammer(side: Side, now: number, dt: number, host: boolean): void {
    const head = this.alongFist(side, HAMMER_HEAD, this.point);
    const prev = this.headPrev[side];
    const rising = this.headValid[side] && dt > 0 ? (head.y - prev.y) / dt : 0;
    prev.copy(head);
    this.headValid[side] = true;
    if (rising < STRIKE_SPEED || now - this.lastStrike[side] < STRIKE_COOLDOWN_MS) {
      return;
    }
    for (let i = 0; i < TEAR_SPOTS.length; i++) {
      const tear = envelope.tears[i];
      if (tear.phase !== 'patched') continue;
      for (let r = 0; r < RIVETS; r++) {
        if (tear.rivets & (1 << r)) continue;
        rivetPoint(this.canvas, TEAR_SPOTS[i], tear.patchLength, r, this.tmp);
        if (Math.hypot(head.x - this.tmp.x, head.y - this.tmp.y, head.z - this.tmp.z) > RIVET_REACH) continue;
        this.lastStrike[side] = now;
        if (envelope.rivet(i, r)) {
          this.pulse(side, 1, 50);
          if (host) {
            this.changed = true;
          } else {
            netLink.sendEvent({ t: 'repair-rivet', r: envelope.resets, s: i, i: r } as { t: string });
          }
        } else {
          // A rushed patch, or one nobody is holding shut: it won't take a rivet.
          sounds.rivet(false);
          this.pulse(side, 0.4, 30);
        }
        return;
      }
    }
  }

  private release(side: Side): void {
    const held = this.held[side];
    if (held && handUse[side] === held.kind) {
      handUse[side] = null;
    }
    this.held[side] = null;
  }

  private letGoAll(): void {
    for (const side of SIDES) this.release(side);
  }

  /** Guest: where this player's hands hold the edges, when that changes (and again each second while they do). */
  private sendHolds(now: number): void {
    if (!netLink.connected) return;
    const key = this.myHolds.map(([s, t]) => `${s}:${Math.round(t * 20)}`).join(',');
    if (key === this.sentHolds && (key === '' || now - this.holdsSentAt < RESEND_MS)) return;
    this.sentHolds = key;
    this.holdsSentAt = now;
    netLink.sendEvent({ t: 'repair-holds', r: envelope.resets, h: this.myHolds.map(([s, t]) => [s, Math.round(t * 100) / 100]) } as { t: string });
  }

  /** Sounds from the tears as this page has them: a rip as one opens or a patch peels off, a slap for each patch, a clink for each rivet. */
  private hear(): void {
    for (let i = 0; i < TEAR_SPOTS.length; i++) {
      const tear = envelope.tears[i];
      const heard = this.heard[i];
      if (tear.phase === 'open' && heard.phase !== 'open') {
        sounds.rip();
      }
      if (tear.patches !== heard.patches && tear.phase !== 'whole') {
        sounds.slap();
      }
      const added = tear.rivets & ~heard.rivets;
      if (added && tear.phase !== 'whole') {
        sounds.rivet(true);
      }
      heard.phase = tear.phase;
      heard.rivets = tear.rivets;
      heard.patches = tear.patches;
    }
    sounds.setHiss(envelope.leak / (LEAK_PER_METRE * 0.5));
  }

  private draw(now: number, dt: number): void {
    let rivets = 0;
    let puffing = false;
    for (let i = 0; i < TEAR_SPOTS.length; i++) {
      const tear = envelope.tears[i];
      const spot = TEAR_SPOTS[i];
      const open = tear.phase === 'open';
      const mesh = this.tears[i];
      mesh.visible = open;
      if (open) {
        // The lips close up as hands pinch them, and gape again when let go.
        const target = tear.closed ? 1 : tear.hands > 0 ? 0.4 : 0;
        this.heldShown[i] += (target - this.heldShown[i]) * Math.min(1, dt * 8);
        this.shape.length = tear.length;
        this.shape.held = this.heldShown[i];
        this.shape.time = now / 1000;
        layTear(mesh, this.canvas, spot, this.shape);
      }
      const patched = tear.phase === 'patched' || tear.phase === 'sound';
      const patch = this.patches[i];
      patch.visible = patched;
      if (patched) {
        const peel = tear.peeling ? Math.round((1 - tear.life / PEEL_SECONDS) * 50) / 50 : 0;
        const laid = this.laidPatch[i];
        if (laid.length !== tear.patchLength || laid.peel !== peel) {
          laid.length = tear.patchLength;
          laid.peel = peel;
          layPatch(patch, this.canvas, spot, tear.patchLength, peel);
        }
        if (!tear.rushed) {
          for (let r = 0; r < RIVETS; r++) {
            const set = tear.phase === 'sound' || (tear.rivets & (1 << r)) !== 0;
            rivetPoint(this.canvas, spot, tear.patchLength, r, this.tmp);
            this.pos.set(this.tmp.x, this.tmp.y, this.tmp.z);
            this.scale.set(set ? 1 : 0.7, set ? 1 : 0.2, set ? 1 : 0.7);
            this.matrix.compose(this.pos, this.noTurn, this.scale);
            this.rivets.setMatrixAt(rivets, this.matrix);
            this.rivets.setColorAt(rivets, this.color.setHex(set ? RIVET_COLORS.set : RIVET_COLORS.hole));
            rivets++;
          }
        }
      }
      puffing = this.layPuffs(i, now, open || tear.peeling) || puffing;
    }
    this.rivets.count = rivets;
    this.rivets.instanceMatrix.needsUpdate = true;
    if (this.rivets.instanceColor) this.rivets.instanceColor.needsUpdate = true;
    this.puffs.visible = puffing;
    if (puffing) (this.puffs.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    this.drawHeldGear();
  }

  /** Puffs of air streaming down and out of tear `i` while it leaks; returns whether it shows any. */
  private layPuffs(i: number, now: number, leaking: boolean): boolean {
    const a = this.puffPositions;
    const tear = envelope.tears[i];
    const spot = TEAR_SPOTS[i];
    // Held shut, only a little gets out.
    const travel = PUFF_TRAVEL * (tear.phase === 'open' ? (tear.closed ? 0.25 : tear.hands > 0 ? 0.6 : 1) : 0.5);
    for (let k = 0; k < PUFFS_PER_TEAR; k++) {
      const o = (i * PUFFS_PER_TEAR + k) * 3;
      if (!leaking) {
        a[o + 1] = -1000;
        continue;
      }
      const along = ((k * 0.618) % 1) * 0.8 + 0.1;
      const age = ((now / 1000) * 1.3 + k / PUFFS_PER_TEAR) % 1;
      slitPoint(this.canvas, spot, tear.phase === 'open' ? tear.length : tear.patchLength * 0.8, along, 0.02, this.tmp);
      const spread = (k % 2 ? 1 : -1) * age * 0.12;
      a[o] = this.tmp.x - spot.az * spread;
      a[o + 1] = this.tmp.y - age * travel;
      a[o + 2] = this.tmp.z + spot.ax * spread;
    }
    return leaking;
  }

  /** The hammer (in this player's hand, the crewmate's, or on its rack) and any patches carried. */
  private drawHeldGear(): void {
    let hammerDrawn = false;
    for (const side of SIDES) {
      const held = this.held[side];
      const pad = this.pads[side];
      pad.visible = held?.kind === 'patch' && this.readPose(side);
      if (pad.visible) {
        this.alongFist(side, PAD_ALONG, pad.position);
        pad.quaternion.copy(this.handQuat);
        if (!this.scriptedPose[side]) pad.quaternion.multiply(this.padInFist[side]);
      }
      if (held?.kind === 'hammer' && this.readPose(side)) {
        this.alongFist(side, 0, this.hammer.position);
        if (this.scriptedPose[side]) {
          this.hammer.quaternion.copy(this.hammerUp);
        } else {
          this.hammer.quaternion.copy(this.handQuat).multiply(this.hammerInFist[side]);
        }
        hammerDrawn = true;
      }
    }
    // The crewmate's hands, as their pose says.
    for (const side of SIDES) {
      const p = this.crewSide(side, HoldKind.Patch);
      const pad = this.crewPads[side];
      pad.visible = p !== null;
      if (p) this.onCrewFist(p, side, PAD_ALONG, this.padInFist[side], pad);
    }
    if (!hammerDrawn) {
      const crew = this.crewHand(HoldKind.Hammer);
      if (crew) {
        this.onCrewFist(crew.pose, crew.side, 0, this.hammerInFist[crew.side], this.hammer);
      } else {
        this.hammer.position.set(HAMMER_REST[0], HAMMER_REST[1], HAMMER_REST[2]);
        this.hammer.quaternion.copy(this.hammerUp);
      }
    }
  }

  /** Read a hand's pose again for drawing (the hands were read for working the gear; this frame's values are the same). */
  private readPose(side: Side): boolean {
    const pose = this.scriptedPose[side];
    if (pose) {
      this.hand.set(pose.x, pose.y, pose.z);
      this.handQuat.identity();
      return true;
    }
    if (!this.world.session || !this.input.xr.getPrimaryInputSource(side)) return false;
    const space = this.player.gripSpaces[side];
    space.getWorldPosition(this.hand);
    space.getWorldQuaternion(this.handQuat);
    return true;
  }

  /** Put `mesh` on the crewmate's fist at `pose`, `along` its hole, turned by `inFist`. */
  private onCrewFist(pose: PoseSample, side: Side, along: number, inFist: Quaternion, mesh: Mesh): void {
    this.crewQuat.set(pose.qx, pose.qy, pose.qz, pose.qw);
    mesh.position.copy(this.fistAxis[side]).multiplyScalar(along).add(this.fistCentre[side]).applyQuaternion(this.crewQuat);
    mesh.position.x += pose.px;
    mesh.position.y += pose.py;
    mesh.position.z += pose.pz;
    mesh.quaternion.copy(this.crewQuat).multiply(inFist);
  }

  /** The crewmate's hand holding `kind`, as drawn, or null. */
  private crewHand(kind: number): { pose: PoseSample; side: Side } | null {
    const left = this.crewSide('left', kind);
    if (left) return { pose: left, side: 'left' };
    const right = this.crewSide('right', kind);
    return right ? { pose: right, side: 'right' } : null;
  }

  private crewSide(side: Side, kind: number): PoseSample | null {
    if (!netLink.connected || !netLink.haveRemote) return null;
    const r = netLink.remote;
    return ((r.holds >> (side === 'left' ? 0 : 4)) & 15) === kind ? (side === 'left' ? r.left : r.right) : null;
  }

  private place(mesh: Mesh, visible: boolean): Mesh {
    mesh.visible = visible;
    this.world.createTransformEntity(mesh);
    return mesh;
  }

  private pulse(side: Side, intensity: number, ms: number): void {
    const actuator = this.input.xr.gamepads[side]?.gamepad.hapticActuators?.[0] as
      | { pulse?: (value: number, duration: number) => Promise<boolean> }
      | undefined;
    void actuator?.pulse?.(intensity, ms)?.catch(() => undefined);
  }

  /** Two signs on one canvas: under the loft's inboard edge, seen from the deck, and on the loft's inboard rail, seen from on it. */
  private createSigns(): void {
    const canvas = document.createElement('canvas');
    canvas.width = SIGN_PX[0];
    canvas.height = SIGN_PX[1];
    const ctx = canvas.getContext('2d')!;
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({ map: texture, toneMapped: false, side: DoubleSide });
    const geometry = new PlaneGeometry(SIGN_SIZE[0], SIGN_SIZE[1]);
    const deck = new Mesh(geometry, material);
    deck.name = 'Envelope Sign';
    deck.position.set(LOFT.x1 + 0.005, 2.3, 0.55);
    deck.rotation.y = Math.PI / 2;
    const loft = new Mesh(geometry, material);
    loft.name = 'Envelope Sign (Loft)';
    loft.position.set(LOFT.x1 - 0.068, 3.18, 0.62);
    loft.rotation.y = -Math.PI / 2;
    for (const mesh of [deck, loft]) this.world.createTransformEntity(mesh);
    this.sign = { ctx, texture, lines: [] };
    this.drawSign();
  }

  private signLines(): { lines: string[]; tone: 'bad' | 'warn' | 'good' } {
    let open = 0;
    let closed = false;
    let waiting = -1;
    let rushedLife = Number.POSITIVE_INFINITY;
    for (const tear of envelope.tears) {
      if (tear.phase === 'open') {
        open++;
        closed ||= tear.closed;
      } else if (tear.phase === 'patched' && !tear.rushed) {
        waiting = Math.max(waiting, countBits(tear.rivets));
        closed ||= tear.closed;
      } else if (tear.phase === 'patched') {
        rushedLife = Math.min(rushedLife, tear.life);
      }
    }
    if (open > 0) {
      return { lines: [open > 1 ? `${open} TEARS!` : 'TEAR!', 'leaking hot air', closed ? 'held: patch it' : 'hold it shut'], tone: 'bad' };
    }
    if (waiting >= 0) {
      return { lines: ['PATCH ON', `rivets ${waiting} of ${RIVETS}`, closed ? 'hammer them up' : 'keep it held!'], tone: 'warn' };
    }
    if (Number.isFinite(rushedLife)) {
      return { lines: ['RUSHED PATCH', rushedLife < PEEL_SECONDS ? 'PEELING OFF' : `holds ${Math.ceil(rushedLife)} s`, 'hold it, patch again'], tone: 'warn' };
    }
    return { lines: ['ENVELOPE', 'sound', ''], tone: 'good' };
  }

  private drawSign(): void {
    const { lines, tone } = this.signLines();
    if (lines.length === this.sign.lines.length && lines.every((line, i) => line === this.sign.lines[i])) {
      return;
    }
    this.sign.lines = lines;
    const { ctx, texture } = this.sign;
    const [w, h] = SIGN_PX;
    ctx.fillStyle = '#2b1d12';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#c9a03a';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, w - 4, h - 4);
    ctx.textAlign = 'center';
    ctx.font = 'bold 30px sans-serif';
    ctx.fillStyle = tone === 'bad' ? '#f08a5d' : tone === 'warn' ? '#e9c46a' : '#7fd17f';
    ctx.fillText(lines[0], w / 2, 40);
    ctx.font = 'bold 24px sans-serif';
    ctx.fillStyle = '#f3e3c3';
    ctx.fillText(lines[1] ?? '', w / 2, 76);
    ctx.fillStyle = '#e8d4a2';
    ctx.fillText(lines[2] ?? '', w / 2, 110);
    texture.needsUpdate = true;
  }
}

function countBits(n: number): number {
  let c = 0;
  for (let v = n; v; v &= v - 1) c++;
  return c;
}
