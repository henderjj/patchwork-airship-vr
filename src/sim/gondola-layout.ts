/**
 * The gondola's main dimensions, shared by the procedural model
 * (src/scene-assets/gondola.scene-asset.ts) and the engine-free simulation.
 * Gondola space: deck surface at y = 0, bow towards -Z, starboard +X.
 */

export const DECK_WIDTH = 2.0;
export const DECK_LENGTH = 3.0;
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
