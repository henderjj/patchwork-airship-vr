import { ConeGeometry, CylinderGeometry, type BufferGeometry } from '@iwsdk/core';
import { describe, expect, it } from 'vitest';
import { cornerKey, jitter, rng } from '../src/scene-assets/lowpoly.js';
import { CALM_SKIES } from '../src/sim/route.js';
import { createLandingIslandGeometry } from '../src/world/route-assets.js';
import { createIslandVariant } from '../src/world/sky-assets.js';

/** Edges used by only one triangle (or an odd number): the cracks you can see sky through. */
function openEdges(geometry: BufferGeometry): number {
  const pos = geometry.getAttribute('position');
  const triangles = geometry.index ? geometry.index.count / 3 : pos.count / 3;
  const vertex = (t: number, k: number) => (geometry.index ? geometry.index.getX(t * 3 + k) : t * 3 + k);
  const uses = new Map<string, number>();
  for (let t = 0; t < triangles; t++) {
    const corners = [0, 1, 2].map((k) => {
      const i = vertex(t, k);
      return cornerKey(pos.getX(i), pos.getY(i), pos.getZ(i));
    });
    if (new Set(corners).size < 3) {
      continue;
    }
    for (let k = 0; k < 3; k++) {
      const a = corners[k];
      const b = corners[(k + 1) % 3];
      const edge = a < b ? `${a}|${b}` : `${b}|${a}`;
      uses.set(edge, (uses.get(edge) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const count of uses.values()) {
    if (count % 2 !== 0) {
      open++;
    }
  }
  return open;
}

describe('island geometry', () => {
  it('keeps the closing seam of a jittered cylinder and cone shut', () => {
    const cylinder = jitter(new CylinderGeometry(1, 0.96, 0.18, 11, 1), 0.12, rng(4));
    const cone = jitter(new ConeGeometry(0.96, 1.5, 11, 4).rotateX(Math.PI), 0.22, rng(5));
    expect(openEdges(cylinder)).toBe(0);
    expect(openEdges(cone)).toBe(0);
  });

  it('builds islands with no gaps between neighbouring faces', () => {
    for (const seed of [10, 11, 12, 13, 31, 77]) {
      const { high, low } = createIslandVariant(seed);
      expect(openEdges(high), `seed ${seed} high`).toBe(0);
      expect(openEdges(low), `seed ${seed} low`).toBe(0);
    }
    for (const island of [CALM_SKIES.start, CALM_SKIES.finish]) {
      expect(openEdges(createLandingIslandGeometry(island, 0xffffff, 1)), `landing island ${island.name}`).toBe(0);
    }
  });
});
