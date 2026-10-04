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

/** Wind noise for an airspeed and climb rate (m/s): gain 0 to 1 and the low-pass cutoff, Hz. */
export function windSound(airspeed: number, climb: number): { gain: number; cutoff: number } {
  // A faint breeze even at rest; louder and brighter with the air rushing past.
  const rush = Math.min(1, Math.hypot(airspeed, climb * 2) / 7);
  return { gain: 0.06 + 0.5 * rush * rush, cutoff: 250 + 1400 * rush };
}

/** The ship's limits that make the timbers strain, from the comfort limits. */
export interface StrainLimits {
  /** Tilt rate, rad/s. */
  tiltRate: number;
  /** Turn rate, rad/s. */
  yawRate: number;
  /** Change of speed, m/s². */
  accel: number;
}

/** How hard the gondola is working, 0 (still) to about 1 (at its limits), from how fast it tilts, turns and changes speed. */
export function strain(rollRate: number, pitchRate: number, yawRate: number, accel: number, limits: StrainLimits): number {
  const tilt = Math.hypot(rollRate, pitchRate) / limits.tiltRate;
  return Math.min(1.5, 0.6 * tilt + 0.5 * Math.abs(yawRate) / limits.yawRate + 0.4 * Math.abs(accel) / limits.accel);
}

/** Creaks a second: now and then at rest, often when the gondola works hard. */
export function creakRate(load: number): number {
  return 0.06 + 0.9 * load;
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
