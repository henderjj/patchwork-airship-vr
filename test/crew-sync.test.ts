import { describe, expect, it } from 'vitest';
import { CrankSim, createHandleInput, DEFAULT_CRANK } from '../src/sim/crank.js';
import {
  callLampLevel,
  type CrankAdvice,
  crankAdvice,
  crankPace,
  HAUL_CALL_PERIOD_MS,
  HaulCall,
  haulCallFraction,
  haulCallPhase,
  lineCreakGapMs,
  lineTension,
  msToNextHeave,
  PACE_LEAD_S,
  PaceTarget,
  paceWindow,
  ropeBuzz,
  TARGET_SPRINT,
  TARGET_START,
} from '../src/sim/crew-sync.js';
import { DEFAULT_ROPE } from '../src/sim/rope-haul.js';

const DT = 1 / 90;
const W = DEFAULT_CRANK.syncWindowMs;

/**
 * Two players crank for `seconds`, each following the sign's advice the way
 * a person would: a hand told to push leads its handle a little more each
 * moment, one told to ease off a little less. Player 1's hand reaches the
 * crank `delayMs` late, as over the network.
 */
function crankOnAdvice(start: [number, number], seconds: number, delayMs = 0) {
  const sim = new CrankSim();
  const inputs = [createHandleInput(), createHandleInput()];
  const leads = [...start];
  const paces = [0, 0];
  const advice: CrankAdvice[] = ['even', 'even'];
  const target = new PaceTarget();
  let gearFrames = 0;
  let frames = 0;
  const history: { at: number; angle: number }[] = [];
  for (let t = 0; t < seconds; t += DT) {
    const now = t * 1000;
    history.push({ at: now, angle: sim.angle });
    inputs.forEach((input, i) => {
      const at = now - (i === 1 ? delayMs : 0);
      const then = [...history].reverse().find((h) => h.at <= at) ?? history[0];
      input.holding = true;
      input.player = i;
      input.handAngle = then.angle + Math.PI * i + leads[i];
      input.atMs = then.at;
    });
    sim.step(DT, now, inputs);
    target.step(DT, sim.inSync);
    for (let i = 0; i < 2; i++) {
      paces[i] += (crankPace(sim.lead[i], sim.omega, 1) - paces[i]) * Math.min(1, DT / 0.2);
      advice[i] = crankAdvice(paces[i] - target.pace, paceWindow(sim.omega, W) / 2, advice[i]);
      // A person takes a moment to respond and doesn't jump: about 0.4 rad a second.
      leads[i] = Math.max(-0.5, Math.min(0.9, leads[i] + (advice[i] === 'push' ? 0.4 : advice[i] === 'ease' ? -0.4 : 0) * DT));
    }
    if (t > seconds - 2) {
      frames++;
      if (sim.gear > 0.95) gearFrames++;
    }
  }
  return { sim, paces, target, gearShare: gearFrames / frames };
}

describe('crank pace, target and advice', () => {
  it("measures a hand's pace as the crank's speed plus its lead", () => {
    expect(crankPace(0, 2 * Math.PI, 1)).toBeCloseTo(1);
    expect(crankPace(0.3, 0, 1)).toBeCloseTo(1 / (PACE_LEAD_S * 2 * Math.PI) * 0.3);
    // Astern, a hand further back is going faster astern.
    expect(crankPace(-0.3, -2 * Math.PI, -1)).toBeCloseTo(1 + 0.3 / PACE_LEAD_S / (2 * Math.PI));
    // Two hands in the sync window are a window's pace apart at most.
    const omega = 3;
    const dLead = (W / 1000) * omega;
    expect(crankPace(0.2 + dLead, omega, 1) - crankPace(0.2, omega, 1)).toBeCloseTo(paceWindow(omega, W));
  });

  it('starts at an easy target, climbs towards a sprint while in step, and falls back once out of step for a while', () => {
    const target = new PaceTarget();
    expect(target.pace).toBe(TARGET_START);
    for (let t = 0; t < 3; t += DT) target.step(DT, true);
    expect(target.pace).toBeGreaterThan(TARGET_START + 0.4);
    const high = target.pace;
    for (let t = 0; t < 0.8; t += DT) target.step(DT, false);
    expect(target.pace).toBeCloseTo(high);
    for (let t = 0; t < 4; t += DT) target.step(DT, false);
    expect(target.pace).toBe(TARGET_START);
    for (let t = 0; t < 20; t += DT) target.step(DT, true);
    expect(target.pace).toBe(TARGET_SPRINT);
  });

  it('two players following the advice from very different efforts fall into step and sprint', () => {
    const { sim, paces, gearShare } = crankOnAdvice([0.05, 0.8], 14);
    expect(gearShare).toBeGreaterThan(0.8);
    expect(Math.abs(paces[0] - paces[1])).toBeLessThan(paceWindow(sim.omega, W));
    expect(sim.omega / (2 * Math.PI)).toBeGreaterThan(1);
  });

  it('still converges with the crewmate 100 ms behind on the network', () => {
    const { gearShare } = crankOnAdvice([0.8, 0.05], 14, 100);
    expect(gearShare).toBeGreaterThan(0.8);
  });

  it("doesn't flicker at the edge", () => {
    expect(crankAdvice(0.7, 1, 'even')).toBe('ease');
    expect(crankAdvice(-0.7, 1, 'even')).toBe('push');
    expect(crankAdvice(0.5, 1, 'ease')).toBe('ease');
    expect(crankAdvice(0.5, 1, 'even')).toBe('even');
    expect(crankAdvice(-0.5, 1, 'push')).toBe('push');
    expect(crankAdvice(0.3, 1, 'ease')).toBe('even');
  });
});

describe('the crank grip', () => {
  it('keeps hold of a hand that falls well behind for a moment', () => {
    const sim = new CrankSim();
    const inputs = [createHandleInput(), createHandleInput()];
    let slipped = false;
    for (let t = 0; t < 3; t += DT) {
      // Cranking steadily, then the hand drops 1.3 rad (about 29 cm) behind for 0.4 s.
      const lag = t > 1.5 && t < 1.9 ? -1.3 : 0.3;
      inputs[0].holding = true;
      inputs[0].handAngle = sim.angle + lag;
      inputs[0].atMs = t * 1000;
      sim.step(DT, t * 1000, inputs);
      slipped ||= sim.slipped[0];
    }
    expect(slipped).toBe(false);
  });

  it('lets go of a hand that stays far off its handle', () => {
    const sim = new CrankSim();
    const inputs = [createHandleInput(), createHandleInput()];
    let slippedAt = -1;
    for (let t = 0; t < 2 && slippedAt < 0; t += DT) {
      inputs[0].holding = true;
      inputs[0].handAngle = sim.angle + (t > 0.5 ? 1.8 : 0.2);
      inputs[0].atMs = t * 1000;
      sim.step(DT, t * 1000, inputs);
      if (sim.slipped[0]) slippedAt = t;
    }
    expect(slippedAt).toBeGreaterThan(0.5 + DEFAULT_CRANK.slipGraceSeconds - 0.02);
    expect(slippedAt).toBeLessThan(0.5 + DEFAULT_CRANK.slipGraceSeconds + 0.05);
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

  it('creaks through the fairlead under a firm pull, faster the harder it is pulled', () => {
    expect(lineCreakGapMs(0.2, 0.5)).toBeNaN();
    expect(lineCreakGapMs(0.5, 0)).toBeNaN();
    expect(lineCreakGapMs(0.8, 0)).toBeGreaterThan(0);
    expect(lineCreakGapMs(0.95, 0.4)).toBeLessThan(lineCreakGapMs(0.5, 0.4));
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
