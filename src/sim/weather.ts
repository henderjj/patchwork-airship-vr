/**
 * Storms and night (Phase 3, docs/storms-and-night.md): the weather a run
 * is flown in, the rain that fills the gondola's bilge and the pump that
 * empties it, and lightning. Engine-free, like the wind: the host steps a
 * `StormSim` and sends what it has to the guest with the route; both draw
 * and hear the weather from it.
 *
 * World space as in src/sim/route.ts; gondola space as in
 * src/sim/gondola-layout.ts.
 */

import { PUMP_LEVER, PUMP_PIVOT, PUMP_SWING } from './gondola-layout.js';
import { rng } from './random.js';

/** The weathers a run can be flown in (the game menu's Practice → Weather). */
export const WEATHERS = ['clear', 'storm', 'night', 'nightstorm'] as const;
export type Weather = (typeof WEATHERS)[number];

export function isWeather(raw: unknown): raw is Weather {
  return (WEATHERS as readonly unknown[]).includes(raw);
}

/** Rain, murk, lightning and harder gusts. */
export function isStorm(w: Weather): boolean {
  return w === 'storm' || w === 'nightstorm';
}

/** A dark sky with the moon and stars. */
export function isNight(w: Weather): boolean {
  return w === 'night' || w === 'nightstorm';
}

/** How far off the fog starts and where it hides everything, m, by weather. */
export const FOG: Record<Weather, readonly [near: number, far: number]> = {
  clear: [180, 950],
  storm: [25, 260],
  night: [60, 520],
  nightstorm: [15, 200],
};

/**
 * The fog for a blend of the weathers: `night` and `storm` each from 0
 * (none) to 1, as the sky eases from one weather to another.
 */
export function fogFor(night: number, storm: number, out: { near: number; far: number }): { near: number; far: number } {
  out.near = blend(FOG.clear[0], FOG.night[0], FOG.storm[0], FOG.nightstorm[0], night, storm);
  out.far = blend(FOG.clear[1], FOG.night[1], FOG.storm[1], FOG.nightstorm[1], night, storm);
  return out;
}

/** Between the four weathers' values: `night` and `storm` each 0 to 1. */
export function blend(clear: number, night: number, storm: number, nightstorm: number, n: number, s: number): number {
  return (clear * (1 - n) + night * n) * (1 - s) + (storm * (1 - n) + nightstorm * n) * s;
}

/** The bilge holds this much water, litres: a full one weighs as much as 7.5 sandbags. */
export const BILGE_LITRES = 150;
/** Rain fills the bilge this fast in a storm while the run is under way, litres a second (40 a minute). */
export const RAIN_FILL = 40 / 60;
/** Water's weight, kg a litre. */
export const WATER_KG = 1;
/** The board and the pump's sign say PUMP! from this much water, litres. */
export const PUMP_WARNING = 50;
/** Crates standing on the deck in more water than this soak, losing `SOAK_RATE` % of their condition a second. */
export const SOAK_FROM = 60;
export const SOAK_RATE = 0.2;
/** Practice → Flood the deck puts this much water in the bilge at once, litres. */
export const FLOOD_LITRES = 60;
/** Water a down stroke of the pump's lever sends over the side, litres a radian: a full stroke (1 rad) is 2.5. */
export const PUMP_LITRES_PER_RAD = 2.5;
/** The pump moves at most this much water a second however fast it is worked, litres. */
export const PUMP_MAX_FLOW = 5;
/** A lever nobody holds sinks back down this fast, rad/s. */
export const PUMP_SINK = 1.5;
/** A hand this close to the middle of the pump's handle can take it, m. */
export const PUMP_REACH = 0.14;

/**
 * How deep the water on the deck is drawn, m, at each step from a film to a
 * full bilge: fixed depths, each at least 3 mm clear of every face on and
 * round the deck that faces up (test/z-fighting.test.ts), so the water
 * never flickers through one (the fuel crate, bulwark steps and crate
 * bottoms sit at 4, 5 and 5.5 cm, hence the uneven steps).
 */
export const WATER_DEPTHS = [0.009, 0.014, 0.019, 0.024, 0.029, 0.034, 0.045, 0.058] as const;
/** Less water than this doesn't show on the deck, litres. */
export const WATER_SHOWS = 2;

/** How deep the water on the deck is drawn for `litres` in the bilge, m (0: not drawn). */
export function waterDepth(litres: number): number {
  if (!(litres >= WATER_SHOWS)) return 0;
  const step = Math.min(WATER_DEPTHS.length - 1, Math.floor((litres / BILGE_LITRES) * WATER_DEPTHS.length));
  return WATER_DEPTHS[step];
}

/** The first strike comes this long after the run gets under way in a storm (from, to), s. */
export const FIRST_STRIKE: readonly [number, number] = [3, 8];
/** Then one every (from, to) s. */
export const STRIKE_GAP: readonly [number, number] = [8, 20];
/** Strikes are this far from the ship (from, to), m. */
export const STRIKE_DISTANCE: readonly [number, number] = [120, 420];
/** Practice → Lightning now strikes this far off, about ahead of the ship, m. */
export const PRACTICE_STRIKE = 150;
/** Sound's speed, m/s: thunder comes this long after the flash per metre. */
export const SOUND_SPEED = 343;

/** A lightning strike: where it came down (world x, z) and when (ship time). */
export interface Strike {
  /** Counts strikes this run, so a guest can tell a new one from a repeat (wraps at 256). */
  id: number;
  time: number;
  x: number;
  z: number;
  /** How far from the ship it struck, m. */
  distance: number;
}

/**
 * The host's storm: the bilge's water, filled by the rain while the run is
 * under way in a storm and emptied by the pump, and the lightning, when and
 * where it strikes next (from a seed drawn fresh each run). The guest takes
 * the host's with the route (`adopt`).
 */
export class StormSim {
  /** The weather in effect (the host's, on the guest). */
  weather: Weather = 'clear';
  /** Water in the bilge, litres. */
  water = 0;
  /** The last strike this run, or null. */
  strike: Strike | null = null;
  /** Ship time the next strike comes, s; NaN until the run is under way in a storm. */
  nextStrikeAt = Number.NaN;
  private random: () => number = rng(1);
  private count = 0;

  /** A fresh run: a dry bilge, no strikes yet, and a new draw of them from `seed`. */
  reset(seed: number): void {
    this.water = 0;
    this.strike = null;
    this.nextStrikeAt = Number.NaN;
    this.count = 0;
    this.random = rng(seed);
  }

  /**
   * Host: move on by `dt` to ship time `t`, with the ship at world (x, z).
   * `underWay` is whether the run is in flight: the rain fills the bilge and
   * lightning strikes only then, and only in a storm. Returns true when
   * lightning has struck.
   */
  step(t: number, dt: number, underWay: boolean, x: number, z: number): boolean {
    const storm = isStorm(this.weather);
    if (!underWay || !storm) {
      this.nextStrikeAt = Number.NaN;
      return false;
    }
    this.water = Math.min(BILGE_LITRES, this.water + RAIN_FILL * dt);
    if (Number.isNaN(this.nextStrikeAt)) {
      this.nextStrikeAt = t + this.between(FIRST_STRIKE);
    }
    if (t < this.nextStrikeAt) {
      return false;
    }
    this.strikeAt(t, x, z, this.random() * Math.PI * 2, this.between(STRIKE_DISTANCE));
    return true;
  }

  /** Host: lightning now, `PRACTICE_STRIKE` m off and about ahead of a ship at (x, z) heading `yaw` (Practice → Lightning now). */
  strikeNow(t: number, x: number, z: number, yaw: number): Strike {
    return this.strikeAt(t, x, z, yaw + (this.random() * 2 - 1) * 0.5, PRACTICE_STRIKE);
  }

  /** Host: water into the bilge at once (Practice → Flood the deck), litres. */
  flood(litres: number): void {
    this.water = Math.min(BILGE_LITRES, this.water + Math.max(0, litres));
  }

  /** Water pumped over the side: as much of `litres` as there is. Returns how much came out. */
  pump(litres: number): number {
    const out = Math.min(this.water, Math.max(0, litres));
    this.water -= out;
    return out;
  }

  /** The storm as sent to the guest: the water, then the last strike (if any). */
  toWire(): number[] {
    const s = this.strike;
    const water = Math.round(this.water * 10) / 10;
    return s ? [water, s.id, round(s.time), Math.round(s.x * 10) / 10, Math.round(s.z * 10) / 10, Math.round(s.distance)] : [water];
  }

  /** Guest: take the host's weather and storm, as sent with the route (`toWire`). */
  adopt(wire: unknown, weather: unknown): void {
    if (isWeather(weather)) this.weather = weather;
    if (!Array.isArray(wire) || !wire.every((n) => typeof n === 'number' && Number.isFinite(n))) return;
    const w = wire as number[];
    if (w.length >= 1) this.water = Math.max(0, Math.min(BILGE_LITRES, w[0]));
    if (w.length !== 6) {
      if (w.length === 1) this.strike = null;
      return;
    }
    const [, id, time, x, z, distance] = w;
    if (this.strike?.id === id && this.strike.time === time) return;
    this.strike = { id, time, x, z, distance };
  }

  private strikeAt(t: number, x: number, z: number, bearing: number, distance: number): Strike {
    // A bearing as a heading: 0 towards -Z, growing to port.
    const s: Strike = {
      id: (this.count = (this.count + 1) & 255),
      time: t,
      x: x - Math.sin(bearing) * distance,
      z: z - Math.cos(bearing) * distance,
      distance,
    };
    this.strike = s;
    this.nextStrikeAt = t + this.between(STRIKE_GAP);
    return s;
  }

  private between([from, to]: readonly [number, number]): number {
    return from + (to - from) * this.random();
  }
}

/**
 * The bilge pump's lever (src/sim/gondola-layout.ts): a hand on its handle
 * swings it up and down within `PUMP_SWING` of level, and each down stroke
 * sends water over the side; let go, it sinks back down, moving none.
 */
export class PumpLever {
  /** Rad from level, up positive; it rests all the way down. */
  angle = -PUMP_SWING;

  /** The lever's angle with its handle's middle at height `y` (gondola space). */
  static angleFor(y: number): number {
    const s = Math.max(-1, Math.min(1, (y - PUMP_PIVOT[1]) / PUMP_LEVER));
    return Math.max(-PUMP_SWING, Math.min(PUMP_SWING, Math.asin(s)));
  }

  /** A hand holding the handle at height `y` for `dt` s: the lever follows it. Returns the litres this moved (on a down stroke). */
  follow(y: number, dt: number): number {
    const a = PumpLever.angleFor(y);
    const down = Math.max(0, this.angle - a);
    this.angle = a;
    return Math.min(down * PUMP_LITRES_PER_RAD, PUMP_MAX_FLOW * Math.max(dt, 1 / 30));
  }

  /** Nobody holds it: it sinks back down over `dt` s. */
  sink(dt: number): void {
    this.angle = Math.max(-PUMP_SWING, this.angle - PUMP_SINK * dt);
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
