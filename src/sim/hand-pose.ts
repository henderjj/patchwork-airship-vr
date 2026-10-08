/**
 * Finger poses for the low-poly hands (Phase 3 step 0, see docs/hands.md).
 * A hand's pose is three curls, each from 0 (open) to 1 (closed): the index
 * finger, the other three fingers together ("grip"), and the thumb. They
 * come from a controller's trigger, grip and capacitive touch sensors, or
 * from tracked hand joints, so one hand model serves both.
 *
 * Pure TypeScript, no allocation.
 */

import { fingerCurl, Joint } from './hand-grip.js';

export interface FingerCurls {
  index: number;
  grip: number;
  thumb: number;
}

export function createFingerCurls(index = 0, grip = 0, thumb = 0): FingerCurls {
  return { index, grip, thumb };
}

/** What a controller reports that poses a hand. */
export interface ControllerFingers {
  /** Trigger pull, 0 to 1, and whether a finger rests on it. */
  trigger: number;
  triggerTouched: boolean;
  /** Grip (squeeze) pull, 0 to 1. The grip has no touch sensor. */
  squeeze: number;
  /** The thumb rests on the thumbstick, a face button or the thumb rest. */
  thumbTouched: boolean;
}

/** Index curl with the finger lifted off the trigger: nearly straight, so it points. */
export const INDEX_LIFTED = 0.12;
/** Index curl with the finger resting on the trigger, before it is pulled. */
export const INDEX_RESTING = 0.4;
/** Curl of the other three fingers with the grip let go: relaxed, not rigidly flat. */
export const GRIP_RELAXED = 0.1;
/** The curls ease towards their targets with this time constant, s: most of the way in about 50 ms. */
export const CURL_TIME_CONSTANT = 0.025;

/** Target curls for a controller's inputs. */
export function curlsFromController(input: ControllerFingers, out: FingerCurls): FingerCurls {
  const trigger = clamp01(input.trigger);
  out.index = input.triggerTouched || trigger > 0.05 ? INDEX_RESTING + (1 - INDEX_RESTING) * trigger : INDEX_LIFTED;
  out.grip = GRIP_RELAXED + (1 - GRIP_RELAXED) * clamp01(input.squeeze);
  out.thumb = input.thumbTouched ? 1 : 0;
  return out;
}

/**
 * Straightness (tip-to-base distance over bone length, see `fingerCurl`) of
 * a straight finger and of one curled into a fist.
 */
const STRAIGHT = 0.97;
const CURLED = 0.45;
/** Thumb tip to index knuckle, m: lifted clear of the hand, and tucked over the curled fingers. */
const THUMB_OUT = 0.07;
const THUMB_IN = 0.035;
const IndexProximal = 6;
const LittleMetacarpal = 20;

function jointDistance(m: Float32Array, a: number, b: number): number {
  const ia = a * 16 + 12;
  const ib = b * 16 + 12;
  return Math.hypot(m[ia] - m[ib], m[ia + 1] - m[ib + 1], m[ia + 2] - m[ib + 2]);
}

function curlOf(straightness: number): number {
  return clamp01((STRAIGHT - straightness) / (STRAIGHT - CURLED));
}

/**
 * Target curls from the 25 WebXR hand joints (4x4 column-major matrices in
 * any one space, as `XRFrame.fillPoses` writes them).
 */
export function curlsFromJoints(joints: Float32Array, out: FingerCurls): FingerCurls {
  out.index = curlOf(fingerCurl(joints, Joint.IndexMetacarpal));
  out.grip =
    (curlOf(fingerCurl(joints, Joint.MiddleMetacarpal)) +
      curlOf(fingerCurl(joints, Joint.RingMetacarpal)) +
      curlOf(fingerCurl(joints, LittleMetacarpal))) /
    3;
  out.thumb = clamp01((THUMB_OUT - jointDistance(joints, Joint.ThumbTip, IndexProximal)) / (THUMB_OUT - THUMB_IN));
  return out;
}

/** Ease `current` towards `target` over `dt` seconds, in place. */
export function easeCurls(current: FingerCurls, target: FingerCurls, dt: number): FingerCurls {
  const k = dt <= 0 ? 0 : 1 - Math.exp(-dt / CURL_TIME_CONSTANT);
  current.index += (target.index - current.index) * k;
  current.grip += (target.grip - current.grip) * k;
  current.thumb += (target.thumb - current.thumb) * k;
  return current;
}

export function copyCurls(from: FingerCurls, out: FingerCurls): FingerCurls {
  out.index = from.index;
  out.grip = from.grip;
  out.thumb = from.thumb;
  return out;
}

export function setCurls(out: FingerCurls, index: number, grip: number, thumb: number): FingerCurls {
  out.index = index;
  out.grip = grip;
  out.thumb = thumb;
  return out;
}

export type PoseName = 'flat' | 'fist' | 'point' | 'thumbs-up' | 'other';

/**
 * The named pose a hand is closest to, for tests and the HUD: a flat hand
 * (nothing held), a fist (everything closed), pointing (fist with the index
 * out) and a thumbs-up (fist with the thumb lifted).
 */
export function poseName(c: FingerCurls): PoseName {
  const closed = (v: number) => v > 0.75;
  const open = (v: number) => v < 0.3;
  if (open(c.index) && open(c.grip) && open(c.thumb)) return 'flat';
  if (closed(c.grip)) {
    if (closed(c.index) && closed(c.thumb)) return 'fist';
    if (open(c.index) && closed(c.thumb)) return 'point';
    if (closed(c.index) && open(c.thumb)) return 'thumbs-up';
  }
  return 'other';
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
