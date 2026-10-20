import { KEEL_DEPTH } from './gondola-layout.js';
import { SHIP_HEIGHT } from './islands.js';

/**
 * Narrow passages and rock arches (Phase 3, docs/passages.md): places on the
 * route where the ship has to thread a gap in the rock. Engine-free: the
 * rock's shape as a signed distance (how far a point is from the rock,
 * negative inside), the ship's hull as a few spheres, and the contact
 * between them, which eases the ship back out of the rock and says when a
 * scrape began and how hard. src/world/passage-assets.ts draws the same
 * shapes.
 *
 * Each passage has its own frame: `u` across the way through (positive to
 * starboard of a ship flying through), `w` along it (positive ahead) and
 * world height `y`, about its gate at world (x, z), facing `yaw` as a ring
 * does (yaw turns to port as it increases).
 */

/**
 * A narrow gap between two floating islands whose rock joins below it: a
 * gorge with sheer walls `2 * half` apart and a rock floor, open to the sky.
 * The islands' grass tops are `walls` above the floor.
 */
export interface Cleft {
  kind: 'cleft';
  name: string;
  x: number;
  z: number;
  yaw: number;
  /** The gorge's floor, m (world). */
  floor: number;
  /** The walls rise this high above the floor, to the islands' grass, m. */
  walls: number;
  /** Half the gap between the walls, m. */
  half: number;
  /** Each island: its top's radius, how far its rock reaches below the top, and how far its middle is beyond its wall, m. */
  radius: number;
  depth: number;
  beyond: number;
  /** It comes after this many of the route's rings. */
  after: number;
}

/**
 * A natural stone arch standing on a floating island: two legs rising
 * straight from the grass, `2 * half` apart, and a span curving over them.
 * The way through is between the legs, above the grass and under the span:
 * there is little room to spare above and below.
 */
export interface Arch {
  kind: 'arch';
  name: string;
  x: number;
  z: number;
  yaw: number;
  /** The island's grass under the arch, m (world). */
  ground: number;
  /** Half the opening between the legs' inner faces, m. */
  half: number;
  /** The legs rise straight this high above the grass before the span curves over, m. */
  legs: number;
  /** The rock's half-thickness across the way through, m, and how many times deeper it is along it. */
  thickness: number;
  deep: number;
  /** The island under it: its top's radius and how far its rock reaches below the top, m. */
  radius: number;
  depth: number;
  after: number;
}

export type Passage = Cleft | Arch;

/** The arch's painted band: rail-high on the legs' inner faces, the rail's height above the deck, m. */
export const BAND_RAIL = 1.0;

/** How far the gorge's rock floor goes down below the floor's top, m. */
export const CLEFT_FLOOR_DEPTH = 5;
/** The legs of an arch go this far down into its island's grass, m. */
export const LEG_ROOT = 2;

/** The ship's top (the envelope's crown) above its deck, m. */
export const SHIP_TOP = SHIP_HEIGHT - KEEL_DEPTH;

/** Where `p` puts world (x, z): across (`u`, starboard positive) and along (`w`, ahead positive) its way through. */
export function toPassage(p: Passage, x: number, z: number, out: { u: number; w: number }): { u: number; w: number } {
  const dx = x - p.x;
  const dz = z - p.z;
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  out.u = dx * c - dz * s;
  out.w = -dx * s - dz * c;
  return out;
}

/** Back from a passage's (u, w) to world x and z offsets from its gate (the same turn: it is its own inverse). */
export function fromPassage(p: Passage, u: number, w: number, out: { x: number; z: number }): { x: number; z: number } {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  out.x = u * c - w * s;
  out.z = -u * s - w * c;
  return out;
}

/**
 * The deck heights at which the whole ship clears the rock while it is in
 * the passage, m (world): from the keel just clearing the floor (or the
 * grass under an arch) to the envelope's crown just clearing an arch's span
 * (or, in a gorge open to the sky, staying well down between its walls).
 */
export function deckWindow(p: Passage): { low: number; high: number } {
  if (p.kind === 'cleft') {
    return { low: p.floor + HULL_BOTTOM + 0.8, high: p.floor + p.walls - SHIP_TOP - 1 };
  }
  return { low: p.ground + HULL_BOTTOM, high: archUnderside(p) - ENVELOPE_TOP };
}

/** The underside of an arch's span at its middle, m (world). */
export function archUnderside(a: Arch): number {
  return a.ground + a.legs + a.half;
}

/** The middle of the deck window: the height the route board steers the deck to. */
export function windowMiddle(p: Passage): number {
  const { low, high } = deckWindow(p);
  return (low + high) / 2;
}

/** How far ahead of the gate the ship starts in practice (Practice → Passages), m. */
export const PRACTICE_RUN_IN = 70;

/**
 * Whether the middle of the ship (the point the route counts rings by),
 * moving from `a` to `b`, went through the passage's gate: across its way
 * through, between its walls or legs, above its floor and under its top.
 */
export function crossesPassage(p: Passage, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const pa = toPassage(p, ax, az, tmpA);
  const wa = pa.w;
  const ua = pa.u;
  const pb = toPassage(p, bx, bz, tmpB);
  if ((wa < 0) === (pb.w < 0) || wa === pb.w) {
    return false;
  }
  const t = wa / (wa - pb.w);
  const u = ua + (pb.u - ua) * t;
  const y = ay + (by - ay) * t;
  if (Math.abs(u) >= p.half) {
    return false;
  }
  if (p.kind === 'cleft') {
    return y > p.floor && y < p.floor + p.walls;
  }
  return y > p.ground && y < archUnderside(p);
}
const tmpA = { u: 0, w: 0 };
const tmpB = { u: 0, w: 0 };

/** How far from the gate a passage's rock reaches (for skipping far-off passages), m. */
export function passageReach(p: Passage): number {
  if (p.kind === 'cleft') {
    return p.half + p.beyond + p.radius;
  }
  return Math.max(p.radius, p.half + 2 * p.thickness);
}

/**
 * A capped cone standing upright: radius `r1` at height `-h`, `r2` at `+h`,
 * about the point (0, 0, 0). Signed distance from (x, y, z), exact (after
 * Inigo Quilez's sdCappedCone).
 */
export function coneDistance(x: number, y: number, z: number, h: number, r1: number, r2: number): number {
  const qx = Math.hypot(x, z);
  const qy = y;
  const k2x = r2 - r1;
  const k2y = 2 * h;
  const cax = qx - Math.min(qx, qy < 0 ? r1 : r2);
  const cay = Math.abs(qy) - h;
  const t = Math.max(0, Math.min(1, ((r2 - qx) * k2x + (h - qy) * k2y) / (k2x * k2x + k2y * k2y)));
  const cbx = qx - r2 + k2x * t;
  const cby = qy - h + k2y * t;
  const s = cbx < 0 && cay < 0 ? -1 : 1;
  return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
}

/** An axis-aligned box of half-sizes (bx, by, bz) about the origin: signed distance from (x, y, z), exact. */
export function boxDistance(x: number, y: number, z: number, bx: number, by: number, bz: number): number {
  const qx = Math.abs(x) - bx;
  const qy = Math.abs(y) - by;
  const qz = Math.abs(z) - bz;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
  return outside + Math.min(Math.max(qx, qy, qz), 0);
}

/** An island under a passage: its grass top at `top`, `radius` across, its rock tapering to a point `depth` below. */
function islandDistance(u: number, y: number, w: number, top: number, radius: number, depth: number): number {
  return coneDistance(u, y - (top - depth / 2), w, depth / 2, 0, radius);
}

/** The gorge's floor: how far it reaches along the way through either side of the gate, where the walls end, m. */
export function cleftFloorAlong(c: Cleft): number {
  const r = c.radius * (1 - c.walls / c.depth);
  return Math.sqrt(Math.max(0, r * r - c.beyond * c.beyond)) + 1;
}

/**
 * How far world point (x, y, z) is from the passage's rock, m: positive
 * outside, negative inside. Not exact everywhere (an arch's rock is squashed
 * along the way through, and pieces are joined by the nearer), but zero
 * exactly on the rock's surface, which is what contact needs.
 */
export function rockDistance(p: Passage, x: number, y: number, z: number): number {
  const { u, w } = toPassage(p, x, z, tmpD);
  return p.kind === 'cleft' ? cleftDistance(p, u, y, w) : archDistance(p, u, y, w);
}
const tmpD = { u: 0, w: 0 };

function cleftDistance(c: Cleft, u: number, y: number, w: number): number {
  const top = c.floor + c.walls;
  const middle = c.half + c.beyond;
  // Each island, cut off sheer at its wall.
  const starboard = Math.max(islandDistance(u - middle, y, w, top, c.radius, c.depth), c.half - u);
  const port = Math.max(islandDistance(u + middle, y, w, top, c.radius, c.depth), c.half + u);
  // The rock floor joining them under the gorge, its ends tucked into the walls.
  const floor = boxDistance(u, y - (c.floor - CLEFT_FLOOR_DEPTH / 2), w, c.half + 2, CLEFT_FLOOR_DEPTH / 2, cleftFloorAlong(c));
  return Math.min(starboard, port, floor);
}

function archDistance(a: Arch, u: number, y: number, w: number): number {
  const v = y - a.ground;
  // The arch's middle line: straight up each leg, then a half circle over the top.
  const r = a.half + a.thickness;
  let across: number;
  if (v > a.legs) {
    across = Math.abs(Math.hypot(u, v - a.legs) - r);
  } else {
    const side = Math.min(Math.abs(u - r), Math.abs(u + r));
    across = v >= -LEG_ROOT ? side : Math.hypot(side, v + LEG_ROOT);
  }
  const rock = Math.hypot(across, w / a.deep) - a.thickness;
  return Math.min(rock, islandDistance(u, y, w, a.ground, a.radius, a.depth));
}

/** Which part of the ship touched: the canvas envelope, or the gondola and its rigging below it. */
export type HullPart = 'envelope' | 'gondola';

/** The ship's hull as spheres in ship space (deck at y = 0, bow towards -Z): three for the envelope, two for the gondola and one for its rigging. */
export const HULL_SPHERES: readonly { x: number; y: number; z: number; r: number; part: HullPart }[] = [
  // The envelope: an ellipsoid 3 m across, 2.8 m high and 5.2 m long (half-sizes) round 7.2 m up.
  { x: 0, y: 7.2, z: -2.3, r: 2.9, part: 'envelope' },
  { x: 0, y: 7.2, z: 0, r: 2.95, part: 'envelope' },
  { x: 0, y: 7.2, z: 2.3, r: 2.9, part: 'envelope' },
  // The gondola: the 2 × 3 m deck, its keel 0.56 m under the deck and its rail 1 m above.
  { x: 0, y: 0.3, z: -0.75, r: 1.0, part: 'gondola' },
  { x: 0, y: 0.3, z: 0.75, r: 1.0, part: 'gondola' },
  // The rigging between them, the load ring and the shrouds up to the envelope.
  { x: 0, y: 2.9, z: 0, r: 1.5, part: 'gondola' },
];

/** The hull spheres' lowest point below the deck and the envelope's crown above it, m. */
const HULL_BOTTOM = -Math.min(...HULL_SPHERES.map((s) => s.y - s.r));
const ENVELOPE_TOP = Math.max(...HULL_SPHERES.map((s) => s.y + s.r));

/** A scrape starts again after the ship has been clear of the rock this long, s. */
export const SCRAPE_GAP = 1;
/** Touching slower than this (straight into the rock) is a brush: heard, but no harm done, m/s. */
export const BRUSH_SPEED = 0.15;
/** A scrape of the envelope this fast tears it (docs/repairs.md), m/s. */
export const TEAR_SPEED = 0.5;
/** A scrape of the gondola knocks the crates aboard this much (% of condition per m/s over a brush). */
export const CRATE_JOLT = 20;
/** Each scrape (not a brush) costs this many points. */
export const SCRAPE_POINTS = 25;
/** The ship counts as grinding along the rock until it has been clear of it this long, s (so sliding along a wall, touching on and off, is one grind). */
export const GRIND_HOLD = 0.3;

/** The ship as contact needs it: where its deck is, which way it heads and how it moves (world). */
export interface ContactShip {
  x: number;
  y: number;
  z: number;
  yaw: number;
  vx: number;
  vy: number;
  vz: number;
}

/** A scrape that began this step: which part, and how fast it was going into the rock. */
export interface Scrape {
  part: HullPart;
  speed: number;
}

/** A small step for the rock's slope, m. */
const SLOPE_STEP = 0.05;
/** Contact passes per step (each eases the ship out of the deepest sphere so far). */
const PASSES = 3;

/**
 * The ship against the passages' rock, run by the host after each flight
 * step: eases the ship straight back out of any rock its hull went into and
 * takes away its motion into it, leaving it free to slide along. `normal`
 * is the way out of the rock it touched hardest this step, for the flight
 * model to stop pushing into it (`FlightSim.bump`).
 */
export class PassageContact {
  /** Whether any part of the hull touched rock this step, and which part touched hardest. */
  touching = false;
  part: HullPart = 'gondola';
  /** The way out of the rock (world, unit), when touching. */
  readonly normal = { x: 0, y: 1, z: 0 };
  /** Ship time of the last touch, s. */
  private lastTouch = Number.NEGATIVE_INFINITY;

  /** Whether the ship touched rock within `GRIND_HOLD` of ship time `time`. */
  grinding(time: number): boolean {
    return time - this.lastTouch < GRIND_HOLD;
  }
  private readonly scrape: Scrape = { part: 'gondola', speed: 0 };
  private readonly at = { x: 0, y: 0, z: 0 };

  reset(): void {
    this.touching = false;
    this.lastTouch = Number.NEGATIVE_INFINITY;
  }

  /**
   * Move `ship` out of the rock of any of `passages` and take away its
   * motion into it. Returns the scrape that began this step (the ship had
   * been clear of all rock for `SCRAPE_GAP`), or null.
   */
  step(passages: readonly Passage[], ship: ContactShip, time: number): Scrape | null {
    this.touching = false;
    let deepest = 0;
    let speed = 0;
    const c = Math.cos(ship.yaw);
    const s = Math.sin(ship.yaw);
    for (const p of passages) {
      const reach = passageReach(p) + 12;
      if (Math.hypot(ship.x - p.x, ship.z - p.z) > reach) {
        continue;
      }
      for (let pass = 0; pass < PASSES; pass++) {
        let moved = false;
        for (const sphere of HULL_SPHERES) {
          // Ship space to world, turned by the heading (the few degrees of lean are left out).
          const x = ship.x + sphere.x * c + sphere.z * s;
          const y = ship.y + sphere.y;
          const z = ship.z - sphere.x * s + sphere.z * c;
          const inside = sphere.r - rockDistance(p, x, y, z);
          if (inside <= 0) {
            continue;
          }
          const n = this.slope(p, x, y, z);
          const into = -(ship.vx * n.x + ship.vy * n.y + ship.vz * n.z);
          if (pass === 0) {
            speed = Math.max(speed, into);
          }
          if (into > 0) {
            ship.vx += n.x * into;
            ship.vy += n.y * into;
            ship.vz += n.z * into;
          }
          ship.x += n.x * inside;
          ship.y += n.y * inside;
          ship.z += n.z * inside;
          moved = true;
          if (!this.touching || inside > deepest) {
            deepest = inside;
            this.part = sphere.part;
            this.normal.x = n.x;
            this.normal.y = n.y;
            this.normal.z = n.z;
          }
          this.touching = true;
        }
        if (!moved) {
          break;
        }
      }
    }
    if (!this.touching) {
      return null;
    }
    const fresh = time - this.lastTouch > SCRAPE_GAP;
    this.lastTouch = time;
    if (!fresh) {
      return null;
    }
    this.scrape.part = this.part;
    this.scrape.speed = speed;
    return this.scrape;
  }

  /** The way out of the rock at world (x, y, z): the slope of its distance, unit length. */
  private slope(p: Passage, x: number, y: number, z: number): { x: number; y: number; z: number } {
    const h = SLOPE_STEP;
    const n = this.at;
    n.x = rockDistance(p, x + h, y, z) - rockDistance(p, x - h, y, z);
    n.y = rockDistance(p, x, y + h, z) - rockDistance(p, x, y - h, z);
    n.z = rockDistance(p, x, y, z + h) - rockDistance(p, x, y, z - h);
    const length = Math.hypot(n.x, n.y, n.z);
    if (length < 1e-9) {
      n.x = 0;
      n.y = 1;
      n.z = 0;
    } else {
      n.x /= length;
      n.y /= length;
      n.z /= length;
    }
    return n;
  }
}

/** What the crew's lookout calls approaching a passage. */
export type LookoutCall = 'UP' | 'DOWN' | 'PORT' | 'STARBOARD' | 'STEADY';

/** The lookout starts calling this far ahead of a passage's gate and stops this far past it, m... */
export const LOOKOUT_AHEAD = 100;
export const LOOKOUT_PAST = 12;
/** ...while the ship is no further than this to either side of its way through, m. */
export const LOOKOUT_ASIDE = 40;
/** The lookout looks this far ahead in time for where the ship is heading across the gap, s. */
const LOOKOUT_LEAD = 4;

/**
 * What a lookout at the bow calls for a ship with its deck at (x, y, z),
 * moving at (vx, vz), approaching passage `p`: up or down when the deck is
 * outside the passage's window (by more than `margin`), else port or
 * starboard when the ship is heading for less than `margin` short of a
 * wall or leg, else steady. Null when the ship isn't on its approach.
 */
export function lookoutCall(p: Passage, x: number, y: number, z: number, vx: number, vz: number, margin = 0.3): LookoutCall | null {
  const at = toPassage(p, x, z, tmpL);
  if (at.w < -LOOKOUT_AHEAD || at.w > LOOKOUT_PAST || Math.abs(at.u) > LOOKOUT_ASIDE) {
    return null;
  }
  const { low, high } = deckWindow(p);
  if (y < low + margin) return 'UP';
  if (y > high - margin) return 'DOWN';
  // Across the gap: where the ship will be when it reaches the gate (or soon, if it is already there).
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  const across = vx * c - vz * s;
  const along = -vx * s - vz * c;
  const lead = at.w < 0 && along > 0.2 ? Math.min(LOOKOUT_LEAD, -at.w / along) : 1;
  const u = at.u + across * lead;
  // Room either side with the envelope in the middle of the gap.
  const room = p.half - 3 - 2 * margin;
  if (u > room) return 'PORT';
  if (u < -room) return 'STARBOARD';
  return 'STEADY';
}
const tmpL = { u: 0, w: 0 };
