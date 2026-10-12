/**
 * Character height and seated play. Engine-free, so it can be unit tested.
 *
 * The game raises or lowers the player's whole tracked rig (view and hands
 * together) so that their eyes are at their character's eye height when they
 * are upright. How tall they are upright is measured, not asked: the highest
 * their head has been, smoothed so a bob or a tracking glitch doesn't count.
 * Crouching still crouches, and the crewmate sees the character's height
 * because poses are sent in scene space, offset included.
 *
 * - Your own height, standing (the default): no change, so the deck is where
 *   the player's real floor is. Only a floor set far too low (eyes measured
 *   above `MAX_OWN_EYE`) is pulled down to that.
 * - A chosen height: eyes at that height less `EYES_BELOW_TOP`, whatever the
 *   player's real height or a wrongly set floor.
 * - Seated: the player's seated eyes are raised to `SEATED_EYE`, a little
 *   shorter than the default character, or to the chosen height's. Raising
 *   a seated player to full standing height left the crank's low point and
 *   the fuel crate too far down to reach from a chair (John, 2026-10-12).
 */

/** The default character's height, m (the crew avatar is built for it). */
export const DEFAULT_CHARACTER_HEIGHT = 1.75;
/** How far the eyes are below the top of the head, m (as on the crew avatar: eyes at 1.62 m). */
export const EYES_BELOW_TOP = 0.13;
/**
 * Eye height for seated play at the player's own height, m: a 1.58 m
 * character's. A chair-height upright head (about 1.2 m) is raised about
 * 0.25 m, so the crank turns between knee and chest and the crate is in
 * reach beside the chair.
 */
export const SEATED_EYE = 1.45;
/** Heights a player may choose, m. */
export const MIN_CHARACTER_HEIGHT = 1.4;
export const MAX_CHARACTER_HEIGHT = 2.0;
/** Highest eye height kept for "your own height": a 2 m tall player's. Above this the floor is set too low. */
export const MAX_OWN_EYE = 1.9;
/** Furthest the rig is lowered or raised, m. */
export const MAX_LOWER = 0.7;
export const MAX_RAISE = 0.9;
/** How fast the view glides to a new offset once playing, m/s (slow enough not to be felt as a lift). */
export const GLIDE_SPEED = 0.25;
/** Time constant of the smoothing on head height before its highest is taken, s. */
const SMOOTH_SECONDS = 0.5;
/** Head heights outside this band aren't counted (headset off, on the floor, or tracking lost), m. */
const MIN_HEAD = 0.6;
const MAX_HEAD = 2.6;

/** What the player chose: a character height in metres (0 for their own) and whether they sit. */
export interface BodyChoice {
  height: number;
  seated: boolean;
}

/** A choice's height kept in range; 0 (their own) stays 0. */
export function clampCharacterHeight(height: number): number {
  if (!(height > 0)) {
    return 0;
  }
  return Math.min(MAX_CHARACTER_HEIGHT, Math.max(MIN_CHARACTER_HEIGHT, height));
}

/**
 * The player's upright eye height in their play space: the highest their head
 * has been since `reset`, after smoothing.
 */
export class UprightEye {
  /** Smoothed head height, m (NaN before the first sample). */
  smoothed = Number.NaN;
  /** Highest smoothed head height, m (NaN before the first sample). */
  upright = Number.NaN;
  /** Seconds of head samples since `reset`. */
  seconds = 0;

  reset(): void {
    this.smoothed = Number.NaN;
    this.upright = Number.NaN;
    this.seconds = 0;
  }

  /** Add a head height (m, above the play-space floor) seen `dt` seconds after the last. */
  push(headY: number, dt: number): void {
    if (!(headY > MIN_HEAD && headY < MAX_HEAD)) {
      return;
    }
    this.smoothed = Number.isNaN(this.smoothed) ? headY : this.smoothed + (headY - this.smoothed) * Math.min(1, dt / SMOOTH_SECONDS);
    if (!(this.upright >= this.smoothed)) {
      this.upright = this.smoothed;
    }
    this.seconds += dt;
  }
}

/** The eye height a choice asks for when upright, m, or null for "as measured" (own height, standing). */
export function targetEyeHeight(choice: BodyChoice): number | null {
  const height = clampCharacterHeight(choice.height);
  if (height > 0) {
    return height - EYES_BELOW_TOP;
  }
  if (choice.seated) {
    return SEATED_EYE;
  }
  return null;
}

/** How far to raise (+) or lower (-) the rig so eyes at `uprightEye` sit at `target`, m. */
export function rigOffset(target: number | null, uprightEye: number): number {
  if (!Number.isFinite(uprightEye)) {
    return 0;
  }
  const offset = target === null ? Math.min(0, MAX_OWN_EYE - uprightEye) : target - uprightEye;
  return Math.min(MAX_RAISE, Math.max(-MAX_LOWER, offset));
}

/** Move `current` towards `target` by at most `GLIDE_SPEED * dt`. */
export function glide(current: number, target: number, dt: number): number {
  const step = GLIDE_SPEED * dt;
  return Math.abs(target - current) <= step ? target : current + Math.sign(target - current) * step;
}
