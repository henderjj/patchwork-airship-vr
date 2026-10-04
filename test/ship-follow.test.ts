import { describe, expect, it } from 'vitest';
import { createShipStatePacket, SHIP_FLAG_PAUSED } from '../src/net/pose-codec.js';
import { ShipFollower } from '../src/net/ship-follow.js';
import { createFlightControls, FlightSim } from '../src/sim/flight.js';
import { createShipState, type ShipState } from '../src/sim/ship-motion.js';

const FRAME_MS = 1000 / 90;

function snapshot(ship: ShipState, sim: FlightSim, timeMs: number, flags = 0) {
  return {
    ...createShipStatePacket(), timeMs, flags, shipTime: ship.time, x: ship.x, y: ship.y, z: ship.z, yaw: ship.yaw, pitch: ship.pitch, roll: ship.roll,
    vx: ship.vx, vy: ship.vy, vz: ship.vz, ax: ship.ax, ay: ship.ay, az: ship.az, yawRate: sim.yawRate, heat: sim.heat, airspeed: sim.airspeed,
  };
}

/**
 * Fly the host for `seconds` with full crank and a turn, sending 20 states a
 * second that arrive `delayMs` (± jitter) later, and follow them on the guest.
 */
function run(seconds: number, delayMs: number, jitterMs: number, lossEvery = 0) {
  const sim = new FlightSim();
  const host = createShipState(100);
  sim.reset(host, 500, 100, -300, 0.5);
  const c = createFlightControls();
  c.crankSpeed = 9.6;
  c.burner = 0.5;
  const guest = createShipState(0);
  const follower = new ShipFollower();
  const inFlight: { at: number; packet: ReturnType<typeof snapshot> }[] = [];
  let worstError = 0;
  let worstStepError = 0;
  let sent = 0;
  let rand = 1;
  const random = () => ((rand = (rand * 16807) % 2147483647) / 2147483647);
  let lastGuest = { x: 0, z: 0 };
  for (let frame = 0; frame < (seconds * 1000) / FRAME_MS; frame++) {
    const now = frame * FRAME_MS;
    c.rudder = Math.sin(now / 9000);
    sim.step(host, c, FRAME_MS / 1000);
    if (frame % 4 === 0 && !(lossEvery && ++sent % lossEvery === 0)) {
      // Host time equals guest time here (clock sync is tested elsewhere).
      inFlight.push({ at: now + delayMs + random() * jitterMs, packet: snapshot(host, sim, now) });
    }
    for (let i = inFlight.length - 1; i >= 0; i--) {
      if (inFlight[i].at <= now) {
        follower.accept(inFlight[i].packet, inFlight[i].packet.timeMs);
        inFlight.splice(i, 1);
      }
    }
    if (follower.update(guest, now, FRAME_MS / 1000) && frame > 90) {
      worstError = Math.max(worstError, Math.hypot(guest.x - host.x, guest.y - host.y, guest.z - host.z));
      // Each frame the guest's world should move by about the ship's own speed, with no jolts.
      const step = Math.hypot(guest.x - lastGuest.x, guest.z - lastGuest.z);
      const expected = Math.hypot(host.vx, host.vz) * (FRAME_MS / 1000);
      worstStepError = Math.max(worstStepError, Math.abs(step - expected));
    }
    lastGuest = { x: guest.x, z: guest.z };
  }
  return { worstError, worstStepError, snaps: follower.snaps };
}

describe('guest follows the host ship', () => {
  it('stays within a few centimetres of the host at 50 ms with jitter', () => {
    const r = run(60, 25, 20);
    expect(r.worstError).toBeLessThan(0.1);
    expect(r.worstStepError).toBeLessThan(0.005);
    expect(r.snaps).toBe(0);
  });

  it('stays close and smooth at 150 ms with jitter and lost packets', () => {
    const r = run(60, 75, 40, 7);
    expect(r.worstError).toBeLessThan(0.3);
    expect(r.worstStepError).toBeLessThan(0.01);
    expect(r.snaps).toBe(0);
  });

  it('places the ship at once on the first state, and snaps after a big jump', () => {
    const follower = new ShipFollower();
    const guest = createShipState(0);
    const p = { ...createShipStatePacket(), timeMs: 1000, x: 100, y: 120, z: -50, yaw: 1 };
    follower.accept(p, 1000);
    follower.update(guest, 1000, FRAME_MS / 1000);
    expect([guest.x, guest.y, guest.z, guest.yaw]).toEqual([100, 120, -50, 1]);
    follower.accept({ ...p, timeMs: 1100, x: 400 }, 1100);
    follower.update(guest, 1100, FRAME_MS / 1000);
    expect(guest.x).toBe(400);
    expect(follower.snaps).toBe(1);
  });

  it('ignores states older than the newest', () => {
    const follower = new ShipFollower();
    expect(follower.accept({ ...createShipStatePacket(), x: 5 }, 2000)).toBe(true);
    expect(follower.accept({ ...createShipStatePacket(), x: 9 }, 1900)).toBe(false);
    expect(follower.latest.x).toBe(5);
  });

  it('holds still while the host is paused', () => {
    const follower = new ShipFollower();
    const guest = createShipState(0);
    follower.accept({ ...createShipStatePacket(), flags: SHIP_FLAG_PAUSED, x: 10, vx: 5, shipTime: 30 }, 0);
    for (let i = 0; i < 90; i++) {
      follower.update(guest, i * FRAME_MS, FRAME_MS / 1000);
    }
    expect(guest.x).toBe(10);
    expect(guest.vx).toBe(0);
    expect(guest.time).toBe(30);
  });
});
