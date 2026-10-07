import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { clampStep, turnAboutHead, WALK_HALF_LENGTH, WALK_HALF_WIDTH, WALK_SPEED } from '../src/sim/deck-walk.js';
import { DECK_LENGTH, DECK_WIDTH } from '../src/sim/gondola-layout.js';

/** Walk the head forwards (towards the bow, -Z) for `seconds` from `startZ`. */
function walkForward(startZ: number, seconds: number): number {
  let z = startZ;
  for (let t = 0; t < seconds; t += 1 / 90) {
    z += clampStep(z, -WALK_SPEED / 90, WALK_HALF_LENGTH);
  }
  return z;
}

describe('deck walking bounds', () => {
  it('lets the head reach the bow and stern whatever the play-space offset', () => {
    // Start anywhere on the deck (as if standing anywhere in the room).
    for (const startZ of [-1, -0.5, 0, 0.5, 1]) {
      expect(walkForward(startZ, 3)).toBeCloseTo(-WALK_HALF_LENGTH, 6);
    }
    expect(WALK_HALF_LENGTH).toBeGreaterThan(DECK_LENGTH / 2 - 0.3);
    expect(WALK_HALF_WIDTH).toBeGreaterThan(DECK_WIDTH / 2 - 0.3);
  });

  it('stops at the bound and slides along it', () => {
    expect(clampStep(0.7, 0.2, WALK_HALF_WIDTH)).toBeCloseTo(WALK_HALF_WIDTH - 0.7, 9);
    expect(clampStep(-0.7, -0.2, WALK_HALF_WIDTH)).toBeCloseTo(-WALK_HALF_WIDTH + 0.7, 9);
    expect(clampStep(0, 0.1, WALK_HALF_WIDTH)).toBe(0.1);
    expect(clampStep(0, 0, WALK_HALF_WIDTH)).toBe(0);
  });

  it('never pushes a head that walked outside in the room, but lets it back in', () => {
    const outside = WALK_HALF_LENGTH + 0.2;
    expect(clampStep(outside, 0.05, WALK_HALF_LENGTH)).toBe(0);
    expect(clampStep(outside, -0.05, WALK_HALF_LENGTH)).toBe(-0.05);
    expect(clampStep(-outside, -0.05, WALK_HALF_LENGTH)).toBe(0);
    expect(clampStep(-outside, 0.05, WALK_HALF_LENGTH)).toBe(0.05);
  });
});

describe('snap turn about the head', () => {
  it('keeps the head where it was', () => {
    for (const angle of [Math.PI / 4, -Math.PI / 4, Math.PI]) {
      const rig = new Object3D();
      rig.position.set(0.2, 0, -0.3);
      rig.rotation.y = 0.7;
      const head = new Object3D();
      head.position.set(0.4, 1.6, -0.8); // standing away from the room's middle
      rig.add(head);
      rig.updateMatrixWorld(true);
      const before = head.getWorldPosition(new Vector3());

      const out: [number, number] = [0, 0];
      turnAboutHead(rig.position.x, rig.position.z, before.x, before.z, angle, out);
      rig.rotateY(angle);
      rig.position.x = out[0];
      rig.position.z = out[1];
      rig.updateMatrixWorld(true);
      const after = head.getWorldPosition(new Vector3());

      expect(after.x).toBeCloseTo(before.x, 9);
      expect(after.z).toBeCloseTo(before.z, 9);
      expect(rig.rotation.y).not.toBeCloseTo(0.7, 3);
    }
  });
});
