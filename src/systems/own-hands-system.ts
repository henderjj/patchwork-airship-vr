import { createSystem, Euler, Quaternion, Vector3, VisibilityState } from '@iwsdk/core';
import { copyCurls, createFingerCurls, poseName } from '../sim/hand-pose.js';
import { createAvatarHand, crewCoat } from '../scene-assets/avatar.scene-asset.js';
import type { PosedHand } from '../scene-assets/hand.scene-asset.js';
import { forcedRelease, handCurls, handUse } from './grip-system.js';
import { LOCK_SLIP, type LockBody, LockedHand } from './hand-lock.js';
import { crewLook, holdKindOf, netLink, NetSystem } from './net-system.js';

const SIDES = ['left', 'right'] as const;

/**
 * This player's own hands in VR: the same gloves and sleeves the crewmate
 * sees, in this player's coat colour, at each controller's (or tracked
 * hand's) grip pose, posed by the fingers on the controller (or the tracked
 * hand's own; see GripSystem). While a hand holds the crank, the line, the
 * tiller, the vent cord or the bell lanyard it is drawn closed on the handle
 * instead (grip locking, see hand-lock.ts), its arm angled back towards
 * where this player's elbow would be, and lets go if the real hand
 * strays more than LOCK_SLIP from it. The crewmate's hands are locked here
 * too, through NetSystem, so this runs after the systems that move the
 * controls.
 *
 * The hands replace IWSDK's controller and hand models, which are never
 * loaded: on Quest 3 those are two 4,470-triangle controllers in six draw
 * calls each, downloaded from a CDN (about 430 KB) when a session starts.
 */
export class OwnHandsSystem extends createSystem({}) {
  private hands!: Record<(typeof SIDES)[number], PosedHand>;
  private shownColor = -1;
  private scale = new Vector3();
  private gripPos = new Vector3();
  private gripQuat = new Quaternion();
  private locks = { left: new LockedHand('left'), right: new LockedHand('right') };
  /** Where this player's head is, for the angle of a locked hand's arm. */
  private body: LockBody = { head: new Vector3(), yaw: 0 };
  private headQuat = new Quaternion();
  private headEuler = new Euler();
  /** The fingers as drawn: the player's, closed round anything they hold. */
  private curls = { left: createFingerCurls(), right: createFingerCurls() };
  private net: NetSystem | undefined;

  init(): void {
    const adapters = this.input.xr.visualAdapters;
    for (const side of SIDES) {
      for (const adapter of [adapters.controller[side], adapters.hand[side]]) {
        // toggleVisual(false) doesn't stick in IWSDK 1.0.1: its input manager
        // sets the model visible again every frame. Skip loading the model,
        // which every use of it already allows for (it may fail to download).
        (adapter as unknown as { connectVisual(): void }).connectVisual = () => {};
      }
    }
    this.shownColor = crewLook.color;
    this.hands = {
      left: createAvatarHand(this.shownColor, 'left'),
      right: createAvatarHand(this.shownColor, 'right'),
    };
    for (const side of SIDES) {
      this.hands[side].mesh.visible = false;
      this.world.createTransformEntity(this.hands[side].mesh);
    }
    (window as { __ownHands?: unknown }).__ownHands = {
      shown: () => SIDES.filter((side) => this.hands[side].mesh.visible),
      inputModels: () => SIDES.filter((side) => adapters.controller[side].visual ?? adapters.hand[side].visual),
      color: () => this.shownColor,
      position: (side: (typeof SIDES)[number]) => this.hands[side].mesh.position.toArray(),
      /** The middle of the drawn fist, where a held handle runs. */
      fist: (side: (typeof SIDES)[number]) => this.hands[side].fistCentre(new Vector3()).toArray(),
      /** Which way the drawn forearm points. */
      forearm: (side: (typeof SIDES)[number]) => this.hands[side].forearm(new Vector3()).toArray(),
      curls: (side: (typeof SIDES)[number]) => ({ ...handCurls[side] }),
      /** How far each hand is eased onto what it holds (0 at the controller, 1 on the handle). */
      locked: (side: (typeof SIDES)[number]) => this.locks[side].blend,
      pose: (side: (typeof SIDES)[number]) => poseName(handCurls[side]),
    };
  }

  update(delta: number): void {
    const dt = Math.min(delta, 0.1);
    if (crewLook.color !== this.shownColor) {
      this.shownColor = crewLook.color;
      for (const side of SIDES) {
        this.hands[side].setCoat(crewCoat(this.shownColor));
      }
    }
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    const flags = (netLink.extraFlags.crank ?? 0) | (netLink.extraFlags.rope ?? 0);
    if (immersive) {
      const head = this.player.head;
      head.updateWorldMatrix(true, false);
      head.matrixWorld.decompose(this.body.head, this.headQuat, this.scale);
      this.body.yaw = this.headEuler.setFromQuaternion(this.headQuat, 'YXZ').y;
    }
    for (const side of SIDES) {
      const hand = this.hands[side].mesh;
      hand.visible = immersive && this.input.xr.getPrimaryInputSource(side) !== undefined;
      if (hand.visible) {
        const grip = this.player.gripSpaces[side];
        grip.updateWorldMatrix(true, false);
        grip.matrixWorld.decompose(this.gripPos, this.gripQuat, this.scale);
        const curls = copyCurls(handCurls[side], this.curls[side]);
        const lock = this.locks[side];
        lock.update(dt, holdKindOf(side, flags, handUse[side]), this.gripPos, this.gripQuat, hand.position, hand.quaternion, curls, this.body);
        if (lock.strain > LOCK_SLIP) {
          forcedRelease[side] = true;
        }
        this.hands[side].pose(curls);
      }
    }
    this.net ??= this.world.getSystem(NetSystem);
    this.net?.lockCrewHands(dt);
  }
}
