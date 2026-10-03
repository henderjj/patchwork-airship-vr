import {
  createSystem,
  eq,
  Grabbed,
  PhysicsBody,
  PhysicsManipulation,
  PhysicsState,
  PhysicsSystem,
} from '@iwsdk/core';
import {
  createShipState,
  MOTION_PROFILES,
  type ShipState,
  stepShip,
  updateFeltGravity,
  updateQuaternion,
} from '../sim/ship-motion.js';
import { settings } from '../settings.js';

/** The ship's current world pose, read by the sky and trim systems. */
export const ship: ShipState = createShipState();

/** How far felt gravity must move (m/s²) before the physics worker is told. */
const GRAVITY_EPSILON = 0.01;
/** How far felt gravity must move (m/s²) before resting bodies are woken. */
const WAKE_EPSILON = 0.05;
/** A negligible impulse (N·s) that wakes a sleeping Havok body. */
const WAKE_IMPULSE = 1e-5;

/**
 * Advances the ship along its motion profile and keeps the physics world's
 * gravity equal to the felt gravity in ship space, so loose objects slide when
 * the ship tilts or turns while the gondola itself stays fixed in the player's
 * tracking space.
 */
export class ShipSystem extends createSystem({
  loose: {
    required: [PhysicsBody],
    excluded: [Grabbed, PhysicsManipulation],
    where: [eq(PhysicsBody, 'state', PhysicsState.Dynamic)],
  },
}) {
  private profile = MOTION_PROFILES[settings.motion] ?? MOTION_PROFILES.still;
  private physics: PhysicsSystem | undefined;
  private sentGravity: [number, number, number] = [0, -9.81, 0];
  private wokenGravity: [number, number, number] = [0, -9.81, 0];
  private paused = false;
  private fixedTilt: [number, number] | null = null;

  init(): void {
    this.physics = this.world.getSystem(PhysicsSystem);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'p' || event.key === 'P') {
        this.paused = !this.paused;
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanupFuncs.push(() => window.removeEventListener('keydown', onKey));
    (window as { __ship?: unknown }).__ship = {
      state: ship,
      setProfile: (name: string) => {
        this.profile = MOTION_PROFILES[name] ?? this.profile;
        return this.profile.name;
      },
      pause: (value: boolean) => {
        this.paused = value;
      },
      /** Test hook: hold the ship still at a fixed tilt (degrees). */
      setFixedTilt: (rollDeg: number, pitchDeg: number) => {
        this.profile = MOTION_PROFILES.still;
        this.fixedTilt = [rollDeg, pitchDeg];
      },
      clearFixedTilt: () => {
        this.fixedTilt = null;
      },
    };
  }

  update(delta: number): void {
    if (this.paused) {
      return;
    }
    // Clamp long frames (tab switches) so the flight doesn't jump.
    stepShip(ship, this.profile, Math.min(delta, 0.1));
    if (this.fixedTilt) {
      ship.roll = (this.fixedTilt[0] * Math.PI) / 180;
      ship.pitch = (this.fixedTilt[1] * Math.PI) / 180;
      updateQuaternion(ship);
      updateFeltGravity(ship);
    }
    if (!this.physics) {
      return;
    }
    const g = this.sentGravity;
    if (
      Math.abs(g[0] - ship.gx) > GRAVITY_EPSILON ||
      Math.abs(g[1] - ship.gy) > GRAVITY_EPSILON ||
      Math.abs(g[2] - ship.gz) > GRAVITY_EPSILON
    ) {
      g[0] = ship.gx;
      g[1] = ship.gy;
      g[2] = ship.gz;
      // A new array is needed for the signal to notice the change; this
      // happens only while the felt gravity is actually changing.
      this.physics.config.gravity.value = [g[0], g[1], g[2]];
    }
    // Havok puts resting bodies to sleep, and a gravity change alone doesn't
    // wake them, so nudge them once the felt gravity has moved noticeably.
    const w = this.wokenGravity;
    if (Math.abs(w[0] - ship.gx) + Math.abs(w[1] - ship.gy) + Math.abs(w[2] - ship.gz) > WAKE_EPSILON) {
      w[0] = ship.gx;
      w[1] = ship.gy;
      w[2] = ship.gz;
      for (const entity of this.queries.loose.entities) {
        entity.addComponent(PhysicsManipulation, { force: [0, WAKE_IMPULSE, 0] });
      }
    }
  }
}
