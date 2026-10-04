import { Euler, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  createShipState,
  GRAVITY,
  MOTION_PROFILES,
  stepShip,
  updateFeltGravity,
  updateQuaternion,
} from '../src/sim/ship-motion.js';

function threeQuat(yaw: number, pitch: number, roll: number): Quaternion {
  return new Quaternion().setFromEuler(new Euler(pitch, yaw, -roll, 'YXZ'));
}

describe('ship orientation', () => {
  it('matches three.js YXZ Euler composition', () => {
    const s = createShipState();
    for (const [yaw, pitch, roll] of [
      [0.3, 0.05, -0.04],
      [-2.1, -0.07, 0.06],
      [3.0, 0.0, 0.12],
    ]) {
      s.yaw = yaw;
      s.pitch = pitch;
      s.roll = roll;
      updateQuaternion(s);
      const q = threeQuat(yaw, pitch, roll);
      expect(Math.abs(q.dot(new Quaternion(s.qx, s.qy, s.qz, s.qw)))).toBeCloseTo(1, 6);
    }
  });

  it('felt gravity is true gravity rotated into the ship frame', () => {
    const s = createShipState();
    s.yaw = 1.2;
    s.pitch = 0.04;
    s.roll = 0.07;
    s.ax = 0.3;
    s.ay = -0.1;
    s.az = 0.2;
    updateQuaternion(s);
    updateFeltGravity(s);
    const q = threeQuat(s.yaw, s.pitch, s.roll);
    const expected = new Vector3(-0.3, -GRAVITY + 0.1, -0.2).applyQuaternion(q.clone().invert());
    expect(s.gx).toBeCloseTo(expected.x, 6);
    expect(s.gy).toBeCloseTo(expected.y, 6);
    expect(s.gz).toBeCloseTo(expected.z, 6);
  });

  it('roll starboard-down makes loose objects slide to starboard (+X)', () => {
    const s = createShipState();
    s.roll = 0.05;
    updateQuaternion(s);
    updateFeltGravity(s);
    expect(s.gx).toBeGreaterThan(0);
  });

  it('nose-up pitch makes loose objects slide aft (+Z)', () => {
    const s = createShipState();
    s.pitch = 0.05;
    updateQuaternion(s);
    updateFeltGravity(s);
    expect(s.gz).toBeGreaterThan(0);
  });
});

describe('scripted flight', () => {
  for (const name of ['gentle', 'tour', 'lively']) {
    it(`${name} stays inside its comfort limits for ten minutes`, () => {
      const profile = MOTION_PROFILES[name];
      const s = createShipState();
      let maxTilt = 0;
      let maxHorizontalAccel = 0;
      let maxYawRate = 0;
      let maxJerk = 0;
      let lastYaw = 0;
      let lastAx = 0;
      let lastAz = 0;
      const dt = 1 / 90;
      for (let i = 0; i < 90 * 600; i++) {
        stepShip(s, profile, dt);
        maxTilt = Math.max(maxTilt, Math.abs(s.pitch), Math.abs(s.roll));
        if (i > 90) {
          maxHorizontalAccel = Math.max(maxHorizontalAccel, Math.hypot(s.ax, s.az));
          maxYawRate = Math.max(maxYawRate, Math.abs(s.yaw - lastYaw) / dt);
          maxJerk = Math.max(maxJerk, Math.hypot(s.ax - lastAx, s.az - lastAz) / dt);
        }
        lastYaw = s.yaw;
        lastAx = s.ax;
        lastAz = s.az;
      }
      expect((maxTilt * 180) / Math.PI).toBeLessThanOrEqual(profile.maxTiltDeg + 1e-6);
      expect((maxYawRate * 180) / Math.PI).toBeLessThanOrEqual(profile.maxYawRateDeg + 1e-6);
      // Sideways acceleration comes from turning plus gusts; no sudden jolts.
      const turning = profile.speed * ((profile.maxYawRateDeg * Math.PI) / 180);
      expect(maxHorizontalAccel).toBeLessThan(turning + 0.4 * profile.gust + 0.3);
      expect(maxJerk).toBeLessThan(1.5);
      expect(Number.isFinite(s.x + s.y + s.z)).toBe(true);
    });
  }

  it('banks into turns, so the deck feels less sideways pull than the turn makes', () => {
    // Without gusts, the only sideways pull is the turn's; a gondola hanging
    // from its envelope leans into it, so the felt gravity across the deck
    // must be smaller than the turn's acceleration, never larger.
    const profile = { ...MOTION_PROFILES.lively, gust: 0 };
    const s = createShipState();
    let worstRatio = 0;
    for (let i = 0; i < 90 * 200; i++) {
      stepShip(s, profile, 1 / 90);
      const turning = Math.hypot(s.ax, s.az);
      if (i > 90 * 60 && turning > 0.5) {
        worstRatio = Math.max(worstRatio, Math.abs(s.gx) / turning);
      }
    }
    expect(worstRatio).toBeGreaterThan(0);
    expect(worstRatio).toBeLessThan(1);
  });

  it('switching profile mid-flight eases in without a jolt', () => {
    const s = createShipState();
    let maxAccel = 0;
    for (let i = 0; i < 90 * 120; i++) {
      const profile = i < 90 * 30 ? MOTION_PROFILES.still : i < 90 * 60 ? MOTION_PROFILES.lively : MOTION_PROFILES.gentle;
      stepShip(s, profile, 1 / 90);
      maxAccel = Math.max(maxAccel, Math.hypot(s.ax, s.ay, s.az));
    }
    expect(maxAccel).toBeLessThan(3);
  });

  it('still profile does not move', () => {
    const s = createShipState();
    for (let i = 0; i < 900; i++) {
      stepShip(s, MOTION_PROFILES.still, 1 / 90);
    }
    expect([s.x, s.y, s.z]).toEqual([0, 120, 0]);
    expect(s.gy).toBeCloseTo(-GRAVITY, 6);
  });
});
