import { Matrix4, Quaternion, Vector3 } from '@iwsdk/core';
import { FIST_AXIS, FIST_CENTRE, FOREARM } from '../scene-assets/hand.scene-asset.js';
import type { FingerCurls } from '../sim/hand-pose.js';

/**
 * Grip locking (Phase 3 step 0, see docs/hands.md): while a hand holds the
 * crank, the mooring line, the tiller, the vent cord or the bell lanyard,
 * its glove is drawn closed on the handle rather than at the controller,
 * with the handle through the middle of the fist and the forearm angled
 * back towards where the player's elbow would be. It eases between the two
 * over 80 ms on taking hold and letting go.
 *
 * The systems that own the controls say where each one is held by
 * registering a resolver for its kind; OwnHandsSystem locks this player's
 * hands and NetSystem the crewmate's, from which control each hand holds.
 */

/** What a hand holds, as sent to the crewmate (four bits per hand). */
export const HoldKind = {
  None: 0,
  Crank: 1,
  Rope: 2,
  Tiller: 3,
  Vent: 4,
  Bell: 5,
} as const;

/**
 * Where a hand at `hand` (scene space) holding a control grips it: the point
 * on the handle's centre line its palm closes round, and which way the
 * handle runs (unit, either sign).
 */
export type LockResolver = (hand: Vector3, point: Vector3, axis: Vector3) => void;

/** Resolvers by `HoldKind`, registered by the systems that own the controls. */
export const lockResolvers = new Map<number, LockResolver>();

/**
 * Kinds held like a rope rather than a rigid bar: the forearm points at the
 * elbow and the line runs through the fist as near along its length as that
 * allows, so hauling hands lean back the way they pull. On a bar the handle
 * runs straight through the fist and the forearm turns about it.
 */
const FLEXIBLE = new Set<number>([HoldKind.Rope]);

/** Taking hold or letting go eases the drawn hand over this long, s. */
export const LOCK_EASE = 0.08;
/** A hand further than this from what it holds lets go, so the drawn hand never stretches far from the real one, m. */
export const LOCK_SLIP = 0.25;
/** The pose a hand takes on a handle. */
const CLOSED: FingerCurls = { index: 0.9, grip: 1, thumb: 1 };

/**
 * Where a crew member's shoulders are from their eyes, facing -Z (m, the
 * right shoulder; the avatar's coat is built round these), and how long the
 * upper arm and the forearm to the middle of the fist are.
 */
const SHOULDER = [0.165, -0.23, 0.09] as const;
const UPPER_ARM = 0.29;
const FOREARM_LENGTH = 0.3;
/** The way elbows bend out of the line from shoulder to hand: out to the side, down and back (right arm, facing -Z). */
const ELBOW_POLE = [0.6, -1, 0.35] as const;

/** Where a player's head is, for working out the angle of their arms. */
export interface LockBody {
  /** Eye centre, scene space. */
  head: Vector3;
  /** Heading, radians about Y (0 faces -Z). */
  yaw: number;
}

/** One hand's locking state: where it was last held, and how far it is eased onto it. */
export class LockedHand {
  /** 0 at the controller, 1 on the handle. */
  blend = 0;
  /** The real hand's distance from the handle it holds this frame, m (0 when it holds nothing lockable). */
  strain = 0;
  /** The fist's hole axis, forearm and centre in this hand's grip space. */
  private readonly fistAxis: Vector3;
  private readonly forearm: Vector3;
  private readonly centre: Vector3;
  /** Grip space basis (hole axis, forearm, their cross product), for building the locked turn. */
  private readonly localBasis = new Matrix4();
  private readonly mirror: number;
  private point = new Vector3();
  private axis = new Vector3(0, 0, -1);
  private kind: number = HoldKind.None;
  private handAxis = new Vector3();
  private fist = new Vector3();
  private turn = new Quaternion();
  private lockQuat = new Quaternion();
  private lockPos = new Vector3();
  private holding = false;
  private sign = 1;
  private shoulder = new Vector3();
  private elbow = new Vector3();
  private reach = new Vector3();
  private pole = new Vector3();
  private aimAxis = new Vector3();
  private aimArm = new Vector3();
  private aimCross = new Vector3();
  private worldBasis = new Matrix4();

  constructor(readonly side: 'left' | 'right' = 'right') {
    this.mirror = side === 'left' ? -1 : 1;
    const m = this.mirror;
    this.fistAxis = new Vector3(FIST_AXIS[0] * m, FIST_AXIS[1], FIST_AXIS[2]).normalize();
    this.forearm = new Vector3(FOREARM[0] * m, FOREARM[1], FOREARM[2]);
    this.forearm.addScaledVector(this.fistAxis, -this.forearm.dot(this.fistAxis)).normalize();
    this.centre = new Vector3(FIST_CENTRE[0] * m, FIST_CENTRE[1], FIST_CENTRE[2]);
    const cross = new Vector3().crossVectors(this.fistAxis, this.forearm);
    // Orthonormal, so its inverse is its transpose.
    this.localBasis.makeBasis(this.fistAxis, this.forearm, cross).transpose();
  }

  /**
   * Work out the drawn pose for a hand at `pos`/`quat` (its grip pose) that
   * holds `kind`, into `outPos`/`outQuat` (which may be `pos`/`quat`), and
   * close `curls` round the handle as far as it is eased on. With `body`,
   * the forearm points back towards the elbow of an arm reaching from that
   * player's shoulder; without it, the hand is turned only as far as it
   * takes to lie along the handle. No allocation.
   */
  update(
    dt: number,
    kind: number,
    pos: Vector3,
    quat: Quaternion,
    outPos: Vector3,
    outQuat: Quaternion,
    curls: FingerCurls | null,
    body: LockBody | null = null,
  ): void {
    const resolver = kind === HoldKind.None ? undefined : lockResolvers.get(kind);
    this.handAxis.copy(this.fistAxis).applyQuaternion(quat);
    this.fist.copy(this.centre).applyQuaternion(quat).add(pos);
    if (resolver) {
      resolver(this.fist, this.point, this.axis);
      // Grip it the way round the hand faces as it takes hold, and keep to that.
      if (!this.holding || kind !== this.kind) {
        this.sign = this.handAxis.dot(this.axis) < 0 ? -1 : 1;
      }
      if (this.sign < 0) {
        this.axis.negate();
      }
      this.holding = true;
      this.kind = kind;
      this.strain = this.fist.distanceTo(this.point);
      this.blend = Math.min(1, this.blend + dt / LOCK_EASE);
    } else {
      this.holding = false;
      this.strain = 0;
      this.blend = Math.max(0, this.blend - dt / LOCK_EASE);
    }
    if (this.blend <= 0) {
      if (outPos !== pos) outPos.copy(pos);
      if (outQuat !== quat) outQuat.copy(quat);
      return;
    }
    // Letting go: ease back from the handle where it was last held.
    if (!body || !this.aim(body)) {
      this.turn.setFromUnitVectors(this.handAxis, this.axis);
      this.lockQuat.multiplyQuaternions(this.turn, quat);
    }
    // The middle of the fist on the handle.
    this.lockPos.copy(this.centre).applyQuaternion(this.lockQuat);
    this.lockPos.subVectors(this.point, this.lockPos);
    const b = this.blend;
    const t = b * b * (3 - 2 * b);
    outPos.lerpVectors(pos, this.lockPos, t);
    outQuat.slerpQuaternions(quat, this.lockQuat, t);
    if (curls) {
      curls.index += (Math.max(curls.index, CLOSED.index) - curls.index) * t;
      curls.grip += (CLOSED.grip - curls.grip) * t;
      curls.thumb += (Math.max(curls.thumb, CLOSED.thumb) - curls.thumb) * t;
    }
  }

  /**
   * Set `lockQuat` so the handle runs through the fist and the forearm
   * points at the elbow of an arm reaching from `body`'s shoulder to the
   * handle. False if the arm is too bunched up to say.
   */
  private aim(body: LockBody): boolean {
    const m = this.mirror;
    const sin = Math.sin(body.yaw);
    const cos = Math.cos(body.yaw);
    // Turn a body-space vector (facing -Z) by the heading.
    const turn = (out: Vector3, x: number, y: number, z: number) => out.set(x * cos + z * sin, y, -x * sin + z * cos);
    turn(this.shoulder, SHOULDER[0] * m, SHOULDER[1], SHOULDER[2]).add(body.head);
    // The elbow: two-bone reach from the shoulder to the handle, bent out towards the pole.
    this.reach.subVectors(this.point, this.shoulder);
    const length = this.reach.length();
    if (length < 0.05) {
      return false;
    }
    this.reach.divideScalar(length);
    const d = Math.min(length, UPPER_ARM + FOREARM_LENGTH - 0.001);
    const along = (UPPER_ARM * UPPER_ARM - FOREARM_LENGTH * FOREARM_LENGTH + d * d) / (2 * d);
    const out = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - along * along));
    turn(this.pole, ELBOW_POLE[0] * m, ELBOW_POLE[1], ELBOW_POLE[2]);
    this.pole.addScaledVector(this.reach, -this.pole.dot(this.reach));
    if (this.pole.lengthSq() < 1e-6) {
      this.pole.set(0, -1, 0);
    }
    this.pole.normalize();
    this.elbow.copy(this.shoulder).addScaledVector(this.reach, along).addScaledVector(this.pole, out);
    this.aimArm.subVectors(this.elbow, this.point);
    if (this.aimArm.lengthSq() < 1e-6) {
      return false;
    }
    this.aimArm.normalize();
    this.aimAxis.copy(this.axis);
    if (FLEXIBLE.has(this.kind)) {
      // A rope: the forearm points at the elbow, and the line runs as near along it as that allows.
      this.aimAxis.addScaledVector(this.aimArm, -this.aimAxis.dot(this.aimArm));
      if (this.aimAxis.lengthSq() < 1e-6) {
        return false;
      }
      this.aimAxis.normalize();
    } else {
      // A bar: it runs straight through the fist, and the forearm turns about it towards the elbow.
      this.aimArm.addScaledVector(this.aimAxis, -this.aimArm.dot(this.aimAxis));
      if (this.aimArm.lengthSq() < 1e-6) {
        return false;
      }
      this.aimArm.normalize();
    }
    this.aimCross.crossVectors(this.aimAxis, this.aimArm);
    this.worldBasis.makeBasis(this.aimAxis, this.aimArm, this.aimCross).multiply(this.localBasis);
    this.lockQuat.setFromRotationMatrix(this.worldBasis);
    return true;
  }
}
