import { describe, expect, it } from 'vitest';
import { MAX_THROW_SPEED, ReleaseVelocityTracker } from '../src/sim/release-velocity.js';

describe('release velocity', () => {
  it('recovers a steady throw from uneven frame times', () => {
    const tracker = new ReleaseVelocityTracker();
    let t = 0;
    const frames = [11, 11, 22, 11, 33, 11, 11, 11];
    for (const dt of frames) {
      t += dt;
      tracker.push(t, 2 * (t / 1000), 1 + 3 * (t / 1000), -1 * (t / 1000));
    }
    const v: [number, number, number] = [0, 0, 0];
    tracker.velocity(v);
    expect(v[0]).toBeCloseTo(2, 5);
    expect(v[1]).toBeCloseTo(3, 5);
    expect(v[2]).toBeCloseTo(-1, 5);
  });

  it('is zero for a still hand and with too little history', () => {
    const tracker = new ReleaseVelocityTracker();
    const v: [number, number, number] = [9, 9, 9];
    tracker.push(0, 1, 1, 1);
    tracker.velocity(v);
    expect(v).toEqual([0, 0, 0]);
    for (let i = 1; i < 10; i++) tracker.push(i * 11, 1, 1, 1);
    tracker.velocity(v);
    expect(v.map((c) => Math.abs(c))).toEqual([0, 0, 0]);
  });

  it('ignores motion older than the window', () => {
    const tracker = new ReleaseVelocityTracker();
    // Fast swing long ago, then still for 200 ms.
    for (let i = 0; i < 5; i++) tracker.push(i * 11, i * 0.1, 0, 0);
    for (let i = 0; i < 18; i++) tracker.push(55 + i * 11, 0.4, 0, 0);
    const v: [number, number, number] = [0, 0, 0];
    tracker.velocity(v);
    expect(Math.abs(v[0])).toBeLessThan(1e-9);
  });

  it('clamps absurd speeds', () => {
    const tracker = new ReleaseVelocityTracker();
    for (let i = 0; i < 6; i++) tracker.push(i * 11, i * 1, 0, 0);
    const v: [number, number, number] = [0, 0, 0];
    tracker.velocity(v);
    expect(Math.hypot(...v)).toBeCloseTo(MAX_THROW_SPEED, 5);
  });
});
