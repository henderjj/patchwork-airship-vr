import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  SphereGeometry,
} from '@iwsdk/core';
import { jitter, mergeParts, type Part, pick, rng, shade } from '../scene-assets/lowpoly.js';

/**
 * Procedural low-poly sky content: floating islands (two levels of detail),
 * chunky clouds and a gradient sky dome. All unit-sized; instances scale them.
 */

const GRASS = [0x7fb35a, 0x8cbf63, 0x6fa552, 0x9cc46b];
const ROCK = [0x9a8270, 0x8a7563, 0xa58f7a, 0x7d6b5c];
const TREE = [0x3f7d4a, 0x4b8c4f, 0x356b45];
const TRUNK = 0x6b4a32;
const ROOF = [0xb5523b, 0x3e6f8e, 0xc78b3a];
const WALL = 0xeee1c6;

/** One island shape at two levels of detail. Unit radius, top surface at y = 0. */
export interface IslandVariant {
  high: BufferGeometry;
  low: BufferGeometry;
}

export function createIslandVariant(seed: number): IslandVariant {
  return {
    high: islandGeometry(seed, true),
    low: islandGeometry(seed, false),
  };
}

function islandGeometry(seed: number, high: boolean): BufferGeometry {
  const random = rng(seed * 7919 + 13);
  const radial = high ? 11 : 6;
  const grassTone = pick(GRASS, random);
  const rockTone = pick(ROCK, random);
  const depth = 1.1 + random() * 0.9;

  const parts: Part[] = [];
  const cap = new CylinderGeometry(1, 0.96, 0.18, radial, 1);
  jitter(cap, high ? 0.12 : 0.06, rng(seed));
  parts.push({
    geometry: cap,
    position: [0, -0.09, 0],
    color: (tri, c) => (c.y > -0.05 ? shade(grassTone, 0.94 + (tri % 4) * 0.03) : shade(grassTone, 0.75)),
  });

  const under = new ConeGeometry(0.96, depth, radial, high ? 4 : 1);
  under.rotateX(Math.PI);
  jitter(under, high ? 0.22 : 0.1, rng(seed + 1));
  parts.push({
    geometry: under,
    position: [0, -0.18 - depth / 2, 0],
    // Strata bands, darker with depth.
    color: (tri, c) => {
      const band = Math.floor(-c.y * 4) % 2;
      return shade(rockTone, 1 - Math.min(0.45, -c.y * 0.22) - band * 0.06 + (tri % 3) * 0.02);
    },
  });

  const trees = high ? 3 + Math.floor(random() * 5) : 2;
  for (let i = 0; i < trees; i++) {
    const angle = random() * Math.PI * 2;
    const dist = 0.15 + random() * 0.65;
    const x = Math.cos(angle) * dist;
    const z = Math.sin(angle) * dist;
    const size = 0.08 + random() * 0.1;
    parts.push({
      geometry: new ConeGeometry(size, size * 3, high ? 6 : 4),
      position: [x, size * 1.5 + size * 0.6, z],
      color: pick(TREE, random),
    });
    if (high) {
      parts.push({
        geometry: new CylinderGeometry(size * 0.18, size * 0.22, size * 0.7, 4),
        position: [x, size * 0.35, z],
        color: TRUNK,
      });
    }
  }

  // Some islands carry a small cottage, the courier's destinations.
  if (random() < 0.4) {
    const x = (random() - 0.5) * 0.6;
    const z = (random() - 0.5) * 0.6;
    const roof = new ConeGeometry(0.16, 0.12, 4);
    roof.rotateY(Math.PI / 4);
    parts.push({ geometry: new CylinderGeometry(0.1, 0.1, 0.12, 4), position: [x, 0.06, z], rotation: [0, Math.PI / 4, 0], color: WALL });
    parts.push({ geometry: roof, position: [x, 0.18, z], color: pick(ROOF, random) });
  }

  return mergeParts(parts);
}

/** A cloud cluster of a few lumpy blobs. Unit size, white tops, bluish bellies. */
export function createCloudGeometry(seed: number): BufferGeometry {
  const random = rng(seed * 104729 + 7);
  const parts: Part[] = [];
  const blobs = 4 + Math.floor(random() * 3);
  for (let i = 0; i < blobs; i++) {
    const r = 0.3 + random() * 0.35;
    const g = new IcosahedronGeometry(r, 1);
    jitter(g, r * 0.25, rng(seed * 31 + i));
    parts.push({
      geometry: g,
      position: [(random() - 0.5) * 1.6, (random() - 0.3) * 0.35, (random() - 0.5) * 0.8],
      scale: [1, 0.7, 1],
      color: (_tri, c) => (c.y > 0.05 ? 0xffffff : c.y > -0.15 ? 0xeef2f7 : 0xd5dde8),
    });
  }
  return mergeParts(parts);
}

export const SKY_TOP = new Color(0x3d7fc0);
export const SKY_HORIZON = new Color(0xf4e6cc);
export const SKY_BELOW = new Color(0xa9c3d8);

/** Sky dome with a vertical gradient baked into vertex colours. */
export function createSkyDomeGeometry(radius: number): BufferGeometry {
  const g = new SphereGeometry(radius, 24, 16);
  const pos = g.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c = new Color();
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / radius;
    if (t >= 0) {
      c.copy(SKY_HORIZON).lerp(SKY_TOP, Math.pow(t, 0.55));
    } else {
      c.copy(SKY_HORIZON).lerp(SKY_BELOW, Math.min(1, Math.pow(-t, 0.4)));
    }
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new BufferAttribute(colors, 3));
  return g;
}

export const SKY_DOME_SIDE = BackSide;
