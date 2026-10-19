import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Raycaster,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import {
  type CanvasAt,
  PATCH_DROP,
  PATCH_WIDTH,
  RIVETS,
  type TearSpot,
  TEAR_SPOTS,
} from '../sim/envelope.js';
import { HAMMER_HEAD } from '../sim/loft.js';
import { createEnvelopeGeometry } from './gondola.scene-asset.js';
import { mergeParts, type Part, shade } from './lowpoly.js';

/**
 * The repair gear that moves (docs/repairs.md): the tears in the envelope's
 * belly, the patches over them and their rivets, a patch carried in a hand,
 * and the riveting hammer. The loft, its ladder, the box of patches and the
 * hammer's rack are part of the gondola (src/scene-assets/gondola.scene-asset.ts).
 *
 * The tears and patches lie on the envelope's lumpy underside as modelled,
 * measured once by `envelopeUnderside`; faces of a different colour stay at
 * least 12 mm below it (the canvas faces down too, so they would flicker
 * through it any closer, test/z-fighting.test.ts).
 */

const IRON = 0x3a3f47;
const WOOD = 0xb07a4a;
const GASH = 0x1c1712;
const FLAP = shade(0xe8dcc0, 0.78);
export const PATCH_COLOR = 0xd6a24a;
const RIVET_SET = 0xc9a03a;
const RIVET_HOLE = 0x2b2622;

/** Where the underside is measured: a grid this far apart over the loft, m. */
const GRID = 0.05;
const GRID_X = [-1.2, 0.2] as const;
const GRID_Z = [-0.5, 1.7] as const;

let underside: CanvasAt | null = null;

/**
 * The envelope's underside height over the loft, as modelled (its lumps
 * included): measured once on a 5 cm grid and read between the grid's
 * points. Outside the grid it is the nearest edge's.
 */
export function envelopeUnderside(): CanvasAt {
  if (underside) return underside;
  const geometry = createEnvelopeGeometry();
  const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
  mesh.updateMatrixWorld(true);
  const nx = Math.round((GRID_X[1] - GRID_X[0]) / GRID) + 1;
  const nz = Math.round((GRID_Z[1] - GRID_Z[0]) / GRID) + 1;
  const heights = new Float32Array(nx * nz);
  const ray = new Raycaster();
  const from = new Vector3();
  const up = new Vector3(0, 1, 0);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      from.set(GRID_X[0] + i * GRID, 0, GRID_Z[0] + j * GRID);
      ray.set(from, up);
      const hit = ray.intersectObject(mesh, false)[0];
      heights[j * nx + i] = hit ? hit.point.y : 4.5;
    }
  }
  geometry.dispose();
  (mesh.material as MeshBasicMaterial).dispose();
  underside = (x, z) => {
    const fx = Math.min(nx - 1.0001, Math.max(0, (x - GRID_X[0]) / GRID));
    const fz = Math.min(nz - 1.0001, Math.max(0, (z - GRID_Z[0]) / GRID));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const w = fz - j;
    const a = heights[j * nx + i];
    const b = heights[j * nx + i + 1];
    const c = heights[(j + 1) * nx + i];
    const d = heights[(j + 1) * nx + i + 1];
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
  return underside;
}

const material = new MeshLambertMaterial({ vertexColors: true, flatShading: true });
const doubleSided = new MeshLambertMaterial({ vertexColors: true, flatShading: true, side: DoubleSide });

/** Segments along a tear's slit. */
const TEAR_SEGMENTS = 10;
/** The gash is this far under the canvas, m. */
const GASH_DROP = 0.012;
/** How wide the gash gapes at its middle, open and held closed, and how far its torn lips hang down, m. */
const GAPE_OPEN = 0.035;
const GAPE_HELD = 0.006;
const HANG_OPEN = 0.07;
const HANG_HELD = 0.015;

/**
 * One tear: a dark gash along its slit and the two torn lips of canvas
 * hanging from it. Its vertices are laid each frame by `layTear`; the
 * triangles' colours are fixed.
 */
export function createTear(): Mesh {
  const quads = TEAR_SEGMENTS * 3;
  const positions = new Float32Array(quads * 6 * 3);
  const colors = new Float32Array(quads * 6 * 3);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  const gash = [0, 0, 0];
  const flap = [0, 0, 0];
  hexToRgb(GASH, gash);
  hexToRgb(FLAP, flap);
  for (let q = 0; q < quads; q++) {
    const rgb = q < TEAR_SEGMENTS ? gash : flap;
    for (let v = 0; v < 6; v++) colors.set(rgb, (q * 6 + v) * 3);
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const mesh = new Mesh(geometry, doubleSided);
  mesh.name = 'Envelope Tear';
  mesh.frustumCulled = false;
  return mesh;
}

/** A tear's shape this frame. */
export interface TearShape {
  length: number;
  /** 0 gaping open, 1 held shut. */
  held: number;
  /** Seconds, for the lips' flutter in the escaping air. */
  time: number;
}

/**
 * Lay tear `mesh` (from `createTear`) along `spot`'s slit on the canvas,
 * as `shape` says. No allocation.
 */
export function layTear(mesh: Mesh, canvas: CanvasAt, spot: TearSpot, shape: TearShape): void {
  const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
  const a = pos.array as Float32Array;
  const n = TEAR_SEGMENTS;
  const gape = GAPE_OPEN + (GAPE_HELD - GAPE_OPEN) * shape.held;
  const hang = HANG_OPEN + (HANG_HELD - HANG_OPEN) * shape.held;
  // Across the slit: along it turned a quarter.
  const cx = -spot.az;
  const cz = spot.ax;
  let o = 0;
  const put = (x: number, y: number, z: number) => {
    a[o++] = x;
    a[o++] = y;
    a[o++] = z;
  };
  // Each corner of the strip at step i: on the slit (side 0), or on a lip's edge (side ±1), or that lip hanging (±2).
  const corner = (i: number, side: number) => {
    const t = i / n;
    const s = (t - 0.5) * shape.length;
    const bulge = Math.sin(Math.PI * t);
    let x = spot.x + spot.ax * s;
    let z = spot.z + spot.az * s;
    let drop = GASH_DROP;
    if (side !== 0) {
      const lip = Math.sign(side);
      const w = gape * bulge * 0.5;
      x += cx * w * lip;
      z += cz * w * lip;
      if (Math.abs(side) === 2) {
        // The lip hangs down and a little out, fluttering in the air that rushes past it.
        const flutter = 1 + (1 - shape.held) * 0.3 * Math.sin(shape.time * 17 + i * 1.7 + lip);
        drop += hang * bulge * flutter;
        x += cx * w * lip * 0.6;
        z += cz * w * lip * 0.6;
      }
    }
    put(x, canvas(x, z) - drop, z);
  };
  const quad = (i: number, sa: number, sb: number) => {
    corner(i, sa);
    corner(i + 1, sa);
    corner(i + 1, sb);
    corner(i, sa);
    corner(i + 1, sb);
    corner(i, sb);
  };
  // The gash, between the lips' edges.
  for (let i = 0; i < n; i++) quad(i, -1, 1);
  // The two lips.
  for (let i = 0; i < n; i++) quad(i, -1, -2);
  for (let i = 0; i < n; i++) quad(i, 1, 2);
  pos.needsUpdate = true;
}

/** Segments along and across a patch. */
const PATCH_ALONG = 8;
const PATCH_ACROSS = 2;

/** A patch over a tear, laid on the canvas by `layPatch`. */
export function createPatch(): Mesh {
  const quads = PATCH_ALONG * PATCH_ACROSS;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(quads * 6 * 3), 3));
  const colors = new Float32Array(quads * 6 * 3);
  const rgb = [0, 0, 0];
  for (let q = 0; q < quads; q++) {
    hexToRgb(shade(PATCH_COLOR, q % 2 ? 0.94 : 1), rgb);
    for (let v = 0; v < 6; v++) colors.set(rgb, (q * 6 + v) * 3);
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const mesh = new Mesh(geometry, doubleSided);
  mesh.name = 'Envelope Patch';
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Lay a patch `patchLength` long over `spot`'s tear, just under the canvas;
 * `peel` (0 to 1) curls its far end down off it. No allocation.
 */
export function layPatch(mesh: Mesh, canvas: CanvasAt, spot: TearSpot, patchLength: number, peel: number): void {
  const pos = mesh.geometry.getAttribute('position') as BufferAttribute;
  const a = pos.array as Float32Array;
  const cx = -spot.az;
  const cz = spot.ax;
  let o = 0;
  const corner = (i: number, k: number) => {
    const f = i / PATCH_ALONG;
    const along = (f - 0.5) * patchLength;
    const across = (k / PATCH_ACROSS - 0.5) * PATCH_WIDTH;
    const x = spot.x + spot.ax * along + cx * across;
    const z = spot.z + spot.az * along + cz * across;
    // Peeling: the end lifts away from the canvas, more the further along.
    const off = Math.max(0, f - (1 - peel * 0.6)) * patchLength;
    a[o++] = x - spot.ax * off * 0.3;
    a[o++] = canvas(x, z) - PATCH_DROP - off * 0.8;
    a[o++] = z - spot.az * off * 0.3;
  };
  for (let i = 0; i < PATCH_ALONG; i++) {
    for (let k = 0; k < PATCH_ACROSS; k++) {
      corner(i, k);
      corner(i + 1, k);
      corner(i + 1, k + 1);
      corner(i, k);
      corner(i + 1, k + 1);
      corner(i, k + 1);
    }
  }
  pos.needsUpdate = true;
}

/** The rivets, `RIVETS` for each tear spot: brass domes once set, dark holes before. */
export function createRivets(): InstancedMesh {
  // A low dome bulging downwards from its rim.
  const geometry = new SphereGeometry(0.013, 8, 3, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const mesh = new InstancedMesh(geometry, new MeshLambertMaterial({ flatShading: true }), RIVETS * TEAR_SPOTS.length);
  mesh.name = 'Rivets';
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

export const RIVET_COLORS = { set: RIVET_SET, hole: RIVET_HOLE } as const;

/** A folded patch in a hand: lies flat on top of the fist, as it is pressed up onto the canvas. Origin at its middle, flat in X and Z. */
export function createPatchInHand(): Mesh {
  const mesh = new Mesh(
    mergeParts([
      { geometry: new BoxGeometry(0.2, 0.012, 0.16), color: PATCH_COLOR },
      { geometry: new BoxGeometry(0.17, 0.006, 0.13), color: shade(PATCH_COLOR, 0.85), position: [0, 0.009, 0] },
    ]),
    material,
  );
  mesh.name = 'Patch';
  return mesh;
}

/**
 * The riveting hammer: a wooden handle with an iron head across its end.
 * Origin where the fist holds it; the handle runs along -Z to the head,
 * `HAMMER_HEAD` along.
 */
export function createHammer(): Mesh {
  const handle = new CylinderGeometry(0.014, 0.016, HAMMER_HEAD + 0.06, 6);
  handle.rotateX(Math.PI / 2);
  const parts: Part[] = [
    { geometry: handle, color: WOOD, position: [0, 0, (0.06 - HAMMER_HEAD) / 2] },
    { geometry: new BoxGeometry(0.11, 0.035, 0.035), color: IRON, position: [0, 0, -HAMMER_HEAD] },
    // A brighter striking face on each end of the head.
    { geometry: new BoxGeometry(0.008, 0.028, 0.028), color: 0x8a8f96, position: [0.059, 0, -HAMMER_HEAD] },
    { geometry: new BoxGeometry(0.008, 0.028, 0.028), color: 0x8a8f96, position: [-0.059, 0, -HAMMER_HEAD] },
  ];
  const mesh = new Mesh(mergeParts(parts), material);
  mesh.name = 'Hammer';
  return mesh;
}

/** A soft white haze of air rushing out of a tear: points drawn by RepairSystem. */
export function createLeakPuffs(count: number): { geometry: BufferGeometry; positions: Float32Array } {
  const positions = new Float32Array(count * 3);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return { geometry, positions };
}

const tmpColor = new Color();

/** A colour as vertex colours store it (linear, as mergeParts writes them). */
function hexToRgb(hex: number, out: number[]): void {
  tmpColor.setHex(hex);
  out[0] = tmpColor.r;
  out[1] = tmpColor.g;
  out[2] = tmpColor.b;
}
