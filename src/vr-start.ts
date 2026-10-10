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
  // Moving the context to the headset's graphics card loses it, which ends
  // the session; the restored context is on the right card for a second try.
  let contextLost = false;
  const canvas = world.renderer.domElement;
  const onContextLost = () => {
    contextLost = true;
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
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
        canvas.removeEventListener('webglcontextlost', onContextLost);
        if (!shown) {
          console.warn(`[VR] The session ended before its first frame${contextLost ? ' (the WebGL context was lost)' : ''}`);
        }
        set(shown ? { phase: 'idle' } : { phase: 'ended-early', contextLost });
      }, { once: true });
    },
    (error: unknown) => {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      console.warn(`[VR] The browser refused a VR session after ${((performance.now() - sinceMs) / 1000).toFixed(1)} s:`, error);
      set({ phase: 'failed', error: describeVrError(error) });
    },
  );
}

let prepared = false;

/**
 * Make the game's WebGL context ready for VR once the browser reports a
 * headset, before anyone presses Enter VR. If the context is on a different
 * graphics card from the headset's, the browser moves it now (losing and
 * restoring it, which three.js recovers from) instead of in the middle of
 * starting the session, where the loss ends the session. three.js calls
 * `makeXRCompatible` again when a session starts, which is then a no-op.
 */
export function prepareVr(world: World): void {
  if (prepared) {
    return;
  }
  const gl = world.renderer.getContext() as WebGL2RenderingContext & { makeXRCompatible?: () => Promise<void> };
  if (typeof gl.makeXRCompatible !== 'function') {
    return;
  }
  prepared = true;
  const sinceMs = performance.now();
  let lost = false;
  const canvas = world.renderer.domElement;
  const onLost = () => {
    lost = true;
  };
  canvas.addEventListener('webglcontextlost', onLost);
  gl.makeXRCompatible().then(
    () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      console.info(`[VR] Graphics ready for VR after ${((performance.now() - sinceMs) / 1000).toFixed(1)} s${lost ? ', moved to the headset\'s graphics card' : ''}`);
    },
    (error: unknown) => {
      canvas.removeEventListener('webglcontextlost', onLost);
      // No headset yet, for example; the session start will try again.
      prepared = false;
      console.info('[VR] Graphics not made ready for VR yet:', error);
    },
  );
}

