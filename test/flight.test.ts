import { describe, expect, it } from 'vitest';
import { createFlightControls, DEFAULT_FLIGHT, DEFAULT_FLIGHT_LIMITS, FlightSim } from '../src/sim/flight.js';
import { createShipState, GRAVITY } from '../src/sim/ship-motion.js';

const DEG = Math.PI / 180;
const DT = 1 / 90;
const CALM = { ...DEFAULT_FLIGHT, windSpeed: 0, windVariation: 0 };

function fly(sim: FlightSim, ship = createShipState(), seconds: number, controls = createFlightControls(), each?: () => void) {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    sim.step(ship, controls, DT);
    each?.();
  }
  return ship;
}

describe('flight model', () => {
  it('floats level and still with no one at the controls', () => {
    const sim = new FlightSim(CALM);
    const ship = createShipState(100);
    sim.reset(ship, 0, 100, 0, 0);
    fly(sim, ship, 30);
    // The envelope cools slowly on its own, so an untended ship sinks gently.
    expect(ship.y).toBeLessThan(100);
    expect(ship.y).toBeGreaterThan(80);
    expect(ship.y).toBeLessThan(99.5);
    expect(Math.hypot(ship.x, ship.z)).toBeLessThan(1e-6);
  });

  it('builds lift slowly from the burner and climbs at a steady rate', () => {
    const sim = new FlightSim(CALM);
    const ship = createShipState(100);
    sim.reset(ship, 0, 100, 0, 0);
    const c = createFlightControls();
    c.burner = 1;
    fly(sim, ship, 5, c);
    // Lift is slow: after 5 s the ship has barely started to rise.
    expect(sim.climb).toBeGreaterThan(0);
    expect(sim.climb).toBeLessThan(0.3);
    fly(sim, ship, 115, c);
    expect(sim.climb).toBeGreaterThan(0.8);
    expect(sim.climb).toBeLessThanOrEqual(DEFAULT_FLIGHT_LIMITS.maxClimb);
    // Once the burner is off the lift fades over tens of seconds, not at once.
    c.burner = 0;
    fly(sim, ship, 3, c);
    expect(sim.climb).toBeGreaterThan(0.5);
  });

  it('drops quickly through the vent', () => {
    const sim = new FlightSim(CALM);
    const ship = createShipState(100);
    sim.reset(ship, 0, 100, 0, 0);
    const c = createFlightControls();
    c.vent = 1;
    fly(sim, ship, 20, c);
    expect(sim.climb).toBeLessThan(-1);
    expect(sim.climb).toBeGreaterThanOrEqual(-DEFAULT_FLIGHT_LIMITS.maxClimb);
  });

  it('gets instant extra lift from dropped ballast', () => {
    const sim = new FlightSim(CALM);
    expect(sim.liftRate(0)).toBeCloseTo(0, 6);
    expect(sim.liftRate(40)).toBeGreaterThan(0.3);
  });

  it('flies at about 2.4 m/s for one cranker and the speed limit for two in step', () => {
    const one = new FlightSim(CALM);
    const c = createFlightControls();
    c.crankSpeed = 3.2;
    fly(one, undefined, 60, c);
    expect(one.airspeed).toBeGreaterThan(2.2);
    expect(one.airspeed).toBeLessThan(2.5);
    const two = new FlightSim(CALM);
    c.crankSpeed = 9.6;
    fly(two, undefined, 60, c);
    expect(two.airspeed).toBeCloseTo(DEFAULT_FLIGHT_LIMITS.maxSpeed, 1);
  });

  it('flies towards the bow and turns the way the rudder points', () => {
    const sim = new FlightSim(CALM);
    const ship = createShipState(100);
    sim.reset(ship, 0, 100, 0, 0);
    const c = createFlightControls();
    c.crankSpeed = 6;
    fly(sim, ship, 20, c);
    expect(ship.z).toBeLessThan(-20);
    expect(Math.abs(ship.x)).toBeLessThan(1e-6);
    // Rudder to starboard turns right: the heading swings clockwise from above (yaw falls).
    c.rudder = 1;
    const yaw0 = ship.yaw;
    fly(sim, ship, 10, c);
    expect(ship.yaw).toBeLessThan(yaw0 - 20 * DEG);
  });

  it('keeps the motion within the comfort limits however hard it is driven', () => {
    const sim = new FlightSim(DEFAULT_FLIGHT);
    const ship = createShipState(100);
    sim.reset(ship, 0, 100, 0, 0);
    const c = createFlightControls();
    const lim = DEFAULT_FLIGHT_LIMITS;
    let worst = { yawRate: 0, climb: 0, tilt: 0, accel: 0 };
    let t = 0;
    fly(sim, ship, 240, c, () => {
      t += DT;
      // Slam every control back and forth.
      const phase = Math.floor(t / 7) % 4;
      c.burner = phase === 0 ? 1 : 0;
      c.vent = phase === 2 ? 1 : 0;
      c.rudder = phase % 2 === 0 ? 1 : -1;
      c.crankSpeed = phase < 2 ? 12 : 0;
      c.trimPitch = phase === 1 ? 0.2 : -0.2;
      worst = {
        yawRate: Math.max(worst.yawRate, Math.abs(sim.yawRate)),
        climb: Math.max(worst.climb, Math.abs(sim.climb)),
        tilt: Math.max(worst.tilt, Math.abs(ship.roll), Math.abs(ship.pitch)),
        accel: Math.max(worst.accel, Math.abs(ship.speedAccel)),
      };
    });
    expect(worst.yawRate).toBeLessThanOrEqual(lim.maxYawRateDeg * DEG + 1e-9);
    expect(worst.climb).toBeLessThanOrEqual(lim.maxClimb + 1e-9);
    expect(worst.tilt).toBeLessThanOrEqual(lim.maxTiltDeg * DEG + 1e-9);
    expect(worst.accel).toBeLessThanOrEqual(lim.maxAccel + 1e-9);
  });

  it('banks into turns so the felt gravity stays under the feet', () => {
    const sim = new FlightSim(CALM);
    const ship = createShipState(100);
    sim.reset(ship, 0, 100, 0, 0);
    const c = createFlightControls();
    c.crankSpeed = 9.6;
    c.rudder = -1;
    fly(sim, ship, 60, c);
    // In a steady turn the sideways pull a level deck would give is
    // v·ω; banking leaves only what the tilt limit can't cover.
    const unbanked = sim.airspeed * Math.abs(sim.yawRate);
    expect(unbanked).toBeGreaterThan(0.3);
    expect(Math.abs(ship.gx)).toBeLessThan(unbanked - GRAVITY * Math.sin(Math.abs(ship.roll)) + 0.02);
    expect(Math.abs(ship.gx)).toBeLessThan(unbanked * 0.5);
  });

  it('drifts with the wind when nobody cranks', () => {
    const sim = new FlightSim(DEFAULT_FLIGHT);
    const ship = createShipState(100);
    sim.reset(ship, 0, 100, 0, 0);
    fly(sim, ship, 60);
    const drift = Math.hypot(ship.x, ship.z) / 60;
    expect(drift).toBeGreaterThan(0.2);
    expect(drift).toBeLessThan(1);
  });

  it('flies downhill when trimmed nose-down, and only once it is moving', () => {
    const sim = new FlightSim(CALM);
    const ship = createShipState(100);
    sim.reset(ship, 0, 100, 0, 0);
    const c = createFlightControls();
    c.trimPitch = -0.03;
    // The burner at exactly the setting that holds the balancing heat.
    c.burner = (DEFAULT_FLIGHT.cooling * DEFAULT_FLIGHT.balanceHeat) / DEFAULT_FLIGHT.burnerHeating;
    fly(sim, ship, 10, c);
    expect(Math.abs(ship.vy)).toBeLessThan(0.01);
    c.crankSpeed = 9.6;
    fly(sim, ship, 40, c);
    expect(ship.vy).toBeLessThan(-0.15);
  });
});
