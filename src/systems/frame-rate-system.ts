import { createSystem, VisibilityState } from '@iwsdk/core';
import { settings } from '../settings.js';

export interface FrameRateInfo {
  supported: number[];
  requested: number | null;
  actual: number | null;
}

/** Latest frame-rate state, read by the perf HUD. */
export const frameRateInfo: FrameRateInfo = { supported: [], requested: null, actual: null };

/**
 * Choose the rate to request: the target if supported, otherwise the highest
 * supported rate below it, otherwise the lowest supported rate.
 */
export function chooseFrameRate(supported: readonly number[], target: number): number | null {
  if (supported.length === 0) {
    return null;
  }
  if (supported.includes(target)) {
    return target;
  }
  const below = supported.filter((rate) => rate <= target);
  return below.length > 0 ? Math.max(...below) : Math.min(...supported);
}

/**
 * Neither IWSDK nor three.js requests a refresh rate, and the Quest Browser's
 * default may be 72 Hz, so ask for the target rate (90 Hz) when each immersive
 * session starts. Also applies the foveation and framebuffer-scale settings.
 */
export class FrameRateSystem extends createSystem({}) {
  private currentSession: XRSession | undefined;

  init(): void {
    this.renderer.xr.setFramebufferScaleFactor(settings.framebufferScale);
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        const session = this.world.session;
        if (state === VisibilityState.NonImmersive || !session || session === this.currentSession) {
          return;
        }
        this.currentSession = session;
        void this.onSessionStart(session);
      }),
    );
  }

  private async onSessionStart(session: XRSession): Promise<void> {
    this.renderer.xr.setFoveation(settings.foveation);
    const supported = Array.from(session.supportedFrameRates ?? []);
    frameRateInfo.supported = supported;
    frameRateInfo.actual = session.frameRate ?? null;
    const rate = chooseFrameRate(supported, settings.hz);
    console.info(
      `[FrameRate] supported=${JSON.stringify(supported)} default=${session.frameRate ?? 'unknown'} requesting=${rate ?? 'none'}`,
    );
    if (rate === null || typeof session.updateTargetFrameRate !== 'function') {
      return;
    }
    try {
      await session.updateTargetFrameRate(rate);
      frameRateInfo.requested = rate;
    } catch (error) {
      console.warn('[FrameRate] updateTargetFrameRate failed', error);
    }
    frameRateInfo.actual = session.frameRate ?? null;
    console.info(`[FrameRate] now ${session.frameRate ?? 'unknown'} Hz`);
  }
}
