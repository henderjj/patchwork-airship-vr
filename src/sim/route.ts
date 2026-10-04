import { KEEL_DEPTH } from './gondola-layout.js';
import { type Island, restingDeck, SHIP_HEIGHT } from './islands.js';

/**
 * Phase 2's route ("Calm skies"): lift off from island A, fly through two
 * marker rings, and land on island B. Engine-free: the host steps a
 * `RouteRun` with the ship's state, and everyone draws the same layout.
 *
 * World space: the ship starts on island A facing -Z (yaw 0); yaw turns to
 * port (towards -X) as it increases.
 */

/** An island with a landing pad in the middle of its flat top. */
export interface LandingIsland extends Island {
  name: string;
  padRadius: number;
}

/** A marker ring standing upright, facing along `yaw` (the way through it). */
export interface RouteRing {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Inner radius of the drawn ring, m. */
  radius: number;
}

export interface Route {
  start: LandingIsland;
  rings: RouteRing[];
  finish: LandingIsland;
}

const DEG = Math.PI / 180;

/** About 550 m: three minutes with one player cranking, under two with both. */
export const CALM_SKIES: Route = {
  start: { name: 'A', x: 0, y: 120, z: 0, radius: 16, depth: 20, padRadius: 4 },
  rings: [
    { x: 0, y: 136, z: -165, yaw: 0, radius: 14 },
    { x: -115, y: 128, z: -330, yaw: 33 * DEG, radius: 14 },
  ],
  finish: { name: 'B', x: -195, y: 108, z: -475, radius: 20, depth: 24, padRadius: 5 },
};

/** The ring is passed when the middle of the ship crosses it this far inside its rim, m. */
export const RING_MARGIN = 4;
/** Height of the middle of the ship (keel to envelope top) above its deck, m. */
export const SHIP_MIDDLE = SHIP_HEIGHT / 2 - KEEL_DEPTH;
/** Resting on island B this long finishes the route, s. */
export const LAND_HOLD_SECONDS = 3;
/** The run is lost below this height (the haze under the islands), m. */
export const HAZE_HEIGHT = 40;
/** The run is lost this far from the route, m. */
export const LOST_DISTANCE = 450;

/** The route's islands, for resting on and running into. */
export function routeIslands(route: Route): Island[] {
  return [route.start, route.finish];
}

/** Way through a ring: its unit normal in world space. */
export function ringNormal(ring: RouteRing): [number, number] {
  return [-Math.sin(ring.yaw), -Math.cos(ring.yaw)];
}

/**
 * Whether a point moving from `a` to `b` went through `ring`, in either
 * direction, at least `RING_MARGIN` inside its rim.
 */
export function crossesRing(ring: RouteRing, ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
  const [nx, nz] = ringNormal(ring);
  const da = (ax - ring.x) * nx + (az - ring.z) * nz;
  const db = (bx - ring.x) * nx + (bz - ring.z) * nz;
  if (da === db || (da > 0 && db > 0) || (da < 0 && db < 0) || (da === 0 && db === 0)) {
    return false;
  }
  const t = da / (da - db);
  const x = ax + (bx - ax) * t - ring.x;
  const y = ay + (by - ay) * t - ring.y;
  const z = az + (bz - az) * t - ring.z;
  return Math.hypot(x, y, z) < ring.radius - RING_MARGIN;
}

/** Horizontal distance from (x, z) to the route's path (A, the rings in order, B), m. */
export function distanceFromRoute(route: Route, x: number, z: number): number {
  const points = [route.start, ...route.rings, route.finish];
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / (ex * ex + ez * ez)));
    best = Math.min(best, Math.hypot(x - a.x - ex * t, z - a.z - ez * t));
  }
  return best;
}

export type RoutePhase = 'ready' | 'flying' | 'finished' | 'lost';

export interface RouteResult {
  seconds: number;
  bricks: number;
  rings: number;
  ringsTotal: number;
  /** From the middle of island B's pad, m. */
  padDistance: number;
  /** Descent rate at touchdown, m/s. */
  touchdown: number;
  score: number;
  stars: number;
}

/** Points: 1000, less time, fuel, missed rings, distance from the pad, and a hard landing. */
export function scoreRun(r: Omit<RouteResult, 'score' | 'stars'>): { score: number; stars: number } {
  const missed = r.ringsTotal - r.rings;
  const hard = Math.max(0, r.touchdown - 0.6);
  const score = Math.max(0, Math.round(1000 - 2 * r.seconds - 15 * r.bricks - 150 * missed - 10 * r.padDistance - 200 * hard));
  const stars = score >= 600 ? 3 : score >= 450 ? 2 : score >= 250 ? 1 : 0;
  return { score, stars };
}

/** What the ship is doing, as the route needs it. */
export interface RouteShip {
  x: number;
  y: number;
  z: number;
  /** Ship time, s (only advances while the ship flies). */
  time: number;
}

/**
 * One attempt at the route. The timer starts when the ship lifts off island
 * A; the run finishes after resting on island B for `LAND_HOLD_SECONDS`, and
 * is lost if the ship hits an island's rock, sinks into the haze, or strays
 * far from the route. Rings may be flown in any order; each missed one
 * costs points.
 */
export class RouteRun {
  phase: RoutePhase = 'ready';
  /** Ship time the timer started at, s. */
  startTime = 0;
  /** Seconds flown (frozen once the run is over). */
  seconds = 0;
  /** One bit per ring flown through. */
  ringMask = 0;
  /** Why the run was lost. */
  lostReason = '';
  result: RouteResult | null = null;
  /** Resting on island B for this long, s. */
  private landedFor = 0;
  private touchdown = 0;
  private prev = { x: 0, y: 0, z: 0, set: false };

  constructor(readonly route: Route) {}

  reset(): void {
    this.phase = 'ready';
    this.startTime = 0;
    this.seconds = 0;
    this.ringMask = 0;
    this.lostReason = '';
    this.result = null;
    this.landedFor = 0;
    this.touchdown = 0;
    this.prev.set = false;
  }

  /** The ship moved without flying there (a test placing it): don't count the jump as passing a ring. */
  jumped(): void {
    this.prev.set = false;
  }

  get rings(): number {
    let n = 0;
    for (let i = 0; i < this.route.rings.length; i++) if (this.ringMask & (1 << i)) n++;
    return n;
  }

  /**
   * Advance the run after the ship has moved. `grounded` is whether it rests
   * on an island's top, `touchdown` its descent rate when it
   * last landed, and `crashed` whether it has run into an island's rock
   * (src/sim/islands.ts). Returns true if anything the crew should see
   * changed (phase or rings).
   */
  step(s: RouteShip, grounded: boolean, touchdown: number, bricks: number, dt: number, crashed: boolean): boolean {
    const route = this.route;
    let changed = false;
    if (this.phase === 'ready') {
      if (!grounded && s.y > restingDeck(route.start) + 0.2) {
        this.phase = 'flying';
        this.startTime = s.time;
        changed = true;
      }
    }
    if (this.phase !== 'flying') {
      this.remember(s);
      return changed;
    }
    this.seconds = s.time - this.startTime;

    // Rings.
    if (this.prev.set) {
      route.rings.forEach((ring, i) => {
        const bit = 1 << i;
        if (!(this.ringMask & bit) && crossesRing(ring, this.prev.x, this.prev.y + SHIP_MIDDLE, this.prev.z, s.x, s.y + SHIP_MIDDLE, s.z)) {
          this.ringMask |= bit;
          changed = true;
        }
      });
    }
    this.remember(s);

    // Landing on island B.
    const onFinish = grounded && Math.abs(s.y - restingDeck(route.finish)) < 0.01 && Math.hypot(s.x - route.finish.x, s.z - route.finish.z) < route.finish.radius;
    if (onFinish) {
      if (this.landedFor === 0) {
        this.touchdown = touchdown;
      }
      this.landedFor += dt;
      if (this.landedFor >= LAND_HOLD_SECONDS) {
        this.finish(s, bricks);
        return true;
      }
    } else {
      this.landedFor = 0;
    }

    // Ways to lose.
    let reason = '';
    if (crashed) {
      reason = 'Ran into an island';
    } else if (s.y < HAZE_HEIGHT) {
      reason = 'Sank into the haze';
    } else if (distanceFromRoute(route, s.x, s.z) > LOST_DISTANCE) {
      reason = 'Drifted off the route';
    }
    if (reason) {
      this.phase = 'lost';
      this.lostReason = reason;
      changed = true;
    }
    return changed;
  }

  private finish(s: RouteShip, bricks: number): void {
    const base = {
      seconds: this.seconds,
      bricks,
      rings: this.rings,
      ringsTotal: this.route.rings.length,
      padDistance: Math.hypot(s.x - this.route.finish.x, s.z - this.route.finish.z),
      touchdown: this.touchdown,
    };
    this.result = { ...base, ...scoreRun(base) };
    this.phase = 'finished';
  }

  private remember(s: RouteShip): void {
    this.prev.x = s.x;
    this.prev.y = s.y;
    this.prev.z = s.z;
    this.prev.set = true;
  }
}
