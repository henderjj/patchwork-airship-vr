import { BoxGeometry, CylinderGeometry, DoubleSide, Mesh, MeshLambertMaterial, MeshPhongMaterial, Path, Shape, ShapeGeometry } from '@iwsdk/core';
import { HATCH } from '../sim/cargo.js';
import { DECK_LENGTH, DECK_WIDTH, PUMP, PUMP_HEIGHT, PUMP_LEVER, PUMP_PIVOT, PUMP_RADIUS, PUMP_SPOUT } from '../sim/gondola-layout.js';
import { beam, mergeParts, type Part, shade } from './lowpoly.js';

/**
 * The bilge pump (storms, docs/storms-and-night.md): a staved barrel
 * against the starboard rail with iron hoops, a spout out over the side and
 * a bracket on top; the lever that pivots in the bracket, its handle
 * reaching inboard; and the plunger rod hanging from the lever's short end
 * into the barrel. Positions live in src/sim/gondola-layout.ts.
 */

const WOOD = 0x8a5a32;
const WOOD_DARK = 0x6a4428;
const STAVE = 0x9a6a3e;
const IRON = 0x3a3f47;
const BRASS = 0xc9a03a;

/** The lever's short end, where the rod hangs, is this far outboard of the pivot, m. */
export const ROD_ARM = 0.06;
/** The plunger rod's length, m. */
const ROD_LENGTH = 0.26;

/** The deck inside the bulwarks, where water lies: x and z either side of the middle, m. */
const INSIDE = [DECK_WIDTH / 2 - 0.05, DECK_LENGTH / 2 - 0.05] as const;

const lambert = () => new MeshLambertMaterial({ vertexColors: true, flatShading: true });

function partsMesh(parts: Part[], name: string): Mesh {
  const mesh = new Mesh(mergeParts(parts), lambert());
  mesh.name = name;
  return mesh;
}

/** The staves' radius at height `y` above the deck: the barrel swells a little towards its foot. */
function staveRadius(y: number): number {
  return PUMP_RADIUS * (1 + (0.06 * (PUMP_HEIGHT - y)) / PUMP_HEIGHT);
}

/** An iron hoop round the barrel at height `y`, 3 cm deep. */
function hoop(y: number): Part {
  const radius = Math.max(staveRadius(y - 0.015), staveRadius(y + 0.015)) + 0.01;
  return { geometry: new CylinderGeometry(radius, radius, 0.03, 10), position: [PUMP[0], y, PUMP[1]], color: IRON };
}

/** The barrel, its hoops, its lid, the spout and the lever's bracket, in gondola space. */
export function createPumpBody(): Mesh {
  const [x, z] = PUMP;
  const [px, py] = PUMP_PIVOT;
  const r = PUMP_RADIUS;
  const parts: Part[] = [
    // Staves, alternating a little in tone.
    {
      geometry: new CylinderGeometry(r, r * 1.06, PUMP_HEIGHT, 10),
      position: [x, PUMP_HEIGHT / 2, z],
      color: (tri) => shade(STAVE, (tri >> 1) % 2 ? 0.92 : 1.04),
    },
    // Two iron hoops standing 1 cm proud of the staves (they flicker closer), and a dark wooden lid.
    hoop(0.16),
    hoop(PUMP_HEIGHT - 0.06),
    { geometry: new CylinderGeometry(r + 0.012, r + 0.012, 0.02, 10), position: [x, PUMP_HEIGHT + 0.006, z], color: WOOD_DARK },
    // The spout: out of the barrel's outboard side, between the bulwark and the rail, turned down over the side.
    beam([x + r * 0.6, PUMP_SPOUT[1] + 0.06, z], [PUMP_SPOUT[0] - 0.03, PUMP_SPOUT[1] + 0.06, z], 0.026, BRASS, 6),
    beam([PUMP_SPOUT[0] - 0.045, PUMP_SPOUT[1] + 0.07, z], [PUMP_SPOUT[0], PUMP_SPOUT[1], z], 0.026, shade(BRASS, 0.85), 6),
  ];
  // The bracket's two iron cheeks either side of the lever, up to the pivot.
  for (const side of [-1, 1]) {
    parts.push({
      geometry: new BoxGeometry(0.05, py - PUMP_HEIGHT + 0.04, 0.01),
      position: [px, (PUMP_HEIGHT + 0.016 + py + 0.04) / 2, z + side * 0.031],
      color: IRON,
    });
  }
  return partsMesh(parts, 'Bilge Pump');
}

/** The lever, its origin on the pivot, reaching inboard (-X) to the handle; it turns about Z. */
export function createPumpLever(): Mesh {
  const L = PUMP_LEVER;
  return partsMesh(
    [
      { geometry: new BoxGeometry(L + ROD_ARM + 0.03, 0.035, 0.035), position: [(ROD_ARM + 0.03 - L) / 2, 0, 0], color: WOOD },
      // The pin through the bracket.
      { geometry: new CylinderGeometry(0.01, 0.01, 0.08, 6), rotation: [Math.PI / 2, 0, 0], color: IRON },
      // The handle: a crossbar to grip, darker from hands, with brass ends.
      { geometry: new CylinderGeometry(0.02, 0.02, 0.16, 8), position: [-L, 0, 0], rotation: [Math.PI / 2, 0, 0], color: WOOD_DARK },
      { geometry: new CylinderGeometry(0.024, 0.024, 0.012, 8), position: [-L, 0, 0.086], rotation: [Math.PI / 2, 0, 0], color: BRASS },
      { geometry: new CylinderGeometry(0.024, 0.024, 0.012, 8), position: [-L, 0, -0.086], rotation: [Math.PI / 2, 0, 0], color: BRASS },
    ],
    'Pump Lever',
  );
}

/** The plunger rod, its origin at its top (on the lever's short end), hanging down into the barrel. */
export function createPumpRod(): Mesh {
  return partsMesh([beam([0, 0.01, 0], [0, -ROD_LENGTH, 0], 0.01, IRON, 5)], 'Pump Rod');
}

/**
 * The water lying on the deck: a sheet inside the bulwarks with a hole for
 * the cargo hatch, its top at y = 0 (moved up to the water's depth).
 */
export function createDeckWater(): Mesh {
  const [hx, hz] = INSIDE;
  // In the shape's plane, x is across the deck and y is -z (it is turned to lie flat).
  const shape = new Shape();
  shape.moveTo(-hx, -hz);
  shape.lineTo(hx, -hz);
  shape.lineTo(hx, hz);
  shape.lineTo(-hx, hz);
  shape.closePath();
  const hole = new Path();
  hole.moveTo(HATCH.x0, -HATCH.z1);
  hole.lineTo(HATCH.x0, -HATCH.z0);
  hole.lineTo(HATCH.x1, -HATCH.z0);
  hole.lineTo(HATCH.x1, -HATCH.z1);
  hole.closePath();
  shape.holes.push(hole);
  const geometry = new ShapeGeometry(shape);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new Mesh(
    geometry,
    // Shiny, so the sky glints off it and it reads as water rather than a grey deck.
    new MeshPhongMaterial({ color: 0x3f6f8f, specular: 0x8899aa, shininess: 60, transparent: true, opacity: 0.55, depthWrite: false, side: DoubleSide }),
  );
  mesh.name = 'Bilge Water';
  // Drawn after the deck and anything on it.
  mesh.renderOrder = 1;
  return mesh;
}
