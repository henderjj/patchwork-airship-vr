import {
  Bone,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  Matrix4,
  MeshLambertMaterial,
  Object3D,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  Vector3,
} from '@iwsdk/core';
import type { FingerCurls } from '../sim/hand-pose.js';
import { mergeParts, type Part, shade } from './lowpoly.js';

/**
 * Low-poly gloved hands that take a pose (Phase 3 step 0, see docs/hands.md):
 * a palm, three box segments per finger and three for the thumb, each
 * weighted fully to one bone of a 16-bone skeleton (rigid skinning, so the
 * faceted look stays and nothing needs weight painting). About 300
 * triangles and one draw call per hand. The pose is three curls (index,
 * the other fingers, thumb), so posing a hand sets 15 bone rotations.
 *
 * Built in the WebXR hand-joint frame of a right wrist: origin at the
 * wrist, fingers towards -Z, back of the hand +Y, thumb on the -X side,
 * forearm back along +Z. The mesh is drawn at a controller's (or tracked
 * hand's) grip pose: the root bone carries the wrist's place in grip space,
 * and a left hand is the right one mirrored, as the grip spaces are.
 */

const LEATHER = 0x6a4a30;

type Vec3 = readonly [number, number, number];

interface FingerSpec {
  /** Knuckle, in the wrist frame. */
  base: Vec3;
  /** Proximal, middle and distal segment lengths, m. */
  lengths: Vec3;
  width: number;
  /** Sideways spread of the open hand, rad (positive towards the thumb). */
  splay: number;
}

const FINGERS: readonly FingerSpec[] = [
  { base: [-0.0295, -0.009, -0.093], lengths: [0.042, 0.026, 0.022], width: 0.021, splay: 0.08 },
  { base: [-0.0095, -0.009, -0.097], lengths: [0.046, 0.029, 0.024], width: 0.021, splay: 0.02 },
  { base: [0.0105, -0.009, -0.094], lengths: [0.043, 0.027, 0.022], width: 0.02, splay: -0.04 },
  { base: [0.0295, -0.011, -0.086], lengths: [0.034, 0.021, 0.019], width: 0.018, splay: -0.11 },
];
/** Bend of each finger joint when fully curled, rad: knuckle, middle and end joints. */
const FINGER_BEND: Vec3 = [1.45, 1.75, 0.9];
/** How much of the spread is left in a closed hand. */
const CLOSED_SPLAY = 0.3;

const THUMB_BASE: Vec3 = [-0.027, -0.021, -0.024];
const THUMB_LENGTHS: Vec3 = [0.038, 0.031, 0.026];
const THUMB_WIDTH = 0.023;
/**
 * The thumb's first bone, lifted (out to the side, along the palm) and down
 * (over the front of the curled fingers, as round a controller's handle):
 * the way it points, and the side its pad faces, towards which it bends.
 */
const THUMB_LIFTED = { dir: [-0.6, 0.2, -0.77] as Vec3, pad: [0.55, -0.83, 0] as Vec3 };
const THUMB_DOWN = { dir: [-0.38, -0.42, -0.82] as Vec3, pad: [1, -0.1, 0] as Vec3 };
/** Bend of the thumb's two outer joints, lifted and down, rad. */
const THUMB_BEND_LIFTED: readonly [number, number] = [0.1, 0.08];
const THUMB_BEND_DOWN: readonly [number, number] = [0.75, 0.6];

/** Bone order: 0 wrist, then 3 per finger (index first), then 3 for the thumb. */
export const HAND_BONES = 1 + FINGERS.length * 3 + 3;
const THUMB_BONE = 1 + FINGERS.length * 3;
/** Segments overlap past each joint by this much, so a bent joint shows no notch, m. */
const OVERLAP = 0.008;

/**
 * Where a right wrist sits in its controller's grip space, from IWSDK's
 * controller-hand pose for a squeezed grip (AnimatedControllerHand). The grip
 * space has its origin in the middle of the fist, -Z along the handle
 * towards the thumb and +X out of the back of a right hand, so the forearm
 * leaves the fist up and back along +Y and +Z rather than straight back.
 */
const WRIST_IN_GRIP = new Matrix4().fromArray([
  -0.19326625764369965, -0.700115978717804, 0.6873756647109985, 0,
  0.9811022877693176, -0.13126900792121887, 0.14215001463890076, 0,
  -0.009290123358368874, 0.7018587589263916, 0.7122553586959839, 0,
  0.04728994518518448, 0.03910332918167114, 0.07807964831590652, 1,
]);
const MIRROR_X = new Matrix4().makeScale(-1, 1, 1);

/**
 * The closed fist in a right hand's grip space, for drawing it round a
 * handle (grip locking): the axis of the hole the curled fingers make, from
 * the little finger towards the thumb (the wrist's -X, about which the
 * fingers bend), the way the forearm leaves the wrist (the wrist's +Z), and
 * the middle of the hole, measured from the fingers' joints in a fist. The
 * hole runs 47° off the grip space's -Z. A left hand's are these mirrored in X.
 */
export const FIST_AXIS: readonly [number, number, number] = [0.19326625764369965, 0.700115978717804, -0.6873756647109985];
export const FOREARM: readonly [number, number, number] = [-0.009290123358368874, 0.7018587589263916, 0.7122553586959839];
export const FIST_CENTRE: readonly [number, number, number] = [0.016, -0.019, 0.011];

const xAxis = new Vector3();
const yAxis = new Vector3();
const zAxis = new Vector3();
const basis = new Matrix4();

/** The rotation whose -Z points along `dir` and whose +X leans towards `pad`. */
function aim(dir: Vec3, pad: Vec3, out: Quaternion): Quaternion {
  zAxis.set(-dir[0], -dir[1], -dir[2]).normalize();
  xAxis.set(pad[0], pad[1], pad[2]);
  xAxis.addScaledVector(zAxis, -xAxis.dot(zAxis)).normalize();
  yAxis.crossVectors(zAxis, xAxis);
  basis.makeBasis(xAxis, yAxis, zAxis);
  return out.setFromRotationMatrix(basis);
}

const thumbLifted = aim(THUMB_LIFTED.dir, THUMB_LIFTED.pad, new Quaternion());
const thumbDown = aim(THUMB_DOWN.dir, THUMB_DOWN.pad, new Quaternion());

/**
 * The hand's bones, in bone order, with the root at the wrist's grip-space
 * pose for `side`. Finger bones bend about their own X axis (curling
 * towards the palm, -Y) and spread about Y; the thumb's bend about Y
 * (towards its pad, +X).
 */
function createBones(side: 'left' | 'right'): Bone[] {
  const bones: Bone[] = [];
  const root = new Bone();
  root.name = 'wrist';
  const place = side === 'left' ? new Matrix4().multiplyMatrices(MIRROR_X, WRIST_IN_GRIP) : WRIST_IN_GRIP;
  place.decompose(root.position, root.quaternion, root.scale);
  bones.push(root);
  for (const finger of FINGERS) {
    let parent: Bone = root;
    for (let s = 0; s < 3; s++) {
      const bone = new Bone();
      bone.rotation.order = 'YXZ';
      if (s === 0) {
        bone.position.set(...finger.base);
      } else {
        bone.position.set(0, 0, -finger.lengths[s - 1]);
      }
      parent.add(bone);
      bones.push(bone);
      parent = bone;
    }
  }
  let parent: Bone = root;
  for (let s = 0; s < 3; s++) {
    const bone = new Bone();
    if (s === 0) {
      bone.position.set(...THUMB_BASE);
    } else {
      bone.position.set(0, 0, -THUMB_LENGTHS[s - 1]);
    }
    parent.add(bone);
    bones.push(bone);
    parent = bone;
  }
  return bones;
}

/** Set the bones' rotations for a pose. No allocation. */
function poseBones(bones: readonly Bone[], curls: FingerCurls): void {
  for (let f = 0; f < FINGERS.length; f++) {
    const curl = f === 0 ? curls.index : curls.grip;
    const splay = FINGERS[f].splay * (1 - (1 - CLOSED_SPLAY) * curls.grip);
    for (let s = 0; s < 3; s++) {
      bones[1 + f * 3 + s].rotation.set(-curl * FINGER_BEND[s], s === 0 ? splay : 0, 0);
    }
  }
  const t = curls.thumb;
  bones[THUMB_BONE].quaternion.slerpQuaternions(thumbLifted, thumbDown, t);
  for (let s = 1; s < 3; s++) {
    const bend = THUMB_BEND_LIFTED[s - 1] + (THUMB_BEND_DOWN[s - 1] - THUMB_BEND_LIFTED[s - 1]) * t;
    bones[THUMB_BONE + s].rotation.set(0, -bend, 0);
  }
}

/** The pose the mesh is built in: an open hand, thumb lifted. */
const BIND_POSE: FingerCurls = { index: 0, grip: 0, thumb: 0 };

/** A segment along its bone's -Z, from just behind the joint to its length. */
function segment(length: number, width: number, height: number, color: number): Part {
  return {
    geometry: new BoxGeometry(width, height, length + OVERLAP),
    color,
    position: [0, 0, -(length - OVERLAP) / 2],
  };
}

/** Each bone's parts, in that bone's own frame. */
function boneParts(coat: number): Part[][] {
  const parts: Part[][] = [];
  parts.push([
    // Back of the hand, a little wider at the knuckles, and the heel of the thumb under it.
    { geometry: new BoxGeometry(0.084, 0.03, 0.085), color: LEATHER, position: [0, -0.008, -0.05] },
    { geometry: new BoxGeometry(0.088, 0.022, 0.02), color: shade(LEATHER, 0.85), position: [0, -0.004, -0.088] },
    { geometry: new BoxGeometry(0.03, 0.028, 0.05), color: LEATHER, position: [-0.026, -0.024, -0.035], rotation: [0, 0.35, 0] },
    // Gauntlet cuff, then the forearm in its sleeve back towards the elbow,
    // which suggests an arm without needing to work out where the elbow is.
    { geometry: new CylinderGeometry(0.05, 0.042, 0.05, 7), color: LEATHER, position: [0, -0.005, 0.02], rotation: [Math.PI / 2, 0, 0], scale: [1, 1, 0.8] },
    { geometry: new CylinderGeometry(0.052, 0.042, 0.2, 7), color: coat, position: [0, -0.005, 0.14], rotation: [Math.PI / 2, 0, 0], scale: [1, 1, 0.85] },
  ]);
  for (const finger of FINGERS) {
    for (let s = 0; s < 3; s++) {
      const taper = 1 - 0.07 * s;
      parts.push([segment(finger.lengths[s], finger.width * taper, 0.0205 * taper, s === 2 ? shade(LEATHER, 0.92) : LEATHER)]);
    }
  }
  for (let s = 0; s < 3; s++) {
    const taper = 1 - 0.08 * s;
    parts.push([segment(THUMB_LENGTHS[s], THUMB_WIDTH * taper, 0.02 * taper, s === 2 ? shade(LEATHER, 0.92) : LEATHER)]);
  }
  return parts;
}

/**
 * The hand's triangles in grip space at `pose`, with each vertex's bone in
 * `skinIndex`, for side `side`. Built from a fresh skeleton, so it's
 * deterministic (asset modules are evaluated in two realms).
 */
function posedGeometry(coat: number, side: 'left' | 'right', pose: FingerCurls): BufferGeometry {
  const bones = createBones(side);
  poseBones(bones, pose);
  bones[0].updateMatrixWorld(true);
  const groups = boneParts(coat);
  const merged = groups.map((parts, bone) => {
    const geometry = mergeParts(parts);
    geometry.applyMatrix4(bones[bone].matrixWorld);
    return geometry;
  });
  let count = 0;
  for (const g of merged) {
    count += g.getAttribute('position').count;
  }
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  let v = 0;
  merged.forEach((g, bone) => {
    const pos = g.getAttribute('position');
    const col = g.getAttribute('color');
    positions.set(pos.array as ArrayLike<number>, v * 3);
    colors.set(col.array as ArrayLike<number>, v * 3);
    for (let i = 0; i < pos.count; i++) {
      skinIndex[(v + i) * 4] = bone;
      skinWeight[(v + i) * 4] = 1;
    }
    v += pos.count;
    g.dispose();
  });
  if (side === 'left') {
    // Mirrored: swap two corners of every triangle so it faces outwards again.
    for (const array of [positions, colors]) {
      for (let tri = 0; tri < count; tri += 3) {
        for (let k = 0; k < 3; k++) {
          const a = array[(tri + 1) * 3 + k];
          array[(tri + 1) * 3 + k] = array[(tri + 2) * 3 + k];
          array[(tri + 2) * 3 + k] = a;
        }
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A gloved hand and sleeve for drawing at a grip pose, in coat colour `coat` (hex), built open. */
export function handGeometry(coat: number, side: 'left' | 'right'): BufferGeometry {
  return posedGeometry(coat, side, BIND_POSE);
}

/**
 * A hand fixed in one pose as plain geometry in the right wrist's frame
 * (fingers -Z, back +Y), for merging into a static mesh such as the
 * stress-test dummy.
 */
export function staticHandGeometry(coat: number, pose: FingerCurls): BufferGeometry {
  const geometry = posedGeometry(coat, 'right', pose);
  geometry.deleteAttribute('skinIndex');
  geometry.deleteAttribute('skinWeight');
  geometry.applyMatrix4(new Matrix4().copy(WRIST_IN_GRIP).invert());
  return geometry;
}

/**
 * One posable hand: a skinned mesh to place at a grip pose each frame, and
 * `pose()` to set its fingers.
 */
export class PosedHand {
  readonly mesh: SkinnedMesh;
  private readonly bones: Bone[];

  constructor(coat: number, readonly side: 'left' | 'right') {
    this.bones = createBones(side);
    poseBones(this.bones, BIND_POSE);
    this.mesh = new SkinnedMesh(handGeometry(coat, side), new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.mesh.add(this.bones[0]);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new Skeleton(this.bones), new Matrix4());
    // Culling uses the open hand's bounds, which hold every pose.
    this.mesh.computeBoundingSphere();
  }

  /** Bend the fingers to `curls`. */
  pose(curls: FingerCurls): void {
    poseBones(this.bones, curls);
  }

  /** Dress the sleeve in another coat colour (hex). */
  setCoat(coat: number): void {
    this.mesh.geometry.dispose();
    this.mesh.geometry = handGeometry(coat, this.side);
  }

  /** The middle of the closed fist, where a held handle runs, in the mesh's parent's space. */
  fistCentre(out: Vector3): Vector3 {
    out.set(FIST_CENTRE[0] * (this.side === 'left' ? -1 : 1), FIST_CENTRE[1], FIST_CENTRE[2]);
    return out.applyQuaternion(this.mesh.quaternion).add(this.mesh.position);
  }

  /** Which way the forearm leaves the wrist, in the mesh's parent's space. */
  forearm(out: Vector3): Vector3 {
    out.set(FOREARM[0] * (this.side === 'left' ? -1 : 1), FOREARM[1], FOREARM[2]);
    return out.applyQuaternion(this.mesh.quaternion);
  }

  /** Where a bone is, in the mesh's space, for tests. */
  boneOrigin(bone: number, out: Vector3): Vector3 {
    this.mesh.updateMatrixWorld(true);
    tmpObject.matrix.copy(this.mesh.matrixWorld).invert();
    return out.setFromMatrixPosition(this.bones[bone].matrixWorld).applyMatrix4(tmpObject.matrix);
  }
}

const tmpObject = new Object3D();
