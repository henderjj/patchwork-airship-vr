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
  | { phase: 'ended-early'; contextLost: boolean };

/** After this long a start is slow enough to explain; on a PC it is Link's. */
export const SLOW_START_MS = 8000;
/** After this long a start has almost certainly hung. */
export const HUNG_START_MS = 90000;

const LINK_CHECK =
  'Check that the headset is connected through Link or Air Link (the Link home shows in the headset) and that Meta Horizon Link is the active OpenXR runtime.';

/**
 * Chrome and Edge on a PC ask before a site may use VR devices, in a bubble
 * on the PC's browser window that someone wearing the headset can't see, and
 * the session request waits until it is answered.
 */
const ALLOW_PROMPT = 'Check the browser window on the PC screen: if it asks to use your virtual reality devices, click Allow.';

/** The line under the Enter VR button for `state`, or '' when there is nothing to say. */
export function vrStartMessage(state: VrStartState, nowMs: number, kind: PlatformKind): string {
  switch (state.phase) {
    case 'idle':
    case 'in-vr':
      return '';
    case 'failed':
      return `VR didn't start: ${state.error}.${kind === 'pc' ? ` ${LINK_CHECK}` : ''}`;
    case 'ended-early':
      if (state.contextLost) {
        return 'VR stopped while the browser moved its graphics to the graphics card the headset uses. Press Enter VR again.';
      }
      return kind === 'pc'
        ? 'VR started but closed straight away. Press Enter VR again. If it keeps closing, open chrome://webxr-internals (edge://webxr-internals in Edge) in a new tab, try once more and send a picture of that page and of the browser console (F12).'
        : 'VR started but closed straight away. Try again; the browser console (F12) has the reason.';
    case 'starting': {
      const elapsed = nowMs - state.sinceMs;
      const seconds = Math.floor(elapsed / 1000);
      if (elapsed >= HUNG_START_MS) {
        return kind === 'pc'
          ? `VR still hasn't started after ${seconds} s. ${ALLOW_PROMPT} Also check that Unknown Sources is on in the Link app (Settings, General). If neither helps, open chrome://webxr-internals (edge://webxr-internals in Edge) in a new tab and send a picture of it.`
          : `VR still hasn't started after ${seconds} s. Reload the page and retry.`;
      }
      if (state.grantedMs !== null) {
        return `Starting VR (${seconds} s): the headset accepted, waiting for the first picture...`;
      }
      if (elapsed < SLOW_START_MS) {
        return kind === 'pc' ? `Starting VR... ${ALLOW_PROMPT}` : 'Starting VR...';
      }
      return kind === 'pc'
        ? `Starting VR (${seconds} s). ${ALLOW_PROMPT} Through Link the start can also take about a minute.`
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

/**
 * A note for a PC whose browser draws with a software renderer instead of a
 * graphics card ('' otherwise). VR then has to move the graphics to the
 * headset's card as it starts, and the flat page runs slowly.
 */
export function softwareRendererNote(kind: PlatformKind, gpu: string): string {
  if (kind !== 'pc' || !/Basic Render Driver|SwiftShader|llvmpipe|Software Adapter/i.test(gpu)) {
    return '';
  }
  return "The browser is drawing without your graphics card (software renderer). Turn on \"Use graphics acceleration when available\" in the browser's settings, set the browser to High performance in Windows Settings > System > Display > Graphics, then restart the browser.";
}


/**
 * The session request's options for this platform. A PC browser is not asked
 * for WebXR Layers: Chrome turned Layers on for Windows OpenXR in 2026, so
 * three.js now draws through a projection layer there instead of the
 * XRWebGLLayer the PC path was tested with (spike S8), and a Rift on Chrome
 * 156 then had its session end before the first frame (2026-10-30). Layers
 * buy nothing on a PC (no fixed foveation through Link), and the Quest Browser
 * keeps them. Leaving them out of the request isn't enough on its own: three.js
 * still makes a projection layer if the browser can (see xr-layers.ts).
 */
export function sessionInitFor(kind: PlatformKind, init: XRSessionInit | undefined): XRSessionInit | undefined {
  if (kind !== 'pc' || init?.optionalFeatures == null) {
    return init;
  }
  return { ...init, optionalFeatures: init.optionalFeatures.filter((feature) => feature !== 'layers') };
}
