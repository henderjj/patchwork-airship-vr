import { shipDirToWorld, shipToWorld, worldToShip } from './docking.js';
import { KEEL_DEPTH } from './gondola-layout.js';
import type { ShipState } from './ship-motion.js';

/**
 * Cargo (Phase 3 step 2, docs/cargo.md): the crate carried from island A to
 * island B and lowered through a hatch in the deck on the hoist line, by
 * the winch, steadied by the tag line. Engine-free, like the flight model.
 *
 * The crate is simulated in ship space (deck at y = 0, bow towards -Z,
 * starboard +X) as a weight on a line from the block above the hatch,
 * under the felt gravity, so the ship's turns and changes of speed swing it
 * as they would a hanging lamp. Below the keel the air reaches it: drag
 * from the wind relative to the ship, and eddies that buffet it, scaled by
 * the wind setting. While it is on the ground (resting on an island, the
 * cargo stage or the jetty) it stays where it is in the world.
 *
 * Knocks cost condition: touching down hard or swinging, scraping the
 * trunk's sides, and dropping onto the line.
 */

/** The cargo hatch in the deck: its square opening (x and z from-to), on planks' edges, m. */
export const HATCH = { x0: 0, x1: 0.5, z0: 0.5, z1: 1.0 } as const;
export const HATCH_CENTER = [(HATCH.x0 + HATCH.x1) / 2, (HATCH.z0 + HATCH.z1) / 2] as const;
export const HATCH_SIZE = HATCH.x1 - HATCH.x0;
/** The crate: square, this tall, this heavy. */
export const CRATE_SIZE = 0.4;
export const CRATE_HEIGHT = 0.36;
export const CRATE_KG = 60;
/** It trims the ship like a crew member this many times as heavy. */
export const CARGO_TRIM_WEIGHT = 0.8;
/** The trunk through the hull under the hatch is as deep as the crate, so it rides with its top level with the deck; the door is its floor. */
export const TRUNK_DEPTH = CRATE_HEIGHT;
/** How far the crate can move either way inside the trunk, m. */
const TRUNK_PLAY = (HATCH_SIZE - CRATE_SIZE) / 2;

/** The block the hoist line hangs from, on the derrick's arm above the hatch. */
export const BLOCK = [HATCH_CENTER[0], 2.3, HATCH_CENTER[1]] as const;
/** The derrick post in the stern starboard corner (x, z) and its height, and where its arm meets it. */
export const DERRICK_POST = [0.9, 1.4] as const;
export const DERRICK_HEIGHT = 2.5;
export const DERRICK_ARM_Y = 2.42;

/** Hoist line from the block to the crate's top with the crate riding in the trunk, and the shortest and longest it goes, m. */
export const LINE_ABOARD = BLOCK[1];
export const LINE_MIN = LINE_ABOARD - 0.4;
export const LINE_MAX = 12;

/**
 * The winch: a drum on the derrick post's foot with its axle along X, and
 * one handle on the drum's port end. Its angle runs from straight up
 * towards the stern (+Z); turning it that way lowers away.
 */
export const WINCH_AXLE = [0.74, 0.92, 1.24] as const;
/** The handle's grip, its radius round the axle, and how close a hand must be to take it, m. */
export const WINCH_HANDLE_X = 0.53;
export const WINCH_RADIUS = 0.17;
export const WINCH_REACH = 0.12;
/** Line paid out per radian of the handle (the drum's radius), m. */
export const DRUM_RADIUS = 0.06;
/** Fastest the handle turns lowering and hoisting, rad/s (the pawl and the load). */
export const WINCH_LOWER_SPEED = 10;
export const WINCH_HOIST_SPEED = 6;
/** A hand this far round from the handle lets go of it, rad. */
export const WINCH_SLIP = 0.9;
/** The winch angles at the line's shortest and longest. */
export const WINCH_MIN = (LINE_MIN - LINE_ABOARD) / DRUM_RADIUS;
export const WINCH_MAX = (LINE_MAX - LINE_ABOARD) / DRUM_RADIUS;

/** The hatch lever: its pivot by the hatch's forward starboard corner, its length to the knob, and how far back it opens the door, rad. */
export const LEVER_PIVOT = [0.64, 0.02, 0.52] as const;
export const LEVER_LENGTH = 0.72;
export const LEVER_OPEN = 0.7;
export const LEVER_REACH = 0.12;

/** The tag line's toggle hangs on a ring on a short post by the hatch's forward port corner; a hand this close takes it, m. */
export const TAG_RING = [-0.07, 0.72, 0.46] as const;
export const TAG_REACH = 0.12;
/** A hand further than this across the deck from the hatch drops the tag line, m. */
export const TAG_SLIP = 1.3;

/** Slack in the line (beyond reaching the crate) at which the hook slips out of a crate that rests on the ground, m. */
export const SLACK_RELEASE = 0.3;
/** Touchdown: knocked going down faster than this, and swinging sideways faster than this, m/s... */
export const TOUCH_SPEED = 0.2;
export const TOUCH_SIDE_SPEED = 0.15;
/** ...costing this much condition (%) per m/s over. */
const TOUCH_COST = 100;
const TOUCH_SIDE_COST = 60;
/** Scraping the trunk's sides faster than this, m/s, costs this per m/s over. */
export const SCRAPE_SPEED = 0.15;
const SCRAPE_COST = 40;
/** Dropping onto the line: knocked if it fell more than this, m, costing this per m over. */
const DROP_FREE = 0.1;
const DROP_COST = 60;
/** Bounce off the trunk's sides. */
const RESTITUTION = 0.3;

/** Air drag on the crate below the keel, per second (of the air's speed past it), and a little damping everywhere else. */
const DRAG = 0.25;
const STILL_DAMPING = 0.05;
/** Eddies below the keel at the usual wind, m/s². */
export const EDDY_ACCEL = 0.12;
/** The tag line: pull towards the point under the hand per m, damping per m/s, and the most it pulls, m/s². */
const TAG_PULL = 1.2;
const TAG_DAMPING = 2.0;
const TAG_MAX = 1.5;
/** Steps of at most this long, s. */
const STEP = 1 / 120;

/** What the crate is doing. Indices are sent to the crewmate. */
export const CARGO_PHASES = ['aboard', 'hanging', 'landed', 'delivered'] as const;
export type CargoPhase = (typeof CARGO_PHASES)[number];

/** What is under a point (world): the height of its top (-Infinity for nothing) and whether a crate set down there is delivered. */
export interface CargoGround {
  y: number;
  delivery: boolean;
}

/** Fills `out` with what is under world (x, z), no higher than `fromY`. */
export type GroundAt = (x: number, z: number, fromY: number, out: CargoGround) => void;

export interface CargoInput {
  /** Line out from the block, m (from the winch). */
  line: number;
  doorOpen: boolean;
  /** Someone holds the tag line, with their hand at (tagX, tagZ) across the deck. */
  tagHeld: boolean;
  tagX: number;
  tagZ: number;
  /** The wind (world, the way it blows, m/s) and the menu's wind setting (0 to 3, 1 usual). */
  windX: number;
  windZ: number;
  windScale: number;
  /** Ship time, s (sets the eddies, so host and tests agree). */
  time: number;
  ground: GroundAt;
}

export function createCargoInput(ground: GroundAt): CargoInput {
  return { line: LINE_ABOARD, doorOpen: false, tagHeld: false, tagX: HATCH_CENTER[0], tagZ: HATCH_CENTER[1], windX: 0, windZ: 0, windScale: 1, time: 0, ground };
}

/** Line out for a winch angle. */
export function lineFromWinch(angle: number): number {
  return LINE_ABOARD + angle * DRUM_RADIUS;
}

/** The winch handle's grip for winch angle `angle` (ship space). */
export function winchHandle(angle: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  out.x = WINCH_HANDLE_X;
  out.y = WINCH_AXLE[1] + WINCH_RADIUS * Math.cos(angle);
  out.z = WINCH_AXLE[2] + WINCH_RADIUS * Math.sin(angle);
  return out;
}

/** A hand at (y, z) as an angle round the winch's axle, the handle's convention. */
export function angleRoundWinch(y: number, z: number): number {
  return Math.atan2(z - WINCH_AXLE[2], y - WINCH_AXLE[1]);
}

function wrap(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/**
 * Turn the winch from `angle` towards a hand at `handAngle` (round the
 * axle) over `dt`: the handle follows the hand, but no faster than the
 * winch turns and no further than the line goes. Returns the new angle, or
 * NaN if the hand has got too far from the handle and lets go.
 */
export function turnWinch(angle: number, handAngle: number, dt: number): number {
  const lead = wrap(handAngle - angle);
  if (Math.abs(lead) > WINCH_SLIP) {
    return Number.NaN;
  }
  const step = Math.max(-WINCH_HOIST_SPEED * dt, Math.min(WINCH_LOWER_SPEED * dt, lead));
  return Math.max(WINCH_MIN, Math.min(WINCH_MAX, angle + step));
}

/** The lever's knob for a lever angle (0 upright, `LEVER_OPEN` pulled back to the stern). */
export function leverKnob(angle: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  out.x = LEVER_PIVOT[0];
  out.y = LEVER_PIVOT[1] + LEVER_LENGTH * Math.cos(angle);
  out.z = LEVER_PIVOT[2] + LEVER_LENGTH * Math.sin(angle);
  return out;
}

/** The lever's angle for a hand at (y, z) holding its knob. */
export function leverFromHand(y: number, z: number): number {
  return Math.max(0, Math.min(LEVER_OPEN, Math.atan2(z - LEVER_PIVOT[2], y - LEVER_PIVOT[1])));
}

/** Eddies under the keel: an acceleration (ship x, z) for ship time `t`, at the usual wind. */
export function eddy(t: number, out: { x: number; z: number }): void {
  out.x = EDDY_ACCEL * (Math.sin(0.71 * t + 0.3) + 0.6 * Math.sin(1.37 * t + 2.1) + 0.4 * Math.sin(0.43 * t + 4.0));
  out.z = EDDY_ACCEL * (Math.sin(0.83 * t + 1.7) + 0.6 * Math.sin(1.19 * t + 0.4) + 0.4 * Math.sin(0.37 * t + 2.6));
}

export class CargoSim {
  phase: CargoPhase = 'aboard';
  /** 0 to 100 %. */
  condition = 100;
  /** Knocks so far this run (wraps at 256; the crewmate plays a thump when it changes). */
  knocks = 0;
  /** How hard the last knock was (condition it cost, %). */
  lastKnock = 0;
  /** Line out from the block, m, and whether the door is open, as last stepped. */
  line: number = LINE_ABOARD;
  doorOpen = false;
  /** How fast the line is paying out this step, m/s (0 while hoisting): the crate can drop that fast without the line checking it. */
  private lineRate = 0;
  /** Counts restarts. */
  resets = 0;
  /** The crate's top middle (where the sling's hooked), ship space, and its velocity relative to the ship. */
  readonly pos = { x: HATCH_CENTER[0], y: 0, z: HATCH_CENTER[1] };
  readonly vel = { x: 0, y: 0, z: 0 };
  /** Resting on the ground (landed or delivered): its bottom middle in the world, and whether it's a delivery spot. */
  readonly rest = { x: 0, y: 0, z: 0, delivery: false };
  private ground: CargoGround = { y: Number.NEGATIVE_INFINITY, delivery: false };
  private tmp = { x: 0, y: 0, z: 0 };
  private tmp2 = { x: 0, y: 0, z: 0 };
  private gust = { x: 0, z: 0 };

  reset(): void {
    this.resets++;
    this.phase = 'aboard';
    this.condition = 100;
    this.knocks = 0;
    this.lastKnock = 0;
    this.line = LINE_ABOARD;
    this.doorOpen = false;
    this.pos.x = HATCH_CENTER[0];
    this.pos.y = 0;
    this.pos.z = HATCH_CENTER[1];
    this.vel.x = this.vel.y = this.vel.z = 0;
  }

  /** Whether the crate (or, once delivered, nothing) is through the door, so it can't shut. */
  get canClose(): boolean {
    if (this.phase === 'delivered') return true;
    if (this.phase === 'landed') return false;
    return this.pos.y - CRATE_HEIGHT >= -TRUNK_DEPTH - 0.01;
  }

  /** Still aboard or on the line: the ship carries its weight (for trim and lift). */
  get carried(): boolean {
    return this.phase !== 'delivered';
  }

  /** How fast it is swinging across the deck, m/s. */
  get swing(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /**
   * Host or solo: move the crate on by `dt` with the ship as it is now.
   * Returns true if it was knocked this step.
   */
  step(ship: ShipState, input: CargoInput, dt: number): boolean {
    const before = this.line;
    this.line = Math.max(LINE_MIN, Math.min(LINE_MAX, input.line));
    this.lineRate = dt > 0 ? Math.max(0, (this.line - before) / dt) : 0;
    this.doorOpen = input.doorOpen;
    const knocksBefore = this.knocks;
    const steps = Math.min(30, Math.max(1, Math.ceil(dt / STEP)));
    for (let i = 0; i < steps; i++) {
      this.substep(ship, input, dt / steps);
    }
    return this.knocks !== knocksBefore;
  }

  /** Where the crate's top is in ship space, into `out` (resting ones from the world). */
  topInShip(ship: ShipState, out: { x: number; y: number; z: number }): void {
    if (this.phase === 'landed' || this.phase === 'delivered') {
      worldToShip(ship, this.rest.x, this.rest.y, this.rest.z, out);
      out.y += CRATE_HEIGHT;
    } else {
      out.x = this.pos.x;
      out.y = this.pos.y;
      out.z = this.pos.z;
    }
  }

  /** How far the crate's bottom is above whatever is below it, m (Infinity over nothing). */
  heightAboveGround(ship: ShipState, ground: GroundAt): number {
    if (this.phase === 'landed' || this.phase === 'delivered') return 0;
    shipToWorld(ship, this.pos.x, this.pos.y - CRATE_HEIGHT, this.pos.z, this.tmp);
    ground(this.tmp.x, this.tmp.z, this.tmp.y + 0.05, this.ground);
    return this.tmp.y - this.ground.y;
  }

  /** The guest: take the host's word for the crate. */
  adopt(phase: CargoPhase, x: number, y: number, z: number, vx: number, vz: number, condition: number, ship: ShipState): void {
    this.phase = phase;
    this.condition = condition;
    this.pos.x = x;
    this.pos.y = y;
    this.pos.z = z;
    this.vel.x = vx;
    this.vel.y = 0;
    this.vel.z = vz;
    if (phase === 'landed' || phase === 'delivered') {
      shipToWorld(ship, x, y - CRATE_HEIGHT, z, this.rest);
    }
  }

  private knock(cost: number): void {
    if (cost <= 0) return;
    this.condition = Math.max(0, this.condition - cost);
    this.lastKnock = cost;
    this.knocks = (this.knocks + 1) & 255;
  }

  private substep(ship: ShipState, input: CargoInput, dt: number): void {
    const p = this.pos;
    const v = this.vel;
    switch (this.phase) {
      case 'delivered':
        return;
      case 'aboard':
        // On the shut door: it lifts off when hoisted, and drops onto the line when the door opens.
        if (this.line < LINE_ABOARD - 1e-4 || this.doorOpen) {
          this.phase = 'hanging';
          v.x = v.y = v.z = 0;
        } else {
          p.x = HATCH_CENTER[0];
          p.y = 0;
          p.z = HATCH_CENTER[1];
          return;
        }
        break;
      case 'landed': {
        // It stays put on the ground until the line lifts it, or the hook slips out once slack.
        worldToShip(ship, this.rest.x, this.rest.y + CRATE_HEIGHT, this.rest.z, this.tmp);
        const reach = Math.hypot(this.tmp.x - BLOCK[0], this.tmp.y - BLOCK[1], this.tmp.z - BLOCK[2]);
        if (this.line < reach - 0.02) {
          this.phase = 'hanging';
          p.x = this.tmp.x;
          p.y = this.tmp.y;
          p.z = this.tmp.z;
          v.x = v.y = v.z = 0;
          break;
        }
        if (this.rest.delivery && this.line - reach > SLACK_RELEASE) {
          this.phase = 'delivered';
        }
        return;
      }
      case 'hanging':
        break;
    }

    // Forces: the felt gravity, the air below the keel, and the tag line.
    let ax = ship.gx;
    let ay = ship.gy;
    let az = ship.gz;
    if (p.y < -KEEL_DEPTH) {
      // The air past the crate, in ship space: the wind less the ship's own motion and the crate's swing.
      worldToShip(ship, ship.x + input.windX - ship.vx, ship.y - ship.vy, ship.z + input.windZ - ship.vz, this.tmp2);
      ax += DRAG * (this.tmp2.x - v.x);
      ay += DRAG * (this.tmp2.y - v.y);
      az += DRAG * (this.tmp2.z - v.z);
      eddy(input.time, this.gust);
      ax += this.gust.x * input.windScale;
      az += this.gust.z * input.windScale;
    } else {
      ax -= STILL_DAMPING * v.x;
      ay -= STILL_DAMPING * v.y;
      az -= STILL_DAMPING * v.z;
    }
    if (input.tagHeld) {
      let tx = TAG_PULL * (input.tagX - p.x) - TAG_DAMPING * v.x;
      let tz = TAG_PULL * (input.tagZ - p.z) - TAG_DAMPING * v.z;
      const t = Math.hypot(tx, tz);
      if (t > TAG_MAX) {
        tx *= TAG_MAX / t;
        tz *= TAG_MAX / t;
      }
      ax += tx;
      az += tz;
    }
    v.x += ax * dt;
    v.y += ay * dt;
    v.z += az * dt;
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;

    // The line: it can't be further from the block than the line out.
    const dx = p.x - BLOCK[0];
    const dy = p.y - BLOCK[1];
    const dz = p.z - BLOCK[2];
    const d = Math.hypot(dx, dy, dz);
    if (d > this.line && d > 1e-6) {
      const nx = dx / d;
      const ny = dy / d;
      const nz = dz / d;
      p.x = BLOCK[0] + nx * this.line;
      p.y = BLOCK[1] + ny * this.line;
      p.z = BLOCK[2] + nz * this.line;
      // Its speed away from the block, beyond what the line paying out allows.
      const out = v.x * nx + v.y * ny + v.z * nz - this.lineRate;
      if (out > 0) {
        // Brought up short: how far it fell to reach this speed.
        const fell = (out * out) / (2 * Math.max(1, Math.hypot(ship.gx, ship.gy, ship.gz)));
        if (fell > DROP_FREE) {
          this.knock(DROP_COST * (fell - DROP_FREE));
        }
        v.x -= out * nx;
        v.y -= out * ny;
        v.z -= out * nz;
      }
    }

    // The trunk's sides, and the door under it.
    const bottom = p.y - CRATE_HEIGHT;
    if (bottom < 0.05 && p.y > -TRUNK_DEPTH) {
      this.wall(p, v, 'x', HATCH_CENTER[0]);
      this.wall(p, v, 'z', HATCH_CENTER[1]);
      if (!this.doorOpen && bottom <= -TRUNK_DEPTH) {
        // Back down on the shut door.
        this.phase = 'aboard';
        p.x = HATCH_CENTER[0];
        p.y = 0;
        p.z = HATCH_CENTER[1];
        v.x = v.y = v.z = 0;
        return;
      }
    }

    // The ground below.
    if (p.y < -KEEL_DEPTH + CRATE_HEIGHT) {
      shipToWorld(ship, p.x, bottom, p.z, this.tmp);
      input.ground(this.tmp.x, this.tmp.z, this.tmp.y + 0.5, this.ground);
      if (this.tmp.y <= this.ground.y) {
        // Its speed over the ground: the ship's, plus its own swing turned to the world.
        shipDirToWorld(ship, v.x, v.y, v.z, this.tmp2);
        const down = -(this.tmp2.y + ship.vy);
        const side = Math.hypot(this.tmp2.x + ship.vx, this.tmp2.z + ship.vz);
        this.knock(TOUCH_COST * Math.max(0, down - TOUCH_SPEED) + TOUCH_SIDE_COST * Math.max(0, side - TOUCH_SIDE_SPEED));
        this.phase = 'landed';
        this.rest.x = this.tmp.x;
        this.rest.y = this.ground.y;
        this.rest.z = this.tmp.z;
        this.rest.delivery = this.ground.delivery;
        v.x = v.y = v.z = 0;
      }
    }
  }

  /** Keep the crate inside the trunk along one axis, knocking it if it hits the side hard. */
  private wall(p: { x: number; z: number }, v: { x: number; z: number }, axis: 'x' | 'z', centre: number): void {
    const off = p[axis] - centre;
    if (Math.abs(off) <= TRUNK_PLAY) return;
    p[axis] = centre + Math.sign(off) * TRUNK_PLAY;
    const into = v[axis] * Math.sign(off);
    if (into > 0) {
      this.knock(SCRAPE_COST * Math.max(0, into - SCRAPE_SPEED));
      v[axis] = -v[axis] * RESTITUTION;
    }
  }
}
