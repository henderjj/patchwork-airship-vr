import { describe, expect, it } from 'vitest';
import { GONDOLA_COLLIDERS } from '../src/scene-assets/gondola.scene-asset.js';
import { CargoSim } from '../src/sim/cargo.js';
import { DEFAULT_FLIGHT, FlightSim } from '../src/sim/flight.js';
import {
  type Arch,
  archUnderside,
  type Cleft,
  crossesPassage,
  deckWindow,
  fromPassage,
  HULL_SPHERES,
  lookoutCall,
  PassageContact,
  PRACTICE_RUN_IN,
  rockDistance,
  SCRAPE_GAP,
  toPassage,
  windowMiddle,
} from '../src/sim/passages.js';
import { CALM_SKIES, MISSED_POINTS, routeGates, routeIslands, RouteRun, scoreRun, SHIP_MIDDLE } from '../src/sim/route.js';
import { createShipState } from '../src/sim/ship-motion.js';
import { CrateYard, obstaclesFrom, PRACTICE_DECK } from '../src/sim/stowage.js';

const ROUTE = CALM_SKIES;
const CLEFT = ROUTE.passages[0] as Cleft;
const ARCH = ROUTE.passages[1] as Arch;

/** A world point at (across, height, along) in passage `p`'s frame. */
function at(p: Cleft | Arch, u: number, y: number, w: number): [number, number, number] {
  const { x, z } = fromPassage(p, u, w, { x: 0, z: 0 });
  return [p.x + x, y, p.z + z];
}

/** The ship's deck at (across, height, along) in passage `p`'s frame, heading along its way through. */
function shipAt(p: Cleft | Arch, u: number, y: number, w: number) {
  const [x, , z] = at(p, u, y, w);
  return { x, y, z, yaw: p.yaw, vx: 0, vy: 0, vz: 0 };
}

/** How far the hull's nearest sphere is from the rock (negative when in it), for a ship as `shipAt` gives. */
function hullClearance(p: Cleft | Arch, ship: { x: number; y: number; z: number; yaw: number }): number {
  const c = Math.cos(ship.yaw);
  const s = Math.sin(ship.yaw);
  let nearest = Number.POSITIVE_INFINITY;
  for (const sphere of HULL_SPHERES) {
    const x = ship.x + sphere.x * c + sphere.z * s;
    const z = ship.z - sphere.x * s + sphere.z * c;
    nearest = Math.min(nearest, rockDistance(p, x, ship.y + sphere.y, z) - sphere.r);
  }
  return nearest;
}

describe('passages: the rock', () => {
  it('turns between world and passage frames and back, with ahead along the way through', () => {
    for (const p of ROUTE.passages) {
      const [x, , z] = at(p, 3, 0, -20);
      const back = toPassage(p, x, z, { u: 0, w: 0 });
      expect(back.u).toBeCloseTo(3);
      expect(back.w).toBeCloseTo(-20);
      // Heading along the way through, a ship's forward (-sin yaw, -cos yaw) takes w up, and its starboard u.
      const ahead = toPassage(p, p.x - Math.sin(p.yaw), p.z - Math.cos(p.yaw), { u: 0, w: 0 });
      expect(ahead.w).toBeCloseTo(1);
      const starboard = toPassage(p, p.x + Math.cos(p.yaw), p.z - Math.sin(p.yaw), { u: 0, w: 0 });
      expect(starboard.u).toBeCloseTo(1);
    }
  });

  it('puts the Cleft’s walls 13 m apart, its floor under the gap, and leaves the gorge open to the sky', () => {
    const mid = CLEFT.floor + 10;
    expect(rockDistance(CLEFT, ...at(CLEFT, CLEFT.half, mid, 0))).toBeCloseTo(0, 1);
    expect(rockDistance(CLEFT, ...at(CLEFT, -CLEFT.half, mid, 0))).toBeCloseTo(0, 1);
    expect(rockDistance(CLEFT, ...at(CLEFT, 0, mid, 0))).toBeCloseTo(CLEFT.half, 1);
    expect(rockDistance(CLEFT, ...at(CLEFT, 0, CLEFT.floor, 0))).toBeCloseTo(0, 1);
    expect(rockDistance(CLEFT, ...at(CLEFT, 0, CLEFT.floor - 1, 0))).toBeLessThan(0);
    expect(rockDistance(CLEFT, ...at(CLEFT, 9, mid, 0))).toBeLessThan(0);
    expect(rockDistance(CLEFT, ...at(CLEFT, 0, CLEFT.floor + CLEFT.walls + 30, 0))).toBeGreaterThan(20);
  });

  it('puts the Arch’s span 14 m over its grass and its legs 16 m apart', () => {
    expect(archUnderside(ARCH)).toBe(ARCH.ground + 14);
    expect(rockDistance(ARCH, ...at(ARCH, 0, archUnderside(ARCH), 0))).toBeCloseTo(0, 1);
    expect(rockDistance(ARCH, ...at(ARCH, ARCH.half, ARCH.ground + 3, 0))).toBeCloseTo(0, 1);
    expect(rockDistance(ARCH, ...at(ARCH, -ARCH.half, ARCH.ground + 3, 0))).toBeCloseTo(0, 1);
    expect(rockDistance(ARCH, ...at(ARCH, 0, ARCH.ground, 0))).toBeCloseTo(0, 1);
    // The rock is deeper along the way through than across.
    expect(rockDistance(ARCH, ...at(ARCH, ARCH.half + ARCH.thickness, ARCH.ground + 3, ARCH.thickness * ARCH.deep))).toBeCloseTo(0, 1);
    // Clear air beside the arch, over its island.
    expect(rockDistance(ARCH, ...at(ARCH, 0, archUnderside(ARCH), 10))).toBeGreaterThan(3);
  });

  it('gives each passage a deck window the whole hull fits through, from end to end', () => {
    const cleft = deckWindow(CLEFT);
    expect(cleft.high - cleft.low).toBeGreaterThan(8);
    const arch = deckWindow(ARCH);
    expect(arch.high - arch.low).toBeCloseTo(3.15, 2);
    for (const p of ROUTE.passages) {
      const { low, high } = deckWindow(p);
      for (const y of [low, windowMiddle(p), high]) {
        for (let w = -40; w <= 40; w += 1) {
          expect(hullClearance(p, shipAt(p, 0, y, w)), `${p.name} at deck ${y.toFixed(1)}, ${w} m along`).toBeGreaterThan(-1e-6);
        }
      }
      // Out of the window, it doesn't (the Cleft's window keeps 0.8 m over its rough floor).
      expect(hullClearance(p, shipAt(p, 0, low - (p.kind === 'cleft' ? 1.3 : 0.5), 0))).toBeLessThan(0);
      if (p.kind === 'arch') expect(hullClearance(p, shipAt(p, 0, high + 0.5, 0))).toBeLessThan(0);
      // Nor does it fit with the envelope's middle a wall's width off the middle line.
      expect(hullClearance(p, shipAt(p, p.half - 2, windowMiddle(p), 0))).toBeLessThan(0);
    }
  });

  it('counts a passage flown through between its rock, and not one flown round or over', () => {
    for (const p of ROUTE.passages) {
      const y = windowMiddle(p) + SHIP_MIDDLE;
      expect(crossesPassage(p, ...at(p, 0, y, -2), ...at(p, 1, y, 2))).toBe(true);
      // Either way through.
      expect(crossesPassage(p, ...at(p, 0, y, 2), ...at(p, 0, y, -2))).toBe(true);
      expect(crossesPassage(p, ...at(p, p.half + 1, y, -2), ...at(p, p.half + 1, y, 2))).toBe(false);
      expect(crossesPassage(p, ...at(p, 0, y, -6), ...at(p, 0, y, -2))).toBe(false);
    }
    const over = archUnderside(ARCH) + 6;
    expect(crossesPassage(ARCH, ...at(ARCH, 0, over, -2), ...at(ARCH, 0, over, 2))).toBe(false);
    const above = CLEFT.floor + CLEFT.walls + 5;
    expect(crossesPassage(CLEFT, ...at(CLEFT, 0, above, -2), ...at(CLEFT, 0, above, 2))).toBe(false);
  });
});

describe('passages: on the route', () => {
  it('flies ring 1, the Cleft, ring 2, then the Arch', () => {
    expect(routeGates(ROUTE)).toEqual([
      { kind: 'ring', index: 0 },
      { kind: 'passage', index: 0 },
      { kind: 'ring', index: 1 },
      { kind: 'passage', index: 1 },
    ]);
  });

  it('lines each passage up with the straight line between the gates either side of it', () => {
    // The Cleft on the line from ring 1 to ring 2, the Arch on the line from ring 2 to B's post.
    const lines: [Cleft | Arch, { x: number; z: number }, { x: number; z: number }][] = [
      [CLEFT, ROUTE.rings[0], ROUTE.rings[1]],
      [ARCH, ROUTE.rings[1], ROUTE.dock],
    ];
    for (const [p, a, b] of lines) {
      const from = toPassage(p, a.x, a.z, { u: 0, w: 0 });
      const to = toPassage(p, b.x, b.z, { u: 0, w: 0 });
      expect(Math.abs(from.u)).toBeLessThan(1);
      expect(Math.abs(to.u)).toBeLessThan(1);
      expect(from.w).toBeLessThan(-PRACTICE_RUN_IN + 10);
      expect(to.w).toBeGreaterThan(40);
    }
  });

  it('keeps the passages’ rock clear of the rings, the drafts and the route’s islands', () => {
    for (const p of ROUTE.passages) {
      for (const ring of ROUTE.rings) {
        // The ring's rim and the ship flying through it.
        expect(rockDistance(p, ring.x, ring.y, ring.z)).toBeGreaterThan(ring.radius + 10);
      }
      for (const d of ROUTE.drafts) {
        expect(Math.hypot(d.x - p.x, d.z - p.z), `${p.name} from a draft`).toBeGreaterThan(d.radius + 30);
      }
      for (const island of routeIslands(ROUTE)) {
        for (let y = island.y - island.depth; y <= island.y + 15; y += 1) {
          expect(rockDistance(p, island.x, y, island.z), `${p.name} from an island at ${island.x}, ${island.z}`).toBeGreaterThan(island.radius + 5);
        }
      }
    }
  });

  it('counts passages flown through, and scores a missed one like a missed ring and each scrape', () => {
    const run = new RouteRun(ROUTE);
    run.phase = 'flying';
    const y = windowMiddle(CLEFT);
    const ship = { x: 0, y, z: 0, time: 0 };
    for (let w = -10; w <= 10; w += 0.5) {
      [ship.x, , ship.z] = at(CLEFT, 0, y, w);
      ship.time += 0.1;
      run.step(ship, false, false, 0, 0, 0.1, false);
    }
    expect(run.passMask).toBe(1);
    expect(run.passes).toBe(1);
    run.reset();
    expect(run.passMask).toBe(0);
    expect(run.scrapes).toBe(0);

    const base = { seconds: 120, bricks: 6, rings: 2, ringsTotal: 2, tears: 0, cargo: 100, crates: 2, cratesTotal: 2, target: 0 };
    const all = scoreRun({ ...base, passes: 2, passesTotal: 2 }).score;
    expect(scoreRun(base).score).toBe(all);
    expect(scoreRun({ ...base, passes: 1, passesTotal: 2 }).score).toBe(all - MISSED_POINTS);
    expect(scoreRun({ ...base, passes: 2, passesTotal: 2, scrapes: 2 }).score).toBe(all - 50);
  });

  it('counts the gates before a practice start as flown', () => {
    const run = new RouteRun(ROUTE);
    const gates = routeGates(ROUTE);
    run.flownBefore(gates, 3);
    expect(run.ringMask).toBe(3);
    expect(run.passMask).toBe(1);
  });
});

describe('passages: contact', () => {
  it('eases a ship drifting into a wall back out, stops its drift into it and calls it a scrape of the envelope', () => {
    const contact = new PassageContact();
    const y = windowMiddle(CLEFT);
    const ship = shipAt(CLEFT, 4, y, 0);
    // Drifting to starboard at 1 m/s, and on along the way through at 3 m/s.
    const c = Math.cos(CLEFT.yaw);
    const s = Math.sin(CLEFT.yaw);
    ship.vx = c * 1 - s * 3;
    ship.vz = -s * 1 - c * 3;
    const hit = contact.step(ROUTE.passages, ship, 10);
    expect(hit).not.toBeNull();
    expect(hit!.part).toBe('envelope');
    expect(hit!.speed).toBeCloseTo(1, 1);
    expect(contact.touching).toBe(true);
    // Out of the rock, the normal pointing back to port.
    expect(hullClearance(CLEFT, ship)).toBeGreaterThan(-0.02);
    const n = toPassage(CLEFT, CLEFT.x + contact.normal.x, CLEFT.z + contact.normal.z, { u: 0, w: 0 });
    expect(n.u).toBeCloseTo(-1, 1);
    // No drift into the wall left, but still going on along it.
    const across = ship.vx * c - ship.vz * s;
    const along = -ship.vx * s - ship.vz * c;
    expect(across).toBeCloseTo(0, 2);
    expect(along).toBeCloseTo(3, 1);
  });

  it('counts grinding along the rock as one scrape, and touching again after a clear second as another', () => {
    const contact = new PassageContact();
    const y = windowMiddle(CLEFT);
    const push = (time: number) => {
      const ship = shipAt(CLEFT, 4, y, 0);
      ship.vx = Math.cos(CLEFT.yaw) * 0.5;
      ship.vz = -Math.sin(CLEFT.yaw) * 0.5;
      return contact.step(ROUTE.passages, ship, time);
    };
    expect(push(0)).not.toBeNull();
    for (let t = 0.1; t < 3; t += 0.1) {
      expect(push(t)).toBeNull();
    }
    expect(contact.grinding(2.95)).toBe(true);
    // Clear of the rock for less than the gap: still the same scrape.
    expect(contact.step(ROUTE.passages, shipAt(CLEFT, 0, y, 0), 3.2)).toBeNull();
    expect(contact.touching).toBe(false);
    expect(contact.grinding(3.1)).toBe(true);
    expect(contact.grinding(3.4)).toBe(false);
    expect(push(3 + SCRAPE_GAP * 0.5)).toBeNull();
    // Clear for longer: a new one.
    expect(push(3.5 + SCRAPE_GAP + 0.1)).not.toBeNull();
  });

  it('calls the gondola’s scrape when the keel drags on the floor or the grass', () => {
    for (const p of ROUTE.passages) {
      const contact = new PassageContact();
      // The keel 0.4 m into the gorge's floor or the arch's grass.
      const base = p.kind === 'cleft' ? p.floor : p.ground;
      const ship = shipAt(p, 0, base + 0.3, 0);
      ship.vy = -0.6;
      const hit = contact.step(ROUTE.passages, ship, 0);
      expect(hit?.part).toBe('gondola');
      expect(hit!.speed).toBeCloseTo(0.6, 1);
      expect(ship.vy).toBeCloseTo(0, 2);
      expect(contact.normal.y).toBeGreaterThan(0.9);
      expect(ship.y).toBeGreaterThan(base + 0.65);
    }
  });

  it('leaves a ship well clear of every passage alone', () => {
    const contact = new PassageContact();
    const ship = { x: 0, y: 130, z: -80, yaw: 0, vx: 1, vy: 0, vz: -3 };
    expect(contact.step(ROUTE.passages, ship, 0)).toBeNull();
    expect(contact.touching).toBe(false);
    expect(ship).toEqual({ x: 0, y: 130, z: -80, yaw: 0, vx: 1, vy: 0, vz: -3 });
  });

  it('takes the flight model’s push into the rock away, but not its push along it', () => {
    const sim = new FlightSim({ ...DEFAULT_FLIGHT, windSpeed: 0, windVariation: 0 });
    const ship = createShipState(130);
    sim.reset(ship, 0, 130, 0, 0);
    // Bow first into rock ahead: the airspeed goes.
    sim.airspeed = 4;
    sim.bump(ship, Math.sin(ship.yaw), 0, Math.cos(ship.yaw));
    expect(sim.airspeed).toBeCloseTo(0);
    // Rock alongside: the airspeed stays.
    sim.airspeed = 4;
    sim.bump(ship, Math.cos(ship.yaw), 0, -Math.sin(ship.yaw));
    expect(sim.airspeed).toBeCloseTo(4);
    // Keel on the floor while sinking: the sink goes.
    sim.climb = -1;
    sim.bump(ship, 0, 1, 0);
    expect(sim.climb).toBe(0);
    // Floor under a climbing ship: the climb stays.
    sim.climb = 1;
    sim.bump(ship, 0, 1, 0);
    expect(sim.climb).toBe(1);
  });

  it('knocks every crate aboard when the gondola scrapes', () => {
    const yard = new CrateYard(obstaclesFrom(GONDOLA_COLLIDERS));
    const cargo = new CargoSim();
    yard.reset(ROUTE.loading, cargo);
    // Still on the loading stage: nothing aboard to knock.
    yard.jolt(cargo, 10);
    expect(yard.crates.every((c) => c.condition === 100)).toBe(true);
    yard.stowAboard(cargo, PRACTICE_DECK);
    yard.jolt(cargo, 10);
    expect(cargo.condition).toBe(90);
    expect(yard.crates.slice(1).every((c) => c.condition === 90)).toBe(true);
  });
});

describe('passages: the lookout', () => {
  /** The call for a ship at (across, deck height, along) going along the way through at 3 m/s and across at `drift`. */
  function call(p: Cleft | Arch, u: number, y: number, w: number, drift = 0) {
    const [x, , z] = at(p, u, y, w);
    const c = Math.cos(p.yaw);
    const s = Math.sin(p.yaw);
    return lookoutCall(p, x, y, z, c * drift - s * 3, -s * drift - c * 3);
  }

  it('calls up or down to the window, then port or starboard, then steady', () => {
    for (const p of ROUTE.passages) {
      const { low, high } = deckWindow(p);
      expect(call(p, 0, low - 2, -50)).toBe('UP');
      expect(call(p, 0, high + 2, -50)).toBe('DOWN');
      expect(call(p, p.half - 2, windowMiddle(p), -50)).toBe('PORT');
      expect(call(p, 2 - p.half, windowMiddle(p), -50)).toBe('STARBOARD');
      expect(call(p, 0, windowMiddle(p), -50)).toBe('STEADY');
      // Heading for the starboard wall, though in the middle now.
      expect(call(p, 0, windowMiddle(p), -12, 1.5)).toBe('PORT');
    }
  });

  it('only calls on the way in and just through', () => {
    for (const p of ROUTE.passages) {
      expect(call(p, 0, windowMiddle(p), -150)).toBeNull();
      expect(call(p, 0, windowMiddle(p), 30)).toBeNull();
      // Nor far off to one side, level with it.
      expect(call(p, 60, windowMiddle(p), -50)).toBeNull();
      expect(call(p, 0, windowMiddle(p), 5)).toBe('STEADY');
    }
  });
});
