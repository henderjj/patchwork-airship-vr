import { Quaternion, Vector3 } from '@iwsdk/core';
import type { FingerCurls } from '../sim/hand-pose.js';

/**
 * Grip locking (Phase 3 step 0, see docs/hands.md): while a hand holds the
 * crank, the mooring line, the tiller, the vent cord or the bell lanyard,
 * its glove is drawn closed on the handle rather than at the controller,
 * turned only as far as it takes to lie along the handle (so the
 * controller's twist about the handle still shows). It eases between the
 * two over 80 ms on taking hold and letting go.
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

/** Taking hold or letting go eases the drawn hand over this long, s. */
export const LOCK_EASE = 0.08;
/** A hand further than this from what it holds lets go, so the drawn hand never stretches far from the real one, m. */
export const LOCK_SLIP = 0.25;
/** The pose a hand takes on a handle. */
const CLOSED: FingerCurls = { index: 0.9, grip: 1, thumb: 1 };

/** One hand's locking state: where it was last held, and how far it is eased onto it. */
export class LockedHand {
  /** 0 at the controller, 1 on the handle. */
  blend = 0;
  /** The real hand's distance from the handle it holds this frame, m (0 when it holds nothing lockable). */
  strain = 0;
  private point = new Vector3();
  private axis = new Vector3(0, 0, -1);
  private handAxis = new Vector3();
  private turn = new Quaternion();
  private lockQuat = new Quaternion();
  private holding = false;
  private sign = 1;

  /**
   * Work out the drawn pose for a hand at `pos`/`quat` (its grip pose) that
   * holds `kind`, into `outPos`/`outQuat` (which may be `pos`/`quat`), and
   * close `curls` round the handle as far as it is eased on. No allocation.
   */
  update(dt: number, kind: number, pos: Vector3, quat: Quaternion, outPos: Vector3, outQuat: Quaternion, curls: FingerCurls | null): void {
    const resolver = kind === HoldKind.None ? undefined : lockResolvers.get(kind);
    this.handAxis.set(0, 0, -1).applyQuaternion(quat);
    if (resolver) {
      resolver(pos, this.point, this.axis);
      // Grip it the way round the hand faces as it takes hold, and keep to that.
      if (!this.holding) {
        this.sign = this.handAxis.dot(this.axis) < 0 ? -1 : 1;
      }
      if (this.sign < 0) {
        this.axis.negate();
      }
      this.holding = true;
      this.strain = pos.distanceTo(this.point);
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
    this.turn.setFromUnitVectors(this.handAxis, this.axis);
    this.lockQuat.multiplyQuaternions(this.turn, quat);
    const b = this.blend;
    const t = b * b * (3 - 2 * b);
    outPos.lerpVectors(pos, this.point, t);
    outQuat.slerpQuaternions(quat, this.lockQuat, t);
    if (curls) {
      curls.index += (Math.max(curls.index, CLOSED.index) - curls.index) * t;
      curls.grip += (CLOSED.grip - curls.grip) * t;
      curls.thumb += (Math.max(curls.thumb, CLOSED.thumb) - curls.thumb) * t;
    }
  }
}
