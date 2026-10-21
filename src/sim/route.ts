import type { DockPost } from './docking.js';
import { UNMENDED_POINTS } from './envelope.js';
import { KEEL_DEPTH } from './gondola-layout.js';
import { type Island, restingDeck, SHIP_HEIGHT } from './islands.js';
import { crossesPassage, type Passage, SCRAPE_POINTS } from './passages.js';
import type { Draft } from './wind.js';

/**
 * Phase 2's route ("Calm skies"): lift off from island A, fly through two
 * marker rings, and make fast to the mooring post on island B's jetty
 * (docking, Phase 3). Engine-free: the host steps a
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

/**
 * The loading stage on the start island (Phase 3 cargo, docs/cargo.md): a
 * plank platform beside where the ship rests, its top `top` high (world),
 * spanning x0..x1 and z0..z1 (world, square to the axes), with the crates
 * waiting on it at `crates` (their bottoms' middles, world x and z), turned
 * by `yaw` so their rope handles face the bow and stern.
 */
export interface LoadingStage {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  top: number;
  crates: readonly (readonly [number, number])[];
  yaw: number;
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
  /** The mooring post at the end of the finish island's jetty. */
  dock: DockPost;
  /**
   * The cargo stage (Phase 3 cargo, docs/cargo.md): a plank platform on a
   * small floating rock under the jetty's end, where the crate is set down,
   * with a target painted in its middle (`TARGET_RINGS`).
   */
  cargo: Island;
  /** Updrafts and downdrafts on the way (Phase 3 wind, docs/wind.md). */
  drafts: Draft[];
  /** Where the crates wait to be loaded on the start island. */
  loading: LoadingStage;
  /** Narrow passages and rock arches on the way (Phase 3, docs/passages.md), each after some of the rings. */
  passages: Passage[];
}

const DEG = Math.PI / 180;

/** Island A, where the run starts: the ship rests in the middle of its pad, facing -Z. */
const START: LandingIsland = { name: 'A', x: 0, y: 120, z: 0, radius: 16, depth: 20, padRadius: 4 };

/** The loading stage's top is this far above the deck of a ship resting on its island: about waist high, so the crates' handles are at hand over the rail. */
export const LOADING_STAGE_HEIGHT = 0.75;

/** About 550 m: three minutes with one player cranking, under two with both. */
export const CALM_SKIES: Route = {
  start: START,
  rings: [
    { x: 0, y: 136, z: -165, yaw: 0, radius: 14 },
    { x: -115, y: 128, z: -330, yaw: 33 * DEG, radius: 14 },
  ],
  finish: { name: 'B', x: -195, y: 108, z: -475, radius: 20, depth: 24, padRadius: 5 },
  // 27 m out from island B's middle, towards ring 2 (the way in), at the end of a
  // 7 m jetty: a ship made fast there has its keel above the island's top and
  // clear of its rock.
  dock: { x: -181.96, y: 108, z: -451.36, height: 2.2 },
  // 6 m below the jetty, its middle (the target) right under the cargo hatch
  // of a ship made fast at the post lying straight out from it with 1.2 m of
  // line (as Practice → Cargo starts it): a ship lying further round the post
  // still has its hatch over the stage, but off the target.
  cargo: { x: -182.6, y: 102, z: -448.17, radius: 4.5, depth: 6 },
  drafts: [
    // Rising air on the way to ring 1, a little to starboard of the straight
    // line: ride it up and ring 1's extra height comes almost free.
    { x: 6, z: -92, radius: 16, speed: 1, bottom: 95, top: 170 },
    // Sinking air on the straight line between the rings: burn through it,
    // or fly round it, or come out of it under ring 2.
    { x: -62, z: -243, radius: 18, speed: -0.9, bottom: 95, top: 170 },
  ],
  // Beside the starboard bow of a ship resting on A's pad (the hull's side
  // is 1.1 m out), clear of the ballast bags further aft: the crates' near
  // sides are 23 cm outboard of the rail.
  loading: {
    x0: 1.14,
    x1: 1.74,
    z0: -1.4,
    z1: 0.0,
    top: restingDeck(START) + LOADING_STAGE_HEIGHT,
    crates: [
      [1.43, -1.0],
      [1.43, -0.42],
    ],
    yaw: Math.PI / 2,
  },
  passages: [
    // Between the rings, three quarters of the way to ring 2 and lined up
    // with it: a gorge 13 m wide between two islands, open to the sky,
    // its floor 6 m under the deck of a ship flying the straight line.
    {
      kind: 'cleft',
      name: 'Cleft',
      x: -87.4,
      z: -290.4,
      yaw: Math.atan2(115, 165),
      floor: 119,
      walls: 22,
      half: 6.5,
      radius: 18,
      depth: 45,
      beyond: 6,
      after: 1,
    },
    // After ring 2, nearly half way to B's post: a stone arch on an island,
    // 16 m between its legs and 14 m from the grass to the span, so the
    // deck has just over 3 m of height to play with, on the way down from ring 2
    // to the post.
    {
      kind: 'arch',
      name: 'Arch',
      x: -145.13,
      z: -384.61,
      yaw: Math.atan2(66.96, 121.36),
      ground: 115,
      half: 8,
      legs: 6,
      thickness: 2.8,
      deep: 1.5,
      radius: 15,
      depth: 26,
      after: 2,
    },
  ],
};

/** The rings and passages in the order the route flies them: each a ring's or a passage's index. */
export type Gate = { kind: 'ring' | 'passage'; index: number };
export function routeGates(route: Route): Gate[] {
  const gates: Gate[] = [];
  for (let i = 0; i <= route.rings.length; i++) {
    route.passages.forEach((p, index) => {
      if (p.after === i) gates.push({ kind: 'passage', index });
    });
    if (i < route.rings.length) gates.push({ kind: 'ring', index: i });
  }
  return gates;
}

/** Whether world (x, z) is on the loading stage's planks. */
export function onLoadingStage(stage: LoadingStage, x: number, z: number): boolean {
  return x >= stage.x0 && x <= stage.x1 && z >= stage.z0 && z <= stage.z1;
}

/** The jetty's planks: this wide, their tops this far above the island's top, m. */
export const JETTY_WIDTH = 1.6;
export const JETTY_TOP = 0.1;

/** Where the jetty leaves the island's rim, along the way from the island's middle to the post. */
export function jettyRoot(route: Route): { x: number; z: number } {
  const dx = route.dock.x - route.finish.x;
  const dz = route.dock.z - route.finish.z;
  const d = Math.hypot(dx, dz);
  const r = route.finish.radius - 1;
  return { x: route.finish.x + (dx / d) * r, z: route.finish.z + (dz / d) * r };
}

/** The jetty's turn about Y: in its own space it runs along +Z from the post's foot to the island. */
export function jettyTurn(route: Route): number {
  const root = jettyRoot(route);
  return Math.atan2(root.x - route.dock.x, root.z - route.dock.z);
}

/**
 * Where B's dock hands slide the crates set down on the cargo stage, to clear
 * its target for the next: beside the stack of crates already there
 * (src/world/route-assets.ts), as offsets from the stage's middle in the
 * jetty's own space, in the order they come.
 */
export const CLEARED_SPOTS = [
  [-0.5, 1.5],
  [-0.5, 0.95],
] as const;

/** Where the `k`th crate set down at world (x, y, z) is slid to (world x, z) and its yaw there (square with the jetty), into `out`; false if it isn't on `route`'s cargo stage or there's no spot left. */
export function clearedSpot(route: Route, x: number, y: number, z: number, k: number, out: { x: number; z: number; yaw: number }): boolean {
  const stage = route.cargo;
  if (k >= CLEARED_SPOTS.length || Math.abs(y - stage.y) > 0.05 || Math.hypot(x - stage.x, z - stage.z) > stage.radius) return false;
  const turn = jettyTurn(route);
  const [ox, oz] = CLEARED_SPOTS[k];
  out.x = stage.x + ox * Math.cos(turn) + oz * Math.sin(turn);
  out.z = stage.z - ox * Math.sin(turn) + oz * Math.cos(turn);
  out.yaw = turn;
  return true;
}

/** Whether world (x, z) is on the jetty's planks, between the post and where it leaves the island. */
export function onJetty(route: Route, x: number, z: number): boolean {
  const root = jettyRoot(route);
  const ex = root.x - route.dock.x;
  const ez = root.z - route.dock.z;
  const length = Math.hypot(ex, ez);
  const along = ((x - route.dock.x) * ex + (z - route.dock.z) * ez) / length;
  const across = Math.abs(((x - route.dock.x) * ez - (z - route.dock.z) * ex) / length);
  return along > -0.3 && along < length + 1 && across < JETTY_WIDTH / 2;
}

/** The ring is passed when the middle of the ship crosses it this far inside its rim, m. */
export const RING_MARGIN = 4;
/** Height of the middle of the ship (keel to envelope top) above its deck, m. */
export const SHIP_MIDDLE = SHIP_HEIGHT / 2 - KEEL_DEPTH;
/** Made fast to island B's post this long finishes the route, s. */
export const FAST_HOLD_SECONDS = 3;
/** The run is lost below this height (the haze under the islands), m. */
export const HAZE_HEIGHT = 40;
/** The run is lost this far from the route, m. */
export const LOST_DISTANCE = 450;

/** The route's islands, for resting on and running into (the cargo stage's rock is one). */
export function routeIslands(route: Route): Island[] {
  return [route.start, route.finish, route.cargo];
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
  /** Times the grapple was torn or yanked off the post. */
  tears: number;
  /** The delivered crates' average condition, % (0 with none delivered). */
  cargo: number;
  /** Crates delivered, of how many there were. */
  crates: number;
  cratesTotal: number;
  /** Points for where on the cargo stage's target they were set down (`targetPoints`). */
  target: number;
  /** Tears in the envelope not soundly mended at the end (src/sim/envelope.ts). */
  unmended: number;
  /** Passages flown through, of how many there were, and times the ship scraped their rock (docs/passages.md). */
  passes: number;
  passesTotal: number;
  scrapes: number;
  score: number;
  stars: number;
}

/** What a run's score is worked out from (tears left unmended, missed passages and scrapes count nothing if not given). */
export type ScoreInput = Omit<RouteResult, 'score' | 'stars' | 'unmended' | 'passes' | 'passesTotal' | 'scrapes'> &
  Partial<Pick<RouteResult, 'unmended' | 'passes' | 'passesTotal' | 'scrapes'>>;

/** Points lost for each ring or passage missed. */
export const MISSED_POINTS = 150;

/** Points lost per percent of a delivered crate's condition lost (a crate not delivered loses all 100). */
export const CARGO_POINTS = 4;

/**
 * The target painted on the cargo stage, from the middle out: a crate set
 * down with its middle within `radius` of the stage's middle scores `points`.
 */
export const TARGET_RINGS = [
  { radius: 0.3, points: 100, name: 'BULLSEYE' },
  { radius: 0.7, points: 50, name: 'ON TARGET' },
  { radius: 1.1, points: 20, name: 'ON TARGET' },
] as const;

/** Which of `TARGET_RINGS` a crate set down with its middle at world (x, z) is in, or null for none. */
export function targetRing(route: Route, x: number, z: number): (typeof TARGET_RINGS)[number] | null {
  const d = Math.hypot(x - route.cargo.x, z - route.cargo.z);
  return TARGET_RINGS.find((ring) => d <= ring.radius) ?? null;
}

/** Points for a crate set down with its middle at world (x, z). */
export function targetPoints(route: Route, x: number, z: number): number {
  return targetRing(route, x, z)?.points ?? 0;
}

/**
 * Points: 1000, less time, fuel, missed rings and passages, scrapes on the
 * passages' rock, the grapple torn off the post, damage to the crates (each
 * one not delivered counts as smashed) and tears in the envelope left
 * unmended, plus the target's points.
 */
export function scoreRun(r: ScoreInput): { score: number; stars: number } {
  const missed = r.ringsTotal - r.rings + Math.max(0, (r.passesTotal ?? 0) - (r.passes ?? 0));
  const damage = CARGO_POINTS * (r.crates * (100 - Math.max(0, Math.min(100, r.cargo))) + 100 * Math.max(0, r.cratesTotal - r.crates));
  const torn = UNMENDED_POINTS * Math.max(0, r.unmended ?? 0);
  const scraped = SCRAPE_POINTS * Math.max(0, r.scrapes ?? 0);
  const score = Math.max(0, Math.round(1000 - 2 * r.seconds - 15 * r.bricks - MISSED_POINTS * missed - 100 * r.tears - damage - torn - scraped + r.target));
  const stars = score >= 600 ? 3 : score >= 450 ? 2 : score >= 250 ? 1 : 0;
  return { score, stars };
}

/**
 * The crates, as the route needs them: how many are still aboard (the run
 * can't finish while any are), how many have been delivered of how many
 * there were, the sum of the delivered ones' conditions (%), and the
 * target's points for where they were set down.
 */
export interface RouteCargo {
  aboard: number;
  delivered: number;
  total: number;
  condition: number;
  target: number;
}

/** For a run with no crate to deliver (tests of the rest of the route). */
export const NO_CARGO: RouteCargo = { aboard: 0, delivered: 1, total: 1, condition: 100, target: 0 };

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
 * A; the run finishes once the ship has been made fast to island B's
 * mooring post for `FAST_HOLD_SECONDS` (src/sim/docking.ts) with no crate
 * left aboard (src/sim/stowage.ts), and is lost if the ship hits an island's rock, sinks into the haze, or strays
 * far from the route. Rings and passages may be flown in any order; each
 * missed one costs points, and so does each scrape on a passage's rock.
 */
export class RouteRun {
  phase: RoutePhase = 'ready';
  /** Ship time the timer started at, s. */
  startTime = 0;
  /** Seconds flown (frozen once the run is over). */
  seconds = 0;
  /** One bit per ring flown through. */
  ringMask = 0;
  /** One bit per passage flown through (docs/passages.md). */
  passMask = 0;
  /** Times the ship scraped a passage's rock (more than a brush), counted by the host's contact (src/sim/passages.ts). */
  scrapes = 0;
  /** Why the run was lost. */
  lostReason = '';
  result: RouteResult | null = null;
  /** Made fast at island B for this long, s. */
  private fastFor = 0;
  private prev = { x: 0, y: 0, z: 0, set: false };

  constructor(readonly route: Route) {}

  reset(): void {
    this.phase = 'ready';
    this.startTime = 0;
    this.seconds = 0;
    this.ringMask = 0;
    this.passMask = 0;
    this.scrapes = 0;
    this.lostReason = '';
    this.result = null;
    this.fastFor = 0;
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

  get passes(): number {
    let n = 0;
    for (let i = 0; i < this.route.passages.length; i++) if (this.passMask & (1 << i)) n++;
    return n;
  }

  /** Every ring and passage that comes before route gate `gate` (in `routeGates` order) counted as flown: for practice starts. */
  flownBefore(gates: readonly Gate[], gate: number): void {
    for (let g = 0; g < gate && g < gates.length; g++) {
      if (gates[g].kind === 'ring') this.ringMask |= 1 << gates[g].index;
      else this.passMask |= 1 << gates[g].index;
    }
  }

  /**
   * Advance the run after the ship has moved. `grounded` is whether it rests
   * on an island's top, `fast` whether it is made fast to island B's post,
   * `tears` how often the grapple has been torn off it, and `crashed`
   * whether it has run into an island's rock (src/sim/islands.ts), and
   * `cargo` how many crates are aboard and delivered, their condition and the target's points,
   * and `unmended` how many tears in the envelope aren't soundly mended. Returns
   * true if anything the crew should see changed (phase or rings).
   */
  step(
    s: RouteShip,
    grounded: boolean,
    fast: boolean,
    bricks: number,
    tears: number,
    dt: number,
    crashed: boolean,
    cargo: RouteCargo = NO_CARGO,
    unmended = 0,
  ): boolean {
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
      route.passages.forEach((passage, i) => {
        const bit = 1 << i;
        if (!(this.passMask & bit) && crossesPassage(passage, this.prev.x, this.prev.y + SHIP_MIDDLE, this.prev.z, s.x, s.y + SHIP_MIDDLE, s.z)) {
          this.passMask |= bit;
          changed = true;
        }
      });
    }
    this.remember(s);

    // Made fast to island B's post, with no crate left aboard.
    if (fast) {
      this.fastFor += dt;
      if (this.fastFor >= FAST_HOLD_SECONDS && cargo.aboard === 0) {
        this.finish(bricks, tears, cargo, unmended);
        return true;
      }
    } else {
      this.fastFor = 0;
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

  private finish(bricks: number, tears: number, cargo: RouteCargo, unmended: number): void {
    const base = {
      seconds: this.seconds,
      bricks,
      rings: this.rings,
      ringsTotal: this.route.rings.length,
      tears,
      cargo: cargo.delivered > 0 ? Math.round(cargo.condition / cargo.delivered) : 0,
      crates: cargo.delivered,
      cratesTotal: cargo.total,
      target: cargo.target,
      unmended,
      passes: this.passes,
      passesTotal: this.route.passages.length,
      scrapes: this.scrapes,
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
