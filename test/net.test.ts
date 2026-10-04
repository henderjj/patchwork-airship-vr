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

  it('does not let one slow pong at the start linger in the smoothed RTT', () => {
    const sync = new ClockSync();
    // The page was busy while connecting: the first pong took 1.9 s.
    sync.onPong(0, 950, 1900);
    for (let i = 1; i <= 3; i++) {
      sync.onPong(i * 500, i * 500 + 75, i * 500 + 150);
    }
    expect(sync.stats.srtt).toBe(150);
    expect(sync.stats.offset).toBeCloseTo(0, 6);
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

describe('crank packets', () => {
  it('round-trip the host crank state', async () => {
    const { encodeCrank, decodeCrank, CRANK_PACKET_BYTES } = await import('../src/net/pose-codec.js');
    const buffer = new ArrayBuffer(CRANK_PACKET_BYTES);
    const length = encodeCrank(buffer, { timeMs: 123456.7, angle: -2.5, omega: 8.75, gear: 0.5, flags: 5 });
    expect(length).toBe(CRANK_PACKET_BYTES);
    const out = { timeMs: 0, angle: 0, omega: 0, gear: 0, flags: 0 };
    expect(decodeCrank(new DataView(buffer), out)).toBe(true);
    expect(out.timeMs).toBe(123456);
    expect(out.angle).toBeCloseTo(-2.5, 5);
    expect(out.omega).toBeCloseTo(8.75, 5);
    expect(out.gear).toBeCloseTo(0.5, 2);
    expect(out.flags).toBe(5);
  });
});

describe('clock sync reset', () => {
  it('forgets the previous peer', async () => {
    const { ClockSync } = await import('../src/net/clock-sync.js');
    const clock = new ClockSync();
    clock.onPong(0, 5000, 10);
    expect(clock.stats.offset).toBeCloseTo(4995, 6);
    clock.reset();
    expect(clock.stats.samples).toBe(0);
    clock.onPong(100, 120, 140);
    expect(clock.stats.offset).toBeCloseTo(0, 6);
  });
});

describe('rope packets', () => {
  it('round-trip the host line state', async () => {
    const { encodeRope, decodeRope, ROPE_PACKET_BYTES } = await import('../src/net/pose-codec.js');
    const buffer = new ArrayBuffer(ROPE_PACKET_BYTES);
    expect(encodeRope(buffer, { timeMs: 99.9, hauled: 3.25, speed: -0.5, flags: 3, heaves: 42 })).toBe(ROPE_PACKET_BYTES);
    const out = { timeMs: 0, hauled: 0, speed: 0, flags: 0, heaves: 0 };
    expect(decodeRope(new DataView(buffer), out)).toBe(true);
    expect(out).toEqual({ timeMs: 99, hauled: 3.25, speed: -0.5, flags: 3, heaves: 42 });
  });
});

describe('ship packets', () => {
  it('round-trip the host ship state, with world positions kilometres out', async () => {
    const { encodeShip, decodeShip, createShipStatePacket, SHIP_PACKET_BYTES } = await import('../src/net/pose-codec.js');
    const state = {
      ...createShipStatePacket(), timeMs: 765432.9, flags: 5, shipTime: 312.5, x: -1834.25, y: 121.5, z: 2950.75,
      yaw: -2.75, pitch: 0.03, roll: -0.06, vx: 4.5, vy: -0.75, vz: -2.25, ax: 0.1, ay: -0.02, az: 0.3, yawRate: 0.05, heat: 63.5, airspeed: 6.25,
    };
    const buffer = new ArrayBuffer(SHIP_PACKET_BYTES);
    expect(encodeShip(buffer, state)).toBe(SHIP_PACKET_BYTES);
    const out = createShipStatePacket();
    expect(decodeShip(new DataView(buffer), out)).toBe(true);
    expect(out.timeMs).toBe(765432);
    expect(out.flags).toBe(5);
    for (const key of ['shipTime', 'x', 'y', 'z', 'yaw', 'pitch', 'roll', 'vx', 'vy', 'vz', 'ax', 'ay', 'az', 'yawRate', 'heat', 'airspeed'] as const) {
      // f32 keeps millimetres at 3 km.
      expect(Math.abs(out[key] - state[key])).toBeLessThan(1e-3);
    }
  });
});
