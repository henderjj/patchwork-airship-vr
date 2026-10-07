import {
  type BufferGeometry,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  TorusGeometry,
} from '@iwsdk/core';
import { beam, mergeParts, type Part, shade } from './lowpoly.js';

/**
 * Stylised crew avatar: an aviator in a leather flying cap and goggles, a
 * long coat in the crew colour, a scarf, gloves and boots. Real-world
 * proportions for a 1.75 m adult, kept low-poly and flat-shaded: about 900
 * triangles in all.
 *
 * The networked avatar (spike S4) is split into parts that move separately,
 * each one draw call: the head follows the remote headset; the torso hangs
 * below it and turns only with its heading; the legs stand on the deck below
 * the torso and stretch to the head's height; each glove follows a
 * controller's grip pose. The stress-test dummy merges the same parts into
 * one mesh.
 */

export const CREW_COLORS = [0x2f6db3, 0xc0563a, 0x3f8f5a, 0x8a4fb0, 0xd19a2a, 0x2a9a9a, 0x9a3a5a, 0x5a5a5a];
/** Names for the coat colours, for the crew panel. */
export const CREW_COLOR_NAMES = ['Blue', 'Brick', 'Green', 'Plum', 'Mustard', 'Teal', 'Wine', 'Slate'];
const SKIN = 0xe0b48f;
const LEATHER = 0x6a4a30;
const GLASS = 0x9fd3e8;
const BRASS = 0xc9a03a;
const SCARF = 0xe8dcc0;
const TROUSERS = 0x4a3f36;
const BOOTS = 0x2e2119;

/** Standing eye height the dummy is built for, m. */
const EYE_HEIGHT = 1.62;
/** Height of the top of the legs at that eye height; the legs mesh is built this long, m. */
export const LEG_LENGTH = 0.8;
/** How far the top of the legs is below the eyes, m. */
export const HIP_BELOW_EYES = EYE_HEIGHT - LEG_LENGTH;
/** The body's centre line is this far behind the eyes, m. */
const BODY_BACK = 0.09;

/** Head parts, with the origin at the eye centre and the face towards -Z. */
function headParts(): Part[] {
  return [
    // Skull, a little narrower than it is deep, and a smaller jaw below it.
    { geometry: new IcosahedronGeometry(0.1, 1), color: SKIN, position: [0, 0.03, 0.065], scale: [0.85, 1, 0.95] },
    { geometry: new IcosahedronGeometry(0.07, 1), color: SKIN, position: [0, -0.055, 0.035], scale: [0.95, 0.8, 1] },
    { geometry: new ConeGeometry(0.014, 0.03, 4), color: shade(SKIN, 0.92), position: [0, -0.028, -0.034], rotation: [-Math.PI / 2 - 0.35, 0, 0] },
    // Leather flying cap with ear flaps.
    { geometry: new IcosahedronGeometry(0.105, 1), color: LEATHER, position: [0, 0.06, 0.07], scale: [0.88, 0.72, 0.98] },
    { geometry: new BoxGeometry(0.025, 0.08, 0.06), color: LEATHER, position: [-0.083, -0.015, 0.07] },
    { geometry: new BoxGeometry(0.025, 0.08, 0.06), color: LEATHER, position: [0.083, -0.015, 0.07] },
    // Goggles over the eyes.
    { geometry: new TorusGeometry(0.03, 0.01, 4, 8), color: BRASS, position: [-0.038, 0.005, -0.035] },
    { geometry: new TorusGeometry(0.03, 0.01, 4, 8), color: BRASS, position: [0.038, 0.005, -0.035] },
    { geometry: new CylinderGeometry(0.026, 0.026, 0.01, 8), color: GLASS, position: [-0.038, 0.005, -0.035], rotation: [Math.PI / 2, 0, 0] },
    { geometry: new CylinderGeometry(0.026, 0.026, 0.01, 8), color: GLASS, position: [0.038, 0.005, -0.035], rotation: [Math.PI / 2, 0, 0] },
  ];
}

/** Neck, coat and scarf, with the origin at the eye centre; turned only by heading. */
function torsoParts(coat: number): Part[] {
  const z = BODY_BACK;
  const flat = 0.62;
  return [
    { geometry: new CylinderGeometry(0.045, 0.05, 0.1, 6), color: SKIN, position: [0, -0.15, z - 0.02] },
    // Chest from shoulders (0.2 m below the eyes) to waist, then the coat skirt to just above the knee.
    { geometry: new CylinderGeometry(0.19, 0.15, 0.4, 8), color: coat, position: [0, -0.4, z], scale: [1, 1, flat] },
    { geometry: new IcosahedronGeometry(0.075, 0), color: coat, position: [-0.165, -0.23, z], scale: [1, 0.75, 1] },
    { geometry: new IcosahedronGeometry(0.075, 0), color: coat, position: [0.165, -0.23, z], scale: [1, 0.75, 1] },
    { geometry: new CylinderGeometry(0.15, 0.2, 0.4, 8), color: shade(coat, 0.85), position: [0, -0.81, z], scale: [1, 1, 0.7] },
    // Belt and buckle.
    { geometry: new CylinderGeometry(0.157, 0.157, 0.04, 8), color: LEATHER, position: [0, -0.6, z], scale: [1, 1, 0.65] },
    { geometry: new BoxGeometry(0.05, 0.035, 0.012), color: BRASS, position: [0, -0.6, z - 0.1] },
    // Scarf round the neck with one end hanging down the chest.
    { geometry: new CylinderGeometry(0.07, 0.115, 0.08, 8), color: SCARF, position: [0, -0.19, z - 0.01], scale: [1, 1, 0.8] },
    { geometry: new BoxGeometry(0.055, 0.17, 0.015), color: SCARF, position: [0.05, -0.31, z - 0.115], rotation: [0.12, 0, 0.1] },
  ];
}

/** Trousers and boots, standing on the floor at the origin, built for hips at `LEG_LENGTH`. */
function legParts(): Part[] {
  const z = BODY_BACK;
  const parts: Part[] = [];
  for (const x of [-0.085, 0.085]) {
    parts.push(
      { geometry: new CylinderGeometry(0.075, 0.058, LEG_LENGTH - 0.08, 6), color: TROUSERS, position: [x, 0.08 + (LEG_LENGTH - 0.08) / 2, z] },
      { geometry: new BoxGeometry(0.09, 0.1, 0.2), color: BOOTS, position: [x, 0.05, z - 0.04] },
    );
  }
  return parts;
}

/**
 * A gloved fist and forearm in its own frame, the WebXR hand-joint frame of
 * a right wrist: origin at the wrist, fingers towards -Z, back of the hand
 * +Y, thumb on the -X side, forearm back along +Z. The thumb wraps round the
 * front of the curled fingers, as round a controller's handle.
 */
function handParts(coat: number): Part[] {
  return [
    // Back of the hand from the wrist to the knuckles, then the curled
    // fingers down the front and their tips tucked under.
    { geometry: new BoxGeometry(0.084, 0.04, 0.09), color: LEATHER, position: [0, -0.005, -0.05] },
    { geometry: new BoxGeometry(0.088, 0.075, 0.045), color: LEATHER, position: [0.002, -0.035, -0.112], rotation: [-0.15, 0, 0] },
    { geometry: new BoxGeometry(0.08, 0.025, 0.05), color: LEATHER, position: [0.004, -0.068, -0.085] },
    { geometry: new BoxGeometry(0.09, 0.022, 0.03), color: shade(LEATHER, 0.85), position: [0.002, 0.01, -0.1] },
    beam([-0.032, -0.022, -0.032], [-0.044, -0.06, -0.098], 0.014, LEATHER),
    // Gauntlet cuff, then the forearm in its sleeve back towards the elbow,
    // which suggests an arm without needing to work out where the elbow is.
    { geometry: new CylinderGeometry(0.05, 0.042, 0.05, 7), color: LEATHER, position: [0, -0.005, 0.02], rotation: [Math.PI / 2, 0, 0], scale: [1, 1, 0.8] },
    { geometry: new CylinderGeometry(0.052, 0.042, 0.2, 7), color: coat, position: [0, -0.005, 0.14], rotation: [Math.PI / 2, 0, 0], scale: [1, 1, 0.85] },
  ];
}

/**
 * Where a right wrist sits in its controller's grip space, from IWSDK's
 * controller-hand pose for a squeezed grip (AnimatedControllerHand). The grip
 * space has its origin in the middle of the fist, -Z along the handle
 * towards the thumb and +X out of the back of a right hand, so the forearm
 * leaves the fist up and back along +Y and +Z rather than straight back.
 */
const WRIST_IN_GRIP = new Matrix4().fromArray([
  -0.19326625764369965, -0.700115978717804, 0.6873756647109985, 0,
  0.9811022877693176, -0.13126900792121887, 0.14215001463890076, 0,
  -0.009290123358368874, 0.7018587589263916, 0.7122553586959839, 0,
  0.04728994518518448, 0.03910332918167114, 0.07807964831590652, 1,
]);
const MIRROR_X = new Matrix4().makeScale(-1, 1, 1);

/**
 * The glove and sleeve placed in a controller's (or tracked hand's) grip
 * space for `side`. The left hand is the right one mirrored, as the WebXR
 * grip spaces are.
 */
function handGeometry(coat: number, side: 'left' | 'right'): BufferGeometry {
  const geometry = mergeParts(handParts(coat));
  geometry.applyMatrix4(WRIST_IN_GRIP);
  if (side === 'left') {
    geometry.applyMatrix4(MIRROR_X);
    flipWinding(geometry);
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Swap two corners of every triangle so a mirrored mesh faces outwards again. */
function flipWinding(geometry: BufferGeometry): void {
  for (const name of ['position', 'color']) {
    const attr = geometry.getAttribute(name);
    for (let i = 0; i < attr.count; i += 3) {
      for (let k = 0; k < attr.itemSize; k++) {
        const a = attr.getComponent(i + 1, k);
        attr.setComponent(i + 1, k, attr.getComponent(i + 2, k));
        attr.setComponent(i + 2, k, a);
      }
    }
    attr.needsUpdate = true;
  }
}

function shifted(parts: Part[], dx: number, dy: number, dz: number): Part[] {
  return parts.map((p) => {
    const [x, y, z] = p.position ?? [0, 0, 0];
    return { ...p, position: [x + dx, y + dy, z + dz] };
  });
}

function partsMesh(parts: Part[], name: string): Mesh {
  const mesh = new Mesh(mergeParts(parts), new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.name = name;
  return mesh;
}

/** A stand-in crew member for the stress test, as one mesh standing at the origin and facing -Z. */
export function createDummyAvatar(index: number): Mesh {
  const coat = CREW_COLORS[index % CREW_COLORS.length];
  return partsMesh(
    [
      ...shifted(headParts(), 0, EYE_HEIGHT, 0),
      ...shifted(torsoParts(coat), 0, EYE_HEIGHT, 0),
      ...legParts(),
      // Hands held forward, palms down, as if on the crank.
      ...shifted(handParts(coat), -0.2, 1.02, -0.38),
      ...shifted(handParts(coat), 0.2, 1.02, -0.38),
    ],
    `Crew Avatar ${index + 1}`,
  );
}

export function createAvatarHead(index: number): Mesh {
  return partsMesh(headParts(), `Crew ${index + 1} Head`);
}

export function createAvatarTorso(index: number): Mesh {
  return partsMesh(torsoParts(CREW_COLORS[index % CREW_COLORS.length]), `Crew ${index + 1} Torso`);
}

export function createAvatarLegs(index: number): Mesh {
  return partsMesh(legParts(), `Crew ${index + 1} Legs`);
}

/** The coat-coloured parts' geometry in crew colour `index`, to recolour a crewmate. */
export function avatarTorsoGeometry(index: number): BufferGeometry {
  return mergeParts(torsoParts(CREW_COLORS[index % CREW_COLORS.length]));
}

/** A glove and sleeve in crew colour `index`, placed for drawing at a grip pose. */
export function avatarHandGeometry(index: number, side: 'left' | 'right'): BufferGeometry {
  return handGeometry(CREW_COLORS[index % CREW_COLORS.length], side);
}

export function createAvatarHand(index: number, side: 'left' | 'right'): Mesh {
  const mesh = new Mesh(avatarHandGeometry(index, side), new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.name = `Crew ${index + 1} ${side === 'left' ? 'Left' : 'Right'} Hand`;
  return mesh;
}
