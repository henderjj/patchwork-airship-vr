import {
  BoxGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Mesh,
  MeshLambertMaterial,
} from '@iwsdk/core';
import { beam, jitter, mergeParts, type Part, pick, rng, shade } from './lowpoly.js';
import { BURNER_POSITION, BURNER_SIZE, DECK_LENGTH, DECK_WIDTH } from '../sim/gondola-layout.js';

export { BURNER_POSITION, BURNER_SIZE, DECK_LENGTH, DECK_WIDTH };

/**
 * The gondola: a 2 × 3 m wood-and-canvas deck that is the players' fixed frame
 * of reference. The bow points towards -Z. The deck surface is at y = 0, so the
 * gondola's local space is the physics and tracking space (see
 * docs/spikes/s2-moving-ship.md for why the ship stays still and the world moves).
 *
 * Static parts are merged into two meshes (two draw calls): the walkable hull
 * and the rigging. Interactive parts (crank, tiller, fuel bricks) are separate.
 */

export const BULWARK_HEIGHT = 0.5;
export const RAIL_HEIGHT = 1.0;
export const ENVELOPE_CENTER = [0, 7.2, 0] as const;
export const ENVELOPE_RADII = [3.0, 2.8, 5.2] as const;

/** Fuel crate at the stern, port side; bricks start inside it. */
export const FUEL_CRATE_POSITION = [-0.55, 0, 1.1] as const;
export const FUEL_CRATE_SIZE = [0.6, 0.32, 0.45] as const;
/** The burner's fire door on its port side: centre height, width and height, m. */
export const FIRE_DOOR = [0.3, 0.2, 0.18] as const;
/** Crank pedestal at the bow; the crank axle runs along X. */
export const CRANK_POSITION = [0, 0, -1.2] as const;
export const CRANK_AXLE_HEIGHT = 1.0;

export interface BoxCollider {
  name: string;
  center: [number, number, number];
  size: [number, number, number];
}

const half = (v: number) => v / 2;
const wallHeight = 1.15;
const wallThickness = 0.1;

/**
 * Static colliders, in gondola space. Walls are taller than the visible
 * bulwark so bricks stay aboard unless thrown well over the rail.
 */
export const GONDOLA_COLLIDERS: BoxCollider[] = [
  { name: 'deck', center: [0, -0.05, 0], size: [DECK_WIDTH, 0.1, DECK_LENGTH] },
  {
    name: 'wall-port',
    center: [-half(DECK_WIDTH) - half(wallThickness), half(wallHeight), 0],
    size: [wallThickness, wallHeight, DECK_LENGTH],
  },
  {
    name: 'wall-starboard',
    center: [half(DECK_WIDTH) + half(wallThickness), half(wallHeight), 0],
    size: [wallThickness, wallHeight, DECK_LENGTH],
  },
  {
    name: 'wall-bow',
    center: [0, half(wallHeight), -half(DECK_LENGTH) - half(wallThickness)],
    size: [DECK_WIDTH + 2 * wallThickness, wallHeight, wallThickness],
  },
  {
    name: 'wall-stern',
    center: [0, half(wallHeight), half(DECK_LENGTH) + half(wallThickness)],
    size: [DECK_WIDTH + 2 * wallThickness, wallHeight, wallThickness],
  },
  {
    name: 'burner',
    center: [BURNER_POSITION[0], half(BURNER_SIZE[1]), BURNER_POSITION[2]],
    size: [...BURNER_SIZE],
  },
  {
    name: 'crank-pedestal',
    center: [CRANK_POSITION[0], half(CRANK_AXLE_HEIGHT), CRANK_POSITION[2]],
    size: [0.14, CRANK_AXLE_HEIGHT, 0.14],
  },
  ...crateColliders(),
];

function crateColliders(): BoxCollider[] {
  const [cx, , cz] = FUEL_CRATE_POSITION;
  const [w, h, d] = FUEL_CRATE_SIZE;
  const t = 0.03;
  return [
    { name: 'crate-floor', center: [cx, t / 2, cz], size: [w, t, d] },
    { name: 'crate-left', center: [cx - w / 2 + t / 2, h / 2, cz], size: [t, h, d] },
    { name: 'crate-right', center: [cx + w / 2 - t / 2, h / 2, cz], size: [t, h, d] },
    { name: 'crate-front', center: [cx, h / 2, cz - d / 2 + t / 2], size: [w, h, t] },
    { name: 'crate-back', center: [cx, h / 2, cz + d / 2 - t / 2], size: [w, h, t] },
  ];
}

const WOOD = 0xb07a4a;
const WOOD_DARK = 0x7a5232;
const WOOD_LIGHT = 0xc99a62;
const IRON = 0x3a3f47;
const ROPE = 0xd8c39a;
const BRASS = 0xc9a03a;
const CANVAS = [0xe8dcc0, 0xd9c7a1, 0xc4553f, 0xd6a24a, 0x5f8f8a, 0xe2d2ae, 0xa8483a];

function box(
  size: [number, number, number],
  position: [number, number, number],
  color: number,
  rotation?: [number, number, number],
): Part {
  return { geometry: new BoxGeometry(...size), color, position, rotation };
}

function deckParts(): Part[] {
  const parts: Part[] = [];
  const planks = 8;
  const plankWidth = DECK_WIDTH / planks;
  for (let i = 0; i < planks; i++) {
    const x = -DECK_WIDTH / 2 + plankWidth * (i + 0.5);
    parts.push(box([plankWidth - 0.01, 0.06, DECK_LENGTH], [x, -0.03, 0], i % 2 ? WOOD : WOOD_LIGHT));
  }
  // Hull below the deck, tapering to a keel.
  const hull = new CylinderGeometry(1, 0.55, 0.5, 4, 1);
  hull.rotateY(Math.PI / 4);
  hull.scale(DECK_WIDTH / Math.SQRT2, 1, DECK_LENGTH / Math.SQRT2);
  parts.push({ geometry: hull, color: WOOD_DARK, position: [0, -0.31, 0] });
  return parts;
}

function bulwarkParts(): Part[] {
  const parts: Part[] = [];
  const t = 0.05;
  const hw = DECK_WIDTH / 2;
  const hl = DECK_LENGTH / 2;
  // Planked sides.
  for (const side of [-1, 1]) {
    parts.push(box([t, BULWARK_HEIGHT, DECK_LENGTH], [side * (hw - t / 2), BULWARK_HEIGHT / 2, 0], WOOD_DARK));
    parts.push(box([DECK_WIDTH, BULWARK_HEIGHT, t], [0, BULWARK_HEIGHT / 2, side * (hl - t / 2)], WOOD_DARK));
  }
  // Rail posts and the top rail.
  const postXs = [-hw + 0.03, 0, hw - 0.03];
  const postZs = [-hl + 0.03, -0.5, 0.5, hl - 0.03];
  for (const x of [-hw + 0.03, hw - 0.03]) {
    for (const z of postZs) {
      parts.push(box([0.06, RAIL_HEIGHT - BULWARK_HEIGHT, 0.06], [x, (RAIL_HEIGHT + BULWARK_HEIGHT) / 2, z], WOOD));
    }
  }
  for (const z of [-hl + 0.03, hl - 0.03]) {
    for (const x of postXs) {
      parts.push(box([0.06, RAIL_HEIGHT - BULWARK_HEIGHT, 0.06], [x, (RAIL_HEIGHT + BULWARK_HEIGHT) / 2, z], WOOD));
    }
  }
  for (const side of [-1, 1]) {
    parts.push(box([0.08, 0.06, DECK_LENGTH + 0.04], [side * (hw - 0.03), RAIL_HEIGHT, 0], WOOD_LIGHT));
    parts.push(box([DECK_WIDTH + 0.04, 0.06, 0.08], [0, RAIL_HEIGHT, side * (hl - 0.03)], WOOD_LIGHT));
  }
  return parts;
}

function riggingParts(): Part[] {
  const parts: Part[] = [];
  const hw = DECK_WIDTH / 2 - 0.03;
  const hl = DECK_LENGTH / 2 - 0.03;
  const [ex, ey, ez] = ENVELOPE_CENTER;
  const [rx, ry, rz] = ENVELOPE_RADII;
  // Load ring under the envelope, and ropes from each rail post to it.
  const ringY = ey - ry * 0.82;
  for (const [x, z] of [
    [-hw, -hl], [hw, -hl], [-hw, hl], [hw, hl], [-hw, 0], [hw, 0],
  ]) {
    parts.push(beam([x, RAIL_HEIGHT, z], [x * 1.3, ringY, z * 1.25], 0.012, ROPE));
    parts.push(beam([x * 1.3, ringY, z * 1.25], [ex + x * rx * 0.5, ey - ry * 0.55, ez + z * rz * 0.35], 0.012, ROPE));
  }
  // A wooden load frame around the envelope's waist.
  const frameY = ringY;
  parts.push(box([0.06, 0.06, DECK_LENGTH * 1.25 * 2 / 2 + 0.1], [-hw * 1.3, frameY, 0], WOOD_DARK));
  parts.push(box([0.06, 0.06, DECK_LENGTH * 1.25 * 2 / 2 + 0.1], [hw * 1.3, frameY, 0], WOOD_DARK));
  parts.push(box([DECK_WIDTH * 1.3 + 0.06, 0.06, 0.06], [0, frameY, -hl * 1.25], WOOD_DARK));
  parts.push(box([DECK_WIDTH * 1.3 + 0.06, 0.06, 0.06], [0, frameY, hl * 1.25], WOOD_DARK));
  return parts;
}

function envelopeParts(): Part[] {
  const random = rng(7);
  const geometry = new IcosahedronGeometry(1, 3);
  jitter(geometry, 0.035, random);
  const [rx, ry, rz] = ENVELOPE_RADII;
  const patchColors = new Map<number, number>();
  return [
    {
      geometry,
      position: [...ENVELOPE_CENTER],
      scale: [rx, ry, rz],
      color: (tri, c) => {
        // Patches: group triangles into coarse cells so patches span several faces.
        const cell = Math.floor((c.y + 20) / 1.6) * 97 + Math.floor((Math.atan2(c.z, c.x) + 4) * 2.2);
        let base = patchColors.get(cell);
        if (base === undefined) {
          base = random() < 0.62 ? CANVAS[0] : pick(CANVAS, random);
          patchColors.set(cell, base);
        }
        // Darker towards the bottom for a cheap baked shading.
        const height = (c.y - (ENVELOPE_CENTER[1] - ry)) / (2 * ry);
        return shade(base, 0.72 + 0.3 * Math.min(1, Math.max(0, height)) + (tri % 3) * 0.015);
      },
    },
  ];
}

function burnerParts(): Part[] {
  const [x, , z] = BURNER_POSITION;
  const [w, h, d] = BURNER_SIZE;
  const ringY = ENVELOPE_CENTER[1] - ENVELOPE_RADII[1] * 0.82;
  // The fire door on the side facing the middle of the deck: a brass frame
  // and grate bars in front of the glow (ControlsSystem's fire glow).
  const doorX = x - w / 2 - 0.006;
  const [doorY, doorW, doorH] = FIRE_DOOR;
  const grate: Part[] = [-0.06, 0, 0.06].map((dz) => box([0.012, doorH, 0.014], [doorX - 0.004, doorY, z + dz], shade(IRON, 0.7)));
  return [
    box([w, h, d], [x, h / 2, z], IRON),
    box([w + 0.04, 0.04, d + 0.04], [x, h, z], BRASS),
    // Iron feet and a brass band, so it reads as a stove rather than a box.
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => box([0.06, 0.04, 0.06], [x + sx * (w / 2 - 0.02), 0.02, z + sz * (d / 2 - 0.02)], shade(IRON, 0.8)))),
    box([w + 0.02, 0.03, d + 0.02], [x, 0.07, z], BRASS),
    box([0.016, 0.025, doorW + 0.05], [doorX, doorY + doorH / 2 + 0.012, z], BRASS),
    box([0.016, 0.025, doorW + 0.05], [doorX, doorY - doorH / 2 - 0.012, z], BRASS),
    box([0.016, doorH, 0.025], [doorX, doorY, z - doorW / 2 - 0.012], BRASS),
    box([0.016, doorH, 0.025], [doorX, doorY, z + doorW / 2 + 0.012], BRASS),
    ...grate,
    // A brass funnel on top for the fuel bricks.
    {
      geometry: new CylinderGeometry(0.2, 0.11, 0.2, 8, 1, true),
      color: BRASS,
      position: [x, h + 0.1, z],
    },
    { geometry: new CylinderGeometry(0.21, 0.21, 0.025, 8, 1, true), color: shade(BRASS, 0.8), position: [x, h + 0.2, z] },
    // Flue up to the envelope mouth.
    beam([x, h, z], [x, ringY + 0.4, z], 0.07, IRON),
    {
      geometry: new CylinderGeometry(0.35, 0.25, 0.3, 8),
      color: BRASS,
      position: [x, ringY + 0.55, z],
    },
  ];
}

function crateParts(): Part[] {
  const [cx, , cz] = FUEL_CRATE_POSITION;
  const [w, h, d] = FUEL_CRATE_SIZE;
  const t = 0.03;
  return [
    box([w, t, d], [cx, t / 2, cz], WOOD_DARK),
    box([t, h, d], [cx - w / 2 + t / 2, h / 2, cz], WOOD),
    box([t, h, d], [cx + w / 2 - t / 2, h / 2, cz], WOOD),
    box([w, h, t], [cx, h / 2, cz - d / 2 + t / 2], WOOD_LIGHT),
    box([w, h, t], [cx, h / 2, cz + d / 2 - t / 2], WOOD_LIGHT),
  ];
}

function crankPedestalParts(): Part[] {
  const [x, , z] = CRANK_POSITION;
  return [
    box([0.14, CRANK_AXLE_HEIGHT - 0.05, 0.14], [x, (CRANK_AXLE_HEIGHT - 0.05) / 2, z], WOOD_DARK),
    box([0.3, 0.05, 0.3], [x, 0.025, z], IRON),
    // Drive shaft forward to the propeller at the bow.
    beam([x, CRANK_AXLE_HEIGHT - 0.1, z], [x, 0.5, -DECK_LENGTH / 2 - 0.3], 0.03, IRON),
  ];
}

function tillerPostParts(): Part[] {
  return [box([0.1, 0.8, 0.1], [0, 0.4, DECK_LENGTH / 2 - 0.15], WOOD_DARK)];
}

const gondolaMaterial = new MeshLambertMaterial({ vertexColors: true, flatShading: true });

/**
 * The hull: deck, bulwarks and rails. Thumbstick walking keeps the player's
 * head inside the rails without colliding with this mesh (see
 * src/sim/deck-walk.ts).
 */
export function createGondolaHull(): Mesh {
  const mesh = new Mesh(mergeParts([...deckParts(), ...bulwarkParts()]), gondolaMaterial);
  mesh.name = 'Gondola Hull';
  return mesh;
}

/** Everything else that is static: envelope, rigging, burner, crate, pedestals. */
export function createGondolaRigging(): Mesh {
  const mesh = new Mesh(
    mergeParts([
      ...riggingParts(),
      ...envelopeParts(),
      ...burnerParts(),
      ...crateParts(),
      ...crankPedestalParts(),
      ...tillerPostParts(),
    ]),
    gondolaMaterial,
  );
  mesh.name = 'Gondola Rigging';
  return mesh;
}

/** Invisible box used for each static collider (sizes from GONDOLA_COLLIDERS). */
export function createColliderBox(size: [number, number, number]): Mesh {
  const mesh = new Mesh(new BoxGeometry(...size), new MeshLambertMaterial());
  mesh.visible = false;
  return mesh;
}

export const FUEL_BRICK_SIZE = [0.16, 0.08, 0.09] as const;

export function createFuelBrick(): Mesh {
  const geometry = mergeParts([
    { geometry: new BoxGeometry(...FUEL_BRICK_SIZE), color: (tri) => (tri < 4 ? 0x2b2622 : 0x3d342c) },
    { geometry: new BoxGeometry(FUEL_BRICK_SIZE[0] + 0.004, 0.012, FUEL_BRICK_SIZE[2] + 0.004), color: 0xb0452d },
  ]);
  return new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}
