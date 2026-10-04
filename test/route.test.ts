import { describe, expect, it } from 'vitest';
import { createFlightControls, DEFAULT_FLIGHT, FlightSim } from '../src/sim/flight.js';
import { KEEL_DEPTH } from '../src/sim/gondola-layout.js';
import { groundBelow, hitsIsland, type Island, islandDepth, layoutIslands, restingDeck, SHIP_RADIUS } from '../src/sim/islands.js';
import { CALM_SKIES, crossesRing, distanceFromRoute, LAND_HOLD_SECONDS, RouteRun, scoreRun } from '../src/sim/route.js';
import { createShipState } from '../src/sim/ship-motion.js';

const DT = 1 / 90;
const CALM = { ...DEFAULT_FLIGHT, windSpeed: 0, windVariation: 0 };
const PAD: Island = { x: 0, y: 100, z: 0, radius: 10, depth: 12 };

describe('islands', () => {
  it('lays out the same islands for the same seed, keeping clear where asked', () => {
    const a = layoutIslands(3, 40);
    const b = layoutIslands(3, 40);
    expect(a).toEqual(b);
    const clear = layoutIslands(3, 40, (x, z, r) => Math.hypot(x, z) > 300 + r);
    expect(clear).toHaveLength(40);
    for (const island of clear) {
      expect(Math.hypot(island.x, island.z)).toBeGreaterThan(300 + island.radius);
    }
  });

  it('gives each island shape a rock depth between its shallowest and deepest', () => {
    for (let seed = 0; seed < 20; seed++) {
      const depth = islandDepth(seed);
      expect(depth).toBeGreaterThanOrEqual(1.28);
      expect(depth).toBeLessThanOrEqual(2.18);
    }
  });

  it('only lets the deck rest on a top it comes down onto', () => {
    // The keel rests on the grass, so the deck is a little above it.
    const deck = restingDeck(PAD);
    expect(deck).toBe(100 + KEEL_DEPTH);
    expect(groundBelow([PAD], 2, 3, 101)).toBe(deck);
    expect(groundBelow([PAD], 2, 3, deck)).toBe(deck);
    // Beside or under the island, there is nothing to rest on.
    expect(groundBelow([PAD], 15, 0, 101)).toBe(Number.NEGATIVE_INFINITY);
    expect(groundBelow([PAD], 0, 0, 95)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('counts running into the rock, but not resting on top or passing well below', () => {
    expect(hitsIsland(PAD, 0, restingDeck(PAD), 0)).toBe(false);
    // Alongside the rim, with the keel a little below the top.
    expect(hitsIsland(PAD, PAD.radius + SHIP_RADIUS - 0.5, 99.5, 0)).toBe(true);
    expect(hitsIsland(PAD, PAD.radius + SHIP_RADIUS + 0.5, 99.5, 0)).toBe(false);
    // Envelope under the tapering rock: hits near the middle, clears out wide.
    expect(hitsIsland(PAD, 0, 84, 0)).toBe(true);
    expect(hitsIsland(PAD, 9, 84, 0)).toBe(false);
    // Entirely below the tip.
    expect(hitsIsland(PAD, 0, 70, 0)).toBe(false);
  });
});

describe('landing', () => {
  it('settles onto an island top and stays put until it has lift', () => {
    const sim = new FlightSim(CALM);
    const ship = createShipState(100);
    sim.reset(ship, 0, 101, 0, 0);
    const c = createFlightControls();
    c.vent = 1;
    c.crankSpeed = 5;
    for (let i = 0; i < 90 * 20; i++) {
      sim.step(ship, c, DT, groundBelow([PAD], ship.x, ship.z, ship.y));
    }
    expect(sim.grounded).toBe(true);
    expect(ship.y).toBe(restingDeck(PAD));
    expect(sim.touchdownSpeed).toBeGreaterThan(0);
    // Cranking doesn't push a grounded ship along or turn it.
    const [x, z, yaw] = [ship.x, ship.z, ship.yaw];
    c.rudder = 1;
    for (let i = 0; i < 90 * 5; i++) {
      sim.step(ship, c, DT, groundBelow([PAD], ship.x, ship.z, ship.y));
    }
    expect([ship.x, ship.z, ship.yaw]).toEqual([x, z, yaw]);
    c.rudder = 0;
    c.vent = 0;
    c.crankSpeed = 0;
    c.burner = 1;
    for (let i = 0; i < 90 * 180 && sim.grounded; i++) {
      sim.step(ship, c, DT, groundBelow([PAD], ship.x, ship.z, ship.y));
    }
    expect(sim.grounded).toBe(false);
    expect(ship.y).toBeGreaterThan(restingDeck(PAD));
  });
  it('stays moored whatever its lift, then climbs from rest once cast off', () => {
    const sim = new FlightSim(CALM);
    const ship = createShipState(100);
    sim.reset(ship, 0, restingDeck(PAD), 0, 0);
    const c = createFlightControls();
    c.burner = 1;
    const step = (moored: boolean) => sim.step(ship, c, DT, groundBelow([PAD], ship.x, ship.z, ship.y), moored);
    for (let i = 0; i < 90 * 20; i++) {
      step(true);
    }
    expect(sim.liftRate(0)).toBeGreaterThan(0.5);
    expect(ship.y).toBe(restingDeck(PAD));
    expect(sim.climb).toBe(0);
    let fastest = 0;
    for (let i = 0; i < 90 * 2; i++) {
      step(false);
      fastest = Math.max(fastest, sim.climb);
    }
    expect(ship.y).toBeGreaterThan(restingDeck(PAD));
    // The climb builds at the comfort limit's 0.25 m/s², not all at once.
    expect(fastest).toBeLessThanOrEqual(0.5 + 1e-9);
  });
});

describe('route', () => {
  const ring = CALM_SKIES.rings[0];

  it('passes a ring flown through near its middle, either way', () => {
    expect(crossesRing(ring, ring.x, ring.y, ring.z + 5, ring.x + 2, ring.y - 3, ring.z - 5)).toBe(true);
    expect(crossesRing(ring, ring.x, ring.y, ring.z - 5, ring.x, ring.y, ring.z + 5)).toBe(true);
    // Outside the rim, or not reaching the ring.
    expect(crossesRing(ring, ring.x + 13, ring.y, ring.z + 5, ring.x + 13, ring.y, ring.z - 5)).toBe(false);
    expect(crossesRing(ring, ring.x, ring.y, ring.z + 9, ring.x, ring.y, ring.z + 1)).toBe(false);
  });

  it('measures how far the ship has strayed from the path', () => {
    expect(distanceFromRoute(CALM_SKIES, 0, -80)).toBeCloseTo(0);
    expect(distanceFromRoute(CALM_SKIES, 50, -80)).toBeCloseTo(50);
  });

  it('scores a quick, clean run better than a slow one that missed a ring', () => {
    const clean = scoreRun({ seconds: 120, bricks: 6, rings: 2, ringsTotal: 2, padDistance: 2, touchdown: 0.4 });
    const messy = scoreRun({ seconds: 220, bricks: 12, rings: 1, ringsTotal: 2, padDistance: 12, touchdown: 1.5 });
    expect(clean.score).toBeGreaterThan(messy.score);
    expect(clean.stars).toBe(3);
    expect(messy.stars).toBeLessThan(2);
  });

  it('times a run from lift-off, counts rings, and finishes after resting on island B', () => {
    const run = new RouteRun(CALM_SKIES);
    const s = { x: 0, y: restingDeck(CALM_SKIES.start), z: 0, time: 0 };
    expect(run.step(s, true, 0, 0, DT, false)).toBe(false);
    s.time = 10;
    s.y += 1;
    expect(run.step(s, false, 0, 0, DT, false)).toBe(true);
    expect(run.phase).toBe('flying');
    // Through ring 1.
    s.y = ring.y - 5;
    s.z = ring.z + 1;
    run.step(s, false, 0, 1, DT, false);
    s.z = ring.z - 1;
    expect(run.step(s, false, 0, 1, DT, false)).toBe(true);
    expect(run.ringMask).toBe(1);
    // Down on island B, a few metres off the pad.
    const b = CALM_SKIES.finish;
    Object.assign(s, { x: b.x + 3, y: restingDeck(b), z: b.z + 4, time: 130 });
    const steps = Math.ceil(LAND_HOLD_SECONDS / DT) + 1;
    for (let i = 0; i < steps && run.phase === 'flying'; i++) {
      run.step(s, true, 0.5, 5, DT, false);
    }
    expect(run.phase).toBe('finished');
    expect(run.result).toMatchObject({ seconds: 120, bricks: 5, rings: 1, ringsTotal: 2, touchdown: 0.5 });
    expect(run.result!.padDistance).toBeCloseTo(5);
    run.reset();
    expect(run.phase).toBe('ready');
    expect(run.result).toBeNull();
  });

  it('is lost on hitting an island, sinking into the haze or straying', () => {
    const run = new RouteRun(CALM_SKIES);
    const lift = () => {
      run.reset();
      run.step({ x: 0, y: restingDeck(CALM_SKIES.start) + 1, z: 0, time: 0 }, false, 0, 0, DT, false);
    };
    lift();
    run.step({ x: 0, y: 125, z: -50, time: 5 }, false, 0, 0, DT, true);
    expect([run.phase, run.lostReason]).toEqual(['lost', 'Ran into an island']);
    lift();
    run.step({ x: 0, y: 30, z: -50, time: 5 }, false, 0, 0, DT, false);
    expect(run.lostReason).toBe('Sank into the haze');
    lift();
    run.step({ x: 600, y: 125, z: -50, time: 5 }, false, 0, 0, DT, false);
    expect(run.lostReason).toBe('Drifted off the route');
  });

  it('keeps the route clear of its own islands', () => {
    const { start, finish, rings } = CALM_SKIES;
    for (const r of rings) {
      expect(hitsIsland(start, r.x, r.y, r.z)).toBe(false);
      expect(hitsIsland(finish, r.x, r.y, r.z)).toBe(false);
    }
    expect(finish.y).toBeLessThan(start.y);
  });
});
