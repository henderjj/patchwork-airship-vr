/**
 * Grip from tracked hand joints (spike S9). With hand tracking there is no
 * grip button, so a hand grips when it makes a fist (index, middle and ring
 * fingers curled) or pinches (thumb tip on index tip). Each has hysteresis so
 * a grip doesn't flicker at the threshold.
 *
 * Input is the 25 WebXR hand joints as 4x4 column-major matrices (the layout
 * `XRFrame.fillPoses` writes), in any one space: only distances are used.
 * Pure TypeScript, no allocation.
 */

/** Joint indices in WebXR's XRHand order. */
export const Joint = {
  Wrist: 0,
  ThumbTip: 4,
  IndexMetacarpal: 5,
  IndexTip: 9,
  MiddleMetacarpal: 10,
  MiddleTip: 14,
  RingMetacarpal: 15,
  RingTip: 19,
} as const;

export const JOINT_COUNT = 25;

/** Default average curl below which the fingers count as a fist; they open again 0.12 above it. */
export const FIST_CLOSE = 0.6;
const FIST_HYSTERESIS = 0.12;
/** Default thumb-to-index tip distance that starts a pinch, m; it ends at twice this. */
export const PINCH_CLOSE = 0.02;

function distance(m: Float32Array, a: number, b: number): number {
  const ia = a * 16 + 12;
  const ib = b * 16 + 12;
  return Math.hypot(m[ia] - m[ib], m[ia + 1] - m[ib + 1], m[ia + 2] - m[ib + 2]);
}

/**
 * How straight one finger is: its tip's distance from its metacarpal joint
 * over the length of its bones. About 1 when straight, under 0.5 in a fist.
 */
export function fingerCurl(m: Float32Array, metacarpal: number): number {
  let length = 0;
  for (let j = metacarpal; j < metacarpal + 4; j++) {
    length += distance(m, j, j + 1);
  }
  return length > 1e-4 ? distance(m, metacarpal, metacarpal + 4) / length : 1;
}

export class HandGrip {
  /** Thresholds, adjustable for testing on a headset. A pinch threshold of 0 turns pinch-to-grip off. */
  fistClose = FIST_CLOSE;
  pinchClose = PINCH_CLOSE;
  fist = false;
  pinch = false;
  /** Average curl of index, middle and ring, for the debug hook. */
  curl = 1;
  pinchDistance = 1;

  get gripping(): boolean {
    return this.fist || this.pinch;
  }

  /** Update from this frame's joints; returns whether the hand grips. */
  update(joints: Float32Array): boolean {
    this.curl =
      (fingerCurl(joints, Joint.IndexMetacarpal) + fingerCurl(joints, Joint.MiddleMetacarpal) + fingerCurl(joints, Joint.RingMetacarpal)) / 3;
    this.fist = this.curl < this.fistClose + (this.fist ? FIST_HYSTERESIS : 0);
    this.pinchDistance = distance(joints, Joint.ThumbTip, Joint.IndexTip);
    this.pinch = this.pinchDistance < this.pinchClose * (this.pinch ? 2 : 1);
    return this.gripping;
  }

  reset(): void {
    this.fist = false;
    this.pinch = false;
    this.curl = 1;
    this.pinchDistance = 1;
  }
}
