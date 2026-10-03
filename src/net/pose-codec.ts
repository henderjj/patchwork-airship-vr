/**
 * Compact binary packets for the unreliable data channel. Positions are
 * ship-local millimetres in 16-bit integers (±32 m, far more than the deck
 * needs); rotations use the "smallest three" quaternion encoding (drop the
 * largest component, send the other three as 16-bit values plus its index).
 * Pure TypeScript and allocation free when given reusable buffers.
 */

export const PacketType = {
  /** Head and both hands of the sender's avatar. */
  Pose: 1,
  Ping: 2,
  Pong: 3,
  /** Host's authoritative crank state (spike S6). */
  Crank: 4,
  /** Host's authoritative mooring-line state (spike S6). */
  Rope: 5,
} as const;

/** One tracked pose: position (m) and rotation quaternion. */
export interface PoseSample {
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface AvatarPose {
  head: PoseSample;
  left: PoseSample;
  right: PoseSample;
  /** Bit 0: left hand tracked, bit 1: right hand tracked. */
  flags: number;
}

export function createPoseSample(): PoseSample {
  return { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
}

export function createAvatarPose(): AvatarPose {
  return { head: createPoseSample(), left: createPoseSample(), right: createPoseSample(), flags: 0 };
}

const POS_SCALE = 1000; // millimetres
const ROT_SCALE = 32767 / Math.SQRT1_2; // components after dropping the largest are within ±1/√2
/** type(1) seq(2) time(4) flags(1) + 3 × (pos 6 + rot 7) */
export const POSE_PACKET_BYTES = 8 + 3 * 13;

function clamp16(v: number): number {
  return v < -32767 ? -32767 : v > 32767 ? 32767 : Math.round(v);
}

function writePose(view: DataView, offset: number, p: PoseSample): number {
  view.setInt16(offset, clamp16(p.px * POS_SCALE));
  view.setInt16(offset + 2, clamp16(p.py * POS_SCALE));
  view.setInt16(offset + 4, clamp16(p.pz * POS_SCALE));
  // Smallest three: find the largest component, make it positive, drop it.
  const ax = Math.abs(p.qx), ay = Math.abs(p.qy), az = Math.abs(p.qz), aw = Math.abs(p.qw);
  let largest = 3;
  let max = aw;
  if (ax > max) { largest = 0; max = ax; }
  if (ay > max) { largest = 1; max = ay; }
  if (az > max) { largest = 2; max = az; }
  const big = largest === 0 ? p.qx : largest === 1 ? p.qy : largest === 2 ? p.qz : p.qw;
  const k = (big < 0 ? -1 : 1) * ROT_SCALE;
  view.setUint8(offset + 6, largest);
  let o = offset + 7;
  if (largest !== 0) { view.setInt16(o, clamp16(p.qx * k)); o += 2; }
  if (largest !== 1) { view.setInt16(o, clamp16(p.qy * k)); o += 2; }
  if (largest !== 2) { view.setInt16(o, clamp16(p.qz * k)); o += 2; }
  if (largest !== 3) { view.setInt16(o, clamp16(p.qw * k)); }
  return offset + 13;
}

function readPose(view: DataView, offset: number, out: PoseSample): number {
  out.px = view.getInt16(offset) / POS_SCALE;
  out.py = view.getInt16(offset + 2) / POS_SCALE;
  out.pz = view.getInt16(offset + 4) / POS_SCALE;
  const largest = view.getUint8(offset + 6) & 3;
  let o = offset + 7;
  const a = view.getInt16(o) / ROT_SCALE;
  o += 2;
  const b = view.getInt16(o) / ROT_SCALE;
  o += 2;
  const c = view.getInt16(o) / ROT_SCALE;
  const sum = a * a + b * b + c * c;
  const d = Math.sqrt(Math.max(0, 1 - sum));
  switch (largest) {
    case 0: out.qx = d; out.qy = a; out.qz = b; out.qw = c; break;
    case 1: out.qx = a; out.qy = d; out.qz = b; out.qw = c; break;
    case 2: out.qx = a; out.qy = b; out.qz = d; out.qw = c; break;
    default: out.qx = a; out.qy = b; out.qz = c; out.qw = d; break;
  }
  return offset + 13;
}

/** Write a pose packet into `buffer` (at least POSE_PACKET_BYTES long). */
export function encodePose(buffer: ArrayBuffer, seq: number, timeMs: number, pose: AvatarPose): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Pose);
  view.setUint16(1, seq & 0xffff);
  view.setUint32(3, Math.floor(timeMs) >>> 0);
  view.setUint8(7, pose.flags & 0xff);
  let o = writePose(view, 8, pose.head);
  o = writePose(view, o, pose.left);
  o = writePose(view, o, pose.right);
  return o;
}

export interface PoseHeader {
  seq: number;
  timeMs: number;
}

/** Decode a pose packet; returns false if it isn't one. */
export function decodePose(view: DataView, header: PoseHeader, out: AvatarPose): boolean {
  if (view.byteLength < POSE_PACKET_BYTES || view.getUint8(0) !== PacketType.Pose) {
    return false;
  }
  header.seq = view.getUint16(1);
  header.timeMs = view.getUint32(3);
  out.flags = view.getUint8(7);
  let o = readPose(view, 8, out.head);
  o = readPose(view, o, out.left);
  readPose(view, o, out.right);
  return true;
}

/** Ping and pong for clock sync: type(1) + t0(8) [+ t1(8)], as float64 ms. */
export function encodePing(buffer: ArrayBuffer, t0: number): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Ping);
  view.setFloat64(1, t0);
  return 9;
}

export function encodePong(buffer: ArrayBuffer, t0: number, t1: number): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Pong);
  view.setFloat64(1, t0);
  view.setFloat64(9, t1);
  return 17;
}

/** Newer-than test for 16-bit wrapping sequence numbers. */
export function seqNewer(a: number, b: number): boolean {
  const diff = (a - b) & 0xffff;
  return diff !== 0 && diff < 0x8000;
}

/** Host's crank state: type(1) time(4) angle f32(4) omega f32(4) gear u8(1) flags u8(1). */
export const CRANK_PACKET_BYTES = 15;

export interface CrankStatePacket {
  timeMs: number;
  /** Crank angle wrapped to ±π (the receiver unwraps it against its own). */
  angle: number;
  omega: number;
  /** 0 to 1. */
  gear: number;
  /** Bit 0: in sync. Bits 1, 2: handle 0, 1 held. */
  flags: number;
}

export function encodeCrank(buffer: ArrayBuffer, state: CrankStatePacket): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Crank);
  view.setUint32(1, Math.floor(state.timeMs) >>> 0);
  view.setFloat32(5, state.angle);
  view.setFloat32(9, state.omega);
  view.setUint8(13, Math.round(Math.max(0, Math.min(1, state.gear)) * 255));
  view.setUint8(14, state.flags & 0xff);
  return CRANK_PACKET_BYTES;
}

export function decodeCrank(view: DataView, out: CrankStatePacket): boolean {
  if (view.byteLength < CRANK_PACKET_BYTES || view.getUint8(0) !== PacketType.Crank) {
    return false;
  }
  out.timeMs = view.getUint32(1);
  out.angle = view.getFloat32(5);
  out.omega = view.getFloat32(9);
  out.gear = view.getUint8(13) / 255;
  out.flags = view.getUint8(14);
  return true;
}

/** Host's line state: type(1) time(4) hauled f32(4) speed f32(4) flags u8(1) heaves u16(2). */
export const ROPE_PACKET_BYTES = 16;

export interface RopeStatePacket {
  timeMs: number;
  hauled: number;
  speed: number;
  /** Bit 0: heave in progress. Bit 1: docked. */
  flags: number;
  heaves: number;
}

export function encodeRope(buffer: ArrayBuffer, state: RopeStatePacket): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Rope);
  view.setUint32(1, Math.floor(state.timeMs) >>> 0);
  view.setFloat32(5, state.hauled);
  view.setFloat32(9, state.speed);
  view.setUint8(13, state.flags & 0xff);
  view.setUint16(14, state.heaves & 0xffff);
  return ROPE_PACKET_BYTES;
}

export function decodeRope(view: DataView, out: RopeStatePacket): boolean {
  if (view.byteLength < ROPE_PACKET_BYTES || view.getUint8(0) !== PacketType.Rope) {
    return false;
  }
  out.timeMs = view.getUint32(1);
  out.hauled = view.getFloat32(5);
  out.speed = view.getFloat32(9);
  out.flags = view.getUint8(13);
  out.heaves = view.getUint16(14);
  return true;
}
