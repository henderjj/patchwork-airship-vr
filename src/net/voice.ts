/**
 * Spike S5: voice between the two crew members on the S4 peer connection.
 *
 * The microphone is captured with the browser's echo cancellation, noise
 * suppression and automatic gain (Opus is WebRTC's default voice codec). The
 * crewmate's voice is played in one of three ways, chosen with `?voice=`:
 *
 * - `spatial` (default): Web Audio with an HRTF panner at the crewmate's
 *   head, so the voice comes from where they stand.
 * - `plain`: an ordinary audio element, not positioned. This is the fail plan
 *   from the development plan, kept for comparison.
 * - `off`: no microphone and no playback.
 *
 * Chromium's echo canceller only "hears" audio played through WebRTC's own
 * output, so the spatial mix played straight from Web Audio may echo on a
 * headset whose speakers sit next to its microphones. `?voiceloop=1` routes
 * the Web Audio mix through a local loopback peer connection into an audio
 * element so the echo canceller can see it (the "loopback workaround").
 */

export type VoiceMode = 'spatial' | 'plain' | 'off';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

export class Voice {
  readonly mode: VoiceMode;
  readonly loopback: boolean;
  micTrack: MediaStreamTrack | null = null;
  micError = '';
  muted = false;
  /** The browser has allowed the microphone (asked up front, or remembered from before). */
  permitted = false;

  private ctx: AudioContext | null = null;
  private panner: PannerNode | null = null;
  private analyser: AnalyserNode | null = null;
  private levelData: Float32Array<ArrayBuffer> | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  /** Keeps Chromium pulling the remote stream; muted in spatial mode (Web Audio plays it). */
  private sink: HTMLAudioElement | null = null;
  private loopOut: HTMLAudioElement | null = null;
  private loopPcs: RTCPeerConnection[] = [];
  private onMicChange: (track: MediaStreamTrack | null) => void;

  constructor(mode: VoiceMode, loopback: boolean, onMicChange: (track: MediaStreamTrack | null) => void) {
    this.mode = mode;
    this.loopback = loopback && mode === 'spatial';
    this.onMicChange = onMicChange;
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  /**
   * Ask for microphone permission before the player joins a crew or enters
   * VR (a permission prompt inside VR is easy to miss), without keeping the
   * microphone open: it opens when they join a crew.
   */
  async askPermission(): Promise<void> {
    if (!this.enabled || this.micTrack || !navigator.mediaDevices?.getUserMedia) {
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
      for (const track of stream.getTracks()) {
        track.stop();
      }
      this.permitted = true;
      this.micError = '';
    } catch (error) {
      this.micError = error instanceof Error ? error.name : String(error);
      console.warn(`[Voice] microphone not allowed: ${this.micError}`);
    }
  }

  /** Whether the browser already allows the microphone, without asking. */
  async checkPermission(): Promise<boolean> {
    try {
      const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
      this.permitted ||= status?.state === 'granted';
    } catch {
      // Not every browser can query the microphone permission.
    }
    return this.permitted;
  }

  /** Ask for the microphone. Call from a click or another user gesture where possible. */
  async startMic(): Promise<void> {
    if (!this.enabled || this.micTrack || !navigator.mediaDevices?.getUserMedia) {
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
      this.micTrack = stream.getAudioTracks()[0] ?? null;
      this.permitted = true;
      this.micError = '';
      if (this.micTrack) {
        this.micTrack.enabled = !this.muted;
        const s = this.micTrack.getSettings();
        console.info(
          `[Voice] mic on: echoCancellation=${s.echoCancellation} noiseSuppression=${s.noiseSuppression} autoGainControl=${s.autoGainControl}`,
        );
      }
      this.onMicChange(this.micTrack);
    } catch (error) {
      this.micError = error instanceof Error ? error.name : String(error);
      console.warn(`[Voice] no microphone: ${this.micError}`);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.micTrack) {
      this.micTrack.enabled = !muted;
    }
  }

  /** Start or resume audio output; browsers only allow this after a user gesture. */
  resume(): void {
    void this.ctx?.resume();
    void this.sink?.play().catch(() => undefined);
    void this.loopOut?.play().catch(() => undefined);
  }

  /** Play the crewmate's voice. */
  playRemote(stream: MediaStream): void {
    if (!this.enabled) {
      return;
    }
    this.stopRemote();
    this.sink = new Audio();
    this.sink.srcObject = stream;
    this.sink.autoplay = true;
    if (this.mode === 'plain') {
      void this.sink.play().catch(() => undefined);
      this.attachAnalyser(stream, false);
      return;
    }
    // Chromium only feeds a remote WebRTC stream into Web Audio while a media element plays it too.
    this.sink.muted = true;
    void this.sink.play().catch(() => undefined);
    const ctx = this.context();
    this.source = ctx.createMediaStreamSource(stream);
    this.panner = new PannerNode(ctx, {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance: 1,
      maxDistance: 50,
      rolloffFactor: 1,
    });
    this.source.connect(this.panner);
    this.attachAnalyser(stream, true);
    if (this.loopback) {
      void this.startLoopback(this.panner);
    } else {
      this.panner.connect(ctx.destination);
    }
  }

  stopRemote(): void {
    this.source?.disconnect();
    this.panner?.disconnect();
    this.analyser?.disconnect();
    this.source = null;
    this.panner = null;
    this.analyser = null;
    if (this.sink) {
      this.sink.srcObject = null;
      this.sink = null;
    }
    for (const pc of this.loopPcs) {
      pc.close();
    }
    this.loopPcs = [];
    if (this.loopOut) {
      this.loopOut.srcObject = null;
      this.loopOut = null;
    }
  }

  /** Place the listener (this player's head). Allocation free. */
  setListener(position: Vec3Like, forward: Vec3Like, up: Vec3Like): void {
    const ctx = this.ctx;
    if (!ctx || !this.panner) {
      return;
    }
    const l = ctx.listener;
    const t = ctx.currentTime;
    l.positionX.setTargetAtTime(position.x, t, 0.02);
    l.positionY.setTargetAtTime(position.y, t, 0.02);
    l.positionZ.setTargetAtTime(position.z, t, 0.02);
    l.forwardX.setTargetAtTime(forward.x, t, 0.02);
    l.forwardY.setTargetAtTime(forward.y, t, 0.02);
    l.forwardZ.setTargetAtTime(forward.z, t, 0.02);
    l.upX.setTargetAtTime(up.x, t, 0.02);
    l.upY.setTargetAtTime(up.y, t, 0.02);
    l.upZ.setTargetAtTime(up.z, t, 0.02);
  }

  /** Place the crewmate's voice at their mouth. Allocation free. */
  setSource(position: Vec3Like): void {
    const p = this.panner;
    if (!p || !this.ctx) {
      return;
    }
    const t = this.ctx.currentTime;
    p.positionX.setTargetAtTime(position.x, t, 0.02);
    p.positionY.setTargetAtTime(position.y, t, 0.02);
    p.positionZ.setTargetAtTime(position.z, t, 0.02);
  }

  /** RMS level of the crewmate's voice, 0 to 1 (speaking indicator and tests). */
  remoteLevel(): number {
    const a = this.analyser;
    const data = this.levelData;
    if (!a || !data) {
      return 0;
    }
    a.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i];
    }
    return Math.sqrt(sum / data.length);
  }

  /** True once the loopback route is playing the spatial mix. */
  get loopbackActive(): boolean {
    return this.loopOut?.srcObject != null;
  }

  get audioState(): string {
    return this.ctx?.state ?? 'none';
  }

  dispose(): void {
    this.stopRemote();
    this.micTrack?.stop();
    this.micTrack = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    return this.ctx;
  }

  private attachAnalyser(stream: MediaStream, reuseSource: boolean): void {
    const ctx = this.context();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.levelData = new Float32Array(this.analyser.fftSize);
    (reuseSource && this.source ? this.source : ctx.createMediaStreamSource(stream)).connect(this.analyser);
  }

  /** Route `node` through a local peer connection pair into an audio element (see the header comment). */
  private async startLoopback(node: AudioNode): Promise<void> {
    const ctx = this.context();
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    this.loopPcs = [a, b];
    a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate);
    this.loopOut = new Audio();
    this.loopOut.autoplay = true;
    b.ontrack = (e) => {
      if (this.loopOut) {
        this.loopOut.srcObject = e.streams[0];
        void this.loopOut.play().catch(() => undefined);
      }
    };
    for (const track of dest.stream.getAudioTracks()) {
      a.addTrack(track, dest.stream);
    }
    // Opus is mono by default, which would undo the HRTF panning; ask for stereo.
    const offer = await a.createOffer();
    await a.setLocalDescription({ type: 'offer', sdp: stereoOpus(offer.sdp ?? '') });
    await b.setRemoteDescription(a.localDescription!);
    const answer = await b.createAnswer();
    await b.setLocalDescription({ type: 'answer', sdp: stereoOpus(answer.sdp ?? '') });
    await a.setRemoteDescription(b.localDescription!);
  }
}

/** Add stereo and a high bitrate to the Opus format line of an SDP. */
export function stereoOpus(sdp: string): string {
  const match = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp);
  if (!match) {
    return sdp;
  }
  const pt = match[1];
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (line, params: string) =>
    params.includes('stereo=1') ? line : `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=256000`,
  );
}
