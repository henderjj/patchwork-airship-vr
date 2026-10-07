import { BoxGeometry, CylinderGeometry, Mesh, MeshLambertMaterial } from '@iwsdk/core';
import { HANDLE_OFFSETS } from '../sim/crank.js';
import { CRANK_AXLE_HEIGHT, CRANK_POSITION } from './gondola.scene-asset.js';
import { mergeParts, type Part, shade } from './lowpoly.js';

/**
 * The rotating part of the two-person propeller crank (spike S6): an axle
 * across the pedestal with an arm and handle at each end, half a turn apart.
 * Players stand side by side behind it facing the bow; the left player takes
 * handle 0 and the right player handle 1.
 *
 * Angle convention (shared with src/sim/crank.ts): angle 0 points a handle
 * straight up, and positive angles turn its top towards the bow (-Z), which
 * drives the ship forward. The mesh's origin is the axle centre, so setting
 * `rotation.x = -angle` turns it.
 */

export const CRANK_CENTER = [CRANK_POSITION[0], CRANK_AXLE_HEIGHT, CRANK_POSITION[2]] as const;
export const CRANK_RADIUS = 0.22;
/** Handles sit on the axle's ends, the left one at -X. */
export const HANDLE_X = [-0.42, 0.42] as const;
/** Grip reach: a hand closer than this to a handle can take it. */
export const HANDLE_REACH = 0.12;

const IRON = 0x3a3f47;
const BRASS = 0xc9a03a;
const WOOD = 0x8a5a32;

/** Angle of a ship-space point around the crank axle, same convention as the crank. */
export function angleAroundAxle(y: number, z: number): number {
  return Math.atan2(-(z - CRANK_CENTER[2]), y - CRANK_CENTER[1]);
}

/** Ship-space position of handle `i` when the crank is at `angle`. */
export function handlePosition(i: number, angle: number, out: { x: number; y: number; z: number }): void {
  const a = angle + HANDLE_OFFSETS[i];
  out.x = CRANK_CENTER[0] + HANDLE_X[i];
  out.y = CRANK_CENTER[1] + CRANK_RADIUS * Math.cos(a);
  out.z = CRANK_CENTER[2] - CRANK_RADIUS * Math.sin(a);
}

export function createCrank(): Mesh {
  const parts: Part[] = [
    // Axle along X, with brass collars where it passes the pedestal.
    { geometry: new CylinderGeometry(0.025, 0.025, 0.76, 8), color: IRON, rotation: [0, 0, Math.PI / 2] },
    { geometry: new CylinderGeometry(0.045, 0.045, 0.05, 8), color: BRASS, position: [-0.1, 0, 0], rotation: [0, 0, Math.PI / 2] },
    { geometry: new CylinderGeometry(0.045, 0.045, 0.05, 8), color: BRASS, position: [0.1, 0, 0], rotation: [0, 0, Math.PI / 2] },
  ];
  for (let i = 0; i < 2; i++) {
    const a = HANDLE_OFFSETS[i];
    const armX = HANDLE_X[i] + (i === 0 ? 0.05 : -0.05);
    const y = Math.cos(a);
    const z = -Math.sin(a);
    // Arm from the axle out to the handle.
    parts.push({
      geometry: new BoxGeometry(0.03, CRANK_RADIUS + 0.04, 0.05),
      color: IRON,
      position: [armX, (y * CRANK_RADIUS) / 2, (z * CRANK_RADIUS) / 2],
      rotation: [-a, 0, 0],
    });
    // Wooden handle pointing outwards along X.
    parts.push({
      geometry: new CylinderGeometry(0.022, 0.022, 0.12, 8),
      color: WOOD,
      position: [HANDLE_X[i], y * CRANK_RADIUS, z * CRANK_RADIUS],
      rotation: [0, 0, Math.PI / 2],
    });
  }
  const mesh = new Mesh(mergeParts(parts), new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.name = 'Crank';
  return mesh;
}

/** The propeller turns this many times for each turn of the crank. */
export const PROPELLER_GEAR = 3;
const PROPELLER_RADIUS = 0.42;

/**
 * The propeller on the drive shaft out past the bow: three wooden blades,
 * each a little twisted, on a brass hub. Origin at the hub; it turns about Z
 * (`rotation.z`), driven by the crank through the gearbox on the pedestal.
 */
export function createPropeller(): Mesh {
  const parts: Part[] = [
    { geometry: new CylinderGeometry(0.06, 0.07, 0.1, 8), color: BRASS, rotation: [Math.PI / 2, 0, 0] },
    { geometry: new CylinderGeometry(0.0, 0.06, 0.08, 8), color: shade(BRASS, 0.85), position: [0, 0, -0.09], rotation: [-Math.PI / 2, 0, 0] },
  ];
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3;
    const mid = 0.05 + PROPELLER_RADIUS / 2;
    // Blade: wide in the middle, pitched 25° to the shaft; a painted tip so the turning reads.
    parts.push({
      geometry: new BoxGeometry(0.1, PROPELLER_RADIUS - 0.08, 0.02),
      color: WOOD,
      position: [Math.sin(a) * mid, Math.cos(a) * mid, 0],
      rotation: [0, 0.44, -a],
    });
    parts.push({
      geometry: new BoxGeometry(0.09, 0.08, 0.022),
      color: i === 0 ? 0xc4553f : 0xe8dcc0,
      position: [Math.sin(a) * (PROPELLER_RADIUS - 0.04), Math.cos(a) * (PROPELLER_RADIUS - 0.04), 0],
      rotation: [0, 0.44, -a],
    });
  }
  const mesh = new Mesh(mergeParts(parts), new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.name = 'Propeller';
  return mesh;
}
