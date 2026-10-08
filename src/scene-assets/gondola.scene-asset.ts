import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Mesh,
  MeshLambertMaterial,
  TorusGeometry,
} from '@iwsdk/core';
import { beam, jitter, mergeParts, type Part, pick, rng, shade } from './lowpoly.js';
import {
  BURNER_POSITION,
  BURNER_SIZE,
  DECK_LENGTH,
  DECK_WIDTH,
  FLUE_POSITION,
  FUNNEL_POSITION,
  LANTERN_HOOK,
  NOZZLE_TOP,
} from '../sim/gondola-layout.js';

export { BURNER_POSITION, BURNER_SIZE, DECK_LENGTH, DECK_WIDTH, LANTERN_HOOK };

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

/**
 * Fuel crate at the stern, port side, standing on a locker so the bricks are
 * at about waist height; bricks start inside it. The position is the centre
 * of the crate's base.
 */
export const FUEL_CRATE_POSITION = [-0.55, 0.55, 1.1] as const;
export const FUEL_CRATE_SIZE = [0.6, 0.26, 0.45] as const;
/** The locker under the fuel crate is this much narrower and shallower than the crate, m. */
const LOCKER_INSET = 0.04;
/** The burner's fire door on its port side: centre height, width and height, m. */
export const FIRE_DOOR = [0.3, 0.2, 0.18] as const;
/** Crank pedestal at the bow; the crank axle runs along X. */
export const CRANK_POSITION = [0, 0, -1.2] as const;
export const CRANK_AXLE_HEIGHT = 1.0;
/** The propeller's hub, out past the bow on the drive shaft from the crank pedestal; it turns about Z. */
export const PROPELLER_HUB = [0, 0.75, -DECK_LENGTH / 2 - 0.42] as const;

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
  const [cx, cy, cz] = FUEL_CRATE_POSITION;
  const [w, h, d] = FUEL_CRATE_SIZE;
  const t = 0.03;
  return [
    { name: 'crate-locker', center: [cx, cy / 2, cz], size: [w - LOCKER_INSET, cy, d - LOCKER_INSET] },
    { name: 'crate-floor', center: [cx, cy + t / 2, cz], size: [w, t, d] },
    { name: 'crate-left', center: [cx - w / 2 + t / 2, cy + h / 2, cz], size: [t, h, d] },
    { name: 'crate-right', center: [cx + w / 2 - t / 2, cy + h / 2, cz], size: [t, h, d] },
    { name: 'crate-front', center: [cx, cy + h / 2, cz - d / 2 + t / 2], size: [w, h, t] },
    { name: 'crate-back', center: [cx, cy + h / 2, cz + d / 2 - t / 2], size: [w, h, t] },
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
      // The bow's middle post would be in the propeller's drive shaft; its bearing post takes that place.
      if (x === 0 && z < 0) continue;
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

/**
 * An open cone or tube, `outer` coloured outside and `inner` inside: the
 * material draws front faces only, so an open cylinder alone vanishes from
 * the inside. The inner shell is the same shape mirrored, which turns its
 * faces inwards, and a touch smaller.
 */
function hollow(top: number, bottom: number, height: number, sides: number, outer: number, inner: number, position: [number, number, number]): Part[] {
  return [
    { geometry: new CylinderGeometry(top, bottom, height, sides, 1, true), color: outer, position },
    { geometry: new CylinderGeometry(top, bottom, height, sides, 1, true), color: inner, position, scale: [-0.96, 1, 0.96] },
  ];
}

const SOOT = 0x2b2622;

function burnerParts(): Part[] {
  const [x, , z] = BURNER_POSITION;
  const [w, h, d] = BURNER_SIZE;
  const [fx, fz] = FUNNEL_POSITION;
  const [px, pz] = FLUE_POSITION;
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
    // A brass funnel on the bow half of the top for the fuel bricks: sooty
    // inside, with the fire's dark throat at the bottom.
    ...hollow(0.15, 0.08, 0.2, 8, BRASS, SOOT, [fx, h + 0.12, fz]),
    { geometry: new TorusGeometry(0.15, 0.012, 4, 8), color: shade(BRASS, 0.8), position: [fx, h + 0.22, fz], rotation: [Math.PI / 2, 0, 0] },
    { geometry: new CylinderGeometry(0.08, 0.08, 0.01, 8), color: 0x3a1a10, position: [fx, h + 0.025, fz] },
    // The flue rises from the stern half to a flared, open nozzle a little
    // below the envelope's mouth: the hot air and the flame leap the gap.
    beam([px, h, pz], [px, NOZZLE_TOP - 0.25, pz], 0.07, IRON),
    ...hollow(0.2, 0.08, 0.28, 8, BRASS, SOOT, [px, NOZZLE_TOP - 0.14, pz]),
    { geometry: new TorusGeometry(0.2, 0.015, 4, 10), color: shade(BRASS, 0.8), position: [px, NOZZLE_TOP, pz], rotation: [Math.PI / 2, 0, 0] },
  ];
}

/**
 * The envelope's mouth over the flue: a short canvas skirt hanging from the
 * bottom of the envelope, dark inside, so the flue visibly feeds an opening
 * rather than running into the cloth.
 */
function envelopeMouthParts(): Part[] {
  const [px, pz] = FLUE_POSITION;
  const [ex, ey, ez] = ENVELOPE_CENTER;
  const [rx, ry, rz] = ENVELOPE_RADII;
  const dx = (px - ex) / rx;
  const dz = (pz - ez) / rz;
  // Where the envelope's underside is above the flue; the skirt reaches up past it.
  const bottom = ey - ry * Math.sqrt(1 - dx * dx - dz * dz);
  const skirtTop = bottom + 0.12;
  const skirtBottom = NOZZLE_TOP + 0.22;
  const height = skirtTop - skirtBottom;
  return [
    ...hollow(0.38, 0.44, height, 10, shade(CANVAS[1], 0.75), SOOT, [px, skirtBottom + height / 2, pz]),
    { geometry: new TorusGeometry(0.44, 0.02, 4, 12), color: WOOD_DARK, position: [px, skirtBottom, pz], rotation: [Math.PI / 2, 0, 0] },
    // The dark opening inside, below the cloth's jittered underside.
    { geometry: new CylinderGeometry(0.38, 0.38, 0.01, 10), color: 0x1c1712, position: [px, bottom - 0.12, pz] },
  ];
}

function crateParts(): Part[] {
  const [cx, cy, cz] = FUEL_CRATE_POSITION;
  const [w, h, d] = FUEL_CRATE_SIZE;
  const t = 0.03;
  const lw = w - LOCKER_INSET;
  const ld = d - LOCKER_INSET;
  return [
    // The locker it stands on: a dark plank chest with iron corner straps and a lid rim.
    box([lw, cy - 0.03, ld], [cx, (cy - 0.03) / 2, cz], WOOD_DARK),
    box([lw + 0.02, 0.03, ld + 0.02], [cx, cy - 0.015, cz], WOOD),
    box([lw + 0.01, 0.04, ld + 0.01], [cx, 0.021, cz], shade(IRON, 0.9)),
    ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => box([0.035, cy - 0.06, 0.035], [cx + sx * (lw / 2 - 0.01), cy / 2, cz + sz * (ld / 2 - 0.01)], IRON))),
    // The open crate on top. The floor sits inside the walls and the side
    // walls between the end walls, so no two faces share a plane (they
    // flickered where they overlapped).
    box([w - 2 * t, t, d - 2 * t], [cx, cy + t / 2, cz], WOOD_DARK),
    box([t, h, d - 2 * t], [cx - w / 2 + t / 2, cy + h / 2, cz], WOOD),
    box([t, h, d - 2 * t], [cx + w / 2 - t / 2, cy + h / 2, cz], WOOD),
    box([w, h, t], [cx, cy + h / 2, cz - d / 2 + t / 2], WOOD_LIGHT),
    box([w, h, t], [cx, cy + h / 2, cz + d / 2 - t / 2], WOOD_LIGHT),
  ];
}

/** The lantern's iron bracket: a collar round the burner flue and an arm out to the hook. */
function lanternBracketParts(): Part[] {
  const [hx, hy, hz] = LANTERN_HOOK;
  const [fx, fz] = FLUE_POSITION;
  const collarX = fx - 0.07;
  return [
    { geometry: new CylinderGeometry(0.085, 0.085, 0.05, 8), color: IRON, position: [fx, hy, fz] },
    beam([collarX, hy, fz], [hx, hy, hz], 0.016, IRON, 4),
    // A diagonal brace under the arm, and the hook's eye at its end.
    beam([collarX, hy - 0.22, fz], [(collarX + hx) / 2, hy, (fz + hz) / 2], 0.01, IRON, 4),
    beam([hx, hy, hz], [hx, hy - 0.03, hz], 0.008, IRON, 4),
  ];
}

function crankPedestalParts(): Part[] {
  const [x, , z] = CRANK_POSITION;
  const [, shaftY, hubZ] = PROPELLER_HUB;
  const bowZ = -DECK_LENGTH / 2 + 0.03;
  return [
    box([0.14, CRANK_AXLE_HEIGHT - 0.05, 0.14], [x, (CRANK_AXLE_HEIGHT - 0.05) / 2, z], WOOD_DARK),
    box([0.3, 0.05, 0.3], [x, 0.025, z], IRON),
    // Gearbox on the pedestal's bow face, and the drive shaft forward over the bulwark to the propeller.
    box([0.12, 0.14, 0.08], [x, shaftY, z - 0.1], IRON),
    beam([x, shaftY, z - 0.14], [x, shaftY, hubZ + 0.04], 0.022, IRON, 6),
    // The shaft's bearing on a short post on the bow bulwark.
    box([0.08, shaftY - BULWARK_HEIGHT - 0.03, 0.06], [x, (shaftY + BULWARK_HEIGHT - 0.03) / 2, bowZ], WOOD),
    { geometry: new CylinderGeometry(0.045, 0.045, 0.07, 8), color: BRASS, position: [x, shaftY, bowZ], rotation: [Math.PI / 2, 0, 0] },
  ];
}

/** Green painted for "ahead": the crank's direction arrows. */
const AHEAD_GREEN = 0x3f9a4a;

/**
 * A curved arrow beside the crank on each side, over the top of the axle
 * from stern to bow, showing which way to turn the handles to go ahead
 * (turning them the other way goes astern). Each arc stands on a small iron
 * frame bolted to the pedestal.
 */
function crankArrowParts(): Part[] {
  const [, , z] = CRANK_POSITION;
  const y0 = CRANK_AXLE_HEIGHT;
  const r = 0.28;
  const end = (80 * Math.PI) / 180;
  const steps = 8;
  // Same angle convention as the crank: 0 straight up, positive towards the bow (-Z).
  const at = (x: number, a: number): [number, number, number] => [x, y0 + r * Math.cos(a), z - r * Math.sin(a)];
  const parts: Part[] = [];
  for (const x of [-0.2, 0.2]) {
    for (let i = 0; i < steps; i++) {
      const a0 = -end + ((2 * end) * i) / steps;
      const a1 = -end + ((2 * end) * (i + 1)) / steps;
      parts.push(beam(at(x, a0), at(x, i === steps - 1 ? a1 - 0.12 : a1), 0.014, AHEAD_GREEN, 5));
    }
    // Arrowhead at the bow end, pointing along the turn.
    parts.push({
      geometry: new ConeGeometry(0.04, 0.09, 6),
      color: AHEAD_GREEN,
      position: at(x, end - 0.05),
      rotation: [Math.atan2(-Math.cos(end), -Math.sin(end)), 0, 0],
    });
    // The frame: posts down from the arc's ends to a rail, and a bar to the pedestal.
    const railY = 0.85;
    const [, fy, fz] = at(x, end);
    const [, by, bz] = at(x, -end);
    parts.push(beam([x, by, bz], [x, railY, bz], 0.01, IRON, 4));
    parts.push(beam([x, fy, fz], [x, railY, fz], 0.01, IRON, 4));
    parts.push(beam([x, railY, bz], [x, railY, fz], 0.012, IRON, 4));
    parts.push(beam([Math.sign(x) * 0.07, railY, z], [x, railY, z], 0.012, IRON, 4));
  }
  return parts;
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
      ...envelopeMouthParts(),
      ...crateParts(),
      ...lanternBracketParts(),
      ...crankPedestalParts(),
      ...crankArrowParts(),
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
