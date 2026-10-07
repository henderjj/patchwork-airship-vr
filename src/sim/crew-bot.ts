/**
 * The practice crewmate's sums: a bot that plays the second player so one
 * person can test the two-player parts of the game (src/systems/crew-bot-system.ts).
 * Engine-free, so it can be unit tested.
 */

/** Gravity in ship space, m/s² (the ship's own accelerations are small next to it). */
export const BOT_GRAVITY = 9.81;
/** How far the bot reaches from its resting hand to meet a brick, m. */
export const CATCH_REACH = 0.7;
/** How far ahead a flying brick's path is followed, s. */
const LOOKAHEAD_S = 1.2;
const LOOKAHEAD_STEP_S = 0.02;

type Vec3 = [number, number, number];

/**
 * The bot's hand angle on the other crank handle, which sits half a turn from
 * the player's. It copies the player's hand as last drawn, moved on by the
 * crank's speed over the time since, so both hands lead their handles by the
 * same amount: in step.
 */
export function crankFollowAngle(playerAngle: number, omega: number, ageMs: number): number {
  return playerAngle + Math.PI + (omega * Math.max(0, ageMs)) / 1000;
}

/**
 * Where along the line the bot's hand goes, for a player's hand at `along`
 * moving at `speed` (m/s) `ageMs` ago: the same stroke, `offset` metres away
 * so the two pairs of hands don't overlap. Clamped to the line's run.
 */
export function ropeFollowAlong(along: number, speed: number, ageMs: number, offset: number, run: number): number {
  return Math.min(run, Math.max(0, along + offset + (speed * Math.max(0, ageMs)) / 1000));
}

/** Which way the bot's hand sits from the player's on the line: towards the end with more room. */
export function ropeOffset(along: number, run: number, gap = 0.6): number {
  return along < run / 2 ? gap : -gap;
}

/**
 * Where to put a hand to meet a flying brick at `pos` moving at `vel`: the
 * point of its falling path closest to `rest`, if that is within `reach`.
 * Writes the point to `out` and returns true, or returns false when the
 * brick won't pass close enough.
 */
export function interceptPoint(pos: Vec3, vel: Vec3, rest: Vec3, out: Vec3, reach = CATCH_REACH): boolean {
  let best = Number.POSITIVE_INFINITY;
  for (let t = 0; t <= LOOKAHEAD_S; t += LOOKAHEAD_STEP_S) {
    const x = pos[0] + vel[0] * t;
    const y = pos[1] + vel[1] * t - 0.5 * BOT_GRAVITY * t * t;
    const z = pos[2] + vel[2] * t;
    const d = Math.hypot(x - rest[0], y - rest[1], z - rest[2]);
    if (d < best) {
      best = d;
      out[0] = x;
      out[1] = y;
      out[2] = z;
    }
  }
  return best <= reach;
}

/** Launch velocity that carries a brick from `from` to `to` in `flightS` seconds under gravity. */
export function throwVelocity(from: Vec3, to: Vec3, flightS: number, out: Vec3): Vec3 {
  out[0] = (to[0] - from[0]) / flightS;
  out[1] = (to[1] - from[1]) / flightS + 0.5 * BOT_GRAVITY * flightS;
  out[2] = (to[2] - from[2]) / flightS;
  return out;
}

/** A gentle flight time for a throw over `distance` metres, s. */
export function throwFlightTime(distance: number): number {
  return Math.min(0.8, Math.max(0.4, distance / 4));
}

/** Move `from` towards `to` by at most `maxStep`, in place; returns the distance left. */
export function stepTowards(from: Vec3, to: Vec3, maxStep: number): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const d = Math.hypot(dx, dy, dz);
  if (d <= maxStep || d === 0) {
    from[0] = to[0];
    from[1] = to[1];
    from[2] = to[2];
    return 0;
  }
  const k = maxStep / d;
  from[0] += dx * k;
  from[1] += dy * k;
  from[2] += dz * k;
  return d - maxStep;
}

type Side = 'left' | 'right';

interface HandTrack {
  held: boolean;
  stroking: boolean;
  /** Furthest-out point since the grab, m: where the stroke starts. */
  start: number;
  startAtMs: number;
  along: number;
  atMs: number;
  /** Inboard speed, m/s. */
  speed: number;
  offset: number;
}

const newTrack = (): HandTrack => ({ held: false, stroking: false, start: 0, startAtMs: 0, along: 0, atMs: 0, speed: 0, offset: 0 });

/** How far a hand must move inboard before it counts as stroking, m. */
const STROKE_START = 0.01;
/** How fast the bot's free hand reaches forward along the line for its next stroke, m/s. */
const REACH_SPEED = 3;
/**
 * The bot takes hold this long before each stroke, as a person does before
 * pulling, so the player's game has seen the grab by the time the hand moves.
 */
const TAKE_HOLD_MS = 100;

/**
 * The practice crewmate's half of hauling the mooring line hand over hand.
 * A heave needs both players' strokes to start within 150 ms, but the bot
 * only sees the player's hand a network delay late. So, as a crew does, it
 * keeps time: once it has seen two of the player's strokes it knows their
 * rhythm, and starts each of its own strokes when the player's next one is
 * due, with the same length and duration, beside the player's hands. Until
 * then (and when the rhythm breaks) it copies each stroke as it sees it.
 */
export class HaulRhythm {
  readonly hands: Record<Side, HandTrack> = { left: newTrack(), right: newTrack() };
  /** Time between the player's stroke starts, ms (0 until two have been seen). */
  period = 0;
  /** When the player's last stroke started, ms. */
  lastStartMs = Number.NEGATIVE_INFINITY;
  strokeLength = 0.5;
  strokeMs = 450;
  /** The bot's own stroke under the rhythm. */
  botStartMs = Number.NEGATIVE_INFINITY;
  botSide: Side = 'right';
  private botBase = 0;
  private lastBase = 0;
  /** Where and when each of the bot's hands last let go, to reach forward from. */
  private botEnd: Record<Side, { along: number; atMs: number }> = {
    left: { along: 0, atMs: Number.NEGATIVE_INFINITY },
    right: { along: 0, atMs: Number.NEGATIVE_INFINITY },
  };

  constructor(private readonly run: number) {}

  /** The player's `side` hand as drawn at `atMs`: holding the line at `along`, or not. */
  observe(side: Side, holding: boolean, along: number, atMs: number): void {
    const h = this.hands[side];
    if (!holding) {
      if (h.stroking && atMs > h.startAtMs) {
        this.strokeLength += (Math.min(0.8, Math.max(0.2, h.along - h.start)) - this.strokeLength) * 0.5;
        this.strokeMs += (Math.min(1500, Math.max(200, h.atMs - h.startAtMs)) - this.strokeMs) * 0.5;
      }
      h.held = false;
      h.stroking = false;
      return;
    }
    if (!h.held) {
      h.held = true;
      h.stroking = false;
      h.start = along;
      h.speed = 0;
    } else if (!h.stroking) {
      // The drawn hand can still be sliding back from the last stroke's end
      // to this grab: the stroke starts from the furthest-out point, once
      // the hand moves inboard from it.
      h.start = Math.min(h.start, along);
      const threshold = h.start + STROKE_START;
      if (along > threshold) {
        h.stroking = true;
        // When the hand passed the threshold, between this pose and the last
        // (a slow frame rate would otherwise make every start late).
        const startAt = h.atMs < atMs && h.along <= threshold ? h.atMs + ((threshold - h.along) / (along - h.along)) * (atMs - h.atMs) : atMs;
        h.startAtMs = startAt;
        h.offset = ropeOffset(h.start, this.run);
        this.lastBase = h.start;
        const interval = startAt - this.lastStartMs;
        if (interval > 250 && interval < 2000) {
          this.period = this.period > 0 ? this.period + (interval - this.period) * 0.5 : interval;
        }
        this.lastStartMs = startAt;
      }
    } else if (atMs > h.atMs) {
      // Inboard speed only, to carry the hand on between drawn poses.
      const speed = Math.max(0, ((along - h.along) * 1000) / (atMs - h.atMs));
      h.speed += (speed - h.speed) * 0.5;
    }
    h.along = along;
    h.atMs = atMs;
  }

  /** The player is hauling to a rhythm the bot can keep. */
  rhythmic(nowMs: number): boolean {
    return this.period > 0 && nowMs - this.lastStartMs < 2.5 * this.period;
  }

  /** Start the bot's next stroke when the player's is due. Call once a frame. */
  update(nowMs: number): void {
    if (!this.rhythmic(nowMs)) {
      return;
    }
    const due = this.lastStartMs + this.period;
    if (nowMs >= due - TAKE_HOLD_MS && due > this.botStartMs + this.period / 2) {
      const end = this.botEnd[this.botSide];
      end.along = this.botBase + this.strokeLength;
      end.atMs = this.botStartMs + this.botStrokeMs();
      this.botStartMs = due;
      this.botSide = this.botSide === 'left' ? 'right' : 'left';
      this.botBase = this.nextBase();
    }
  }

  /** Where the bot's next stroke starts: beside the player's last one. */
  private nextBase(): number {
    return Math.min(this.run - this.strokeLength, Math.max(0, this.lastBase + ropeOffset(this.lastBase, this.run)));
  }

  private botStrokeMs(): number {
    return Math.min(this.strokeMs, 0.95 * this.period);
  }

  /**
   * Where the bot's `side` hand waits while it isn't holding: reaching
   * forward from where it let go to where its next stroke starts, so it
   * takes hold without a jump. Null leaves the hand where it let go.
   */
  botRest(side: Side, nowMs: number): number | null {
    if (!this.rhythmic(nowMs)) {
      return null;
    }
    const end = this.botEnd[side];
    if (end.atMs === Number.NEGATIVE_INFINITY) {
      return this.nextBase();
    }
    const target = this.nextBase();
    const d = target - end.along;
    const step = (REACH_SPEED * Math.max(0, nowMs - end.atMs)) / 1000;
    return Math.abs(d) <= step ? target : end.along + Math.sign(d) * step;
  }

  /** Where the bot's `side` hand holds the line at `nowMs`, m, or null when it isn't holding. */
  botAlong(side: Side, nowMs: number): number | null {
    if (this.rhythmic(nowMs)) {
      if (side !== this.botSide) {
        return null;
      }
      const phase = (nowMs - this.botStartMs) / this.botStrokeMs();
      if (phase > 1 || nowMs < this.botStartMs - TAKE_HOLD_MS) {
        return null;
      }
      return this.botBase + (this.strokeLength * (1 - Math.cos(Math.PI * Math.max(0, phase)))) / 2;
    }
    const h = this.hands[side];
    return h.stroking ? ropeFollowAlong(h.along, h.speed, nowMs - h.atMs, h.offset, this.run) : null;
  }
}
