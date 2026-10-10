import { describe, expect, it } from 'vitest';
import { CrankSim, createHandleInput, DEFAULT_CRANK } from '../src/sim/crank.js';
import {
  callLampLevel,
  type CrankAdvice,
  crankAdvice,
  crankBalanceMs,
  HAUL_CALL_PERIOD_MS,
  HaulCall,
  haulCallFraction,
  haulCallPhase,
  lineTension,
  msToNextHeave,
  ropeBuzz,
} from '../src/sim/crew-sync.js';
import { DEFAULT_ROPE } from '../src/sim/rope-haul.js';

const DT = 1 / 90;
const W = DEFAULT_CRANK.syncWindowMs;

/** Two players crank for `seconds`, each hand leading its handle by its own amount (radians); returns the crank and player 0's advice over time. */
function crank(lead0: number, lead1: number, seconds: number) {
  const sim = new CrankSim();
  const inputs = [createHandleInput(), createHandleInput()];
  let advice: CrankAdvice = 'even';
  let balance = 0;
  for (let t = 0; t < seconds; t += DT) {
    const now = t * 1000;
    inputs.forEach((input, i) => {
      input.holding = true;
      input.player = i;
      input.handAngle = sim.angle + Math.PI * i + (i === 0 ? lead0 : lead1);
      input.atMs = now;
    });
    sim.step(DT, now, inputs);
    balance += (crankBalanceMs(sim.lead[0], sim.lead[1], sim.omega) - balance) * Math.min(1, DT / 0.2);
    advice = crankAdvice(balance, W, advice);
  }
  return { sim, advice, balance };
}

describe('crank balance and advice', () => {
  it('reads even when both players push alike, and they reach high gear', () => {
    const { sim, advice, balance } = crank(0.3, 0.3, 4);
    expect(Math.abs(balance)).toBeLessThan(10);
    expect(advice).toBe('even');
    expect(sim.gear).toBeGreaterThan(0.95);
  });

  it('tells the player pushing harder to ease off, and the other to push', () => {
    const ahead = crank(0.9, 0.1, 3);
    expect(ahead.balance).toBeGreaterThan(0.6 * W);
    expect(ahead.advice).toBe('ease');
    const behind = crank(0.1, 0.9, 3);
    expect(behind.balance).toBeLessThan(-0.6 * W);
    expect(behind.advice).toBe('push');
  });

  it('warns before the pair drops out of the sync window', () => {
    // Just inside the window: still in step, but drifting far enough to be told.
    expect(crankAdvice(0.7 * W, W, 'even')).toBe('ease');
    expect(crankAdvice(-0.7 * W, W, 'even')).toBe('push');
    expect(crankAdvice(0.3 * W, W, 'even')).toBe('even');
  });

  it("doesn't flicker at the edge", () => {
    expect(crankAdvice(0.5 * W, W, 'ease')).toBe('ease');
    expect(crankAdvice(0.5 * W, W, 'even')).toBe('even');
    expect(crankAdvice(-0.5 * W, W, 'push')).toBe('push');
    expect(crankAdvice(0.3 * W, W, 'ease')).toBe('even');
  });

  it('measures the balance the way the crank measures sync, with a sign', () => {
    expect(crankBalanceMs(0.5, 0.2, 3)).toBeCloseTo(100);
    expect(crankBalanceMs(0.2, 0.5, 3)).toBeCloseTo(-100);
    // Cranking astern, leading means further back.
    expect(crankBalanceMs(-0.5, -0.2, -3)).toBeCloseTo(100);
  });
});

describe('the line in the hand', () => {
  it('buzzes harder the harder the hand pulls, most just before the line slips', () => {
    const slip = DEFAULT_ROPE.slipDistance;
    expect(ropeBuzz(lineTension(0, slip), 0)).toBe(0);
    expect(ropeBuzz(lineTension(-0.1, slip), 0)).toBe(0);
    const light = ropeBuzz(lineTension(0.05, slip), 0.3);
    const firm = ropeBuzz(lineTension(0.15, slip), 0.3);
    const slipping = ropeBuzz(lineTension(0.24, slip), 0.3);
    expect(light).toBeGreaterThan(0);
    expect(firm).toBeGreaterThan(light);
    expect(slipping).toBeGreaterThan(firm);
    expect(slipping).toBeGreaterThan(0.7);
    expect(ropeBuzz(1, 5)).toBeLessThanOrEqual(1);
  });
});

describe('the haul call', () => {
  it('beats on whole periods of the shared clock, so both players hear the same heave', () => {
    expect(msToNextHeave(0)).toBe(0);
    expect(msToNextHeave(250)).toBe(HAUL_CALL_PERIOD_MS - 250);
    expect(haulCallPhase(2500)).toEqual({ index: 2, phase: 0.5 });
    expect(haulCallFraction(2500)).toBeCloseTo(0.5);
    expect(haulCallFraction(-250)).toBeCloseTo(0.75);
    // Two pages whose local clocks differ by 4321 ms but share the host's clock beat together.
    const offset = 4321;
    for (let host = 10000; host < 13000; host += 137) {
      const hostNext = host + msToNextHeave(host);
      const guestLocal = host - offset;
      const guestNext = guestLocal + msToNextHeave(guestLocal + offset);
      expect(guestNext + offset).toBeCloseTo(hostNext);
    }
  });

  it('sounds only while both players are at the line, heave then reach, and lingers between strokes', () => {
    const call = new HaulCall();
    const beats: [number, string][] = [];
    for (let t = 0; t < 6000; t += 10) {
      // Both at the line from 1.05 s to 3 s; then one lets go for good.
      const both = t >= 1050 && t < 3000;
      const beat = call.update(t, t, both);
      if (beat) beats.push([t, beat]);
    }
    // First beat is the next half beat after the pair meet, then alternating.
    expect(beats[0]).toEqual([1500, 'reach']);
    expect(beats[1]).toEqual([2000, 'heave']);
    expect(beats.filter(([, b]) => b === 'heave').map(([t]) => t)).toEqual([2000, 3000, 4000, 5000]);
    // Lingers 2.5 s after the pair last held together, then stops.
    expect(beats[beats.length - 1][0]).toBeLessThan(3000 + call.lingerMs);
    expect(call.running).toBe(false);
  });

  it('flashes its lamp on each heave and builds towards the next', () => {
    expect(callLampLevel(0)).toBeCloseTo(1);
    expect(callLampLevel(0.3)).toBeLessThan(0.1);
    expect(callLampLevel(0.95)).toBeGreaterThan(callLampLevel(0.6));
  });
});
