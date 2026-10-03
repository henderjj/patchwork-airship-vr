import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { ClockSync } from '../src/net/clock-sync.js';
import { PoseBuffer } from '../src/net/pose-buffer.js';
import {
  createAvatarPose,
  decodePose,
  encodePose,
  POSE_PACKET_BYTES,
  type PoseSample,
  seqNewer,
} from '../src/net/pose-codec.js';

function setPose(p: PoseSample, pos: Vector3, q: Quaternion) {
  p.px = pos.x; p.py = pos.y; p.pz = pos.z;
  p.qx = q.x; p.qy = q.y; p.qz = q.z; p.qw = q.w;
}

describe('pose codec', () => {
  it('round-trips within a millimetre and a tenth of a degree', () => {
    const buffer = new ArrayBuffer(POSE_PACKET_BYTES);
    const pose = createAvatarPose();
    const out = createAvatarPose();
    const header = { seq: 0, timeMs: 0 };
    for (let i = 0; i < 200; i++) {
      const q = new Quaternion().random();
      const pos = new Vector3(Math.random() * 4 - 2, Math.random() * 2, Math.random() * 6 - 3);
      setPose(pose.head, pos, q);
      setPose(pose.left, pos.clone().addScalar(0.3), q.clone().invert());
      setPose(pose.right, pos.clone().addScalar(-0.3), new Quaternion());
      pose.flags = 3;
      const n = encodePose(buffer, 65535 + i, 123456.7, pose);
      expect(n).toBe(POSE_PACKET_BYTES);
      expect(decodePose(new DataView(buffer), header, out)).toBe(true);
      expect(header.seq).toBe((65535 + i) & 0xffff);
      expect(header.timeMs).toBe(123456);
      expect(out.flags).toBe(3);
      for (const k of ['head', 'left', 'right'] as const) {
        expect(Math.abs(out[k].px - pose[k].px)).toBeLessThan(0.0006);
        expect(Math.abs(out[k].pz - pose[k].pz)).toBeLessThan(0.0006);
        const a = new Quaternion(pose[k].qx, pose[k].qy, pose[k].qz, pose[k].qw);
        const b = new Quaternion(out[k].qx, out[k].qy, out[k].qz, out[k].qw);
        expect((a.angleTo(b) * 180) / Math.PI).toBeLessThan(0.1);
      }
    }
  });

  it('packets are small', () => {
    expect(POSE_PACKET_BYTES).toBeLessThanOrEqual(50);
  });

  it('compares wrapping sequence numbers', () => {
    expect(seqNewer(1, 65535)).toBe(true);
    expect(seqNewer(65535, 1)).toBe(false);
    expect(seqNewer(5, 5)).toBe(false);
  });
});

describe('clock sync', () => {
  it('finds the offset from the lowest-RTT sample', () => {
    const sync = new ClockSync();
    const peerAhead = 5000;
    // Symmetric 20 ms path, then a sample delayed by queueing on the way back.
    sync.onPong(0, 10 + peerAhead, 20);
    sync.onPong(100, 110 + peerAhead, 190);
    expect(sync.stats.offset).toBeCloseTo(peerAhead, 6);
    expect(sync.stats.rtt).toBe(90);
    expect(sync.toLocal(peerAhead + 500)).toBeCloseTo(500, 6);
  });
});

describe('pose buffer', () => {
  it('interpolates between snapshots and briefly extrapolates', () => {
    const buf = new PoseBuffer();
    const p = createAvatarPose();
    for (let i = 0; i <= 4; i++) {
      p.head.px = i * 0.1; // 0.1 m per 22 ms
      buf.push(i * 22, p);
    }
    const out = createAvatarPose();
    buf.sample(33, out);
    expect(out.head.px).toBeCloseTo(0.15, 6);
    buf.sample(88 + 11, out);
    expect(out.head.px).toBeCloseTo(0.45, 6);
    buf.sample(1000, out); // capped at 50 ms of extrapolation
    expect(out.head.px).toBeCloseTo(0.4 + (50 / 22) * 0.1, 6);
  });

  it('drops out-of-order packets', () => {
    const buf = new PoseBuffer();
    const p = createAvatarPose();
    buf.push(10, p);
    buf.push(5, p);
    expect(buf.count).toBe(1);
  });
});
