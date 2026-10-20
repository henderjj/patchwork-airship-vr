import { describe, expect, it } from 'vitest';
import { PUMP_PIVOT, PUMP_SWING, pumpHandle } from '../src/sim/gondola-layout.js';
import {
  BILGE_LITRES,
  FIRST_STRIKE,
  FOG,
  fogFor,
  isNight,
  isStorm,
  isWeather,
  PRACTICE_STRIKE,
  PUMP_LITRES_PER_RAD,
  PUMP_MAX_FLOW,
  PumpLever,
  RAIN_FILL,
  STRIKE_DISTANCE,
  STRIKE_GAP,
  StormSim,
  WATER_DEPTHS,
  WATER_SHOWS,
  waterDepth,
  WEATHERS,
} from '../src/sim/weather.js';
import { FIRST_GUST, GUST_PEAK, STORM_FIRST_GUST, STORM_GUST_PEAK, WindSim } from '../src/sim/wind.js';

const DT = 1 / 90;

/** Step a storm for `seconds` from ship time `t0` with the ship at (x, z), returning each strike's time. */
function run(sim: StormSim, t0: number, seconds: number, underWay = true, x = 0, z = 0): number[] {
  const strikes: number[] = [];
  for (let t = t0; t < t0 + seconds; t += DT) {
    if (sim.step(t, DT, underWay, x, z)) strikes.push(t);
  }
  return strikes;
}

describe('the weathers', () => {
  it('are clear, storm, night and night storm, each a storm or a night or both', () => {
    expect(WEATHERS).toEqual(['clear', 'storm', 'night', 'nightstorm']);
    expect(WEATHERS.map(isStorm)).toEqual([false, true, false, true]);
    expect(WEATHERS.map(isNight)).toEqual([false, false, true, true]);
    expect(isWeather('storm')).toBe(true);
    expect(isWeather('hail')).toBe(false);
    expect(isWeather(undefined)).toBe(false);
  });

  it('close the fog in for a storm and at night, and blend between them as the sky changes', () => {
    const out = { near: 0, far: 0 };
    expect(fogFor(0, 0, out)).toEqual({ near: FOG.clear[0], far: FOG.clear[1] });
    expect(fogFor(1, 1, { near: 0, far: 0 })).toEqual({ near: FOG.nightstorm[0], far: FOG.nightstorm[1] });
    // A storm hides the islands well short of a clear day's horizon, and a night storm shorter still.
    expect(FOG.storm[1]).toBeLessThan(FOG.clear[1] / 2);
    expect(FOG.nightstorm[1]).toBeLessThan(FOG.storm[1]);
    // Half way into a storm, half way between.
    fogFor(0, 0.5, out);
    expect(out.far).toBeCloseTo((FOG.clear[1] + FOG.storm[1]) / 2);
  });
});

describe('the bilge in a storm', () => {
  it('fills with rain only in a storm and only while the run is under way', () => {
    const sim = new StormSim();
    sim.weather = 'clear';
    run(sim, 0, 30);
    expect(sim.water).toBe(0);
    sim.weather = 'storm';
    run(sim, 0, 30, false);
    expect(sim.water).toBe(0);
    run(sim, 0, 30);
    expect(sim.water).toBeCloseTo(RAIN_FILL * 30, 0);
    // 40 litres a minute.
    expect(RAIN_FILL * 60).toBeCloseTo(40);
  });

  it('holds no more than a full bilge, and pumps out no more than there is', () => {
    const sim = new StormSim();
    sim.weather = 'nightstorm';
    sim.flood(BILGE_LITRES + 50);
    expect(sim.water).toBe(BILGE_LITRES);
    run(sim, 0, 5);
    expect(sim.water).toBe(BILGE_LITRES);
    expect(sim.pump(40)).toBe(40);
    expect(sim.water).toBe(BILGE_LITRES - 40);
    expect(sim.pump(BILGE_LITRES)).toBe(BILGE_LITRES - 40);
    expect(sim.water).toBe(0);
    expect(sim.pump(5)).toBe(0);
    expect(sim.pump(-5)).toBe(0);
  });

  it('starts every run dry', () => {
    const sim = new StormSim();
    sim.weather = 'storm';
    sim.flood(60);
    run(sim, 0, 10);
    sim.reset(7);
    expect(sim.water).toBe(0);
    expect(sim.strike).toBeNull();
  });

  it('is drawn on deck deeper as it fills, from a couple of litres to a full bilge', () => {
    expect(waterDepth(0)).toBe(0);
    expect(waterDepth(WATER_SHOWS - 0.1)).toBe(0);
    expect(waterDepth(WATER_SHOWS)).toBe(WATER_DEPTHS[0]);
    expect(waterDepth(BILGE_LITRES)).toBe(WATER_DEPTHS[WATER_DEPTHS.length - 1]);
    let last = 0;
    for (let litres = WATER_SHOWS; litres <= BILGE_LITRES; litres += 1) {
      const depth = waterDepth(litres);
      expect(depth).toBeGreaterThanOrEqual(last);
      last = depth;
    }
    expect(waterDepth(Number.NaN)).toBe(0);
  });
});

describe('lightning', () => {
  it('strikes a few seconds into a storm, then every 8 to 20 s, 120 to 420 m from the ship', () => {
    const sim = new StormSim();
    sim.reset(42);
    sim.weather = 'storm';
    const strikes = run(sim, 100, 300, true, 500, -200);
    expect(strikes[0] - 100).toBeGreaterThanOrEqual(FIRST_STRIKE[0] - DT);
    expect(strikes[0] - 100).toBeLessThanOrEqual(FIRST_STRIKE[1] + DT);
    for (let i = 1; i < strikes.length; i++) {
      const gap = strikes[i] - strikes[i - 1];
      expect(gap).toBeGreaterThanOrEqual(STRIKE_GAP[0] - DT);
      expect(gap).toBeLessThanOrEqual(STRIKE_GAP[1] + DT);
    }
    expect(strikes.length).toBeGreaterThan(300 / STRIKE_GAP[1] - 1);
    const s = sim.strike!;
    const off = Math.hypot(s.x - 500, s.z + 200);
    expect(off).toBeCloseTo(s.distance, 5);
    expect(s.distance).toBeGreaterThanOrEqual(STRIKE_DISTANCE[0]);
    expect(s.distance).toBeLessThanOrEqual(STRIKE_DISTANCE[1]);
    expect(s.id).toBe(strikes.length);
  });

  it('never strikes in clear weather or before the run is under way', () => {
    const sim = new StormSim();
    sim.weather = 'night';
    expect(run(sim, 0, 120)).toEqual([]);
    sim.weather = 'storm';
    expect(run(sim, 0, 120, false)).toEqual([]);
    expect(sim.strike).toBeNull();
  });

  it('strikes about ahead of the ship at once in practice', () => {
    const sim = new StormSim();
    // Heading 0 is towards -Z.
    const s = sim.strikeNow(12, 10, 20, 0);
    expect(s.distance).toBe(PRACTICE_STRIKE);
    expect(s.time).toBe(12);
    expect(s.z).toBeLessThan(20 - PRACTICE_STRIKE * 0.8);
    expect(Math.abs(s.x - 10)).toBeLessThan(PRACTICE_STRIKE * 0.5);
  });
});

describe('the storm on the wire', () => {
  it('reaches the guest whole, and a repeat of the same strike is not a new one', () => {
    const host = new StormSim();
    host.weather = 'nightstorm';
    host.flood(37.25);
    host.strikeNow(5, 0, 0, 1);
    const guest = new StormSim();
    guest.adopt(JSON.parse(JSON.stringify(host.toWire())), 'nightstorm');
    expect(guest.weather).toBe('nightstorm');
    expect(guest.water).toBeCloseTo(37.3, 5);
    expect(guest.strike!.id).toBe(host.strike!.id);
    expect(guest.strike!.distance).toBe(PRACTICE_STRIKE);
    const strike = guest.strike;
    guest.adopt(host.toWire(), 'nightstorm');
    expect(guest.strike).toBe(strike);
    // A new run: dry, no strike.
    host.reset(3);
    guest.adopt(host.toWire(), 'storm');
    expect(guest.water).toBe(0);
    expect(guest.strike).toBeNull();
    expect(guest.weather).toBe('storm');
  });

  it('ignores junk', () => {
    const guest = new StormSim();
    guest.flood(10);
    guest.adopt('lots', 'tornado');
    guest.adopt([Number.NaN], 'clear');
    guest.adopt([1e9, 'x'], 'clear');
    expect(guest.water).toBe(10);
    guest.adopt([1e9], 'clear');
    expect(guest.water).toBe(BILGE_LITRES);
  });
});

describe('the bilge pump', () => {
  it('has its lever follow the hand on the handle, within its swing', () => {
    const at = { x: 0, y: 0, z: 0 };
    for (const angle of [-PUMP_SWING, -0.2, 0, 0.3, PUMP_SWING]) {
      pumpHandle(angle, at);
      expect(PumpLever.angleFor(at.y)).toBeCloseTo(angle, 6);
      expect(at.z).toBe(PUMP_PIVOT[2]);
      // The handle reaches inboard of the pivot.
      expect(at.x).toBeLessThan(PUMP_PIVOT[0]);
    }
    expect(PumpLever.angleFor(10)).toBe(PUMP_SWING);
    expect(PumpLever.angleFor(-10)).toBe(-PUMP_SWING);
  });

  it('moves water on the down stroke only, about 2.5 litres a full stroke', () => {
    const lever = new PumpLever();
    const at = { x: 0, y: 0, z: 0 };
    let litres = 0;
    // Up over a second: nothing.
    for (let k = 0; k <= 90; k++) {
      pumpHandle(-PUMP_SWING + (2 * PUMP_SWING * k) / 90, at);
      litres += lever.follow(at.y, DT);
    }
    expect(litres).toBe(0);
    expect(lever.angle).toBeCloseTo(PUMP_SWING);
    // Down over a second.
    for (let k = 0; k <= 90; k++) {
      pumpHandle(PUMP_SWING - (2 * PUMP_SWING * k) / 90, at);
      litres += lever.follow(at.y, DT);
    }
    expect(litres).toBeCloseTo(2 * PUMP_SWING * PUMP_LITRES_PER_RAD, 3);
    expect(litres).toBeGreaterThan(2);
    expect(litres).toBeLessThan(3);
  });

  it("can't be slammed for a bucketful: a stroke moves no more than its fastest flow", () => {
    const lever = new PumpLever();
    const at = { x: 0, y: 0, z: 0 };
    pumpHandle(PUMP_SWING, at);
    lever.follow(at.y, DT);
    pumpHandle(-PUMP_SWING, at);
    expect(lever.follow(at.y, DT)).toBeCloseTo(PUMP_MAX_FLOW / 30);
  });

  it('sinks back down when let go', () => {
    const lever = new PumpLever();
    lever.angle = PUMP_SWING;
    for (let k = 0; k < 90; k++) lever.sink(DT);
    expect(lever.angle).toBe(-PUMP_SWING);
  });

  it('empties a flooded deck quicker than a storm fills it', () => {
    // A steady stroke a second (about 2.5 litres) against 40 litres a minute.
    expect(2 * PUMP_SWING * PUMP_LITRES_PER_RAD).toBeGreaterThan(RAIN_FILL * 2);
  });
});

describe('gusts in a storm', () => {
  it('come sooner and harder', () => {
    const calm = new WindSim();
    const storm = new WindSim();
    storm.storm = true;
    let firstCalm = Number.NaN;
    let firstStorm = Number.NaN;
    for (let t = 0; t < 120 && (Number.isNaN(firstCalm) || Number.isNaN(firstStorm)); t += 0.1) {
      if (calm.step(t, true, true, 0) && Number.isNaN(firstCalm)) firstCalm = t;
      if (storm.step(t, true, true, 0) && Number.isNaN(firstStorm)) firstStorm = t;
    }
    expect(firstCalm).toBeGreaterThanOrEqual(FIRST_GUST[0] - 0.1);
    expect(firstStorm).toBeGreaterThanOrEqual(STORM_FIRST_GUST[0] - 0.1);
    expect(firstStorm).toBeLessThanOrEqual(STORM_FIRST_GUST[1] + 0.1);
    expect(STORM_FIRST_GUST[1]).toBeLessThan(FIRST_GUST[0]);
    expect(storm.gust!.peak).toBeGreaterThanOrEqual(GUST_PEAK[0] * STORM_GUST_PEAK - 1e-9);
    expect(storm.gust!.peak).toBeLessThanOrEqual(GUST_PEAK[1] * STORM_GUST_PEAK + 1e-9);
  });
});
