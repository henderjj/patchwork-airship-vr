/**
 * Compact binary packets for the unreliable data channel. Positions are
 * ship-local millimetres in 16-bit integers (±32 m, far more than the deck
 * needs); rotations use the "smallest three" quaternion encoding (drop the
 * largest component, send the other three as 16-bit values plus its index).
 * Pure TypeScript and allocation free when given reusable buffers.
 */

import { createFingerCurls, type FingerCurls } from '../sim/hand-pose.js';

export const PacketType = {
  /** Head and both hands of the sender's avatar. */
  Pose: 1,
  Ping: 2,
  Pong: 3,
  /** Host's authoritative crank state (spike S6). */
  Crank: 4,
  /** Host's authoritative mooring-line state (spike S6). */
  Rope: 5,
  /** A loose object's state from its owner (spike S7). */
  Object: 6,
  /** Host's authoritative ship state (Phase 2 flight). */
  Ship: 7,
  /** The guest's hands on the vent cord and tiller (Phase 2 controls). */
  Controls: 8,
  /** Host's authoritative crate, hatch and winch (Phase 3 cargo). */
  Cargo: 9,
  /** The guest's hands on the cargo winch, tag line and hatch lever (Phase 3 cargo). */
  CargoHands: 10,
  /** Host's authoritative crates: where each is and who holds it (Phase 3 cargo loading). */
  Crates: 11,
  /** The guest's hands on the crates' handles (Phase 3 cargo loading). */
  CrateHands: 12,
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
  /** How each hand's fingers are curled (Phase 3 posed hands). */
  leftFingers: FingerCurls;
  rightFingers: FingerCurls;
  /** What each hand holds (grip locking): the left's kind in the low four bits, the right's in the high (see HoldKind). */
  holds: number;
}

export function createPoseSample(): PoseSample {
  return { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
}

export function createAvatarPose(): AvatarPose {
  return {
    head: createPoseSample(),
    left: createPoseSample(),
    right: createPoseSample(),
    flags: 0,
    leftFingers: createFingerCurls(1, 1, 1),
    rightFingers: createFingerCurls(1, 1, 1),
    holds: 0,
  };
}

const POS_SCALE = 1000; // millimetres
const ROT_SCALE = 32767 / Math.SQRT1_2; // components after dropping the largest are within ±1/√2
/** type(1) seq(2) time(4) flags(1) + 3 × (pos 6 + rot 7), as sent before posed hands. */
export const POSE_PACKET_MIN_BYTES = 8 + 3 * 13;
/** ... + finger curls u8 × 3 per hand (index, grip, thumb; left then right). */
const FINGERS_END = POSE_PACKET_MIN_BYTES + 6;
/** ... + what each hand holds, u8. */
export const POSE_PACKET_BYTES = FINGERS_END + 1;

function clamp16(v: number): number {
  return v < -32767 ? -32767 : v > 32767 ? 32767 : Math.round(v);
}

export function writePose(view: DataView, offset: number, p: PoseSample): number {
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

export function readPose(view: DataView, offset: number, out: PoseSample): number {
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
  o = writeFingers(view, o, pose.leftFingers);
  o = writeFingers(view, o, pose.rightFingers);
  view.setUint8(o, pose.holds & 0xff);
  return o + 1;
}

function curlByte(v: number): number {
  return Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255);
}

function writeFingers(view: DataView, offset: number, f: FingerCurls): number {
  view.setUint8(offset, curlByte(f.index));
  view.setUint8(offset + 1, curlByte(f.grip));
  view.setUint8(offset + 2, curlByte(f.thumb));
  return offset + 3;
}

function readFingers(view: DataView, offset: number, out: FingerCurls): number {
  out.index = view.getUint8(offset) / 255;
  out.grip = view.getUint8(offset + 1) / 255;
  out.thumb = view.getUint8(offset + 2) / 255;
  return offset + 3;
}

export interface PoseHeader {
  seq: number;
  timeMs: number;
}

/**
 * Decode a pose packet; returns false if it isn't one. A packet from a
 * version without posed hands has no finger curls; its hands are drawn as
 * fists, as that version drew them. One from before grip locking says
 * nothing held (the crank and line still show in its flags).
 */
export function decodePose(view: DataView, header: PoseHeader, out: AvatarPose): boolean {
  if (view.byteLength < POSE_PACKET_MIN_BYTES || view.getUint8(0) !== PacketType.Pose) {
    return false;
  }
  header.seq = view.getUint16(1);
  header.timeMs = view.getUint32(3);
  out.flags = view.getUint8(7);
  let o = readPose(view, 8, out.head);
  o = readPose(view, o, out.left);
  o = readPose(view, o, out.right);
  if (view.byteLength >= FINGERS_END) {
    o = readFingers(view, o, out.leftFingers);
    o = readFingers(view, o, out.rightFingers);
  } else {
    setFist(out.leftFingers);
    setFist(out.rightFingers);
  }
  out.holds = view.byteLength >= POSE_PACKET_BYTES ? view.getUint8(o) : 0;
  return true;
}

function setFist(f: FingerCurls): void {
  f.index = 1;
  f.grip = 1;
  f.thumb = 1;
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

/**
 * Host's line state: type(1) time(4) hauled f32(4) speed f32(4) flags u8(1)
 * heaves u16(2), then the grapple (docking): phase u8(1) throws u8(1).
 */
export const ROPE_PACKET_BYTES = 18;
/** A packet from a version before docking ends after the heaves. */
const ROPE_PACKET_V1_BYTES = 16;
/** `grapple` in a packet that didn't say. */
export const GRAPPLE_UNKNOWN = 255;

export interface RopeStatePacket {
  timeMs: number;
  hauled: number;
  speed: number;
  /** Bit 0: heave in progress. Bit 1: the whole line is in. */
  flags: number;
  heaves: number;
  /** What the grapple is doing (an index into GRAPPLE_PHASES in src/sim/docking.ts), or GRAPPLE_UNKNOWN. */
  grapple: number;
  /** Throws so far (wrapping at 256), so a page can tell which throw this is about. */
  throws: number;
}

export function encodeRope(buffer: ArrayBuffer, state: RopeStatePacket): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Rope);
  view.setUint32(1, Math.floor(state.timeMs) >>> 0);
  view.setFloat32(5, state.hauled);
  view.setFloat32(9, state.speed);
  view.setUint8(13, state.flags & 0xff);
  view.setUint16(14, state.heaves & 0xffff);
  view.setUint8(16, state.grapple & 0xff);
  view.setUint8(17, state.throws & 0xff);
  return ROPE_PACKET_BYTES;
}

export function decodeRope(view: DataView, out: RopeStatePacket): boolean {
  if (view.byteLength < ROPE_PACKET_V1_BYTES || view.getUint8(0) !== PacketType.Rope) {
    return false;
  }
  out.timeMs = view.getUint32(1);
  out.hauled = view.getFloat32(5);
  out.speed = view.getFloat32(9);
  out.flags = view.getUint8(13);
  out.heaves = view.getUint16(14);
  const docking = view.byteLength >= ROPE_PACKET_BYTES;
  out.grapple = docking ? view.getUint8(16) : GRAPPLE_UNKNOWN;
  out.throws = docking ? view.getUint8(17) : 0;
  return true;
}

/** Owner's object state: type(1) id u8(1) epoch u8(1) flags u8(1) time(4) pose(13). */
export const OBJECT_PACKET_BYTES = 21;

export interface ObjectStatePacket {
  id: number;
  /** Ownership epoch the sender owns the object under (see src/net/ownership.ts). */
  epoch: number;
  /** Bit 0: held in the sender's hand. */
  flags: number;
  timeMs: number;
  pose: PoseSample;
}

export function encodeObject(buffer: ArrayBuffer, state: ObjectStatePacket): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Object);
  view.setUint8(1, state.id & 0xff);
  view.setUint8(2, state.epoch & 0xff);
  view.setUint8(3, state.flags & 0xff);
  view.setUint32(4, Math.floor(state.timeMs) >>> 0);
  return writePose(view, 8, state.pose);
}

export function decodeObject(view: DataView, out: ObjectStatePacket): boolean {
  if (view.byteLength < OBJECT_PACKET_BYTES || view.getUint8(0) !== PacketType.Object) {
    return false;
  }
  out.id = view.getUint8(1);
  out.epoch = view.getUint8(2);
  out.flags = view.getUint8(3);
  out.timeMs = view.getUint32(4);
  readPose(view, 8, out.pose);
  return true;
}

/** Host's ship state: type(1) flags u8(1) time(4) then 20 × f32. */
export const SHIP_PACKET_BYTES = 6 + 20 * 4;

/** Ship packet flag bits. */
export const SHIP_FLAG_PAUSED = 1;
export const SHIP_FLAG_BURNER = 2;
export const SHIP_FLAG_VENT = 4;

export interface ShipStatePacket {
  /** Sender's clock when the state was taken, ms. */
  timeMs: number;
  flags: number;
  /** Ship clock, s. */
  shipTime: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
  /** Turn rate, rad/s. */
  yawRate: number;
  /** Envelope heat, °C above the outside air (0 for scripted motion). */
  heat: number;
  /** Airspeed, m/s. */
  airspeed: number;
  /** Rudder, -1 (port) to 1 (starboard), and vent opening, 0 to 1. */
  rudder: number;
  vent: number;
  /** Seconds of burn left in the burner. */
  burnLeft: number;
  /** Which ballast bags have been dropped, one bit each. */
  ballast: number;
}

export function createShipStatePacket(): ShipStatePacket {
  return {
    timeMs: 0, flags: 0, shipTime: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0,
    vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, yawRate: 0, heat: 0, airspeed: 0,
    rudder: 0, vent: 0, burnLeft: 0, ballast: 0,
  };
}

const SHIP_FIELDS = [
  'shipTime', 'x', 'y', 'z', 'yaw', 'pitch', 'roll', 'vx', 'vy', 'vz', 'ax', 'ay', 'az', 'yawRate', 'heat', 'airspeed',
  'rudder', 'vent', 'burnLeft', 'ballast',
] as const;

export function encodeShip(buffer: ArrayBuffer, state: ShipStatePacket): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Ship);
  view.setUint8(1, state.flags & 0xff);
  view.setUint32(2, Math.floor(state.timeMs) >>> 0);
  for (let i = 0; i < SHIP_FIELDS.length; i++) {
    view.setFloat32(6 + i * 4, state[SHIP_FIELDS[i]]);
  }
  return SHIP_PACKET_BYTES;
}

export function decodeShip(view: DataView, out: ShipStatePacket): boolean {
  if (view.byteLength < SHIP_PACKET_BYTES || view.getUint8(0) !== PacketType.Ship) {
    return false;
  }
  out.flags = view.getUint8(1);
  out.timeMs = view.getUint32(2);
  for (let i = 0; i < SHIP_FIELDS.length; i++) {
    out[SHIP_FIELDS[i]] = view.getFloat32(6 + i * 4);
  }
  return true;
}

/** The guest's hands on the controls: type(1) time(4) flags u8(1) vent u8(1) tiller i16(2). */
export const CONTROLS_PACKET_BYTES = 9;

/** Controls packet flag bits: the guest holds the vent cord, the tiller. */
export const CONTROLS_FLAG_VENT = 1;
export const CONTROLS_FLAG_TILLER = 2;

export interface ControlsPacket {
  timeMs: number;
  flags: number;
  /** How far the guest has pulled the vent cord, 0 to 1. */
  vent: number;
  /** Where the guest holds the tiller, -1 (rudder to port) to 1 (starboard). */
  rudder: number;
}

export function encodeControls(buffer: ArrayBuffer, state: ControlsPacket): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Controls);
  view.setUint32(1, Math.floor(state.timeMs) >>> 0);
  view.setUint8(5, state.flags & 0xff);
  view.setUint8(6, Math.round(Math.max(0, Math.min(1, state.vent)) * 255));
  view.setInt16(7, Math.round(Math.max(-1, Math.min(1, state.rudder)) * 32767));
  return CONTROLS_PACKET_BYTES;
}

export function decodeControls(view: DataView, out: ControlsPacket): boolean {
  if (view.byteLength < CONTROLS_PACKET_BYTES || view.getUint8(0) !== PacketType.Controls) {
    return false;
  }
  out.timeMs = view.getUint32(1);
  out.flags = view.getUint8(5);
  out.vent = view.getUint8(6) / 255;
  out.rudder = view.getInt16(7) / 32767;
  return true;
}

/**
 * Host's crate: type(1) time(4) phase u8(1) flags u8(1) winch f32(4)
 * lever u8(1) crate top x, y, z f32(12) swing x, z f32(8) condition u8(1)
 * knocks u8(1) resets u8(1).
 */
export const CARGO_PACKET_BYTES = 35;

/** Cargo packet flag bits: the hatch door is open; someone holds the winch, the tag line, the lever. */
export const CARGO_FLAG_DOOR = 1;
export const CARGO_FLAG_WINCH = 2;
export const CARGO_FLAG_TAG = 4;
export const CARGO_FLAG_LEVER = 8;

export interface CargoStatePacket {
  timeMs: number;
  /** An index into CARGO_PHASES (src/sim/cargo.ts). */
  phase: number;
  flags: number;
  /** The winch's angle, rad (sets the line out). */
  winch: number;
  /** The hatch lever's angle, rad (0 to about 0.7). */
  lever: number;
  /** The crate's top middle, ship space, m, and how fast it swings across the deck, m/s. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  /** Its condition, 0 to 100 %. */
  condition: number;
  /** Knocks so far (wrapping), so the guest hears each one. */
  knocks: number;
  /** Restarts so far (wrapping), so the guest drops its own hold on the old run's winch. */
  resets: number;
}

export function createCargoStatePacket(): CargoStatePacket {
  return { timeMs: 0, phase: 0, flags: 0, winch: 0, lever: 0, x: 0, y: 0, z: 0, vx: 0, vz: 0, condition: 100, knocks: 0, resets: 0 };
}

export function encodeCargo(buffer: ArrayBuffer, state: CargoStatePacket): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Cargo);
  view.setUint32(1, Math.floor(state.timeMs) >>> 0);
  view.setUint8(5, state.phase & 0xff);
  view.setUint8(6, state.flags & 0xff);
  view.setFloat32(7, state.winch);
  view.setUint8(11, Math.round(Math.max(0, Math.min(1, state.lever)) * 255));
  view.setFloat32(12, state.x);
  view.setFloat32(16, state.y);
  view.setFloat32(20, state.z);
  view.setFloat32(24, state.vx);
  view.setFloat32(28, state.vz);
  view.setUint8(32, Math.round(Math.max(0, Math.min(100, state.condition))));
  view.setUint8(33, state.knocks & 0xff);
  view.setUint8(34, state.resets & 0xff);
  return CARGO_PACKET_BYTES;
}

export function decodeCargo(view: DataView, out: CargoStatePacket): boolean {
  if (view.byteLength < CARGO_PACKET_BYTES || view.getUint8(0) !== PacketType.Cargo) {
    return false;
  }
  out.timeMs = view.getUint32(1);
  out.phase = view.getUint8(5);
  out.flags = view.getUint8(6);
  out.winch = view.getFloat32(7);
  out.lever = view.getUint8(11) / 255;
  out.x = view.getFloat32(12);
  out.y = view.getFloat32(16);
  out.z = view.getFloat32(20);
  out.vx = view.getFloat32(24);
  out.vz = view.getFloat32(28);
  out.condition = view.getUint8(32);
  out.knocks = view.getUint8(33);
  out.resets = view.getUint8(34);
  return true;
}

/**
 * The guest's hands on the cargo gear: type(1) time(4) flags u8(1) (the
 * CARGO_FLAG_WINCH, _TAG and _LEVER bits) winch f32(4) lever u8(1) tag hand
 * x, z i16 mm(4) resets u8(1).
 */
export const CARGO_HANDS_PACKET_BYTES = 16;

export interface CargoHandsPacket {
  timeMs: number;
  flags: number;
  /** The winch's angle as the guest's hand has turned it, rad. */
  winch: number;
  /** The lever's angle as the guest's hand holds it, rad. */
  lever: number;
  /** Where the guest's hand on the tag line is across the deck, ship space, m. */
  tagX: number;
  tagZ: number;
  /** The host's restarts the guest had heard of (a hand from an older run is ignored). */
  resets: number;
}

export function createCargoHandsPacket(): CargoHandsPacket {
  return { timeMs: 0, flags: 0, winch: 0, lever: 0, tagX: 0, tagZ: 0, resets: 0 };
}

export function encodeCargoHands(buffer: ArrayBuffer, state: CargoHandsPacket): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.CargoHands);
  view.setUint32(1, Math.floor(state.timeMs) >>> 0);
  view.setUint8(5, state.flags & 0xff);
  view.setFloat32(6, state.winch);
  view.setUint8(10, Math.round(Math.max(0, Math.min(1, state.lever)) * 255));
  view.setInt16(11, Math.round(Math.max(-32, Math.min(32, state.tagX)) * 1000));
  view.setInt16(13, Math.round(Math.max(-32, Math.min(32, state.tagZ)) * 1000));
  view.setUint8(15, state.resets & 0xff);
  return CARGO_HANDS_PACKET_BYTES;
}

export function decodeCargoHands(view: DataView, out: CargoHandsPacket): boolean {
  if (view.byteLength < CARGO_HANDS_PACKET_BYTES || view.getUint8(0) !== PacketType.CargoHands) {
    return false;
  }
  out.timeMs = view.getUint32(1);
  out.flags = view.getUint8(5);
  out.winch = view.getFloat32(6);
  out.lever = view.getUint8(10) / 255;
  out.tagX = view.getInt16(11) / 1000;
  out.tagZ = view.getInt16(13) / 1000;
  out.resets = view.getUint8(15);
  return true;
}

/** Crates in a crates packet. */
export const CRATES_IN_PACKET = 2;

/**
 * Host's crates: type(1) time(4) resets u8(1) knocks u8(1) hatch crate
 * u8(1, 255 none), then for each crate: state u8(1) holders u8(1, two bits
 * per handle: 0 nobody, else the crew index + 1) condition u8(1) x, y, z,
 * yaw f32(16).
 */
export const CRATES_PACKET_BYTES = 8 + CRATES_IN_PACKET * 19;

export interface CratePacketEntry {
  /** An index into CRATE_STATES (src/sim/stowage.ts). */
  state: number;
  /** Who holds each handle: -1 nobody, else the crew index. */
  holders: [number, number];
  condition: number;
  /** Bottom middle and yaw: ship space, or world for crates resting in the world. */
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface CratesPacket {
  timeMs: number;
  resets: number;
  knocks: number;
  /** Which crate is in the hatch, or -1. */
  hatch: number;
  crates: CratePacketEntry[];
}

export function createCratesPacket(): CratesPacket {
  const crates: CratePacketEntry[] = [];
  for (let i = 0; i < CRATES_IN_PACKET; i++) {
    crates.push({ state: 0, holders: [-1, -1], condition: 100, x: 0, y: 0, z: 0, yaw: 0 });
  }
  return { timeMs: 0, resets: 0, knocks: 0, hatch: -1, crates };
}

export function encodeCrates(buffer: ArrayBuffer, state: CratesPacket): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.Crates);
  view.setUint32(1, Math.floor(state.timeMs) >>> 0);
  view.setUint8(5, state.resets & 0xff);
  view.setUint8(6, state.knocks & 0xff);
  view.setUint8(7, state.hatch < 0 ? 255 : state.hatch & 0xff);
  let o = 8;
  for (let i = 0; i < CRATES_IN_PACKET; i++) {
    const c = state.crates[i];
    view.setUint8(o, c.state & 0xff);
    view.setUint8(o + 1, ((c.holders[0] + 1) & 3) | (((c.holders[1] + 1) & 3) << 2));
    view.setUint8(o + 2, Math.round(Math.max(0, Math.min(100, c.condition))));
    view.setFloat32(o + 3, c.x);
    view.setFloat32(o + 7, c.y);
    view.setFloat32(o + 11, c.z);
    view.setFloat32(o + 15, c.yaw);
    o += 19;
  }
  return CRATES_PACKET_BYTES;
}

export function decodeCrates(view: DataView, out: CratesPacket): boolean {
  if (view.byteLength < CRATES_PACKET_BYTES || view.getUint8(0) !== PacketType.Crates) {
    return false;
  }
  out.timeMs = view.getUint32(1);
  out.resets = view.getUint8(5);
  out.knocks = view.getUint8(6);
  const hatch = view.getUint8(7);
  out.hatch = hatch === 255 ? -1 : hatch;
  let o = 8;
  for (let i = 0; i < CRATES_IN_PACKET; i++) {
    const c = out.crates[i];
    c.state = view.getUint8(o);
    const holders = view.getUint8(o + 1);
    c.holders[0] = (holders & 3) - 1;
    c.holders[1] = ((holders >> 2) & 3) - 1;
    c.condition = view.getUint8(o + 2);
    c.x = view.getFloat32(o + 3);
    c.y = view.getFloat32(o + 7);
    c.z = view.getFloat32(o + 11);
    c.yaw = view.getFloat32(o + 15);
    o += 19;
  }
  return true;
}

/**
 * The guest's hands on crates: type(1) time(4) resets u8(1), then for its
 * left and right hands: crate u8(1, 255 none) handle u8(1) x, y, z f32(12),
 * ship space.
 */
export const CRATE_HANDS_PACKET_BYTES = 6 + 2 * 14;

export interface CrateHandEntry {
  /** Which crate, or -1 for none. */
  crate: number;
  handle: number;
  x: number;
  y: number;
  z: number;
}

export interface CrateHandsPacket {
  timeMs: number;
  /** The host's restarts the guest had heard of (a hand from an older run is ignored). */
  resets: number;
  hands: [CrateHandEntry, CrateHandEntry];
}

export function createCrateHandsPacket(): CrateHandsPacket {
  return {
    timeMs: 0,
    resets: 0,
    hands: [
      { crate: -1, handle: 0, x: 0, y: 0, z: 0 },
      { crate: -1, handle: 0, x: 0, y: 0, z: 0 },
    ],
  };
}

export function encodeCrateHands(buffer: ArrayBuffer, state: CrateHandsPacket): number {
  const view = new DataView(buffer);
  view.setUint8(0, PacketType.CrateHands);
  view.setUint32(1, Math.floor(state.timeMs) >>> 0);
  view.setUint8(5, state.resets & 0xff);
  let o = 6;
  for (const hand of state.hands) {
    view.setUint8(o, hand.crate < 0 ? 255 : hand.crate & 0xff);
    view.setUint8(o + 1, hand.handle & 0xff);
    view.setFloat32(o + 2, hand.x);
    view.setFloat32(o + 6, hand.y);
    view.setFloat32(o + 10, hand.z);
    o += 14;
  }
  return CRATE_HANDS_PACKET_BYTES;
}

export function decodeCrateHands(view: DataView, out: CrateHandsPacket): boolean {
  if (view.byteLength < CRATE_HANDS_PACKET_BYTES || view.getUint8(0) !== PacketType.CrateHands) {
    return false;
  }
  out.timeMs = view.getUint32(1);
  out.resets = view.getUint8(5);
  let o = 6;
  for (const hand of out.hands) {
    const crate = view.getUint8(o);
    hand.crate = crate === 255 ? -1 : crate;
    hand.handle = view.getUint8(o + 1);
    hand.x = view.getFloat32(o + 2);
    hand.y = view.getFloat32(o + 6);
    hand.z = view.getFloat32(o + 10);
    o += 14;
  }
  return true;
}
