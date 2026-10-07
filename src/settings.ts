/**
 * Runtime settings, read once when the page loads: first the ones saved from
 * the Settings menu on the crew panel (src/settings-menu.ts), then any in the
 * page URL on top, so a test build can still be tuned from the address bar
 * without a rebuild. Example: `?islands=60&clouds=80&rain=1&hz=90&hud=1&motion=tour`.
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
  /** Crew room code to join on load (four letters), or '' to stay solo. */
  room: string;
  /** Lobby base URL (ws:// or wss://); '' uses the build default. */
  lobby: string;
  /** Player name shown to the crewmate. */
  name: string;
  /** Simulated extra one-way latency on received packets, ms (testing only). */
  netLag: number;
  /** Simulated random extra delay on received packets, 0 to this many ms. */
  netJitter: number;
  /** Simulated loss of received pose packets, 0 to 1. */
  netLoss: number;
  /** Crewmate voice: 'spatial' (HRTF at their head), 'plain' (not positioned) or 'off'. */
  voice: 'spatial' | 'plain' | 'off';
  /** Route spatial voice through a loopback peer connection so echo cancellation sees it. */
  voiceLoop: boolean;
  /** The ship's sounds (burner, wind, creaks, crank, bell); `audio=0` turns them off. */
  audio: boolean;
  /** Tracked hands grip when the fingers' average curl falls below this (1 straight, about 0.4 a fist). */
  fist: number;
  /** Tracked hands grip when the thumb and index tips are closer than this, cm; 0 turns pinch-to-grip off. */
  pinch: number;
  /** Spike S3: overrides for the motion profile's limits; NaN keeps the profile's own value. */
  motionSpeed: number;
  motionTurn: number;
  motionClimb: number;
  motionTilt: number;
  motionGust: number;
  /** Spike S3: ask for a comfort rating this often while in VR, s; 0 never asks. */
  comfort: number;
  /** A tag for this session (tester or variant) written into the perf and comfort logs. */
  label: string;
  /**
   * This page plays as the practice crewmate, a bot that joins the crew as
   * the second player so one person can test the two-player parts.
   */
  bot: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  hz: 90,
  islands: 30,
  clouds: 40,
  rain: false,
  shadows: false,
  foveation: 1,
  framebufferScale: 1,
  avatars: 0,
  bricks: 8,
  hud: true,
  motion: 'flight',
  seed: 1,
  room: '',
  lobby: '',
  name: '',
  netLag: 0,
  netJitter: 0,
  netLoss: 0,
  voice: 'spatial',
  voiceLoop: false,
  audio: true,
  fist: 0.6,
  pinch: 2,
  motionSpeed: Number.NaN,
  motionTurn: Number.NaN,
  motionClimb: Number.NaN,
  motionTilt: Number.NaN,
  motionGust: Number.NaN,
  comfort: 0,
  label: '',
  bot: false,
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

function voiceMode(raw: string | null, fallback: Settings['voice']): Settings['voice'] {
  return raw === 'spatial' || raw === 'plain' || raw === 'off' ? raw : fallback;
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
    room: params.get('room') ?? d.room,
    lobby: params.get('lobby') ?? d.lobby,
    name: (params.get('name') ?? d.name).slice(0, 24),
    netLag: num(params, 'netlag', d.netLag, 0, 2000),
    netJitter: num(params, 'netjitter', d.netJitter, 0, 1000),
    netLoss: num(params, 'netloss', d.netLoss, 0, 1),
    voice: voiceMode(params.get('voice'), d.voice),
    voiceLoop: bool(params, 'voiceloop', d.voiceLoop),
    audio: bool(params, 'audio', d.audio),
    fist: num(params, 'fist', d.fist, 0.2, 0.95),
    pinch: num(params, 'pinch', d.pinch, 0, 6),
    motionSpeed: num(params, 'speed', d.motionSpeed, 0, 30),
    motionTurn: num(params, 'turn', d.motionTurn, 0, 30),
    motionClimb: num(params, 'climb', d.motionClimb, 0, 10),
    motionTilt: num(params, 'tilt', d.motionTilt, 0, 20),
    motionGust: num(params, 'gust', d.motionGust, 0, 10),
    comfort: num(params, 'comfort', d.comfort, 0, 600),
    label: (params.get('label') ?? d.label).slice(0, 40),
    bot: bool(params, 'bot', d.bot),
  };
}

/** Where the Settings menu keeps its choices, as a URL query string. */
export const SAVED_SETTINGS_KEY = 'patchwork-airship.settings';

/** The saved settings with the URL's on top, as one query string. */
export function mergeSettings(saved: string, search: string): string {
  const params = new URLSearchParams(saved);
  new URLSearchParams(search).forEach((value, key) => params.set(key, value));
  return params.toString();
}

function savedSettings(): string {
  try {
    return localStorage.getItem(SAVED_SETTINGS_KEY) ?? '';
  } catch {
    return '';
  }
}

export const settings: Settings =
  typeof location === 'undefined' ? DEFAULT_SETTINGS : parseSettings(mergeSettings(savedSettings(), location.search));
