import { type CargoGround, type CargoSim, CRATE_HEIGHT, CRATE_SIZE, type GroundAt, HATCH_CENTER, TRUNK_DEPTH } from './cargo.js';
import { shipToWorld, worldToShip } from './docking.js';
import { DECK_LENGTH, DECK_WIDTH, RAIL_HEIGHT } from './gondola-layout.js';
import type { LoadingStage } from './route.js';
import type { ShipState } from './ship-motion.js';

/**
 * Loading and stowing (Phase 3 cargo, second slice, docs/cargo.md): the
 * crates carried by hand. Engine-free, like the flight model.
 *
 * A run starts with the crates on the loading stage beside the ship on
 * island A. The crew lifts them by their rope handles over the rail, sets
 * one in the hatch (where it is hooked to the hoist line and becomes the
 * winch's: src/sim/cargo.ts) and stows the other on deck, which trims the
 * ship where it sits. At island B the one in the hatch is lowered, the empty
 * hook wound back up, and the other lifted into the hatch and lowered too.
 *
 * A crate is heavy: one hand on one handle only drags it across what it
 * stands on; both handles held lift it, slowly for one player and easily
 * for two (one handle each). It can't pass through the bulwark below the
 * rail, the gear on deck or the other crate. Let go, it settles on whatever
 * is below it or falls, and a fall of more than `DROP_FREE` knocks it.
 *
 * Crates on deck, in hand or falling are in ship space (deck at y = 0, bow
 * towards -Z, starboard +X); crates resting in the world (on the loading
 * stage, or delivered) are in world space. Positions are the middle of the
 * crate's bottom; yaw turns it about Y (its handles are on its own ±X faces).
 */

export const CRATE_COUNT = 2;

/**
 * Where a crate is: resting in the world, on deck, in someone's hands,
 * falling, in the hatch (the cargo sim has it), delivered, or lost
 * overboard. Indices are sent to the crewmate.
 */
export const CRATE_STATES = ['ground', 'deck', 'held', 'falling', 'hatch', 'delivered', 'lost'] as const;
export type CrateState = (typeof CRATE_STATES)[number];

/** The rope handles: this far out from the crate's middle on its ±X faces, and this high above its bottom (as the crate model has them). */
export const HANDLE_OUT = CRATE_SIZE / 2 + 0.012;
export const HANDLE_UP = CRATE_HEIGHT * 0.68;
/** A hand this close to a handle can take it, m. */
export const HANDLE_REACH = 0.12;
/** A hand this far from the handle it holds slips off it, m. */
export const HANDLE_SLIP = 0.3;
/** One player holding both handles carries a crate this fast across, up and down, m/s, and turns it this fast, rad/s... */
export const CARRY_ALONE = 0.6;
export const LIFT_ALONE = 0.4;
export const LOWER_ALONE = 0.8;
export const TURN_ALONE = 1.5;
/** ...and two players, a handle each, this fast. */
export const CARRY_TOGETHER = 2;
export const LIFT_TOGETHER = 1.5;
export const TURN_TOGETHER = 4;
/** One hand on one handle drags a crate across what it stands on at most this fast, m/s. */
export const DRAG_SPEED = 0.3;
/** A crate that falls further than this is knocked, costing this much condition (%) per m over. */
export const DROP_FREE = 0.25;
export const DROP_COST = 60;
/** A crate lowered over the hatch with its middle this close to the hatch's middle goes into the trunk, m. */
export const HATCH_ENTRY = 0.12;
/** A falling crate this far below the deck is gone, m. */
const LOST_BELOW = 30;

const HALF = CRATE_SIZE / 2;
/** The bulwark: the deck's edge inside, the hull's side outside (its walls are 0.1 m thick). */
const INSIDE_X = DECK_WIDTH / 2;
const INSIDE_Z = DECK_LENGTH / 2;
const OUTSIDE_X = INSIDE_X + 0.1;
const OUTSIDE_Z = INSIDE_Z + 0.1;
/** Crates rest on what is this close below them, m. */
const REST_SLOP = 0.02;

/** Gear standing on the deck that a crate can't pass through (or can rest on top of): its footprint and its top, ship space. */
export interface DeckObstacle {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  bottom: number;
  top: number;
}

/** The gondola's colliders (src/scene-assets/gondola.scene-asset.ts) as obstacles, less the deck and the walls (the bulwark is handled on its own). */
export function obstaclesFrom(colliders: readonly { name: string; center: readonly number[]; size: readonly number[] }[]): DeckObstacle[] {
  return colliders
    .filter((c) => c.name !== 'deck' && !c.name.startsWith('wall-'))
    .map((c) => ({
      x0: c.center[0] - c.size[0] / 2,
      x1: c.center[0] + c.size[0] / 2,
      z0: c.center[2] - c.size[2] / 2,
      z1: c.center[2] + c.size[2] / 2,
      bottom: c.center[1] - c.size[1] / 2,
      top: c.center[1] + c.size[1] / 2,
    }));
}

export interface Crate {
  state: CrateState;
  /** The middle of its bottom: ship space on deck, held or falling; world space resting in the world (ground, delivered). */
  x: number;
  y: number;
  z: number;
  /** Turned about Y, rad (ship space or world, as its position). In the hatch, a quarter turn. */
  yaw: number;
  /** Falling: its velocity (ship space) and the height the fall started from. */
  vx: number;
  vy: number;
  vz: number;
  fromY: number;
  /** 0 to 100 %. */
  condition: number;
  /** Who holds each handle: -1 nobody, else the crew index (0 the host or a solo player, 1 the guest). */
  holders: [number, number];
}

/** A hand on a crate's handle this step: which crate and handle, whose hand (crew index), and where it is (ship space). */
export interface CrateHand {
  crate: number;
  handle: number;
  crew: number;
  x: number;
  y: number;
  z: number;
  /** How far it can get from its handle before it slips off, m (HANDLE_SLIP if not given; more for the crewmate's hands, which arrive late). */
  slip?: number;
}

/** The handle's place on a crate (ship space) for a crate at (x, y, z) turned by yaw. */
export function handleAt(x: number, y: number, z: number, yaw: number, handle: number, out: { x: number; y: number; z: number }): void {
  const side = handle === 0 ? -HANDLE_OUT : HANDLE_OUT;
  out.x = x + side * Math.cos(yaw);
  out.y = y + HANDLE_UP;
  out.z = z - side * Math.sin(yaw);
}

function wrap(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/** The nearest quarter turn to `yaw`. */
function quarter(yaw: number): number {
  return Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
}

export class CrateYard {
  readonly crates: Crate[] = [];
  /** Which crate is in the hatch (the cargo sim's), or -1. */
  hatchCrate = -1;
  /** Knocks so far this run, for all crates (wraps at 256; the crewmate plays a thump when it changes), and how hard the last was (%). */
  knocks = 0;
  lastKnock = 0;
  /** Counts restarts. */
  resets = 0;
  /** Each crate's ship-space position this step (world ones turned to ship space), for collisions. */
  private readonly at: { x: number; y: number; z: number; yaw: number; solid: boolean }[] = [];
  private tmp = { x: 0, y: 0, z: 0 };
  private tmp2 = { x: 0, y: 0, z: 0 };
  private pose = { x: 0, y: 0, z: 0, yaw: 0 };
  private groundOut: CargoGround = { y: Number.NEGATIVE_INFINITY, delivery: false };
  /** Hands on each crate's handles this step (indices into the hands passed in), -1 for none. */
  private grips: [number, number][] = [];

  constructor(readonly obstacles: readonly DeckObstacle[]) {
    for (let i = 0; i < CRATE_COUNT; i++) {
      this.crates.push({ state: 'ground', x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, fromY: 0, condition: 100, holders: [-1, -1] });
      this.at.push({ x: 0, y: 0, z: 0, yaw: 0, solid: false });
      this.grips.push([-1, -1]);
    }
  }

  /** A fresh run: the crates back on the loading stage, the hatch empty. */
  reset(stage: LoadingStage, cargo: CargoSim): void {
    this.resets++;
    this.knocks = 0;
    this.lastKnock = 0;
    this.hatchCrate = -1;
    cargo.clear();
    this.crates.forEach((c, i) => {
      const [x, z] = stage.crates[i % stage.crates.length];
      Object.assign(c, { state: 'ground', x, y: stage.top, z, yaw: stage.yaw, vx: 0, vy: 0, vz: 0, fromY: 0, condition: 100 });
      c.holders[0] = c.holders[1] = -1;
    });
  }

  /** Practice starts: the first crate in the hatch, the others stowed on deck at `deck` (ship-space x, z each). */
  stowAboard(cargo: CargoSim, deck: readonly (readonly [number, number])[]): void {
    this.crates.forEach((c, i) => {
      Object.assign(c, { vx: 0, vy: 0, vz: 0, fromY: 0, condition: 100 });
      c.holders[0] = c.holders[1] = -1;
      if (i === 0) {
        Object.assign(c, { state: 'hatch', x: HATCH_CENTER[0], y: -TRUNK_DEPTH, z: HATCH_CENTER[1], yaw: 0 });
      } else {
        const [x, z] = deck[(i - 1) % deck.length];
        Object.assign(c, { state: 'deck', x, y: 0, z, yaw: 0 });
      }
    });
    this.hatchCrate = 0;
    cargo.load(100);
  }

  /** The hatch is ready for a crate: empty, the hook wound up into it and the door shut. */
  hatchReady(cargo: CargoSim): boolean {
    return this.hatchCrate < 0 && cargo.ready;
  }

  /** Whether hands can take hold of crate `i` now. */
  grabbable(i: number, cargo: CargoSim): boolean {
    const c = this.crates[i];
    switch (c.state) {
      case 'ground':
      case 'deck':
      case 'held':
        return true;
      case 'hatch':
        // Only sitting on the shut door in the trunk.
        return i === this.hatchCrate && cargo.phase === 'aboard' && !cargo.doorOpen;
      default:
        return false;
    }
  }

  /** Where crate `i` is in ship space now (its bottom's middle) and its yaw there, into `out`. */
  shipPose(i: number, ship: ShipState, cargo: CargoSim, out: { x: number; y: number; z: number; yaw: number }): void {
    const c = this.crates[i];
    if (c.state === 'ground' || c.state === 'delivered' || c.state === 'lost') {
      worldToShip(ship, c.x, c.y, c.z, this.tmp);
      out.x = this.tmp.x;
      out.y = this.tmp.y;
      out.z = this.tmp.z;
      out.yaw = c.yaw - ship.yaw;
    } else if (c.state === 'hatch' && i === this.hatchCrate) {
      cargo.topInShip(ship, this.tmp);
      out.x = this.tmp.x;
      out.y = this.tmp.y - CRATE_HEIGHT;
      out.z = this.tmp.z;
      out.yaw = c.yaw;
    } else {
      out.x = c.x;
      out.y = c.y;
      out.z = c.z;
      out.yaw = c.yaw;
    }
  }

  /** The nearest free handle within `HANDLE_REACH` of a hand at ship-space (x, y, z): [crate, handle], or null. `crew` is whose hand it is. */
  handleNear(ship: ShipState, cargo: CargoSim, x: number, y: number, z: number, crew: number): [number, number] | null {
    let best: [number, number] | null = null;
    let bestD = HANDLE_REACH;
    const pose = this.pose;
    for (let i = 0; i < this.crates.length; i++) {
      if (!this.grabbable(i, cargo)) continue;
      this.shipPose(i, ship, cargo, pose);
      for (let h = 0; h < 2; h++) {
        const holder = this.crates[i].holders[h];
        if (holder !== -1 && holder !== crew) continue;
        handleAt(pose.x, pose.y, pose.z, pose.yaw, h, this.tmp2);
        const d = Math.hypot(this.tmp2.x - x, this.tmp2.y - y, this.tmp2.z - z);
        if (d < bestD) {
          bestD = d;
          best = [i, h];
        }
      }
    }
    return best;
  }

  /** Crates the ship carries (on deck, in hand, falling, or in the hatch or on its line): their weight counts for lift and trim. */
  aboard(cargo: CargoSim): number {
    let n = 0;
    for (let i = 0; i < this.crates.length; i++) if (this.isAboard(i, cargo)) n++;
    return n;
  }

  isAboard(i: number, cargo: CargoSim): boolean {
    const s = this.crates[i].state;
    return s === 'deck' || s === 'held' || s === 'falling' || (s === 'hatch' && cargo.carried);
  }

  /** Crates delivered so far, and the sum of their conditions, %. */
  delivered(): { count: number; condition: number } {
    let count = 0;
    let condition = 0;
    for (const c of this.crates) {
      if (c.state === 'delivered') {
        count++;
        condition += c.condition;
      }
    }
    return { count, condition };
  }

  /** Crates still on the loading stage or anywhere else in the world not delivered. */
  get leftBehind(): number {
    return this.crates.filter((c) => c.state === 'ground').length;
  }

  /** The guest: take the host's word for crate `i`. */
  adopt(i: number, state: CrateState, x: number, y: number, z: number, yaw: number, condition: number, holder0: number, holder1: number): void {
    const c = this.crates[i];
    c.state = state;
    c.x = x;
    c.y = y;
    c.z = z;
    c.yaw = yaw;
    c.condition = condition;
    c.holders[0] = holder0;
    c.holders[1] = holder1;
    if (state === 'hatch') {
      this.hatchCrate = i;
    } else if (this.hatchCrate === i) {
      this.hatchCrate = -1;
    }
  }

  /**
   * Host or solo: move the crates on by `dt` with these hands on them.
   * `ground` says what is under a world point (the loading stage, islands,
   * the cargo stage, the jetty). Returns a bit for each hand (by its index
   * in `hands`) that couldn't take hold or slipped off, so its owner lets
   * go. `only`, if given, steps just that crate and only while two hands
   * carry it (the guest running ahead of the host with a crate it carries
   * alone).
   */
  step(ship: ShipState, cargo: CargoSim, hands: readonly CrateHand[], dt: number, ground: GroundAt, only = -1): number {
    let refused = 0;
    // The crate in the hatch: its condition, and whether it has been delivered.
    if (only < 0 && this.hatchCrate >= 0) {
      const c = this.crates[this.hatchCrate];
      c.condition = cargo.condition;
      if (cargo.phase === 'delivered') {
        c.state = 'delivered';
        c.x = cargo.rest.x;
        c.y = cargo.rest.y;
        c.z = cargo.rest.z;
        c.yaw = c.yaw + ship.yaw;
        this.hatchCrate = -1;
      } else if (cargo.phase === 'empty') {
        // Taken off the hook some other way: back on the deck over the hatch.
        this.hatchCrate = -1;
        Object.assign(c, { state: 'deck', x: HATCH_CENTER[0], y: 0, z: HATCH_CENTER[1] });
      }
    }

    // Who holds what.
    for (let i = 0; i < this.crates.length; i++) {
      this.grips[i][0] = this.grips[i][1] = -1;
    }
    for (let k = 0; k < hands.length; k++) {
      const hand = hands[k];
      const c = this.crates[hand.crate];
      const h = hand.handle;
      if (!c || (h !== 0 && h !== 1) || (only >= 0 && hand.crate !== only)) continue;
      const other = c.holders[h];
      if (!this.grabbable(hand.crate, cargo) || this.grips[hand.crate][h] >= 0 || (other !== -1 && other !== hand.crew)) {
        refused |= 1 << k;
        continue;
      }
      this.grips[hand.crate][h] = k;
    }
    for (let i = 0; i < this.crates.length; i++) {
      if (only >= 0 && i !== only) continue;
      const c = this.crates[i];
      const [a, b] = this.grips[i];
      c.holders[0] = a >= 0 ? hands[a].crew : -1;
      c.holders[1] = b >= 0 ? hands[b].crew : -1;
    }

    // Where each one is in ship space, for collisions.
    const pose = this.pose;
    for (let i = 0; i < this.crates.length; i++) {
      this.shipPose(i, ship, cargo, pose);
      const s = this.crates[i].state;
      Object.assign(this.at[i], pose);
      this.at[i].solid = s === 'ground' || s === 'deck' || s === 'held' || s === 'falling';
    }

    for (let i = 0; i < this.crates.length; i++) {
      if (only >= 0 && i !== only) continue;
      const c = this.crates[i];
      const [a, b] = this.grips[i];
      const held = (a >= 0 ? 1 : 0) + (b >= 0 ? 1 : 0);
      if (only >= 0 && held < 2) continue;
      if (held === 2 && c.state !== 'falling') {
        this.lift(i, ship, cargo);
        this.carry(i, hands[a], hands[b], hands[a].crew !== hands[b].crew, ship, cargo, ground, dt);
        refused |= this.slipped(i, hands, a, ship, cargo) ? 1 << a : 0;
        refused |= this.slipped(i, hands, b, ship, cargo) ? 1 << b : 0;
      } else if (held === 1 && (c.state === 'deck' || c.state === 'ground')) {
        const k = a >= 0 ? a : b;
        this.drag(i, hands[k], ship, ground, cargo, dt);
        refused |= this.slipped(i, hands, k, ship, cargo) ? 1 << k : 0;
      } else if (c.state === 'held') {
        // Nobody holds it by both handles: set down, or dropped.
        this.release(i, ship, cargo, ground);
      } else if (c.state === 'falling') {
        this.fall(i, ship, cargo, ground, dt);
      } else if (c.state === 'deck') {
        // Whatever it stood on may have gone (the other crate lifted, the hatch opened under it).
        const support = this.support(i, c.x, c.y, c.z, ship, cargo, ground);
        if (support < c.y - REST_SLOP) this.startFall(c);
      }
    }
    return refused;
  }

  /** Take crate `i` up in two hands from wherever it rests. */
  private lift(i: number, ship: ShipState, cargo: CargoSim): void {
    const c = this.crates[i];
    if (c.state === 'held') return;
    const at = this.at[i];
    if (c.state === 'hatch') {
      // Lifted off the hook.
      cargo.clear();
      this.hatchCrate = -1;
    }
    c.state = 'held';
    c.x = at.x;
    c.y = at.y;
    c.z = at.z;
    c.yaw = at.yaw;
  }

  /** Two hands carry crate `i` towards where they hold it, as fast as one player or two can. */
  private carry(i: number, ha: CrateHand, hb: CrateHand, together: boolean, ship: ShipState, cargo: CargoSim, ground: GroundAt, dt: number): void {
    const c = this.crates[i];
    // The hands on handles 0 and 1: their middle is the handles' middle, and the way from 0 to 1 the crate's +X.
    const h0 = ha.handle === 0 ? ha : hb;
    const h1 = ha.handle === 0 ? hb : ha;
    const tx = (h0.x + h1.x) / 2;
    const ty = (h0.y + h1.y) / 2 - HANDLE_UP;
    const tz = (h0.z + h1.z) / 2;
    const wantYaw = Math.atan2(-(h1.z - h0.z), h1.x - h0.x);
    const across = (together ? CARRY_TOGETHER : CARRY_ALONE) * dt;
    const up = (together ? LIFT_TOGETHER : LIFT_ALONE) * dt;
    const down = (together ? LIFT_TOGETHER : LOWER_ALONE) * dt;
    const turn = (together ? TURN_TOGETHER : TURN_ALONE) * dt;

    if (c.y < -1e-3) {
      // In the trunk: it only goes up or down, square to it.
      c.y = Math.min(c.y + up, Math.max(c.y - down, ty, -TRUNK_DEPTH));
      if (c.y >= 0) c.y = 0;
      return;
    }
    let dx = tx - c.x;
    let dz = tz - c.z;
    const d = Math.hypot(dx, dz);
    if (d > across) {
      dx *= across / d;
      dz *= across / d;
    }
    let ny = c.y + Math.max(-down, Math.min(up, ty - c.y));
    let yaw = c.yaw + Math.max(-turn, Math.min(turn, wrap(wantYaw - c.yaw)));
    let nx = c.x + dx;
    let nz = c.z + dz;

    // Lowered over the hatch, ready for a crate: it goes into the trunk, squared up to it.
    const intoTrunk = ny < 0 && this.hatchReady(cargo) && Math.abs(nx - HATCH_CENTER[0]) <= HATCH_ENTRY && Math.abs(nz - HATCH_CENTER[1]) <= HATCH_ENTRY;
    if (intoTrunk) {
      c.x = HATCH_CENTER[0];
      c.z = HATCH_CENTER[1];
      c.yaw = quarter(yaw);
      c.y = Math.max(-TRUNK_DEPTH, ny);
      return;
    }
    // Across: as far as it goes without running into the bulwark, the gear or the other crate.
    const y = Math.min(c.y, ny);
    if (this.blocked(i, nx, y, nz)) {
      if (!this.blocked(i, nx, y, c.z)) {
        nz = c.z;
      } else if (!this.blocked(i, c.x, y, nz)) {
        nx = c.x;
      } else {
        nx = c.x;
        nz = c.z;
      }
    }
    // Down: no lower than what it is over.
    ny = Math.max(ny, this.support(i, nx, c.y, nz, ship, cargo, ground));
    if (ny < 0 && this.inside(nx, nz)) ny = 0;
    c.x = nx;
    c.y = ny;
    c.z = nz;
    c.yaw = wrap(yaw);
  }

  /** One hand on one handle drags crate `i` across what it stands on. */
  private drag(i: number, hand: CrateHand, ship: ShipState, ground: GroundAt, cargo: CargoSim, dt: number): void {
    const c = this.crates[i];
    const at = this.at[i];
    // The crate where the handle would be under the hand.
    const side = hand.handle === 0 ? -HANDLE_OUT : HANDLE_OUT;
    let dx = hand.x - side * Math.cos(at.yaw) - at.x;
    let dz = hand.z + side * Math.sin(at.yaw) - at.z;
    const d = Math.hypot(dx, dz);
    const most = DRAG_SPEED * dt;
    if (d > most) {
      dx *= most / d;
      dz *= most / d;
    }
    let nx = at.x + dx;
    let nz = at.z + dz;
    if (this.blocked(i, nx, at.y, nz)) {
      if (!this.blocked(i, nx, at.y, at.z)) nz = at.z;
      else if (!this.blocked(i, at.x, at.y, nz)) nx = at.x;
      else return;
    }
    if (c.state === 'ground') {
      shipToWorld(ship, nx, at.y, nz, this.tmp);
      c.x = this.tmp.x;
      c.z = this.tmp.z;
    } else {
      c.x = nx;
      c.z = nz;
    }
    at.x = nx;
    at.z = nz;
    // Dragged off the edge of what it stood on.
    const support = this.support(i, nx, at.y, nz, ship, cargo, ground);
    if (support < at.y - REST_SLOP) {
      Object.assign(c, { state: 'falling', x: nx, y: at.y, z: nz, yaw: at.yaw });
      this.startFall(c);
    }
  }

  /** Whether the hand `k` has got too far from its handle on crate `i`. */
  private slipped(i: number, hands: readonly CrateHand[], k: number, ship: ShipState, cargo: CargoSim): boolean {
    const hand = hands[k];
    const pose = this.pose;
    this.shipPose(i, ship, cargo, pose);
    handleAt(pose.x, pose.y, pose.z, pose.yaw, hand.handle, this.tmp2);
    if (Math.hypot(this.tmp2.x - hand.x, this.tmp2.y - hand.y, this.tmp2.z - hand.z) <= (hand.slip ?? HANDLE_SLIP)) {
      return false;
    }
    this.crates[i].holders[hand.handle] = -1;
    return true;
  }

  /** Nobody holds crate `i` by both handles: it settles on what is below it, or falls. */
  private release(i: number, ship: ShipState, cargo: CargoSim, ground: GroundAt): void {
    const c = this.crates[i];
    // Straddling the bulwark: to whichever side its middle is on.
    if (!this.inside(c.x, c.z) && !this.outside(c.x, c.z)) {
      if (Math.abs(c.x) <= INSIDE_X && Math.abs(c.z) <= INSIDE_Z) {
        c.x = Math.max(-INSIDE_X + HALF, Math.min(INSIDE_X - HALF, c.x));
        c.z = Math.max(-INSIDE_Z + HALF, Math.min(INSIDE_Z - HALF, c.z));
      } else if (Math.abs(c.x) - INSIDE_X > Math.abs(c.z) - INSIDE_Z) {
        c.x = Math.sign(c.x) * Math.max(Math.abs(c.x), OUTSIDE_X + HALF);
      } else {
        c.z = Math.sign(c.z) * Math.max(Math.abs(c.z), OUTSIDE_Z + HALF);
      }
    }
    this.startFall(c);
    this.fall(i, ship, cargo, ground, 0);
  }

  private startFall(c: Crate): void {
    c.state = 'falling';
    c.vx = c.vy = c.vz = 0;
    c.fromY = c.y;
  }

  /** Crate `i` falls under the felt gravity until it lands on something, or is lost. */
  private fall(i: number, ship: ShipState, cargo: CargoSim, ground: GroundAt, dt: number): void {
    const c = this.crates[i];
    const wasY = c.y;
    c.vx += ship.gx * dt;
    c.vy += ship.gy * dt;
    c.vz += ship.gz * dt;
    let nx = c.x + c.vx * dt;
    let nz = c.z + c.vz * dt;
    if (this.blocked(i, nx, Math.max(0, c.y), nz)) {
      nx = c.x;
      nz = c.z;
      c.vx = c.vz = 0;
    }
    c.x = nx;
    c.z = nz;
    c.y += c.vy * dt;
    // Into the trunk through the hatch, if it is ready for a crate and this one comes down square over it.
    const overHatch = this.inside(c.x, c.z) && Math.abs(c.x - HATCH_CENTER[0]) <= HATCH_ENTRY && Math.abs(c.z - HATCH_CENTER[1]) <= HATCH_ENTRY;
    if (overHatch && this.hatchReady(cargo)) {
      if (c.y < 0) {
        // Down in the trunk, square to it.
        c.x = HATCH_CENTER[0];
        c.z = HATCH_CENTER[1];
        c.yaw = quarter(c.yaw);
      }
      if (c.y <= -TRUNK_DEPTH) {
        // Let go already in the trunk, it slides down its sides onto the door; dropped in from above the deck, it is knocked.
        if (c.fromY > 0) this.land(c, -TRUNK_DEPTH);
        c.state = 'hatch';
        c.y = -TRUNK_DEPTH;
        this.hatchCrate = i;
        cargo.load(c.condition);
      }
      return;
    }
    const support = this.support(i, c.x, wasY, c.z, ship, cargo, ground);
    if (c.y <= support) {
      this.land(c, support);
      if (this.inside(c.x, c.z)) {
        c.state = 'deck';
        c.y = support;
      } else {
        // Resting in the world.
        shipToWorld(ship, c.x, support, c.z, this.tmp);
        c.state = 'ground';
        c.x = this.tmp.x;
        c.y = this.tmp.y;
        c.z = this.tmp.z;
        c.yaw += ship.yaw;
      }
      c.vx = c.vy = c.vz = 0;
    } else if (c.y < -LOST_BELOW) {
      c.state = 'lost';
      c.condition = 0;
    }
  }

  /** Land a falling crate on something `support` high: knocked if it fell far. */
  private land(c: Crate, support: number): void {
    const fell = c.fromY - support;
    if (fell > DROP_FREE) {
      const cost = DROP_COST * (fell - DROP_FREE);
      c.condition = Math.max(0, c.condition - cost);
      this.lastKnock = cost;
      this.knocks = (this.knocks + 1) & 255;
    }
  }

  /** The crate's footprint at (x, z) is all inside the bulwark. */
  private inside(x: number, z: number): boolean {
    return Math.abs(x) <= INSIDE_X - HALF + 1e-6 && Math.abs(z) <= INSIDE_Z - HALF + 1e-6;
  }

  /** The crate's footprint at (x, z) is all outside the hull. */
  private outside(x: number, z: number): boolean {
    return Math.abs(x) >= OUTSIDE_X + HALF - 1e-6 || Math.abs(z) >= OUTSIDE_Z + HALF - 1e-6;
  }

  /** Whether crate `i` with its bottom at y and middle at (x, z) runs into the bulwark (below the rail), the gear on deck or another crate. */
  private blocked(i: number, x: number, y: number, z: number): boolean {
    if (y < RAIL_HEIGHT && !this.inside(x, z) && !this.outside(x, z)) {
      return true;
    }
    const top = y + CRATE_HEIGHT;
    for (const o of this.obstacles) {
      if (x + HALF > o.x0 && x - HALF < o.x1 && z + HALF > o.z0 && z - HALF < o.z1 && y < o.top - REST_SLOP && top > o.bottom) {
        return true;
      }
    }
    for (let j = 0; j < this.at.length; j++) {
      const other = this.at[j];
      if (j === i || !other.solid) continue;
      if (Math.abs(x - other.x) < CRATE_SIZE && Math.abs(z - other.z) < CRATE_SIZE && y < other.y + CRATE_HEIGHT - REST_SLOP && top > other.y + REST_SLOP) {
        return true;
      }
    }
    return false;
  }

  /** The height of what is under crate `i` at (x, z), at or below `fromY` (ship space): the deck, gear or another crate on deck, or the world below. */
  private support(i: number, x: number, fromY: number, z: number, ship: ShipState, cargo: CargoSim, ground: GroundAt): number {
    let best = Number.NEGATIVE_INFINITY;
    if (this.inside(x, z)) {
      // The hatch open with no crate sitting in the trunk: a hole a crate square over it falls through.
      const hole = cargo.doorOpen && (this.hatchCrate < 0 || cargo.phase !== 'aboard');
      if (!(hole && Math.abs(x - HATCH_CENTER[0]) <= HATCH_ENTRY && Math.abs(z - HATCH_CENTER[1]) <= HATCH_ENTRY)) {
        best = 0;
      }
      for (const o of this.obstacles) {
        if (x + HALF > o.x0 && x - HALF < o.x1 && z + HALF > o.z0 && z - HALF < o.z1 && o.top <= fromY + REST_SLOP && o.top > best) {
          best = o.top;
        }
      }
      for (let j = 0; j < this.at.length; j++) {
        const other = this.at[j];
        const top = other.y + CRATE_HEIGHT;
        if (j !== i && other.solid && Math.abs(x - other.x) < CRATE_SIZE && Math.abs(z - other.z) < CRATE_SIZE && top <= fromY + REST_SLOP && top > best) {
          best = top;
        }
      }
      if (best > Number.NEGATIVE_INFINITY) return best;
    } else if (!this.outside(x, z)) {
      // On the bulwark itself (only while held above the rail).
      return RAIL_HEIGHT;
    }
    // Below the hull, or through the hatch: the world.
    shipToWorld(ship, x, fromY, z, this.tmp);
    ground(this.tmp.x, this.tmp.z, this.tmp.y + REST_SLOP, this.groundOut);
    if (this.groundOut.y === Number.NEGATIVE_INFINITY) return Number.NEGATIVE_INFINITY;
    worldToShip(ship, this.tmp.x, this.groundOut.y, this.tmp.z, this.tmp2);
    return this.tmp2.y;
  }
}

/** Where practice starts stow the crates that aren't in the hatch: port side amidships, across from the hatch (ship-space x, z). */
export const PRACTICE_DECK: readonly (readonly [number, number])[] = [[-0.62, 0.0]];

