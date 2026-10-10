import { type BufferGeometry, createSystem, Euler, InputComponent, Mesh, Object3D, Quaternion, Vector3, VisibilityState } from '@iwsdk/core';
import { LobbyUi } from '../net/lobby-ui.js';
import { normaliseRoomCode } from '../net/lobby-protocol.js';
import { NetSession } from '../net/net-session.js';
import { createAvatarPose, decodePose, encodePose, type AvatarPose, type PoseHeader, type PoseSample, POSE_PACKET_BYTES, seqNewer } from '../net/pose-codec.js';
import { copyAvatar, copyPose, PoseBuffer } from '../net/pose-buffer.js';
import { Voice } from '../net/voice.js';
import {
  createAvatarHand,
  createAvatarHead,
  createAvatarLegs,
  avatarTorsoGeometry,
  crewCoat,
  createAvatarTorso,
  CREW_COLOR_NAMES,
  CREW_COLORS,
  HIP_BELOW_EYES,
  LEG_LENGTH,
} from '../scene-assets/avatar.scene-asset.js';
import type { PosedHand } from '../scene-assets/hand.scene-asset.js';
import { copyCurls, createFingerCurls, type FingerCurls, setCurls } from '../sim/hand-pose.js';
import { settings } from '../settings.js';
import { crewPresence } from '../net/crew-presence.js';
import { handCurls, handUse } from './grip-system.js';
import { HoldKind, LockedHand } from './hand-lock.js';
import { perf } from './perf-hud-system.js';
import { describeBrowser } from '../perf/platform-report.js';
import { vrStartMessage, vrSupportNote } from '../vr-messages.js';
import { onVrStart, startVr, vrStartState } from '../vr-start.js';

/**
 * Spike S4: two players in one gondola. Sends this player's head and hands
 * 45 times a second over the unreliable channel, and draws the crewmate from
 * a jitter buffer a little in the past so they move smoothly. Poses are in
 * ship space, which is the scene's space because the gondola never moves
 * (see the S2 record).
 *
 * The crew panel on the flat page creates or joins a room; `?room=ABCD` in
 * the URL joins on load. With no room the game is solo and nothing here runs.
 *
 * Spike S5 adds voice on the same connection (see src/net/voice.ts): the
 * crewmate's voice is placed at their mouth and heard from this player's
 * head. The Y button (left controller) or the crew panel's Mic button mutes.
 */

const SEND_HZ = 45;
/**
 * How far a scripted hand's grip is pitched back from level, rad: with the
 * controller's handle tilted forward like this, the glove's forearm lies
 * level (see the grip space in avatar.scene-asset.ts).
 */
const SCRIPTED_GRIP_PITCH = 0.9;
const STATS_LOG_MS = 5000;
/** Finger curls sent for a scripted hand: closed while it holds something, else relaxed. */
const SCRIPTED_HOLDING = createFingerCurls(1, 1, 1);
const SCRIPTED_RELAXED = createFingerCurls(0.35, 0.35, 0.3);
/** Where this player's coat colour is kept in the browser. */
const COLOR_KEY = 'patchwork-airship.colour';

/** The coat colour picked before, or a random one (kept for next time). */
function loadCrewColor(): number {
  try {
    const saved = Number(localStorage.getItem(COLOR_KEY) ?? Number.NaN);
    if (Number.isInteger(saved) && saved >= 0 && saved < CREW_COLORS.length) {
      return saved;
    }
    const picked = Math.floor(Math.random() * CREW_COLORS.length);
    localStorage.setItem(COLOR_KEY, String(picked));
    return picked;
  } catch {
    return Math.floor(Math.random() * CREW_COLORS.length);
  }
}

/** This player's coat colour, for their own hands (OwnHandsSystem). */
export const crewLook = { color: 0 };

/**
 * How far behind the newest packet to draw the crewmate: long enough that the
 * next packet has usually arrived (one and a half packet intervals, which
 * grow if the sender's frame rate drops below 45 fps) plus three times the
 * arrival jitter, kept between 30 and 200 ms. The one-way network delay is
 * added on top of this.
 */
export function bufferDelayMs(packetIntervalMs: number, arrivalJitterMs: number): number {
  return Math.min(200, Math.max(30, 1.5 * packetIntervalMs + 3 * arrivalJitterMs + 5));
}

/** Pose flag bits: hand tracked (0, 1) and hand holding a crank handle (2, 3). */
export const FLAG_LEFT_TRACKED = 1;
export const FLAG_RIGHT_TRACKED = 2;
export const FLAG_LEFT_CRANK = 4;
export const FLAG_RIGHT_CRANK = 8;
/** Pose flag bits: hand holding the mooring line (4, 5). */
export const FLAG_LEFT_ROPE = 16;
export const FLAG_RIGHT_ROPE = 32;

/**
 * What a hand holds, as a HoldKind, for grip locking: the crank or the line
 * from the pose flags (this player's from the crank and rope systems'
 * extra flags), else the gondola control in `use` (handUse, this player's
 * own hands only).
 */
export function holdKindOf(side: 'left' | 'right', flags: number, use: string | null): number {
  if (flags & (side === 'left' ? FLAG_LEFT_CRANK : FLAG_RIGHT_CRANK)) return HoldKind.Crank;
  if (flags & (side === 'left' ? FLAG_LEFT_ROPE : FLAG_RIGHT_ROPE)) return HoldKind.Rope;
  return use === 'tiller' ? HoldKind.Tiller : use === 'vent' ? HoldKind.Vent : use === 'bell' ? HoldKind.Bell : HoldKind.None;
}

/**
 * What other systems (the crank, the rope and loose objects) need from the
 * network, without reaching into NetSystem: connection state, the crewmate's
 * pose as drawn this frame and the local time it describes, extra pose flags
 * and hand positions to send, a way to send packets, and handlers for packet
 * types other than poses.
 */
export const netLink = {
  connected: false,
  isHost: true,
  /** The crewmate's pose as drawn this frame (valid when haveRemote). */
  remote: createAvatarPose(),
  haveRemote: false,
  /** Local time the drawn crewmate pose describes, ms. */
  remoteAtMs: Number.NaN,
  /** Extra flag bits OR-ed into this player's pose packets, one entry per system (crank, rope). */
  extraFlags: {} as Record<string, number>,
  /**
   * Hand poses to send instead of the tracked ones (tests without a headset),
   * as functions of the send time so the pose matches its timestamp, or null.
   */
  handOverride: {
    left: null as ((nowMs: number) => PoseSample) | null,
    right: null as ((nowMs: number) => PoseSample) | null,
  },
  /** A scripted hand is squeezing (holding a brick), so it is sent as a fist. */
  scriptedSqueeze: { left: false, right: false },
  /** A head pose to send instead of the camera's (the practice crewmate), or null. */
  headOverride: null as ((nowMs: number) => PoseSample) | null,
  send: (_buffer: ArrayBuffer, _length: number): void => undefined,
  /** The clock offset to the crewmate is known (packet times can be placed). */
  clockSynced: false,
  /** Convert the crewmate's clock to ours. */
  toLocal: (peerMs: number): number => peerMs,
  handlers: new Map<number, (view: DataView) => void>(),
  /** Send a game event on the reliable, ordered channel (an object with a string `t`). */
  sendEvent: (_event: { t: string }): void => undefined,
  /** Handlers for reliable events, by their `t`. */
  events: new Map<string, (event: Record<string, unknown>) => void>(),
  /** Name of the microphone voice is using, '' before it opens. */
  micLabel: '',
};

export function lobbyBaseUrl(): string {
  if (settings.lobby) {
    return settings.lobby;
  }
  const configured = import.meta.env.VITE_LOBBY_URL as string | undefined;
  if (configured) {
    return configured;
  }
  // Development: the Vite server proxies /parties to the local lobby.
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

interface NetDebug {
  session: NetSession;
  room: string;
  sent: number;
  received: number;
  renderDelayMs: number;
  /** Local time the drawn crewmate pose describes, ms. */
  remoteAtMs: number;
  packetIntervalMs: number;
  arrivalJitterMs: number;
  /** Frames drawn by extrapolating because the next packet was late. */
  lateFrames: number;
  /**
   * Override the local pose that gets sent (tests without a headset): a fixed
   * pose, or a function of the send time so a moving test pose is stamped
   * exactly. null restores tracking.
   */
  setTestPose(pose: AvatarPose | ((nowMs: number) => AvatarPose) | null): void;
  /** The crewmate's pose as currently drawn, or null before any packets. */
  remotePose(): AvatarPose | null;
  /** Where the crewmate's hands are drawn (on what they hold, with grip locking), ship space. */
  crewHands(): { left: number[]; right: number[] };
  /** This player's coat colour, and the crewmate's as last told. */
  color: number;
  remoteColor: number;
  join(room: string): void;
  leave(): void;
  voice: Voice;
}

export class NetSystem extends createSystem({}) {
  private session!: NetSession;
  private ui: LobbyUi | null = null;
  private room = '';
  private local = createAvatarPose();
  private testPose: AvatarPose | ((nowMs: number) => AvatarPose) | null = null;
  private remote = createAvatarPose();
  private haveRemote = false;
  private buffer = new PoseBuffer();
  private header: PoseHeader = { seq: 0, timeMs: 0 };
  private incoming = createAvatarPose();
  private lastSeq = -1;
  private sendBuffer = new ArrayBuffer(POSE_PACKET_BYTES);
  private seq = 0;
  private sendAccumulator = 0;
  private sent = 0;
  private received = 0;
  /** Total delay between the crewmate moving and us drawing it, ms. */
  private delayMs = Number.NaN;
  /** Smoothed one-way delay (send to arrival), time between pose packets, and RFC 3550-style arrival jitter, ms. */
  private transit = Number.NaN;
  private packetInterval = 1000 / SEND_HZ;
  private arrivalJitter = 0;
  private lastArrival = Number.NaN;
  /** Spike S10: when the connection opened, the crewmate's last presence report, and ours. */
  private connectedAt = 0;
  private crewAway = false;
  private sentAway: boolean | null = null;
  private lastTransit = Number.NaN;
  private head!: Mesh;
  private torso!: Mesh;
  private legs!: Mesh;
  private leftHand!: PosedHand;
  private rightHand!: PosedHand;
  /** Grip locking for the crewmate's hands, and their curls as drawn. */
  private crewLocks = { left: new LockedHand(), right: new LockedHand() };
  private crewCurls = { left: createFingerCurls(), right: createFingerCurls() };
  private tmpPos = new Vector3();
  private tmpQuat = new Quaternion();
  private tmpScale = new Vector3();
  private tmpEuler = new Euler(0, 0, 0, 'YXZ');
  private scriptedGrip = new Quaternion();
  private readonly gripPitch = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), SCRIPTED_GRIP_PITCH);
  private readonly yAxis = new Vector3(0, 1, 0);
  private debug!: NetDebug;
  private voice!: Voice;
  private listenerPos = new Vector3();
  private listenerQuat = new Quaternion();
  private forward = new Vector3();
  private up = new Vector3();
  private mouth = new Vector3();
  private statsTimer = 0;
  private color = loadCrewColor();
  /** The crewmate's coat colour, as last told. */
  private remoteColor = 1;

  init(): void {
    crewLook.color = this.color;
    // The practice crewmate has nothing to say, and shouldn't open the microphone.
    this.voice = new Voice(settings.bot ? 'off' : settings.voice, settings.voiceLoop, (track) => {
      netLink.micLabel = track?.label ?? '';
      this.session.setMicTrack(track);
    });
    this.session = new NetSession({
      onState: (state, detail) => {
        this.ui?.update(state, this.room, detail);
        console.info(`[Net] ${state}${detail ? `: ${detail}` : ''}`);
        clearInterval(this.statsTimer);
        if (state === 'connected') {
          this.session.sendEvent({ t: 'look', color: this.color });
          // Which route the connection took, and how long it took to set up.
          setTimeout(() => {
            void this.session.updateReport().then(() =>
              console.info(
                `[Net] connected via ${this.session.report.candidates} (${this.session.report.protocol}) in ${this.session.connectMs.toFixed(0)} ms`,
              ),
            );
          }, 1000);
          this.statsTimer = window.setInterval(() => void this.logStats(), STATS_LOG_MS);
        }
        this.crewAway = false;
        this.sentAway = null;
        this.connectedAt = performance.now();
        if (state !== 'connected') {
          this.voice.stopRemote();
          this.haveRemote = false;
          this.buffer.clear();
          this.lastSeq = -1;
          this.lastArrival = this.lastTransit = this.transit = Number.NaN;
        }
      },
      onPacket: (view) => this.onPacket(view),
      onEvent: (event) => {
        const e = event as Record<string, unknown>;
        if (typeof e?.t === 'string') {
          netLink.events.get(e.t)?.(e);
        }
      },
      onRemoteAudio: (stream) => this.voice.playRemote(stream),
    }, { lagMs: settings.netLag, jitterMs: settings.netJitter, loss: settings.netLoss });

    this.createRemoteAvatar();
    netLink.remote = this.remote;
    netLink.send = (buffer, length) => this.session.sendUnreliable(buffer, length);
    netLink.sendEvent = (event) => this.session.sendEvent(event);
    netLink.toLocal = (peerMs) => this.session.clock.toLocal(peerMs);

    const self = this;
    this.debug = {
      session: this.session,
      get room() { return self.room; },
      get sent() { return self.sent; },
      get received() { return self.received; },
      get renderDelayMs() { return self.delayMs; },
      get remoteAtMs() { return netLink.remoteAtMs; },
      get packetIntervalMs() { return self.packetInterval; },
      get arrivalJitterMs() { return self.arrivalJitter; },
      get lateFrames() { return self.buffer.late; },
      setTestPose: (pose) => { this.testPose = pose; },
      remotePose: () => (this.haveRemote ? this.remote : null),
      crewHands: () => ({ left: this.leftHand.mesh.position.toArray(), right: this.rightHand.mesh.position.toArray() }),
      get color() { return self.color; },
      get remoteColor() { return self.remoteColor; },
      join: (room) => this.join(room),
      leave: () => this.leave(),
      voice: this.voice,
    } as NetDebug;
    (window as unknown as { __net: NetDebug }).__net = this.debug;

    this.ui = new LobbyUi({
      onJoin: (room) => this.join(room),
      onLeave: () => this.leave(),
      onMute: () => this.toggleMute(),
      onAllowMic: () => {
        this.voice.resume();
        void this.voice.askPermission().then(() => this.showMic());
      },
      onColor: (index) => this.setColor(index),
      onEnterVr: () => {
        this.voice.resume();
        startVr(this.world);
      },
      colors: CREW_COLORS,
      colorNames: CREW_COLOR_NAMES,
      color: this.color,
    });
    void this.voice.checkPermission().then(() => this.showMic());
    // Whether to offer Enter VR. A desktop browser can see no headset when the
    // page opened before Link was running, so look again when it reports a
    // device change or the window comes back into focus.
    const kind = describeBrowser(navigator.userAgent).kind;
    const checkVr = () => {
      const xr = navigator.xr;
      if (xr == null) {
        const { button, note } = vrSupportNote(kind, false, false);
        this.ui?.showEnterVr(button, note);
        return;
      }
      void xr
        .isSessionSupported('immersive-vr')
        .catch(() => false)
        .then((supported) => {
          const { button, note } = vrSupportNote(kind, true, supported);
          this.ui?.showEnterVr(button, note);
        });
    };
    checkVr();
    navigator.xr?.addEventListener('devicechange', checkVr);
    window.addEventListener('focus', checkVr);
    // How a press of Enter VR is going, ticking each second while it starts.
    let vrTick: ReturnType<typeof setInterval> | undefined;
    const showVrStart = () => {
      const state = vrStartState();
      this.ui?.setVrStart(vrStartMessage(state, performance.now(), kind), state.phase === 'starting');
      if (state.phase === 'starting' && vrTick === undefined) {
        vrTick = setInterval(showVrStart, 1000);
      } else if (state.phase !== 'starting' && vrTick !== undefined) {
        clearInterval(vrTick);
        vrTick = undefined;
      }
    };
    // Browsers only start audio after a user gesture: any click, or entering VR.
    const resume = () => this.voice.resume();
    window.addEventListener('pointerdown', resume);
    this.cleanupFuncs.push(
      () => window.removeEventListener('pointerdown', resume),
      () => navigator.xr?.removeEventListener('devicechange', checkVr),
      () => window.removeEventListener('focus', checkVr),
      onVrStart(showVrStart),
      () => clearInterval(vrTick),
      () => clearInterval(this.statsTimer),
      () => this.session.close(),
      () => this.voice.dispose(),
      () => this.ui?.dispose(),
      this.world.visibilityState.subscribe((v) => {
        this.ui?.show(v === VisibilityState.NonImmersive);
        if (v !== VisibilityState.NonImmersive) {
          this.voice.resume();
        }
        this.sendPresence();
      }),
      () => document.removeEventListener('visibilitychange', onPageVisibility),
      () => netLink.events.delete('presence'),
      () => netLink.events.delete('look'),
    );
    // The crewmate's coat colour.
    netLink.events.set('look', (event) => {
      const index = Number(event.color);
      if (Number.isInteger(index) && index >= 0 && index < CREW_COLORS.length && index !== this.remoteColor) {
        this.recolorRemote(index);
      }
    });
    // Spike S10: tell the crewmate when this player stops seeing the game
    // (headset off, Meta button, tab hidden). These events still fire while
    // the page's frames are paused.
    const onPageVisibility = () => this.sendPresence();
    document.addEventListener('visibilitychange', onPageVisibility);
    netLink.events.set('presence', (event) => {
      this.crewAway = event.away === true;
    });
    // The lobby only knows four-letter codes; anything else in the link is ignored.
    const code = settings.room ? normaliseRoomCode(settings.room) : null;
    if (code) {
      this.ui.join(code);
    }
  }

  /** Hidden page, headset off or asleep, or a system menu over the game. */
  private isAway(): boolean {
    const v = this.world.visibilityState.peek();
    return document.visibilityState === 'hidden' || v === VisibilityState.Hidden || v === VisibilityState.VisibleBlurred;
  }

  private sendPresence(): void {
    if (this.session?.state !== 'connected') {
      return;
    }
    const away = this.isAway();
    if (away !== this.sentAway) {
      this.sentAway = away;
      this.session.sendEvent({ t: 'presence', away });
    }
  }

  private join(room: string): void {
    this.room = room;
    const name = settings.name || (settings.bot ? 'Practice crewmate' : `Crew ${Math.floor(Math.random() * 900 + 100)}`);
    this.session.join(lobbyBaseUrl(), room, name, this.color);
    this.voice.resume();
    void this.voice.startMic().then(() => this.showMic());
  }

  private toggleMute(): void {
    this.voice.setMuted(!this.voice.muted);
    this.showMic();
    console.info(`[Voice] ${this.voice.muted ? 'muted' : 'unmuted'}`);
  }

  private showMic(): void {
    const v = this.voice;
    this.ui?.setMic({ muted: v.muted, error: v.micError, on: v.micTrack !== null, permitted: v.permitted || !v.enabled });
  }

  /** This player's coat colour, kept in the browser and shown to the crewmate. */
  private setColor(index: number): void {
    this.color = index;
    crewLook.color = index;
    try {
      localStorage.setItem(COLOR_KEY, String(index));
    } catch {
      // Private browsing: the colour lasts for this visit only.
    }
    if (this.session.state === 'connected') {
      this.session.sendEvent({ t: 'look', color: index });
    }
  }

  /** Dress the crewmate in coat colour `index`. */
  private recolorRemote(index: number): void {
    this.remoteColor = index;
    const swap = (mesh: Mesh, geometry: BufferGeometry) => {
      mesh.geometry.dispose();
      mesh.geometry = geometry;
    };
    swap(this.torso, avatarTorsoGeometry(index));
    this.leftHand.setCoat(crewCoat(index));
    this.rightHand.setCoat(crewCoat(index));
  }

  private async logStats(): Promise<void> {
    await this.session.updateReport();
    const s = this.session.clock.stats;
    const r = this.session.report;
    console.info(
      `[Net] rtt ${s.srtt.toFixed(1)} ms (jitter ${s.jitter.toFixed(1)}), avatar delay ${this.delayMs.toFixed(0)} ms, ` +
        `pose packets ${r.received} lost ${r.lost}, voice buffer ${r.audioJitterBufferMs.toFixed(0)} ms lost ${r.audioLost} ` +
        `concealed ${(r.audioConcealed * 100).toFixed(1)}%, route ${r.candidates}`,
    );
  }

  private leave(): void {
    this.session.close();
    this.room = '';
  }

  private createRemoteAvatar(): void {
    // Until the crewmate says which coat colour they picked.
    const index = this.remoteColor;
    this.head = createAvatarHead(index);
    this.torso = createAvatarTorso(index);
    this.legs = createAvatarLegs(index);
    this.leftHand = createAvatarHand(index, 'left');
    this.rightHand = createAvatarHand(index, 'right');
    for (const mesh of [this.head, this.torso, this.legs, this.leftHand.mesh, this.rightHand.mesh]) {
      mesh.visible = false;
      this.world.createTransformEntity(mesh);
    }
  }

  private onPacket(view: DataView): void {
    if (!decodePose(view, this.header, this.incoming)) {
      netLink.handlers.get(view.getUint8(0))?.(view);
      return;
    }
    this.accept(this.header.seq, this.header.timeMs, this.incoming);
  }

  private accept(seq: number, peerTimeMs: number, pose: AvatarPose): void {
    const report = this.session.report;
    if (this.lastSeq >= 0) {
      if (!seqNewer(seq, this.lastSeq)) {
        return; // late duplicate or reordered packet: the buffer already has newer
      }
      report.lost += ((seq - this.lastSeq) & 0xffff) - 1;
    }
    this.lastSeq = seq;
    report.received++;
    this.received++;
    if (this.session.clock.stats.samples === 0) {
      return; // no clock offset yet, so the timestamp can't be placed
    }
    const now = performance.now();
    const sentLocal = this.session.clock.toLocal(peerTimeMs);
    const transit = now - sentLocal;
    this.transit = Number.isNaN(this.transit) ? transit : this.transit + (transit - this.transit) / 16;
    if (!Number.isNaN(this.lastArrival)) {
      this.packetInterval += (Math.min(now - this.lastArrival, 500) - this.packetInterval) / 16;
      this.arrivalJitter += (Math.abs(transit - this.lastTransit) - this.arrivalJitter) / 16;
    }
    this.lastArrival = now;
    this.lastTransit = transit;
    this.buffer.push(sentLocal, pose);
  }

  update(delta: number): void {
    const session = this.session;
    netLink.connected = session.state === 'connected';
    netLink.isHost = session.isHost || !netLink.connected;
    netLink.haveRemote = false;
    netLink.clockSynced = netLink.connected && session.clock.stats.samples > 0;
    const now = performance.now();
    crewPresence.update(
      session.state,
      session.reconnecting,
      this.crewAway,
      Number.isNaN(this.lastArrival) ? now - this.connectedAt : now - this.lastArrival,
    );
    if (session.state !== 'connected') {
      if (this.head.visible) {
        this.setRemoteVisible(false, 0);
      }
      return;
    }
    const stats = session.clock.stats;
    perf.rttMs = stats.srtt;
    if (this.input.xr.gamepads.left?.getButtonDown(InputComponent.Y_Button)) {
      this.toggleMute();
    }

    // Send this player's pose at 45 Hz.
    this.sendAccumulator += delta;
    if (this.sendAccumulator >= 1 / SEND_HZ) {
      this.sendAccumulator = Math.min(this.sendAccumulator - 1 / SEND_HZ, 1 / SEND_HZ);
      const now = performance.now();
      const test = this.testPose;
      const pose = test === null ? this.readLocalPose() : this.local;
      if (test !== null) {
        copyAvatar(withFingers(typeof test === 'function' ? test(now) : test), this.local);
      }
      for (const key in netLink.extraFlags) {
        pose.flags |= netLink.extraFlags[key];
      }
      if (netLink.headOverride) {
        copyPose(netLink.headOverride(now), pose.head);
      }
      if (netLink.handOverride.left || netLink.handOverride.right) {
        // Scripted hands (the practice crewmate, tests) give only a position:
        // hold them as a player would, facing the way the head does.
        this.tmpQuat.set(pose.head.qx, pose.head.qy, pose.head.qz, pose.head.qw);
        this.tmpEuler.setFromQuaternion(this.tmpQuat, 'YXZ');
        this.scriptedGrip.setFromAxisAngle(this.yAxis, this.tmpEuler.y).multiply(this.gripPitch);
      }
      if (netLink.handOverride.left) {
        copyPose(netLink.handOverride.left(now), pose.left);
        this.holdScripted(pose.left);
        const holding = (pose.flags & (FLAG_LEFT_CRANK | FLAG_LEFT_ROPE)) !== 0 || netLink.scriptedSqueeze.left;
        copyCurls(holding ? SCRIPTED_HOLDING : SCRIPTED_RELAXED, pose.leftFingers);
      }
      if (netLink.handOverride.right) {
        copyPose(netLink.handOverride.right(now), pose.right);
        this.holdScripted(pose.right);
        const holding = (pose.flags & (FLAG_RIGHT_CRANK | FLAG_RIGHT_ROPE)) !== 0 || netLink.scriptedSqueeze.right;
        copyCurls(holding ? SCRIPTED_HOLDING : SCRIPTED_RELAXED, pose.rightFingers);
      }
      pose.holds =
        holdKindOf('left', pose.flags, test === null ? handUse.left : null) |
        (holdKindOf('right', pose.flags, test === null ? handUse.right : null) << 4);
      const length = encodePose(this.sendBuffer, this.seq, now, pose);
      this.seq = (this.seq + 1) & 0xffff;
      session.sendUnreliable(this.sendBuffer, length);
      this.sent++;
    }

    // Draw the crewmate a little in the past.
    this.delayMs = Math.max(0, this.transit) + bufferDelayMs(this.packetInterval, this.arrivalJitter);
    if (this.buffer.count > 0 && this.buffer.sample(performance.now() - this.delayMs, this.remote)) {
      this.haveRemote = true;
      netLink.haveRemote = true;
      netLink.remoteAtMs = performance.now() - this.delayMs;
      this.applyRemote();
      this.placeVoice();
    }
  }

  /** Hear the crewmate's voice from their mouth, relative to this player's head. */
  private placeVoice(): void {
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    const head = immersive ? this.player.head : this.camera;
    head.updateWorldMatrix(true, false);
    head.matrixWorld.decompose(this.listenerPos, this.listenerQuat, this.tmpScale);
    this.forward.set(0, 0, -1).applyQuaternion(this.listenerQuat);
    this.up.set(0, 1, 0).applyQuaternion(this.listenerQuat);
    this.voice.setListener(this.listenerPos, this.forward, this.up);
    const h = this.remote.head;
    this.tmpQuat.set(h.qx, h.qy, h.qz, h.qw);
    this.mouth.set(0, -0.08, -0.06).applyQuaternion(this.tmpQuat);
    this.mouth.x += h.px;
    this.mouth.y += h.py;
    this.mouth.z += h.pz;
    this.voice.setSource(this.mouth);
  }

  private holdScripted(hand: PoseSample): void {
    hand.qx = this.scriptedGrip.x;
    hand.qy = this.scriptedGrip.y;
    hand.qz = this.scriptedGrip.z;
    hand.qw = this.scriptedGrip.w;
  }

  private readLocalPose(): AvatarPose {
    const player = this.player;
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    readWorldPose(immersive ? player.head : this.camera, this.local.head, this.tmpPos, this.tmpQuat, this.tmpScale);
    const xr = this.input.xr;
    let flags = 0;
    if (immersive && xr.getPrimaryInputSource('left')) {
      readWorldPose(player.gripSpaces.left, this.local.left, this.tmpPos, this.tmpQuat, this.tmpScale);
      flags |= FLAG_LEFT_TRACKED;
    }
    if (immersive && xr.getPrimaryInputSource('right')) {
      readWorldPose(player.gripSpaces.right, this.local.right, this.tmpPos, this.tmpQuat, this.tmpScale);
      flags |= FLAG_RIGHT_TRACKED;
    }
    this.local.flags = flags;
    copyCurls(handCurls.left, this.local.leftFingers);
    copyCurls(handCurls.right, this.local.rightFingers);
    return this.local;
  }

  private applyRemote(): void {
    const r = this.remote;
    setFromPose(this.head, r.head);
    // Torso: its mesh hangs below the head origin and turns only with the head's yaw.
    this.torso.position.set(r.head.px, r.head.py, r.head.pz);
    this.tmpQuat.set(r.head.qx, r.head.qy, r.head.qz, r.head.qw);
    this.tmpEuler.setFromQuaternion(this.tmpQuat, 'YXZ');
    this.torso.rotation.set(0, this.tmpEuler.y, 0);
    // Legs stand on the deck under the torso and stretch or squash to reach
    // it, so a crouching or seated crewmate never sinks into the floor.
    this.legs.position.set(r.head.px, 0, r.head.pz);
    this.legs.rotation.set(0, this.tmpEuler.y, 0);
    this.legs.scale.y = Math.min(1.3, Math.max(0.3, (r.head.py - HIP_BELOW_EYES) / LEG_LENGTH));
    setFromPose(this.leftHand.mesh, r.left);
    setFromPose(this.rightHand.mesh, r.right);
    // Their fingers are posed, and hands locked to what they hold, in lockCrewHands.
    this.setRemoteVisible(true, r.flags);
  }

  /**
   * Draw the crewmate's hands on whatever they hold (grip locking). Run late
   * in the frame (OwnHandsSystem calls it), once the crank, line and
   * controls have moved. Their bell lanyard isn't drawn here in their hand,
   * so a hand on it isn't locked.
   */
  lockCrewHands(dt: number): void {
    if (!netLink.haveRemote) {
      return;
    }
    const r = this.remote;
    for (const side of ['left', 'right'] as const) {
      const hand = side === 'left' ? this.leftHand : this.rightHand;
      if (!hand.mesh.visible) {
        continue;
      }
      const sent = (r.holds >> (side === 'left' ? 0 : 4)) & 15;
      // A crewmate on a version before grip locking sends no kinds; the crank and line are in its flags.
      const kind = sent !== HoldKind.None ? sent : holdKindOf(side, r.flags, null);
      const p = side === 'left' ? r.left : r.right;
      this.tmpPos.set(p.px, p.py, p.pz);
      this.tmpQuat.set(p.qx, p.qy, p.qz, p.qw);
      const curls = copyCurls(side === 'left' ? r.leftFingers : r.rightFingers, this.crewCurls[side]);
      this.crewLocks[side].update(dt, kind === HoldKind.Bell ? HoldKind.None : kind, this.tmpPos, this.tmpQuat, hand.mesh.position, hand.mesh.quaternion, curls);
      hand.pose(curls);
    }
  }

  private setRemoteVisible(visible: boolean, flags: number): void {
    this.head.visible = visible;
    this.torso.visible = visible;
    this.legs.visible = visible;
    this.leftHand.mesh.visible = visible && (flags & FLAG_LEFT_TRACKED) !== 0;
    this.rightHand.mesh.visible = visible && (flags & FLAG_RIGHT_TRACKED) !== 0;
  }
}

/** A test pose from a script may leave out the fingers: draw those hands as fists. */
function withFingers(pose: AvatarPose): AvatarPose {
  const p = pose as Partial<Pick<AvatarPose, 'leftFingers' | 'rightFingers' | 'holds'>> & AvatarPose;
  p.leftFingers ??= setCurls({} as FingerCurls, 1, 1, 1);
  p.rightFingers ??= setCurls({} as FingerCurls, 1, 1, 1);
  p.holds ??= 0;
  return p;
}

function readWorldPose(object: Object3D, out: PoseSample, pos: Vector3, quat: Quaternion, scale: Vector3): void {
  object.updateWorldMatrix(true, false);
  object.matrixWorld.decompose(pos, quat, scale);
  out.px = pos.x; out.py = pos.y; out.pz = pos.z;
  out.qx = quat.x; out.qy = quat.y; out.qz = quat.z; out.qw = quat.w;
}

function setFromPose(object: Object3D, p: PoseSample): void {
  object.position.set(p.px, p.py, p.pz);
  object.quaternion.set(p.qx, p.qy, p.qz, p.qw);
}
