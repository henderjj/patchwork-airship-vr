/**
 * The patch loft (Phase 3 repairs, docs/repairs.md): a small railed
 * platform slung under the envelope's belly over the port side of the deck,
 * reached by a ladder that rises from the deck through a hatch in its
 * floor. From the loft the crew can reach the envelope overhead to mend a
 * tear (src/sim/envelope.ts). Engine-free, so it can be unit tested.
 *
 * Gondola space: deck surface at y = 0, bow towards -Z, starboard +X.
 *
 * Climbing: squeeze near a rung or a stile and the hand holds the ladder
 * where it is; moving it down raises the player (the whole tracked rig, as
 * character height does, src/sim/body-height.ts) so the hand stays put on
 * the ladder, and moving it up lowers them. Only the height changes. Let go
 * and the player stays where they are (feet on the rungs). At the top their
 * eyes are at `LOFT_EYE`, whatever their height or seated, so the envelope
 * is the same reach overhead for everyone.
 */

import { DEFAULT_CHARACTER_HEIGHT, EYES_BELOW_TOP } from './body-height.js';

/** The top of the loft's planks above the deck, m. */
export const LOFT_FLOOR = 2.45;
/** The planks' thickness, m. */
export const LOFT_THICKNESS = 0.05;
/** The loft's floor (x and z from-to), m: along the port side, aft of the vent cord, clear of the lantern. */
export const LOFT = { x0: -0.95, x1: -0.1, z0: -0.15, z1: 1.4 } as const;
/** The loft's floor planks run fore and aft, this many across it. */
export const LOFT_PLANKS = 5;
/** The hatch in its floor that the ladder comes up through: the outboard three planks are cut away there. */
export const LOFT_HATCH = { x0: LOFT.x0, x1: LOFT.x0 + ((LOFT.x1 - LOFT.x0) * 3) / LOFT_PLANKS, z0: 0.26, z1: 0.84 } as const;
/** The loft's rail is this high above its floor, m. */
export const LOFT_RAIL = 0.95;
/** Where the eyes are with the player standing on the loft, m above the deck: about 40 cm below the envelope over it. */
export const LOFT_EYE = 4.1;
/** The default character's upright eyes on the deck, m. */
export const DEFAULT_EYE = DEFAULT_CHARACTER_HEIGHT - EYES_BELOW_TOP;
/** Least and most a player is raised standing on the loft (a tall or a short character, or seated), m. */
const LOFT_RAISE_MIN = 2.0;
const LOFT_RAISE_MAX = 3.0;

/** The ladder: its rungs run fore and aft between two stiles in this plane (x), m. */
export const LADDER_X = -0.86;
/** Its two stiles (z), fore and aft. */
export const LADDER_Z = [0.34, 0.76] as const;
/** The stiles stand from the deck to a rail's height above the loft's floor (hand holds for getting on and off at the top), m. */
export const LADDER_TOP = LOFT_FLOOR + LOFT_RAIL;
/** Rungs, from the lowest up, m: one every `RUNG_SPACING` up to the loft's floor. */
export const RUNG_SPACING = 0.3;
export const RUNGS: readonly number[] = Array.from({ length: 8 }, (_, i) => RUNG_SPACING * (i + 1));
/** The stiles' size across (x) and along (z) the deck, and the rungs' radius, m. */
export const STILE_SIZE = [0.035, 0.05] as const;
export const RUNG_RADIUS = 0.016;
/** A hand this close to a rung's or a stile's middle line can take hold, m. */
export const LADDER_REACH = 0.1;
/** Most a climbing hand can move the player in one frame, m (a tracking glitch can't throw them up the ladder). */
const MAX_STEP = 0.2;
/** Let go within this much of the top, the player steps up onto the loft, m; and how fast they step, m/s. */
const STEP_UP = 0.2;
const STEP_SPEED = 1;

/**
 * The loft's box of patches, hung inside its inboard rail: the middle of
 * its open top and its size (x, y, z); a hand this close to the top takes
 * a patch, m.
 */
export const PATCH_BOX = [-0.2, LOFT_FLOOR + 0.8, 0.22] as const;
export const PATCH_BOX_SIZE = [0.14, 0.2, 0.34] as const;
export const PATCH_BOX_REACH = 0.16;
/** The riveting hammer hangs on the inboard rail, aft: where its handle is held as it hangs, and how close a hand must be to take it, m. */
export const HAMMER_REST = [-0.19, LOFT_FLOOR + 0.62, 0.98] as const;
export const HAMMER_REACH = 0.12;
/** The hammer's head is this far along the handle from the hand (out of the fist, the way a held rope runs), m. */
export const HAMMER_HEAD = 0.24;

/** Where the thumbstick may take the head on the loft: inside its rail, m. */
const LOFT_MARGIN = 0.12;
export const LOFT_WALK = {
  x0: LOFT.x0 + LOFT_MARGIN,
  x1: LOFT.x1 - LOFT_MARGIN,
  z0: LOFT.z0 + LOFT_MARGIN,
  z1: LOFT.z1 - LOFT_MARGIN,
} as const;

/**
 * How far a player whose upright eyes are `eye` above the deck (with any
 * character height or seated raise already in it) is raised standing on the
 * loft, so their eyes are at `LOFT_EYE`. NaN (not measured yet) counts as
 * the default character's.
 */
export function loftRaise(eye: number): number {
  const e = Number.isFinite(eye) ? eye : DEFAULT_EYE;
  return Math.min(LOFT_RAISE_MAX, Math.max(LOFT_RAISE_MIN, LOFT_EYE - e));
}

/** Where on the ladder a hand at (x, y, z) takes hold: the nearest point on a rung or a stile, and which way that runs. */
export interface LadderHold {
  x: number;
  y: number;
  z: number;
  /** True for a stile (upright), false for a rung (fore and aft). */
  stile: boolean;
  /** Distance from the hand, m. */
  distance: number;
}

/**
 * The ladder's nearest rung or stile to a hand at (x, y, z), into `out`;
 * false if none is within `LADDER_REACH`.
 */
export function ladderHold(x: number, y: number, z: number, out: LadderHold): boolean {
  out.distance = Number.POSITIVE_INFINITY;
  const dx = x - LADDER_X;
  // Stiles: upright from the deck to their tops.
  for (const sz of LADDER_Z) {
    const py = Math.min(LADDER_TOP, Math.max(0, y));
    const d = Math.hypot(dx, y - py, z - sz);
    if (d < out.distance) {
      out.x = LADDER_X;
      out.y = py;
      out.z = sz;
      out.stile = true;
      out.distance = d;
    }
  }
  // Rungs: fore and aft between the stiles.
  const pz = Math.min(LADDER_Z[1], Math.max(LADDER_Z[0], z));
  for (const ry of RUNGS) {
    const d = Math.hypot(dx, y - ry, z - pz);
    if (d < out.distance) {
      out.x = LADDER_X;
      out.y = ry;
      out.z = pz;
      out.stile = false;
      out.distance = d;
    }
  }
  return out.distance <= LADDER_REACH;
}

type Side = 'left' | 'right';

/**
 * One player on the ladder: how far climbing has raised them. Each hand
 * that takes hold of the ladder is anchored at the height it took hold;
 * the most recent one climbs (the player moves so it stays at its anchor),
 * and when it lets go the other, if it still holds, takes over from where
 * it is.
 */
export class Climber {
  /** How far climbing has raised the player, m (0 on the deck). */
  height = 0;
  /** How far standing on the loft raises them, m (`loftRaise`). */
  top = loftRaise(Number.NaN);
  private anchor: Record<Side, number> = { left: Number.NaN, right: Number.NaN };
  private active: Side | null = null;
  /** The active hand changed while holding on: anchor it where it is on the next update. */
  private reanchor = false;

  /** Whether a hand holds the ladder. */
  holding(side: Side): boolean {
    return !Number.isNaN(this.anchor[side]);
  }

  /** Whether either hand holds it. */
  get onLadder(): boolean {
    return this.holding('left') || this.holding('right');
  }

  /** Standing on the loft (not holding on partway up). */
  get onLoft(): boolean {
    return this.height >= this.top - 0.02;
  }

  /** Partway up, neither on the deck nor on the loft. */
  get between(): boolean {
    return this.height > 0.02 && !this.onLoft;
  }

  /** Where the player's feet are, m above the deck (for their avatar's legs). */
  get feet(): number {
    return this.onLoft ? LOFT_FLOOR : this.height;
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
   * the loft raises this player. Returns the height.
   */
  update(dt: number, leftY: number, rightY: number, top: number): number {
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
    } else if (this.height > top - STEP_UP && this.height !== top) {
      // Let go near the top: step up onto the loft (or settle, if it moved).
      const step = STEP_SPEED * dt;
      this.height += Math.max(-step, Math.min(step, top - this.height));
    } else if (this.height > 0 && this.height < 0.05) {
      this.height = 0;
    }
    return this.height;
  }
}
