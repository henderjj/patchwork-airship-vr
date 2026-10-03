/**
 * Hand-over-hand rope haul (spike S6, part 2), the docking mooring line.
 * Engine-free, like the crank.
 *
 * The line runs inboard through a fairlead along the port rail. It is a
 * one-dimensional object: `hauled` is how many metres have been pulled in.
 * The dock pulls it back out with a steady load. A hand that grabs the line
 * holds the bit of rope under it, and pulls that bit towards where the hand
 * is now, like a stiff spring. Each player can only pull so hard in total
 * (both hands together), and a hand that gets too far from its bit of rope
 * lets it slip through.
 *
 * One player alone can haul, but slowly; pulling harder makes the line slip
 * through their hands. Two players can pull twice as hard, and when their
 * strokes start together (within the sync window, 150 ms to start) the pull
 * is a "heave": both pull harder for that stroke, as crews do when they
 * call the heave.
 *
 * Like the crank, every hand input carries the time the hand was there and
 * is compared with where the line was at that moment, so a crewmate's late
 * packets don't spoil their rhythm.
 */

export interface RopeParams {
  /** Effective mass of the line and what it is pulling, kg-ish. */
  mass: number;
  /** Spring from a hand to its bit of rope, force per metre. */
  stiffness: number;
  /** Damping on the difference between hand and line speed. */
  handDamping: number;
  /** Strongest total pull of one player. */
  maxPlayerForce: number;
  /** Steady pull of the dock on the line. */
  load: number;
  /** Friction of the line through the fairlead (force per m/s). */
  damping: number;
  /** A hand further than this from its bit of rope (m) lets it slip. */
  slipDistance: number;
  /** Hand speed along the line that starts a stroke, and below which it ends (m/s). */
  strokeStartSpeed: number;
  strokeEndSpeed: number;
  /** How close two players' stroke starts must be for a heave, ms. */
  syncWindowMs: number;
  /** Pull multiplier during a heave. */
  heaveBoost: number;
  /** Metres of line to haul in before the ship is docked. */
  length: number;
}

export const DEFAULT_ROPE: RopeParams = {
  // Light and stiff enough that the line answers the hand within a tenth of a second.
  mass: 0.6,
  stiffness: 40,
  handDamping: 4,
  maxPlayerForce: 1,
  load: 0.6,
  damping: 0.8,
  slipDistance: 0.25,
  strokeStartSpeed: 0.35,
  strokeEndSpeed: 0.1,
  syncWindowMs: 150,
  heaveBoost: 1.6,
  length: 8,
};

/** Hand slots: player 0 left, player 0 right, player 1 left, player 1 right. */
export const ROPE_SLOTS = 4;

export interface RopeHandInput {
  holding: boolean;
  /** Hand position along the line's path, metres (increasing inboard). */
  along: number;
  /** Local time the hand was there, ms. */
  atMs: number;
}

export function createRopeHandInput(): RopeHandInput {
  return { holding: false, along: 0, atMs: 0 };
}

const HISTORY = 128;
/** A grab this soon after the line slipped through the same hand doesn't start a stroke, ms. */
const SLIP_REGRAB_MS = 300;
/** A stroke must get going this soon after the grab, ms. */
const STROKE_GRAB_MS = 300;

export class RopeHaulSim {
  readonly params: RopeParams;
  /** Metres hauled in. */
  hauled = 0;
  /** Line speed, m/s (positive is inboard). */
  speed = 0;
  /** True while both players are in a heave together. */
  heave = false;
  /** Number of heaves so far. */
  heaves = 0;
  docked = false;
  /** Per slot: whether the hand slipped off this step, and how far it is from its bit of rope (m). */
  readonly slipped = [false, false, false, false];
  readonly lead = [0, 0, 0, 0];

  /** Rope coordinate under each holding hand: along − hauled at grab time. */
  private grip = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  private prevAlong = [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  private prevAt = [0, 0, 0, 0];
  private handSpeed = [0, 0, 0, 0];
  private stroking = [false, false];
  private strokeHand = [-1, -1];
  private grabAt = [0, 0, 0, 0];
  private slipAt = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  private canStroke = [false, false, false, false];
  private strokeStart = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  private times = new Float64Array(HISTORY);
  private positions = new Float64Array(HISTORY);
  private next = 0;
  private count = 0;

  constructor(params: RopeParams = DEFAULT_ROPE) {
    this.params = params;
  }

  /** Where the line was at local time `ms`. */
  hauledAt(ms: number): number {
    if (this.count === 0) {
      return this.hauled;
    }
    const newest = (this.next - 1 + HISTORY) % HISTORY;
    if (ms >= this.times[newest]) {
      return this.positions[newest];
    }
    for (let i = 1; i < this.count; i++) {
      const b = (newest - i + 1 + HISTORY) % HISTORY;
      const a = (newest - i + HISTORY) % HISTORY;
      if (ms >= this.times[a]) {
        const t = (ms - this.times[a]) / (this.times[b] - this.times[a] || 1);
        return this.positions[a] + (this.positions[b] - this.positions[a]) * t;
      }
    }
    return this.positions[(newest - this.count + 1 + HISTORY) % HISTORY];
  }

  step(dt: number, nowMs: number, hands: readonly RopeHandInput[]): void {
    const p = this.params;
    let force = 0;
    for (let player = 0; player < 2; player++) {
      let playerForce = 0;
      for (let side = 0; side < 2; side++) {
        const i = player * 2 + side;
        const hand = hands[i];
        this.slipped[i] = false;
        if (!hand?.holding) {
          this.grip[i] = Number.NaN;
          this.prevAlong[i] = Number.NaN;
          this.lead[i] = 0;
          continue;
        }
        const lineThen = this.hauledAt(hand.atMs);
        if (Number.isNaN(this.grip[i])) {
          // A fresh grab: hold the bit of rope under the hand. It may start a stroke,
          // unless the line has just slipped through this hand (catching it again
          // mid-pull isn't a new stroke).
          this.grip[i] = hand.along - lineThen;
          this.handSpeed[i] = 0;
          this.grabAt[i] = hand.atMs;
          this.canStroke[i] = hand.atMs - this.slipAt[i] > SLIP_REGRAB_MS;
        }
        if (!Number.isNaN(this.prevAlong[i]) && hand.atMs > this.prevAt[i]) {
          const v = (hand.along - this.prevAlong[i]) / ((hand.atMs - this.prevAt[i]) / 1000);
          this.handSpeed[i] += (v - this.handSpeed[i]) * 0.5;
        }
        if (Number.isNaN(this.prevAlong[i]) || hand.atMs > this.prevAt[i]) {
          this.prevAlong[i] = hand.along;
          this.prevAt[i] = hand.atMs;
        }
        const lead = hand.along - this.grip[i] - lineThen;
        this.lead[i] = lead;
        if (Math.abs(lead) > p.slipDistance) {
          this.slipped[i] = true;
          this.slipAt[i] = hand.atMs;
          this.grip[i] = Number.NaN;
          this.prevAlong[i] = Number.NaN;
          if (this.strokeHand[player] === i) this.strokeHand[player] = -1;
          continue;
        }
        playerForce += p.stiffness * lead + p.handDamping * (this.handSpeed[i] - this.speed);
        // Strokes: each grab can start one stroke, when the hand first pulls inboard
        // briskly, timed by when the hand did it.
        if (this.canStroke[i] && this.handSpeed[i] > p.strokeStartSpeed && hand.atMs - this.grabAt[i] < STROKE_GRAB_MS) {
          this.canStroke[i] = false;
          this.strokeHand[player] = i;
          this.strokeStart[player] = hand.atMs;
        }
        if (this.strokeHand[player] === i && this.handSpeed[i] < p.strokeEndSpeed && hand.atMs - this.strokeStart[player] > 100) {
          this.strokeHand[player] = -1;
        }
      }
      // A stroke ends when its hand lets go.
      const sh = this.strokeHand[player];
      if (sh >= 0 && !hands[sh]?.holding) {
        this.strokeHand[player] = -1;
      }
      this.stroking[player] = this.strokeHand[player] >= 0;
      const max = p.maxPlayerForce * (this.heave ? p.heaveBoost : 1);
      force += Math.max(-max, Math.min(max, playerForce));
    }

    const together = this.stroking[0] && this.stroking[1] && Math.abs(this.strokeStart[0] - this.strokeStart[1]) <= p.syncWindowMs;
    if (together && !this.heave) {
      this.heaves++;
    }
    this.heave = together;

    if (!this.docked) {
      const net = force - p.load - p.damping * this.speed;
      this.speed += (net / p.mass) * dt;
      this.hauled += this.speed * dt;
      if (this.hauled <= 0) {
        this.hauled = 0;
        this.speed = Math.max(0, this.speed);
      }
      if (this.hauled >= p.length) {
        this.hauled = p.length;
        this.speed = 0;
        this.docked = true;
      }
    }

    this.times[this.next] = nowMs;
    this.positions[this.next] = this.hauled;
    this.next = (this.next + 1) % HISTORY;
    this.count = Math.min(this.count + 1, HISTORY);
  }

  /** Follow an authoritative state (the guest following the host). */
  blendToward(hauled: number, speed: number, rate: number): void {
    const error = hauled - this.hauled;
    if (Math.abs(error) > 0.5) {
      this.hauled = hauled;
      this.speed = speed;
    } else {
      this.hauled += error * rate;
      this.speed += (speed - this.speed) * rate;
    }
  }

  reset(): void {
    this.hauled = 0;
    this.speed = 0;
    this.heave = false;
    this.heaves = 0;
    this.docked = false;
    this.count = 0;
    this.next = 0;
    this.stroking = [false, false];
    this.strokeHand = [-1, -1];
    this.grip.fill(Number.NaN);
    this.prevAlong.fill(Number.NaN);
  }
}
