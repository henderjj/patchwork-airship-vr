import { describe, expect, it } from 'vitest';
import { fingerCurl, HandGrip, JOINT_COUNT } from '../src/sim/hand-grip.js';

/** Bone lengths from each finger's metacarpal joint to its tip, m. */
const BONES = [0.065, 0.04, 0.025, 0.02];

/**
 * A right hand in its own space (fingers along -z, palm facing -y) with every
 * finger joint bent by `bend` radians and the thumb tip `pinchGap` from the
 * index tip.
 */
function handJoints(bend: number, pinchGap = 0.08): Float32Array {
  const m = new Float32Array(JOINT_COUNT * 16);
  const set = (joint: number, x: number, y: number, z: number) => {
    m[joint * 16 + 12] = x;
    m[joint * 16 + 13] = y;
    m[joint * 16 + 14] = z;
  };
  for (let finger = 0; finger < 4; finger++) {
    const base = 5 + finger * 5;
    let x = -0.03 + finger * 0.02, y = 0, z = 0, angle = 0;
    set(base, x, y, z);
    for (let bone = 0; bone < 4; bone++) {
      // The metacarpal stays in the palm; each later joint bends towards it.
      if (bone > 0) angle += bend;
      z -= BONES[bone] * Math.cos(angle);
      y -= BONES[bone] * Math.sin(angle);
      set(base + bone + 1, x, y, z);
    }
  }
  const indexTip = 9 * 16 + 12;
  set(4, m[indexTip] + pinchGap, m[indexTip + 1], m[indexTip + 2]);
  return m;
}

describe('fingerCurl', () => {
  it('is 1 for a straight finger and about 0.4 in a fist', () => {
    expect(fingerCurl(handJoints(0), 5)).toBeCloseTo(1, 5);
    const fist = fingerCurl(handJoints(1.4), 5);
    expect(fist).toBeGreaterThan(0.25);
    expect(fist).toBeLessThan(0.5);
  });
});

describe('HandGrip', () => {
  it('grips on a fist and lets go only once the hand opens well past the threshold', () => {
    const grip = new HandGrip();
    expect(grip.update(handJoints(0))).toBe(false);
    expect(grip.update(handJoints(0.6))).toBe(false); // relaxed, half curled
    expect(grip.update(handJoints(1.4))).toBe(true);
    expect(grip.fist).toBe(true);
    // Between the thresholds: still gripping.
    expect(grip.update(handJoints(0.75))).toBe(true);
    expect(grip.update(handJoints(0.3))).toBe(false);
  });

  it('grips on a pinch with hysteresis', () => {
    const grip = new HandGrip();
    expect(grip.update(handJoints(0, 0.03))).toBe(false);
    expect(grip.update(handJoints(0, 0.01))).toBe(true);
    expect(grip.pinch).toBe(true);
    expect(grip.update(handJoints(0, 0.03))).toBe(true);
    expect(grip.update(handJoints(0, 0.05))).toBe(false);
  });
});
