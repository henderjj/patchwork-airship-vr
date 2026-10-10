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
 * How far this player's crank hand leads the crewmate's, ms: positive when
 * this player pushes harder (their hand further ahead of its handle),
 * negative when the crewmate does and the crank is pulling this player's
 * handle away from their hand. Same measure as the crank's sync offset
 * (src/sim/crank.ts), with a sign.
 */
export function crankBalanceMs(myLead: number, theirLead: number, omega: number): number {
  const dir = omega >= 0 ? 1 : -1;
  const speed = Math.max(Math.abs(omega), 0.5);
  return (((myLead - theirLead) * dir) / speed) * 1000;
}

export type CrankAdvice = 'even' | 'push' | 'ease';

/** A balance this far out of the sync window's fraction starts advice; it stops again inside the smaller one. */
const ADVICE_ON = 0.6;
const ADVICE_OFF = 0.4;

/**
 * What to tell a player from their (smoothed) crank balance: push harder
 * when the crewmate leads, ease off when they lead, with a little
 * hysteresis so the advice doesn't flicker at the edge. It starts well
 * inside the sync window, so a pair hears about drifting apart before
 * they fall out of high gear.
 */
export function crankAdvice(balanceMs: number, windowMs: number, previous: CrankAdvice): CrankAdvice {
  const on = ADVICE_ON * windowMs;
  const off = ADVICE_OFF * windowMs;
  if (balanceMs > on || (previous === 'ease' && balanceMs > off)) return 'ease';
  if (balanceMs < -on || (previous === 'push' && balanceMs < -off)) return 'push';
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
