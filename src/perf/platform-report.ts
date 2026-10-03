/**
 * What each player's browser and headset runtime offer (spike S8), so a
 * cross-play session between a Quest standalone player and a PCVR player
 * (Chrome or Edge on Windows with Meta Horizon Link) can be checked from
 * either side: both players log their own report and the crewmate's.
 *
 * `describeBrowser` is pure; `collectPlatform` reads the live session.
 */

export type PlatformKind = 'quest' | 'pc' | 'android' | 'other';

export interface BrowserInfo {
  kind: PlatformKind;
  /** e.g. "Quest Browser 41.2", "Chrome 141", "Edge 141". */
  browser: string;
  os: string;
}

export interface PlatformReport extends BrowserInfo {
  gpu: string;
  /** Refresh rate in use, and where it came from. */
  hz: number | null;
  hzSource: 'reported' | 'measured' | 'unknown';
  /** `supportedFrameRates`, empty when not offered. */
  rates: number[];
  canSetRate: boolean;
  /** Both eyes drawn in one pass (OCULUS_multiview); without it draw calls double. */
  multiview: boolean;
  /** Rendering through a WebXR Layers projection layer rather than an XRWebGLLayer. */
  layers: boolean;
  /** The layer accepts fixed foveation. */
  foveation: boolean;
  /** Colour buffer size, width x height (x views). */
  buffer: string;
  /** Session features granted, e.g. hand-tracking. */
  features: string[];
  /** One entry per input source: "left controller oculus-touch-v3". */
  inputs: string[];
  mic: string;
}

/** This player's platform and the crewmate's, for the perf HUD and tests. */
export const platformInfo = {
  mine: null as PlatformReport | null,
  crew: null as PlatformReport | null,
};

/** Browser, OS and platform kind from a user-agent string. */
export function describeBrowser(ua: string): BrowserInfo {
  const version = (pattern: RegExp): string => {
    const match = ua.match(pattern);
    return match ? match[1].split('.').slice(0, 2).join('.') : '';
  };
  const os = /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'unknown';
  let browser: string;
  let kind: PlatformKind;
  if (/OculusBrowser\//.test(ua)) {
    browser = `Quest Browser ${version(/OculusBrowser\/([\d.]+)/)}`;
    kind = 'quest';
  } else {
    browser = /Edg\//.test(ua) ? `Edge ${version(/Edg\/([\d.]+)/).split('.')[0]}`
      : /Firefox\//.test(ua) ? `Firefox ${version(/Firefox\/([\d.]+)/).split('.')[0]}`
      : /Chrome\//.test(ua) ? `Chrome ${version(/Chrome\/([\d.]+)/).split('.')[0]}`
      : 'unknown browser';
    kind = os === 'Android' ? 'android' : os === 'unknown' ? 'other' : 'pc';
  }
  return { kind, browser, os };
}

/** One short line for the HUD and logs: "PC Chrome 141, 90 Hz, no multiview". */
export function summarize(report: PlatformReport): string {
  const where = report.kind === 'quest' ? report.browser : `${report.kind === 'pc' ? 'PC' : report.os} ${report.browser}`;
  const hz = report.hz === null ? '? Hz' : `${report.hzSource === 'measured' ? '~' : ''}${report.hz} Hz`;
  const hands = report.inputs.some((input) => input.includes(' hand ')) ? ', hands' : '';
  return `${where}, ${hz}${report.multiview ? '' : ', no multiview'}${hands}`;
}

interface LayerLike {
  textureWidth?: number;
  textureHeight?: number;
  textureArrayLength?: number;
  framebufferWidth?: number;
  framebufferHeight?: number;
  fixedFoveation?: number | null;
}

/**
 * The GPU's name. Reading it waits for the GPU process to catch up, which can
 * stall the page for a long time on a busy machine, so read it once at start.
 */
export function readGpu(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  } catch {
    return 'unknown';
  }
}

export interface PlatformSources {
  gpu: string;
  session: XRSession | undefined;
  layer: LayerLike | null;
  multiview: boolean;
  hz: number | null;
  hzSource: PlatformReport['hzSource'];
  rates: number[];
  canSetRate: boolean;
  mic: string;
}

export function collectPlatform(sources: PlatformSources): PlatformReport {
  const { session, layer } = sources;
  let buffer = '';
  if (layer?.textureWidth) {
    buffer = `${layer.textureWidth}x${layer.textureHeight}${layer.textureArrayLength && layer.textureArrayLength > 1 ? `x${layer.textureArrayLength}` : ''}`;
  } else if (layer?.framebufferWidth) {
    buffer = `${layer.framebufferWidth}x${layer.framebufferHeight}`;
  }
  const inputs: string[] = [];
  if (session) {
    for (const source of session.inputSources) {
      inputs.push(`${source.handedness} ${source.hand ? 'hand' : 'controller'} ${source.profiles[0] ?? 'unknown'}`);
    }
  }
  const features = Array.from((session as (XRSession & { enabledFeatures?: readonly string[] }) | undefined)?.enabledFeatures ?? []);
  return {
    ...describeBrowser(navigator.userAgent),
    gpu: sources.gpu,
    hz: sources.hz,
    hzSource: sources.hzSource,
    rates: sources.rates,
    canSetRate: sources.canSetRate,
    multiview: sources.multiview,
    layers: layer?.textureWidth !== undefined,
    foveation: layer?.fixedFoveation !== undefined,
    buffer,
    features,
    inputs,
    mic: sources.mic,
  };
}
