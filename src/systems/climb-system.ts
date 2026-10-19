import { createSystem, Vector3 } from '@iwsdk/core';
import { Climber, ladderHold, type LadderHold, loftRaise } from '../sim/loft.js';
import { body } from './body-height-system.js';
import { grip, handUse } from './grip-system.js';
import { HoldKind, lockResolvers } from './hand-lock.js';
import { FLAG_LEFT_CRANK, FLAG_LEFT_ROPE, FLAG_RIGHT_CRANK, FLAG_RIGHT_ROPE, netLink } from './net-system.js';

const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];

/**
 * Where this player is on the ladder to the patch loft, for the systems that
 * move them about (BodyHeightSystem raises the rig by `height` on top of the
 * character height, DeckWalkSystem keeps the thumbstick to the loft on it and
 * off it partway up) and for the crewmate (the feet in the pose packets).
 */
export const climb = {
  /** How far climbing has raised the player, m. */
  height: 0,
  /** Standing on the loft. */
  onLoft: false,
  /** Partway up the ladder. */
  between: false,
  /** Where the feet are, m above the deck. */
  feet: 0,
};

interface ClimbDebug {
  state(): { height: number; onLoft: boolean; between: boolean; feet: number; top: number; holding: Record<Side, boolean> };
  /** Put this player on the loft at once, or back on the deck (tests). */
  place(onLoft: boolean): void;
}

/**
 * Climbing the ladder to the patch loft (docs/repairs.md, src/sim/loft.ts):
 * squeeze near a rung or a stile to take hold, and pull down to climb up
 * (push up to climb down), hand over hand. Let go near the top to step onto
 * the loft; let go partway and you stay there, feet on the rungs. Only in VR.
 */
export class ClimbSystem extends createSystem({}) {
  private climber = new Climber();
  private handPos = new Vector3();
  private hold: LadderHold = { x: 0, y: 0, z: 0, stile: false, distance: 0 };
  private resolved: LadderHold = { x: 0, y: 0, z: 0, stile: false, distance: 0 };
  private heights: Record<Side, number> = { left: 0, right: 0 };

  init(): void {
    // Grip locking: a hand on the ladder is drawn round its nearest rung or stile.
    lockResolvers.set(HoldKind.Ladder, (hand, point, axis) => {
      ladderHold(hand.x, hand.y, hand.z, this.resolved);
      point.set(this.resolved.x, this.resolved.y, this.resolved.z);
      if (this.resolved.stile) {
        axis.set(0, 1, 0);
      } else {
        axis.set(0, 0, 1);
      }
    });
    this.cleanupFuncs.push(() => {
      lockResolvers.delete(HoldKind.Ladder);
    });
    const debug: ClimbDebug = {
      state: () => ({
        ...climb,
        top: this.climber.top,
        holding: { left: this.climber.holding('left'), right: this.climber.holding('right') },
      }),
      place: (onLoft) => {
        this.letGo();
        const before = this.climber.height;
        this.climber.height = onLoft ? loftRaise(body.eye) : 0;
        this.player.position.y += this.climber.height - before;
        this.publish();
      },
    };
    (window as unknown as { __climb: ClimbDebug }).__climb = debug;
  }

  update(delta: number): void {
    const dt = Math.min(delta, 0.1);
    if (!this.world.session) {
      if (this.climber.height !== 0 || this.climber.onLadder) {
        this.letGo();
        this.climber.reset();
        this.publish();
      }
      return;
    }
    const busy = (netLink.extraFlags.crank ?? 0) | (netLink.extraFlags.rope ?? 0);
    for (const side of SIDES) {
      this.player.gripSpaces[side].getWorldPosition(this.handPos);
      this.heights[side] = this.handPos.y;
      if (this.climber.holding(side)) {
        if (!grip[side].pressed) {
          this.release(side);
        }
        continue;
      }
      const sideBusy = busy & (side === 'left' ? FLAG_LEFT_CRANK | FLAG_LEFT_ROPE : FLAG_RIGHT_CRANK | FLAG_RIGHT_ROPE);
      if (!grip[side].down || sideBusy || handUse[side]) {
        continue;
      }
      if (ladderHold(this.handPos.x, this.handPos.y, this.handPos.z, this.hold)) {
        this.climber.grab(side, this.handPos.y);
        handUse[side] = 'ladder';
        this.pulse(side, 0.3, 25);
      }
    }
    // The loft puts this player's eyes at the same height whatever their character's height (measured without the climb).
    const before = this.climber.height;
    const top = loftRaise(body.eye);
    const after = this.climber.update(dt, this.heights.left, this.heights.right, top);
    if (after !== before) {
      // Raise the rig now, so the systems after this one see the hands where they are drawn.
      this.player.position.y += after - before;
      if (Math.floor(after / 0.3) !== Math.floor(before / 0.3)) {
        // A knock in the climbing hand at each rung passed.
        for (const side of SIDES) {
          if (this.climber.holding(side)) this.pulse(side, 0.15, 12);
        }
      }
    }
    this.publish();
  }

  private publish(): void {
    climb.height = this.climber.height;
    climb.onLoft = this.climber.onLoft;
    climb.between = this.climber.between;
    climb.feet = this.climber.feet;
    netLink.feet = this.climber.feet;
  }

  private release(side: Side): void {
    this.climber.release(side);
    if (handUse[side] === 'ladder') {
      handUse[side] = null;
    }
  }

  private letGo(): void {
    for (const side of SIDES) {
      if (this.climber.holding(side)) this.release(side);
    }
    this.climber.releaseAll();
  }

  private pulse(side: Side, intensity: number, ms: number): void {
    const actuator = this.input.xr.gamepads[side]?.gamepad.hapticActuators?.[0] as
      | { pulse?: (value: number, duration: number) => Promise<boolean> }
      | undefined;
    void actuator?.pulse?.(intensity, ms)?.catch(() => undefined);
  }
}
