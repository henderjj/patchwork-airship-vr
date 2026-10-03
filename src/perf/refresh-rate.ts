/**
 * Display refresh rate from measured frame intervals (spike S8). Over Meta
 * Horizon Link the refresh rate is set in the Link app on the PC, and desktop
 * Chrome and Edge may not report `frameRate`, so the perf HUD's budget and
 * dropped-frame count fall back to this.
 *
 * Uses the median interval, so occasional dropped frames don't move it, and
 * snaps to a common headset rate when one is within 6% (frame timestamps
 * jitter by a millisecond or so). If Link's Asynchronous SpaceWarp is halving
 * the app's rate, this reads the halved rate (45 at 90 Hz), which is what the
 * app is really getting.
 */

const COMMON_RATES = [60, 72, 80, 90, 120, 144];
const MIN_SAMPLES = 30;

/** Sorts `intervalsMs[0..count)` in place. Null until there are enough samples. */
export function estimateRefreshHz(intervalsMs: Float32Array, count: number): number | null {
  if (count < MIN_SAMPLES) {
    return null;
  }
  const sorted = intervalsMs.subarray(0, count).sort();
  const median = sorted[Math.floor(count / 2)];
  if (!(median > 0)) {
    return null;
  }
  const hz = 1000 / median;
  for (const rate of COMMON_RATES) {
    if (Math.abs(hz - rate) / rate < 0.06) {
      return rate;
    }
  }
  return Math.round(hz);
}
