import { type BufferGeometry, Mesh, type Object3D, Vector3 } from '@iwsdk/core';

/**
 * Finds z-fighting in static geometry: two triangles of different colours
 * facing the same way, lying in (nearly) the same plane and overlapping.
 * The depth buffer can't tell which is in front, so the headset shows them
 * flickering through each other as the head moves. Faces facing opposite
 * ways don't count (back faces are culled), nor do same-coloured faces
 * (nothing to see), nor triangles that only touch along an edge.
 */

export interface CoplanarOverlap {
  /** The two meshes (the same name twice: within one merged mesh). */
  a: string;
  b: string;
  /** How far apart the planes are, m, and how much of them overlaps, m². */
  gap: number;
  area: number;
  /** Where (the middle of the overlap), and which way they face. */
  at: [number, number, number];
  normal: [number, number, number];
}

interface Tri {
  owner: string;
  p: [Vector3, Vector3, Vector3];
  n: Vector3;
  d: number;
  colour: string;
}

function colourKey(geometry: BufferGeometry, indices: number[], material: string): string {
  const colour = geometry.getAttribute('color');
  if (!colour) return material;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const i of indices) {
    r += colour.getX(i);
    g += colour.getY(i);
    b += colour.getZ(i);
  }
  return `${material}:${(r / 3).toFixed(2)},${(g / 3).toFixed(2)},${(b / 3).toFixed(2)}`;
}

/** Every visible triangle under `root`, in `root`'s parent's space (call updateMatrixWorld first). */
export function trianglesOf(root: Object3D, name = root.name): Tri[] {
  const out: Tri[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!(o instanceof Mesh) || !o.visible) return;
    const geometry = o.geometry as BufferGeometry;
    const pos = geometry.getAttribute('position');
    const index = geometry.index;
    const count = index ? index.count : pos.count;
    const material = Array.isArray(o.material) ? o.material[0] : o.material;
    const materialKey = `${material.uuid}${'color' in material && !material.vertexColors ? `:${(material.color as { getHexString(): string }).getHexString()}` : ''}`;
    for (let t = 0; t + 2 < count; t += 3) {
      const ids = [0, 1, 2].map((k) => (index ? index.getX(t + k) : t + k));
      const p = ids.map((i) => new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(o.matrixWorld)) as Tri['p'];
      const n = new Vector3().subVectors(p[1], p[0]).cross(new Vector3().subVectors(p[2], p[0]));
      const len = n.length();
      if (len < 1e-10) continue;
      n.divideScalar(len);
      out.push({ owner: `${name}${o !== root && o.name ? `/${o.name}` : ''}`, p, n, d: n.dot(p[0]), colour: colourKey(geometry, ids, materialKey) });
    }
  });
  return out;
}

/** The overlap of two triangles in one plane (normal `n`): its area, m², and its middle. */
function overlap(a: Tri['p'], b: Tri['p'], n: Vector3): { area: number; at: Vector3 } {
  const u = Math.abs(n.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
  const v = new Vector3().crossVectors(n, u);
  const flat = (t: Tri['p']) => {
    const pts = t.map((q) => [q.dot(u), q.dot(v)] as [number, number]);
    // Counter-clockwise.
    const cross = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[1][1] - pts[0][1]) * (pts[2][0] - pts[0][0]);
    return cross < 0 ? [pts[0], pts[2], pts[1]] : pts;
  };
  let poly = flat(a);
  const clip = flat(b);
  for (let i = 0; i < 3 && poly.length > 0; i++) {
    const [ax, ay] = clip[i];
    const [bx, by] = clip[(i + 1) % 3];
    const side = (q: [number, number]) => (bx - ax) * (q[1] - ay) - (by - ay) * (q[0] - ax);
    const next: [number, number][] = [];
    for (let j = 0; j < poly.length; j++) {
      const p = poly[j];
      const q = poly[(j + 1) % poly.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) next.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        next.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    poly = next;
  }
  let area = 0;
  let cu = 0;
  let cv = 0;
  for (let j = 0; j < poly.length; j++) {
    const p = poly[j];
    const q = poly[(j + 1) % poly.length];
    const c = p[0] * q[1] - q[0] * p[1];
    area += c;
    cu += (p[0] + q[0]) * c;
    cv += (p[1] + q[1]) * c;
  }
  const at = n.clone().multiplyScalar(n.dot(a[0]));
  if (Math.abs(area) > 1e-12) {
    at.addScaledVector(u, cu / (3 * area)).addScaledVector(v, cv / (3 * area));
  }
  return { area: Math.abs(area) / 2, at };
}

/**
 * Pairs of differently coloured triangles facing the same way within `gap`
 * of each other's plane that overlap by more than `minArea`, except where
 * `ignore` says the overlap (its middle, and which way it faces) can never
 * be seen.
 */
export function coplanarOverlaps(
  tris: Tri[],
  gap: number,
  minArea = 2e-5,
  ignore?: (at: Vector3, normal: Vector3) => boolean,
): CoplanarOverlap[] {
  const buckets = new Map<string, Tri[]>();
  for (const t of tris) {
    const key = `${Math.round(t.n.x * 40)},${Math.round(t.n.y * 40)},${Math.round(t.n.z * 40)}`;
    let list = buckets.get(key);
    if (!list) buckets.set(key, (list = []));
    list.push(t);
  }
  const found: CoplanarOverlap[] = [];
  const middle = new Vector3();
  for (const list of buckets.values()) {
    list.sort((x, y) => x.d - y.d);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length && list[j].d - a.d <= gap; j++) {
        const b = list[j];
        if (a.colour === b.colour || a.n.dot(b.n) < 0.999) continue;
        // The planes' offsets from the origin differ by more than their real separation when the
        // normals differ a little and the faces are metres from the origin (the envelope's belly):
        // measure how far b's middle is off a's plane instead.
        const separation = Math.abs(a.n.dot(middle.copy(b.p[0]).add(b.p[1]).add(b.p[2]).divideScalar(3)) - a.d);
        if (separation > gap) continue;
        const { area, at } = overlap(a.p, b.p, a.n);
        if (area > minArea && !(ignore && ignore(at, a.n))) {
          found.push({ a: a.owner, b: b.owner, gap: separation, area, at: [at.x, at.y, at.z], normal: [a.n.x, a.n.y, a.n.z] });
        }
      }
    }
  }
  return found;
}

/** One line per overlap, for a test's failure message. */
export function describeOverlaps(found: CoplanarOverlap[], limit = 30): string {
  const f = (v: number) => v.toFixed(3);
  return found
    .slice(0, limit)
    .map((o) => `${o.a} × ${o.b}: ${(o.gap * 1000).toFixed(1)} mm apart, ${(o.area * 1e4).toFixed(1)} cm² at (${o.at.map(f).join(', ')}) facing (${o.normal.map((v) => v.toFixed(2)).join(', ')})`)
    .join('\n');
}
