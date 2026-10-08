import { VisibilityState, type World } from '@iwsdk/core';
import { describeVrError, type VrStartState } from './vr-messages.js';

let state: VrStartState = { phase: 'idle' };
const listeners = new Set<(state: VrStartState) => void>();

function set(next: VrStartState): void {
  state = next;
  for (const listener of listeners) {
    listener(state);
  }
}

/** Where the last press of Enter VR has got to. */
export function vrStartState(): VrStartState {
  return state;
}

/** Call `listener` whenever the start state changes; returns the unsubscribe. */
export function onVrStart(listener: (state: VrStartState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Enter VR through IWSDK's `launchXR`, and follow the request so the page can
 * say what is happening. `launchXR` only logs a failed request to the
 * console, and a desktop browser over Link can take most of a minute to hand
 * over a session (Meta Horizon Link 207 with Chrome), which on the page looks
 * exactly like nothing happening.
 *
 * The browser's `requestSession` is wrapped only for the duration of the
 * `launchXR` call, which makes its request synchronously, to catch the promise.
 */
export function startVr(world: World): void {
  if (world.session != null || state.phase === 'starting') {
    return;
  }
  const xr = navigator.xr;
  if (xr == null) {
    set({ phase: 'failed', error: 'this browser has no WebXR' });
    return;
  }
  const own = Object.prototype.hasOwnProperty.call(xr, 'requestSession');
  const original = xr.requestSession;
  let request: Promise<XRSession> | undefined;
  xr.requestSession = function (this: XRSystem, ...args: Parameters<XRSystem['requestSession']>) {
    request = original.apply(this, args);
    return request;
  };
  try {
    world.launchXR();
  } catch (error) {
    set({ phase: 'failed', error: describeVrError(error) });
    return;
  } finally {
    if (own) {
      xr.requestSession = original;
    } else {
      delete (xr as Partial<XRSystem>).requestSession;
    }
  }
  if (request == null) {
    return;
  }
  const sinceMs = performance.now();
  set({ phase: 'starting', sinceMs, grantedMs: null });
  console.info('[VR] Asked the browser for a VR session');
  request.then(
    (session) => {
      const grantedMs = performance.now();
      console.info(`[VR] Session granted after ${((grantedMs - sinceMs) / 1000).toFixed(1)} s`);
      set({ phase: 'starting', sinceMs, grantedMs });
      let shown = false;
      const stopWatching = world.visibilityState.subscribe((visibility) => {
        if (visibility !== VisibilityState.NonImmersive && !shown) {
          shown = true;
          const tookMs = performance.now() - sinceMs;
          console.info(`[VR] First frame in the headset after ${(tookMs / 1000).toFixed(1)} s`);
          set({ phase: 'in-vr', tookMs });
        }
      });
      session.addEventListener('end', () => {
        stopWatching();
        if (!shown) {
          console.warn('[VR] The session ended before its first frame');
        }
        set(shown ? { phase: 'idle' } : { phase: 'ended-early' });
      }, { once: true });
    },
    (error: unknown) => {
      console.warn(`[VR] The browser refused a VR session after ${((performance.now() - sinceMs) / 1000).toFixed(1)} s:`, error);
      set({ phase: 'failed', error: describeVrError(error) });
    },
  );
}
