import { BoxGeometry, type BufferGeometry, ConeGeometry, CylinderGeometry, IcosahedronGeometry, TorusGeometry } from '@iwsdk/core';
import { beam, jitter, mergeParts, type Part, rng, shade } from '../scene-assets/lowpoly.js';
import type { LandingIsland } from '../sim/route.js';

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
 */
export function createLandingIslandGeometry(island: LandingIsland, flagColor: number, seed: number): BufferGeometry {
  const random = rng(seed * 4093 + 11);
  const r = island.radius;
  const parts: Part[] = [];

  // Level top, with only its edge roughened.
  parts.push({ geometry: new CylinderGeometry(r, r * 0.96, 0.6, 16, 1), position: [0, -0.3, 0], color: (tri, c) => (c.y > -0.05 ? shade(GRASS, 0.95 + (tri % 3) * 0.03) : shade(GRASS, 0.72)) });
  const rockDepth = island.depth - 0.6;
  const rock = new ConeGeometry(r * 0.96, rockDepth, 16, 4);
  rock.rotateX(Math.PI);
  jitter(rock, r * 0.12, rng(seed * 4093 + 12));
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
