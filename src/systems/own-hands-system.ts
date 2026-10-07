import { createSystem, Mesh, Vector3, VisibilityState } from '@iwsdk/core';
import { avatarHandGeometry, createAvatarHand } from '../scene-assets/avatar.scene-asset.js';
import { crewLook } from './net-system.js';

const SIDES = ['left', 'right'] as const;

/**
 * This player's own hands in VR: the same mittens and sleeves the crewmate
 * sees, in this player's coat colour, at each controller's (or tracked
 * hand's) grip pose. They replace IWSDK's controller and hand models, which
 * are never loaded: on Quest 3 those are two 4,470-triangle controllers in
 * six draw calls each, downloaded from a CDN (about 430 KB) when a session
 * starts.
 */
export class OwnHandsSystem extends createSystem({}) {
  private hands!: Record<(typeof SIDES)[number], Mesh>;
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
      this.hands[side].visible = false;
      this.world.createTransformEntity(this.hands[side]);
    }
    (window as { __ownHands?: unknown }).__ownHands = {
      shown: () => SIDES.filter((side) => this.hands[side].visible),
      inputModels: () => SIDES.filter((side) => adapters.controller[side].visual ?? adapters.hand[side].visual),
      color: () => this.shownColor,
      position: (side: (typeof SIDES)[number]) => this.hands[side].position.toArray(),
    };
  }

  update(): void {
    if (crewLook.color !== this.shownColor) {
      this.shownColor = crewLook.color;
      for (const side of SIDES) {
        this.hands[side].geometry.dispose();
        this.hands[side].geometry = avatarHandGeometry(this.shownColor, side);
      }
    }
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    for (const side of SIDES) {
      const hand = this.hands[side];
      hand.visible = immersive && this.input.xr.getPrimaryInputSource(side) !== undefined;
      if (hand.visible) {
        const grip = this.player.gripSpaces[side];
        grip.updateWorldMatrix(true, false);
        grip.matrixWorld.decompose(hand.position, hand.quaternion, this.scale);
      }
    }
  }
}
