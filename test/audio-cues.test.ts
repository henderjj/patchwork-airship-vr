import { describe, expect, it } from 'vitest';
import { CreakTimer, creakRate, ratchetClicks, RATCHET_TEETH, strain, touchedDown, windGust, windSound } from '../src/sim/audio-cues.js';
import { createShipState, MOTION_PROFILES, stepShip } from '../src/sim/ship-motion.js';
import { rng } from '../src/sim/random.js';

const DEG = Math.PI / 180;
const LIMITS = { tiltRate: 3 * DEG, yawAccel: 2 * DEG, accel: 0.4 };

describe('audio cues', () => {
  it('clicks the ratchet once per tooth, either way round', () => {
    expect(ratchetClicks(0, Math.PI * 2)).toBe(RATCHET_TEETH);
    expect(ratchetClicks(Math.PI * 2, 0)).toBe(RATCHET_TEETH);
    expect(ratchetClicks(0.01, 0.02)).toBe(0);
    // Across the start of a turn.
    expect(ratchetClicks(-0.05, 0.05)).toBe(1);
  });

  it('grows the wind louder and brighter with speed', () => {
    const still = windSound(0, 0);
    const cruise = windSound(4, 0);
    const full = windSound(7, 0);
    expect(still.gain).toBeGreaterThan(0);
    expect(cruise.gain).toBeGreaterThan(still.gain);
    expect(full.gain).toBeGreaterThan(cruise.gain);
    expect(full.cutoff).toBeGreaterThan(still.cutoff);
    expect(full.gain).toBeLessThanOrEqual(1);
  });

  it('keeps the wind a soft rush that rises and falls, even at full speed', () => {
    // Before, cruising at 7 m/s held the wind at a steady 0.56, louder than the burner.
    for (let t = 0; t < 600; t += 0.5) {
      const g = windGust(t);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      expect(windSound(7, 0, g).gain).toBeLessThan(0.25);
      expect(windSound(0, 0, g).gain).toBeGreaterThan(0.03);
    }
    expect(windSound(7, 0, 1).gain).toBeGreaterThan(windSound(7, 0, 0).gain * 1.5);
    expect(windSound(7, 0, 1).cutoff).toBeLessThan(1200);
  });

  it('strains the timbers as the gondola tilts, tightens a turn and changes speed, not in a steady turn', () => {
    expect(strain(0, 0, 0, 0, LIMITS)).toBe(0);
    const easingIn = strain(0, 0, LIMITS.yawAccel, 0, LIMITS);
    const hard = strain(LIMITS.tiltRate, 0, LIMITS.yawAccel, LIMITS.accel, LIMITS);
    expect(easingIn).toBeGreaterThan(0);
    expect(hard).toBeGreaterThan(easingIn);
    expect(creakRate(hard)).toBeGreaterThan(creakRate(0));
  });

  it('creaks only now and then on the scripted tour', () => {
    // As the audio system does: tilt rate, change of the smoothed turn rate, change of speed.
    const ship = createShipState();
    const timer = new CreakTimer(rng(3));
    const dt = 1 / 90;
    let p = { roll: 0, pitch: 0, yaw: 0, speed: 0 };
    let yawRate = 0;
    let lastYawRate = 0;
    let creaks = 0;
    for (let i = 0; i < 90 * 600; i++) {
      stepShip(ship, MOTION_PROFILES.tour, dt);
      yawRate += ((ship.yaw - p.yaw) / dt - yawRate) * Math.min(1, dt / 0.25);
      const load = strain((ship.roll - p.roll) / dt, (ship.pitch - p.pitch) / dt, (yawRate - lastYawRate) / dt, (ship.speed - p.speed) / dt, LIMITS);
      if (timer.step(dt, load)) {
        creaks++;
      }
      lastYawRate = yawRate;
      p = { roll: ship.roll, pitch: ship.pitch, yaw: ship.yaw, speed: ship.speed };
    }
    // Before, the tour's long turns kept the timbers creaking about 22 times a minute.
    expect(creaks / 10).toBeLessThan(9);
    expect(creaks / 10).toBeGreaterThan(2);
  });

  it('creaks now and then at rest, often under strain, never in a pile', () => {
    const count = (load: number) => {
      const timer = new CreakTimer(rng(7));
      let creaks = 0;
      let last = -Infinity;
      let closest = Infinity;
      for (let i = 0; i < 90 * 120; i++) {
        if (timer.step(1 / 90, load)) {
          creaks++;
          closest = Math.min(closest, i / 90 - last);
          last = i / 90;
        }
      }
      return { creaks, closest };
    };
    const rest = count(0);
    const busy = count(1);
    // About 6 in two minutes at rest, and many times that under strain.
    expect(rest.creaks).toBeGreaterThan(2);
    expect(rest.creaks).toBeLessThan(20);
    expect(busy.creaks).toBeGreaterThan(rest.creaks * 4);
    expect(busy.closest).toBeGreaterThanOrEqual(CreakTimer.MIN_GAP - 1e-9);
  });

  it('hears a touchdown, not a gentle levelling off', () => {
    expect(touchedDown(-0.8, 0)).toBe(true);
    expect(touchedDown(-0.05, 0)).toBe(false);
    expect(touchedDown(-0.8, -0.78)).toBe(false);
  });
});
