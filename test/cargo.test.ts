import { describe, expect, it } from 'vitest';
import {
  BLOCK,
  CargoSim,
  coastWinch,
  createCargoInput,
  CRATE_HEIGHT,
  type GroundAt,
  HATCH_CENTER,
  LINE_ABOARD,
  lineFromWinch,
  turnWinch,
  WINCH_EMPTY_SPEED,
  WINCH_HOIST_SPEED,
  WINCH_LOWER_SPEED,
  WINCH_MAX,
} from '../src/sim/cargo.js';
import { alongsidePost, shipToWorld } from '../src/sim/docking.js';
import { CALM_SKIES, JETTY_TOP, onJetty, targetPoints } from '../src/sim/route.js';
import { createShipState, type ShipState, updateQuaternion } from '../src/sim/ship-motion.js';

const DT = 1 / 90;
const ROUTE = CALM_SKIES;

/** What is under a point: the route's islands (B and the cargo stage deliver) and B's jetty, as CargoSystem has it. */
const ground: GroundAt = (x, z, fromY, out) => {
  out.y = Number.NEGATIVE_INFINITY;
  out.delivery = false;
  for (const island of [ROUTE.start, ROUTE.finish, ROUTE.cargo]) {
    const r = island.radius * 0.92;
    if ((x - island.x) ** 2 + (z - island.z) ** 2 < r * r && island.y <= fromY && island.y > out.y) {
      out.y = island.y;
      out.delivery = island !== ROUTE.start;
    }
  }
  const jetty = ROUTE.dock.y + JETTY_TOP;
  if (jetty <= fromY && jetty > out.y && onJetty(ROUTE, x, z)) {
    out.y = jetty;
    out.delivery = true;
  }
};

/** A ship made fast at B's post as practice cargo starts it: still, level, the fairlead 1.2 m out. */
function madeFast(): ShipState {
  const at = alongsidePost(ROUTE.dock, ROUTE.finish.x, ROUTE.finish.z, 1.2);
  const ship = createShipState();
  Object.assign(ship, { x: at.x, y: at.y, z: at.z, yaw: at.yaw, pitch: 0, roll: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, time: 0 });
  updateQuaternion(ship);
  return ship;
}

/** Run the crate for `seconds`, the line out set each step by `line(t)`. */
function run(sim: CargoSim, ship: ShipState, input: ReturnType<typeof createCargoInput>, seconds: number, line?: (t: number) => number, each?: () => void): void {
  for (let t = 0; t < seconds; t += DT) {
    if (line) input.line = line(t);
    ship.time += DT;
    input.time = ship.time;
    sim.step(ship, input, DT);
    each?.();
  }
}

function calm(): { sim: CargoSim; ship: ShipState; input: ReturnType<typeof createCargoInput> } {
  const sim = new CargoSim();
  const ship = madeFast();
  const input = createCargoInput(ground);
  input.windScale = 0;
  return { sim, ship, input };
}

describe('cargo', () => {
  it('starts in the hatch at 100%, its top level with the deck, hooked on a taut line', () => {
    const { sim } = calm();
    expect(sim.phase).toBe('aboard');
    expect(sim.condition).toBe(100);
    expect(sim.pos.y).toBe(0);
    expect(sim.canClose).toBe(true);
    expect(LINE_ABOARD).toBeCloseTo(BLOCK[1] - sim.pos.y);
  });

  it('turns the winch with the hand, no faster than it goes, and lets go of a hand that runs away', () => {
    expect(turnWinch(0, 0.05, DT)).toBeCloseTo(0.05);
    expect(turnWinch(0, 0.5, DT)).toBeCloseTo(WINCH_LOWER_SPEED * DT);
    expect(Number.isNaN(turnWinch(0, 1.5, DT))).toBe(true);
    expect(turnWinch(WINCH_MAX, WINCH_MAX + 0.3, DT)).toBe(WINCH_MAX);
    expect(lineFromWinch(10)).toBeCloseTo(LINE_ABOARD + 0.6);
  });

  it('winds the empty hook in three times as fast, and a drum let go winding in spins on until the hook is home', () => {
    expect(turnWinch(50, 49.5, DT)).toBeCloseTo(50 - WINCH_HOIST_SPEED * DT);
    expect(turnWinch(50, 49.5, DT, true)).toBeCloseTo(50 - WINCH_EMPTY_SPEED * DT);
    // Let go at 12 rad/s (two turns a second) with 5 m of line out: most of it comes in on its own.
    const out = { angle: 5 / 0.06, spin: -12 };
    let t = 0;
    while (out.spin < 0 && t < 30) {
      coastWinch(out.angle, out.spin, DT, out);
      t += DT;
    }
    expect(lineFromWinch(out.angle) - LINE_ABOARD).toBeLessThan(2.5);
    // It stops at home and never pays out.
    Object.assign(out, { angle: 0.1, spin: -12 });
    coastWinch(out.angle, out.spin, DT, out);
    coastWinch(out.angle, out.spin, DT, out);
    expect(out).toEqual({ angle: 0, spin: 0 });
    Object.assign(out, { angle: 10, spin: 3 });
    coastWinch(out.angle, out.spin, DT, out);
    expect(out).toEqual({ angle: 10, spin: 0 });
  });

  it("can't be lowered through a shut door, and opening it on slack line drops the crate with a knock", () => {
    const { sim, ship, input } = calm();
    input.line = LINE_ABOARD + 0.5;
    run(sim, ship, input, 1);
    expect(sim.phase).toBe('aboard');
    expect(sim.condition).toBe(100);
    input.doorOpen = true;
    run(sim, ship, input, 1);
    expect(sim.phase).toBe('hanging');
    expect(sim.pos.y).toBeCloseTo(-0.5, 1);
    expect(sim.condition).toBeLessThan(80);
    expect(sim.knocks).toBe(1);
  });

  it('opening the door on a taut line leaves it hanging unharmed', () => {
    const { sim, ship, input } = calm();
    input.doorOpen = true;
    run(sim, ship, input, 1);
    expect(sim.phase).toBe('hanging');
    expect(sim.condition).toBe(100);
    expect(sim.canClose).toBe(true);
  });

  it('lowered at a steady pace through the open hatch, it sets down softly on the cargo stage and is delivered once slack', () => {
    const { sim, ship, input } = calm();
    input.doorOpen = true;
    run(sim, ship, input, 60, (t) => LINE_ABOARD + 0.15 * t);
    expect(sim.phase).toBe('delivered');
    expect(sim.rest.delivery).toBe(true);
    expect(sim.condition).toBe(100);
    // It's on the stage, 6 m under the jetty.
    expect(sim.rest.y).toBeCloseTo(ROUTE.cargo.y, 3);
    expect(Math.hypot(sim.rest.x - ROUTE.cargo.x, sim.rest.z - ROUTE.cargo.z)).toBeLessThan(ROUTE.cargo.radius);
    // Lowered straight down from a ship lying as practice cargo starts it, it hits the bullseye.
    expect(targetPoints(ROUTE, sim.rest.x, sim.rest.z)).toBe(100);
  });

  it('needs slack in the line before the hook slips out, and isn\'t delivered until then', () => {
    const { sim, ship, input } = calm();
    input.doorOpen = true;
    let landedAt = -1;
    run(sim, ship, input, 80, (t) => {
      if (sim.phase === 'landed' && landedAt < 0) landedAt = input.line;
      return landedAt < 0 ? LINE_ABOARD + 0.15 * t : landedAt + 0.2;
    });
    expect(sim.phase).toBe('landed');
    input.line = landedAt + 0.45;
    run(sim, ship, input, 0.2);
    expect(sim.phase).toBe('delivered');
    expect(sim.carried).toBe(false);
  });

  it('lowered fast, it lands hard and is knocked', () => {
    const { sim, ship, input } = calm();
    input.doorOpen = true;
    run(sim, ship, input, 30, (t) => LINE_ABOARD + 0.6 * t);
    expect(['landed', 'delivered']).toContain(sim.phase);
    expect(sim.condition).toBeLessThan(70);
    expect(sim.condition).toBeGreaterThan(40);
  });

  it('swings in the eddies below the keel; a hand held still on the tag line only slows it, and one working against the swing steadies it', () => {
    const swingOver = (hand: 'none' | 'still' | 'working', scale: number) => {
      const { sim, ship, input } = calm();
      input.doorOpen = true;
      input.windScale = scale;
      input.windX = 0.4 * scale;
      // Lower it to 5 m under the block, then watch it.
      run(sim, ship, input, 25, (t) => Math.min(LINE_ABOARD + 0.2 * t, 5));
      input.tagHeld = hand !== 'none';
      input.tagX = HATCH_CENTER[0];
      input.tagZ = HATCH_CENTER[1];
      // Working the line: the hand moves against the crate's swing as fast as it, staying within 30 cm of over the hatch.
      const work = () => {
        if (hand !== 'working') return;
        input.tagX = Math.max(HATCH_CENTER[0] - 0.3, Math.min(HATCH_CENTER[0] + 0.3, input.tagX - sim.vel.x * DT));
        input.tagZ = Math.max(HATCH_CENTER[1] - 0.3, Math.min(HATCH_CENTER[1] + 0.3, input.tagZ - sim.vel.z * DT));
      };
      // How far it swings either side of where it hangs (the steady wind holds it a little to one side).
      const lo = { x: Infinity, z: Infinity };
      const hi = { x: -Infinity, z: -Infinity };
      run(sim, ship, input, 10, undefined, work);
      run(sim, ship, input, 30, undefined, () => {
        work();
        lo.x = Math.min(lo.x, sim.pos.x);
        lo.z = Math.min(lo.z, sim.pos.z);
        hi.x = Math.max(hi.x, sim.pos.x);
        hi.z = Math.max(hi.z, sim.pos.z);
      });
      return Math.hypot(hi.x - lo.x, hi.z - lo.z) / 2;
    };
    const calmAir = swingOver('none', 0);
    const normal = swingOver('none', 1);
    const double = swingOver('none', 2);
    const held = swingOver('still', 2);
    const worked = swingOver('working', 2);
    expect(calmAir).toBeLessThan(0.05);
    expect(normal).toBeGreaterThan(0.12);
    expect(double).toBeGreaterThan(normal);
    // Held still, it still swings more than half as far...
    expect(held).toBeGreaterThan(double * 0.55);
    // ...but worked against, it settles to less than a third.
    expect(worked).toBeLessThan(double / 3);
  });

  it('scrapes the trunk when a swinging crate is hoisted back in', () => {
    const { sim, ship, input } = calm();
    input.doorOpen = true;
    run(sim, ship, input, 10, (t) => Math.min(LINE_ABOARD + 0.3 * t, 3.5));
    sim.vel.x = 0.9;
    run(sim, ship, input, 6, (t) => Math.max(LINE_ABOARD, 3.5 - 0.5 * t));
    expect(sim.knocks).toBeGreaterThan(0);
    expect(sim.condition).toBeLessThan(100);
    expect(Math.abs(sim.pos.x - HATCH_CENTER[0])).toBeLessThanOrEqual(0.051);
  });

  it("puts the hatch of a ship made fast straight out from the post right over the stage's target", () => {
    const f = { x: 0, y: 0, z: 0 };
    shipToWorld(madeFast(), HATCH_CENTER[0], 0, HATCH_CENTER[1], f);
    expect(Math.hypot(f.x - ROUTE.cargo.x, f.z - ROUTE.cargo.z)).toBeLessThan(0.05);
  });

  it('puts the hatch of a ship made fast at the post over the cargo stage whichever way round the post it lies', () => {
    const f = { x: 0, y: 0, z: 0 };
    for (let bearing = -60; bearing <= 60; bearing += 15) {
      const ship = madeFast();
      // Swing the ship round the post, keeping the fairlead 1.2 m from it.
      const turn = (bearing * Math.PI) / 180;
      const post = ROUTE.dock;
      const dx = ship.x - post.x;
      const dz = ship.z - post.z;
      ship.x = post.x + dx * Math.cos(turn) + dz * Math.sin(turn);
      ship.z = post.z - dx * Math.sin(turn) + dz * Math.cos(turn);
      ship.yaw += turn;
      updateQuaternion(ship);
      shipToWorld(ship, HATCH_CENTER[0], -CRATE_HEIGHT, HATCH_CENTER[1], f);
      const out = { y: 0, delivery: false };
      ground(f.x, f.z, f.y, out);
      expect(out.delivery, `bearing ${bearing}°`).toBe(true);
    }
  });
});
