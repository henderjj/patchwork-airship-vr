import type { PlatformKind } from './perf/platform-report.js';

/**
 * Where a press of Enter VR has got to. `grantedMs` is set once the browser
 * has handed over a session and the game is waiting for its first frame in
 * the headset.
 */
export type VrStartState =
  | { phase: 'idle' }
  | { phase: 'starting'; sinceMs: number; grantedMs: number | null }
  | { phase: 'in-vr'; tookMs: number }
  | { phase: 'failed'; error: string }
  | { phase: 'ended-early' };

/** After this long a start is slow enough to explain; on a PC it is Link's. */
export const SLOW_START_MS = 8000;
/** After this long a start has almost certainly hung. */
export const HUNG_START_MS = 90000;

const LINK_CHECK =
  'Check that the headset is connected through Link or Air Link (the Link home shows in the headset) and that Meta Horizon Link is the active OpenXR runtime.';

/** The line under the Enter VR button for `state`, or '' when there is nothing to say. */
export function vrStartMessage(state: VrStartState, nowMs: number, kind: PlatformKind): string {
  switch (state.phase) {
    case 'idle':
    case 'in-vr':
      return '';
    case 'failed':
      return `VR didn't start: ${state.error}.${kind === 'pc' ? ` ${LINK_CHECK}` : ''}`;
    case 'ended-early':
      return "VR started but closed straight away. Try again; the browser console (F12) has the reason.";
    case 'starting': {
      const elapsed = nowMs - state.sinceMs;
      const seconds = Math.floor(elapsed / 1000);
      if (elapsed >= HUNG_START_MS) {
        return kind === 'pc'
          ? `VR still hasn't started after ${seconds} s. Close every browser window, start the browser again with Link already running, and retry.`
          : `VR still hasn't started after ${seconds} s. Reload the page and retry.`;
      }
      if (state.grantedMs !== null) {
        return `Starting VR (${seconds} s): the headset accepted, waiting for the first picture...`;
      }
      if (elapsed < SLOW_START_MS) {
        return 'Starting VR...';
      }
      return kind === 'pc'
        ? `Starting VR (${seconds} s). Through Link this can take about a minute; put the headset on and wait.`
        : `Starting VR (${seconds} s)...`;
    }
  }
}

/**
 * Whether to offer the Enter VR button, and what to say when this browser
 * reports no headset. On a PC the button stays: the browser can report no
 * headset when the page opened before Link was running, and a press then
 * either starts VR or says why not.
 */
export function vrSupportNote(kind: PlatformKind, hasWebXr: boolean, supported: boolean): { button: boolean; note: string } {
  if (supported) {
    return { button: true, note: '' };
  }
  if (kind !== 'pc') {
    return { button: false, note: '' };
  }
  if (!hasWebXr) {
    return { button: false, note: "This browser can't run VR. On a PC, use Chrome or Edge." };
  }
  return { button: true, note: 'The browser sees no VR headset yet. Start Link or Air Link, then press Enter VR.' };
}

/** A short description of a failed session request, from its error. */
export function describeVrError(error: unknown): string {
  if (error instanceof Error || (typeof DOMException !== 'undefined' && error instanceof DOMException)) {
    const { name, message } = error as Error;
    if (name === 'NotSupportedError') {
      return `the browser found no VR headset${message ? ` (${message})` : ''}`;
    }
    if (name === 'SecurityError' || name === 'NotAllowedError') {
      return `the browser refused${message ? ` (${message})` : ''}`;
    }
    if (name === 'InvalidStateError') {
      return `another VR session is already running${message ? ` (${message})` : ''}`;
    }
    return message ? `${name}: ${message}` : name;
  }
  return String(error);
}
