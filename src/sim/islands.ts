import { KEEL_DEPTH } from './gondola-layout.js';
import { rng } from './random.js';

/**
 * Floating islands as the simulation sees them: where they are, the grassy
 * top a ship can rest on, and the rock beneath it that a ship can hit.
 * Engine-free; src/systems/sky-world-system.ts draws the same islands.
 */

/** An island: a flat-ish top of `radius` at height `y`, over rock tapering to a point `depth` metres below. */
export interface Island {
  x: number;
  y: number;
  z: number;
  radius: number;
  depth: number;
}

/** A randomly placed scenery island, with what the renderer needs to draw it. */
export interface SceneryIsland extends Island {
  /** Vertical scale of the unit-sized island shape. */
  height: number;
  rotationY: number;
  variant: number;
}

/** Island shapes, and the seed each shape is built from (src/world/sky-assets.ts). */
export const ISLAND_VARIANTS = 4;
export function islandVariantSeed(seed: number, variant: number): number {
  return seed * 10 + variant;
}

/**
 * How far the rock of island shape `variantSeed` reaches below its top, for
 * a unit-sized island. Replays the shape builder's own random stream (two
 * colour picks, then the depth), so it matches the drawn rock.
 */
export function islandDepth(variantSeed: number): number {
  const random = rng(variantSeed * 7919 + 13);
  random();
  random();
  // Grass cap 0.18 deep, then a cone of rock.
  return 0.18 + 1.1 + random() * 0.9;
}

/** The ship's size for collisions: the gondola and envelope as an upright cylinder from the keel. */
export const SHIP_RADIUS = 3;
export const SHIP_HEIGHT = 10.6;
/** The deck rests on an island's top only within this fraction of its radius (the rim is rough). */
const GROUND_FRACTION = 0.92;
/** A ship this little below a top still counts as resting on it, m. */
const GROUND_SLOP = 0.05;

/**
 * Lay out `count` scenery islands at random around the origin. A spot for
 * which `clear(x, z, radius)` is false is drawn again, so routes can keep
 * their corridor free without changing how many islands there are.
 */
export function layoutIslands(seed: number, count: number, clear: (x: number, z: number, radius: number) => boolean = () => true): SceneryIsland[] {
  const random = rng(seed * 101 + 5);
  const depths: number[] = [];
  for (let v = 0; v < ISLAND_VARIANTS; v++) {
    depths.push(islandDepth(islandVariantSeed(seed, v)));
  }
  const islands: SceneryIsland[] = [];
  for (let i = 0; i < count; i++) {
    let island: SceneryIsland | null = null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const angle = random() * Math.PI * 2;
      // Near islands first so a small count still frames the ship nicely.
      const distance = 60 + Math.pow(random(), 0.8) * 600;
      const radius = 8 + random() * 26;
      const y = 25 + random() * 75;
      const height = radius * (0.8 + random() * 0.6);
      const rotationY = random() * Math.PI * 2;
      const variant = i % ISLAND_VARIANTS;
      const x = Math.cos(angle) * distance;
      const z = Math.sin(angle) * distance;
      island = { x, y, z, radius, depth: depths[variant] * height, height, rotationY, variant };
      if (clear(x, z, radius)) {
        break;
      }
    }
    islands.push(island!);
  }
  return islands;
}

/** The deck's height when the ship rests on `island`, its keel on the grass. */
export function restingDeck(island: Island): number {
  return island.y + KEEL_DEPTH;
}

/**
 * The deck's height if a ship at (x, z) rests on an island top below it, or
 * -Infinity. Only islands it would rest on at or below `fromY` (the deck's
 * height a moment ago) count, so a ship that is beside or under an island
 * isn't lifted onto it.
 * `wrap` moves each island to its copy nearest the ship (the world repeats).
 */
export function groundBelow(islands: readonly Island[], x: number, z: number, fromY: number, wrap?: (value: number, centre: number) => number): number {
  let ground = Number.NEGATIVE_INFINITY;
  for (const island of islands) {
    const ix = wrap ? wrap(island.x, x) : island.x;
    const iz = wrap ? wrap(island.z, z) : island.z;
    const r = island.radius * GROUND_FRACTION;
    const dx = x - ix;
    const dz = z - iz;
    const deck = island.y + KEEL_DEPTH;
    if (dx * dx + dz * dz < r * r && deck <= fromY + GROUND_SLOP && deck > ground) {
      ground = deck;
    }
  }
  return ground;
}

/** Whether a ship with its deck at (x, y, z) has run into the rock of `island` (resting on its top doesn't count). */
export function hitsIsland(island: Island, x: number, y: number, z: number, ix = island.x, iz = island.z): boolean {
  const keel = y - KEEL_DEPTH;
  if (keel >= island.y - GROUND_SLOP) {
    return false;
  }
  // The highest part of the ship that is level with the rock.
  const level = Math.min(island.y, keel + SHIP_HEIGHT);
  const below = island.y - level;
  if (below >= island.depth) {
    return false;
  }
  const rockRadius = island.radius * (1 - below / island.depth);
  return Math.hypot(x - ix, z - iz) < rockRadius + SHIP_RADIUS;
}

/** The first island the ship at (x, y, z) has run into, or -1. */
export function islandHit(islands: readonly Island[], x: number, y: number, z: number, wrap?: (value: number, centre: number) => number): number {
  for (let i = 0; i < islands.length; i++) {
    const island = islands[i];
    const ix = wrap ? wrap(island.x, x) : island.x;
    const iz = wrap ? wrap(island.z, z) : island.z;
    if (hitsIsland(island, x, y, z, ix, iz)) {
      return i;
    }
  }
  return -1;
}
