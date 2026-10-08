import { createSystem, Vector3, VisibilityState } from '@iwsdk/core';
import { poseName } from '../sim/hand-pose.js';
import { createAvatarHand, crewCoat } from '../scene-assets/avatar.scene-asset.js';
import type { PosedHand } from '../scene-assets/hand.scene-asset.js';
import { handCurls } from './grip-system.js';
import { crewLook } from './net-system.js';

const SIDES = ['left', 'right'] as const;

/**
 * This player's own hands in VR: the same mittens and sleeves the crewmate
 * sees, in this player's coat colour, at each controller's (or tracked
 * hand's) grip pose, posed by the fingers on the controller (or the tracked
 * hand's own fingers; see GripSystem). They replace IWSDK's controller and hand models, which
 * are never loaded: on Quest 3 those are two 4,470-triangle controllers in
 * six draw calls each, downloaded from a CDN (about 430 KB) when a session
 * starts.
 */
export class OwnHandsSystem extends createSystem({}) {
  private hands!: Record<(typeof SIDES)[number], PosedHand>;
  private shownColor = -1;
  private scale = new Vector3();

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
      curls: (side: (typeof SIDES)[number]) => ({ ...handCurls[side] }),
      pose: (side: (typeof SIDES)[number]) => poseName(handCurls[side]),
    };
  }

  update(): void {
    if (crewLook.color !== this.shownColor) {
      this.shownColor = crewLook.color;
      for (const side of SIDES) {
        this.hands[side].setCoat(crewCoat(this.shownColor));
      }
    }
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    for (const side of SIDES) {
      const hand = this.hands[side].mesh;
      hand.visible = immersive && this.input.xr.getPrimaryInputSource(side) !== undefined;
      if (hand.visible) {
        const grip = this.player.gripSpaces[side];
        grip.updateWorldMatrix(true, false);
        grip.matrixWorld.decompose(hand.position, hand.quaternion, this.scale);
        this.hands[side].pose(handCurls[side]);
      }
    }
  }
}
