import { Quaternion, Vector3 } from '@iwsdk/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createFingerCurls } from '../src/sim/hand-pose.js';
import { HoldKind, LOCK_EASE, LockedHand, lockResolvers } from '../src/systems/hand-lock.js';

const HANDLE = new Vector3(0.4, 1.0, -0.5);

/** A crank-like handle running along X at HANDLE. */
function registerHandle(): void {
  lockResolvers.set(HoldKind.Crank, (_hand, point, axis) => {
    point.copy(HANDLE);
    axis.set(1, 0, 0);
  });
}

describe('grip locking', () => {
  afterEach(() => lockResolvers.clear());

  const hand = new Vector3(0.45, 1.05, -0.45);
  // The controller's handle (grip -Z) tilted 30° off the crank's rod, about Y.
  const quat = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2 + Math.PI / 6);

  it('draws the hand at the controller while it holds nothing', () => {
    registerHandle();
    const lock = new LockedHand();
    const pos = new Vector3();
    const q = new Quaternion();
    lock.update(0.011, HoldKind.None, hand, quat, pos, q, null);
    expect(pos.distanceTo(hand)).toBe(0);
    expect(q.angleTo(quat)).toBe(0);
  });

  it('eases onto the handle over 80 ms, closes the fingers and lines the hand up with the handle', () => {
    registerHandle();
    const lock = new LockedHand();
    const pos = new Vector3();
    const q = new Quaternion();
    const curls = createFingerCurls(0.12, 0.5, 0);
    lock.update(0.02, HoldKind.Crank, hand, quat, pos, q, curls);
    // Part of the way after one short frame.
    expect(pos.distanceTo(HANDLE)).toBeGreaterThan(0.005);
    expect(pos.distanceTo(hand)).toBeGreaterThan(0.005);
    let frames = 0;
    for (let t = 0.02; t < LOCK_EASE + 1e-9; t += 0.011) {
      curls.index = 0.12;
      curls.grip = 0.5;
      curls.thumb = 0;
      lock.update(0.011, HoldKind.Crank, hand, quat, pos, q, curls);
      frames++;
    }
    expect(frames).toBeLessThan(10);
    expect(lock.blend).toBe(1);
    expect(pos.distanceTo(HANDLE)).toBeLessThan(1e-6);
    expect(curls.grip).toBe(1);
    expect(curls.index).toBeGreaterThan(0.85);
    expect(curls.thumb).toBe(1);
    // The drawn handle axis lies along the rod, turned no more than it takes (30°).
    const along = new Vector3(0, 0, -1).applyQuaternion(q);
    expect(Math.abs(along.x)).toBeCloseTo(1, 5);
    expect((q.angleTo(quat) * 180) / Math.PI).toBeCloseTo(30, 3);
    expect(lock.strain).toBeCloseTo(hand.distanceTo(HANDLE), 6);
  });

  it('keeps the twist about the handle the hand takes it with', () => {
    registerHandle();
    const lock = new LockedHand();
    const pos = new Vector3();
    const q = new Quaternion();
    // The same hand rolled 40° about its own handle axis.
    const rolled = quat.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.7));
    for (let i = 0; i < 10; i++) lock.update(0.011, HoldKind.Crank, hand, rolled, pos, q, null);
    const plain = new Quaternion();
    const lock2 = new LockedHand();
    for (let i = 0; i < 10; i++) lock2.update(0.011, HoldKind.Crank, hand, quat, pos, plain, null);
    expect((q.angleTo(plain) * 180) / Math.PI).toBeCloseTo(40, 0);
  });

  it('eases back to the controller on letting go', () => {
    registerHandle();
    const lock = new LockedHand();
    const pos = new Vector3();
    const q = new Quaternion();
    for (let i = 0; i < 10; i++) lock.update(0.011, HoldKind.Crank, hand, quat, pos, q, null);
    lock.update(0.011, HoldKind.None, hand, quat, pos, q, null);
    expect(pos.distanceTo(HANDLE)).toBeGreaterThan(0.001);
    expect(pos.distanceTo(hand)).toBeGreaterThan(0.001);
    for (let i = 0; i < 10; i++) lock.update(0.011, HoldKind.None, hand, quat, pos, q, null);
    expect(lock.blend).toBe(0);
    expect(pos.distanceTo(hand)).toBe(0);
    expect(lock.strain).toBe(0);
  });

  it('leaves a hand alone when nothing says where its control is', () => {
    const lock = new LockedHand();
    const pos = new Vector3();
    const q = new Quaternion();
    lock.update(0.1, HoldKind.Tiller, hand, quat, pos, q, null);
    expect(pos.distanceTo(hand)).toBe(0);
  });
});
