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
import { CargoSim, CRATE_KG } from '../sim/cargo.js';
import { CRATE_COUNT, CrateYard, obstaclesFrom, PRACTICE_DECK } from '../sim/stowage.js';
import { GONDOLA_COLLIDERS } from '../scene-assets/gondola.scene-asset.js';
import { envelopeUnderside } from '../scene-assets/repairs.scene-asset.js';
import { EnvelopeSim } from '../sim/envelope.js';
import { alongsidePost, DockingSim } from '../sim/docking.js';
import { createFlightControls, DEFAULT_FLIGHT, FlightSim } from '../sim/flight.js';
import { ballastDropped } from '../sim/gondola-controls.js';
import { fendOff, groundBelow, islandHit, restingDeck } from '../sim/islands.js';
import { type RoutePhase, type RouteResult, RouteRun, targetPoints } from '../sim/route.js';
import { wrapNear } from '../sim/world-tile.js';
import { draftAt, WindSim } from '../sim/wind.js';
import { ROUTE, SHIP_ISLANDS, sceneryIslands } from '../world/route-world.js';
import { onSettingChange } from '../live-settings.js';
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

/**
 * The motion profile in use and whether the ship is held still, for the
 * comfort log; `stopped` is whether a player stopped it with B (or P), as
 * against waiting for a crewmate who can't play (CrewStatusSystem says which).
 */
export const shipInfo = { motion: 'still', paused: false, stopped: false };

/**
 * While the game menu is open, B closes it instead of stopping the ship.
 * GameMenuSystem keeps `menuOpen`, and sets `usedByMenu` in a frame where B
 * closed it (whichever of the two systems runs first that frame).
 */
export const stopButton = { menuOpen: false, usedByMenu: false };

/** Phase 2: the crew-controlled flight model (`?motion=flight`) and what the crew is doing to it. */
export const flight = new FlightSim({ ...DEFAULT_FLIGHT });
export const flightControls = createFlightControls();
/** Seconds of full flame one fuel brick gives, and the most the burner holds at once. */
export const BRICK_BURN_SECONDS = 20;
const MAX_BURN_SECONDS = 60;
/** Where the flight starts: resting on the route's island A, facing world -Z. */
const FLIGHT_START = [ROUTE.start.x, restingDeck(ROUTE.start), ROUTE.start.z] as const;
/** Waiting on island A, the ground crew keeps the envelope this close below floating heat, °C. */
const READY_HEAT_BELOW = 2;
/** Practice docking starts with the fairlead this far out from the post, m. */
const PRACTICE_DOCK_ACROSS = 5;
/** Practice cargo starts made fast with this much line out, m. */
const PRACTICE_CARGO_LINE = 1.2;
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

/**
 * Docking at island B's post (Phase 3): the grapple and the line's hold on
 * the ship. RopeSystem throws and hauls; on the host (or solo) this system
 * keeps the ship on the line after each flight step.
 */
export const docking = new DockingSim(ROUTE.dock);

/**
 * The crate in the hatch (Phase 3 cargo, docs/cargo.md), lowered through it
 * onto island B's cargo stage. CargoSystem works the hatch, winch and tag
 * line and runs it on the host.
 */
export const cargo = new CargoSim();

/**
 * The crates (Phase 3 cargo loading): waiting on A's loading stage, carried
 * by hand, stowed on deck or in the hatch (where `cargo` takes over), and
 * delivered. StowageSystem works the handles and runs it on the host.
 */
export const yard = new CrateYard(obstaclesFrom(GONDOLA_COLLIDERS));

/**
 * The wind's gusts (Phase 3, docs/wind.md): the host sends them on their
 * way while a run is under way and passes their push, and the drafts', to
 * the flight model; the guest takes the host's gust with the route, to draw
 * and hear it. `auto` off (tests) sends gusts only when asked.
 */
export const wind = new WindSim();
export const windControl = { auto: settings.gusts };

/**
 * The envelope's tears (Phase 3 repairs, docs/repairs.md): RepairSystem
 * opens them on their schedule and mends them on the host, and the leak
 * goes into the flight model here; tears left unmended at the finish cost
 * points. The guest takes the host's tears to draw and hear them.
 */
export const envelope = new EnvelopeSim(envelopeUnderside());

/**
 * Phase 2 ready check: with a crewmate, the ship stays moored to island A
 * until both players have rung the bell there. Solo, it casts off as soon as
 * it has lift. The host keeps this and sends it with the route.
 */
export const crewReady = { host: false, guest: false };

/** Whether the ship is held on island A waiting for the crew to be ready. */
export function moored(): boolean {
  return netLink.connected && route.phase === 'ready' && !(crewReady.host && crewReady.guest);
}

/** The ship system's own restart and ready check, set when it starts. */
const routeControl = {
  restart: () => undefined as void,
  ready: () => undefined as void,
  practiceDocking: () => undefined as void,
  practiceCargo: () => undefined as void,
  sendGust: () => undefined as void,
};

/** The crates, as the route counts them (filled in each step on the host). */
const routeCargo = { aboard: 0, delivered: 0, total: CRATE_COUNT, condition: 0, target: 0 };

/** The crates as the route counts them: aboard, delivered, their conditions and the target's points for where they were set down. */
function countCrates(): void {
  routeCargo.aboard = yard.aboard(cargo);
  routeCargo.delivered = 0;
  routeCargo.condition = 0;
  routeCargo.target = 0;
  for (const c of yard.crates) {
    if (c.state === 'delivered') {
      routeCargo.delivered++;
      routeCargo.condition += c.condition;
      routeCargo.target += targetPoints(ROUTE, c.x, c.z);
    }
  }
}

/** This player is ready to cast off (the guest tells the host). */
export function markReady(): void {
  if (netLink.connected && !netLink.isHost) {
    netLink.sendEvent({ t: 'crew-ready' });
  } else {
    routeControl.ready();
  }
}

/** Start the route again from island A (the guest asks the host). */
export function restartRoute(): void {
  if (netLink.connected && !netLink.isHost) {
    netLink.sendEvent({ t: 'route-restart' });
  } else {
    routeControl.restart();
  }
}

/**
 * Practice docking (the game menu's "Start beside B's post"): start a run
 * with both rings flown and the ship beside island B's mooring post, level
 * with it, so the crew can go straight to throwing the grapple (the guest
 * asks the host).
 */
export function practiceDocking(): void {
  if (netLink.connected && !netLink.isHost) {
    netLink.sendEvent({ t: 'route-dock' });
  } else {
    routeControl.practiceDocking();
  }
}

/**
 * Practice cargo (the game menu's "Made fast at B"): start a run with
 * both rings flown and the ship already made fast at island B's post, the
 * crates aboard (one in the hatch, one on deck), so the crew can go straight
 * to lowering them (the guest asks the host).
 */
export function practiceCargo(): void {
  if (netLink.connected && !netLink.isHost) {
    netLink.sendEvent({ t: 'route-cargo' });
  } else {
    routeControl.practiceCargo();
  }
}

/** A gust on its way now (the game menu's Practice → Send a gust; the guest asks the host). */
export function sendGust(): void {
  if (netLink.connected && !netLink.isHost) {
    netLink.sendEvent({ t: 'wind-gust' });
  } else {
    routeControl.sendGust();
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
  flightControls.ballastDropped = weightOff();
}

/** What the envelope no longer has to lift: the sandbags dropped, and each crate not aboard (on the stage, delivered or lost). */
function weightOff(): number {
  return ballastDropped(flightInfo.ballastMask) + CRATE_KG * (CRATE_COUNT - yard.aboard(cargo));
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
  private gustPush = { x: 0, z: 0 };

  init(): void {
    // The breeze's strength from the game menu (only the host's or a solo ship's matters).
    const applyWind = () => {
      flight.params.windSpeed = DEFAULT_FLIGHT.windSpeed * settings.wind;
      flight.params.windVariation = DEFAULT_FLIGHT.windVariation * settings.wind;
      if (!netLink.connected || netLink.isHost) {
        wind.scale = settings.wind;
        this.sendRoute();
      }
    };
    applyWind();
    this.cleanupFuncs.push(
      onSettingChange((key) => {
        if (key === 'wind') {
          applyWind();
        }
      }),
    );
    routeControl.restart = () => this.restart();
    routeControl.practiceDocking = () => this.practiceDocking();
    routeControl.practiceCargo = () => this.practiceCargo();
    routeControl.sendGust = () => {
      const g = wind.send(ship.time, ship.yaw);
      console.info(`[Wind] gust sent: ${g.peak.toFixed(1)} m/s towards ${Math.round((g.heading * 180) / Math.PI)}°`);
      this.sendRoute();
    };
    routeControl.ready = () => {
      crewReady.host = true;
      this.sendRoute();
    };
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
    netLink.events.set('route-dock', () => {
      if (netLink.isHost) {
        this.practiceDocking();
      }
    });
    netLink.events.set('route-cargo', () => {
      if (netLink.isHost) {
        this.practiceCargo();
      }
    });
    netLink.events.set('wind-gust', () => {
      if (netLink.isHost) {
        routeControl.sendGust();
      }
    });
    netLink.events.set('crew-ready', () => {
      if (netLink.isHost && route.phase === 'ready') {
        crewReady.guest = true;
        this.sendRoute();
      }
    });
    this.cleanupFuncs.push(() => {
      netLink.handlers.delete(PacketType.Ship);
      for (const name of ['ship-pause', 'feed', 'ballast', 'route', 'route-restart', 'route-dock', 'route-cargo', 'wind-gust', 'crew-ready']) {
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
    (window as { __wind?: unknown }).__wind = {
      sim: wind,
      control: windControl,
      /** What Practice → Send a gust does. */
      send: () => sendGust(),
      /** Random gusts on or off (tests turn them off so other checks aren't pushed about). */
      setAuto: (on: boolean) => {
        windControl.auto = on;
      },
      /** The gust's push the ship has taken up, and the draft's, m/s. */
      push: () => ({ x: flight.gustX, z: flight.gustZ, up: flight.draft }),
    };
  }

  /** Host or solo: back to island A with the crates on the loading stage, fresh ballast and a fresh route. */
  private restart(): void {
    this.flying = true;
    flight.reset(ship, FLIGHT_START[0], FLIGHT_START[1], FLIGHT_START[2], 0);
    flight.heat -= READY_HEAT_BELOW;
    Object.assign(flightControls, createFlightControls());
    flightInfo.burnLeft = 0;
    flightInfo.bricksBurned = 0;
    setBallast(0);
    route.reset();
    docking.reset();
    cargo.reset();
    yard.reset(ROUTE.loading, cargo);
    // Each run gets its own gusts, and its own tears.
    wind.reset(Math.floor(Math.random() * 0x7fffffff));
    wind.scale = settings.wind;
    envelope.reset(Math.floor(Math.random() * 0x7fffffff));
    envelope.rate = settings.tears;
    crewReady.host = crewReady.guest = false;
    this.sendRoute();
  }

  /**
   * Host or solo: a fresh run already under way beside island B's post,
   * both rings flown, the crates aboard, the envelope at floating heat and
   * the ship still.
   */
  private practiceDocking(): void {
    this.restart();
    yard.stowAboard(cargo, PRACTICE_DECK);
    const at = alongsidePost(ROUTE.dock, ROUTE.finish.x, ROUTE.finish.z, PRACTICE_DOCK_ACROSS);
    flight.reset(ship, at.x, at.y, at.z, at.yaw);
    route.phase = 'flying';
    route.ringMask = (1 << ROUTE.rings.length) - 1;
    route.startTime = ship.time;
    route.jumped();
    crewReady.host = crewReady.guest = true;
    console.info('[Route] practice docking: starting beside the post at B');
    this.sendRoute();
  }

  /**
   * Host or solo: a fresh run already under way with the ship made fast at
   * island B's post (level with it, port side to it), both rings flown and
   * the crates aboard: one in the hatch, one stowed on deck.
   */
  private practiceCargo(): void {
    this.restart();
    yard.stowAboard(cargo, PRACTICE_DECK);
    const at = alongsidePost(ROUTE.dock, ROUTE.finish.x, ROUTE.finish.z, PRACTICE_CARGO_LINE);
    flight.reset(ship, at.x, at.y, at.z, at.yaw);
    docking.makeFast(ship, PRACTICE_CARGO_LINE);
    route.phase = 'flying';
    route.ringMask = (1 << ROUTE.rings.length) - 1;
    route.startTime = ship.time;
    route.jumped();
    crewReady.host = crewReady.guest = true;
    console.info('[Route] practice cargo: starting made fast at B');
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
      ready: [crewReady.host, crewReady.guest],
      wind: settings.wind,
      gust: wind.toWire(),
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
    const ready = Array.isArray(event.ready) ? event.ready : [];
    crewReady.host = ready[0] === true;
    crewReady.guest = ready[1] === true;
    wind.adopt(event.gust, Number(event.wind));
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
    shipInfo.stopped = this.paused;
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
        c.solo = !netLink.connected;
        c.ballastDropped = weightOff();
        if (route.phase === 'ready') {
          // The ground crew keeps the envelope just below floating heat for what is aboard (the crates
          // come aboard while it waits, making it heavier) until the burner is fed.
          const rest = flight.balanceHeat(c.ballastDropped) - READY_HEAT_BELOW;
          flight.heat = flightInfo.burnLeft > 0 ? Math.max(flight.heat, rest) : rest;
        }
        // Run into an island and the ship stops there until the crew starts again.
        if (route.phase !== 'lost') {
          const ground = Math.max(
            groundBelow(SHIP_ISLANDS, ship.x, ship.z, ship.y),
            groundBelow(sceneryIslands, ship.x, ship.z, ship.y, wrapNear),
          );
          const fromY = ship.y;
          // The gusts (sent on their way once the run is under way) and the drafts.
          wind.scale = settings.wind;
          if (wind.step(ship.time, route.phase === 'flying', windControl.auto, ship.yaw)) {
            console.info(`[Wind] gust coming: ${wind.gust!.peak.toFixed(1)} m/s`);
            this.sendRoute();
          }
          wind.gustVelocity(ship.time, this.gustPush);
          c.gustX = this.gustPush.x;
          c.gustZ = this.gustPush.z;
          c.draft = draftAt(ROUTE.drafts, ship.x, ship.y, ship.z) * settings.wind;
          // Hot air out through any tears in the envelope (RepairSystem moves them on).
          c.leak = envelope.leak;
          flight.step(ship, c, dt, ground, moored());
          // On the line to island B's post: held in by it, and held still once made fast.
          docking.constrain(ship, docking.lineOut, dt);
          if (docking.phase === 'fast') {
            flight.airspeed = 0;
            flight.climb = 0;
            flight.yawRate = 0;
          } else if (fendOff(ROUTE.cargo, ship, fromY, dt)) {
            // Sitting on the cargo stage's planks: it rises again as soon as it has lift.
            flight.climb = Math.max(0, flight.climb);
          }
        }
        const crashed = islandHit(SHIP_ISLANDS, ship.x, ship.y, ship.z) >= 0 || islandHit(sceneryIslands, ship.x, ship.y, ship.z, wrapNear) >= 0;
        countCrates();
        if (route.step(ship, flight.grounded, docking.phase === 'fast', flightInfo.bricksBurned, docking.tears, dt, crashed, routeCargo, envelope.unmended)) {
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
    if (netLink.connected !== this.wasConnected) {
      // A crewmate joined or left: whoever is aboard now says they're ready again.
      crewReady.host = crewReady.guest = false;
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
    // (a comfort escape for playtests; P does the same on a keyboard). With
    // the game menu open, B closes the menu instead.
    if (this.input.xr.gamepads.right?.getButtonDown(InputComponent.B_Button) && !stopButton.menuOpen && !stopButton.usedByMenu) {
      this.togglePause();
    }
    stopButton.usedByMenu = false;
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
      // The host's flag also covers waiting for a crewmate, which this page's own presence shows.
      shipInfo.stopped = this.follower.paused && !crewPresence.paused;
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
