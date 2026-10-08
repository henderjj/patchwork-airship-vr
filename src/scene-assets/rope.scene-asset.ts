import {
  CanvasTexture,
  CylinderGeometry,
  Mesh,
  MeshLambertMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  TorusGeometry,
} from '@iwsdk/core';
import { beam, mergeParts, type Part, shade } from './lowpoly.js';

/**
 * The mooring line for the hand-over-hand haul (spike S6, part 2). It comes
 * aboard over the port rail at the bow, through a brass fairlead, and runs
 * along the inside of the rail towards the stern, where it drops to a coil
 * on the deck. Outboard, the line still out hangs over the side; hauling
 * shortens it. (Throwing it to a dock post comes with docking, Phase 3.)
 * Players stand on the port side facing the rail and haul it towards the
 * stern (+Z).
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
/**
 * The coil's centre on the deck (x, z), clear of the fuel crate's locker. Its
 * turns step inwards as they stack, and the line from the end of the run
 * comes down onto the edge of the top turn.
 */
const COIL = [ROPE_X + 0.04, ROPE_Z1 - 0.044] as const;
const COIL_TURNS = [0.13, 0.11, 0.085] as const;
/** Each turn sits this much higher, and its centre steps this far towards the line's drop. */
const COIL_RISE = 0.03;
const COIL_STEP = [0.01, -0.008] as const;
/** Height of the top turn, where the dropping line meets the coil. */
const COIL_TOP = 0.02 + (COIL_TURNS.length - 1) * COIL_RISE;
/** Where the outboard line goes over the rail top and hangs down from. */
export const ROPE_OVERSIDE = [-1.04, 1.04, ROPE_Z0] as const;

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
  /** Fairlead, the line over the rail, and the coil (static). */
  fittings: Mesh;
  /** The line hanging over the side: 1 m long down from its origin; scale Y to its length and turn it to the felt gravity. */
  overside: Mesh;
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

  const [ox, oy, oz] = ROPE_OVERSIDE;
  const flat: [number, number, number] = [Math.PI / 2, 0, 0];
  const parts: Part[] = [
    // From the fairlead up over the rail top to where the line hangs down.
    beam([ROPE_X, ROPE_Y, ROPE_Z0], [ox + 0.06, oy + 0.01, oz], ROPE_RADIUS, ROPE_COLOR, 6),
    beam([ox + 0.06, oy + 0.01, oz], [ox, oy, oz], ROPE_RADIUS, ROPE_COLOR, 6),
    // Fairlead ring on the rail.
    { geometry: new TorusGeometry(0.04, 0.012, 6, 12), color: BRASS, position: [ROPE_X, ROPE_Y, ROPE_Z0] },
    // Line dropping from the end of the run onto the top turn of the coil.
    {
      geometry: new CylinderGeometry(ROPE_RADIUS, ROPE_RADIUS, ROPE_Y - COIL_TOP, 6, 1, true),
      color: ROPE_COLOR,
      position: [ROPE_X, (ROPE_Y + COIL_TOP) / 2, ROPE_Z1],
    },
    // Three loose turns of the coil, a shade darker than the run so they read as rope on the planks.
    ...COIL_TURNS.map((r, i): Part => ({
      geometry: new TorusGeometry(r, 0.02, 5, 14),
      color: shade(ROPE_COLOR, 0.82 - i * 0.04),
      position: [COIL[0] + i * COIL_STEP[0], 0.02 + i * COIL_RISE, COIL[1] + i * COIL_STEP[1]],
      rotation: flat,
    })),
  ];
  const fittings = new Mesh(mergeParts(parts), new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  fittings.name = 'Mooring Line Fittings';

  const overside = new Mesh(
    mergeParts([{ geometry: new CylinderGeometry(ROPE_RADIUS, ROPE_RADIUS, 1, 6, 1, true), color: ROPE_COLOR, position: [0, -0.5, 0] }]),
    new MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  );
  overside.position.set(ox, oy, oz);
  overside.name = 'Mooring Line Overside';
  return { run, fittings, overside, texture };
}


/** Slide the stripes so the line appears to have moved `hauled` metres inboard. */
export function setRopeHauled(texture: CanvasTexture, hauled: number): void {
  texture.offset.y = -hauled / STRIPE_METRES;
}
