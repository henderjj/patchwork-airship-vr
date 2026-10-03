import { describe, expect, it } from 'vitest';
import { clampRating, COMFORT_CSV_HEADER, ComfortLog } from '../src/sim/comfort-log.js';
import { createShipState, MOTION_PROFILES, stepShip } from '../src/sim/ship-motion.js';
import { WORLD_TILE, wrapNear } from '../src/sim/world-tile.js';

describe('comfort log', () => {
  it('records the peak motion between ratings and starts again after each', () => {
    const log = new ComfortLog();
    const ship = createShipState();
    const profile = MOTION_PROFILES.lively;
    for (let i = 0; i < 60 * 90; i++) {
      stepShip(ship, profile, 1 / 90);
      log.sample(ship, 1 / 90);
    }
    log.rate(60, 'lively', 3);
    const [header, row] = log.csv().trim().split('\n');
    expect(header).toBe(COMFORT_CSV_HEADER);
    const cells = row.split(',');
    expect(cells.slice(0, 3)).toEqual(['60', 'lively', '3']);
    const [tilt, turn, accelH] = cells.slice(3, 6).map(Number);
    // Within the profile's limits, and clearly moving.
    expect(tilt).toBeGreaterThan(1);
    expect(tilt).toBeLessThanOrEqual(profile.maxTiltDeg + 0.5);
    expect(turn).toBeGreaterThan(1);
    expect(turn).toBeLessThanOrEqual(profile.maxYawRateDeg * 1.6);
    expect(accelH).toBeGreaterThan(0);
    expect(log.peakTiltDeg).toBe(0);
    log.rate(120, 'lively', null);
    expect(log.rows[2].split(',')[2]).toBe('');
  });

  it('keeps ratings on the 0 to 20 scale', () => {
    expect(clampRating(-1)).toBe(0);
    expect(clampRating(7.4)).toBe(7);
    expect(clampRating(25)).toBe(20);
  });
});

describe('world tile', () => {
  it('draws each island in the copy of the tile nearest the ship', () => {
    expect(wrapNear(300, 0)).toBe(300);
    expect(wrapNear(300, 5000)).toBe(300 + 2 * WORLD_TILE);
    expect(wrapNear(-600, 3900)).toBe(-600 + 2 * WORLD_TILE);
    for (const centre of [-7777, -1, 0, 999, 123456]) {
      for (const value of [-650, 0, 640]) {
        const w = wrapNear(value, centre);
        expect(Math.abs(w - centre)).toBeLessThanOrEqual(WORLD_TILE / 2);
        expect(Math.abs(((w - value) / WORLD_TILE) % 1)).toBeLessThan(1e-9);
      }
    }
  });
});
