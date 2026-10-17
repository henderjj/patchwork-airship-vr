import { describe, expect, it } from 'vitest';
import { windSound } from '../src/sim/audio-cues.js';
import { createFlightControls, DEFAULT_FLIGHT, DEFAULT_FLIGHT_LIMITS, FlightSim } from '../src/sim/flight.js';
import { CALM_SKIES } from '../src/sim/route.js';
import { createShipState } from '../src/sim/ship-motion.js';
import {
  DRAFT_EDGE,
  draftAt,
  FIRST_GUST,
  type Gust,
  GUST_WARNING,
  gustEnd,
  gustStrength,
  WindSim,
} from '../src/sim/wind.js';

const DEG = Math.PI / 180;
const DT = 1 / 90;
const CALM = { ...DEFAULT_FLIGHT, windSpeed: 0, windVariation: 0 };
/** The burner setting that holds the balancing heat. */
const HOLD = (DEFAULT_FLIGHT.cooling * DEFAULT_FLIGHT.balanceHeat) / DEFAULT_FLIGHT.burnerHeating;

const gust = (over: Partial<Gust> = {}): Gust => ({ id: 1, start: 10, heading: 0, peak: 2, rise: 6, hold: 6, fall: 6, ...over });

/** Step a wind sim from t0 to t1, returning each gust sent and when. */
function run(sim: WindSim, t0: number, t1: number, underWay = true, auto = true, yaw = 0): { at: number; gust: Gust }[] {
  const sent: { at: number; gust: Gust }[] = [];
  for (let t = t0; t < t1; t += 0.1) {
    if (sim.step(t, underWay, auto, yaw)) sent.push({ at: t, gust: sim.gust! });
  }
  return sent;
}

describe('gusts', () => {
  it('build up smoothly, hold and die away', () => {
    const g = gust();
    expect(gustStrength(g, 9)).toBe(0);
    expect(gustStrength(g, 10)).toBe(0);
    expect(gustStrength(g, 11)).toBeGreaterThan(0);
    expect(gustStrength(g, 11)).toBeLessThan(0.2);
    expect(gustStrength(g, 13)).toBeCloseTo(0.5, 5);
    expect(gustStrength(g, 18)).toBe(1);
    expect(gustStrength(g, 25)).toBeCloseTo(0.5, 5);
    expect(gustStrength(g, gustEnd(g))).toBe(0);
    expect(gustStrength(g, 40)).toBe(0);
  });

  it('wait for the run to be under way, then come one after another from abeam', () => {
    const sim = new WindSim();
    sim.reset(42);
    // Waiting on island A, nothing.
    expect(run(sim, 0, 120, false)).toHaveLength(0);
    // Under way from t = 120, with the ship heading 30° to port.
    const yaw = 30 * DEG;
    const sent = run(sim, 120, 600, true, true, yaw);
    expect(sent.length).toBeGreaterThanOrEqual(5);
    expect(sent[0].at - 120).toBeGreaterThanOrEqual(FIRST_GUST[0] - 0.1);
    expect(sent[0].at - 120).toBeLessThanOrEqual(FIRST_GUST[1] + 0.1);
    for (const [i, { at, gust: g }] of sent.entries()) {
      // Its front arrives a few seconds after the warning starts.
      expect(g.start - at).toBeCloseTo(GUST_WARNING, 5);
      expect(g.peak).toBeGreaterThanOrEqual(1);
      expect(g.peak).toBeLessThanOrEqual(1.6);
      // From abeam, give or take 0.4 rad, port or starboard.
      const across = Math.abs(Math.atan2(Math.sin(g.heading - yaw), Math.cos(g.heading - yaw)));
      expect(Math.abs(across - Math.PI / 2)).toBeLessThanOrEqual(0.4 + 1e-9);
      // A calm of at least 30 s after each one dies away.
      if (i > 0) expect(at - gustEnd(sent[i - 1].gust)).toBeGreaterThanOrEqual(30 - 0.1);
    }
    // Both sides turn up.
    const sides = new Set(sent.map(({ gust: g }) => Math.sign(Math.sin(g.heading - yaw))));
    expect(sides.size).toBe(2);
  });

  it('a fresh run draws different gusts; none come in still air or with gusts turned off', () => {
    const a = new WindSim();
    a.reset(1);
    const b = new WindSim();
    b.reset(2);
    expect(run(a, 0, 300)[0].at).not.toBe(run(b, 0, 300)[0].at);
    const still = new WindSim();
    still.reset(1);
    still.scale = 0;
    expect(run(still, 0, 300)).toHaveLength(0);
    const off = new WindSim();
    off.reset(1);
    expect(run(off, 0, 300, true, false)).toHaveLength(0);
  });

  it('Practice sends one at once, its front arriving after the warning, and blows at the wind setting', () => {
    const sim = new WindSim();
    sim.reset(5);
    sim.scale = 2;
    const g = sim.send(50, 0);
    expect(sim.warning(50)).toBeCloseTo(GUST_WARNING, 5);
    expect(sim.warning(52)).toBeCloseTo(GUST_WARNING - 2, 5);
    expect(sim.warning(g.start + 1)).toBe(0);
    expect(sim.warning(gustEnd(g) + 0.1)).toBe(-1);
    const v = sim.gustVelocity(g.start + g.rise + 1, { x: 0, z: 0 });
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(g.peak * 2, 5);
    // Abeam of a ship heading -Z, so it blows along X.
    expect(Math.abs(v.x)).toBeGreaterThan(Math.abs(v.z));
  });

  it("reach the guest as the host's, and a repeat doesn't restart it", () => {
    const host = new WindSim();
    host.reset(9);
    host.scale = 0.5;
    const g = host.send(12.3456, 1);
    const guest = new WindSim();
    guest.adopt(host.toWire(), host.scale);
    expect(guest.scale).toBe(0.5);
    expect(guest.gust!.id).toBe(g.id);
    expect(guest.gust!.start).toBeCloseTo(g.start, 2);
    expect(guest.gust!.heading).toBeCloseTo(g.heading, 2);
    const same = guest.gust;
    guest.adopt(host.toWire(), 0.5);
    expect(guest.gust).toBe(same);
    guest.adopt(null, 1);
    expect(guest.gust).toBeNull();
    guest.adopt(['x', 1, 2], 1);
    expect(guest.gust).toBeNull();
  });

  it('swell the wind noise, louder and brighter', () => {
    const calm = windSound(3, 0, 0.5, 0);
    const blowing = windSound(3, 0, 0.5, 2.2);
    expect(blowing.gain).toBeGreaterThan(calm.gain * 1.8);
    expect(blowing.cutoff).toBeGreaterThan(calm.cutoff + 500);
    expect(windSound(3, 0, 0.5, 10).gain).toBeLessThan(1);
  });
});

describe('drafts', () => {
  const up = { x: 0, z: 0, radius: 10, speed: 1, bottom: 50, top: 150 };
  it('are full strength inside, fade over the edge, and nothing beyond', () => {
    expect(draftAt([up], 0, 100, 0)).toBe(1);
    expect(draftAt([up], 9.9, 100, 0)).toBe(1);
    const edge = draftAt([up], 10 + DRAFT_EDGE / 2, 100, 0);
    expect(edge).toBeGreaterThan(0.3);
    expect(edge).toBeLessThan(0.7);
    expect(draftAt([up], 10 + DRAFT_EDGE, 100, 0)).toBe(0);
    expect(draftAt([up], 0, 150 + DRAFT_EDGE, 0)).toBe(0);
    expect(draftAt([up], 0, 50 - DRAFT_EDGE, 0)).toBe(0);
    expect(draftAt([up, { ...up, x: 100, speed: -0.9 }], 100, 100, 0)).toBe(-0.9);
  });

  it("lie across Calm skies' straight line, clear of the islands", () => {
    const ups = CALM_SKIES.drafts.filter((d) => d.speed > 0);
    const downs = CALM_SKIES.drafts.filter((d) => d.speed < 0);
    expect(ups.length).toBeGreaterThan(0);
    expect(downs.length).toBeGreaterThan(0);
    const points = [CALM_SKIES.start, ...CALM_SKIES.rings, CALM_SKIES.finish];
    for (const d of CALM_SKIES.drafts) {
      // The straight line between two of the route's points passes through its full-strength core.
      let nearest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const ex = b.x - a.x;
        const ez = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((d.x - a.x) * ex + (d.z - a.z) * ez) / (ex * ex + ez * ez)));
        nearest = Math.min(nearest, Math.hypot(d.x - a.x - ex * t, d.z - a.z - ez * t));
        // And the line is at a height inside the column.
        const y = a.y + (b.y - a.y) * t;
        if (Math.hypot(d.x - a.x - ex * t, d.z - a.z - ez * t) < d.radius) {
          expect(y).toBeGreaterThan(d.bottom);
          expect(y).toBeLessThan(d.top);
        }
      }
      expect(nearest).toBeLessThan(d.radius * 0.6);
      // Nowhere near the islands, the jetty or a ring (a draft in a ring would be unfair).
      for (const island of [CALM_SKIES.start, CALM_SKIES.finish, CALM_SKIES.cargo]) {
        expect(Math.hypot(d.x - island.x, d.z - island.z)).toBeGreaterThan(d.radius + DRAFT_EDGE + island.radius + 20);
      }
      for (const ring of CALM_SKIES.rings) {
        expect(Math.hypot(d.x - ring.x, d.z - ring.z)).toBeGreaterThan(d.radius + DRAFT_EDGE + ring.radius);
      }
    }
  });
});

describe('the flight model in the wind', () => {
  it('drifts sideways in a crosswind gust, taking up its push gradually, and leans with it', () => {
    const sim = new FlightSim(CALM);
    const ship = createShipState(100);
    sim.reset(ship, 0, 100, 0, 0);
    const c = createFlightControls();
    c.burner = HOLD;
    const wind = new WindSim();
    wind.reset(3);
    // Heading -Z; a 2 m/s gust blowing to starboard (+X).
    wind.gust = gust({ start: 1, heading: -Math.PI / 2, peak: 2 });
    const v = { x: 0, z: 0 };
    let worstAccel = 0;
    let lastVx = 0;
    let leanWhileRising = 0;
    for (let t = 0; t < 30; t += DT) {
      wind.gustVelocity(ship.time, v);
      c.gustX = v.x;
      c.gustZ = v.z;
      sim.step(ship, c, DT);
      worstAccel = Math.max(worstAccel, Math.abs(ship.vx - lastVx) / DT);
      lastVx = ship.vx;
      if (ship.time > 3 && ship.time < 6) leanWhileRising = Math.max(leanWhileRising, ship.roll);
    }
    // About 20 m to starboard, hardly any along the bow.
    expect(ship.x).toBeGreaterThan(15);
    expect(Math.abs(ship.z)).toBeLessThan(0.5);
    // No faster than the envelope's inertia allows.
    expect(worstAccel).toBeLessThanOrEqual(DEFAULT_FLIGHT.gustFollow + 1e-6);
    // Pushed to starboard, the gondola leans like a basket swung that way (starboard down, a degree or two).
    expect(leanWhileRising).toBeGreaterThan(0.5 * DEG);
    expect(leanWhileRising).toBeLessThan(2 * DEG);
    // Pushed along, the felt gravity stays under the feet.
    expect(Math.abs(ship.gx)).toBeLessThan(0.05);
  });

  it('can be held on course into the gust with the crank and rudder', () => {
    const fly = (correct: boolean) => {
      const sim = new FlightSim(CALM);
      const ship = createShipState(100);
      sim.reset(ship, 0, 100, 0, 0);
      const c = createFlightControls();
      c.burner = HOLD;
      // Both players cranking in step.
      c.crankSpeed = 6.4;
      const wind = new WindSim();
      wind.gust = gust({ start: 1, heading: -Math.PI / 2, peak: 2, hold: 8 });
      const v = { x: 0, z: 0 };
      for (let t = 0; t < 30; t += DT) {
        wind.gustVelocity(ship.time, v);
        c.gustX = v.x;
        c.gustZ = v.z;
        if (correct) {
          // Steer to hold the track along -Z: turn into the gust (to port) while drifting to starboard.
          const offTrack = ship.x + ship.vx * 4;
          c.rudder = Math.max(-1, Math.min(1, -offTrack * 0.3));
        }
        sim.step(ship, c, DT);
      }
      return Math.abs(ship.x);
    };
    expect(fly(false)).toBeGreaterThan(15);
    expect(fly(true)).toBeLessThan(5);
  });

  it('rises in an updraft and sinks in a downdraft, taking it up gradually', () => {
    for (const speed of [1, -0.9]) {
      const sim = new FlightSim(CALM);
      const ship = createShipState(100);
      sim.reset(ship, 0, 100, 0, 0);
      const c = createFlightControls();
      c.burner = HOLD;
      c.draft = speed;
      let lastVy = 0;
      let worst = 0;
      for (let t = 0; t < 20; t += DT) {
        sim.step(ship, c, DT);
        worst = Math.max(worst, Math.abs(ship.vy - lastVy) / DT);
        lastVy = ship.vy;
      }
      expect(ship.vy).toBeCloseTo(speed, 2);
      expect(Math.sign(ship.y - 100)).toBe(Math.sign(speed));
      expect(Math.abs(ship.y - 100)).toBeGreaterThan(12);
      expect(worst).toBeLessThanOrEqual(DEFAULT_FLIGHT.draftFollow + 1e-6);
      // The envelope's heat (and so what the burner must do) is unchanged: the air carries it.
      expect(sim.climb).toBeCloseTo(0, 2);
    }
  });

  it("doesn't blow a ship resting on an island about", () => {
    const sim = new FlightSim(DEFAULT_FLIGHT);
    const ship = createShipState(100);
    sim.reset(ship, 0, 100, 0, 0);
    const c = createFlightControls();
    // Short of floating heat, so it stays down.
    sim.heat -= 2;
    c.gustX = 3;
    for (let t = 0; t < 10; t += DT) sim.step(ship, c, DT, 100);
    expect(ship.x).toBe(0);
    expect(ship.z).toBe(0);
  });

  it('keeps within the comfort limits in gusts and drafts however hard it is driven', () => {
    const sim = new FlightSim(DEFAULT_FLIGHT);
    const ship = createShipState(100);
    sim.reset(ship, 0, 100, 0, 0);
    const c = createFlightControls();
    const lim = DEFAULT_FLIGHT_LIMITS;
    let worst = { climb: 0, tilt: 0, accel: 0 };
    let last = { vx: 0, vz: 0, speed: 0, yaw: 0 };
    let t = 0;
    for (let i = 0; i < 240 / DT; i++) {
      t += DT;
      const phase = Math.floor(t / 7) % 4;
      c.burner = phase === 0 ? 1 : 0;
      c.vent = phase === 2 ? 1 : 0;
      c.rudder = phase % 2 === 0 ? 1 : -1;
      c.crankSpeed = phase < 2 ? 12 : 0;
      // Gusts at double strength, slammed from side to side, and drafts in and out.
      c.gustX = phase % 2 === 0 ? 4.4 : -4.4;
      c.gustZ = phase === 1 ? 4.4 : 0;
      c.draft = phase < 2 ? 2 : -2;
      sim.step(ship, c, DT);
      // The ground velocity's change, less what the airspeed and turning account for, is the gust's.
      const fx = -Math.sin(ship.yaw);
      const fz = -Math.cos(ship.yaw);
      const ax = (ship.vx - last.vx) / DT - ((ship.speed * fx - last.speed * -Math.sin(last.yaw)) / DT);
      const az = (ship.vz - last.vz) / DT - ((ship.speed * fz - last.speed * -Math.cos(last.yaw)) / DT);
      worst = {
        climb: Math.max(worst.climb, Math.abs(ship.vy)),
        tilt: Math.max(worst.tilt, Math.abs(ship.roll), Math.abs(ship.pitch)),
        accel: i > 0 ? Math.max(worst.accel, Math.hypot(ax, az)) : 0,
      };
      last = { vx: ship.vx, vz: ship.vz, speed: ship.speed, yaw: ship.yaw };
    }
    expect(worst.climb).toBeLessThanOrEqual(lim.maxClimb + 1e-9);
    expect(worst.tilt).toBeLessThanOrEqual(lim.maxTiltDeg * DEG + 1e-9);
    expect(worst.accel).toBeLessThanOrEqual(DEFAULT_FLIGHT.gustFollow + 0.05);
  });
});
