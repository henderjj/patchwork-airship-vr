/**
 * The crew-controlled flight model for the Phase 2 slice. Engine-free, like
 * the crank, so the host's simulation could move to a server.
 *
 * - Lift: the burner heats the envelope, which cools slowly on its own and
 *   quickly through the vent. The ship floats level when the envelope is at
 *   the heat that balances its weight, climbs when hotter and sinks when
 *   cooler, so lift builds and fades over tens of seconds. Dropping ballast
 *   lowers the balancing heat at once.
 * - Thrust: the propeller crank is the only thrust. Airspeed eases towards a
 *   speed set by how fast the crank turns. Turned the other way (handle tops
 *   towards the stern), it drives the ship astern, at most at a fraction of
 *   the top speed.
 * - Steering: the rudder sets a turn rate that needs airflow over it, so it
 *   bites properly only once the ship is moving.
 * - Wind: a gentle, slowly varying breeze drifts the ship, and the gusts
 *   and drafts of src/sim/wind.ts (passed in with the controls) push it
 *   sideways, up or down. The ship takes up a change in the air's motion
 *   gradually, as a big envelope does, and the gondola leans with it.
 * - Trim: where the crew stands leans the gondola a little, and a ship
 *   trimmed nose-down flies slightly downhill.
 * - Tears: hot air leaks out through tears in the envelope
 *   (src/sim/envelope.ts), so it cools faster and the burner has to work
 *   harder to hold height.
 *
 * Turn rate, climb rate, acceleration and tilt are capped by the comfort
 * limits, so nothing the crew does can make the motion harsher than spike S3
 * allows. The model writes the same ShipState as the scripted motion, so the
 * sky, physics gravity and network code don't care which one runs.
 */

import { GRAVITY, type ShipState, updateFeltGravity, updateQuaternion } from './ship-motion.js';

/** Comfort caps on the motion the crew can produce. */
export interface FlightLimits {
  /** Fastest airspeed, m/s. */
  maxSpeed: number;
  /** Fastest change of airspeed, m/s². */
  maxAccel: number;
  /** Fastest turn, degrees per second. */
  maxYawRateDeg: number;
  /** Fastest change of turn rate, degrees per second². */
  maxYawAccelDeg: number;
  /** Fastest climb or descent, m/s. */
  maxClimb: number;
  /** Fastest change of climb rate, m/s². */
  maxClimbAccel: number;
  /** Largest pitch or roll, degrees. */
  maxTiltDeg: number;
  /** Fastest change of pitch or roll, degrees per second. */
  maxTiltRateDeg: number;
}

/**
 * The `tour` comfort profile's limits, used until the S3 playtests set the
 * real ones (see docs/spikes/s3-comfort.md).
 */
export const DEFAULT_FLIGHT_LIMITS: FlightLimits = {
  maxSpeed: 7,
  maxAccel: 0.4,
  maxYawRateDeg: 6,
  maxYawAccelDeg: 2,
  maxClimb: 1.5,
  maxClimbAccel: 0.25,
  maxTiltDeg: 4,
  maxTiltRateDeg: 3,
};

export interface FlightParams {
  /** Envelope heat that floats the loaded ship, °C above the outside air. */
  balanceHeat: number;
  /** Mass of the loaded ship, including ballast, kg. */
  mass: number;
  /** Heating from the burner at full flame, °C per second. */
  burnerHeating: number;
  /** Fraction of the envelope's heat lost per second on its own. */
  cooling: number;
  /** Extra fraction lost per second with the vent fully open. */
  ventCooling: number;
  /** Climb acceleration per °C above the balancing heat, m/s². */
  liftPerDegree: number;
  /** Vertical air drag, per second (sets the steady climb rate). */
  verticalDrag: number;
  /** Airspeed per rad/s of crank speed, m/s. */
  speedPerCrank: number;
  /** The same with no crewmate in the game, m/s: a playing-alone boost. */
  soloSpeedPerCrank: number;
  /** Seconds for the airspeed to settle at the crank's speed. */
  speedLag: number;
  /** Fastest astern speed, as a fraction of the speed limit. */
  reverseFraction: number;
  /** Airspeed at which the rudder has full effect, m/s. */
  rudderFullSpeed: number;
  /** Share of the rudder's effect with the ship standing still. */
  rudderStill: number;
  /** Mean wind, m/s, and the direction it blows towards (radians about Y, 0 = towards -Z). */
  windSpeed: number;
  windHeading: number;
  /** How much the wind's speed wanders, m/s. */
  windVariation: number;
  /** Fastest the ship takes up a change in a gust's push, m/s² (the envelope's inertia). */
  gustFollow: number;
  /** Fastest the ship takes up a change in a draft's rise or fall, m/s². */
  draftFollow: number;
}

export const DEFAULT_FLIGHT: FlightParams = {
  balanceHeat: 60,
  mass: 420,
  // Holding height takes the burner at about 40%, so the crew feed it in
  // pulses; full flame warms the envelope about 0.7 °C a second faster than
  // it cools, so a climb builds over tens of seconds, and an untended ship
  // sinks gently.
  burnerHeating: 1.2,
  cooling: 0.008,
  ventCooling: 0.12,
  liftPerDegree: 0.02,
  verticalDrag: 0.25,
  // One player cranking (about 3.2 rad/s) gives about 3.2 m/s, enough to
  // get about and hold a line in a gust; two in step (about 9.5 rad/s) reach
  // the 7 m/s limit, a sprint rather than a need (John, 2026-10-18). Playing
  // alone, one player makes about 4.8 m/s.
  speedPerCrank: 1,
  soloSpeedPerCrank: 1.5,
  speedLag: 6,
  reverseFraction: 0.4,
  rudderFullSpeed: 3,
  rudderStill: 0.25,
  windSpeed: 0.6,
  windHeading: Math.PI * 0.75,
  windVariation: 0.3,
  // A gust leans the gondola at most about 1.7° and swings the lantern a little.
  gustFollow: 0.3,
  draftFollow: 0.2,
};

/** The breeze's speed at flight time `t`, m/s: `windSpeed`, wandering slowly by up to `windVariation`. */
export function breezeSpeed(p: FlightParams, t: number): number {
  return p.windSpeed + p.windVariation * Math.sin(t * 0.05) * Math.sin(t * 0.013 + 0.7);
}

/** What the crew is doing to the ship this frame. */
export interface FlightControls {
  /** Burner flame, 0 (out) to 1 (full). */
  burner: number;
  /** Vent opening, 0 (closed) to 1 (open). */
  vent: number;
  /** Rudder, -1 (hard to port, turning left) to 1 (hard to starboard, turning right). */
  rudder: number;
  /** Propeller crank speed, rad/s: positive drives the ship ahead, negative astern. */
  crankSpeed: number;
  /** No crewmate in the game: the crank drives at `soloSpeedPerCrank`. */
  solo: boolean;
  /** Ballast dropped so far, kg. */
  ballastDropped: number;
  /** Lean from where the crew and cargo stand: nose-up pitch and starboard-down roll, radians. */
  trimPitch: number;
  trimRoll: number;
  /** The air's motion at the ship from gusts (world, m/s) and drafts (up, m/s), on top of the breeze. */
  gustX: number;
  gustZ: number;
  draft: number;
  /** Hot air lost through tears in the envelope (src/sim/envelope.ts): an extra share of its heat per second. */
  leak: number;
}

export function createFlightControls(): FlightControls {
  return { burner: 0, vent: 0, rudder: 0, crankSpeed: 0, solo: false, ballastDropped: 0, trimPitch: 0, trimRoll: 0, gustX: 0, gustZ: 0, draft: 0, leak: 0 };
}

const DEG = Math.PI / 180;

export class FlightSim {
  /** Envelope heat, °C above the outside air. */
  heat: number;
  /** Airspeed along the bow, m/s. */
  airspeed = 0;
  /** Turn rate, rad/s (positive turns to port, as yaw increases). */
  yawRate = 0;
  /** Climb rate, m/s. */
  climb = 0;
  /** Time flown, s (sets the wind's wandering). */
  time = 0;
  /** Whether the deck rests on an island's top. */
  grounded = false;
  /** Descent rate when the ship last touched down, m/s. */
  touchdownSpeed = 0;
  /** The gusts' and drafts' push the ship has taken up so far (world, m/s). */
  gustX = 0;
  gustZ = 0;
  draft = 0;
  /** The wind blowing now, breeze and gust (world, m/s): what the crate and wind socks feel. */
  windX = 0;
  windZ = 0;
  /**
   * The velocity this model gave the ship last step. Its acceleration (and
   * so the felt gravity) comes from this rather than the ship state's, so
   * a mooring line holding or drawing the ship (src/sim/docking.ts) moves
   * it without jolting the felt gravity.
   */
  private lastV = { x: 0, y: 0, z: 0 };

  constructor(
    readonly params: FlightParams = DEFAULT_FLIGHT,
    readonly limits: FlightLimits = DEFAULT_FLIGHT_LIMITS,
  ) {
    this.heat = params.balanceHeat;
  }

  /** The heat that floats the ship with this much ballast gone, °C. */
  balanceHeat(ballastDropped: number): number {
    const p = this.params;
    return (p.balanceHeat * Math.max(0.1 * p.mass, p.mass - ballastDropped)) / p.mass;
  }

  /** Steady climb rate the current heat is heading for, m/s (positive up). */
  liftRate(ballastDropped: number): number {
    const p = this.params;
    return (p.liftPerDegree * (this.heat - this.balanceHeat(ballastDropped))) / p.verticalDrag;
  }

  /** Put the ship at rest, floating level, with the envelope at its balancing heat. */
  reset(state: ShipState, x: number, y: number, z: number, yaw: number): void {
    this.heat = this.params.balanceHeat;
    this.airspeed = 0;
    this.yawRate = 0;
    this.climb = 0;
    this.time = 0;
    this.grounded = false;
    this.touchdownSpeed = 0;
    this.gustX = this.gustZ = this.draft = 0;
    this.windX = this.windZ = 0;
    this.lastV.x = this.lastV.y = this.lastV.z = 0;
    state.time = 0;
    state.x = x;
    state.y = y;
    state.z = z;
    state.yaw = yaw;
    state.pitch = 0;
    state.roll = 0;
    state.vx = state.vy = state.vz = 0;
    state.ax = state.ay = state.az = 0;
    state.speed = 0;
    updateQuaternion(state);
    updateFeltGravity(state);
  }

  /**
   * Advance by dt seconds, writing the ship's pose into `state`. Allocation
   * free. `ground` is the height of an island top under the deck, if any:
   * the ship settles on it, held there (no drifting, turning or cranking
   * away) until it has the lift to rise. A `moored` ship resting there stays
   * down whatever its lift.
   */
  step(state: ShipState, c: FlightControls, dt: number, ground = Number.NEGATIVE_INFINITY, moored = false): void {
    if (dt <= 0) {
      return;
    }
    const p = this.params;
    const lim = this.limits;
    this.time += dt;

    // Envelope heat: lost on its own, through the vent and through any tears.
    const burner = clamp(c.burner, 0, 1);
    const vent = clamp(c.vent, 0, 1);
    this.heat += (p.burnerHeating * burner - (p.cooling + p.ventCooling * vent + Math.max(0, c.leak)) * this.heat) * dt;
    this.heat = Math.max(0, this.heat);

    // Climb: lift against weight and vertical drag, then the comfort caps.
    const lift = p.liftPerDegree * (this.heat - this.balanceHeat(c.ballastDropped));
    const climbAccel = clamp(lift - p.verticalDrag * this.climb, -lim.maxClimbAccel, lim.maxClimbAccel);
    this.climb = clamp(this.climb + climbAccel * dt, -lim.maxClimb, lim.maxClimb);

    // Airspeed from the crank, eased and capped; negative is astern.
    const wanted = clamp(c.crankSpeed * (c.solo ? p.soloSpeedPerCrank : p.speedPerCrank), -lim.maxSpeed * p.reverseFraction, lim.maxSpeed);
    let speedAccel = clamp((wanted - this.airspeed) / p.speedLag, -lim.maxAccel, lim.maxAccel);
    this.airspeed += speedAccel * dt;

    // Turn rate from the rudder and the airflow over it.
    const bite = p.rudderStill + (1 - p.rudderStill) * Math.min(1, Math.abs(this.airspeed) / p.rudderFullSpeed);
    // Rudder to starboard turns the ship to starboard, which is negative yaw.
    const wantedYaw = -clamp(c.rudder, -1, 1) * bite * lim.maxYawRateDeg * DEG;
    this.yawRate = approach(this.yawRate, wantedYaw, lim.maxYawAccelDeg * DEG * dt);
    state.yaw += this.yawRate * dt;

    // The gusts' and drafts' push, taken up no faster than the envelope's inertia allows.
    let gx = c.gustX - this.gustX;
    let gz = c.gustZ - this.gustZ;
    const gust = Math.hypot(gx, gz);
    const most = p.gustFollow * dt;
    if (gust > most) {
      gx *= most / gust;
      gz *= most / gust;
    }
    this.gustX += gx;
    this.gustZ += gz;
    this.draft = approach(this.draft, c.draft, p.draftFollow * dt);

    // Velocity: along the bow, plus the wind.
    const fx = -Math.sin(state.yaw);
    const fz = -Math.cos(state.yaw);
    const breeze = breezeSpeed(p, this.time);
    this.windX = -Math.sin(p.windHeading) * breeze + this.gustX;
    this.windZ = -Math.cos(p.windHeading) * breeze + this.gustZ;
    let vx = fx * this.airspeed + this.windX;
    let vz = fz * this.airspeed + this.windZ;
    // Trimmed nose-down, the ship flies a little downhill (and nose-up, uphill); drafts carry it up or down.
    let vy = clamp(this.climb + this.airspeed * Math.sin(c.trimPitch) + this.draft, -lim.maxClimb, lim.maxClimb);
    // How fast the gust's push is changing, along the bow and to starboard: the gondola leans with it.
    let gustAhead = (gx * fx + gz * fz) / dt;
    let gustStarboard = (gx * -fz + gz * fx) / dt;

    // Resting on an island: the ground takes the weight and holds the ship.
    if (state.y + vy * dt <= ground || (moored && state.y <= ground + 0.01)) {
      if (!this.grounded) {
        this.touchdownSpeed = Math.max(0, -vy);
        this.grounded = true;
      }
      state.y = ground;
      vx = vy = vz = 0;
      // Moored, the lines take the lift too: the climb builds from rest once cast off.
      this.climb = moored ? 0 : Math.max(0, this.climb);
      this.airspeed = 0;
      speedAccel = 0;
      state.yaw -= this.yawRate * dt;
      this.yawRate = 0;
      gustAhead = gustStarboard = 0;
    } else {
      this.grounded = false;
    }

    const k = Math.min(1, dt * 6);
    const last = this.lastV;
    state.ax += ((vx - last.x) / dt - state.ax) * k;
    state.ay += ((vy - last.y) / dt - state.ay) * k;
    state.az += ((vz - last.z) / dt - state.az) * k;
    last.x = vx;
    last.y = vy;
    last.z = vz;
    state.vx = vx;
    state.vy = vy;
    state.vz = vz;
    state.x += vx * dt;
    state.y += vy * dt;
    state.z += vz * dt;
    state.speed = this.airspeed;
    state.speedAccel = speedAccel;

    // Tilt: the gondola banks into turns, lifts its nose a little as it
    // speeds up, and leans with the trim; capped and slewed gently.
    const maxTilt = lim.maxTiltDeg * DEG;
    const slew = lim.maxTiltRateDeg * DEG * dt;
    // A gust pushing the envelope to one side swings the basket the same way a turn does.
    const bank = Math.atan2(-this.yawRate * this.airspeed + gustStarboard, GRAVITY);
    const roll = clamp(bank + c.trimRoll, -maxTilt, maxTilt);
    const pitch = clamp(Math.atan2(speedAccel + gustAhead, GRAVITY) + c.trimPitch, -maxTilt, maxTilt);
    state.roll = approach(state.roll, roll, slew);
    state.pitch = approach(state.pitch, pitch, slew);
    state.time += dt;

    updateQuaternion(state);
    updateFeltGravity(state);
  }
}

function approach(value: number, target: number, maxStep: number): number {
  return value + clamp(target - value, -maxStep, maxStep);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
