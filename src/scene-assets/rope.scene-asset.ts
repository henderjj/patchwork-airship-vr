import {
  CanvasTexture,
  CylinderGeometry,
  Euler,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  RepeatWrapping,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { FAIRLEAD } from '../sim/docking.js';
import { DECK_WIDTH } from '../sim/gondola-layout.js';
import { RAIL_HEIGHT } from './gondola.scene-asset.js';
import { beam, mergeParts, type Part, shade } from './lowpoly.js';

/**
 * The mooring line for the hand-over-hand haul (spike S6, part 2). It comes
 * aboard over the port rail at the bow, through a brass fairlead, and runs
 * along the inside of the rail towards the stern, where it drops to a coil
 * on the deck. Wherever it bends it runs through a brass ring. Its outboard
 * end carries a small iron grapple, which hangs
 * on a hook on the bow rail beside the fairlead until it is thrown at a
 * mooring post (docking, Phase 3). Outboard, the line out hangs over the
 * side or runs to the grapple; hauling shortens it. Players stand on the
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
/** The inside face of the port rail's top bar. */
const RAIL_INSIDE = -DECK_WIDTH / 2 + 0.07;
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
/** Where the outboard line leaves the ship and hangs down from (the docking fairlead, above the rail). */
export const ROPE_OVERSIDE = FAIRLEAD;
/** The haul call's lamp (RopeSystem lights it): its radius, and its centre, sat in a brass cup on the port rail top halfway along the run, in front of the hauling crew. */
export const HAUL_LAMP_RADIUS = 0.022;
const LAMP_CUP_HEIGHT = 0.012;
export const HAUL_LAMP = [-DECK_WIDTH / 2 + 0.03, RAIL_HEIGHT + 0.03 + LAMP_CUP_HEIGHT + HAUL_LAMP_RADIUS * 0.6, ROPE_Z0 + ROPE_RUN * 0.55] as const;
/** Where the grapple's eye hangs on its hook, on the inside of the bow rail by the fairlead. */
export const GRAPPLE_HOOK = [-0.66, 0.93, -1.41] as const;
/** The grapple is held by its shank this far below its eye, m... */
export const GRAPPLE_GRIP = 0.12;
/** ...and taken by a hand within this of that point, m. */
export const GRAPPLE_REACH = 0.15;
/** The grapple's shank, from its eye to the prongs' crown, m. */
const SHANK = 0.32;

const ROPE_COLOR = 0xd8c39a;
const BRASS = 0xc9a03a;
const IRON = 0x4c525c;

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

const ringTurn = new Quaternion();
const ringRim = new Vector3();
const ringAxis = new Vector3();

/**
 * A brass ring where the line bends, centred on the bend and square to the
 * mean of the line's directions in and out of it, so the line goes through
 * its middle; plus a brass stay from its rim to a mount on the rail.
 */
function bendRing(at: Vector3, comingIn: Vector3, goingOut: Vector3, radius: number, mount: Vector3): Part[] {
  ringAxis.addVectors(comingIn, goingOut).normalize();
  ringTurn.setFromUnitVectors(new Vector3(0, 0, 1), ringAxis);
  const [rx, ry, rz] = new Euler().setFromQuaternion(ringTurn).toArray() as [number, number, number];
  // The stay leaves the rim at the point nearest the mount.
  ringRim.subVectors(mount, at);
  ringRim.addScaledVector(ringAxis, -ringRim.dot(ringAxis)).setLength(radius).add(at);
  return [
    { geometry: new TorusGeometry(radius, 0.011, 6, 14), color: BRASS, position: at.toArray(), rotation: [rx, ry, rz] },
    beam(ringRim.toArray(), mount.toArray(), 0.01, BRASS, 5),
  ];
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

  const flat: [number, number, number] = [Math.PI / 2, 0, 0];
  const bowEnd = new Vector3(ROPE_X, ROPE_Y, ROPE_Z0);
  const sternEnd = new Vector3(ROPE_X, ROPE_Y, ROPE_Z1);
  const fairlead = new Vector3(...ROPE_OVERSIDE);
  const up = new Vector3().subVectors(fairlead, bowEnd).normalize();
  const parts: Part[] = [
    // From the bow end of the run up over the rail to the fairlead, where the line leaves the ship.
    beam(bowEnd.toArray(), fairlead.toArray(), ROPE_RADIUS, ROPE_COLOR, 6),
    // A brass ring at each bend, centred on it. The line from the fairlead
    // runs out level to a moored post or hangs down overside, so that ring
    // faces between the two.
    ...bendRing(bowEnd, new Vector3(0, 0, -1), up, 0.045, new Vector3(RAIL_INSIDE - 0.01, RAIL_HEIGHT - 0.01, ROPE_Z0)),
    ...bendRing(fairlead, up, new Vector3(-1, -0.6, 0).normalize(), 0.05, new Vector3(fairlead.x + 0.045, RAIL_HEIGHT + 0.03, ROPE_Z0)),
    ...bendRing(sternEnd, new Vector3(0, 0, 1), new Vector3(0, -1, 0), 0.045, new Vector3(RAIL_INSIDE - 0.01, RAIL_HEIGHT - 0.01, ROPE_Z1)),
    // The rope's pieces are open tubes, so each bend gets a ball a touch
    // thicker than the rope to close the corner; without it the open ends
    // show through on the outside of the bend.
    ...[bowEnd, fairlead, sternEnd].map((at): Part => ({ geometry: new SphereGeometry(ROPE_RADIUS * 1.08, 8, 6), color: ROPE_COLOR, position: at.toArray() })),
    // The haul lamp's cup on the rail top.
    {
      geometry: new CylinderGeometry(HAUL_LAMP_RADIUS * 1.1, HAUL_LAMP_RADIUS * 0.8, LAMP_CUP_HEIGHT, 10),
      color: BRASS,
      position: [HAUL_LAMP[0], RAIL_HEIGHT + 0.03 + LAMP_CUP_HEIGHT / 2, HAUL_LAMP[2]],
    },
    // The grapple's hook: an iron peg out of the bow rail's inside face, turned up at its end.
    beam([GRAPPLE_HOOK[0], GRAPPLE_HOOK[1] + 0.012, GRAPPLE_HOOK[2] - 0.05], [GRAPPLE_HOOK[0], GRAPPLE_HOOK[1] + 0.012, GRAPPLE_HOOK[2] + 0.02], 0.008, IRON, 5),
    beam([GRAPPLE_HOOK[0], GRAPPLE_HOOK[1] + 0.008, GRAPPLE_HOOK[2] + 0.02], [GRAPPLE_HOOK[0], GRAPPLE_HOOK[1] + 0.04, GRAPPLE_HOOK[2] + 0.025], 0.007, IRON, 5),
    // The line dropping from the stern end of the run onto the top turn of the coil.
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
  overside.position.set(...ROPE_OVERSIDE);
  overside.name = 'Mooring Line Overside';
  return { run, fittings, overside, texture };
}

/**
 * The grapple on the line's outboard end: an eye at the origin, an iron
 * shank down -Y and four prongs curving back up from its crown, about 25 cm
 * across. Held by the shank (`GRAPPLE_GRIP` below the eye); its line ties
 * to the eye.
 */
export function createGrapple(): Mesh {
  const parts: Part[] = [
    { geometry: new TorusGeometry(0.028, 0.008, 4, 10), color: IRON, position: [0, 0, 0] },
    beam([0, -0.02, 0], [0, -SHANK, 0], 0.013, IRON, 6),
    // A band of the line's colour where it is held, so it reads as the handle.
    beam([0, -GRAPPLE_GRIP + 0.05, 0], [0, -GRAPPLE_GRIP - 0.05, 0], 0.017, shade(ROPE_COLOR, 0.8), 6),
  ];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const elbow: [number, number, number] = [0.09 * c, -SHANK - 0.02, 0.09 * s];
    const tip: [number, number, number] = [0.12 * c, -SHANK + 0.09, 0.12 * s];
    parts.push(beam([0, -SHANK, 0], elbow, 0.011, IRON, 5));
    parts.push(beam(elbow, tip, 0.009, IRON, 5));
  }
  const mesh = new Mesh(mergeParts(parts), new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.name = 'Grapple';
  return mesh;
}

/** A straight length of line 1 m long up +Y from its origin: point it from one end to the other and scale Y to the length. */
export function createLineSpan(): Mesh {
  const mesh = new Mesh(
    mergeParts([{ geometry: new CylinderGeometry(ROPE_RADIUS, ROPE_RADIUS, 1, 6, 1, true), color: ROPE_COLOR, position: [0, 0.5, 0] }]),
    new MeshLambertMaterial({ vertexColors: true, flatShading: true }),
  );
  mesh.name = 'Mooring Line Out';
  // It reaches tens of metres out to the post; its bounds would need refitting each frame.
  mesh.frustumCulled = false;
  return mesh;
}

/** Slide the stripes so the line appears to have moved `hauled` metres inboard. */
export function setRopeHauled(texture: CanvasTexture, hauled: number): void {
  texture.offset.y = -hauled / STRIPE_METRES;
}
