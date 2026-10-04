import {
  createSystem,
  eq,
  Grabbed,
  InputComponent,
  PhysicsBody,
  PhysicsManipulation,
  PhysicsState,
  PhysicsSystem,
} from '@iwsdk/core';
import {
  createShipState,
  MOTION_PROFILES,
  type MotionProfile,
  type ShipState,
  stepShip,
  updateFeltGravity,
  updateQuaternion,
} from '../sim/ship-motion.js';
import { createFlightControls, FlightSim } from '../sim/flight.js';
import { ballastDropped } from '../sim/gondola-controls.js';
import { groundBelow, islandHit, restingDeck } from '../sim/islands.js';
import { type RoutePhase, type RouteResult, RouteRun } from '../sim/route.js';
import { wrapNear } from '../sim/world-tile.js';
import { ROUTE, ROUTE_ISLANDS, sceneryIslands } from '../world/route-world.js';
import { settings } from '../settings.js';
import { crewPresence } from '../net/crew-presence.js';
import {
  createShipStatePacket,
  encodeShip,
  decodeShip,
  PacketType,
  SHIP_FLAG_BURNER,
  SHIP_FLAG_PAUSED,
  SHIP_FLAG_VENT,
  SHIP_PACKET_BYTES,
} from '../net/pose-codec.js';
import { ShipFollower } from '../net/ship-follow.js';
import { crankInfo } from './crank-system.js';
import { netLink } from './net-system.js';

/** The ship's current world pose, read by the sky and trim systems. */
export const ship: ShipState = createShipState();

/** The motion profile in use and whether the ship is held still, for the comfort log. */
export const shipInfo = { motion: 'still', paused: false };

/** Phase 2: the crew-controlled flight model (`?motion=flight`) and what the crew is doing to it. */
export const flight = new FlightSim();
export const flightControls = createFlightControls();
/** Seconds of full flame one fuel brick gives, and the most the burner holds at once. */
export const BRICK_BURN_SECONDS = 20;
const MAX_BURN_SECONDS = 60;
/** Where the flight starts: resting on the route's island A, facing world -Z. */
const FLIGHT_START = [ROUTE.start.x, restingDeck(ROUTE.start), ROUTE.start.z] as const;
/** Waiting on island A, the ground crew keeps the envelope this close below floating heat, °C. */
const READY_HEAT_BELOW = 2;
/** While a guest is connected, the host repeats the route's state this often, ms (so a late joiner catches up). */
const ROUTE_RESEND_MS = 1000;
/** How fast the keyboard swings the rudder, full travel per second. */
const RUDDER_KEY_RATE = 0.8;
/** Ship states the host sends the guest per second. */
const SHIP_SEND_HZ = 20;

/** Flight readings for instruments, tests and the guest (who gets them from the host). */
export const flightInfo = {
  flying: false,
  /** Seconds of burn left in the burner. */
  burnLeft: 0,
  heat: 0,
  climb: 0,
  airspeed: 0,
  /** The steady climb the current heat is heading for, m/s. */
  liftRate: 0,
  burner: false,
  vent: false,
  /** Rudder and vent opening as flown (the host's, on the guest). */
  rudder: 0,
  ventOpen: 0,
  /** Which ballast bags have been dropped, one bit each. */
  ballastMask: 0,
  /** Fuel bricks burned since the flight started. */
  bricksBurned: 0,
};

/** Phase 2's route: the host's run, or on the guest, the host's run as last heard. */
export const route = new RouteRun(ROUTE);

/** The ship system's own restart, set when it starts. */
const routeControl = { restart: () => undefined as void };

/** Start the route again from island A (the guest asks the host). */
export function restartRoute(): void {
  if (netLink.connected && !netLink.isHost) {
    netLink.sendEvent({ t: 'route-restart' });
  } else {
    routeControl.restart();
  }
}

/** The gondola's controls as the crew works them (written by the controls system on the host or solo). */
export const stations = { vent: 0 };

function addFuel(): void {
  flightInfo.burnLeft = Math.min(MAX_BURN_SECONDS, flightInfo.burnLeft + BRICK_BURN_SECONDS);
  flightInfo.bricksBurned++;
}

function setBallast(mask: number): void {
  flightInfo.ballastMask = mask;
  flightControls.ballastDropped = ballastDropped(mask);
}

/** A fuel brick went into the hopper: burn it (the guest tells the host, who flies the ship). */
export function feedBurner(): void {
  if (netLink.connected && !netLink.isHost) {
    netLink.sendEvent({ t: 'feed' });
  } else {
    addFuel();
  }
}

/** Ballast bag `index` went overboard. */
export function dropBallast(index: number): void {
  if (netLink.connected && !netLink.isHost) {
    netLink.sendEvent({ t: 'ballast', index } as { t: string });
  } else {
    setBallast(flightInfo.ballastMask | (1 << index));
  }
}

/**
 * The profile named by `?motion=`, with any of its limits replaced from the
 * URL (`?speed=`, `?turn=`, `?climb=`, `?tilt=`, `?gust=`), so comfort tests
 * can try values between the named profiles. A changed profile is named
 * after its base with a `*`.
 */
export function motionProfileFromSettings(): MotionProfile {
  const base = MOTION_PROFILES[settings.motion] ?? MOTION_PROFILES.still;
  const pick = (value: number, fallback: number) => (Number.isNaN(value) ? fallback : value);
  const profile: MotionProfile = {
    name: base.name,
    speed: pick(settings.motionSpeed, base.speed),
    maxYawRateDeg: pick(settings.motionTurn, base.maxYawRateDeg),
    maxClimb: pick(settings.motionClimb, base.maxClimb),
    maxTiltDeg: pick(settings.motionTilt, base.maxTiltDeg),
    gust: pick(settings.motionGust, base.gust),
  };
  const changed =
    profile.speed !== base.speed || profile.maxYawRateDeg !== base.maxYawRateDeg || profile.maxClimb !== base.maxClimb ||
    profile.maxTiltDeg !== base.maxTiltDeg || profile.gust !== base.gust;
  if (changed) {
    profile.name = `${base.name}*`;
  }
  return profile;
}

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
  private profile = motionProfileFromSettings();
  private physics: PhysicsSystem | undefined;
  private sentGravity: [number, number, number] = [0, -9.81, 0];
  private wokenGravity: [number, number, number] = [0, -9.81, 0];
  private paused = false;
  private fixedTilt: [number, number] | null = null;
  private flying = settings.motion === 'flight';
  private keys = { vent: false, port: false, starboard: false };
  private follower = new ShipFollower();
  private following = false;
  private incoming = createShipStatePacket();
  private outgoing = createShipStatePacket();
  private sendBuffer = new ArrayBuffer(SHIP_PACKET_BYTES);
  private sendAccumulator = 0;
  private routeSentAt = Number.NEGATIVE_INFINITY;
  private wasConnected = false;

  init(): void {
    routeControl.restart = () => this.restart();
    this.physics = this.world.getSystem(PhysicsSystem);
    if (this.flying) {
      this.restart();
    }
    // Keyboard: P stops and starts the ship. With `?motion=flight`, B feeds the
    // burner a brick's worth of fuel, V (held) opens the vent, and , and .
    // (held) swing the rudder to port and starboard, until the gondola's own
    // controls exist. (These keys are clear of the emulator's controller keys.)
    const onKey = (event: KeyboardEvent) => {
      // Not while typing a name or room code on the crew panel.
      if ((event.target as Element | null)?.closest?.('input, textarea')) {
        return;
      }
      const down = event.type === 'keydown';
      const key = event.key.toLowerCase();
      if (key === 'p' && down) {
        this.togglePause();
      } else if (key === 'b' && down && !event.repeat) {
        this.feedFuel();
      } else if (key === 'v') {
        this.keys.vent = down;
      } else if (key === ',') {
        this.keys.port = down;
      } else if (key === '.') {
        this.keys.starboard = down;
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    this.cleanupFuncs.push(() => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    });

    // The host's ship state, and the guest's request to stop or start it.
    netLink.handlers.set(PacketType.Ship, (view) => {
      if (decodeShip(view, this.incoming) && netLink.clockSynced) {
        this.follower.accept(this.incoming, netLink.toLocal(this.incoming.timeMs));
      }
    });
    netLink.events.set('ship-pause', (event) => {
      if (netLink.isHost) {
        this.paused = event.paused === true;
      }
    });
    // The guest's brick in the hopper and bag over the side.
    netLink.events.set('feed', () => {
      if (netLink.isHost) {
        addFuel();
      }
    });
    netLink.events.set('ballast', (event) => {
      const index = event.index;
      if (netLink.isHost && typeof index === 'number' && index >= 0 && index < 8) {
        setBallast(flightInfo.ballastMask | (1 << index));
      }
    });
    // The route: the host's run for the guest, and the guest's bell to start again.
    netLink.events.set('route', (event) => {
      if (!netLink.isHost) {
        this.applyRoute(event);
      }
    });
    netLink.events.set('route-restart', () => {
      if (netLink.isHost) {
        this.restart();
      }
    });
    this.cleanupFuncs.push(() => {
      netLink.handlers.delete(PacketType.Ship);
      for (const name of ['ship-pause', 'feed', 'ballast', 'route', 'route-restart']) {
        netLink.events.delete(name);
      }
    });
    (window as { __ship?: unknown }).__ship = {
      state: ship,
      setProfile: (name: string) => {
        this.profile = MOTION_PROFILES[name] ?? this.profile;
        this.flying = false;
        return this.profile.name;
      },
      flight,
      controls: flightControls,
      info: flightInfo,
      follower: this.follower,
      /** Switch to the crew-controlled flight model, resting on island A. */
      fly: () => this.restart(),
      route,
      /** Test hook: move the ship (deck) to a point and heading, keeping its heat and speed. */
      place: (x: number, y: number, z: number, yaw = ship.yaw) => {
        Object.assign(ship, { x, y, z, yaw });
        route.jumped();
        updateQuaternion(ship);
      },
      /** What P and the B button do: stop or start the ship (the guest asks the host). */
      togglePause: () => this.togglePause(),
      feedFuel: () => this.feedFuel(),
      /** Test hook: hold the vent open, and set the rudder (-1 port to 1 starboard). */
      setVent: (open: boolean) => {
        this.keys.vent = open;
      },
      setRudder: (value: number) => {
        flightControls.rudder = Math.max(-1, Math.min(1, value));
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

  /** Host or solo: back to island A with a fresh crate, ballast and route. */
  private restart(): void {
    this.flying = true;
    flight.reset(ship, FLIGHT_START[0], FLIGHT_START[1], FLIGHT_START[2], 0);
    flight.heat -= READY_HEAT_BELOW;
    Object.assign(flightControls, createFlightControls());
    flightInfo.burnLeft = 0;
    flightInfo.bricksBurned = 0;
    setBallast(0);
    route.reset();
    this.sendRoute();
  }

  /** Host: tell the guest how the run stands. */
  private sendRoute(): void {
    this.routeSentAt = performance.now();
    if (!netLink.connected || !netLink.isHost) {
      return;
    }
    netLink.sendEvent({
      t: 'route',
      phase: route.phase,
      rings: route.ringMask,
      start: route.startTime,
      seconds: route.seconds,
      reason: route.lostReason,
      result: route.result,
    } as { t: string });
  }

  /** Guest: take the host's run. */
  private applyRoute(event: Record<string, unknown>): void {
    const phases: RoutePhase[] = ['ready', 'flying', 'finished', 'lost'];
    if (!phases.includes(event.phase as RoutePhase)) {
      return;
    }
    route.phase = event.phase as RoutePhase;
    route.ringMask = Number(event.rings) | 0;
    route.startTime = Number(event.start) || 0;
    route.seconds = Number(event.seconds) || 0;
    route.lostReason = String(event.reason ?? '');
    route.result = (event.result as RouteResult | null) ?? null;
  }

  private togglePause(): void {
    if (netLink.connected && !netLink.isHost) {
      // The guest asks the host, who flies the ship for both.
      netLink.sendEvent({ t: 'ship-pause', paused: !this.follower.paused } as { t: string });
    } else {
      this.paused = !this.paused;
    }
  }

  private feedFuel(): void {
    feedBurner();
  }

  /** Solo or host: move the ship by the flight model or the scripted path, and send it to the guest. */
  private flyOwnShip(dt: number): void {
    shipInfo.motion = this.flying ? 'flight' : this.profile.name;
    // Spike S10: the ship also waits while the crewmate can't play.
    shipInfo.paused = this.paused || crewPresence.paused;
    flightInfo.flying = this.flying;
    if (!shipInfo.paused) {
      if (this.flying) {
        const c = flightControls;
        flightInfo.burnLeft = Math.max(0, flightInfo.burnLeft - dt);
        c.burner = flightInfo.burnLeft > 0 ? 1 : 0;
        c.vent = Math.max(this.keys.vent ? 1 : 0, stations.vent);
        const swing = (this.keys.starboard ? 1 : 0) - (this.keys.port ? 1 : 0);
        c.rudder = Math.max(-1, Math.min(1, c.rudder + swing * RUDDER_KEY_RATE * dt));
        c.crankSpeed = crankInfo.speed;
        if (route.phase === 'ready') {
          flight.heat = Math.max(flight.heat, flight.balanceHeat(c.ballastDropped) - READY_HEAT_BELOW);
        }
        // Run into an island and the ship stops there until the crew starts again.
        if (route.phase !== 'lost') {
          const ground = Math.max(
            groundBelow(ROUTE_ISLANDS, ship.x, ship.z, ship.y),
            groundBelow(sceneryIslands, ship.x, ship.z, ship.y, wrapNear),
          );
          flight.step(ship, c, dt, ground);
        }
        const crashed = islandHit(ROUTE_ISLANDS, ship.x, ship.y, ship.z) >= 0 || islandHit(sceneryIslands, ship.x, ship.y, ship.z, wrapNear) >= 0;
        if (route.step(ship, flight.grounded, flight.touchdownSpeed, flightInfo.bricksBurned, dt, crashed)) {
          this.sendRoute();
        }
        flightInfo.heat = flight.heat;
        flightInfo.climb = flight.climb;
        flightInfo.airspeed = flight.airspeed;
        flightInfo.liftRate = flight.liftRate(c.ballastDropped);
        flightInfo.burner = c.burner > 0;
        flightInfo.vent = c.vent > 0;
        flightInfo.rudder = c.rudder;
        flightInfo.ventOpen = c.vent;
      } else {
        stepShip(ship, this.profile, dt);
      }
      if (this.fixedTilt) {
        ship.roll = (this.fixedTilt[0] * Math.PI) / 180;
        ship.pitch = (this.fixedTilt[1] * Math.PI) / 180;
        updateQuaternion(ship);
        updateFeltGravity(ship);
      }
    }
    if (netLink.connected) {
      this.sendState(dt);
      const now = performance.now();
      if (this.flying && (!this.wasConnected || now - this.routeSentAt > ROUTE_RESEND_MS)) {
        this.sendRoute();
      }
    }
    this.wasConnected = netLink.connected;
  }

  private sendState(dt: number): void {
    this.sendAccumulator += dt;
    if (this.sendAccumulator < 1 / SHIP_SEND_HZ) {
      return;
    }
    this.sendAccumulator = Math.min(this.sendAccumulator - 1 / SHIP_SEND_HZ, 1 / SHIP_SEND_HZ);
    const o = this.outgoing;
    o.timeMs = performance.now();
    o.flags = (shipInfo.paused ? SHIP_FLAG_PAUSED : 0) | (flightInfo.flying && flightInfo.burner ? SHIP_FLAG_BURNER : 0) |
      (flightInfo.flying && flightInfo.vent ? SHIP_FLAG_VENT : 0);
    o.shipTime = ship.time;
    o.x = ship.x;
    o.y = ship.y;
    o.z = ship.z;
    o.yaw = ship.yaw;
    o.pitch = ship.pitch;
    o.roll = ship.roll;
    o.vx = ship.vx;
    o.vy = ship.vy;
    o.vz = ship.vz;
    o.ax = ship.ax;
    o.ay = ship.ay;
    o.az = ship.az;
    o.yawRate = this.flying ? flight.yawRate : 0;
    o.heat = this.flying ? flight.heat : 0;
    o.airspeed = ship.speed;
    o.rudder = flightInfo.rudder;
    o.vent = flightInfo.ventOpen;
    o.burnLeft = flightInfo.burnLeft;
    o.ballast = flightInfo.ballastMask;
    netLink.send(this.sendBuffer, encodeShip(this.sendBuffer, o));
  }

  update(delta: number): void {
    // B on the right controller stops the ship at once, and starts it again
    // (a comfort escape for playtests; P does the same on a keyboard).
    if (this.input.xr.gamepads.right?.getButtonDown(InputComponent.B_Button)) {
      this.togglePause();
    }
    const dt = Math.min(delta, 0.1);
    const guest = netLink.connected && !netLink.isHost;
    if (guest !== this.following) {
      this.following = guest;
      this.follower.reset();
    }
    if (guest) {
      // The guest's ship is the host's: follow it.
      this.follower.update(ship, performance.now(), dt);
      const h = this.follower.latest;
      shipInfo.paused = this.follower.paused;
      flightInfo.flying = h.heat > 0;
      flightInfo.heat = h.heat;
      flightInfo.airspeed = h.airspeed;
      flightInfo.climb = h.vy;
      flightInfo.burner = (h.flags & SHIP_FLAG_BURNER) !== 0;
      flightInfo.vent = (h.flags & SHIP_FLAG_VENT) !== 0;
      flightInfo.rudder = h.rudder;
      flightInfo.ventOpen = h.vent;
      flightInfo.burnLeft = h.burnLeft;
      flightInfo.ballastMask = h.ballast;
      if (route.phase === 'flying') {
        route.seconds = Math.max(0, ship.time - route.startTime);
      }
    } else {
      this.flyOwnShip(dt);
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
