import { describe, expect, it } from 'vitest';
import { createHandleInput, CrankSim, HANDLE_OFFSETS } from '../src/sim/crank.js';

const DT = 1 / 90;

/**
 * Drive the crank with scripted hands. `hand(i, t)` gives handle i's hand
 * angle at time t (seconds) or null when not held; `delay[i]` is how late
 * that hand's input arrives (ms), as for a crewmate over the network.
 */
function run(
  seconds: number,
  hand: (i: number, t: number) => number | null,
  players: [number, number] = [0, 1],
  delay: [number, number] = [0, 0],
  sim = new CrankSim(),
) {
  const inputs = [createHandleInput(), createHandleInput()];
  let slipped = [false, false];
  let syncFrames = 0;
  let frames = 0;
  for (let t = 0; t < seconds; t += DT) {
    const now = t * 1000;
    for (let i = 0; i < 2; i++) {
      const at = now - delay[i];
      const angle = hand(i, at / 1000);
      inputs[i].holding = angle !== null && !slipped[i];
      inputs[i].player = players[i];
      inputs[i].handAngle = angle ?? 0;
      inputs[i].atMs = at;
    }
    sim.step(DT, now, inputs);
    slipped = slipped.map((s, i) => s || sim.slipped[i]);
    if (t > seconds - 1) {
      frames++;
      if (sim.inSync) syncFrames++;
    }
  }
  return { sim, slipped, syncShare: syncFrames / frames };
}

/** A hand that speeds up smoothly to `rate` rad/s over `rampS` seconds, offset in time by `lagS`. */
function cranking(rate: number, rampS = 2, lagS = 0) {
  return (i: number, t: number) => {
    const tt = Math.max(0, t - lagS);
    const angle = tt < rampS ? (rate * tt * tt) / (2 * rampS) : rate * (tt - rampS / 2);
    return angle + HANDLE_OFFSETS[i];
  };
}

describe('two-person crank', () => {
  it('one player cranks steadily at a comfortable pace', () => {
    const drive = cranking(2.5);
    const { sim, slipped } = run(6, (i, t) => (i === 0 ? drive(0, t) : null));
    expect(slipped[0]).toBe(false);
    expect(sim.omega).toBeGreaterThan(2.2);
    expect(sim.omega).toBeLessThan(2.8);
    expect(sim.gear).toBe(0);
  });

  it('one player alone cannot sprint: the handle lags and slips out of the hand', () => {
    const drive = cranking(9);
    const { sim, slipped } = run(6, (i, t) => (i === 0 ? drive(0, t) : null));
    expect(slipped[0]).toBe(true);
    expect(sim.omega).toBeLessThan(sim.soloTopSpeed + 0.2);
  });

  it('two players in sync reach about three times the solo speed', () => {
    const drive = cranking(9, 3);
    const { sim, slipped, syncShare } = run(8, drive);
    expect(slipped).toEqual([false, false]);
    expect(syncShare).toBeGreaterThan(0.95);
    expect(sim.gear).toBeCloseTo(1, 3);
    expect(sim.omega).toBeGreaterThan(2.6 * sim.soloTopSpeed);
  });

  it('one player holding both handles does not get the sprint gear', () => {
    const drive = cranking(9, 3);
    const { sim } = run(8, drive, [0, 0]);
    expect(sim.gear).toBe(0);
    expect(sim.omega).toBeLessThan(2 * sim.soloTopSpeed);
  });

  it('stays in sync when the crewmate’s hand arrives 75 ms late (150 ms RTT)', () => {
    const drive = cranking(9, 3);
    const { sim, slipped, syncShare } = run(8, drive, [0, 1], [0, 75]);
    expect(slipped).toEqual([false, false]);
    expect(syncShare).toBeGreaterThan(0.95);
    expect(sim.omega).toBeGreaterThan(2.6 * sim.soloTopSpeed);
  });

  it('hands out of rhythm by 250 ms stutter and never reach sprint speed', () => {
    const lead = cranking(6, 2);
    const lag = cranking(6, 2, 0.25);
    const { sim, syncShare } = run(8, (i, t) => (i === 0 ? lead(0, t) : lag(1, t)));
    expect(syncShare).toBeLessThan(0.2);
    expect(sim.gear).toBeLessThan(0.5);
    expect(Math.abs(sim.omega)).toBeLessThan(1.6 * sim.soloTopSpeed);
  });

  it('remembers its recent angles for judging late inputs', () => {
    const sim = new CrankSim();
    const inputs = [createHandleInput(), createHandleInput()];
    inputs[0].holding = true;
    for (let i = 0; i < 90; i++) {
      inputs[0].handAngle = sim.angle + 0.3;
      inputs[0].atMs = i * 10;
      sim.step(0.01, i * 10, inputs);
    }
    const past = sim.angleAt(450);
    expect(past).toBeGreaterThan(0);
    expect(past).toBeLessThan(sim.angle);
  });
});
