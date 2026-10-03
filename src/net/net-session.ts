import { ClockSync } from './clock-sync.js';
import type { CrewMember, RTCIceServerLike, ServerMessage, SignalData } from './lobby-protocol.js';
import { encodePing, encodePong, PacketType } from './pose-codec.js';

/**
 * One player's network session: joins a room on the lobby over a WebSocket,
 * then opens a direct WebRTC peer connection to the other crew member with
 * two data channels:
 *
 * - `u`: unordered, no retransmits (poses, pings), so a lost packet never
 *   holds up newer ones;
 * - `r`: reliable and ordered (grabs, releases, ownership and game events).
 *
 * The host (first to join) makes the offer. The offer also carries one
 * two-way audio transceiver for voice (spike S5); the microphone track is
 * attached with replaceTrack whenever it becomes available, so muting or a
 * late microphone permission never needs a renegotiation.
 */

export type SessionState = 'idle' | 'lobby' | 'waiting' | 'connecting' | 'connected' | 'full' | 'closed' | 'error';

export interface ConnectionReport {
  /** ICE candidate types of the selected pair, e.g. "host/host", "srflx/srflx", "relay/srflx". */
  candidates: string;
  protocol: string;
  /** Packets the peer sent that never arrived (from pose sequence gaps). */
  lost: number;
  received: number;
  /** Voice receive stats: average jitter-buffer delay (ms), lost packets, fraction of audio concealed. */
  audioJitterBufferMs: number;
  audioLost: number;
  audioConcealed: number;
  audioBytesReceived: number;
}

/** Test-only network conditions applied to received unreliable packets. */
export interface SimulatedConditions {
  /** Extra one-way delay, ms. */
  lagMs: number;
  /** Extra random delay, 0 to this many ms (also reorders packets). */
  jitterMs: number;
  /** Fraction of packets dropped, 0 to 1. */
  loss: number;
}

export interface NetSessionEvents {
  onState?(state: SessionState, detail?: string): void;
  onPacket?(view: DataView): void;
  onEvent?(event: unknown): void;
  /** The crewmate's voice arrived (or restarted). */
  onRemoteAudio?(stream: MediaStream): void;
}

const PING_INTERVAL_MS = 500;
const CONNECT_TIMEOUT_MS = 15000;

export class NetSession {
  state: SessionState = 'idle';
  you: CrewMember | null = null;
  peer: CrewMember | null = null;
  readonly clock = new ClockSync();
  readonly report: ConnectionReport = {
    candidates: '', protocol: '', lost: 0, received: 0,
    audioJitterBufferMs: Number.NaN, audioLost: 0, audioConcealed: 0, audioBytesReceived: 0,
  };
  /** Milliseconds from starting to join until the data channels opened. */
  connectMs = Number.NaN;

  private socket: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private unreliable: RTCDataChannel | null = null;
  private reliable: RTCDataChannel | null = null;
  private iceServers: RTCIceServerLike[] = [];
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private audio: RTCRtpTransceiver | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private pingTimer = 0;
  private connectTimer = 0;
  private joinStarted = 0;
  private pingBuffer = new ArrayBuffer(9);
  private pongBuffer = new ArrayBuffer(17);
  private readonly events: NetSessionEvents;
  private readonly simulated: SimulatedConditions | null;

  constructor(events: NetSessionEvents, simulated?: SimulatedConditions) {
    this.events = events;
    const active = simulated && (simulated.lagMs > 0 || simulated.jitterMs > 0 || simulated.loss > 0);
    this.simulated = active ? simulated : null;
  }

  get isHost(): boolean {
    return this.you?.host ?? false;
  }

  /** Join `room` on the lobby at `lobbyUrl` (ws:// or wss:// base). */
  join(lobbyUrl: string, room: string, name: string, color: number): void {
    this.close();
    this.joinStarted = performance.now();
    this.setState('lobby');
    const socket = new WebSocket(`${lobbyUrl.replace(/\/$/, '')}/parties/lobby/${room}`);
    this.socket = socket;
    socket.onopen = () => socket.send(JSON.stringify({ t: 'hello', name, color }));
    socket.onmessage = (event) => void this.onLobbyMessage(JSON.parse(String(event.data)) as ServerMessage);
    socket.onerror = () => this.setState('error', 'could not reach the lobby');
    socket.onclose = () => {
      if (this.state === 'lobby' || this.state === 'waiting') {
        this.setState('error', 'lobby connection closed');
      }
    };
  }

  /** Use `track` as this player's voice (null sends silence). */
  setMicTrack(track: MediaStreamTrack | null): void {
    this.micTrack = track;
    void this.audio?.sender.replaceTrack(track).catch(() => undefined);
  }

  /** Send a binary packet on the unreliable channel. */
  sendUnreliable(buffer: ArrayBuffer, length: number): void {
    if (this.unreliable?.readyState === 'open' && this.unreliable.bufferedAmount < 16384) {
      this.unreliable.send(new Uint8Array(buffer, 0, length));
    }
  }

  /** Send a game event on the reliable channel. */
  sendEvent(event: unknown): void {
    if (this.reliable?.readyState === 'open') {
      this.reliable.send(JSON.stringify(event));
    }
  }

  close(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.connectTimer);
    this.unreliable?.close();
    this.reliable?.close();
    this.pc?.close();
    this.socket?.close();
    this.unreliable = this.reliable = null;
    this.pc = null;
    this.socket = null;
    this.peer = null;
    if (this.state !== 'idle') {
      this.setState('closed');
    }
  }

  private setState(state: SessionState, detail?: string): void {
    this.state = state;
    this.events.onState?.(state, detail);
  }

  private async onLobbyMessage(message: ServerMessage): Promise<void> {
    switch (message.t) {
      case 'welcome':
        this.you = message.you;
        this.iceServers = message.iceServers;
        this.setState('waiting');
        if (message.crew.length > 0) {
          this.peer = message.crew[0];
          // The guest waits for the host's offer.
          this.createPeerConnection();
        }
        break;
      case 'joined':
        this.peer = message.member;
        this.createPeerConnection();
        if (this.isHost) {
          await this.makeOffer();
        }
        break;
      case 'left':
        if (this.you && message.newHost === this.you.id) {
          this.you.host = true;
        }
        this.peer = null;
        this.resetPeerConnection();
        this.setState('waiting', 'crewmate left');
        break;
      case 'signal':
        await this.onSignal(message.data);
        break;
      case 'full':
        this.setState('full', 'this crew already has two players');
        break;
      case 'error':
        this.setState('error', message.message);
        break;
    }
  }

  private createPeerConnection(): void {
    this.resetPeerConnection();
    // A new crewmate's clock has its own origin; old offsets would misplace every packet.
    this.clock.reset();
    this.setState('connecting');
    const pc = new RTCPeerConnection({ iceServers: this.iceServers as RTCIceServer[] });
    this.pc = pc;
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.signal({
          kind: 'candidate',
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        this.setState('error', 'peer connection failed');
      } else if (pc.connectionState === 'disconnected' && this.state === 'connected') {
        this.setState('connecting', 'connection interrupted');
      }
    };
    pc.ontrack = (event) => {
      if (event.track.kind === 'audio') {
        this.events.onRemoteAudio?.(event.streams[0] ?? new MediaStream([event.track]));
      }
    };
    if (this.isHost) {
      this.attachChannel(pc.createDataChannel('u', { ordered: false, maxRetransmits: 0 }));
      this.attachChannel(pc.createDataChannel('r', { ordered: true }));
      this.audio = pc.addTransceiver(this.micTrack ?? 'audio', { direction: 'sendrecv', streams: [new MediaStream()] });
    } else {
      pc.ondatachannel = (event) => this.attachChannel(event.channel);
    }
    this.connectTimer = window.setTimeout(() => {
      if (this.state === 'connecting') {
        this.setState('error', 'timed out connecting to crewmate');
      }
    }, CONNECT_TIMEOUT_MS);
  }

  private resetPeerConnection(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.connectTimer);
    this.unreliable?.close();
    this.reliable?.close();
    this.pc?.close();
    this.unreliable = this.reliable = null;
    this.pc = null;
    this.audio = null;
    this.pendingCandidates = [];
  }

  private async makeOffer(): Promise<void> {
    const pc = this.pc!;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signal({ kind: 'offer', sdp: offer.sdp ?? '' });
  }

  private async onSignal(data: SignalData): Promise<void> {
    const pc = this.pc;
    if (!pc) {
      return;
    }
    if (data.kind === 'offer') {
      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      // Answer the host's audio transceiver with our own microphone.
      this.audio = pc.getTransceivers().find((t) => t.receiver.track.kind === 'audio') ?? null;
      if (this.audio) {
        this.audio.direction = 'sendrecv';
        await this.audio.sender.replaceTrack(this.micTrack).catch(() => undefined);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.signal({ kind: 'answer', sdp: answer.sdp ?? '' });
      await this.flushCandidates();
    } else if (data.kind === 'answer') {
      await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      await this.flushCandidates();
    } else if (data.kind === 'candidate') {
      const candidate = { candidate: data.candidate, sdpMid: data.sdpMid, sdpMLineIndex: data.sdpMLineIndex };
      if (pc.remoteDescription) {
        await pc.addIceCandidate(candidate).catch(() => undefined);
      } else {
        this.pendingCandidates.push(candidate);
      }
    }
  }

  private async flushCandidates(): Promise<void> {
    for (const candidate of this.pendingCandidates) {
      await this.pc?.addIceCandidate(candidate).catch(() => undefined);
    }
    this.pendingCandidates = [];
  }

  private signal(data: SignalData): void {
    if (this.peer && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ t: 'signal', to: this.peer.id, data }));
    }
  }

  private attachChannel(channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    if (channel.label === 'u') {
      this.unreliable = channel;
      channel.onmessage = (event) => {
        const sim = this.simulated;
        if (!sim) {
          this.onUnreliable(event.data as ArrayBuffer);
        } else if (Math.random() >= sim.loss) {
          setTimeout(() => this.onUnreliable(event.data as ArrayBuffer), sim.lagMs + Math.random() * sim.jitterMs);
        }
      };
    } else {
      this.reliable = channel;
      channel.onmessage = (event) => {
        try {
          this.events.onEvent?.(JSON.parse(String(event.data)));
        } catch {
          // ignore malformed events
        }
      };
    }
    channel.onopen = () => this.checkOpen();
  }

  private checkOpen(): void {
    if (this.unreliable?.readyState === 'open' && this.reliable?.readyState === 'open') {
      clearTimeout(this.connectTimer);
      this.connectMs = performance.now() - this.joinStarted;
      this.setState('connected');
      const ping = () => this.sendUnreliable(this.pingBuffer, encodePing(this.pingBuffer, performance.now()));
      ping();
      this.pingTimer = window.setInterval(ping, PING_INTERVAL_MS);
      void this.updateReport();
    }
  }

  private onUnreliable(data: ArrayBuffer): void {
    const view = new DataView(data);
    const type = view.getUint8(0);
    if (type === PacketType.Ping) {
      this.sendUnreliable(this.pongBuffer, encodePong(this.pongBuffer, view.getFloat64(1), performance.now()));
    } else if (type === PacketType.Pong) {
      this.clock.onPong(view.getFloat64(1), view.getFloat64(9), performance.now());
    } else {
      this.events.onPacket?.(view);
    }
  }

  /** Record which ICE candidate types won (direct, via STUN, or relayed through TURN). */
  async updateReport(): Promise<void> {
    const pc = this.pc;
    if (!pc) {
      return;
    }
    const stats = await pc.getStats();
    let pairId = '';
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) {
        pairId = s.selectedCandidatePairId;
      }
    });
    stats.forEach((s) => {
      if ((pairId && s.id === pairId) || (!pairId && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded')) {
        const local = stats.get(s.localCandidateId);
        const remote = stats.get(s.remoteCandidateId);
        this.report.candidates = `${local?.candidateType ?? '?'}/${remote?.candidateType ?? '?'}`;
        this.report.protocol = local?.protocol ?? '';
      }
      if (s.type === 'inbound-rtp' && s.kind === 'audio') {
        const r = this.report;
        r.audioJitterBufferMs = s.jitterBufferEmittedCount > 0 ? (1000 * s.jitterBufferDelay) / s.jitterBufferEmittedCount : Number.NaN;
        r.audioLost = s.packetsLost ?? 0;
        r.audioConcealed = s.totalSamplesReceived > 0 ? (s.concealedSamples ?? 0) / s.totalSamplesReceived : 0;
        r.audioBytesReceived = s.bytesReceived ?? 0;
      }
    });
  }
}
