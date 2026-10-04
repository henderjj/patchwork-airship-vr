/**
 * The ship's sounds (Phase 2), made in Web Audio rather than recorded, to
 * keep the download small: the burner's roar, wind that grows with speed,
 * timber creaks, the crank's ratchet, the ship's bell, a chime for a ring
 * flown through and a thump on touchdown.
 *
 * Sources sit at fixed places in ship space (the gondola doesn't move in
 * the player's tracking space), so only the listener moves each frame.
 * Panning is equal-power rather than HRTF, which is cheaper on a headset
 * and plenty for sounds this broad.
 */

type Vec3 = readonly [number, number, number];

/** Overall loudness, below the crewmate's voice. */
const MASTER_GAIN = 0.55;
/** How quickly the looped sounds follow their targets, s (time constant). */
const FOLLOW = 0.12;

export class ShipSounds {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private analyser!: AnalyserNode;
  private levelData!: Float32Array<ArrayBuffer>;
  private noise!: AudioBuffer;
  private burnerGain!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private ratchetOut!: AudioNode;
  private bellOut!: AudioNode;
  /** Sounds played so far, by name (tests and the HUD). */
  readonly played: Record<string, number> = { ratchet: 0, creak: 0, bell: 0, chime: 0, thump: 0 };

  constructor(
    private readonly places: { burner: Vec3; crank: Vec3; bell: Vec3 },
    readonly enabled = true,
  ) {}

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Make (on first use) or wake the audio; browsers only allow this after a user gesture or on entering VR. */
  resume(): void {
    if (!this.enabled) {
      return;
    }
    if (!this.ctx) {
      this.build(new AudioContext({ latencyHint: 'interactive' }));
    }
    void this.ctx!.resume();
  }

  private build(ctx: AudioContext): void {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = MASTER_GAIN;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.levelData = new Float32Array(this.analyser.fftSize);
    this.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // Two seconds of white noise, looped by the burner and the wind and sliced for clicks.
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    // Burner: a breathy roar over a low rumble, at the burner.
    const burnerAt = this.panner(this.places.burner);
    this.burnerGain = ctx.createGain();
    this.burnerGain.gain.value = 0;
    this.burnerGain.connect(burnerAt);
    const roar = ctx.createBiquadFilter();
    roar.type = 'bandpass';
    roar.frequency.value = 520;
    roar.Q.value = 0.7;
    const rumble = ctx.createBiquadFilter();
    rumble.type = 'lowpass';
    rumble.frequency.value = 140;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 2.2;
    this.loop(roar).connect(this.burnerGain);
    this.loop(rumble).connect(rumbleGain).connect(this.burnerGain);

    // Wind: everywhere at once, brighter and louder with speed.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 250;
    this.windFilter.Q.value = 0.5;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.loop(this.windFilter).connect(this.windGain).connect(this.master);

    // The ratchet clicks at the crank, the bell rings at the bell.
    const ratchetFilter = ctx.createBiquadFilter();
    ratchetFilter.type = 'highpass';
    ratchetFilter.frequency.value = 2200;
    ratchetFilter.connect(this.panner(this.places.crank));
    this.ratchetOut = ratchetFilter;
    this.bellOut = this.panner(this.places.bell);
  }

  /** Looped noise into `filter`; returns the filter to connect onwards. */
  private loop(filter: BiquadFilterNode): BiquadFilterNode {
    const source = this.ctx!.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    // Start each loop at a different point so the burner and wind don't share a pattern.
    source.start(0, Math.random() * 2);
    source.connect(filter);
    return filter;
  }

  /** A fixed source position in ship space, into the master. */
  private panner(at: Vec3): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 1;
    p.rolloffFactor = 0.8;
    p.positionX.value = at[0];
    p.positionY.value = at[1];
    p.positionZ.value = at[2];
    p.connect(this.master);
    return p;
  }

  /** Where the player's head is, in ship space, and which way it faces. */
  setListener(px: number, py: number, pz: number, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void {
    const l = this.ctx?.listener;
    if (!l || !l.positionX) {
      return;
    }
    l.positionX.value = px;
    l.positionY.value = py;
    l.positionZ.value = pz;
    l.forwardX.value = fx;
    l.forwardY.value = fy;
    l.forwardZ.value = fz;
    l.upX.value = ux;
    l.upY.value = uy;
    l.upZ.value = uz;
  }

  /** Burner flame 0 (out) to 1, and the wind's gain and brightness. */
  setLoops(burner: number, windGain: number, windCutoff: number): void {
    if (!this.ctx) {
      return;
    }
    const t = this.ctx.currentTime;
    // The flame catches quickly and dies away a little slower.
    this.burnerGain.gain.setTargetAtTime(burner * 0.5, t, burner > 0 ? FOLLOW * 0.6 : FOLLOW * 2.5);
    this.windGain.gain.setTargetAtTime(windGain, t, FOLLOW * 4);
    this.windFilter.frequency.setTargetAtTime(windCutoff, t, FOLLOW * 4);
  }

  /** One pawl click of the crank's ratchet, louder with `strength` (0 to 1). */
  ratchet(strength: number): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    const click = ctx.createBufferSource();
    click.buffer = this.noise;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.25 + 0.35 * strength, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
    click.connect(gain).connect(this.ratchetOut);
    click.start(t, Math.random() * 1.9, 0.03);
    this.played.ratchet++;
  }

  /** A timber creak at `at`: a rough, sliding tone, deeper and longer when the load is heavy. */
  creak(at: Vec3, load: number): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    const duration = 0.35 + 0.4 * Math.random() + 0.3 * Math.min(1, load);
    const pitch = 110 + Math.random() * 140;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(pitch, t);
    osc.frequency.linearRampToValueAtTime(pitch * (0.8 + Math.random() * 0.15), t + duration);
    // A fast wobble makes it grind like wood rather than hum.
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 18 + Math.random() * 20;
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = pitch * 0.08;
    wobble.connect(wobbleDepth).connect(osc.frequency);
    const body = ctx.createBiquadFilter();
    body.type = 'bandpass';
    body.frequency.value = pitch * 3;
    body.Q.value = 6;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18 + 0.12 * Math.min(1, load), t + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(body).connect(gain).connect(this.panner(at));
    osc.start(t);
    wobble.start(t);
    osc.stop(t + duration + 0.05);
    wobble.stop(t + duration + 0.05);
    this.played.creak++;
  }

  /** The ship's bell: a struck brass bell's out-of-tune partials, each dying away at its own rate. */
  bell(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    const partials: [number, number, number][] = [
      [1, 0.35, 2.6],
      [2.42, 0.18, 1.4],
      [3.98, 0.1, 0.8],
      [5.95, 0.06, 0.45],
    ];
    for (const [ratio, level, decay] of partials) {
      this.tone(784 * ratio, 'sine', level, 0.004, decay, this.bellOut, t);
    }
    this.played.bell++;
  }

  /** Two rising notes: a ring flown through. */
  chime(): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    this.tone(1046.5, 'triangle', 0.16, 0.01, 0.5, this.master, t);
    this.tone(1568, 'triangle', 0.16, 0.01, 0.8, this.master, t + 0.14);
    this.played.chime++;
  }

  /** The gondola settling onto the ground, harder with a faster `speed` (m/s). */
  thump(speed: number): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(75, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.3);
    const gain = ctx.createGain();
    const level = Math.min(0.7, 0.2 + 0.35 * speed);
    gain.gain.setValueAtTime(level, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.4);
    this.played.thump++;
  }

  private tone(freq: number, type: OscillatorType, level: number, attack: number, decay: number, out: AudioNode, t: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(level, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  /** RMS of everything playing, 0 to 1 (tests). */
  level(): number {
    if (!this.ctx) {
      return 0;
    }
    this.analyser.getFloatTimeDomainData(this.levelData);
    let sum = 0;
    for (let i = 0; i < this.levelData.length; i++) {
      sum += this.levelData[i] * this.levelData[i];
    }
    return Math.sqrt(sum / this.levelData.length);
  }

  /** The looped sounds' current gains (tests). */
  loops(): { burner: number; wind: number } {
    return { burner: this.burnerGain?.gain.value ?? 0, wind: this.windGain?.gain.value ?? 0 };
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
