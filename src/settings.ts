/**
 * Runtime settings read once from the page URL, so a test build can be tuned
 * from the headset's browser address bar without a rebuild. Example:
 * `?islands=60&clouds=80&rain=1&hz=90&hud=1&motion=tour`.
 */
export interface Settings {
  /** Requested XR frame rate; the nearest supported rate at or below is used. */
  hz: number;
  /** Floating islands in the stress scene. */
  islands: number;
  /** Cloud clusters. */
  clouds: number;
  /** Instanced rain around the gondola. */
  rain: boolean;
  /** One shadow-casting directional light limited to the gondola. */
  shadows: boolean;
  /** Fixed foveation, 0 (off) to 1 (maximum). */
  foveation: number;
  /** WebXR framebuffer scale; 1 is the browser default. */
  framebufferScale: number;
  /** Dummy avatars standing on the deck. */
  avatars: number;
  /** Loose physics fuel bricks. */
  bricks: number;
  /** Show the perf HUD from the start. */
  hud: boolean;
  /** Ship motion profile: still, tour (scripted path), or a comfort profile name. */
  motion: string;
  /** Seed for the generated world. */
  seed: number;
}

export const DEFAULT_SETTINGS: Settings = {
  hz: 90,
  islands: 30,
  clouds: 40,
  rain: false,
  shadows: false,
  foveation: 1,
  framebufferScale: 1,
  avatars: 2,
  bricks: 8,
  hud: true,
  motion: 'still',
  seed: 1,
};

function num(params: URLSearchParams, key: string, fallback: number, min: number, max: number): number {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function bool(params: URLSearchParams, key: string, fallback: boolean): boolean {
  const raw = params.get(key);
  if (raw === null) {
    return fallback;
  }
  return raw === '1' || raw === 'true' || raw === 'on' || raw === '';
}

export function parseSettings(search: string): Settings {
  const params = new URLSearchParams(search);
  const d = DEFAULT_SETTINGS;
  return {
    hz: num(params, 'hz', d.hz, 60, 120),
    islands: Math.round(num(params, 'islands', d.islands, 0, 400)),
    clouds: Math.round(num(params, 'clouds', d.clouds, 0, 400)),
    rain: bool(params, 'rain', d.rain),
    shadows: bool(params, 'shadows', d.shadows),
    foveation: num(params, 'foveation', d.foveation, 0, 1),
    framebufferScale: num(params, 'fbscale', d.framebufferScale, 0.5, 1.5),
    avatars: Math.round(num(params, 'avatars', d.avatars, 0, 8)),
    bricks: Math.round(num(params, 'bricks', d.bricks, 0, 60)),
    hud: bool(params, 'hud', d.hud),
    motion: params.get('motion') ?? d.motion,
    seed: Math.round(num(params, 'seed', d.seed, 0, 1e9)),
  };
}

export const settings: Settings =
  typeof location === 'undefined' ? DEFAULT_SETTINGS : parseSettings(location.search);
