import { describe, expect, it } from 'vitest';
import {
  alongsidePost,
  DockingSim,
  FAIRLEAD,
  LINE_LENGTH,
  MADE_FAST_LINE,
  shipToWorld,
  TEAR_SECONDS,
  worldToShip,
} from '../src/sim/docking.js';
import { createFlightControls, FlightSim } from '../src/sim/flight.js';
import { hitsIsland } from '../src/sim/islands.js';
import { CALM_SKIES } from '../src/sim/route.js';
import { createShipState, GRAVITY, type ShipState } from '../src/sim/ship-motion.js';

const DT = 1 / 90;
const POST = CALM_SKIES.dock;
const ISLANDS = [CALM_SKIES.start, CALM_SKIES.finish];

/** Way out from island B through its post, across the ground. */
const OUT = (() => {
  const dx = POST.x - CALM_SKIES.finish.x;
  const dz = POST.z - CALM_SKIES.finish.z;
  const d = Math.hypot(dx, dz);
  return { x: dx / d, z: dz / d };
})();

/**
 * A flight with the ship off the end of the jetty, its port side (where the
 * fairlead is) to the post, the fairlead `across` metres out from it and
 * `high` metres above its top.
 */
function alongside(across: number, high = 0): { ship: ShipState; flight: FlightSim; dock: DockingSim } {
  const ship = createShipState();
  const flight = new FlightSim();
  // Port (ship -X) faces back towards the post.
  const yaw = Math.atan2(-OUT.z, OUT.x);
  flight.reset(ship, 0, 0, 0, yaw);
  const f = { x: 0, y: 0, z: 0 };
  shipToWorld(ship, FAIRLEAD[0], FAIRLEAD[1], FAIRLEAD[2], f);
  // Move the ship so its fairlead is where it should be.
  const dock = new DockingSim(POST);
  flight.reset(ship, POST.x + OUT.x * across - f.x, dock.postTop + high - f.y, POST.z + OUT.z * across - f.z, yaw);
  return { ship, flight, dock };
}

/** Step the flight with the envelope held at floating heat, and the line holding the ship. */
function fly(t: { ship: ShipState; flight: FlightSim; dock: DockingSim }, seconds: number, lineOut: (time: number) => number, crank = 0): void {
  const c = createFlightControls();
  c.crankSpeed = crank;
  for (let time = 0; time < seconds; time += DT) {
    t.flight.heat = t.flight.balanceHeat(0);
    t.flight.step(t.ship, c, DT);
    t.dock.lineOut = lineOut(time);
    t.dock.constrain(t.ship, t.dock.lineOut, DT);
  }
}

/** A throw from the fairlead that reaches (x, y, z) after `seconds`. */
function throwAt(ship: ShipState, x: number, y: number, z: number, seconds: number) {
  const f = { x: 0, y: 0, z: 0 };
  shipToWorld(ship, FAIRLEAD[0], FAIRLEAD[1], FAIRLEAD[2], f);
  return {
    x: f.x,
    y: f.y,
    z: f.z,
    vx: (x - f.x) / seconds,
    vy: (y - f.y) / seconds + 0.5 * GRAVITY * seconds,
    vz: (z - f.z) / seconds,
    time: ship.time,
  };
}

function flyGrapple(dock: DockingSim, ship: ShipState, seconds: number): string[] {
  const events: string[] = [];
  for (let t = 0; t < seconds && dock.phase === 'flying'; t += DT) {
    ship.time += DT;
    const e = dock.stepFlight(ship, ship.time, ISLANDS);
    if (e !== 'none') events.push(e);
  }
  return events;
}

describe('docking', () => {
  it('turns points between ship and world space and back', () => {
    const { ship } = alongside(5);
    const w = { x: 0, y: 0, z: 0 };
    const back = { x: 0, y: 0, z: 0 };
    shipToWorld(ship, 0.3, 1.2, -0.7, w);
    worldToShip(ship, w.x, w.y, w.z, back);
    expect(back.x).toBeCloseTo(0.3);
    expect(back.y).toBeCloseTo(1.2);
    expect(back.z).toBeCloseTo(-0.7);
  });

  it('a throw at the post catches round it, paying out the line it flew', () => {
    const { ship, dock } = alongside(5);
    dock.throwGrapple(throwAt(ship, POST.x, dock.postTop - 0.3, POST.z, 0.8));
    expect(flyGrapple(dock, ship, 2)).toEqual(['caught']);
    expect(dock.phase).toBe('hooked');
    expect(dock.flightLine).toBeGreaterThan(4);
    expect(dock.flightLine).toBeLessThan(6);
  });

  it('a throw wide of the post runs the line out and hangs, and goes back on its hook once hauled in', () => {
    const { ship, dock } = alongside(5);
    // Two metres to the side of the post, and too far.
    dock.throwGrapple(throwAt(ship, POST.x + OUT.z * 2 + OUT.x * -8, dock.postTop - 6, POST.z - OUT.x * 2 + OUT.z * -8, 1.5));
    expect(flyGrapple(dock, ship, 4)).toEqual(['fell']);
    expect(dock.phase).toBe('hanging');
    expect(dock.flightLine).toBeLessThanOrEqual(LINE_LENGTH);
    expect(dock.stowIfIn(2)).toBe(false);
    expect(dock.stowIfIn(0.2)).toBe(true);
    expect(dock.phase).toBe('stowed');
  });

  it('a gentle lob back aboard goes back on its hook', () => {
    const { ship, dock } = alongside(5);
    const f = { x: 0, y: 0, z: 0 };
    shipToWorld(ship, 0, 0.6, 0, f);
    dock.throwGrapple(throwAt(ship, f.x, f.y, f.z, 0.7));
    expect(flyGrapple(dock, ship, 2)).toEqual(['aboard']);
    expect(dock.phase).toBe('stowed');
  });

  it('the line stops the ship pulling away, without jolting the felt gravity', () => {
    const t = alongside(4);
    t.dock.phase = 'hooked';
    // Crank hard: the bow points across the line, so this drives the ship along and away round the post.
    let worstAccel = 0;
    const c = createFlightControls();
    c.crankSpeed = 4;
    for (let time = 0; time < 20; time += DT) {
      t.flight.heat = t.flight.balanceHeat(0);
      t.flight.step(t.ship, c, DT);
      t.dock.constrain(t.ship, 4, DT);
      // (Skipping the wind's first push on a flight started in mid-air.)
      if (time > 1) worstAccel = Math.max(worstAccel, Math.hypot(t.ship.ax, t.ship.az));
    }
    expect(t.dock.phase).toBe('hooked');
    expect(t.dock.across).toBeLessThan(4.6);
    expect(worstAccel).toBeLessThan(1);
  });

  it('hauling the line in draws the ship to the post, and short and level makes it fast', () => {
    const t = alongside(6);
    t.dock.phase = 'hooked';
    // Haul in at 0.8 m/s.
    fly(t, 12, (time) => Math.max(MADE_FAST_LINE - 0.1, 6 - 0.8 * time));
    expect(t.dock.phase).toBe('fast');
    expect(t.dock.across).toBeLessThan(2.2);
    // Made fast, the ship is held where it is, whatever the crank and wind do.
    const held = { x: t.ship.x, y: t.ship.y, z: t.ship.z };
    fly(t, 5, () => MADE_FAST_LINE - 0.1, 5);
    expect(Math.hypot(t.ship.x - held.x, t.ship.y - held.y, t.ship.z - held.z)).toBeLessThan(1e-6);
  });

  it("doesn't make fast with the deck too high, and tears off if it stays far too high", () => {
    const t = alongside(1.2, 2);
    t.dock.phase = 'hooked';
    fly(t, 0.5, () => 1.2);
    expect(t.dock.phase).toBe('hooked');
    expect(t.dock.heightOff).toBeCloseTo(2, 1);
    // Higher than the tear height for longer than the tear time.
    t.ship.y += 1;
    fly(t, TEAR_SECONDS + 0.2, () => 1.2);
    expect(t.dock.phase).toBe('hanging');
    expect(t.dock.tears).toBe(1);
  });

  it('practice docking starts the ship beside the post, level, port side to it, and clear of island B', () => {
    const at = alongsidePost(POST, CALM_SKIES.finish.x, CALM_SKIES.finish.z, 5);
    const ship = createShipState();
    new FlightSim().reset(ship, at.x, at.y, at.z, at.yaw);
    const dock = new DockingSim(POST);
    dock.measure(ship);
    expect(dock.across).toBeCloseTo(5, 3);
    expect(dock.heightOff).toBeCloseTo(0, 3);
    // The fairlead is the side of the deck nearest the post.
    const f = { x: 0, y: 0, z: 0 };
    shipToWorld(ship, -FAIRLEAD[0], FAIRLEAD[1], FAIRLEAD[2], f);
    expect(Math.hypot(f.x - POST.x, f.z - POST.z)).toBeGreaterThan(6);
    expect(hitsIsland(CALM_SKIES.finish, ship.x, ship.y, ship.z)).toBe(false);
  });

  it('a ship made fast at the post, even low, is clear of island B', () => {
    const { ship } = alongside(MADE_FAST_LINE, -1);
    expect(hitsIsland(CALM_SKIES.finish, ship.x, ship.y, ship.z)).toBe(false);
  });
});
