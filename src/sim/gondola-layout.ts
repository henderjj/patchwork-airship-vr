/**
 * The gondola's main dimensions, shared by the procedural model
 * (src/scene-assets/gondola.scene-asset.ts) and the engine-free simulation.
 * Gondola space: deck surface at y = 0, bow towards -Z, starboard +X.
 */

export const DECK_WIDTH = 2.0;
export const DECK_LENGTH = 3.0;

/** Burner and fuel hopper, mid-ship on the starboard side. */
export const BURNER_POSITION = [0.55, 0, 0.05] as const;
export const BURNER_SIZE = [0.42, 0.6, 0.42] as const;
