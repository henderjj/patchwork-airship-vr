/**
 * The two-person propeller crank (spike S6). Engine-free so the host's
 * simulation could move to a server.
 *
 * The crank is a horizontal axle with two handles half a turn apart, one for
 * each player. A hand holding a handle pulls it toward the hand like a stiff
 * spring with limited strength (a player can only push so hard), and the
 * propeller loads the crank with drag that grows with the square of its
 * speed. One player alone tops out at a steady cruising speed.
 *
 * When both handles are held by different players and their hands lead
 * their handles by the same amount of time (within the sync window, 150 ms
 * to start), the crank "clicks into high gear": the load drops so the pair
 * can reach about three times the solo speed. Out of sync, a hand that lags
 * its handle pulls against the crank, which stutters.
 *
 * Network latency: each hand's input carries the local time the hand was
 * there, and its error is measured against the crank angle at that same
 * moment (kept in a short history), so a crewmate's hand that arrives
 * 100 ms late is judged on its rhythm, not penalised for the delay.
 */

export interface CrankParams {
  /** Moment of inertia of crank plus propeller. */
  inertia: number;
  /** Spring from hand to handle, torque per radian of lead. */
  stiffness: number;
  /** Damping on the difference between hand and crank speed. */
  handDamping: number;
  /** Strongest torque one hand can apply. */
  maxTorque: number;
  /** Propeller drag coefficient (torque = drag · ω²). */
  drag: number;
  /** Bearing friction (torque = friction · ω). */
  friction: number;
  /** Drag divisor in high gear: 4.5 gives three times the solo top speed for two players. */
  syncDragDivisor: number;
  /** Sync window, ms: how closely the two hands' timing must match. */
  syncWindowMs: number;
  /** Seconds for high gear to engage fully (and to drop out). */
  syncRampSeconds: number;
  /** A hand further than this from its handle (radians) lets go. */
  slipAngle: number;
}

export const DEFAULT_CRANK: CrankParams = {
  inertia: 0.05,
  stiffness: 2.5,
  handDamping: 0.12,
  maxTorque: 1,
  // Solo top speed sqrt(maxTorque / drag) ≈ 3.2 rad/s, about half a turn a second.
  drag: 0.1,
  friction: 0.02,
  syncDragDivisor: 4.5,
  syncWindowMs: 150,
  syncRampSeconds: 0.4,
  // About 22 cm along the handle's circle.
  slipAngle: 1.0,
};

/** Handle offsets around the axle: handle 0 at angle θ, handle 1 half a turn on. */
export const HANDLE_OFFSETS = [0, Math.PI] as const;

export interface HandleInput {
  holding: boolean;
  /** Which player holds it (0 host, 1 guest); sprinting needs two different players. */
  player: number;
  /** Angle of the hand around the axle, radians, same convention as the crank angle. */
  handAngle: number;
  /** Local time the hand was at this angle, ms (now for this player, in the past for the crewmate). */
  atMs: number;
}

export function createHandleInput(): HandleInput {
  return { holding: false, player: 0, handAngle: 0, atMs: 0 };
}

export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

const HISTORY = 128;
/** How far (radians) a hand may trail its handle and still count as cranking with it. */
const DRAG_BACK = 0.15;

export class CrankSim {
  readonly params: CrankParams;
  /** Unwrapped crank angle, radians (positive cranks the ship forward). */
  angle = 0;
  /** Angular speed, rad/s. */
  omega = 0;
  /** 0 to 1: how far high gear is engaged. */
  gear = 0;
  /** Whether the hands are currently in sync (both players holding). */
  inSync = false;
  /** Timing difference between the two players' hands, ms (NaN unless both hold). */
  syncOffsetMs = Number.NaN;
  /** Per handle: lead of the hand over its handle (radians), and whether it slipped off this step. */
  readonly lead = [0, 0];
  readonly slipped = [false, false];
  /** Per handle: strain 0 to 1 (how hard the hand is pulling), for haptics. */
  readonly strain = [0, 0];
  /** Seconds the two players have been pulling against each other (out of sync). */
  stutter = 0;

  private times = new Float64Array(HISTORY);
  private angles = new Float64Array(HISTORY);
  private next = 0;
  private count = 0;
  private prevHand = [Number.NaN, Number.NaN];
  private prevHandTime = [0, 0];
  private handSpeed = [0, 0];

  constructor(params: CrankParams = DEFAULT_CRANK) {
    this.params = params;
  }

  /** Solo top speed, rad/s. */
  get soloTopSpeed(): number {
    const p = this.params;
    return Math.sqrt(p.maxTorque / p.drag);
  }

  /** Crank angle at local time `ms`, from the recorded history (clamped to its ends). */
  angleAt(ms: number): number {
    if (this.count === 0) {
      return this.angle;
    }
    const newest = (this.next - 1 + HISTORY) % HISTORY;
    if (ms >= this.times[newest]) {
      return this.angles[newest];
    }
    for (let i = 1; i < this.count; i++) {
      const b = (newest - i + 1 + HISTORY) % HISTORY;
      const a = (newest - i + HISTORY) % HISTORY;
      if (ms >= this.times[a]) {
        const t = (ms - this.times[a]) / (this.times[b] - this.times[a] || 1);
        return this.angles[a] + (this.angles[b] - this.angles[a]) * t;
      }
    }
    return this.angles[(newest - this.count + 1 + HISTORY) % HISTORY];
  }

  /**
   * Advance by `dt` seconds at local time `nowMs`. Handles that slip are
   * reported in `slipped`; the caller should release them.
   */
  step(dt: number, nowMs: number, inputs: readonly HandleInput[]): void {
    const p = this.params;
    let torque = 0;
    let holders = 0;
    for (let i = 0; i < 2; i++) {
      const input = inputs[i];
      this.slipped[i] = false;
      this.strain[i] = 0;
      if (!input?.holding) {
        this.prevHand[i] = Number.NaN;
        this.lead[i] = 0;
        continue;
      }
      // Hand speed from successive samples (inputs may arrive at their own rate).
      if (!Number.isNaN(this.prevHand[i]) && input.atMs > this.prevHandTime[i]) {
        const d = wrapAngle(input.handAngle - this.prevHand[i]);
        const speed = d / ((input.atMs - this.prevHandTime[i]) / 1000);
        this.handSpeed[i] += (speed - this.handSpeed[i]) * 0.5;
      }
      if (Number.isNaN(this.prevHand[i]) || input.atMs > this.prevHandTime[i]) {
        this.prevHand[i] = input.handAngle;
        this.prevHandTime[i] = input.atMs;
      }
      const crankThen = this.angleAt(input.atMs) + HANDLE_OFFSETS[i];
      const lead = wrapAngle(input.handAngle - crankThen);
      this.lead[i] = lead;
      if (Math.abs(lead) > p.slipAngle) {
        this.slipped[i] = true;
        this.prevHand[i] = Number.NaN;
        continue;
      }
      holders++;
      const t = p.stiffness * lead + p.handDamping * (this.handSpeed[i] - this.omega);
      const clamped = Math.max(-p.maxTorque, Math.min(p.maxTorque, t));
      this.strain[i] = Math.abs(clamped) / p.maxTorque;
      torque += clamped;
    }

    // Sync: both handles held by different players, hands leading by the same time.
    const a = inputs[0];
    const b = inputs[1];
    const twoPlayers = holders === 2 && a.player !== b.player;
    if (twoPlayers) {
      const speed = Math.max(Math.abs(this.omega), 0.5);
      this.syncOffsetMs = (Math.abs(this.lead[0] - this.lead[1]) / speed) * 1000;
      // A hand just behind its handle is still "with" the crank; one pulling well back is not.
      const dir = this.omega >= 0 ? 1 : -1;
      const bothDriving = this.lead[0] * dir > -DRAG_BACK && this.lead[1] * dir > -DRAG_BACK;
      this.inSync = bothDriving && this.syncOffsetMs <= p.syncWindowMs;
    } else {
      this.syncOffsetMs = Number.NaN;
      this.inSync = false;
    }
    const ramp = dt / p.syncRampSeconds;
    this.gear = Math.max(0, Math.min(1, this.gear + (this.inSync ? ramp : -ramp)));

    const drag = p.drag / (1 + (p.syncDragDivisor - 1) * this.gear);
    const load = drag * this.omega * Math.abs(this.omega) + p.friction * this.omega;
    this.omega += ((torque - load) / p.inertia) * dt;
    this.angle += this.omega * dt;

    const fighting = twoPlayers && this.lead[0] * this.lead[1] < 0 && Math.abs(this.lead[0] - this.lead[1]) > 0.2;
    this.stutter = fighting ? this.stutter + dt : 0;

    this.times[this.next] = nowMs;
    this.angles[this.next] = this.angle;
    this.next = (this.next + 1) % HISTORY;
    this.count = Math.min(this.count + 1, HISTORY);
  }

  /** Pull the simulation toward an authoritative state (the guest following the host). */
  blendToward(angle: number, omega: number, gear: number, rate: number): void {
    const error = angle - this.angle;
    if (Math.abs(error) > 1.5) {
      this.angle = angle; // too far apart: snap
      this.omega = omega;
    } else {
      this.angle += error * rate;
      this.omega += (omega - this.omega) * rate;
    }
    this.gear += (gear - this.gear) * rate;
  }
}
