/**
 * When the ship's sounds play and how loud, worked out from the ship's
 * state (Phase 2 audio). Engine-free, so the timing and levels are unit
 * tested; src/audio/ship-sounds.ts makes the sounds.
 */

/** Pawl clicks per turn of the crank's ratchet (matches its haptic clicks). */
export const RATCHET_TEETH = 8;

/** How many ratchet teeth the crank passed turning from `from` to `to` (radians, unwrapped), either way. */
export function ratchetClicks(from: number, to: number, teeth = RATCHET_TEETH): number {
  const step = (Math.PI * 2) / teeth;
  return Math.abs(Math.floor(to / step) - Math.floor(from / step));
}

/**
 * How gusty the air is at time `t` (s), 0 (a lull) to 1 (a gust): two slow
 * swells, about 20 s and 55 s long, so the wind rises and falls rather than
 * holding one steady hiss.
 */
export function windGust(t: number): number {
  return 0.5 + 0.28 * Math.sin(t * 0.31) + 0.22 * Math.sin(t * 0.113 + 1.7);
}

/**
 * Wind noise for an airspeed and climb rate (m/s) and the gustiness (0 to 1,
 * from `windGust`): gain 0 to 1 and the low-pass cutoff, Hz. Even at full
 * speed it stays a soft, low rush under the burner, so a long cruise isn't
 * one tiring hiss.
 */
export function windSound(airspeed: number, climb: number, gust = 0.5): { gain: number; cutoff: number } {
  // A faint breeze even at rest; a little louder and brighter with the air rushing past.
  const rush = Math.min(1, Math.hypot(airspeed, climb * 2) / 7);
  const swell = 0.7 + 0.6 * gust;
  return { gain: (0.06 + 0.12 * rush * rush) * swell, cutoff: (250 + 650 * rush) * (0.85 + 0.3 * gust) };
}

/** The ship's limits that make the timbers strain, from the comfort limits. */
export interface StrainLimits {
  /** Tilt rate, rad/s. */
  tiltRate: number;
  /** Change of turn rate, rad/s². */
  yawAccel: number;
  /** Change of speed, m/s². */
  accel: number;
}

/**
 * How hard the gondola is working, 0 (steady) to about 1 (at its limits),
 * from how fast it tilts, how fast its turn tightens or eases, and how fast
 * it changes speed. A steady cruise or a steady turn loads the rigging
 * evenly, so only changes make the timbers complain.
 */
export function strain(rollRate: number, pitchRate: number, yawAccel: number, accel: number, limits: StrainLimits): number {
  const tilt = Math.hypot(rollRate, pitchRate) / limits.tiltRate;
  return Math.min(1.5, 0.6 * tilt + 0.5 * Math.abs(yawAccel) / limits.yawAccel + 0.4 * Math.abs(accel) / limits.accel);
}

/** Creaks a second: now and then at rest, rising steeply as the gondola works hard (about one a second at its limits). */
export function creakRate(load: number): number {
  return 0.05 + 0.9 * load * load;
}

/**
 * Decides when a timber creaks: a random process at `creakRate(load)` a
 * second, with at least `MIN_GAP` seconds between creaks so they never
 * pile up into a buzz.
 */
export class CreakTimer {
  static readonly MIN_GAP = 0.6;
  private sinceLast = 0;

  constructor(private readonly random: () => number = Math.random) {}

  /** Advance by `dt` seconds at this strain; true if a creak starts now. */
  step(dt: number, load: number): boolean {
    this.sinceLast += dt;
    if (this.sinceLast < CreakTimer.MIN_GAP) {
      return false;
    }
    if (this.random() < creakRate(load) * dt) {
      this.sinceLast = 0;
      return true;
    }
    return false;
  }
}

/** A touchdown: the ship was coming down this frame before and has stopped now. */
export function touchedDown(previousVy: number, vy: number): boolean {
  return previousVy < -0.15 && Math.abs(vy) < 0.02;
}
