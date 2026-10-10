import type { Island } from './islands.js';
import { DEFAULT_ROPE } from './rope-haul.js';
import { GRAVITY, type ShipState } from './ship-motion.js';

/**
 * Docking (Phase 3 step 1): throwing the grapple on the end of the mooring
 * line onto a mooring post, holding the ship's height while the line is
 * fast to it, and hauling the ship in until it is made fast. Engine-free,
 * like the flight model; the haul itself is the S6 rope haul
 * (src/sim/rope-haul.ts), which says how much line is out.
 *
 * The grapple flies in world space (the gondola stays still and the world
 * moves round it), from a throw: where and how fast it left the hand, and
 * the ship time it did. Its path is worked out from those alone, so every
 * page flies it the same way; the host decides what it caught.
 *
 * While the grapple is fast to the post, the ship can't get further from
 * the post (across the ground) than the line out: a tight line stops it,
 * easing it to a halt rather than at once, and draws it in as the line is
 * hauled, easing it up to speed. (Only the ship's position and velocity
 * change, not the felt gravity: the line's pull is gentle, and loose bricks
 * stay put.) Too far above or below the post, or yanked hard, and the grapple
 * tears off the post. With the line down to `MADE_FAST_LINE` and the deck
 * level with the post, the ship is made fast and held there.
 */

/** The mooring post at the end of a jetty: its foot (on the jetty) and its height, m. */
export interface DockPost {
  x: number;
  y: number;
  z: number;
  height: number;
}

/** What the grapple is doing. Indices are sent to the crewmate. */
export const GRAPPLE_PHASES = ['stowed', 'flying', 'hooked', 'hanging', 'fast'] as const;
export type GrapplePhase = (typeof GRAPPLE_PHASES)[number];

/** Metres of mooring line in all (the haul's length). */
export const LINE_LENGTH = DEFAULT_ROPE.length;
/**
 * Where the line leaves the ship, over the port rail by the bow (ship space:
 * deck at y = 0, bow towards -Z, starboard +X).
 */
export const FAIRLEAD = [-1.04, 1.04, -1.35] as const;
/** The grapple catches if it passes this close to the post's top part, m... */
export const CATCH_RADIUS = 0.45;
/** ...which runs this far down from the post's top (and a little above it), m. */
export const CATCH_BELOW_TOP = 0.9;
const CATCH_ABOVE_TOP = 0.15;
/** The grapple's flight is checked this often, s. */
const FLIGHT_STEP = 0.01;
/** A throw that hasn't caught or run the line out by now has fallen short, s. */
const FLIGHT_MAX = 4;
/** Slower than this (relative to the ship) a let-go grapple goes back on its hook, m/s. */
export const THROW_SPEED = 2;
/** Above or below the post's top by more than this, the line strains (creaks, the sign warns), m. */
export const STRAIN_HEIGHT = 1.5;
/** More than this for longer than `TEAR_SECONDS`, and the grapple tears off the post, m. */
export const TEAR_HEIGHT = 2.5;
export const TEAR_SECONDS = 1;
/** A tight line slows the ship pulling away, or draws it in, changing its speed by up to this, m/s², ... */
const TETHER_ACCEL = 3;
/** ...aiming to take up the ship's distance beyond the line over this long, s, but never drawing it in faster than this, m/s... */
const TETHER_TIME = 0.6;
const TETHER_MAX_SPEED = 2.5;
/** ...and if it still gets this far beyond the line, the grapple is yanked off the post, m. */
export const YANK_STRETCH = 1.2;
/** Line out and height off the post's top within which the ship is made fast, m. */
export const MADE_FAST_LINE = 1.3;
export const MADE_FAST_HEIGHT = 1;
/** ...with the ship drawn in to within this of the line's length, m. */
const MADE_FAST_SLACK = 0.5;
/** Hauled in to within this of the fairlead, a hanging grapple is back on its hook, m. */
export const STOW_LINE = 0.3;
/** With the grapple on the post, the line can't be hauled in shorter than this, m. */
export const SHORTEST_LINE = 0.8;
/** The ship within this of the line's length from the post: the line is tight, m. */
const TIGHT_SLACK = 0.05;

/** Rotate ship-space (x, y, z) by the ship's orientation and add its position: world space. */
export function shipToWorld(s: ShipState, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  const { qx, qy, qz, qw } = s;
  // v' = q v q*
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty) + s.x;
  out.y = y + qw * ty + (qz * tx - qx * tz) + s.y;
  out.z = z + qw * tz + (qx * ty - qy * tx) + s.z;
}

/** Turn a ship-space direction (x, y, z) to world space (no position). */
export function shipDirToWorld(s: ShipState, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  shipToWorld(s, x, y, z, out);
  out.x -= s.x;
  out.y -= s.y;
  out.z -= s.z;
}

/** The inverse of `shipToWorld`: a world point in ship space. */
export function worldToShip(s: ShipState, x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
  const px = x - s.x;
  const py = y - s.y;
  const pz = z - s.z;
  const qx = -s.qx, qy = -s.qy, qz = -s.qz, qw = s.qw;
  const tx = 2 * (qy * pz - qz * py);
  const ty = 2 * (qz * px - qx * pz);
  const tz = 2 * (qx * py - qy * px);
  out.x = px + qw * tx + (qy * tz - qz * ty);
  out.y = py + qw * ty + (qz * tx - qx * tz);
  out.z = pz + qw * tz + (qx * ty - qy * tx);
}

/** A thrown grapple: where and how fast it left the hand (world), and the ship time it did. */
export interface GrappleThrow {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  time: number;
}

/** What happened to the grapple this step. */
export type GrappleEvent = 'none' | 'caught' | 'fell' | 'aboard' | 'torn' | 'yanked' | 'fast';

export class DockingSim {
  phase: GrapplePhase = 'stowed';
  /** World position of the grapple while it flies, or where it caught or fell. */
  readonly pos = { x: 0, y: 0, z: 0 };
  /** Line out of the fairlead while the grapple flies, m (the haul sets it otherwise). */
  flightLine = 0;
  /** Line out of the fairlead as the haul has it, m (set each frame by whoever runs the haul). */
  lineOut = 0;
  /** Counts restarts, so the haul can put all the line back in. */
  resets = 0;
  /** Throws so far (wraps at 256; sent to the crewmate so their throws and the host's line up). */
  throws = 0;
  /** Times the grapple was torn or yanked off the post this run. */
  tears = 0;
  /** While fast to the post: how far the fairlead is above (+) or below the post's top, m. */
  heightOff = 0;
  /** How long the line has been past `TEAR_HEIGHT`, s. */
  strainTime = 0;
  /** How far the ship is past the line's length across the ground, m. */
  stretch = 0;
  /** How far the fairlead is from the post across the ground, m (see `measure`). */
  across = 0;
  readonly launch: GrappleThrow = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, time: 0 };
  private flightT = 0;
  private tetherSpeed = 0;
  private fairlead = { x: 0, y: 0, z: 0 };
  private local = { x: 0, y: 0, z: 0 };
  /** Where the ship is held once made fast. */
  private held = { x: 0, y: 0, z: 0, yaw: 0 };

  constructor(readonly post: DockPost) {}

  get postTop(): number {
    return this.post.y + this.post.height;
  }

  reset(): void {
    this.resets++;
    this.phase = 'stowed';
    this.tears = 0;
    this.flightLine = 0;
    this.strainTime = 0;
    this.stretch = 0;
    this.heightOff = 0;
    this.tetherSpeed = 0;
  }

  /** Whether the grapple is on the post with the ship as far out as the line lets it go (it pulls the ship). */
  get tight(): boolean {
    return this.phase === 'hooked' && this.across >= this.lineOut - TIGHT_SLACK;
  }

  /** Every page, each frame: where the fairlead is relative to the post (`heightOff`, `across`). */
  measure(ship: ShipState): void {
    shipToWorld(ship, FAIRLEAD[0], FAIRLEAD[1], FAIRLEAD[2], this.fairlead);
    const f = this.fairlead;
    this.heightOff = f.y - this.postTop;
    this.across = Math.hypot(f.x - this.post.x, f.z - this.post.z);
  }

  /**
   * The guest: take the host's word for what the grapple did (the host
   * decides catches and tear-offs; the guest's own flight only shows it
   * until then).
   */
  adopt(phase: GrapplePhase): void {
    if (phase === this.phase) {
      return;
    }
    this.phase = phase;
    if (phase === 'hooked' || phase === 'fast') {
      this.pos.x = this.post.x;
      this.pos.y = this.postTop - 0.15;
      this.pos.z = this.post.z;
    }
  }

  /** The grapple leaves a hand. */
  throwGrapple(t: GrappleThrow, count = (this.throws + 1) & 255): void {
    Object.assign(this.launch, t);
    this.throws = count;
    this.phase = 'flying';
    this.flightT = 0;
    this.flightLine = 0;
    this.pos.x = t.x;
    this.pos.y = t.y;
    this.pos.z = t.z;
  }

  /** Where the thrown grapple is `t` seconds after the throw (gravity only: every page agrees). */
  flightAt(t: number, out: { x: number; y: number; z: number }): void {
    const l = this.launch;
    out.x = l.x + l.vx * t;
    out.y = l.y + l.vy * t - 0.5 * GRAVITY * t * t;
    out.z = l.z + l.vz * t;
  }

  /** Whether a world point is within catching distance of the post's top part. */
  catches(x: number, y: number, z: number): boolean {
    const top = this.postTop;
    const dy = y > top + CATCH_ABOVE_TOP ? y - top - CATCH_ABOVE_TOP : y < top - CATCH_BELOW_TOP ? top - CATCH_BELOW_TOP - y : 0;
    const dx = x - this.post.x;
    const dz = z - this.post.z;
    return dx * dx + dy * dy + dz * dz < CATCH_RADIUS * CATCH_RADIUS;
  }

  /**
   * Fly the grapple on to ship time `time` (the ship's pose then is `ship`).
   * It catches on the post, runs the line out and falls to hang over the
   * side, lands on an island and hangs from there, or lands back aboard.
   */
  stepFlight(ship: ShipState, time: number, islands: readonly Island[]): GrappleEvent {
    if (this.phase !== 'flying') {
      return 'none';
    }
    shipToWorld(ship, FAIRLEAD[0], FAIRLEAD[1], FAIRLEAD[2], this.fairlead);
    const target = Math.min(time - this.launch.time, FLIGHT_MAX);
    const p = this.pos;
    while (this.flightT < target) {
      this.flightT = Math.min(target, this.flightT + FLIGHT_STEP);
      this.flightAt(this.flightT, p);
      if (this.catches(p.x, p.y, p.z)) {
        this.phase = 'hooked';
        p.x = this.post.x;
        p.y = this.postTop - 0.15;
        p.z = this.post.z;
        this.strainTime = 0;
        this.tetherSpeed = 0;
        return 'caught';
      }
      const f = this.fairlead;
      const out = Math.hypot(p.x - f.x, p.y - f.y, p.z - f.z);
      this.flightLine = Math.min(LINE_LENGTH, out);
      if (out >= LINE_LENGTH) {
        this.phase = 'hanging';
        return 'fell';
      }
      for (const island of islands) {
        if (p.y < island.y && Math.hypot(p.x - island.x, p.z - island.z) < island.radius) {
          this.phase = 'hanging';
          return 'fell';
        }
      }
      // Back on deck (thrown up, or into the gondola): it goes back on its hook.
      worldToShip(ship, p.x, p.y, p.z, this.local);
      const l = this.local;
      if (this.flightT > 0.15 && Math.abs(l.x) < 1 && Math.abs(l.z) < 1.5 && l.y < 1 && l.y > -0.6) {
        this.phase = 'stowed';
        return 'aboard';
      }
    }
    if (this.flightT >= FLIGHT_MAX) {
      this.phase = 'hanging';
      return 'fell';
    }
    return 'none';
  }

  /**
   * Host or solo, after the flight model has moved the ship: while the
   * grapple is fast to the post, keep the ship within `lineOut` of it across
   * the ground, check the height, and make it fast once hauled in. Once made
   * fast, hold it there. Returns what happened.
   */
  constrain(ship: ShipState, lineOut: number, dt: number): GrappleEvent {
    if (this.phase === 'fast') {
      ship.x = this.held.x;
      ship.y = this.held.y;
      ship.z = this.held.z;
      ship.yaw = this.held.yaw;
      ship.vx = ship.vy = ship.vz = 0;
      return 'none';
    }
    if (dt <= 0) {
      return 'none';
    }
    this.measure(ship);
    const hooked = this.phase === 'hooked';
    const f = this.fairlead;
    const across = this.across;
    const nx = across > 1e-6 ? (f.x - this.post.x) / across : 0;
    const nz = across > 1e-6 ? (f.z - this.post.z) / across : 0;
    // Across the ground, the line holds the ship in. It aims to cancel the
    // flight's speed away from the post and take up any distance beyond the
    // line, easing its pull up and down so the ship neither jolts to a halt
    // nor lurches in with each stroke of the haul. (A grapple torn off lets
    // go of the ship as gently.)
    const excess = hooked ? across - lineOut : 0;
    const away = ship.vx * nx + ship.vz * nz;
    const wanted = excess > 0 ? Math.max(0, away + Math.min(TETHER_MAX_SPEED, excess / TETHER_TIME)) : 0;
    const step = TETHER_ACCEL * dt;
    this.tetherSpeed += Math.max(-step, Math.min(step, wanted - this.tetherSpeed));
    if (this.tetherSpeed > 0) {
      ship.x -= nx * this.tetherSpeed * dt;
      ship.z -= nz * this.tetherSpeed * dt;
      ship.vx -= nx * this.tetherSpeed;
      ship.vz -= nz * this.tetherSpeed;
    }
    this.stretch = Math.max(0, excess);
    if (!hooked) {
      this.strainTime = 0;
      return 'none';
    }
    if (this.stretch > YANK_STRETCH) {
      this.tearOff();
      return 'yanked';
    }
    // Too high or too low for long and the grapple tears off the post.
    if (Math.abs(this.heightOff) > TEAR_HEIGHT) {
      this.strainTime += dt;
      if (this.strainTime > TEAR_SECONDS) {
        this.tearOff();
        return 'torn';
      }
    } else {
      this.strainTime = 0;
    }
    if (lineOut <= MADE_FAST_LINE && excess < MADE_FAST_SLACK && Math.abs(this.heightOff) <= MADE_FAST_HEIGHT) {
      this.phase = 'fast';
      this.held.x = ship.x;
      this.held.y = ship.y;
      this.held.z = ship.z;
      this.held.yaw = ship.yaw;
      ship.vx = ship.vy = ship.vz = 0;
      this.tetherSpeed = 0;
      return 'fast';
    }
    return 'none';
  }

  /** The grapple is pulled off the post and hangs over the side on the line out. */
  tearOff(): void {
    this.phase = 'hanging';
    this.tears++;
    this.strainTime = 0;
    this.stretch = 0;
  }

  /** Hauled back in to the fairlead: a hanging grapple goes back on its hook. */
  stowIfIn(lineOut: number): boolean {
    if (this.phase === 'hanging' && lineOut <= STOW_LINE) {
      this.phase = 'stowed';
      return true;
    }
    return false;
  }
}
