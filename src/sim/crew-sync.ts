/**
 * Cues that help two players keep the crank and the mooring line in step
 * (src/systems/crank-system.ts, src/systems/rope-system.ts). Hands are drawn
 * locked onto the handles and the line, so neither player can see who is
 * pushing harder or lagging, and controllers can't push back like a real
 * handle. These turn the simulations' numbers into things to see, feel and
 * hear. Engine-free, so they are unit tested; nothing here changes the
 * rules for high gear or a heave.
 */

/**
 * How long ahead a hand's lead over its handle counts towards its pace, s:
 * a hand 0.3 rad ahead of its handle is going for 1 rad/s more than the
 * crank is turning now.
 */
export const PACE_LEAD_S = 0.3;

/**
 * The pace a hand on the crank is going for, turns/s in the crank's
 * direction (`dir` +1 ahead, -1 astern): the crank's speed now plus how far
 * the hand leads its handle. The crank is one piece, so both handles turn
 * at its speed, but a hand pushing harder leads further and is going for a
 * faster pace. Two hands going for the same pace lead by the same amount,
 * which is what puts the crank in step.
 */
export function crankPace(lead: number, omega: number, dir: number): number {
  return (dir * (omega + lead / PACE_LEAD_S)) / (2 * Math.PI);
}

/**
 * How far apart two hands' paces may be and still be in step, turns/s: the
 * crank's 150 ms sync window, turned into pace at the crank's speed now.
 */
export function paceWindow(omega: number, syncWindowMs: number): number {
  return ((syncWindowMs / 1000) * Math.max(Math.abs(omega), 0.5)) / PACE_LEAD_S / (2 * Math.PI);
}

/** The pace target, turns/s: an easy pace to find the step at, rising to a sprint while the pair stays in step. */
export const TARGET_START = 0.45;
export const TARGET_SPRINT = 1.3;
/** How fast the target rises while the pair is in step, and falls back while they aren't, turns/s per s. */
const TARGET_RISE = 0.15;
const TARGET_FALL = 0.5;
/** The target only falls once the pair has been out of step this long, s (a wobble doesn't reset it). */
const TARGET_GRACE_S = 1;

/**
 * The pace both players aim for. Chasing each other's pace is hard because
 * each correction moves the thing the other is aiming at, so the sign gives
 * both one target: an easy pace to fall into step, which then climbs
 * towards a sprint as long as they stay in step, and drops back if they
 * fall out of step for more than a second.
 */
export class PaceTarget {
  /** The target, turns/s. */
  pace = TARGET_START;
  private outFor = 0;

  /** Advance by `dt` s with whether the pair is in step. */
  step(dt: number, inStep: boolean): void {
    if (inStep) {
      this.outFor = 0;
      this.pace = Math.min(TARGET_SPRINT, this.pace + TARGET_RISE * dt);
      return;
    }
    this.outFor += dt;
    if (this.outFor > TARGET_GRACE_S) {
      this.pace = Math.max(TARGET_START, this.pace - TARGET_FALL * dt);
    }
  }

  reset(): void {
    this.pace = TARGET_START;
    this.outFor = 0;
  }
}

export type CrankAdvice = 'even' | 'push' | 'ease';

/** A pace this far (as a fraction of the window) from the target starts advice; it stops again inside the smaller one. */
const ADVICE_ON = 0.6;
const ADVICE_OFF = 0.4;

/**
 * What to tell a player from how far their (smoothed) pace is from the
 * target (`offset`, positive when faster) and the window it should be
 * within: push harder when slower, ease off when faster, with a little
 * hysteresis so the advice doesn't flicker at the edge.
 */
export function crankAdvice(offset: number, window: number, previous: CrankAdvice): CrankAdvice {
  const on = ADVICE_ON * window;
  const off = ADVICE_OFF * window;
  if (offset > on || (previous === 'ease' && offset > off)) return 'ease';
  if (offset < -on || (previous === 'push' && offset < -off)) return 'push';
  return 'even';
}

/** How hard a hand pulls on the line, 0 to 1 (1 where the line slips through it). */
export function lineTension(lead: number, slipDistance: number): number {
  return Math.max(0, Math.min(1, lead / slipDistance));
}

/**
 * Buzz strength for a hand holding the line, 0 to 1: nothing while it lies
 * slack, a faint creak while it runs, growing with how hard the hand pulls and steeply near the
 * point it slips. When the crewmate pulls too, the line comes in faster,
 * the hand gets less far ahead of it, and the buzz eases: the line "goes
 * light", as it does on a real haul.
 */
export function ropeBuzz(tension: number, lineSpeed: number): number {
  const buzz = 0.12 * Math.min(1, Math.abs(lineSpeed)) + 0.8 * tension * tension;
  // A slack line lying still in the hand doesn't buzz at all.
  return buzz < 0.03 ? 0 : Math.min(1, 0.05 + buzz);
}

/**
 * Time to the line's next creak through the fairlead, ms, under the
 * hardest pull on it (`tension`, 0 to 1) with the line running at
 * `lineSpeed` (m/s), or NaN when it isn't straining enough to creak: it
 * creaks while it runs under a firm pull, or even standing still near the
 * point it slips, faster the harder it is pulled.
 */
export function lineCreakGapMs(tension: number, lineSpeed: number): number {
  const straining = tension > 0.45 && (Math.abs(lineSpeed) > 0.03 || tension > 0.7);
  return straining ? 700 - 400 * Math.min(1, tension) : Number.NaN;
}

/** Time between the haul call's heaves, ms: pull on the beat, reach forward on the off-beat. */
export const HAUL_CALL_PERIOD_MS = 1000;
/** The call keeps going this long after one of the pair lets go of the line, ms (between strokes). */
export const HAUL_CALL_LINGER_MS = 2500;

export type HaulBeat = 'heave' | 'reach';

/** Where the haul call is at `clockMs` on the shared clock: the heave's number and how far past it, 0 to 1. */
export function haulCallPhase(clockMs: number, periodMs = HAUL_CALL_PERIOD_MS): { index: number; phase: number } {
  const index = Math.floor(clockMs / periodMs);
  return { index, phase: clockMs / periodMs - index };
}

/** How far `clockMs` on the shared clock is past the call's last heave, 0 to 1 (no allocation, for every frame). */
export function haulCallFraction(clockMs: number, periodMs = HAUL_CALL_PERIOD_MS): number {
  return (((clockMs % periodMs) + periodMs) % periodMs) / periodMs;
}

/** Time from `clockMs` on the shared clock to the call's next heave, ms (0 on a heave). */
export function msToNextHeave(clockMs: number, periodMs = HAUL_CALL_PERIOD_MS): number {
  const into = ((clockMs % periodMs) + periodMs) % periodMs;
  return into === 0 ? 0 : periodMs - into;
}

/**
 * The haul call: a steady "heave" beat while both players are at the line.
 * It keeps time on the host's clock (heaves at whole multiples of the
 * period), which both players share through clock sync, so each hears the
 * heave at the same moment whatever the network delay, and starting a
 * stroke on it lands both strokes inside the heave's 150 ms window.
 */
export class HaulCall {
  /** The call is sounding. */
  running = false;
  private lastBothMs = Number.NEGATIVE_INFINITY;
  private lastHalf = Number.NaN;

  constructor(
    readonly periodMs = HAUL_CALL_PERIOD_MS,
    readonly lingerMs = HAUL_CALL_LINGER_MS,
  ) {}

  /**
   * Advance to local time `nowMs`, shared-clock time `clockMs`, with whether
   * both players have a hand on the line. Returns the beat this frame
   * crossed, if any. A call that has just started waits for its next beat.
   */
  update(nowMs: number, clockMs: number, bothAtLine: boolean): HaulBeat | null {
    if (bothAtLine) {
      this.lastBothMs = nowMs;
    }
    const was = this.running;
    this.running = nowMs - this.lastBothMs < this.lingerMs;
    const half = Math.floor((2 * clockMs) / this.periodMs);
    const crossed = this.running && was && half !== this.lastHalf;
    this.lastHalf = half;
    if (!crossed) {
      return null;
    }
    return ((half % 2) + 2) % 2 === 0 ? 'heave' : 'reach';
  }

  stop(): void {
    this.running = false;
    this.lastBothMs = Number.NEGATIVE_INFINITY;
  }
}

/** Brightness of the haul call's lamp, 0 to 1, `phase` (0 to 1) past a heave: a flash on the heave, fading, then building towards the next. */
export function callLampLevel(phase: number): number {
  return Math.max(Math.exp(-phase * 9), 0.35 * phase * phase);
}
