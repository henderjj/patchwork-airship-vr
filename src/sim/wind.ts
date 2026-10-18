/**
 * Wind (Phase 3, docs/wind.md): gusts that push the ship sideways, and
 * updrafts and downdrafts at fixed places on the route. Engine-free, like
 * the flight model: the host steps a `WindSim` and passes the air's motion
 * at the ship to `FlightSim` through its controls; the guest only draws and
 * hears it, from the gust the host sends with the route.
 *
 * World space as in src/sim/route.ts: a heading is the way the air blows
 * towards, radians about Y, 0 towards -Z, growing to port (towards -X), so
 * the air moves along (-sin h, -cos h), the same as the bow at that yaw.
 */

import { rng } from './random.js';

/** A column of rising (speed > 0) or sinking air, fixed in the world. */
export interface Draft {
  x: number;
  z: number;
  /** Full strength within this radius, m; it fades to nothing over `DRAFT_EDGE` beyond. */
  radius: number;
  /** Vertical air speed at the usual wind, m/s (positive up). */
  speed: number;
  /** Bottom and top of the column, m: it fades out over `DRAFT_EDGE` past each. */
  bottom: number;
  top: number;
}

/** A gust: the air across the ship picks up, holds and dies away. */
export interface Gust {
  /** Counts gusts this run, so a guest can tell a new one from a repeat (wraps at 256). */
  id: number;
  /** Ship time it starts to blow, s. The streaks show `GUST_WARNING` s before. */
  start: number;
  /** The way it blows towards, radians (see above). */
  heading: number;
  /** Strongest it blows at the usual wind, m/s. */
  peak: number;
  /** Seconds to build up, hold at its peak, and die away. */
  rise: number;
  hold: number;
  fall: number;
}

/** A draft fades to nothing over this far past its edge, m. */
export const DRAFT_EDGE = 8;
/** Seconds of warning before a gust blows: the streaks of its front are on their way to the ship. */
export const GUST_WARNING = 5;
/** The first gust of a run comes this long after lift-off (from, to), s. */
export const FIRST_GUST: readonly [number, number] = [25, 40];
/** Calm between one gust dying away and the next one's warning (from, to), s. */
export const GUST_GAP: readonly [number, number] = [30, 50];
/** A gust's peak at the usual wind (from, to), m/s: one player cranking makes 3.2 m/s (4.8 alone), two in step 7. */
export const GUST_PEAK: readonly [number, number] = [1, 1.6];
/** How long a gust holds at its peak (from, to), s. */
export const GUST_HOLD: readonly [number, number] = [4, 8];
/** A gust builds up and dies away over this long, s. */
export const GUST_RAMP = 6;
/** Gusts come from abeam, give or take this much, radians. */
const GUST_SPREAD = 0.4;

function smooth(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** How hard gust `g` blows at ship time `t`, 0 to 1 of its peak. */
export function gustStrength(g: Gust, t: number): number {
  const s = t - g.start;
  if (s <= 0) return 0;
  if (s < g.rise) return smooth(s / g.rise);
  if (s < g.rise + g.hold) return 1;
  return 1 - smooth((s - g.rise - g.hold) / g.fall);
}

/** Ship time gust `g` has died away by, s. */
export function gustEnd(g: Gust): number {
  return g.start + g.rise + g.hold + g.fall;
}

/** Vertical air speed at a point, m/s at the usual wind: the strongest draft there. */
export function draftAt(drafts: readonly Draft[], x: number, y: number, z: number): number {
  let best = 0;
  for (const d of drafts) {
    const across = Math.hypot(x - d.x, z - d.z) - d.radius;
    const below = d.bottom - y;
    const above = y - d.top;
    const out = Math.max(across, below, above);
    if (out >= DRAFT_EDGE) continue;
    // Full strength inside, easing to nothing over the edge.
    const w = d.speed * (out <= 0 ? 1 : 1 - smooth(out / DRAFT_EDGE));
    if (Math.abs(w) > Math.abs(best)) best = w;
  }
  return best;
}

/**
 * The host's gusts. `step` schedules the next one while the run is under
 * way: the first some way after lift-off, then one after another with a
 * calm between, each from abeam of the ship as it heads when its warning
 * starts, port or starboard at random. A run gets a fresh draw of gusts.
 */
export class WindSim {
  /** The gust now blowing or on its way, or the last one (null before the first). */
  gust: Gust | null = null;
  /** The menu's wind setting in effect (the host's, on the guest): 0 still air, 1 usual, 2 double. */
  scale = 1;
  /** Ship time the next gust's warning starts, s; NaN until the run is under way. */
  nextAt = Number.NaN;
  private random: () => number = rng(1);
  private count = 0;

  /** A fresh run: no gusts yet, and a new draw of them from `seed`. */
  reset(seed: number): void {
    this.gust = null;
    this.nextAt = Number.NaN;
    this.count = 0;
    this.random = rng(seed);
  }

  /**
   * Host: move on to ship time `t`. `underWay` is whether the run is in
   * flight (gusts wait for lift-off), `auto` whether to send gusts at all
   * (Practice → Send a gust still does), and `yaw` the ship's heading.
   * Returns true when a new gust has been set on its way.
   */
  step(t: number, underWay: boolean, auto: boolean, yaw: number): boolean {
    if (!underWay || !auto || this.scale <= 0) {
      if (!underWay) this.nextAt = Number.NaN;
      return false;
    }
    if (Number.isNaN(this.nextAt)) {
      this.nextAt = t + this.between(FIRST_GUST);
    }
    if (t < this.nextAt || (this.gust && t < gustEnd(this.gust))) {
      return false;
    }
    this.send(t, yaw);
    return true;
  }

  /** Host: a gust on its way now, its front arriving in `GUST_WARNING` s (Practice → Send a gust). */
  send(t: number, yaw: number): Gust {
    const side = this.random() < 0.5 ? 1 : -1;
    const g: Gust = {
      id: (this.count = (this.count + 1) & 255),
      start: t + GUST_WARNING,
      heading: yaw + side * (Math.PI / 2) + (this.random() * 2 - 1) * GUST_SPREAD,
      peak: this.between(GUST_PEAK),
      rise: GUST_RAMP,
      hold: this.between(GUST_HOLD),
      fall: GUST_RAMP,
    };
    this.gust = g;
    this.nextAt = gustEnd(g) + this.between(GUST_GAP);
    return g;
  }

  /** The gust's air velocity at ship time `t` (world, m/s), at the wind setting in effect. */
  gustVelocity(t: number, out: { x: number; z: number }): { x: number; z: number } {
    const g = this.gust;
    const w = g ? gustStrength(g, t) * g.peak * this.scale : 0;
    out.x = g ? -Math.sin(g.heading) * w : 0;
    out.z = g ? -Math.cos(g.heading) * w : 0;
    return out;
  }

  /**
   * Seconds until the gust's front arrives (0 to `GUST_WARNING`) while it is
   * on its way, 0 once it blows, and -1 with none coming or blowing.
   */
  warning(t: number): number {
    const g = this.gust;
    if (!g || this.scale <= 0 || t >= gustEnd(g) || t < g.start - GUST_WARNING) return -1;
    return Math.max(0, g.start - t);
  }

  /** Guest: take the host's gust and wind setting, as sent with the route (`toWire`). */
  adopt(wire: unknown, scale: number): void {
    this.scale = Number.isFinite(scale) ? Math.max(0, scale) : this.scale;
    if (!Array.isArray(wire) || wire.length !== 7 || !wire.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      this.gust = null;
      return;
    }
    const [id, start, heading, peak, rise, hold, fall] = wire as number[];
    if (this.gust?.id === id && this.gust.start === start) return;
    this.gust = { id, start, heading, peak, rise: Math.max(0.1, rise), hold: Math.max(0, hold), fall: Math.max(0.1, fall) };
  }

  /** The gust as sent to the guest, or null. */
  toWire(): number[] | null {
    const g = this.gust;
    return g ? [g.id, round(g.start), round(g.heading), round(g.peak), g.rise, round(g.hold), g.fall] : null;
  }

  private between([from, to]: readonly [number, number]): number {
    return from + (to - from) * this.random();
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
