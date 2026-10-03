import { createSystem, VisibilityState } from '@iwsdk/core';
import { collectPlatform, type PlatformReport, platformInfo, summarize } from '../perf/platform-report.js';
import { frameRateInfo } from './frame-rate-system.js';
import { netLink } from './net-system.js';

/** Long enough after a session starts for input sources to appear and the refresh rate to be measured. */
const SETTLE_MS = 3000;

/**
 * Spike S8: reports what this browser and headset runtime offer (refresh
 * rate and whether it can be set, multiview, layers, foveation, hand
 * tracking, input profiles, microphone) and swaps reports with the crewmate,
 * so a Quest + PCVR session can be checked from either headset. Logged as
 * `[Platform]` lines, drawn on the perf HUD, and readable from
 * `window.__platform`. Nothing here changes behaviour by platform: the game
 * only uses feature detection (FrameRateSystem skips the rate request where
 * `updateTargetFrameRate` is missing, and the HUD measures the rate instead).
 */
export class PlatformSystem extends createSystem({}) {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private session: XRSession | undefined;
  private sentToCrew = false;
  private micLabel = '';

  init(): void {
    netLink.events.set('platform', (event) => {
      const report = event.report as PlatformReport | undefined;
      if (report && typeof report.browser === 'string' && Array.isArray(report.inputs)) {
        platformInfo.crew = report;
        console.info(`[Platform] crewmate: ${summarize(report)} ${JSON.stringify(report)}`);
      }
    });
    const onInputs = () => this.schedule(500);
    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((state) => {
        const session = this.world.session;
        if (state === VisibilityState.NonImmersive || !session || session === this.session) {
          return;
        }
        this.session?.removeEventListener('inputsourceschange', onInputs);
        this.session = session;
        session.addEventListener('inputsourceschange', onInputs);
        this.schedule(SETTLE_MS);
      }),
      () => {
        clearTimeout(this.timer);
        this.session?.removeEventListener('inputsourceschange', onInputs);
        netLink.events.delete('platform');
      },
    );
    (window as unknown as { __platform: unknown }).__platform = {
      get mine() { return platformInfo.mine; },
      get crew() { return platformInfo.crew; },
      collect: () => this.report(),
    };
    this.schedule(1000);
  }

  update(): void {
    if (netLink.micLabel !== this.micLabel) {
      this.micLabel = netLink.micLabel;
      this.schedule(200);
    }
    if (!netLink.connected) {
      this.sentToCrew = false;
      platformInfo.crew = null;
    } else if (!this.sentToCrew) {
      const report = platformInfo.mine ?? this.report();
      this.sentToCrew = true;
      netLink.sendEvent({ t: 'platform', report } as { t: string });
    }
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.report(), delayMs);
  }

  private report(): PlatformReport {
    const xr = this.renderer.xr as typeof this.renderer.xr & { isMultiview?: boolean };
    const session = this.world.session ?? undefined;
    const hzSource = frameRateInfo.actual !== null ? 'reported' : frameRateInfo.measured !== null ? 'measured' : 'unknown';
    const report = collectPlatform({
      gl: this.renderer.getContext(),
      session,
      layer: session ? (xr.getBaseLayer() as unknown as Parameters<typeof collectPlatform>[0]['layer']) : null,
      multiview: session ? !!xr.isMultiview : false,
      hz: frameRateInfo.actual ?? frameRateInfo.measured,
      hzSource,
      rates: frameRateInfo.supported,
      canSetRate: frameRateInfo.canSet,
      mic: netLink.micLabel || 'not open',
    });
    platformInfo.mine = report;
    console.info(`[Platform] me${session ? '' : ' (not immersive)'}: ${summarize(report)} ${JSON.stringify(report)}`);
    // Tell the crewmate again whenever the report changes (entering XR, hands appearing).
    this.sentToCrew = false;
    return report;
  }
}
