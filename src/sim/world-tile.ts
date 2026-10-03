/**
 * The islands and clouds repeat every `WORLD_TILE` metres east-west and
 * north-south, so a long flight never leaves them behind (a 15-minute comfort
 * test covers about 4 km). Each is drawn in the copy of the tile nearest the
 * ship, so it jumps to the far side only where the fog has already hidden it
 * (the fog ends at 950 m).
 */
export const WORLD_TILE = 2000;

/** `value` shifted by whole world tiles to lie within half a tile of `centre`. */
export function wrapNear(value: number, centre: number): number {
  const half = WORLD_TILE / 2;
  return centre + ((((value - centre + half) % WORLD_TILE) + WORLD_TILE) % WORLD_TILE) - half;
}
