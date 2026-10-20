/**
 * The gondola's main dimensions, shared by the procedural model
 * (src/scene-assets/gondola.scene-asset.ts) and the engine-free simulation.
 * Gondola space: deck surface at y = 0, bow towards -Z, starboard +X.
 */

export const DECK_WIDTH = 2.0;
export const DECK_LENGTH = 3.0;
/** The top rail runs round the deck this high above it, m. */
export const RAIL_HEIGHT = 1.0;
/** How far the hull's keel is below the deck: a ship resting on the ground has its deck this high. */
export const KEEL_DEPTH = 0.56;

/** Burner and fuel hopper, mid-ship on the starboard side. */
export const BURNER_POSITION = [0.55, 0, 0.05] as const;
export const BURNER_SIZE = [0.42, 0.6, 0.42] as const;
/** The fuel funnel on the burner's top, towards the bow (x, z). */
export const FUNNEL_POSITION = [BURNER_POSITION[0], BURNER_POSITION[2] - 0.11] as const;
/** The flue rises from the burner's top towards the stern (x, z), up to a flared nozzle under the envelope's mouth. */
export const FLUE_POSITION = [BURNER_POSITION[0], BURNER_POSITION[2] + 0.12] as const;
/** Height of the nozzle's open top, where the flame leaps up into the envelope's mouth. */
export const NOZZLE_TOP = 3.9;

/** The lantern hangs from this hook, on an iron bracket off the burner flue's port side. */
export const LANTERN_HOOK = [0.12, 2.35, FLUE_POSITION[1]] as const;

/**
 * The bilge pump (storms, docs/storms-and-night.md), against the starboard
 * rail between the crank and the burner: a barrel (its middle's x and z, its
 * radius and height), a lever pivoting on top with its handle reaching
 * inboard at waist height, and a spout out between the bulwark and the rail.
 */
export const PUMP = [0.82, -0.72] as const;
export const PUMP_RADIUS = 0.1;
export const PUMP_HEIGHT = 0.82;
/** The lever's pivot, and how far inboard of it the middle of its handle is, m. */
export const PUMP_PIVOT = [PUMP[0], 0.95, PUMP[1]] as const;
export const PUMP_LEVER = 0.42;
/** The lever swings this far either side of level, rad: the handle travels about 40 cm. */
export const PUMP_SWING = 0.5;
/** Where the water leaves the spout, outboard of the rail. */
export const PUMP_SPOUT = [DECK_WIDTH / 2 + 0.16, 0.6, PUMP[1]] as const;

/** The middle of the pump's handle with the lever at `angle` (rad, up positive), gondola space. */
export function pumpHandle(angle: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  out.x = PUMP_PIVOT[0] - PUMP_LEVER * Math.cos(angle);
  out.y = PUMP_PIVOT[1] + PUMP_LEVER * Math.sin(angle);
  out.z = PUMP_PIVOT[2];
  return out;
}
