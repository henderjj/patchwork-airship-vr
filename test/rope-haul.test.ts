import { describe, expect, it } from 'vitest';
import { createRopeHandInput, RopeHaulSim } from '../src/sim/rope-haul.js';

const DT = 1 / 90;

/**
 * Scripted hand-over-hand hauling: each player's hands take turns, each
 * stroke pulling `reach` metres inboard over `strokeS` seconds with an eased
 * start and finish, then letting go and reaching forward while the other
 * hand pulls. Player 1's rhythm can lag by `lagS`, and their input can
 * arrive `delayMs` late as over the network.
 */
function haul(opts: { players: number; reach: number; strokeS: number; lagS?: number; delayMs?: number; seconds: number }) {
  const sim = new RopeHaulSim();
  const hands = [0, 1, 2, 3].map(() => createRopeHandInput());
  const slipped = [false, false, false, false];
  let lastStroke = [-1, -1, -1, -1];
  for (let t = 0; t < opts.seconds; t += DT) {
    const now = t * 1000;
    for (let player = 0; player < 2; player++) {
      const delay = player === 1 ? (opts.delayMs ?? 0) : 0;
      const at = now - delay;
      const tt = at / 1000 - (player === 1 ? (opts.lagS ?? 0) : 0);
      for (let side = 0; side < 2; side++) {
        const i = player * 2 + side;
        const h = hands[i];
        const stroke = Math.floor(tt / opts.strokeS);
        const mine = player < opts.players && tt >= 0 && stroke % 2 === side;
        if (stroke !== lastStroke[i]) {
          slipped[i] = false; // a fresh grab
          lastStroke[i] = stroke;
        }
        const phase = (tt - stroke * opts.strokeS) / opts.strokeS;
        h.holding = mine && !slipped[i];
        // Grab at the fairlead end (0) and pull inboard.
        h.along = (opts.reach * (1 - Math.cos(Math.PI * phase))) / 2;
        h.atMs = at;
      }
    }
    sim.step(DT, now, hands);
    for (let i = 0; i < 4; i++) slipped[i] ||= sim.slipped[i];
  }
  return { sim, slips: sim.slipped, anySlip: slipped };
}

describe('rope haul', () => {
  it('one player hauls in steadily with short, easy strokes', () => {
    const { sim, anySlip } = haul({ players: 1, reach: 0.25, strokeS: 0.6, seconds: 8 });
    // Each new grab gives back a few centimetres while the hand takes up the load.
    expect(sim.hauled).toBeGreaterThan(0.8);
    expect(anySlip).toEqual([false, false, false, false]);
    expect(sim.heaves).toBe(0);
  });

  it('one player pulling hard has the line slip through their hands', () => {
    let slips = 0;
    const sim = new RopeHaulSim();
    const hands = [0, 1, 2, 3].map(() => createRopeHandInput());
    for (let t = 0; t < 4; t += DT) {
      // A hand dragging inboard at 1.5 m/s, regrabbing whenever the line slips.
      hands[0].holding = true;
      hands[0].along = 1.5 * t;
      hands[0].atMs = t * 1000;
      sim.step(DT, t * 1000, hands);
      if (sim.slipped[0]) slips++;
    }
    expect(slips).toBeGreaterThan(0);
    expect(sim.hauled).toBeLessThan(4);
  });

  it('two players in rhythm heave together and haul much faster than one', () => {
    const solo = haul({ players: 1, reach: 0.25, strokeS: 0.6, seconds: 8 }).sim.hauled;
    const { sim } = haul({ players: 2, reach: 0.5, strokeS: 0.5, seconds: 8 });
    expect(sim.heaves).toBeGreaterThan(10);
    expect(sim.hauled).toBeGreaterThan(2 * solo);
  });

  it('still heaves when the crewmate’s hands arrive 75 ms late', () => {
    const { sim } = haul({ players: 2, reach: 0.5, strokeS: 0.5, delayMs: 75, seconds: 8 });
    expect(sim.heaves).toBeGreaterThan(10);
  });

  it('strokes 250 ms apart never heave', () => {
    const { sim } = haul({ players: 2, reach: 0.5, strokeS: 0.5, lagS: 0.25, seconds: 8 });
    expect(sim.heaves).toBe(0);
  });

  it('docks when the whole line is in', () => {
    const { sim } = haul({ players: 2, reach: 0.5, strokeS: 0.5, seconds: 30 });
    expect(sim.docked).toBe(true);
    expect(sim.hauled).toBe(sim.params.length);
  });
});
