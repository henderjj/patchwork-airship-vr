import { createSystem, InputComponent, type StatefulGamepad } from '@iwsdk/core';
import { HandGrip, JOINT_COUNT } from '../sim/hand-grip.js';
import {
  type ControllerFingers,
  createFingerCurls,
  curlsFromController,
  curlsFromJoints,
  easeCurls,
  type FingerCurls,
  GRIP_RELAXED,
  INDEX_RESTING,
} from '../sim/hand-pose.js';
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

/**
 * Hands made to let go because the real hand strayed too far from what its
 * drawn hand holds (grip locking, OwnHandsSystem): their grip reads as let
 * go until the button (or fist) is actually released.
 */
export const forcedRelease: Record<Side, boolean> = { left: false, right: false };

/** Per-hand gesture state (curl, pinch), for the perf HUD and tests. */
export const handGrips: Record<Side, HandGrip> = { left: new HandGrip(), right: new HandGrip() };

/**
 * Each hand's finger pose this frame, eased so it doesn't snap: from the
 * controller's trigger, grip and touch sensors, or from tracked joints.
 * OwnHandsSystem draws it and NetSystem sends it to the crewmate.
 */
export const handCurls: Record<Side, FingerCurls> = { left: createFingerCurls(), right: createFingerCurls() };

/**
 * What each controller reported this frame that poses its hand, and whether
 * it has reported any touch yet: until it does, the touch sensors are taken
 * as unknown and the hand rests on the controller (finger on the trigger,
 * thumb down) rather than pointing with its thumb up. Shown on the perf HUD
 * so the sensors can be checked on a headset.
 */
export const fingerInputs: Record<Side, ControllerFingers & { touchSeen: boolean; touches: number }> = {
  left: { trigger: 0, triggerTouched: false, squeeze: 0, thumbTouched: false, touchSeen: false, touches: 0 },
  right: { trigger: 0, triggerTouched: false, squeeze: 0, thumbTouched: false, touchSeen: false, touches: 0 },
};

/** Bits of `fingerInputs[side].touches`: which sensors report a touch. */
export const Touch = { Trigger: 1, Thumbstick: 2, LowerButton: 4, UpperButton: 8, Thumbrest: 16 } as const;

interface GripWindow {
  __grip?: {
    state: typeof grip;
    hands: Record<Side, HandGrip>;
    curls: Record<Side, FingerCurls>;
    inputs: typeof fingerInputs;
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
  private targetCurls: Record<Side, FingerCurls> = { left: createFingerCurls(), right: createFingerCurls() };
  private assumed: ControllerFingers = { trigger: 0, triggerTouched: true, squeeze: 0, thumbTouched: true };

  init(): void {
    for (const side of SIDES) {
      this.hands[side].fistClose = settings.fist;
      this.hands[side].pinchClose = settings.pinch / 100;
    }
    (window as GripWindow).__grip = { state: grip, hands: this.hands, curls: handCurls, inputs: fingerInputs };
  }

  update(delta: number): void {
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
        curlsFromJoints(this.joints, this.targetCurls[side]);
      } else {
        this.hands[side].reset();
        this.readFingers(side, pad);
      }
      easeCurls(handCurls[side], this.targetCurls[side], Math.min(delta, 0.1));
      if (forcedRelease[side]) {
        forcedRelease[side] = pressed;
        pressed = false;
      }
      state.down = pressed && !state.pressed;
      state.pressed = pressed;
    }
  }

  /** Target finger curls from a controller's sensors (or a relaxed hand with no controller). */
  private readFingers(side: Side, pad: StatefulGamepad | undefined): void {
    const target = this.targetCurls[side];
    if (!pad) {
      target.index = INDEX_RESTING;
      target.grip = GRIP_RELAXED;
      target.thumb = 1;
      return;
    }
    const input = fingerInputs[side];
    input.trigger = pad.getButtonValue(InputComponent.Trigger);
    input.triggerTouched = pad.getButtonTouched(InputComponent.Trigger);
    input.squeeze = pad.getButtonValue(InputComponent.Squeeze);
    const lower = side === 'left' ? InputComponent.X_Button : InputComponent.A_Button;
    const upper = side === 'left' ? InputComponent.Y_Button : InputComponent.B_Button;
    input.touches =
      (input.triggerTouched ? Touch.Trigger : 0) |
      (pad.getButtonTouched(InputComponent.Thumbstick) ? Touch.Thumbstick : 0) |
      (pad.getButtonTouched(lower) ? Touch.LowerButton : 0) |
      (pad.getButtonTouched(upper) ? Touch.UpperButton : 0) |
      (pad.getButtonTouched(InputComponent.Thumbrest) ? Touch.Thumbrest : 0);
    input.thumbTouched = (input.touches & ~Touch.Trigger) !== 0;
    input.touchSeen ||= input.touches !== 0;
    if (input.touchSeen) {
      curlsFromController(input, target);
    } else {
      this.assumed.trigger = input.trigger;
      this.assumed.squeeze = input.squeeze;
      curlsFromController(this.assumed, target);
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
