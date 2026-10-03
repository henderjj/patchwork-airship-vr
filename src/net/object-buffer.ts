import { createPoseSample, type PoseSample } from './pose-codec.js';
import { copyPose, lerpPose } from './pose-buffer.js';

/**
 * Jitter buffer for one object the crewmate owns (spike S7): timestamped
 * poses, sampled a little in the past like the crewmate's avatar so a thrown
 * object leaves their drawn hand at the right moment. Before the first pose
 * it holds the oldest; past the newest it extrapolates up to 50 ms, then
 * holds. Pure TypeScript; allocation free after construction.
 */

const CAPACITY = 24;
const MAX_EXTRAPOLATION_MS = 50;
const CLOCK_JUMP_MS = 250;
/** Poses used to estimate a thrown object's flight. */
const FIT_WINDOW_MS = 120;

export class ObjectBuffer {
  private times = new Float64Array(CAPACITY);
  private flags = new Uint8Array(CAPACITY);
  private poses: PoseSample[] = [];
  private next = 0;
  private fit = new Float64Array(6);
  private sums = new Float64Array(6);
  count = 0;

  constructor() {
    for (let i = 0; i < CAPACITY; i++) {
      this.poses.push(createPoseSample());
    }
  }

  /**
   * Add a pose stamped with local-clock time. Out-of-order poses are dropped;
   * one far older than the newest means the clock estimate moved back, so the
   * buffer starts again rather than dropping everything until it catches up.
   */
  push(localTimeMs: number, pose: PoseSample, flags: number): void {
    const newestTime = this.newestTime();
    if (localTimeMs < newestTime - CLOCK_JUMP_MS) {
      this.clear();
    } else if (localTimeMs <= newestTime) {
      return;
    }
    this.times[this.next] = localTimeMs;
    this.flags[this.next] = flags;
    copyPose(pose, this.poses[this.next]);
    this.next = (this.next + 1) % CAPACITY;
    this.count = Math.min(this.count + 1, CAPACITY);
  }

  /**
   * Sample at `renderTimeMs`; returns the flags of the nearest earlier pose,
   * or -1 if empty. With `gravity` (m/s²), a time past the newest pose is
   * extrapolated as free flight for up to `maxAheadMs`, for drawing a thrown
   * object ahead of the latest packet.
   */
  sample(renderTimeMs: number, out: PoseSample, gravity?: readonly number[], maxAheadMs = MAX_EXTRAPOLATION_MS): number {
    if (this.count === 0) {
      return -1;
    }
    const newest = (this.next - 1 + CAPACITY) % CAPACITY;
    const oldest = (this.next - this.count + CAPACITY) % CAPACITY;
    if (renderTimeMs <= this.times[oldest]) {
      copyPose(this.poses[oldest], out);
      return this.flags[oldest];
    }
    for (let i = 0; i < this.count - 1; i++) {
      const a = (oldest + i) % CAPACITY;
      const b = (a + 1) % CAPACITY;
      if (renderTimeMs <= this.times[b]) {
        lerpPose(this.poses[a], this.poses[b], (renderTimeMs - this.times[a]) / (this.times[b] - this.times[a]), out);
        return this.flags[a];
      }
    }
    if (this.count >= 2) {
      const prev = (newest - 1 + CAPACITY) % CAPACITY;
      const span = this.times[newest] - this.times[prev];
      // Hold still objects rather than extrapolating across a keep-alive gap.
      if (span > 0 && span < 100) {
        const ahead = Math.min(renderTimeMs - this.times[newest], maxAheadMs);
        lerpPose(this.poses[prev], this.poses[newest], 1 + ahead / span, out);
        if (gravity && this.flightFit(newest, gravity)) {
          // Free flight: fit p − ½g(t − tₙ)² = a + b(t − tₙ) to the recent
          // poses (one pair of uneven frame times would make the velocity,
          // and so a long extrapolation, wobble), then carry the parabola on.
          const tau = ahead / 1000;
          const g = 0.5 * tau * tau;
          out.px = this.fit[0] + this.fit[3] * tau + gravity[0] * g;
          out.py = this.fit[1] + this.fit[4] * tau + gravity[1] * g;
          out.pz = this.fit[2] + this.fit[5] * tau + gravity[2] * g;
        }
        return this.flags[newest];
      }
    }
    copyPose(this.poses[newest], out);
    return this.flags[newest];
  }

  /**
   * Least-squares fit over the free-flight poses (flags 0) of the last
   * FIT_WINDOW_MS before `newest`: intercept (position at the newest time) in
   * fit[0..2] and velocity (m/s) in fit[3..5]. False if fewer than 3 poses.
   */
  private flightFit(newest: number, gravity: readonly number[]): boolean {
    const tn = this.times[newest];
    let n = 0, st = 0, stt = 0;
    const sp = this.sums;
    sp.fill(0);
    for (let i = 0; i < this.count; i++) {
      const k = (newest - i + CAPACITY) % CAPACITY;
      const dt = (this.times[k] - tn) / 1000;
      if (dt < -FIT_WINDOW_MS / 1000 || this.flags[k] !== 0) {
        break;
      }
      const g = 0.5 * dt * dt;
      const p = this.poses[k];
      const x = p.px - gravity[0] * g, y = p.py - gravity[1] * g, z = p.pz - gravity[2] * g;
      n++; st += dt; stt += dt * dt;
      sp[0] += x; sp[1] += y; sp[2] += z;
      sp[3] += dt * x; sp[4] += dt * y; sp[5] += dt * z;
    }
    const denom = n * stt - st * st;
    if (n < 3 || denom <= 1e-12) {
      return false;
    }
    for (let a = 0; a < 3; a++) {
      const slope = (n * sp[3 + a] - st * sp[a]) / denom;
      this.fit[3 + a] = slope;
      this.fit[a] = (sp[a] - slope * st) / n;
    }
    return true;
  }

  /** Local time of the oldest pose, or NaN. */
  oldestTime(): number {
    return this.count ? this.times[(this.next - this.count + CAPACITY) % CAPACITY] : Number.NaN;
  }

  /** Local time of the newest pose, or NaN. */
  newestTime(): number {
    return this.count ? this.times[(this.next - 1 + CAPACITY) % CAPACITY] : Number.NaN;
  }

  clear(): void {
    this.count = 0;
    this.next = 0;
  }
}
