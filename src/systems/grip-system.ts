import { createSystem, InputComponent } from '@iwsdk/core';
import { HandGrip, JOINT_COUNT } from '../sim/hand-grip.js';
import { settings } from '../settings.js';

type Side = 'left' | 'right';
const SIDES: readonly Side[] = ['left', 'right'];

/** WebXR Hand Input's batch call, missing from the TypeScript DOM types. */
type FillPoses = (spaces: readonly XRSpace[], base: XRSpace, out: Float32Array) => boolean;

export interface GripState {
  /** Held this frame. */
  pressed: boolean;
  /** Started this frame. */
  down: boolean;
  /** The hand is tracked as a hand rather than a controller. */
  hand: boolean;
}

/**
 * Grip for each hand this frame, from the controller's grip button or, with
 * hand tracking, from a fist or a pinch. The crank, rope and throwables read
 * this instead of the grip button, so they work the same either way.
 */
export const grip: Record<Side, GripState> = {
  left: { pressed: false, down: false, hand: false },
  right: { pressed: false, down: false, hand: false },
};

/**
 * What each hand is holding at one of the gondola's controls (tiller, vent
 * cord, a sandbag), or null. Loose objects aren't picked up by a hand that
 * holds a control.
 */
export const handUse: Record<Side, string | null> = { left: null, right: null };

/** Per-hand gesture state (curl, pinch), for the perf HUD and tests. */
export const handGrips: Record<Side, HandGrip> = { left: new HandGrip(), right: new HandGrip() };

interface GripWindow {
  __grip?: {
    state: typeof grip;
    hands: Record<Side, HandGrip>;
  };
}

/**
 * Spike S9: reads the grip for both hands once per frame, before the systems
 * that use it. Hand joints come from `XRFrame.fillPoses` into one reused
 * buffer; each hand's joint-space list is built once and kept.
 */
export class GripSystem extends createSystem({}) {
  private hands = handGrips;
  private joints = new Float32Array(JOINT_COUNT * 16);
  private cachedHand: Record<Side, XRHand | null> = { left: null, right: null };
  private cachedSpaces: Record<Side, XRJointSpace[]> = { left: [], right: [] };

  init(): void {
    for (const side of SIDES) {
      this.hands[side].fistClose = settings.fist;
      this.hands[side].pinchClose = settings.pinch / 100;
    }
    (window as GripWindow).__grip = { state: grip, hands: this.hands };
  }

  update(): void {
    const session = this.world.session;
    const frame = this.world.xrFrame;
    const space = this.world.xrReferenceSpace;
    for (const side of SIDES) {
      const state = grip[side];
      const pad = this.input.xr.gamepads[side];
      let pressed = !!pad?.getButtonPressed(InputComponent.Squeeze);
      const hand = session && frame && space ? this.findHand(session, side) : null;
      state.hand = hand !== null;
      if (hand && frame && space && (frame as XRFrame & { fillPoses?: FillPoses }).fillPoses?.(this.spacesFor(side, hand), space, this.joints)) {
        pressed = this.hands[side].update(this.joints) || pressed;
      } else {
        this.hands[side].reset();
      }
      state.down = pressed && !state.pressed;
      state.pressed = pressed;
    }
  }

  private findHand(session: XRSession, side: Side): XRHand | null {
    const sources = session.inputSources;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (source.handedness === side && source.hand) {
        return source.hand;
      }
    }
    return null;
  }

  private spacesFor(side: Side, hand: XRHand): XRJointSpace[] {
    if (this.cachedHand[side] !== hand) {
      this.cachedHand[side] = hand;
      this.cachedSpaces[side] = Array.from(hand.values());
    }
    return this.cachedSpaces[side];
  }
}
