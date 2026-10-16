/**
 * Controller buzz, shared by the systems that use it. Browsers offer it in
 * different ways: Quest Browser through WebXR's `hapticActuators[0].pulse`,
 * and some others only through the Gamepad API's
 * `vibrationActuator.playEffect`. Chrome on a PC driving a Rift or a Quest
 * over Link may offer neither for VR controllers, and then nothing buzzes.
 * `hapticsInfo` records which way each controller buzzes (or that it can't,
 * or that the browser turned a buzz down) so the wrist HUD can show it.
 */

type Side = 'left' | 'right';

/** How a controller buzzes: WebXR pulse, Gamepad API rumble, no way offered, a buzz the browser refused, or no controller seen yet. */
export type HapticsRoute = 'pulse' | 'rumble' | 'none' | 'refused' | '-';

export const hapticsInfo: Record<Side, HapticsRoute> = { left: '-', right: '-' };

interface PulseActuator {
  pulse?: (value: number, duration: number) => Promise<boolean>;
}

interface RumbleActuator {
  effects?: readonly string[];
  playEffect?: (type: string, params: { duration: number; strongMagnitude: number; weakMagnitude: number; startDelay?: number }) => Promise<string>;
}

// Made once, so a buzz allocates nothing of ours.
const refused: Record<Side, () => void> = {
  left: () => { hapticsInfo.left = 'refused'; },
  right: () => { hapticsInfo.right = 'refused'; },
};
const pulsed: Record<Side, (ok: unknown) => void> = {
  left: (ok) => { if (ok === false) hapticsInfo.left = 'refused'; },
  right: (ok) => { if (ok === false) hapticsInfo.right = 'refused'; },
};

/** Buzz `side`'s controller at `intensity` (0 to 1) for `ms`, by whichever way its gamepad offers. */
export function buzz(gamepad: Gamepad | undefined, side: Side, intensity: number, ms: number): void {
  if (!gamepad) {
    return;
  }
  const strength = Math.max(0, Math.min(1, intensity));
  const pulse = (gamepad.hapticActuators?.[0] as PulseActuator | undefined)?.pulse;
  if (typeof pulse === 'function') {
    if (hapticsInfo[side] !== 'refused') hapticsInfo[side] = 'pulse';
    void pulse.call(gamepad.hapticActuators![0], strength, ms)?.then?.(pulsed[side], refused[side]);
    return;
  }
  const rumble = (gamepad as Gamepad & { vibrationActuator?: RumbleActuator | null }).vibrationActuator;
  if (rumble && typeof rumble.playEffect === 'function') {
    if (hapticsInfo[side] !== 'refused') hapticsInfo[side] = 'rumble';
    const type = rumble.effects && !rumble.effects.includes('dual-rumble') && rumble.effects.includes('trigger-rumble') ? 'trigger-rumble' : 'dual-rumble';
    void rumble.playEffect(type, { duration: ms, strongMagnitude: strength, weakMagnitude: strength })?.catch?.(refused[side]);
    return;
  }
  hapticsInfo[side] = 'none';
}

/** How `gamepad` can buzz, without buzzing it: the HUD's view before anything has. */
export function hapticsRoute(gamepad: Gamepad | undefined): HapticsRoute {
  if (!gamepad) return '-';
  if (typeof (gamepad.hapticActuators?.[0] as PulseActuator | undefined)?.pulse === 'function') return 'pulse';
  const rumble = (gamepad as Gamepad & { vibrationActuator?: RumbleActuator | null }).vibrationActuator;
  return rumble && typeof rumble.playEffect === 'function' ? 'rumble' : 'none';
}

/** Short text for the HUD: how each controller buzzes (a refused buzz shows as refused). */
export function hapticsSummary(left: Gamepad | undefined, right: Gamepad | undefined): string {
  const l = hapticsInfo.left === 'refused' ? 'refused' : hapticsRoute(left);
  const r = hapticsInfo.right === 'refused' ? 'refused' : hapticsRoute(right);
  return l === r ? `buzz ${l}` : `buzz ${l}/${r}`;
}
