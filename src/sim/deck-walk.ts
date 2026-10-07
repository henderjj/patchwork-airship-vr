/**
 * Walking the deck with the thumbstick. Engine-free, so it can be unit tested.
 *
 * Gondola space: deck surface at y = 0, bow towards -Z, starboard +X.
 *
 * The bounds apply to the player's head, wherever it is in their play space.
 * IWSDK's locomotion collided a 0.5 m capsule at the play-space origin instead,
 * so a player standing away from the middle of their room was stopped early on
 * one side and could walk through the rail on the other.
 */

import { DECK_LENGTH, DECK_WIDTH } from './gondola-layout.js';

/** How close to the deck's edge the thumbstick takes the head, m (the bulwark is 0.05 m thick). */
export const WALK_MARGIN = 0.25;
export const WALK_HALF_WIDTH = DECK_WIDTH / 2 - WALK_MARGIN;
export const WALK_HALF_LENGTH = DECK_LENGTH / 2 - WALK_MARGIN;
/** Thumbstick walking speed at full tilt, m/s. */
export const WALK_SPEED = 1.5;
/** Thumbstick tilt below this is ignored (stick drift). */
export const WALK_DEAD_ZONE = 0.15;
/** Snap turn, radians. */
export const SNAP_TURN = Math.PI / 4;

/**
 * How far a thumbstick step of `step` along one axis may move a head at `head`
 * while staying within ±`half`. It stops at the bound and never pushes a head
 * that is already outside (the player walked there in their room) further
 * out, but always lets it come back in.
 */
export function clampStep(head: number, step: number, half: number): number {
  if (step > 0) {
    return Math.max(0, Math.min(step, half - head));
  }
  if (step < 0) {
    return Math.min(0, Math.max(step, -half - head));
  }
  return 0;
}

/**
 * Where the play-space origin goes when the player snap turns by `angle`
 * (radians, positive turns left) about their head, so the head stays put.
 * `out` gets [x, z].
 */
export function turnAboutHead(
  originX: number,
  originZ: number,
  headX: number,
  headZ: number,
  angle: number,
  out: [number, number],
): [number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const ox = originX - headX;
  const oz = originZ - headZ;
  out[0] = headX + ox * c + oz * s;
  out[1] = headZ - ox * s + oz * c;
  return out;
}
