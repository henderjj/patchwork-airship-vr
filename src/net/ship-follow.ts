/**
 * The guest's copy of the host's ship (Phase 2). The host flies the ship and
 * sends its state about 20 times a second; the guest moves its own ship on
 * at the host's velocity every frame and steers it gently onto where the
 * newest state says the ship is now (that state moved on by its age), so the
 * world neither stutters at the packet rate nor jumps when a packet is late.
 * A large disagreement (a reconnect, a restart) snaps instead.
 *
 * Engine-free and allocation free.
 */

import { type ShipStatePacket, createShipStatePacket, SHIP_FLAG_PAUSED } from './pose-codec.js';
import { type ShipState, updateFeltGravity, updateQuaternion } from '../sim/ship-motion.js';

/** Fraction of the position and heading error removed per second. */
const CORRECT_RATE = 3;
/** Fraction of the tilt error removed per second. */
const TILT_RATE = 8;
/** Further than this from the host's ship (m), or turned this far from it (rad), and the guest snaps. */
const SNAP_DISTANCE = 25;
const SNAP_ANGLE = 0.5;
/** Never move a state on by more than this, s (a stalled connection holds the ship rather than flying blind). */
const MAX_EXTRAPOLATE = 0.5;

export class ShipFollower {
  readonly latest: ShipStatePacket = createShipStatePacket();
  /** Local time the newest state describes, ms. */
  latestAtMs = Number.NaN;
  have = false;
  /** Distance from the host's ship before this frame's correction, m (for tests and the HUD). */
  error = 0;
  snaps = 0;
  private placed = false;

  /** The host has stopped the ship. */
  get paused(): boolean {
    return this.have && (this.latest.flags & SHIP_FLAG_PAUSED) !== 0;
  }

  /** Take a state from the host, taken at local time `atMs`; older states than the newest are ignored. */
  accept(packet: ShipStatePacket, atMs: number): boolean {
    if (this.have && !(atMs > this.latestAtMs)) {
      return false;
    }
    Object.assign(this.latest, packet);
    this.latestAtMs = atMs;
    this.have = true;
    return true;
  }

  /** Forget the host's ship (a new connection), so the next state places the ship at once. */
  reset(): void {
    this.have = false;
    this.placed = false;
    this.latestAtMs = Number.NaN;
  }

  /** Move `ship` on by dt seconds towards the host's. Returns false until a state has arrived. */
  update(ship: ShipState, nowMs: number, dt: number): boolean {
    if (!this.have) {
      return false;
    }
    const p = this.latest;
    const paused = (p.flags & SHIP_FLAG_PAUSED) !== 0;
    const age = paused ? 0 : Math.min(MAX_EXTRAPOLATE, Math.max(0, (nowMs - this.latestAtMs) / 1000));
    const tx = p.x + p.vx * age;
    const ty = p.y + p.vy * age;
    const tz = p.z + p.vz * age;
    const tyaw = p.yaw + p.yawRate * age;

    const yawError = wrap(tyaw - ship.yaw);
    this.error = Math.hypot(tx - ship.x, ty - ship.y, tz - ship.z);
    if (!this.placed || this.error > SNAP_DISTANCE || Math.abs(yawError) > SNAP_ANGLE) {
      if (this.placed) {
        this.snaps++;
      }
      this.placed = true;
      ship.x = tx;
      ship.y = ty;
      ship.z = tz;
      ship.yaw = tyaw;
      ship.pitch = p.pitch;
      ship.roll = p.roll;
    } else {
      if (!paused && dt > 0) {
        ship.x += p.vx * dt;
        ship.y += p.vy * dt;
        ship.z += p.vz * dt;
        ship.yaw += p.yawRate * dt;
      }
      const k = Math.min(1, CORRECT_RATE * dt);
      ship.x += (tx - ship.x) * k;
      ship.y += (ty - ship.y) * k;
      ship.z += (tz - ship.z) * k;
      ship.yaw += wrap(tyaw - ship.yaw) * k;
      const kt = Math.min(1, TILT_RATE * dt);
      ship.pitch += (p.pitch - ship.pitch) * kt;
      ship.roll += (p.roll - ship.roll) * kt;
    }
    ship.vx = paused ? 0 : p.vx;
    ship.vy = paused ? 0 : p.vy;
    ship.vz = paused ? 0 : p.vz;
    ship.ax = paused ? 0 : p.ax;
    ship.ay = paused ? 0 : p.ay;
    ship.az = paused ? 0 : p.az;
    ship.speed = p.airspeed;
    ship.time = p.shipTime + age;
    updateQuaternion(ship);
    updateFeltGravity(ship);
    return true;
  }
}

function wrap(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}
