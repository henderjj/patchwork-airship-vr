import { Vector3 } from '@iwsdk/core';
import { describe, expect, it } from 'vitest';
import { lerpAvatar } from '../src/net/pose-buffer.js';
import { createAvatarPose, decodePose, encodePose, POSE_PACKET_BYTES, POSE_PACKET_MIN_BYTES } from '../src/net/pose-codec.js';
import { HAND_BONES, PosedHand, staticHandGeometry } from '../src/scene-assets/hand.scene-asset.js';
import { JOINT_COUNT } from '../src/sim/hand-grip.js';
import {
  type ControllerFingers,
  createFingerCurls,
  curlsFromController,
  curlsFromJoints,
  easeCurls,
  type PoseName,
  poseName,
} from '../src/sim/hand-pose.js';

const controller = (trigger: number, triggerTouched: boolean, squeeze: number, thumbTouched: boolean): ControllerFingers => ({
  trigger,
  triggerTouched,
  squeeze,
  thumbTouched,
});

const named = (input: ControllerFingers): PoseName => poseName(curlsFromController(input, createFingerCurls()));

describe('poses from a controller', () => {
  it('gives the named poses', () => {
    expect(named(controller(0, false, 0, false))).toBe('flat');
    expect(named(controller(1, true, 1, true))).toBe('fist');
    expect(named(controller(0, false, 1, true))).toBe('point');
    expect(named(controller(1, true, 1, false))).toBe('thumbs-up');
  });

  it('rests the index on the trigger and closes it with the pull', () => {
    const lifted = curlsFromController(controller(0, false, 0, false), createFingerCurls()).index;
    const resting = curlsFromController(controller(0, true, 0, false), createFingerCurls()).index;
    const half = curlsFromController(controller(0.5, true, 0, false), createFingerCurls()).index;
    const pulled = curlsFromController(controller(1, true, 0, false), createFingerCurls()).index;
    expect(lifted).toBeLessThan(resting);
    expect(resting).toBeLessThan(half);
    expect(half).toBeLessThan(pulled);
    expect(pulled).toBe(1);
    // A pulled trigger counts as touched even if the sensor says otherwise.
    expect(curlsFromController(controller(0.6, false, 0, false), createFingerCurls()).index).toBeGreaterThan(resting);
  });

  it('eases most of the way to a new pose in about 50 ms', () => {
    const current = createFingerCurls(0, 0, 0);
    const target = createFingerCurls(1, 1, 1);
    for (let i = 0; i < 5; i++) {
      easeCurls(current, target, 0.011); // five 90 Hz frames
    }
    expect(current.grip).toBeGreaterThan(0.85);
    expect(current.grip).toBeLessThan(1);
    // A single frame moves part of the way, so a pose never snaps.
    const one = easeCurls(createFingerCurls(0, 0, 0), target, 0.011);
    expect(one.grip).toBeGreaterThan(0.2);
    expect(one.grip).toBeLessThan(0.5);
  });
});

/** Bone lengths from each finger's metacarpal joint to its tip, m. */
const BONES = [0.065, 0.04, 0.025, 0.02];

/**
 * A right hand in its own space (fingers along -z, palm facing -y): the
 * index bent by `indexBend` and the other fingers by `bend` at each joint,
 * the thumb tip at `thumb`.
 */
function handJoints(indexBend: number, bend: number, thumb: readonly [number, number, number]): Float32Array {
  const m = new Float32Array(JOINT_COUNT * 16);
  const set = (joint: number, x: number, y: number, z: number) => {
    m[joint * 16 + 12] = x;
    m[joint * 16 + 13] = y;
    m[joint * 16 + 14] = z;
  };
  for (let finger = 0; finger < 4; finger++) {
    const base = 5 + finger * 5;
    let y = 0, z = 0, angle = 0;
    const x = -0.03 + finger * 0.02;
    set(base, x, y, z);
    for (let bone = 0; bone < 4; bone++) {
      if (bone > 0) angle += finger === 0 ? indexBend : bend;
      z -= BONES[bone] * Math.cos(angle);
      y -= BONES[bone] * Math.sin(angle);
      set(base + bone + 1, x, y, z);
    }
  }
  set(4, ...thumb);
  return m;
}

const fromJoints = (joints: Float32Array) => curlsFromJoints(joints, createFingerCurls());

describe('poses from tracked hands', () => {
  // The index knuckle (proximal joint) is at (-0.03, 0, -0.065).
  const thumbOut: [number, number, number] = [-0.11, 0.01, -0.04];
  const thumbIn: [number, number, number] = [-0.01, -0.03, -0.07];

  it('gives the named poses', () => {
    expect(poseName(fromJoints(handJoints(0, 0, thumbOut)))).toBe('flat');
    expect(poseName(fromJoints(handJoints(1.4, 1.4, thumbIn)))).toBe('fist');
    expect(poseName(fromJoints(handJoints(0, 1.4, thumbIn)))).toBe('point');
    expect(poseName(fromJoints(handJoints(1.4, 1.4, thumbOut)))).toBe('thumbs-up');
  });

  it('curls in between for a half-closed hand', () => {
    const half = fromJoints(handJoints(0.6, 0.6, thumbOut));
    expect(half.grip).toBeGreaterThan(0.2);
    expect(half.grip).toBeLessThan(0.8);
  });
});

describe('finger curls in pose packets', () => {
  it('round-trip within half a percent', () => {
    const buffer = new ArrayBuffer(POSE_PACKET_BYTES);
    const pose = createAvatarPose();
    pose.leftFingers = createFingerCurls(0.12, 0.5, 1);
    pose.rightFingers = createFingerCurls(1, 0.15, 0);
    expect(encodePose(buffer, 1, 10, pose)).toBe(POSE_PACKET_BYTES);
    const out = createAvatarPose();
    expect(decodePose(new DataView(buffer), { seq: 0, timeMs: 0 }, out)).toBe(true);
    for (const k of ['leftFingers', 'rightFingers'] as const) {
      for (const f of ['index', 'grip', 'thumb'] as const) {
        expect(Math.abs(out[k][f] - pose[k][f])).toBeLessThan(0.005);
      }
    }
  });

  it('draws fists for a crewmate on a version without posed hands', () => {
    const buffer = new ArrayBuffer(POSE_PACKET_BYTES);
    const pose = createAvatarPose();
    pose.flags = 3;
    encodePose(buffer, 1, 10, pose);
    const out = createAvatarPose();
    out.leftFingers = createFingerCurls(0, 0, 0);
    const old = new DataView(buffer, 0, POSE_PACKET_MIN_BYTES);
    expect(decodePose(old, { seq: 0, timeMs: 0 }, out)).toBe(true);
    expect(out.flags).toBe(3);
    expect(poseName(out.leftFingers)).toBe('fist');
    expect(poseName(out.rightFingers)).toBe('fist');
  });

  it('stay small', () => {
    expect(POSE_PACKET_BYTES).toBe(POSE_PACKET_MIN_BYTES + 6);
  });

  it('interpolate between packets and stay within 0 to 1 when extrapolating', () => {
    const a = createAvatarPose();
    const b = createAvatarPose();
    a.rightFingers = createFingerCurls(0, 0, 0);
    b.rightFingers = createFingerCurls(1, 0.5, 1);
    const out = createAvatarPose();
    lerpAvatar(a, b, 0.5, out);
    expect(out.rightFingers.index).toBeCloseTo(0.5);
    expect(out.rightFingers.grip).toBeCloseTo(0.25);
    lerpAvatar(a, b, 1.5, out);
    expect(out.rightFingers.index).toBe(1);
  });
});

describe('the posed hand model', () => {
  const tip = new Vector3();
  const wrist = new Vector3();
  const knuckle = new Vector3();
  /** Index fingertip: the distal bone's origin plus its length isn't exposed, so use the distal joint. */
  const INDEX_DISTAL = 3;
  const MIDDLE_DISTAL = 6;

  it('is low-poly: one skinned mesh of 16 bones and a few hundred triangles', () => {
    const hand = new PosedHand(0x2f6db3, 'right');
    expect(HAND_BONES).toBe(16);
    expect(hand.mesh.skeleton.bones.length).toBe(16);
    const triangles = hand.mesh.geometry.getAttribute('position').count / 3;
    expect(triangles).toBeGreaterThan(200);
    expect(triangles).toBeLessThan(600);
  });

  it('curls the fingers back towards the wrist in a fist', () => {
    const hand = new PosedHand(0x2f6db3, 'right');
    hand.pose(createFingerCurls(0, 0, 0));
    hand.boneOrigin(0, wrist);
    const openReach = hand.boneOrigin(MIDDLE_DISTAL, tip).distanceTo(wrist);
    hand.pose(createFingerCurls(1, 1, 1));
    const fistReach = hand.boneOrigin(MIDDLE_DISTAL, tip).distanceTo(wrist);
    expect(openReach).toBeGreaterThan(0.15);
    expect(fistReach).toBeLessThan(0.1);
  });

  it('points with the index while the other fingers close', () => {
    const hand = new PosedHand(0x2f6db3, 'right');
    hand.pose(createFingerCurls(0.12, 1, 1));
    hand.boneOrigin(0, wrist);
    const index = hand.boneOrigin(INDEX_DISTAL, tip).distanceTo(wrist);
    const middle = hand.boneOrigin(MIDDLE_DISTAL, knuckle).distanceTo(wrist);
    expect(index).toBeGreaterThan(middle + 0.04);
  });

  it('draws the left hand as the right one mirrored', () => {
    const left = new PosedHand(0x2f6db3, 'left');
    const right = new PosedHand(0x2f6db3, 'right');
    for (const hand of [left, right]) {
      hand.pose(createFingerCurls(0.3, 0.8, 0.5));
    }
    const l = left.boneOrigin(INDEX_DISTAL, tip).clone();
    const r = right.boneOrigin(INDEX_DISTAL, knuckle);
    expect(l.x).toBeCloseTo(-r.x, 5);
    expect(l.y).toBeCloseTo(r.y, 5);
    expect(l.z).toBeCloseTo(r.z, 5);
  });

  it('keeps the fist for the static stress-test dummy', () => {
    const geometry = staticHandGeometry(0x2f6db3, createFingerCurls(1, 1, 1));
    expect(geometry.getAttribute('skinIndex')).toBeUndefined();
    geometry.computeBoundingBox();
    // In the wrist's frame: the fist ends well short of an open hand's reach.
    expect(geometry.boundingBox!.min.z).toBeGreaterThan(-0.14);
  });
});
