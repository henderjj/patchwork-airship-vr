import { createSystem, Euler, Mesh, Object3D, Quaternion, Vector3, VisibilityState } from '@iwsdk/core';
import { LobbyUi } from '../net/lobby-ui.js';
import { NetSession } from '../net/net-session.js';
import { createAvatarPose, decodePose, encodePose, type AvatarPose, type PoseHeader, type PoseSample, POSE_PACKET_BYTES, seqNewer } from '../net/pose-codec.js';
import { PoseBuffer } from '../net/pose-buffer.js';
import { createAvatarHand, createAvatarHead, createAvatarTorso, CREW_COLORS } from '../scene-assets/avatar.scene-asset.js';
import { settings } from '../settings.js';
import { perf } from './perf-hud-system.js';

/**
 * Spike S4: two players in one gondola. Sends this player's head and hands
 * 45 times a second over the unreliable channel, and draws the crewmate from
 * a jitter buffer a little in the past so they move smoothly. Poses are in
 * ship space, which is the scene's space because the gondola never moves
 * (see the S2 record).
 *
 * The crew panel on the flat page creates or joins a room; `?room=ABCD` in
 * the URL joins on load. With no room the game is solo and nothing here runs.
 */

const SEND_HZ = 45;

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
  join(room: string): void;
  leave(): void;
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
  private lastTransit = Number.NaN;
  private head!: Mesh;
  private torso!: Mesh;
  private leftHand!: Mesh;
  private rightHand!: Mesh;
  private tmpPos = new Vector3();
  private tmpQuat = new Quaternion();
  private tmpScale = new Vector3();
  private tmpEuler = new Euler(0, 0, 0, 'YXZ');
  private debug!: NetDebug;

  init(): void {
    this.session = new NetSession({
      onState: (state, detail) => {
        this.ui?.update(state, this.room, detail);
        console.info(`[Net] ${state}${detail ? `: ${detail}` : ''}`);
        if (state === 'connected') {
          // Which route the connection took, and how long it took to set up.
          setTimeout(() => {
            void this.session.updateReport().then(() =>
              console.info(
                `[Net] connected via ${this.session.report.candidates} (${this.session.report.protocol}) in ${this.session.connectMs.toFixed(0)} ms`,
              ),
            );
          }, 1000);
        }
        if (state !== 'connected') {
          this.haveRemote = false;
          this.buffer.clear();
          this.lastSeq = -1;
          this.lastArrival = this.lastTransit = this.transit = Number.NaN;
        }
      },
      onPacket: (view) => this.onPacket(view),
    }, { lagMs: settings.netLag, jitterMs: settings.netJitter, loss: settings.netLoss });

    this.createRemoteAvatar();

    const self = this;
    this.debug = {
      session: this.session,
      get room() { return self.room; },
      get sent() { return self.sent; },
      get received() { return self.received; },
      get renderDelayMs() { return self.delayMs; },
      get packetIntervalMs() { return self.packetInterval; },
      get arrivalJitterMs() { return self.arrivalJitter; },
      get lateFrames() { return self.buffer.late; },
      setTestPose: (pose) => { this.testPose = pose; },
      remotePose: () => (this.haveRemote ? this.remote : null),
      join: (room) => this.join(room),
      leave: () => this.leave(),
    } as NetDebug;
    (window as unknown as { __net: NetDebug }).__net = this.debug;

    this.ui = new LobbyUi((room) => this.join(room), () => this.leave());
    this.cleanupFuncs.push(
      () => this.session.close(),
      () => this.ui?.dispose(),
      this.world.visibilityState.subscribe((v) => this.ui?.show(v === VisibilityState.NonImmersive)),
    );
    if (settings.room) {
      this.ui.join(settings.room.toUpperCase());
    }
  }

  private join(room: string): void {
    this.room = room;
    const color = Math.floor(Math.random() * CREW_COLORS.length);
    const name = settings.name || `Crew ${Math.floor(Math.random() * 900 + 100)}`;
    this.session.join(lobbyBaseUrl(), room, name, color);
  }

  private leave(): void {
    this.session.close();
    this.room = '';
  }

  private createRemoteAvatar(): void {
    // Coat colour is fixed per role for now: the host's crewmate wears the second colour.
    const index = 1;
    this.head = createAvatarHead(index);
    this.torso = createAvatarTorso(index);
    this.leftHand = createAvatarHand(index, 'left');
    this.rightHand = createAvatarHand(index, 'right');
    for (const mesh of [this.head, this.torso, this.leftHand, this.rightHand]) {
      mesh.visible = false;
      this.world.createTransformEntity(mesh);
    }
  }

  private onPacket(view: DataView): void {
    if (!decodePose(view, this.header, this.incoming)) {
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
    if (session.state !== 'connected') {
      if (this.head.visible) {
        this.setRemoteVisible(false, 0);
      }
      return;
    }
    const stats = session.clock.stats;
    perf.rttMs = stats.srtt;

    // Send this player's pose at 45 Hz.
    this.sendAccumulator += delta;
    if (this.sendAccumulator >= 1 / SEND_HZ) {
      this.sendAccumulator = Math.min(this.sendAccumulator - 1 / SEND_HZ, 1 / SEND_HZ);
      const now = performance.now();
      const test = this.testPose;
      const pose = test === null ? this.readLocalPose() : typeof test === 'function' ? test(now) : test;
      const length = encodePose(this.sendBuffer, this.seq, now, pose);
      this.seq = (this.seq + 1) & 0xffff;
      session.sendUnreliable(this.sendBuffer, length);
      this.sent++;
    }

    // Draw the crewmate a little in the past.
    this.delayMs = Math.max(0, this.transit) + bufferDelayMs(this.packetInterval, this.arrivalJitter);
    if (this.buffer.count > 0 && this.buffer.sample(performance.now() - this.delayMs, this.remote)) {
      this.haveRemote = true;
      this.applyRemote();
    }
  }

  private readLocalPose(): AvatarPose {
    const player = this.player;
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    readWorldPose(immersive ? player.head : this.camera, this.local.head, this.tmpPos, this.tmpQuat, this.tmpScale);
    const xr = this.input.xr;
    let flags = 0;
    if (immersive && xr.getPrimaryInputSource('left')) {
      readWorldPose(player.gripSpaces.left, this.local.left, this.tmpPos, this.tmpQuat, this.tmpScale);
      flags |= 1;
    }
    if (immersive && xr.getPrimaryInputSource('right')) {
      readWorldPose(player.gripSpaces.right, this.local.right, this.tmpPos, this.tmpQuat, this.tmpScale);
      flags |= 2;
    }
    this.local.flags = flags;
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
    setFromPose(this.leftHand, r.left);
    setFromPose(this.rightHand, r.right);
    this.setRemoteVisible(true, r.flags);
  }

  private setRemoteVisible(visible: boolean, flags: number): void {
    this.head.visible = visible;
    this.torso.visible = visible;
    this.leftHand.visible = visible && (flags & 1) !== 0;
    this.rightHand.visible = visible && (flags & 2) !== 0;
  }
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
