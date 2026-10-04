import { describe, expect, it } from 'vitest';
import { CreakTimer, creakRate, ratchetClicks, RATCHET_TEETH, strain, touchedDown, windSound } from '../src/sim/audio-cues.js';
import { rng } from '../src/sim/random.js';

const LIMITS = { tiltRate: (3 * Math.PI) / 180, yawRate: (6 * Math.PI) / 180, accel: 0.4 };

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

  it('strains the timbers more as the gondola tilts, turns and changes speed', () => {
    expect(strain(0, 0, 0, 0, LIMITS)).toBe(0);
    const turning = strain(0, 0, LIMITS.yawRate, 0, LIMITS);
    const hard = strain(LIMITS.tiltRate, 0, LIMITS.yawRate, LIMITS.accel, LIMITS);
    expect(turning).toBeGreaterThan(0);
    expect(hard).toBeGreaterThan(turning);
    expect(creakRate(hard)).toBeGreaterThan(creakRate(0));
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
    // About 7 in two minutes at rest, and ten times that under strain.
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
