/**
 * The rigging to the envelope (Phase 3 repairs, docs/repairs.md): two
 * shrouds rising from the port rail amidships, just aft of the rail's middle
 * post, straight up to the envelope's belly, with rope ratlines between them
 * from above head height. A crew member climbs them to mend a tear in the
 * canvas overhead (src/sim/envelope.ts) while the other keeps flying; the
 * patches and the riveting hammer hang at the rigging's foot, so the one
 * left on deck can hand them up. Engine-free, so it can be unit tested.
 *
 * Gondola space: deck surface at y = 0, bow towards -Z, starboard +X.
 *
 * Climbing: squeeze near a ratline or a shroud and the hand holds the
 * rigging where it is; moving it down raises the player (the whole tracked
 * rig, as character height does, src/sim/body-height.ts) so the hand stays
 * put, and moving it up lowers them. Only the height changes. Let go and the
 * player stays where they are (feet on the ratlines). At the top their eyes
 * are at `RIG_EYE`, whatever their height or seated, so the envelope is the
 * same reach overhead for everyone.
 */

import { DEFAULT_CHARACTER_HEIGHT, EYES_BELOW_TOP } from './body-height.js';
import { RAIL_HEIGHT } from './gondola-layout.js';

/** The shrouds rise in this plane (x), on the port rail's cap, m. */
export const RIG_X = -0.99;
/** Fore and aft shroud (z): clear of the rail's middle post and its rope, and forward of the mooring line's coil, m. */
export const RIG_Z = [0.15, 0.6] as const;
/** The shrouds stand on the rail's cap and run up into the envelope's belly, m. */
export const SHROUD_FOOT = RAIL_HEIGHT + 0.03;
export const SHROUD_TOP = 4.62;
/** Ratlines, from the lowest up, m: one every `RATLINE_SPACING` from above head height (clear of the mooring line along the rail) to just under the canvas. */
export const RATLINE_SPACING = 0.32;
export const RATLINES: readonly number[] = Array.from({ length: 9 }, (_, i) => 1.8 + RATLINE_SPACING * i);
/** A hand can hold a shroud only above this, well clear of the mooring line on the rail below, m. */
export const SHROUD_HOLD_LOW = 1.55;
/** The shrouds' and ratlines' radius, m. */
export const SHROUD_RADIUS = 0.014;
export const RATLINE_RADIUS = 0.011;
/** A hand this close to a ratline or a shroud can take hold, m. */
export const RIG_REACH = 0.12;
/** Where the eyes are with the player at the top of the rigging, m above the deck: about 45 cm below the envelope over it. */
export const RIG_EYE = 4.1;
/** Where a player at the top works from: their head, standing inboard of the shrouds as they climbed (tests, sounds), m. */
export const RIG_WORK = [-0.62, RIG_EYE, (RIG_Z[0] + RIG_Z[1]) / 2] as const;
/** The default character's upright eyes on the deck, m. */
export const DEFAULT_EYE = DEFAULT_CHARACTER_HEIGHT - EYES_BELOW_TOP;
/** Least and most a player is raised at the top (a tall or a short character, or seated), m. */
const RIG_RAISE_MIN = 2.0;
const RIG_RAISE_MAX = 3.0;
/** Most a climbing hand can move the player in one frame, m (a tracking glitch can't throw them up the rigging). */
const MAX_STEP = 0.2;

/** A batten lashed across the shrouds at the rigging's foot, holding the hammer: its height, m. */
export const GEAR_BATTEN = 1.48;
/**
 * The box of canvas patches, hung on the aft shroud's inboard side at the
 * rigging's foot: the middle of its open top and its size (x, y, z); a hand
 * this close to the top takes a patch, m.
 */
export const PATCH_BOX = [-0.87, GEAR_BATTEN + 0.1, RIG_Z[1] + 0.19] as const;
export const PATCH_BOX_SIZE = [0.12, 0.18, 0.26] as const;
export const PATCH_BOX_REACH = 0.16;
/** The riveting hammer rests on two pegs on the batten, its head forward: where its handle is held as it rests, and how close a hand must be to take it, m. */
export const HAMMER_REST = [-0.9, GEAR_BATTEN + 0.035, RIG_Z[1] - 0.12] as const;
export const HAMMER_REACH = 0.12;
/** The hammer's head is this far along the handle from the hand (out of the fist, the way a held rope runs), m. */
export const HAMMER_HEAD = 0.24;

/**
 * How far a player whose upright eyes are `eye` above the deck (with any
 * character height or seated raise already in it) is raised at the top of
 * the rigging, so their eyes are at `RIG_EYE`. NaN (not measured yet)
 * counts as the default character's.
 */
export function rigRaise(eye: number): number {
  const e = Number.isFinite(eye) ? eye : DEFAULT_EYE;
  return Math.min(RIG_RAISE_MAX, Math.max(RIG_RAISE_MIN, RIG_EYE - e));
}

/** Where on the rigging a hand at (x, y, z) takes hold: the nearest point on a ratline or a shroud, and which way that runs. */
export interface RigHold {
  x: number;
  y: number;
  z: number;
  /** True for a shroud (upright), false for a ratline (fore and aft). */
  shroud: boolean;
  /** Distance from the hand, m. */
  distance: number;
}

/**
 * The rigging's nearest ratline or shroud to a hand at (x, y, z), into
 * `out`; false if none is within `RIG_REACH`.
 */
export function rigHold(x: number, y: number, z: number, out: RigHold): boolean {
  out.distance = Number.POSITIVE_INFINITY;
  const dx = x - RIG_X;
  // Shrouds: upright, holdable above the rail.
  for (const sz of RIG_Z) {
    const py = Math.min(RATLINES[RATLINES.length - 1], Math.max(SHROUD_HOLD_LOW, y));
    const d = Math.hypot(dx, y - py, z - sz);
    if (d < out.distance) {
      out.x = RIG_X;
      out.y = py;
      out.z = sz;
      out.shroud = true;
      out.distance = d;
    }
  }
  // Ratlines: fore and aft between the shrouds.
  const pz = Math.min(RIG_Z[1], Math.max(RIG_Z[0], z));
  for (const ry of RATLINES) {
    const d = Math.hypot(dx, y - ry, z - pz);
    if (d < out.distance) {
      out.x = RIG_X;
      out.y = ry;
      out.z = pz;
      out.shroud = false;
      out.distance = d;
    }
  }
  return out.distance <= RIG_REACH;
}

type Side = 'left' | 'right';

/**
 * One player in the rigging: how far climbing has raised them. Each hand
 * that takes hold is anchored at the height it took hold; the most recent
 * one climbs (the player moves so it stays at its anchor), and when it lets
 * go the other, if it still holds, takes over from where it is.
 */
export class Climber {
  /** How far climbing has raised the player, m (0 on the deck). */
  height = 0;
  /** How far the top of the rigging raises them, m (`rigRaise`). */
  top = rigRaise(Number.NaN);
  private anchor: Record<Side, number> = { left: Number.NaN, right: Number.NaN };
  private active: Side | null = null;
  /** The active hand changed while holding on: anchor it where it is on the next update. */
  private reanchor = false;

  /** Whether a hand holds the rigging. */
  holding(side: Side): boolean {
    return !Number.isNaN(this.anchor[side]);
  }

  /** Whether either hand holds it. */
  get onRigging(): boolean {
    return this.holding('left') || this.holding('right');
  }

  /** Off the deck, in the rigging. */
  get aloft(): boolean {
    return this.height > 0.02;
  }

  /** At the top, where the tears are in reach. */
  get atTop(): boolean {
    return this.height >= this.top - 0.02;
  }

  /** Where the player's feet are, m above the deck (for their avatar's legs). */
  get feet(): number {
    return this.height;
  }

  /** A hand took hold at world height `handY`. */
  grab(side: Side, handY: number): void {
    this.anchor[side] = handY;
    this.active = side;
  }

  release(side: Side): void {
    this.anchor[side] = Number.NaN;
    if (this.active === side) {
      const other: Side = side === 'left' ? 'right' : 'left';
      this.active = this.holding(other) ? other : null;
      this.reanchor = this.active !== null;
    }
  }

  releaseAll(): void {
    this.anchor.left = this.anchor.right = Number.NaN;
    this.active = null;
  }

  /** Back on the deck (a fresh run, leaving VR). */
  reset(): void {
    this.releaseAll();
    this.height = 0;
  }

  /**
   * Move on a frame: `leftY` and `rightY` are the hands' world heights this
   * frame (as tracked, with the rig at the current height), `top` how far
   * the top of the rigging raises this player. Returns the height.
   */
  update(leftY: number, rightY: number, top: number): number {
    this.top = top;
    const side = this.active;
    if (side) {
      const y = side === 'left' ? leftY : rightY;
      if (this.reanchor) {
        this.anchor[side] = y;
        this.reanchor = false;
      }
      const want = Math.max(-MAX_STEP, Math.min(MAX_STEP, this.anchor[side] - y));
      const next = Math.min(top, Math.max(0, this.height + want));
      // Pushed past the top or the deck, the hand's hold moves with it, so pulling back starts at once.
      this.anchor[side] = y + (next - this.height);
      this.height = next;
    } else if (this.height > top) {
      // The top came down (a shorter character chosen up there).
      this.height = top;
    } else if (this.height > 0 && this.height < 0.05) {
      // Let go just above the deck: stand on it.
      this.height = 0;
    }
    return this.height;
  }
}
