import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Matrix4,
  Quaternion,
  Vector3,
} from '@iwsdk/core';

/**
 * Helpers for building flat-shaded, vertex-coloured low-poly geometry and
 * merging many parts into one geometry (one draw call). Deterministic: every
 * random choice goes through a seeded generator, because asset modules are
 * evaluated in two realms and must produce identical results.
 */

export { rng } from '../sim/random.js';

export interface Part {
  geometry: BufferGeometry;
  /** One colour for the whole part, or a function per triangle. */
  color: number | ((triangle: number, centroid: Vector3) => number);
  position?: readonly [number, number, number];
  rotation?: readonly [number, number, number];
  scale?: readonly [number, number, number];
}

const tmpMatrix = new Matrix4();
const tmpQuat = new Quaternion();
const tmpEuler = new Euler();
const tmpPos = new Vector3();
const tmpScale = new Vector3();
const tmpColor = new Color();
const centroid = new Vector3();

/**
 * Merge parts into one non-indexed geometry with flat normals and a `color`
 * attribute. Use with a material that has `vertexColors: true`.
 */
export function mergeParts(parts: Part[]): BufferGeometry {
  const prepared: BufferGeometry[] = [];
  let vertexCount = 0;
  for (const part of parts) {
    const g = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
    tmpEuler.set(...(part.rotation ?? [0, 0, 0]));
    tmpQuat.setFromEuler(tmpEuler);
    tmpPos.set(...(part.position ?? [0, 0, 0]));
    tmpScale.set(...(part.scale ?? [1, 1, 1]));
    tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
    g.applyMatrix4(tmpMatrix);
    const pos = g.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let tri = 0; tri < pos.count / 3; tri++) {
      let hex: number;
      if (typeof part.color === 'number') {
        hex = part.color;
      } else {
        centroid.set(0, 0, 0);
        for (let k = 0; k < 3; k++) {
          centroid.x += pos.getX(tri * 3 + k) / 3;
          centroid.y += pos.getY(tri * 3 + k) / 3;
          centroid.z += pos.getZ(tri * 3 + k) / 3;
        }
        hex = part.color(tri, centroid);
      }
      tmpColor.setHex(hex);
      for (let k = 0; k < 3; k++) {
        colors[(tri * 3 + k) * 3] = tmpColor.r;
        colors[(tri * 3 + k) * 3 + 1] = tmpColor.g;
        colors[(tri * 3 + k) * 3 + 2] = tmpColor.b;
      }
    }
    g.setAttribute('color', new BufferAttribute(colors, 3));
    prepared.push(g);
    vertexCount += pos.count;
  }

  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  let offset = 0;
  for (const g of prepared) {
    const pos = g.getAttribute('position').array as ArrayLike<number>;
    const col = g.getAttribute('color').array as ArrayLike<number>;
    positions.set(pos, offset);
    colors.set(col, offset);
    offset += pos.length;
    g.dispose();
  }
  const merged = new BufferGeometry();
  merged.setAttribute('position', new BufferAttribute(positions, 3));
  merged.setAttribute('color', new BufferAttribute(colors, 3));
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Move every vertex by a random amount, keeping shared corners together. */
export function jitter(geometry: BufferGeometry, amount: number, random: () => number): BufferGeometry {
  const pos = geometry.getAttribute('position');
  const offsets = new Map<string, [number, number, number]>();
  for (let i = 0; i < pos.count; i++) {
    const key = cornerKey(pos.getX(i), pos.getY(i), pos.getZ(i));
    let o = offsets.get(key);
    if (!o) {
      o = [(random() - 0.5) * amount, (random() - 0.5) * amount, (random() - 0.5) * amount];
      offsets.set(key, o);
    }
    pos.setXYZ(i, pos.getX(i) + o[0], pos.getY(i) + o[1], pos.getZ(i) + o[2]);
  }
  pos.needsUpdate = true;
  return geometry;
}

/**
 * Which corner a vertex sits on, to 0.1 mm. Rounds to integers rather than
 * using toFixed, which writes a tiny negative such as sin(2π) as "-0.0000"
 * and so split the closing seam of every cylinder and cone in two.
 */
export function cornerKey(x: number, y: number, z: number): string {
  return `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
}

/** Shade a colour by a factor (0.8 = 20% darker). */
export function shade(hex: number, factor: number): number {
  tmpColor.setHex(hex).multiplyScalar(factor);
  return tmpColor.getHex();
}

/** Pick from a list with the generator. */
export function pick<T>(list: readonly T[], random: () => number): T {
  return list[Math.floor(random() * list.length) % list.length];
}

export function triangleCount(geometry: BufferGeometry): number {
  return (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
}

const beamUp = new Vector3(0, 1, 0);
const beamDir = new Vector3();
const beamQuat = new Quaternion();

/** A thin cylinder from a to b. */
export function beam(a: readonly number[], b: readonly number[], radius: number, color: number, sides = 5): Part {
  const start = new Vector3(a[0], a[1], a[2]);
  const end = new Vector3(b[0], b[1], b[2]);
  beamDir.subVectors(end, start);
  const length = beamDir.length();
  const geometry = new CylinderGeometry(radius, radius, length, sides, 1);
  beamQuat.setFromUnitVectors(beamUp, beamDir.normalize());
  geometry.applyQuaternion(beamQuat);
  const mid = start.add(end).multiplyScalar(0.5);
  geometry.translate(mid.x, mid.y, mid.z);
  return { geometry, color };
}
