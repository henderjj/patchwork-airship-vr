import { BoxGeometry, type BufferGeometry, Color, ConeGeometry, CylinderGeometry, TorusGeometry } from '@iwsdk/core';
import { cornerKey, jitter, mergeParts, type Part, rng, shade } from '../scene-assets/lowpoly.js';
import { type Arch, BAND_RAIL, type Cleft, CLEFT_FLOOR_DEPTH, cleftFloorAlong, deckWindow, LEG_ROOT, type Passage } from '../sim/passages.js';

/**
 * The narrow passages and rock arches in the sky (Phase 3,
 * docs/passages.md), built from the same shapes the contact uses
 * (src/sim/passages.ts). Each geometry is in its passage's own frame: x
 * across the way through (starboard positive), -z along it (ahead), and y
 * from the gorge's floor or the grass under the arch; the mesh stands at
 * the gate turned by the passage's yaw (`passageBase`).
 */

const GRASS = 0x86ba5f;
const ROCK = 0x8f7a68;
const CLIFF = 0x9c8673;
const SCREE = 0x7d6e60;
const PAINT = 0xf2ecd8;
const RED = 0xc8402c;
const TREE = [0x3f7d4a, 0x4b8c4f, 0x356b45];
const TRUNK = 0x6b4a32;

/** The height a passage's mesh stands at (its gorge's floor, or the grass under its arch), m. */
export function passageBase(p: Passage): number {
  return p.kind === 'cleft' ? p.floor : p.ground;
}

export function createPassageGeometry(p: Passage): BufferGeometry {
  return p.kind === 'cleft' ? createCleftGeometry(p) : createArchGeometry(p);
}

/** A floating island's grass cap and the rock under it, its top at `top` (the frame's y), centred at x. */
function islandParts(x: number, top: number, radius: number, depth: number, seed: number): Part[] {
  const rockDepth = depth - 0.6;
  const rock = new ConeGeometry(radius * 0.96, rockDepth, 14, 5);
  rock.rotateX(Math.PI);
  jitter(rock, radius * 0.1, rng(seed));
  // Keep the roughened rock under the grass, as on the landing islands.
  const pos = rock.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, Math.min(pos.getY(i), rockDepth / 2 - 0.05));
  }
  return [
    {
      geometry: new CylinderGeometry(radius, radius * 0.96, 0.6, 14, 1),
      position: [x, top - 0.3, 0],
      color: (tri, c) => (c.y > top - 0.05 ? shade(GRASS, 0.95 + (tri % 3) * 0.03) : shade(GRASS, 0.72)),
    },
    {
      geometry: rock,
      position: [x, top - 0.6 - rockDepth / 2, 0],
      color: (tri, c) => shade(ROCK, 1 - Math.min(0.45, ((top - c.y) / depth) * 0.5) - (Math.floor((top - c.y) / 2.5) % 2) * 0.06 + (tri % 3) * 0.02),
    },
  ];
}

function treeParts(x: number, top: number, z: number, size: number, color: number): Part[] {
  return [
    { geometry: new ConeGeometry(size, size * 3, 6), position: [x, top + size * 2, z], color },
    { geometry: new CylinderGeometry(size * 0.15, size * 0.2, size * 0.6, 4), position: [x, top + size * 0.3, z], color: TRUNK },
  ];
}

/**
 * The Cleft: two islands side by side, each cut off sheer where it faces
 * the other, so a gorge `2 * half` wide runs between them, with a rock floor
 * joining them under it. The sheer walls are one colour, so the rock
 * squashed flat against them can't flicker.
 */
export function createCleftGeometry(c: Cleft): BufferGeometry {
  const random = rng(4421);
  const middle = c.half + c.beyond;
  const islands: BufferGeometry[] = [];
  for (const side of [1, -1]) {
    const x = side * middle;
    const parts = islandParts(x, c.walls, c.radius, c.depth, side > 0 ? 7341 : 7342);
    // Trees on top, back from the edge of the gorge.
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + random() * 0.6;
      const dist = c.radius * (0.35 + random() * 0.45);
      const tx = x + Math.cos(angle) * dist;
      const tz = Math.sin(angle) * dist;
      if (side * tx < c.half + 2.5) continue;
      parts.push(...treeParts(tx, c.walls, tz, 1.2 + random() * 1.3, TREE[i % TREE.length]));
    }
    const island = mergeParts(parts);
    sheerWall(island, side, c.half, CLIFF);
    islands.push(island);
  }
  // The gorge's floor: rock with scree on top, its top no higher than the floor.
  const along = cleftFloorAlong(c);
  const floor = new BoxGeometry(2 * (c.half + 2), CLEFT_FLOOR_DEPTH, 2 * along, 5, 1, 5);
  jitter(floor, 0.6, rng(4422));
  const fp = floor.getAttribute('position');
  for (let i = 0; i < fp.count; i++) {
    fp.setY(i, Math.min(fp.getY(i), CLEFT_FLOOR_DEPTH / 2));
  }
  return mergeParts([
    ...islands.map((geometry): Part => ({ geometry, color: 'own' })),
    {
      geometry: floor,
      position: [0, -CLEFT_FLOOR_DEPTH / 2, 0],
      color: (tri, p) => (p.y > -0.3 ? shade(SCREE, 0.95 + (tri % 3) * 0.04) : shade(ROCK, 0.7 + (tri % 3) * 0.03)),
    },
  ]);
}

/**
 * Cut an island off sheer at x = side * half: every corner nearer the gorge
 * goes onto the wall, and every face that ends up on it takes `color`.
 */
function sheerWall(geometry: BufferGeometry, side: number, half: number, color: number): void {
  const pos = geometry.getAttribute('position');
  const col = geometry.getAttribute('color');
  const wall = side * half;
  for (let i = 0; i < pos.count; i++) {
    if (side * pos.getX(i) < half) pos.setX(i, wall);
  }
  // Colours as mergeParts stores them (in the renderer's working colour space).
  const wallColor = new Color().setHex(color);
  for (let tri = 0; tri < pos.count / 3; tri++) {
    let flat = true;
    for (let k = 0; k < 3; k++) flat &&= pos.getX(tri * 3 + k) === wall;
    if (!flat) continue;
    for (let k = 0; k < 3; k++) col.setXYZ(tri * 3 + k, wallColor.r, wallColor.g, wallColor.b);
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

/**
 * The Arch: an island with a stone arch standing across its middle, two
 * legs rising straight from the grass and a half circle of rock over them,
 * the rock deeper along the way through than across it. A band is painted
 * on each leg's inner face (white between red edges) at the height the
 * gondola's rail is at while the ship fits under the span with its keel
 * clear of the grass: keep the rail level with the band.
 */
export function createArchGeometry(a: Arch): BufferGeometry {
  const t = a.thickness;
  const r = a.half + t;
  const { low, high } = deckWindow(a);
  const bandLow = low - a.ground + BAND_RAIL;
  const bandHigh = high - a.ground + BAND_RAIL;
  const edge = 0.15;
  // Each leg in stacked rings, so the band's edges are rows of corners.
  const rows = [-LEG_ROOT, bandLow - edge, bandLow, bandHigh, bandHigh + edge, a.legs];
  const paint = [ROCK, RED, PAINT, RED, ROCK];
  const parts: Part[] = [];
  for (const side of [1, -1]) {
    for (let i = 0; i < rows.length - 1; i++) {
      const height = rows[i + 1] - rows[i];
      parts.push({
        geometry: new CylinderGeometry(t, t, height, 8, 1, true),
        position: [side * r, rows[i] + height / 2, 0],
        color: (tri, c) => {
          const inner = side * (c.x - side * r) < -t * 0.35;
          return inner && paint[i] !== ROCK ? paint[i] : shade(ROCK, 0.92 - (c.y < 1 ? 0.08 : 0) + (tri % 3) * 0.03);
        },
      });
    }
  }
  // The span: half a torus whose ends meet the legs' top rings corner for corner.
  parts.push({
    geometry: new TorusGeometry(r, t, 8, 14, Math.PI),
    position: [0, a.legs, 0],
    // Grass on the top of the crown.
    color: (tri, c) => (c.y > a.legs + r + t * 0.55 ? shade(GRASS, 0.85 + (tri % 3) * 0.04) : shade(ROCK, 1.02 - (tri % 3) * 0.04)),
  });
  const arch = mergeParts(parts);
  roughen(arch, a, rng(5517));
  arch.scale(1, 1, a.deep);

  const random = rng(5518);
  const shrubs: Part[] = [];
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const size = 0.7 + random() * 0.5;
    shrubs.push({ geometry: new ConeGeometry(size, size * 1.6, 5), position: [sx * (a.half + 4.5), size * 0.8, sz * (t * a.deep + 2.5)], color: TREE[Math.floor(random() * 3)] });
  }
  return mergeParts([{ geometry: arch, color: 'own' }, ...islandParts(0, 0, a.radius, a.depth, 5519), ...shrubs]);
}

/**
 * Roughen an arch's rock in and out from its middle line by up to ±0.25 m,
 * keeping shared corners together (so the legs and span stay joined) and
 * the band's rows at their heights.
 */
function roughen(geometry: BufferGeometry, a: Arch, random: () => number): void {
  const pos = geometry.getAttribute('position');
  const offsets = new Map<string, number>();
  const r = a.half + a.thickness;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const key = cornerKey(x, y, z);
    let o = offsets.get(key);
    if (o === undefined) {
      o = (random() - 0.5) * 0.5;
      offsets.set(key, o);
    }
    // Outwards from the nearest point of the middle line: a leg's axis, or the span's circle.
    let cx: number;
    let cy: number;
    if (y > a.legs) {
      const d = Math.hypot(x, y - a.legs) || 1;
      cx = (x / d) * r;
      cy = a.legs + ((y - a.legs) / d) * r;
    } else {
      cx = Math.sign(x) * r;
      cy = y;
    }
    const dx = x - cx;
    const dy = y - cy;
    const dz = z;
    const d = Math.hypot(dx, dy, dz) || 1;
    pos.setXYZ(i, x + (dx / d) * o, y + (dy / d) * o, z + (dz / d) * o);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}
