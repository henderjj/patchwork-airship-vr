import { BoxGeometry, type BufferGeometry, ConeGeometry, CylinderGeometry, IcosahedronGeometry, TorusGeometry } from '@iwsdk/core';
import { beam, jitter, mergeParts, type Part, rng, shade } from '../scene-assets/lowpoly.js';
import { jettyRoot, type LandingIsland, type LoadingStage, type Route, TARGET_RINGS } from '../sim/route.js';

/**
 * The route's pieces in the sky (Phase 2): the two landing islands, the
 * marker rings and island B's beacon. Sizes are in metres, as the route
 * (src/sim/route.ts) lays them out; each geometry's origin is the island's
 * top centre, the ring's centre, or the beacon's base.
 */

const GRASS = 0x86ba5f;
const ROCK = 0x947c69;
const PLANK = 0xb8875a;
const PLANK_DARK = 0x8a5f3c;
const PAINT = 0xf2ecd8;
const POLE = 0x6b4a32;
const TREE = [0x3f7d4a, 0x4b8c4f, 0x356b45];

/**
 * A landing island: a level grass top (so the gondola sits flat on it), rock
 * below as deep as `island.depth`, a plank landing pad with a painted ring in
 * the middle, a flag of `flagColor` beside the pad, and trees round the rim.
 * With `loading`, the loading stage too (cargo loading): a waist-high plank
 * table on the pad beside the ship, for the crates to wait on.
 */
export function createLandingIslandGeometry(island: LandingIsland, flagColor: number, seed: number, loading?: LoadingStage): BufferGeometry {
  const random = rng(seed * 4093 + 11);
  const r = island.radius;
  const parts: Part[] = loading ? loadingStageParts(loading, island) : [];

  // Level top, with only its edge roughened.
  parts.push({ geometry: new CylinderGeometry(r, r * 0.96, 0.6, 16, 1), position: [0, -0.3, 0], color: (tri, c) => (c.y > -0.05 ? shade(GRASS, 0.95 + (tri % 3) * 0.03) : shade(GRASS, 0.72)) });
  const rockDepth = island.depth - 0.6;
  const rock = new ConeGeometry(r * 0.96, rockDepth, 16, 4);
  rock.rotateX(Math.PI);
  jitter(rock, r * 0.12, rng(seed * 4093 + 12));
  // Keep the roughened rock below the grass: its top corners jittered up
  // through the grass in brown wedges that flickered against it.
  const rockPos = rock.getAttribute('position');
  for (let i = 0; i < rockPos.count; i++) {
    rockPos.setY(i, Math.min(rockPos.getY(i), rockDepth / 2 - 0.05));
  }
  parts.push({
    geometry: rock,
    position: [0, -0.6 - rockDepth / 2, 0],
    color: (tri, c) => shade(ROCK, 1 - Math.min(0.45, (-c.y / island.depth) * 0.5) - (Math.floor(-c.y / 2.5) % 2) * 0.06 + (tri % 3) * 0.02),
  });

  // Plank pad, a painted ring and a centre spot.
  const pad = island.padRadius;
  parts.push({ geometry: new CylinderGeometry(pad, pad, 0.12, 20), position: [0, 0.06, 0], color: (tri) => (tri % 4 < 2 ? PLANK : PLANK_DARK) });
  parts.push({ geometry: new TorusGeometry(pad * 0.7, 0.12, 3, 24), position: [0, 0.13, 0], rotation: [Math.PI / 2, 0, 0], scale: [1, 1, 0.3], color: PAINT });
  parts.push({ geometry: new CylinderGeometry(0.5, 0.5, 0.03, 10), position: [0, 0.135, 0], color: PAINT });

  // Flag on a pole at the pad's edge, to the side of the way in.
  const fx = pad + 1.5;
  parts.push(beam([fx, 0, 0], [fx, 6, 0], 0.08, POLE, 5));
  parts.push({ geometry: new BoxGeometry(0.04, 1.1, 1.8), position: [fx, 5.35, 0.95], color: flagColor });

  // Trees round the rim, clear of the pad.
  const trees = 7;
  for (let i = 0; i < trees; i++) {
    const angle = (i / trees) * Math.PI * 2 + random() * 0.5;
    const dist = r * (0.62 + random() * 0.25);
    const size = 1.2 + random() * 1.2;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    parts.push({ geometry: new ConeGeometry(size, size * 3, 6), position: [x, size * 1.5 + size * 0.5, z], color: TREE[i % TREE.length] });
    parts.push({ geometry: new CylinderGeometry(size * 0.15, size * 0.2, size * 0.6, 4), position: [x, size * 0.3, z], color: POLE });
  }
  return mergeParts(parts);
}

/** A marker ring of `radius` (inner), standing upright facing ±Z, striped so it reads at a distance. */
export function createRingGeometry(radius: number): BufferGeometry {
  const tube = 0.6;
  const segments = 36;
  return mergeParts([
    {
      geometry: new TorusGeometry(radius + tube, tube, 6, segments),
      // Six stripes, alternating red and cream.
      color: (_tri, c) => (Math.floor(((Math.atan2(c.y, c.x) + Math.PI) / (Math.PI * 2)) * 12) % 2 === 0 ? 0xd8452f : 0xf4ead2),
    },
  ]);
}

/** Island B's beacon mast: a tall pole with a lamp on top, drawn unlit so it shows through the haze. */
export function createBeaconMastGeometry(height: number): BufferGeometry {
  return mergeParts([
    beam([0, 0, 0], [0, height, 0], 0.12, POLE, 5),
    { geometry: new CylinderGeometry(0.6, 0.8, 0.3, 6), position: [0, height, 0], color: 0x3a3f47 },
  ]);
}

/** The beacon's lamp, a bright ball. */
export function createBeaconLampGeometry(): BufferGeometry {
  return mergeParts([{ geometry: new IcosahedronGeometry(1.4, 1), color: 0xffb648 }]);
}

const IRON = 0x3a3f47;
const POST_RED = 0xc8402c;

/** The cargo stage under the jetty's end, in the jetty's own space (the post's foot at the origin, the jetty along +Z). */
export interface CargoStagePlace {
  x: number;
  /** Its planks' top, below the jetty (negative). */
  y: number;
  z: number;
  radius: number;
  depth: number;
}

/** Where `route`'s cargo stage is in its jetty's own space, and the jetty's length and turn (the jetty runs along +Z, turned by `turn` about Y). */
export function jettyPlacement(route: Route): { length: number; turn: number; stage: CargoStagePlace } {
  const dock = route.dock;
  const root = jettyRoot(route);
  const turn = Math.atan2(root.x - dock.x, root.z - dock.z);
  const sx = route.cargo.x - dock.x;
  const sz = route.cargo.z - dock.z;
  return {
    length: Math.hypot(root.x - dock.x, root.z - dock.z),
    turn,
    stage: {
      x: sx * Math.cos(turn) - sz * Math.sin(turn),
      y: route.cargo.y - dock.y,
      z: sx * Math.sin(turn) + sz * Math.cos(turn),
      radius: route.cargo.radius,
      depth: route.cargo.depth,
    },
  };
}

/**
 * Island B's jetty and mooring post (docking, Phase 3): the post at the
 * origin, standing `postHeight` on the jetty's end, and the jetty running
 * `length` towards +Z back to the island, on struts down to the rock. The
 * post is banded red and white so it reads from a distance, with an iron cap
 * for the grapple to bite under. With `stage`, the cargo stage too (Phase 3
 * cargo): a small floating rock below the jetty's end with a plank platform
 * on it, a target painted on it to set crates down on, a few crates already
 * delivered, and a rope ladder up to the jetty.
 */
export function createJettyGeometry(length: number, postHeight: number, stage?: CargoStagePlace): BufferGeometry {
  const parts: Part[] = stage ? cargoStageParts(stage) : [];
  const width = 1.6;
  // Planks across, on two stringers. They sit a little above the island's
  // grass where the jetty runs onto it (their tops level with it flickered).
  const planks = Math.round(length / 0.4);
  for (let i = 0; i < planks; i++) {
    const z = -0.3 + i * (length + 0.3) / planks;
    parts.push({ geometry: new BoxGeometry(width, 0.08, 0.36), position: [0, 0.06, z + 0.18], color: i % 3 === 0 ? PLANK_DARK : PLANK });
  }
  for (const x of [-width / 2 + 0.15, width / 2 - 0.15]) {
    parts.push({ geometry: new BoxGeometry(0.14, 0.2, length + 0.3), position: [x, -0.08, length / 2 - 0.15], color: PLANK_DARK });
    // Struts from under the jetty's outer half back down to the island's rock.
    parts.push(beam([x, -0.25, 0.2], [x * 0.6, -3.2, length + 2.5], 0.08, POLE, 5));
    parts.push(beam([x, -0.25, length * 0.45], [x * 0.6, -2.2, length + 1.6], 0.07, POLE, 5));
  }
  // The post, in red and white bands, with an iron cap and collar.
  const bands = 5;
  for (let i = 0; i < bands; i++) {
    const h = postHeight / bands;
    parts.push({ geometry: new CylinderGeometry(0.16, 0.17, h, 8), position: [0, h * (i + 0.5), 0], color: i % 2 === 0 ? POST_RED : PAINT });
  }
  parts.push({ geometry: new CylinderGeometry(0.24, 0.2, 0.12, 8), position: [0, postHeight + 0.06, 0], color: IRON });
  parts.push({ geometry: new CylinderGeometry(0.2, 0.2, 0.06, 8), position: [0, postHeight - 0.25, 0], color: IRON });
  return mergeParts(parts);
}

const CRATE = 0xc08a52;

/** The loading stage (route.loading, world space) in its island's own space: planks on two bearers on four legs standing on the pad. */
function loadingStageParts(stage: LoadingStage, island: LandingIsland): Part[] {
  const parts: Part[] = [];
  const x0 = stage.x0 - island.x;
  const x1 = stage.x1 - island.x;
  const z0 = stage.z0 - island.z;
  const z1 = stage.z1 - island.z;
  const top = stage.top - island.y;
  // The pad's planks' top.
  const pad = 0.12;
  const across = x1 - x0;
  const along = z1 - z0;
  const boards = 6;
  for (let i = 0; i < boards; i++) {
    const z = z0 + (along / boards) * (i + 0.5);
    parts.push({ geometry: new BoxGeometry(across, 0.06, along / boards - 0.02), position: [(x0 + x1) / 2, top - 0.03, z], color: i % 2 === 0 ? PLANK : PLANK_DARK });
  }
  for (const x of [x0 + 0.07, x1 - 0.07]) {
    parts.push({ geometry: new BoxGeometry(0.08, 0.1, along - 0.04), position: [x, top - 0.11, (z0 + z1) / 2], color: PLANK_DARK });
    for (const z of [z0 + 0.1, z1 - 0.1]) {
      parts.push(beam([x, pad, z], [x, top - 0.16, z], 0.05, POLE, 5));
    }
  }
  // A brace along each side, and a bumper rail along the outboard edge so the crates read as waiting for the ship.
  for (const x of [x0 + 0.07, x1 - 0.07]) {
    parts.push(beam([x, pad + 0.15, z0 + 0.1], [x, top - 0.2, z1 - 0.1], 0.025, POLE, 4));
  }
  parts.push({ geometry: new BoxGeometry(0.05, 0.08, along), position: [x1 - 0.025, top + 0.04, (z0 + z1) / 2], color: POST_RED });
  return parts;
}

function cargoStageParts(stage: CargoStagePlace): Part[] {
  const { x, y, z, radius } = stage;
  const parts: Part[] = [];
  // The rock: a jittered cone under a thin grass cap, like the scenery islands.
  const rockDepth = stage.depth - 0.3;
  const rock = new ConeGeometry(radius * 0.95, rockDepth, 10, 3);
  rock.rotateX(Math.PI);
  jitter(rock, radius * 0.1, rng(9311));
  const rockPos = rock.getAttribute('position');
  for (let i = 0; i < rockPos.count; i++) {
    rockPos.setY(i, Math.min(rockPos.getY(i), rockDepth / 2 - 0.05));
  }
  parts.push({ geometry: rock, position: [x, y - 0.3 - rockDepth / 2, z], color: (tri, c) => shade(ROCK, 0.95 - Math.min(0.4, (-(c.y - y) / stage.depth) * 0.45) + (tri % 3) * 0.02) });
  parts.push({ geometry: new CylinderGeometry(radius, radius * 0.95, 0.3, 12, 1), position: [x, y - 0.27, z], color: (tri) => shade(GRASS, 0.9 + (tri % 3) * 0.03) });
  // The plank platform, square, a little inside the rock's rim, and a target painted on it.
  const side = radius * 1.3;
  const planks = 9;
  for (let i = 0; i < planks; i++) {
    const px = x - side / 2 + (side / planks) * (i + 0.5);
    parts.push({ geometry: new BoxGeometry(side / planks - 0.03, 0.1, side), position: [px, y - 0.05, z], color: i % 3 === 0 ? PLANK_DARK : PLANK });
  }
  // The target (TARGET_RINGS): a red bullseye standing 1 cm proud of the planks, and a white ring round each of the others.
  const [bull, ...rings] = TARGET_RINGS;
  parts.push({ geometry: new CylinderGeometry(bull.radius, bull.radius, 0.01, 20), position: [x, y + 0.015, z], color: POST_RED });
  for (const ring of rings) {
    parts.push({ geometry: new TorusGeometry(ring.radius - 0.05, 0.05, 3, 32), position: [x, y + 0.005, z], rotation: [Math.PI / 2, 0, 0], scale: [1, 1, 0.1], color: PAINT });
  }
  // A few crates already delivered, stacked at the platform's island side.
  const stack: [number, number, number][] = [[-1.6, 0, 1.4], [-1.05, 0, 1.6], [-1.35, 0.4, 1.5]];
  for (const [cx, cy, cz] of stack) {
    parts.push({ geometry: new BoxGeometry(0.4, 0.36, 0.4), position: [x + cx, y + cy + 0.18, z + cz], color: (tri) => (tri % 4 < 2 ? CRATE : shade(CRATE, 0.85)) });
  }
  // A rope ladder from the platform up to the jetty's end beside the post.
  const lx = 0.55;
  const lz = -0.25;
  for (const dx of [-0.2, 0.2]) {
    parts.push(beam([lx + dx, y, lz], [lx + dx, 0.05, lz], 0.02, POLE, 4));
  }
  for (let ry = y + 0.35; ry < 0; ry += 0.35) {
    parts.push(beam([lx - 0.2, ry, lz], [lx + 0.2, ry, lz], 0.025, PLANK_DARK, 4));
  }
  return parts;
}
