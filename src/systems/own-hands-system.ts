import { createSystem, Mesh, Vector3, VisibilityState } from '@iwsdk/core';
import { avatarHandGeometry, createAvatarHand } from '../scene-assets/avatar.scene-asset.js';
import { crewLook } from './net-system.js';

const SIDES = ['left', 'right'] as const;

/**
 * This player's own hands in VR: the same mittens and sleeves the crewmate
 * sees, in this player's coat colour, at each controller's (or tracked
 * hand's) grip pose. They replace IWSDK's controller and hand models, which
 * are downloaded from a CDN when a session starts and may never arrive.
 */
export class OwnHandsSystem extends createSystem({}) {
  private hands!: Record<(typeof SIDES)[number], Mesh>;
  private shownColor = -1;
  private scale = new Vector3();

  init(): void {
    const adapters = this.input.xr.visualAdapters;
    for (const side of SIDES) {
      adapters.controller[side].toggleVisual(false);
      adapters.hand[side].toggleVisual(false);
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
      color: () => this.shownColor,
      position: (side: (typeof SIDES)[number]) => this.hands[side].position.toArray(),
    };
  }

  update(): void {
    if (crewLook.color !== this.shownColor) {
      this.shownColor = crewLook.color;
      for (const side of SIDES) {
        this.hands[side].geometry.dispose();
        this.hands[side].geometry = avatarHandGeometry(this.shownColor);
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
