/**
 * Estimates a held object's velocity at release from its recent positions.
 * Allocation free after construction. Pure TypeScript.
 */

const SAMPLES = 16;
/** Look back this far (ms) when estimating velocity. */
export const RELEASE_WINDOW_MS = 80;
/** Throws faster than this (m/s) are clamped; nobody throws a brick at 15 m/s. */
export const MAX_THROW_SPEED = 12;

export class ReleaseVelocityTracker {
  private t = new Float64Array(SAMPLES);
  private x = new Float64Array(SAMPLES);
  private y = new Float64Array(SAMPLES);
  private z = new Float64Array(SAMPLES);
  private next = 0;
  private count = 0;

  reset(): void {
    this.next = 0;
    this.count = 0;
  }

  push(timeMs: number, x: number, y: number, z: number): void {
    this.t[this.next] = timeMs;
    this.x[this.next] = x;
    this.y[this.next] = y;
    this.z[this.next] = z;
    this.next = (this.next + 1) % SAMPLES;
    this.count = Math.min(this.count + 1, SAMPLES);
  }

  /**
   * Least-squares slope of position over the last RELEASE_WINDOW_MS, which is
   * steadier than a two-point difference when frame times are uneven.
   * Writes m/s into `out`; zero when there is too little history.
   */
  velocity(out: [number, number, number]): void {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    if (this.count < 2) {
      return;
    }
    const newest = (this.next - 1 + SAMPLES) % SAMPLES;
    const tEnd = this.t[newest];
    let n = 0;
    let st = 0;
    let stt = 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let stx = 0;
    let sty = 0;
    let stz = 0;
    for (let i = 0; i < this.count; i++) {
      const k = (newest - i + SAMPLES) % SAMPLES;
      const dt = (this.t[k] - tEnd) / 1000;
      if (dt < -RELEASE_WINDOW_MS / 1000 && n >= 2) {
        break;
      }
      n++;
      st += dt;
      stt += dt * dt;
      sx += this.x[k];
      sy += this.y[k];
      sz += this.z[k];
      stx += dt * this.x[k];
      sty += dt * this.y[k];
      stz += dt * this.z[k];
    }
    const denom = n * stt - st * st;
    if (n < 2 || denom <= 1e-12) {
      return;
    }
    out[0] = (n * stx - st * sx) / denom;
    out[1] = (n * sty - st * sy) / denom;
    out[2] = (n * stz - st * sz) / denom;
    const speed = Math.hypot(out[0], out[1], out[2]);
    if (speed > MAX_THROW_SPEED) {
      const s = MAX_THROW_SPEED / speed;
      out[0] *= s;
      out[1] *= s;
      out[2] *= s;
    }
  }
}
