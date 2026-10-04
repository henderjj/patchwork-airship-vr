/**
 * Where the gondola's flight controls are and how a hand works them (Phase 2).
 * Engine-free, so the geometry, the interaction and the host's simulation
 * share one set of numbers and can be unit tested.
 *
 * Gondola space: deck surface at y = 0, bow towards -Z, starboard +X.
 *
 * - Burner: a fuel brick let go in or on the hopper mouth is burned.
 * - Vent cord: hangs mid-ship on the port side; pulling its toggle down
 *   opens the vent, and it springs closed when let go.
 * - Tiller: a bar at the stern, pivoting on the rudder post. Like a boat's,
 *   pushing it to one side turns the ship the other way. It stays where it
 *   is left.
 * - Ballast: sandbags hanging outside the starboard rail at the stern.
 *   Lifting one off its hook and letting go drops it overboard.
 * - Trim: where the crew stands tips the ship a little and, once it is
 *   moving, a nose-down trim makes it descend.
 */

import { BURNER_POSITION, BURNER_SIZE, DECK_LENGTH, DECK_WIDTH } from './gondola-layout.js';

/** Hopper mouth: a brick whose centre comes within this region and isn't held is burned. */
export const HOPPER = {
  x: BURNER_POSITION[0],
  z: BURNER_POSITION[2],
  /** Horizontal reach from the hopper's centre line, m (the burner top is 0.42 m across). */
  radius: 0.22,
  /** From just above the burner's top (where a dropped brick comes to rest) to well above it, m. */
  yMin: BURNER_SIZE[1] - 0.02,
  yMax: BURNER_SIZE[1] + 0.35,
} as const;

export function inHopper(x: number, y: number, z: number): boolean {
  return y > HOPPER.yMin && y < HOPPER.yMax && Math.hypot(x - HOPPER.x, z - HOPPER.z) < HOPPER.radius;
}

/** Vent cord toggle at rest (closed), m. */
export const VENT_TOGGLE = [-0.3, 1.55, -0.3] as const;
/** Pulling the toggle this far down opens the vent fully, m. */
export const VENT_PULL = 0.3;
/** Where the cord is tied off above, m. */
export const VENT_CORD_TOP = 4.4;
/** A hand this close to the toggle can take it, m. */
export const VENT_REACH = 0.12;

/** Vent opening for the toggle pulled down to `toggleY`. */
export function ventFromToggle(toggleY: number): number {
  return Math.min(1, Math.max(0, (VENT_TOGGLE[1] - toggleY) / VENT_PULL));
}

/** The toggle's height for a hand at `handY` holding it `offset` above the toggle (the cord can't be pushed up). */
export function toggleFromHand(handY: number, offset: number): number {
  return Math.min(VENT_TOGGLE[1], Math.max(VENT_TOGGLE[1] - VENT_PULL, handY - offset));
}

/** Tiller: the rudder post at the stern, and the bar's length forward to the handle, m. */
export const TILLER_PIVOT = [0, 0.86, DECK_LENGTH / 2 - 0.15] as const;
export const TILLER_LENGTH = 0.6;
/** The bar swings this far either side, degrees. */
export const TILLER_MAX_DEG = 35;
/** A hand this close to the handle (the bar's last 15 cm) can take it, m. */
export const TILLER_REACH = 0.13;
const TILLER_MAX = (TILLER_MAX_DEG * Math.PI) / 180;

/** Bar angle for a rudder setting: positive swings the handle to starboard, which puts the rudder to port. */
export function tillerAngle(rudder: number): number {
  return -Math.max(-1, Math.min(1, rudder)) * TILLER_MAX;
}

/** The rudder setting for a hand at (x, z) holding the tiller. */
export function rudderFromHand(x: number, z: number): number {
  const forward = TILLER_PIVOT[2] - z;
  if (forward < 0.05) {
    // A hand behind the post can't sensibly steer; hold the middle.
    return 0;
  }
  const angle = Math.atan2(x - TILLER_PIVOT[0], forward);
  return Math.max(-1, Math.min(1, -angle / TILLER_MAX));
}

/** Handle (the bar's end) position for a rudder setting. */
export function tillerHandle(rudder: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const a = tillerAngle(rudder);
  out.x = TILLER_PIVOT[0] + Math.sin(a) * TILLER_LENGTH;
  out.y = TILLER_PIVOT[1] + 0.04;
  out.z = TILLER_PIVOT[2] - Math.cos(a) * TILLER_LENGTH;
  return out;
}

/** Ballast bags hanging outside the starboard rail, stern end; each one's centre, m. */
export const BALLAST_BAGS: readonly (readonly [number, number, number])[] = [0.55, 0.78, 1.01, 1.24].map(
  (z) => [DECK_WIDTH / 2 + 0.16, 0.78, z] as const,
);
export const BALLAST_BAG_KG = 20;
/** A hand this close to a bag can take it, m. */
export const BALLAST_REACH = 0.16;

/** Let go here and the bag falls overboard; anywhere else it goes back on its hook. */
export function overboard(x: number, z: number): boolean {
  return Math.abs(x) > DECK_WIDTH / 2 || Math.abs(z) > DECK_LENGTH / 2;
}

export function ballastDropped(mask: number): number {
  let n = 0;
  for (let i = 0; i < BALLAST_BAGS.length; i++) {
    if (mask & (1 << i)) n++;
  }
  return n * BALLAST_BAG_KG;
}

/** Lean per metre of a crew member's offset from the deck centre, radians. */
export const TRIM_PER_METRE = 0.015;

/**
 * Trim from where the crew stands: nose-up pitch and starboard-down roll,
 * radians. Each person standing towards the bow pushes the nose down; each
 * one to starboard pushes that side down.
 */
export function trimFromCrew(xs: readonly number[], zs: readonly number[], count: number, out: { pitch: number; roll: number }): void {
  let sx = 0;
  let sz = 0;
  for (let i = 0; i < count; i++) {
    sx += Math.max(-DECK_WIDTH / 2, Math.min(DECK_WIDTH / 2, xs[i]));
    sz += Math.max(-DECK_LENGTH / 2, Math.min(DECK_LENGTH / 2, zs[i]));
  }
  // Bow is -Z, so standing at the bow (negative z) gives a negative (nose-down) pitch.
  out.pitch = TRIM_PER_METRE * sz;
  out.roll = TRIM_PER_METRE * sx;
}

/**
 * The ship's bell (Phase 2 route): hung from a bracket over the port bow
 * corner post. Ring it (grip within reach) to start the route again.
 */
export const BELL_HOOK = [-0.78, 1.7, -1.3] as const;
/** The bell's middle, below its hook. */
export const BELL_CENTER = [BELL_HOOK[0], BELL_HOOK[1] - 0.12, BELL_HOOK[2]] as const;
export const BELL_REACH = 0.16;
