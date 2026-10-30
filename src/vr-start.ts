import { VisibilityState, type World } from '@iwsdk/core';
import { describeBrowser } from './perf/platform-report.js';
import { describeVrError, sessionInitFor, type VrStartState } from './vr-messages.js';
import { describeDrawing, hideProjectionLayers } from './xr-layers.js';

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
 * `launchXR` call, which makes its request synchronously, to catch the promise
 * and to adjust the options for the platform (`sessionInitFor`).
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
  let handedOver = false;
  const kind = describeBrowser(navigator.userAgent).kind;
  xr.requestSession = function (this: XRSystem, mode: XRSessionMode, init?: XRSessionInit) {
    const options = sessionInitFor(kind, init);
    console.info(`[VR] Session options: ${JSON.stringify(options ?? {})}`);
    request = original.call(this, mode, options);
    // IWSDK gets the session only once the graphics are ready for it.
    return request.then(async (session) => {
      // Before three.js picks its layer in IWSDK's setSession.
      const restore = hideProjectionLayers(
        (globalThis as { XRWebGLBinding?: { prototype: object } }).XRWebGLBinding?.prototype,
        (session as XRSession & { enabledFeatures?: readonly string[] }).enabledFeatures,
      );
      if (restore !== null) {
        console.info('[VR] The session has no WebXR Layers; drawing through an XRWebGLLayer');
        session.addEventListener('end', restore, { once: true });
      }
      await makeGraphicsReady(world, session);
      handedOver = true;
      return session;
    });
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
  // A context lost while IWSDK sets the session up ends the session; the
  // restored context is on the right card for a second try.
  let contextLost = false;
  const canvas = world.renderer.domElement;
  const onContextLost = () => {
    // A loss while the graphics are made ready is waited out (makeGraphicsReady).
    contextLost ||= handedOver;
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  console.info('[VR] Asked the browser for a VR session');
  request.then(
    (session) => {
      const grantedMs = performance.now();
      console.info(`[VR] Session granted after ${((grantedMs - sinceMs) / 1000).toFixed(1)} s`);
      set({ phase: 'starting', sinceMs, grantedMs });
      let shown = false;
      // What the session went through, for the console if it ends before its first frame.
      const seen: string[] = [`visibility ${session.visibilityState}`];
      const onVisibility = () => seen.push(`visibility ${session.visibilityState} at ${secondsSince(grantedMs)}`);
      session.addEventListener('visibilitychange', onVisibility);
      // Whether the browser hands the page XR frames at all, whatever three.js does with them.
      let xrFrames = 0;
      const countFrame = () => {
        xrFrames++;
        if (!shown) {
          session.requestAnimationFrame(countFrame);
        }
      };
      session.requestAnimationFrame(countFrame);
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
        session.removeEventListener('visibilitychange', onVisibility);
        canvas.removeEventListener('webglcontextlost', onContextLost);
        if (!shown) {
          console.warn(`[VR] The session ended before its first frame${contextLost ? ' (the WebGL context was lost)' : ''}`);
          console.warn(`[VR] Ended ${secondsSince(grantedMs)} after it was granted; ${describeEarlyEnd(world, session, handedOver, seen)}; the browser gave the page ${xrFrames} XR frame(s)`);
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

function secondsSince(ms: number): string {
  return `${((performance.now() - ms) / 1000).toFixed(1)} s`;
}

/** How far a session that ended before its first frame got, for the console. */
function describeEarlyEnd(world: World, session: XRSession, handedOver: boolean, seen: string[]): string {
  const stage = world.session === session ? 'IWSDK had taken it' : handedOver ? 'IWSDK was setting it up' : 'the graphics were being made ready';
  let drawing = 'unknown';
  try {
    drawing = describeDrawing(session.renderState as XRRenderState & { layers?: readonly unknown[] });
  } catch {
    // The render state can be unreadable once the session has ended.
  }
  const features = (session as XRSession & { enabledFeatures?: readonly string[] }).enabledFeatures;
  return `${stage}, drawing through ${drawing}, features ${JSON.stringify(features ?? 'not reported')}, ${seen.join(', ')}`;
}

type XrGl = WebGL2RenderingContext & { makeXRCompatible?: () => Promise<void> };

/** Resolve once the canvas's WebGL context is back, or after `timeoutMs`. */
function contextRestored(canvas: HTMLCanvasElement, gl: XrGl, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (!gl.isContextLost()) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      canvas.removeEventListener('webglcontextrestored', done);
      // three.js rebuilds its state in its own listener, added before this one.
      setTimeout(resolve, 0);
    };
    const timer = setTimeout(done, timeoutMs);
    canvas.addEventListener('webglcontextrestored', done);
  });
}

/**
 * Make the WebGL context ready for a granted session before IWSDK uses it.
 *
 * three.js calls `makeXRCompatible` when it takes the session, and on a PC
 * whose context is on another graphics adapter than the headset's (Chrome on
 * Windows' software renderer, or the low-power GPU of a laptop) the browser
 * answers by losing the context and restoring it on the right adapter. three.js
 * carries on with the lost context, creating the XR layer throws, and IWSDK
 * ends the session (John's Chrome over Air Link, 2026-10-10, twice). Doing it
 * here instead, and waiting for the context to come back, keeps the session:
 * three.js's own call is then a no-op.
 */
async function makeGraphicsReady(world: World, session: XRSession): Promise<void> {
  const canvas = world.renderer.domElement;
  let ended = false;
  const onEnd = () => {
    ended = true;
  };
  session.addEventListener('end', onEnd);
  try {
    for (let attempt = 1; attempt <= 4 && !ended; attempt++) {
      const gl = world.renderer.getContext() as XrGl;
      if (typeof gl.makeXRCompatible !== 'function') {
        return;
      }
      if (gl.isContextLost()) {
        await contextRestored(canvas, gl, 10000);
        continue;
      }
      let error: unknown = null;
      try {
        await gl.makeXRCompatible();
      } catch (e) {
        error = e;
      }
      // The loss can be reported just after the promise settles.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!gl.isContextLost()) {
        if (error !== null) {
          // Leave it to three.js, which will report it.
          console.warn('[VR] Could not make the graphics ready for VR:', error);
        } else if (attempt > 1) {
          console.info("[VR] Graphics moved to the headset's graphics card; carrying on with the session");
        }
        return;
      }
      console.info("[VR] The browser is moving the graphics to the headset's graphics card; waiting for it");
      await contextRestored(canvas, gl, 10000);
    }
  } finally {
    session.removeEventListener('end', onEnd);
  }
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

