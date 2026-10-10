import { Quaternion, Vector3 } from '@iwsdk/core';
import { afterEach, describe, expect, it } from 'vitest';
import { FIST_AXIS, FIST_CENTRE, FOREARM } from '../src/scene-assets/hand.scene-asset.js';
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

/** A right hand's fist hole axis, forearm and fist centre for a grip pose. */
const fistAxis = (q: Quaternion) => new Vector3(...FIST_AXIS).applyQuaternion(q);
const forearm = (q: Quaternion) => new Vector3(...FOREARM).applyQuaternion(q);
const fistCentre = (p: Vector3, q: Quaternion) => new Vector3(...FIST_CENTRE).applyQuaternion(q).add(p);

describe('grip locking', () => {
  afterEach(() => lockResolvers.clear());

  const hand = new Vector3(0.45, 1.05, -0.45);
  // The fist's hole tilted 30° off the crank's rod, about Y.
  const quat = new Quaternion()
    .setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 6)
    .multiply(new Quaternion().setFromUnitVectors(new Vector3(...FIST_AXIS).normalize(), new Vector3(1, 0, 0)));

  it('draws the hand at the controller while it holds nothing', () => {
    registerHandle();
    const lock = new LockedHand();
    const pos = new Vector3();
    const q = new Quaternion();
    lock.update(0.011, HoldKind.None, hand, quat, pos, q, null);
    expect(pos.distanceTo(hand)).toBe(0);
    expect(q.angleTo(quat)).toBe(0);
  });

  it('eases onto the handle over 80 ms, closes the fingers and puts the handle through the fist', () => {
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
    expect(fistCentre(pos, q).distanceTo(HANDLE)).toBeLessThan(1e-6);
    expect(curls.grip).toBe(1);
    expect(curls.index).toBeGreaterThan(0.85);
    expect(curls.thumb).toBe(1);
    // The fist's hole lies along the rod, turned no more than it takes (30°).
    expect(Math.abs(fistAxis(q).normalize().x)).toBeCloseTo(1, 5);
    expect((q.angleTo(quat) * 180) / Math.PI).toBeCloseTo(30, 3);
    expect(lock.strain).toBeCloseTo(fistCentre(hand, quat).distanceTo(HANDLE), 6);
  });

  it('keeps the twist about the handle the hand takes it with', () => {
    registerHandle();
    const lock = new LockedHand();
    const pos = new Vector3();
    const q = new Quaternion();
    // The same hand rolled 40° about its fist's hole.
    const rolled = quat.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(...FIST_AXIS).normalize(), 0.7));
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
    expect(fistCentre(pos, q).distanceTo(HANDLE)).toBeGreaterThan(0.001);
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

  it('angles the arm on the tiller back towards the player holding it from inside the gondola', () => {
    // The tiller's bar runs fore and aft; the player stands to starboard of it, facing the stern.
    lockResolvers.set(HoldKind.Tiller, (_hand, point, axis) => {
      point.set(0, 0.86, 0.85);
      axis.set(0, 0, 1);
    });
    const body = { head: new Vector3(0.4, 1.6, 0.6), yaw: Math.PI };
    // Whatever way the controller happens to be turned, the bar goes through the fist...
    for (const controller of [quat, new Quaternion(), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -1)]) {
      const lock = new LockedHand('left');
      const pos = new Vector3();
      const q = new Quaternion();
      for (let i = 0; i < 10; i++) lock.update(0.011, HoldKind.Tiller, new Vector3(0.05, 0.9, 0.85), controller, pos, q, null, body);
      const hole = new Vector3(-FIST_AXIS[0], FIST_AXIS[1], FIST_AXIS[2]).normalize().applyQuaternion(q);
      expect(Math.abs(hole.z)).toBeCloseTo(1, 5);
      // ...and the forearm comes back out to starboard, towards the player, not down through the deck.
      const arm = new Vector3(-FOREARM[0], FOREARM[1], FOREARM[2]).applyQuaternion(q);
      expect(arm.x).toBeGreaterThan(0.6);
      expect(arm.y).toBeGreaterThan(-0.3);
    }
  });

  it('leans both arms back the way they pull on the line', () => {
    // The line runs fore and aft along the port rail; the player faces the bow and hauls it aft.
    lockResolvers.set(HoldKind.Rope, (hand, point, axis) => {
      point.set(-0.85, 0.95, hand.z);
      axis.set(0, 0, 1);
    });
    const body = { head: new Vector3(-0.4, 1.6, 0.35), yaw: 0 };
    for (const [side, z] of [['left', -0.35], ['right', -0.05]] as const) {
      const lock = new LockedHand(side);
      const pos = new Vector3();
      const q = new Quaternion();
      for (let i = 0; i < 10; i++) lock.update(0.011, HoldKind.Rope, new Vector3(-0.85, 0.95, z), quat, pos, q, null, body);
      const m = side === 'left' ? -1 : 1;
      const arm = new Vector3(FOREARM[0] * m, FOREARM[1], FOREARM[2]).applyQuaternion(q);
      // Back towards the stern and in from the rail, towards the player.
      expect(arm.z).toBeGreaterThan(0.3);
      expect(arm.x).toBeGreaterThan(0.15);
      // The line still passes through the fist.
      const centre = new Vector3(FIST_CENTRE[0] * m, FIST_CENTRE[1], FIST_CENTRE[2]).applyQuaternion(q).add(pos);
      expect(centre.distanceTo(new Vector3(-0.85, 0.95, z))).toBeLessThan(0.02);
    }
  });
});
