/**
 * Kinematic ship motion for spikes S2 and S3: a scripted flight with turns,
 * climbs, gusts and tilt, driven by a comfort profile. Pure TypeScript with no
 * rendering or IWSDK imports, so the host can run it anywhere.
 *
 * Coordinates: world Y is up; the ship's bow points along its local -Z.
 * The gondola never moves in the player's tracking space; instead the world is
 * drawn with the inverse of the ship pose, and physics uses the "felt" gravity
 * in ship space (true gravity minus the ship's acceleration, rotated into the
 * ship frame).
 */

export interface MotionProfile {
  name: string;
  /** Cruise airspeed, m/s. */
  speed: number;
  /** Peak turn rate, degrees per second. */
  maxYawRateDeg: number;
  /** Peak climb or descent rate, m/s. */
  maxClimb: number;
  /** Peak pitch and roll, degrees. */
  maxTiltDeg: number;
  /** Peak sideways gust speed, m/s. */
  gust: number;
}

export const MOTION_PROFILES: Record<string, MotionProfile> = {
  still: { name: 'still', speed: 0, maxYawRateDeg: 0, maxClimb: 0, maxTiltDeg: 0, gust: 0 },
  gentle: { name: 'gentle', speed: 5, maxYawRateDeg: 3, maxClimb: 0.8, maxTiltDeg: 2, gust: 0.5 },
  tour: { name: 'tour', speed: 7, maxYawRateDeg: 6, maxClimb: 1.5, maxTiltDeg: 4, gust: 1.2 },
  lively: { name: 'lively', speed: 10, maxYawRateDeg: 10, maxClimb: 2.5, maxTiltDeg: 7, gust: 2.5 },
};

export const GRAVITY = 9.81;
const DEG = Math.PI / 180;

export interface ShipState {
  time: number;
  /** World position of the deck centre, m. */
  x: number;
  y: number;
  z: number;
  /** Heading about world Y, radians (0 = bow towards world -Z). */
  yaw: number;
  /** Nose-up pitch and starboard-down roll, radians. */
  pitch: number;
  roll: number;
  /** World velocity and acceleration, m/s and m/s². */
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
  /** Ship orientation as a quaternion (x, y, z, w), yaw then pitch then roll. */
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** Current cruise speed (m/s) and its rate of change, eased towards the profile. */
  speed: number;
  speedAccel: number;
  /** Current turn, climb, gust and tilt amplitudes, eased towards the profile. */
  yawAmp: number;
  climbAmp: number;
  gustAmp: number;
  tiltMax: number;
  /** Felt gravity in ship space, m/s². */
  gx: number;
  gy: number;
  gz: number;
}

export function createShipState(altitude = 120): ShipState {
  return {
    time: 0, x: 0, y: altitude, z: 0, yaw: 0, pitch: 0, roll: 0,
    vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0,
    qx: 0, qy: 0, qz: 0, qw: 1, speed: 0, speedAccel: 0, yawAmp: 0, climbAmp: 0, gustAmp: 0, tiltMax: 0, gx: 0, gy: -GRAVITY, gz: 0,
  };
}

/** Smooth gusts in [-1, 1]: mostly calm, with occasional pushes either way. */
function gustAt(t: number): number {
  const a = Math.sin(t * 0.21) * Math.sin(t * 0.077 + 1.3);
  return a * a * a;
}

/** Turn rate shape in [-1, 1]: long straights joined by smooth turns. */
function turnAt(t: number): number {
  const s = Math.sin((t / 70) * Math.PI * 2);
  return Math.sign(s) * Math.min(1, Math.abs(s) * 1.8) ** 2;
}

function climbAt(t: number): number {
  return Math.sin((t / 47) * Math.PI * 2);
}

/** How fast motion amplitudes may change, per second. */
const YAW_AMP_RATE = 0.5 * (Math.PI / 180);
const CLIMB_AMP_RATE = 0.1;
const GUST_AMP_RATE = 0.1;
const TILT_RATE = 0.3 * (Math.PI / 180);
/** Fastest change of cruise speed, m/s². */
const MAX_SPEED_CHANGE = 0.4;

/**
 * Advance the ship by dt seconds. Allocation free; writes into `state`.
 * Speed and the strength of turns, climbs and gusts ease towards the profile
 * (from zero at start), so neither a fresh session nor a profile change jolts
 * the felt gravity.
 */
export function stepShip(state: ShipState, profile: MotionProfile, dt: number): void {
  if (dt <= 0) {
    return;
  }
  const t = state.time + dt;
  // Amplitudes ease towards the profile at capped rates, so a profile change
  // (or a fresh start from rest) never steps the felt gravity.
  state.yawAmp = approach(state.yawAmp, profile.maxYawRateDeg * DEG, YAW_AMP_RATE * dt);
  state.climbAmp = approach(state.climbAmp, profile.maxClimb, CLIMB_AMP_RATE * dt);
  state.gustAmp = approach(state.gustAmp, profile.gust, GUST_AMP_RATE * dt);
  state.tiltMax = approach(state.tiltMax, profile.maxTiltDeg * DEG, TILT_RATE * dt);
  // Critically damped approach to the cruise speed with a capped acceleration,
  // so speed changes start and stop gently (low jerk).
  const wantedAccel = clamp((profile.speed - state.speed) * 0.5, -MAX_SPEED_CHANGE, MAX_SPEED_CHANGE);
  state.speedAccel += (wantedAccel - state.speedAccel) * Math.min(1, 2 * dt);
  state.speed += state.speedAccel * dt;
  const yawRate = turnAt(t) * state.yawAmp;
  const climb = climbAt(t) * state.climbAmp;
  const gust = gustAt(t) * state.gustAmp;
  const speed = state.speed;

  state.yaw += yawRate * dt;
  // Bow points along local -Z, so forward in world is (-sin yaw, 0, -cos yaw).
  const fx = -Math.sin(state.yaw);
  const fz = -Math.cos(state.yaw);
  // Starboard (local +X) in world.
  const sx = Math.cos(state.yaw);
  const sz = -Math.sin(state.yaw);
  const vx = fx * speed + sx * gust;
  const vz = fz * speed + sz * gust;
  const vy = climb;

  // Low-pass the finite-difference acceleration so tiny integration steps
  // don't show up as noise in the physics gravity.
  const k = Math.min(1, dt * 6);
  state.ax += ((vx - state.vx) / dt - state.ax) * k;
  state.ay += ((vy - state.vy) / dt - state.ay) * k;
  state.az += ((vz - state.vz) / dt - state.az) * k;
  state.vx = vx;
  state.vy = vy;
  state.vz = vz;
  state.x += vx * dt;
  state.y += vy * dt;
  state.z += vz * dt;

  // Tilt: bank into turns like a hanging gondola, nose follows climbs, gusts
  // heel the ship, then clamp to the profile limit.
  const maxTilt = state.tiltMax;
  const bank = Math.atan2(yawRate * speed, GRAVITY);
  const heel = gustAt(t) * maxTilt * 0.4;
  state.roll = clamp(bank + heel, -maxTilt, maxTilt);
  state.pitch = climbAt(t) * maxTilt * 0.5;
  state.time = t;

  updateQuaternion(state);
  updateFeltGravity(state);
}

function approach(value: number, target: number, maxStep: number): number {
  return value + clamp(target - value, -maxStep, maxStep);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Orientation = Ry(yaw) · Rx(pitch) · Rz(-roll) (roll positive = starboard down). */
export function updateQuaternion(state: ShipState): void {
  const hy = state.yaw / 2;
  const hp = state.pitch / 2;
  const hr = -state.roll / 2;
  const cy = Math.cos(hy), sy = Math.sin(hy);
  const cp = Math.cos(hp), sp = Math.sin(hp);
  const cr = Math.cos(hr), sr = Math.sin(hr);
  // q = qy * qx * qz
  const ax = cy * sp, ay = sy * cp, az = -sy * sp, aw = cy * cp; // qy*qx
  state.qx = ax * cr + ay * sr;
  state.qy = ay * cr - ax * sr;
  state.qz = aw * sr + az * cr;
  state.qw = aw * cr - az * sr;
}

/** g_ship = R⁻¹ · (g_world − a_ship). */
export function updateFeltGravity(state: ShipState): void {
  const wx = -state.ax;
  const wy = -GRAVITY - state.ay;
  const wz = -state.az;
  rotateByInverse(state, wx, wy, wz);
}

function rotateByInverse(state: ShipState, x: number, y: number, z: number): void {
  // Rotate v by conjugate(q): v' = q* v q.
  const qx = -state.qx, qy = -state.qy, qz = -state.qz, qw = state.qw;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  state.gx = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  state.gy = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  state.gz = iz * qw + iw * -qz + ix * -qy - iy * -qx;
}
