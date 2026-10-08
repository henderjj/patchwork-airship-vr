import { copyCurls, type FingerCurls } from '../sim/hand-pose.js';
import { type AvatarPose, createAvatarPose, type PoseSample } from './pose-codec.js';

/**
 * Jitter buffer for a remote avatar: stores timestamped poses and samples them
 * a little in the past, interpolating between the two surrounding snapshots so
 * the remote player moves smoothly despite uneven packet arrival. Briefly
 * extrapolates (up to 50 ms) when packets are late, then holds. Pure
 * TypeScript; allocation free after construction.
 */

const CAPACITY = 32;
const MAX_EXTRAPOLATION_MS = 50;

export class PoseBuffer {
  private times = new Float64Array(CAPACITY);
  private poses: AvatarPose[] = [];
  private next = 0;
  count = 0;
  /** Samples that had to extrapolate or hold because packets were late (for tuning the delay). */
  late = 0;

  constructor() {
    for (let i = 0; i < CAPACITY; i++) {
      this.poses.push(createAvatarPose());
    }
  }

  /** Add a pose stamped with local-clock time. Out-of-order packets are dropped. */
  push(localTimeMs: number, pose: AvatarPose): void {
    if (this.count > 0 && localTimeMs <= this.times[(this.next - 1 + CAPACITY) % CAPACITY]) {
      return;
    }
    this.times[this.next] = localTimeMs;
    copyAvatar(pose, this.poses[this.next]);
    this.next = (this.next + 1) % CAPACITY;
    this.count = Math.min(this.count + 1, CAPACITY);
  }

  /** Time of the newest pose, or NaN. */
  newestTime(): number {
    return this.count ? this.times[(this.next - 1 + CAPACITY) % CAPACITY] : Number.NaN;
  }

  /**
   * Sample at `renderTimeMs` (local clock, typically now − delay). Returns
   * false if empty.
   */
  sample(renderTimeMs: number, out: AvatarPose): boolean {
    if (this.count === 0) {
      return false;
    }
    const newest = (this.next - 1 + CAPACITY) % CAPACITY;
    const oldest = (this.next - this.count + CAPACITY) % CAPACITY;
    if (renderTimeMs <= this.times[oldest]) {
      copyAvatar(this.poses[oldest], out);
      return true;
    }
    for (let i = 0; i < this.count - 1; i++) {
      const a = (oldest + i) % CAPACITY;
      const b = (a + 1) % CAPACITY;
      if (renderTimeMs <= this.times[b]) {
        const t = (renderTimeMs - this.times[a]) / (this.times[b] - this.times[a]);
        lerpAvatar(this.poses[a], this.poses[b], t, out);
        return true;
      }
    }
    // Past the newest pose: extrapolate a little from the last two, then hold.
    this.late++;
    if (this.count >= 2) {
      const prev = (newest - 1 + CAPACITY) % CAPACITY;
      const span = this.times[newest] - this.times[prev];
      const ahead = Math.min(renderTimeMs - this.times[newest], MAX_EXTRAPOLATION_MS);
      if (span > 0) {
        lerpAvatar(this.poses[prev], this.poses[newest], 1 + ahead / span, out);
        return true;
      }
    }
    copyAvatar(this.poses[newest], out);
    return true;
  }

  clear(): void {
    this.count = 0;
    this.next = 0;
  }
}

export function copyPose(a: PoseSample, out: PoseSample): void {
  out.px = a.px; out.py = a.py; out.pz = a.pz;
  out.qx = a.qx; out.qy = a.qy; out.qz = a.qz; out.qw = a.qw;
}

export function copyAvatar(a: AvatarPose, out: AvatarPose): void {
  copyPose(a.head, out.head);
  copyPose(a.left, out.left);
  copyPose(a.right, out.right);
  out.flags = a.flags;
  copyCurls(a.leftFingers, out.leftFingers);
  copyCurls(a.rightFingers, out.rightFingers);
}

function lerpCurl(a: number, b: number, t: number): number {
  const v = a + (b - a) * t;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear, kept within 0 to 1 when extrapolating. */
export function lerpFingers(a: FingerCurls, b: FingerCurls, t: number, out: FingerCurls): void {
  out.index = lerpCurl(a.index, b.index, t);
  out.grip = lerpCurl(a.grip, b.grip, t);
  out.thumb = lerpCurl(a.thumb, b.thumb, t);
}

/** Linear position, normalised-lerp rotation (fine for the small steps between packets). */
export function lerpPose(a: PoseSample, b: PoseSample, t: number, out: PoseSample): void {
  out.px = a.px + (b.px - a.px) * t;
  out.py = a.py + (b.py - a.py) * t;
  out.pz = a.pz + (b.pz - a.pz) * t;
  const dot = a.qx * b.qx + a.qy * b.qy + a.qz * b.qz + a.qw * b.qw;
  const s = dot < 0 ? -1 : 1;
  let x = a.qx + (b.qx * s - a.qx) * t;
  let y = a.qy + (b.qy * s - a.qy) * t;
  let z = a.qz + (b.qz * s - a.qz) * t;
  let w = a.qw + (b.qw * s - a.qw) * t;
  const len = Math.hypot(x, y, z, w) || 1;
  x /= len; y /= len; z /= len; w /= len;
  out.qx = x; out.qy = y; out.qz = z; out.qw = w;
}

export function lerpAvatar(a: AvatarPose, b: AvatarPose, t: number, out: AvatarPose): void {
  lerpPose(a.head, b.head, t, out.head);
  lerpPose(a.left, b.left, t, out.left);
  lerpPose(a.right, b.right, t, out.right);
  out.flags = t < 0.5 ? a.flags : b.flags;
  lerpFingers(a.leftFingers, b.leftFingers, t, out.leftFingers);
  lerpFingers(a.rightFingers, b.rightFingers, t, out.rightFingers);
}
