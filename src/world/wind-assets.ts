import { BufferAttribute, BufferGeometry, CylinderGeometry, TorusGeometry } from '@iwsdk/core';
import { beam, mergeParts } from '../scene-assets/lowpoly.js';

/**
 * The wind's pieces in the sky (Phase 3, docs/wind.md): streaks of moving
 * air for drafts and gusts, and wind socks on the landing islands. Sizes in
 * metres.
 */

const POLE = 0x6b4a32;
const SOCK_RED = 0xd8452f;
const SOCK_WHITE = 0xf4ead2;
const BRASS = 0xb08a3e;

/** A wind sock's length, m, from its hoop to its tail. */
export const SOCK_LENGTH = 1.8;
/** The wind sock's pole height, m (the hoop's swivel at the top). */
export const SOCK_POLE = 4.5;

/**
 * A streak of moving air: two crossed quads along the streak (so it shows
 * from any side), `length` long and `width` wide, centred on the origin,
 * along +Y (`vertical`) or +X. Its colour fades to nothing at both ends
 * (vertex alpha), for a transparent material with `vertexColors`.
 */
export function createStreakGeometry(length: number, width: number, color: number, vertical: boolean): BufferGeometry {
  const r = ((color >> 16) & 255) / 255;
  const g = ((color >> 8) & 255) / 255;
  const b = (color & 255) / 255;
  // Along the streak: faded end, solid middle, faded end.
  const stations = [
    [-0.5, 0],
    [-0.2, 1],
    [0.2, 1],
    [0.5, 0],
  ] as const;
  const positions: number[] = [];
  const colors: number[] = [];
  const corner = (along: number, across: number, flat: boolean, alpha: number) => {
    const a = along * length;
    const c = across * width;
    // Vertical: along Y, across X or Z. Horizontal: along X, across Y or Z.
    if (vertical) positions.push(flat ? c : 0, a, flat ? 0 : c);
    else positions.push(a, flat ? 0 : c, flat ? c : 0);
    colors.push(r, g, b, alpha);
  };
  for (const flat of [true, false]) {
    for (let i = 0; i < stations.length - 1; i++) {
      const [a0, f0] = stations[i];
      const [a1, f1] = stations[i + 1];
      corner(a0, -0.5, flat, f0);
      corner(a1, -0.5, flat, f1);
      corner(a1, 0.5, flat, f1);
      corner(a0, -0.5, flat, f0);
      corner(a1, 0.5, flat, f1);
      corner(a0, 0.5, flat, f0);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 4));
  geometry.computeBoundingSphere();
  return geometry;
}

/** A wind sock's pole: a wooden post with an iron swivel and a brass hoop bracket at the top (origin at its foot). */
export function createWindSockPoleGeometry(): BufferGeometry {
  return mergeParts([
    beam([0, 0, 0], [0, SOCK_POLE - 0.05, 0], 0.07, POLE, 6),
    // The swivel the sock turns on, its foot sunk into the post's top.
    { geometry: new CylinderGeometry(0.09, 0.09, 0.2, 8), position: [0, SOCK_POLE - 0.02, 0], color: 0x3a3f47 },
  ]);
}

/** Where the sock's mouth is, out from its swivel along +X, m. */
const SOCK_MOUTH_X = 0.55;

/**
 * The sock itself, turning on its swivel at the origin: a brass hoop on
 * two arms and a tapering cloth tube along +X, banded red and white so it
 * reads from the deck. Drawn double-sided so the open mouth doesn't show
 * through. Droop it no more than 40° or the hoop meets the pole.
 */
export function createWindSockGeometry(): BufferGeometry {
  const mouth = 0.3;
  const tail = 0.12;
  // Its wide end (the cylinder's bottom) ends up at the mouth.
  const cloth = new CylinderGeometry(tail, mouth, SOCK_LENGTH, 10, 5, true);
  return mergeParts([
    {
      geometry: cloth,
      position: [SOCK_MOUTH_X + SOCK_LENGTH / 2, 0, 0],
      // Its axis along +X, the mouth at the hoop.
      rotation: [0, 0, -Math.PI / 2],
      // Five bands, red at the mouth.
      color: (_tri, c) => (Math.floor(((c.x - SOCK_MOUTH_X) / SOCK_LENGTH) * 5) % 2 === 0 ? SOCK_RED : SOCK_WHITE),
    },
    // The hoop round the mouth, a little outside the cloth.
    { geometry: new TorusGeometry(mouth + 0.025, 0.02, 4, 12), position: [SOCK_MOUTH_X, 0, 0], rotation: [0, Math.PI / 2, 0], color: BRASS },
    // The arms from the swivel to the hoop's top and bottom.
    beam([0, 0, 0], [SOCK_MOUTH_X, mouth + 0.025, 0], 0.015, BRASS, 4),
    beam([0, 0, 0], [SOCK_MOUTH_X, -mouth - 0.025, 0], 0.015, BRASS, 4),
  ]);
}

/** Most the sock droops in still air, radians (more and its hoop meets the pole). */
export const SOCK_MAX_DROOP = (40 * Math.PI) / 180;
