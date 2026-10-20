/**
 * Envelope repairs (Phase 3, docs/repairs.md): tears in the envelope's
 * belly over the rigging (src/sim/rigging.ts) that leak hot air, and the
 * patches that mend them. Engine-free, like the flight model: the host
 * steps an `EnvelopeSim` and passes its leak to `FlightSim` through its
 * controls; the guest takes the host's state (`toWire`, `adopt`) to draw
 * and hear it.
 *
 * One crew member climbs up and mends a tear while the other keeps flying
 * (John's playtest, 2026-10-20); the one on deck can hand up the patch or
 * the hammer.
 *
 * - A tear opens at one of `TEAR_SPOTS` while the run is under way, the
 *   first a while after lift-off and then one every couple of minutes (or
 *   at once from Practice). It leaks hot air in proportion to its length,
 *   and grows while no hand is on it.
 * - A hand on its edge holds it closed, which nearly stops the leak and
 *   leaves the other hand free for a patch.
 * - A patch pressed onto it sticks. Pressed on while the tear is held
 *   closed, it lies flat and can be riveted: it lasts `HELD_LIFE` s
 *   without anyone holding it, and four rivets hammered home in that time
 *   make it sound, for good. Pressed on an open tear, it is a rushed
 *   patch: it stops the leak, takes no rivets, and after `RUSHED_LIFE` s
 *   it has peeled off and the tear is open again. Either peels for its
 *   last `PEEL_SECONDS`. A fresh patch can go over a rushed one.
 *
 * Gondola space: deck surface at y = 0, bow towards -Z, starboard +X.
 */

import { rng } from './random.js';

/** Where a tear can open: the middle of its slit on the envelope's underside (x, z), and the slit's direction. */
export interface TearSpot {
  x: number;
  z: number;
  /** Unit direction along the slit, across the deck (x) and along it (z). */
  ax: number;
  az: number;
}

/**
 * The tear spots, all in the envelope's belly round the top of the
 * rigging and within reach from it: across forward of the shrouds, fore
 * and aft inboard of them, and across aft of them. The worn, much patched
 * canvas where the rigging rubs is where seams give.
 */
export const TEAR_SPOTS: readonly TearSpot[] = [
  { x: -0.6, z: -0.03, ax: 1, az: 0 },
  { x: -0.38, z: 0.4, ax: 0, az: 1 },
  { x: -0.6, z: 0.8, ax: 1, az: 0 },
];

/** The envelope's underside height above the deck at (x, z), m (src/scene-assets/repairs.scene-asset.ts measures the real one). */
export type CanvasAt = (x: number, z: number) => number;

/** The envelope as an ellipsoid (its model's centre and radii, without the model's lumps): good to a few centimetres. */
export const ELLIPSOID_UNDERSIDE: CanvasAt = (x, z) => {
  const u = x / 3.0;
  const w = z / 5.2;
  return 7.2 - 2.8 * Math.sqrt(Math.max(0, 1 - u * u - w * w));
};

/** A tear opens this long, grows this fast while nobody holds it, up to this long, m and m/s. */
export const TEAR_START = 0.3;
export const TEAR_GROWTH = 0.006;
export const TEAR_MAX = 0.7;
/**
 * Hot air lost through an open tear: a share of the envelope's heat per
 * second for each metre of it. A new tear (0.3 m) takes as much again as
 * the envelope loses on its own, so holding height needs the burner at
 * nearly full flame; grown to its longest, full flame can't keep up and
 * the ship sinks.
 */
export const LEAK_PER_METRE = 0.03;
/** Share of a tear's leak that gets out with it held closed, and through a peeling patch. */
export const HELD_LEAK = 0.15;
export const PEEL_LEAK = 0.3;
/** A hand this close to a tear's edge (its slit, a little below the canvas) can take hold of it, m. */
export const EDGE_REACH = 0.16;
/** The edge a hand holds is this far below the canvas: the torn lips sag, m. */
export const EDGE_DROP = 0.05;
/** A patch carried this close to the middle of a tear sticks to it, m. */
export const PATCH_REACH = 0.2;
/** A patch is this much longer than the tear it goes over (at least, at most), and this wide, m. */
export const PATCH_MARGIN = 0.16;
export const PATCH_MIN = 0.42;
export const PATCH_MAX = 0.86;
export const PATCH_WIDTH = 0.3;
/** The patch hangs this far under the canvas, m. */
export const PATCH_DROP = 0.012;
/** Four rivets, one in each corner, this far in from its edges, m. */
export const RIVETS = 4;
export const RIVET_INSET = 0.045;
/** The hammer's head this close to a rivet, moving up into it at least this fast, sets it, m and m/s. */
export const RIVET_REACH = 0.07;
export const STRIKE_SPEED = 0.6;
/**
 * A patch put on a tear held closed waits this long for its rivets (time
 * to climb down for the hammer, or have it handed up), and a rushed one
 * lasts this long; either peels for the last `PEEL_SECONDS` of it, s.
 */
export const HELD_LIFE = 120;
export const RUSHED_LIFE = 60;
export const PEEL_SECONDS = 10;
/** Most tears open (or only rushed-patched) at once. */
export const MAX_UNMENDED = 2;
/** Points lost at the end of a run for each tear not soundly mended (src/sim/route.ts). */
export const UNMENDED_POINTS = 50;

/** How often tears come (the game menu's Practice → Tears): off, normal and often. */
export const TEAR_RATES = ['off', 'normal', 'often'] as const;
export type TearRate = (typeof TEAR_RATES)[number];

/** The gentler of two players' choices: in a crew, either can turn tears down or off. */
export function gentlerRate(a: TearRate, b: TearRate): TearRate {
  return TEAR_RATES.indexOf(a) <= TEAR_RATES.indexOf(b) ? a : b;
}
/** The first tear of a run comes this long after lift-off, and each next one this long after the last (from, to), s. */
const SCHEDULE: Record<Exclude<TearRate, 'off'>, { first: readonly [number, number]; gap: readonly [number, number] }> = {
  normal: { first: [50, 80], gap: [90, 140] },
  often: { first: [20, 35], gap: [45, 70] },
};

export const TEAR_PHASES = ['whole', 'open', 'patched', 'sound'] as const;
export type TearPhase = (typeof TEAR_PHASES)[number];

/** One tear spot's state. */
export class Tear {
  phase: TearPhase = 'whole';
  /** The slit's length, m. */
  length = 0;
  /** Patched: a rushed patch (it peels), rather than one waiting for its rivets. */
  rushed = false;
  /** Which rivets are in, one bit each. */
  rivets = 0;
  /** A patch's life left before it peels off, s. */
  life = 0;
  /** The patch's length, m (it is cut to the tear when put on). */
  patchLength = 0;
  /** Patches put on it (wraps at 256): a new one tells the guest to hear it slapped on. */
  patches = 0;
  /** Where along it (0 at one end, 1 at the other) each page's hands hold its edge: this page's first, then the crewmate's. */
  readonly holds: number[][] = [[], []];
  /** The host says it is held closed (on the guest, for hands it can't see holding). */
  heldOnHost = false;

  reset(): void {
    this.phase = 'whole';
    this.length = 0;
    this.rushed = false;
    this.rivets = 0;
    this.life = 0;
    this.patchLength = 0;
    this.patches = 0;
    this.holds[0].length = 0;
    this.holds[1].length = 0;
    this.heldOnHost = false;
  }

  /** Hands on its edge, from both pages. */
  get hands(): number {
    return this.holds[0].length + this.holds[1].length;
  }

  /** A hand holds it closed (or the host says one does). */
  get closed(): boolean {
    return this.heldOnHost || this.hands > 0;
  }

  /** A patch in its last seconds. */
  get peeling(): boolean {
    return this.phase === 'patched' && this.life < PEEL_SECONDS;
  }

  /** A patch put on it held closed, waiting for its rivets. */
  get riveting(): boolean {
    return this.phase === 'patched' && !this.rushed;
  }

  /** Open, or patched but not yet sound: what still needs mending. */
  get unmended(): boolean {
    return this.phase === 'open' || this.phase === 'patched';
  }

  /** Hot air lost through it: a share of the envelope's heat per second. */
  get leak(): number {
    const full = LEAK_PER_METRE * this.length;
    if (this.phase === 'open') {
      return full * (this.closed ? HELD_LEAK : 1);
    }
    return this.peeling ? full * PEEL_LEAK : 0;
  }
}

/** A point in gondola space. */
export interface Point {
  x: number;
  y: number;
  z: number;
}

/** The point `t` (0 to 1) along tear `spot`'s slit of `length`, on the canvas less `drop`. */
export function slitPoint(canvas: CanvasAt, spot: TearSpot, length: number, t: number, drop: number, out: Point): Point {
  const s = (t - 0.5) * length;
  out.x = spot.x + spot.ax * s;
  out.z = spot.z + spot.az * s;
  out.y = canvas(out.x, out.z) - drop;
  return out;
}

/**
 * Where along tear `spot`'s edge (0 to 1) a hand at (x, y, z) takes hold,
 * or NaN if it is further than `EDGE_REACH` from it.
 */
export function edgeHold(canvas: CanvasAt, spot: TearSpot, length: number, x: number, y: number, z: number, tmp: Point): number {
  const along = (x - spot.x) * spot.ax + (z - spot.z) * spot.az;
  const t = Math.min(1, Math.max(0, along / Math.max(length, 1e-3) + 0.5));
  slitPoint(canvas, spot, length, t, EDGE_DROP, tmp);
  return Math.hypot(x - tmp.x, y - tmp.y, z - tmp.z) <= EDGE_REACH ? t : Number.NaN;
}

/** The patch's length for a tear this long, m. */
export function patchLengthFor(length: number): number {
  return Math.min(PATCH_MAX, Math.max(PATCH_MIN, length + PATCH_MARGIN));
}

/** Rivet `i` (0 to 3, a corner each) of a patch of `patchLength` on tear `spot`, on its underside. */
export function rivetPoint(canvas: CanvasAt, spot: TearSpot, patchLength: number, i: number, out: Point): Point {
  const along = ((i & 1) === 0 ? -1 : 1) * (patchLength / 2 - RIVET_INSET);
  const across = (i < 2 ? -1 : 1) * (PATCH_WIDTH / 2 - RIVET_INSET);
  // Across is along turned a quarter: (-az, ax) in (x, z).
  out.x = spot.x + spot.ax * along - spot.az * across;
  out.z = spot.z + spot.az * along + spot.ax * across;
  out.y = canvas(out.x, out.z) - PATCH_DROP - 0.006;
  return out;
}

/** Whether a patch carried at (x, y, z) is close enough to tear `spot`'s middle to stick. */
export function patchTouches(canvas: CanvasAt, spot: TearSpot, x: number, y: number, z: number): boolean {
  return Math.hypot(x - spot.x, y - (canvas(spot.x, spot.z) - PATCH_DROP), z - spot.z) <= PATCH_REACH;
}

/** What a patch pressed on a tear did. */
export type PatchResult = 'held' | 'rushed' | null;

/**
 * The envelope's tears, run by the host (or a solo page). `step` opens
 * tears on their schedule while the run is under way and moves patches and
 * tears on; the crew's hands come in through `setHolds`, `press` and
 * `rivet`.
 */
export class EnvelopeSim {
  readonly tears: Tear[] = TEAR_SPOTS.map(() => new Tear());
  /** How often tears come. */
  rate: TearRate = 'normal';
  /** Ship time the next tear opens, s; NaN until the run is under way. */
  nextAt = Number.NaN;
  /** Counts runs (fresh starts), so a guest's late reports of an old run are ignored (wraps at 256). */
  resets = 0;
  /** Tears opened this run (also tells a guest a new one opened). */
  opened = 0;
  private random: () => number = rng(1);

  constructor(readonly canvas: CanvasAt = ELLIPSOID_UNDERSIDE) {}

  /** A fresh run: the envelope sound, and a new draw of when and where it tears from `seed`. */
  reset(seed: number): void {
    for (const tear of this.tears) tear.reset();
    this.nextAt = Number.NaN;
    this.opened = 0;
    this.resets = (this.resets + 1) & 255;
    this.random = rng(seed);
  }

  /** All the hot air lost through the tears: a share of the envelope's heat per second (FlightControls.leak). */
  get leak(): number {
    let sum = 0;
    for (const tear of this.tears) sum += tear.leak;
    return sum;
  }

  /** Tears not soundly mended. */
  get unmended(): number {
    let n = 0;
    for (const tear of this.tears) if (tear.unmended) n++;
    return n;
  }

  /**
   * Host: move on by `dt` to ship time `t`. `underWay` is whether the run
   * is in flight and not made fast (tears wait for lift-off). Returns true
   * when anything the guest should hear about changed: a tear opened or a
   * patch peeled off.
   */
  step(t: number, underWay: boolean, dt: number): boolean {
    let changed = false;
    for (const tear of this.tears) {
      if (tear.phase === 'open') {
        if (tear.hands === 0) {
          tear.length = Math.min(TEAR_MAX, tear.length + TEAR_GROWTH * dt);
        }
      } else if (tear.phase === 'patched') {
        tear.life -= dt;
        if (tear.life <= 0) {
          // Peeled off: the tear is open again, as long as it was.
          tear.phase = 'open';
          tear.rushed = false;
          tear.rivets = 0;
          tear.life = 0;
          changed = true;
        }
      }
    }
    if (!underWay || this.rate === 'off') {
      if (!underWay) this.nextAt = Number.NaN;
      return changed;
    }
    const schedule = SCHEDULE[this.rate];
    if (Number.isNaN(this.nextAt)) {
      this.nextAt = t + this.between(schedule.first);
    } else if (t >= this.nextAt) {
      this.nextAt = t + this.between(schedule.gap);
      if (this.unmended < MAX_UNMENDED && this.tearNow() >= 0) {
        changed = true;
      }
    }
    return changed;
  }

  /** Tear the envelope now at a sound spot, chosen at random (Practice → Tear it now); its index, or -1 if none is left. */
  tearNow(): number {
    let whole = 0;
    for (const tear of this.tears) if (tear.phase === 'whole') whole++;
    if (whole === 0) return -1;
    let pick = Math.floor(this.random() * whole);
    for (let i = 0; i < this.tears.length; i++) {
      if (this.tears[i].phase !== 'whole') continue;
      if (pick-- === 0) {
        this.open(i);
        return i;
      }
    }
    return -1;
  }

  /** Tear spot `i` rips open. */
  open(i: number): void {
    const tear = this.tears[i];
    tear.reset();
    tear.phase = 'open';
    tear.length = TEAR_START;
    this.opened = (this.opened + 1) & 255;
  }

  /**
   * One page's hands on the tears' edges: `page` 0 for this one, 1 for the
   * crewmate's, and for each hand holding an edge, which tear and where
   * along it (0 to 1). Replaces what that page held before.
   */
  setHolds(page: 0 | 1, holds: readonly (readonly [number, number])[]): void {
    for (const tear of this.tears) tear.holds[page].length = 0;
    for (const [i, t] of holds) {
      const tear = this.tears[i];
      if (tear && (tear.phase === 'open' || tear.phase === 'patched') && tear.holds[page].length < 2 && t >= 0 && t <= 1) {
        tear.holds[page].push(t);
      }
    }
  }

  /**
   * A patch pressed onto tear `i`: 'held' if it was held closed (now
   * waiting for its rivets), 'rushed' if not, or null if it didn't stick
   * (nothing to mend there, or a patch already waiting for its rivets).
   * A rushed patch pressed on again while the tear is held is put on
   * afresh.
   */
  press(i: number): PatchResult {
    const tear = this.tears[i];
    if (!tear || !(tear.phase === 'open' || (tear.phase === 'patched' && tear.rushed))) {
      return null;
    }
    tear.phase = 'patched';
    tear.patches = (tear.patches + 1) & 255;
    tear.patchLength = patchLengthFor(tear.length);
    tear.rivets = 0;
    if (tear.closed) {
      tear.rushed = false;
      tear.life = HELD_LIFE;
      return 'held';
    }
    tear.rushed = true;
    tear.life = RUSHED_LIFE;
    return 'rushed';
  }

  /** Rivet `r` of tear `i`'s patch hammered home: true if it went in (a patch put on held closed, not yet peeled). The fourth makes it sound. */
  rivet(i: number, r: number): boolean {
    const tear = this.tears[i];
    if (!tear || !tear.riveting || r < 0 || r >= RIVETS || tear.rivets & (1 << r)) {
      return false;
    }
    tear.rivets |= 1 << r;
    if (tear.rivets === (1 << RIVETS) - 1) {
      tear.phase = 'sound';
      tear.life = 0;
      tear.holds[0].length = 0;
      tear.holds[1].length = 0;
    }
    return true;
  }

  /** The tears as sent to the guest. */
  toWire(): { r: number; n: number; s: number[][] } {
    return {
      r: this.resets,
      n: this.opened,
      s: this.tears.map((tear) => [
        TEAR_PHASES.indexOf(tear.phase),
        Math.round(tear.length * 1000),
        tear.rushed ? 1 : 0,
        tear.rivets,
        Math.round(tear.life * 10),
        Math.round(tear.patchLength * 1000),
        tear.closed ? 1 : 0,
        tear.patches,
      ]),
    };
  }

  /**
   * Guest: take the host's tears (`toWire`). Its own hands' holds stay, so
   * it still draws them; returns false for something that isn't one.
   */
  adopt(wire: unknown): boolean {
    const w = wire as { r?: unknown; n?: unknown; s?: unknown };
    if (!w || typeof w.r !== 'number' || typeof w.n !== 'number' || !Array.isArray(w.s) || w.s.length !== this.tears.length) {
      return false;
    }
    if (!w.s.every((row) => Array.isArray(row) && row.length === 8 && row.every((n) => typeof n === 'number' && Number.isFinite(n)))) {
      return false;
    }
    this.resets = w.r & 255;
    this.opened = w.n & 255;
    (w.s as number[][]).forEach((row, i) => {
      const tear = this.tears[i];
      tear.phase = TEAR_PHASES[row[0]] ?? 'whole';
      tear.length = row[1] / 1000;
      tear.rushed = row[2] === 1;
      tear.rivets = row[3] & ((1 << RIVETS) - 1);
      tear.life = row[4] / 10;
      tear.patchLength = row[5] / 1000;
      tear.heldOnHost = row[6] === 1;
      tear.patches = row[7] & 255;
    });
    return true;
  }

  private between([from, to]: readonly [number, number]): number {
    return from + (to - from) * this.random();
  }
}
