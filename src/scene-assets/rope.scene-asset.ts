import {
  CanvasTexture,
  CylinderGeometry,
  Mesh,
  MeshLambertMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  TorusGeometry,
} from '@iwsdk/core';
import { beam, mergeParts, type Part } from './lowpoly.js';

/**
 * The mooring line for the hand-over-hand haul (spike S6, part 2). It comes
 * aboard through a brass fairlead at the bow end of the port rail and runs
 * along the inside of the rail towards the stern, where it drops to a coil
 * on the deck. Outboard it runs away towards the dock. Players stand on the
 * port side facing the rail and haul it towards the stern (+Z).
 *
 * The inboard run is one cylinder with a striped texture; sliding the
 * texture shows the line moving without moving any geometry.
 */

export const ROPE_X = -0.85;
export const ROPE_Y = 0.95;
/** The fairlead (z where `along` is 0) and the inboard end of the hauling run. */
export const ROPE_Z0 = -1.35;
export const ROPE_Z1 = 0.75;
export const ROPE_RUN = ROPE_Z1 - ROPE_Z0;
export const ROPE_RADIUS = 0.018;
/** A hand closer than this to the line can take hold. */
export const ROPE_REACH = 0.1;
/** Metres of line per stripe repeat on the texture. */
const STRIPE_METRES = 0.25;

const ROPE_COLOR = 0xd8c39a;
const BRASS = 0xc9a03a;

/** Distance from a ship-space point to the inboard run, and its position along it. */
export function nearestOnRope(x: number, y: number, z: number): { distance: number; along: number } {
  const along = Math.max(0, Math.min(ROPE_RUN, z - ROPE_Z0));
  const dz = z - (ROPE_Z0 + along);
  return { distance: Math.hypot(x - ROPE_X, y - ROPE_Y, dz), along };
}

export interface RopeMeshes {
  /** The inboard run; move its texture with `setRopeHauled`. */
  run: Mesh;
  /** Fairlead, coil and the outboard line (static). */
  fittings: Mesh;
  texture: CanvasTexture;
}

export function createRope(): RopeMeshes {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#d8c39a';
  ctx.fillRect(0, 0, 8, 64);
  // Twisted-rope look: dark diagonal bands, plus one red marker band per repeat.
  ctx.fillStyle = '#a8946a';
  for (let y = 0; y < 64; y += 8) {
    ctx.fillRect(0, y, 8, 3);
  }
  ctx.fillStyle = '#b8453a';
  ctx.fillRect(0, 0, 8, 6);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(1, ROPE_RUN / STRIPE_METRES);

  const run = new Mesh(
    new CylinderGeometry(ROPE_RADIUS, ROPE_RADIUS, ROPE_RUN, 8, 1, true),
    new MeshLambertMaterial({ map: texture }),
  );
  run.rotation.x = Math.PI / 2; // cylinder axis along Z
  run.position.set(ROPE_X, ROPE_Y, (ROPE_Z0 + ROPE_Z1) / 2);
  run.name = 'Mooring Line';

  // Outboard: from the fairlead out over the bow towards the dock, sagging down.
  const outboard = [
    [ROPE_X, ROPE_Y, ROPE_Z0],
    [ROPE_X - 0.5, ROPE_Y - 0.15, ROPE_Z0 - 0.9],
    [ROPE_X - 1.3, ROPE_Y - 0.7, ROPE_Z0 - 2.4],
    [ROPE_X - 2.6, ROPE_Y - 1.9, ROPE_Z0 - 4.6],
  ] as const;
  const parts: Part[] = [];
  for (let i = 0; i < outboard.length - 1; i++) {
    parts.push(beam(outboard[i], outboard[i + 1], ROPE_RADIUS, ROPE_COLOR, 6));
  }
  parts.push(
    // Fairlead ring on the rail.
    { geometry: new TorusGeometry(0.04, 0.012, 6, 12), color: BRASS, position: [ROPE_X, ROPE_Y, ROPE_Z0] as [number, number, number] },
    // Line dropping from the end of the run to a coil on the deck.
    {
      geometry: new CylinderGeometry(ROPE_RADIUS, ROPE_RADIUS, ROPE_Y - 0.06, 6, 1, true),
      color: ROPE_COLOR,
      position: [ROPE_X, ROPE_Y / 2 + 0.03, ROPE_Z1] as [number, number, number],
    },
    { geometry: new TorusGeometry(0.12, 0.025, 6, 14), color: ROPE_COLOR, position: [ROPE_X + 0.05, 0.03, ROPE_Z1 + 0.12] as [number, number, number], rotation: [Math.PI / 2, 0, 0] as [number, number, number] },
    { geometry: new TorusGeometry(0.09, 0.025, 6, 14), color: ROPE_COLOR, position: [ROPE_X + 0.05, 0.07, ROPE_Z1 + 0.12] as [number, number, number], rotation: [Math.PI / 2, 0, 0] as [number, number, number] },
  );
  const fittings = new Mesh(mergeParts(parts), new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  fittings.name = 'Mooring Line Fittings';
  return { run, fittings, texture };
}

/** Slide the stripes so the line appears to have moved `hauled` metres inboard. */
export function setRopeHauled(texture: CanvasTexture, hauled: number): void {
  texture.offset.y = -hauled / STRIPE_METRES;
}
