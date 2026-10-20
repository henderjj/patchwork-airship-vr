/**
 * The ship's sounds (Phase 2), made in Web Audio rather than recorded, to
 * keep the download small: the burner's roar, wind that grows with speed,
 * timber creaks, the crank's ratchet, the ship's bell, a chime for a ring
 * flown through, a thump on touchdown, the haul call's mallet knock, the
 * mooring line creaking under strain, and the envelope's repairs: canvas
 * ripping, hot air hissing out of a tear, a patch slapped on and rivets
 * hammered home; the hull scraping a passage's rock, the crewmate's
 * whistle as it calls the way through; and in a storm, the rain's patter,
 * thunder and the bilge pump's gushes.
 *
 * Sources sit at fixed places in ship space (the gondola doesn't move in
 * the player's tracking space), so only the listener moves each frame.
 * Panning is equal-power rather than HRTF, which is cheaper on a headset
 * and plenty for sounds this broad.
 */

type Vec3 = readonly [number, number, number];

/** Overall loudness, below the crewmate's voice. */
const MASTER_GAIN = 0.55;
/**
 * Length of the looped noise, s (about 1 MB). A 2 s loop could be heard
 * repeating as a rhythmic swish under the wind.
 */
const NOISE_SECONDS = 5;
/** How quickly the looped sounds follow their targets, s (time constant). */
const FOLLOW = 0.12;
/** A timber's body resonances for the haul call's knock: frequency (Hz), Q, starting gain and how long it rings (s). */
const WOOD_MODES: readonly (readonly [number, number, number, number])[] = [
  [620, 9, 2.2, 0.11],
  [1650, 12, 1.1, 0.06],
];

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
  private haulOut!: AudioNode;
  private lineOut!: AudioNode;
  private loftOut!: AudioNode;
  private hissGain!: GainNode;
  private rainGain!: GainNode;
  private pumpOut!: AudioNode;
  /** Sounds played so far, by name (tests and the HUD). */
  readonly played: Record<string, number> = {
    ratchet: 0, creak: 0, bell: 0, chime: 0, thump: 0, heave: 0, lineCreak: 0, rip: 0, slap: 0, rivet: 0, dud: 0, scrape: 0, call: 0,
    thunder: 0, gush: 0,
  };

  constructor(
    private readonly places: { burner: Vec3; crank: Vec3; bell: Vec3; haul: Vec3; fairlead: Vec3; loft: Vec3; pump: Vec3 },
    private on = true,
  ) {}

  /** The sounds are on (the `audio` setting, which the in-game menu changes). */
  get enabled(): boolean {
    return this.on;
  }

  /**
   * Turn the sounds on or off while playing. Off suspends the audio, so it
   * costs nothing, and nothing is queued to play when it comes back.
   */
  setEnabled(on: boolean): void {
    this.on = on;
    if (on) {
      this.resume();
    } else {
      void this.ctx?.suspend();
    }
  }

  /** The audio context while the sounds are on. */
  private get live(): AudioContext | null {
    return this.on ? this.ctx : null;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Make (on first use) or wake the audio; browsers only allow this after a user gesture or on entering VR. */
  resume(): void {
    if (!this.on) {
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

    // White noise, looped by the burner and the wind and sliced for clicks.
    this.noise = ctx.createBuffer(1, ctx.sampleRate * NOISE_SECONDS, ctx.sampleRate);
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
    this.haulOut = this.panner(this.places.haul);
    this.lineOut = this.panner(this.places.fairlead);

    // The envelope's belly over the patch loft: the hiss of hot air out of a tear, and the repairs.
    this.loftOut = this.panner(this.places.loft);
    const hiss = ctx.createBiquadFilter();
    hiss.type = 'bandpass';
    hiss.frequency.value = 3800;
    hiss.Q.value = 0.9;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    this.loop(hiss).connect(this.hissGain).connect(this.loftOut);

    // Rain: a bright patter everywhere at once, over a softer hush of it on the envelope.
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.rainGain.connect(this.master);
    const patter = ctx.createBiquadFilter();
    patter.type = 'highpass';
    patter.frequency.value = 2600;
    const hush = ctx.createBiquadFilter();
    hush.type = 'bandpass';
    hush.frequency.value = 900;
    hush.Q.value = 0.6;
    const hushGain = ctx.createGain();
    hushGain.gain.value = 0.7;
    this.loop(patter).connect(this.rainGain);
    this.loop(hush).connect(hushGain).connect(this.rainGain);
    // The bilge pump's spout.
    this.pumpOut = this.panner(this.places.pump);
  }

  /** Looped noise into `filter`; returns the filter to connect onwards. */
  private loop(filter: BiquadFilterNode): BiquadFilterNode {
    const source = this.ctx!.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    // Start each loop at a different point so the burner and wind don't share a pattern.
    source.start(0, Math.random() * NOISE_SECONDS);
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
    if (!this.live) {
      return;
    }
    const t = this.live.currentTime;
    // The flame catches quickly and dies away a little slower.
    this.burnerGain.gain.setTargetAtTime(burner * 0.5, t, burner > 0 ? FOLLOW * 0.6 : FOLLOW * 2.5);
    this.windGain.gain.setTargetAtTime(windGain, t, FOLLOW * 4);
    this.windFilter.frequency.setTargetAtTime(windCutoff, t, FOLLOW * 4);
  }

  /** Hot air hissing out of the envelope's tears, 0 (none) to 1 (a long open tear). */
  setHiss(level: number): void {
    if (!this.live) {
      return;
    }
    this.hissGain.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.35, this.live.currentTime, FOLLOW * 2);
  }

  /** Rain falling, 0 (none) to 1 (a storm). */
  setRain(level: number): void {
    if (!this.live) {
      return;
    }
    this.rainGain.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.22, this.live.currentTime, FOLLOW * 6);
  }

  /**
   * Thunder from lightning `distance` m off, coming as long after now as
   * sound takes to get here: a sharp crack first when it is near, then a
   * long, uneven rumble, quieter and duller the further it is.
   */
  thunder(distance: number, delay: number): void {
    const ctx = this.live;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime + Math.max(0, delay);
    const near = Math.max(0, Math.min(1, (420 - distance) / 300));
    const level = 0.35 + 0.55 * near;
    const length = 2.4 + 1.6 * (1 - near);
    if (near > 0.4) {
      const crack = ctx.createBufferSource();
      crack.buffer = this.noise;
      const bright = ctx.createBiquadFilter();
      bright.type = 'highpass';
      bright.frequency.value = 700;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(level * near, t);
      gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.25);
      crack.connect(bright).connect(gain).connect(this.master);
      crack.start(t, Math.random() * (NOISE_SECONDS - 0.4), 0.3);
    }
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noise;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.setValueAtTime(160 + 260 * near, t);
    low.frequency.exponentialRampToValueAtTime(70, t + length);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(level * 2.2, t + 0.08 + 0.3 * (1 - near));
    // Rolling: it swells and falls back a few times as it dies away.
    for (let i = 1; i < 6; i++) {
      gain.gain.setTargetAtTime(level * 2.2 * (1 - i / 6) * (0.5 + 0.5 * Math.random()), t + (i * length) / 7, 0.12);
    }
    gain.gain.setTargetAtTime(0.0001, t + length * 0.85, 0.2);
    rumble.connect(low).connect(gain).connect(this.master);
    rumble.start(t, Math.random() * (NOISE_SECONDS - length - 0.1), length + 0.5);
    this.played.thunder++;
  }

  /** The bilge pump sending water out of its spout and over the side, louder with `strength` (0 to 1). */
  gush(strength: number): void {
    const ctx = this.live;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    const k = Math.max(0, Math.min(1, strength));
    const water = ctx.createBufferSource();
    water.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.2;
    band.frequency.setValueAtTime(500, t);
    band.frequency.exponentialRampToValueAtTime(1300, t + 0.25);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.25 + 0.35 * k, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.4);
    water.connect(band).connect(gain).connect(this.pumpOut);
    water.start(t, Math.random() * (NOISE_SECONDS - 0.5), 0.45);
    // The plunger's suck and clunk.
    this.tone(140 + 40 * Math.random(), 'triangle', 0.08 + 0.08 * k, 0.004, 0.07, this.pumpOut, t);
    this.played.gush++;
  }

  /** The envelope tearing: canvas ripping, a ragged burst of noise falling in pitch. */
  rip(): void {
    const ctx = this.live;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    const tear = ctx.createBufferSource();
    tear.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.4;
    band.frequency.setValueAtTime(2600, t);
    band.frequency.exponentialRampToValueAtTime(700, t + 0.5);
    // Threads giving way one after another: the level stutters.
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    for (let i = 0; i < 9; i++) {
      gain.gain.setValueAtTime(0.25 + 0.35 * Math.random(), t + i * 0.05);
      gain.gain.setValueAtTime(0.05, t + i * 0.05 + 0.025);
    }
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    tear.connect(band).connect(gain).connect(this.loftOut);
    tear.start(t, Math.random() * (NOISE_SECONDS - 1), 0.65);
    this.played.rip++;
  }

  /** A patch slapped onto the canvas: a soft, low smack. */
  slap(): void {
    const ctx = this.live;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    const smack = ctx.createBufferSource();
    smack.buffer = this.noise;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 900;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.6, t);
    gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.12);
    smack.connect(low).connect(gain).connect(this.loftOut);
    smack.start(t, Math.random() * (NOISE_SECONDS - 0.2), 0.14);
    this.played.slap++;
  }

  /** A rivet hammered home: a bright clink of iron on brass. `home` false is a dull knock on a patch nobody is holding (it won't take a rivet). */
  rivet(home = true): void {
    const ctx = this.live;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    if (home) {
      this.tone(2150, 'sine', 0.22, 0.002, 0.25, this.loftOut, t);
      this.tone(3420, 'sine', 0.12, 0.002, 0.14, this.loftOut, t);
      this.tone(5150, 'sine', 0.06, 0.002, 0.08, this.loftOut, t);
      this.played.rivet++;
    } else {
      this.tone(310, 'triangle', 0.2, 0.003, 0.08, this.loftOut, t);
      this.played.dud++;
    }
  }

  /** One pawl click of the crank's ratchet, louder with `strength` (0 to 1). */
  ratchet(strength: number): void {
    const ctx = this.live;
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
    click.start(t, Math.random() * (NOISE_SECONDS - 0.1), 0.03);
    this.played.ratchet++;
  }

  /** A timber creak at `at`: a rough, sliding tone, deeper and longer when the load is heavy. */
  creak(at: Vec3, load: number): void {
    const ctx = this.live;
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

  /** The ship's bell: a struck brass bell's out-of-tune partials, each dying away at its own rate; `strength` 0 to 1 for how hard it was struck. */
  bell(strength = 1): void {
    const ctx = this.live;
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
      this.tone(784 * ratio, 'sine', level * (0.3 + 0.7 * Math.min(1, Math.max(0, strength))), 0.004, decay, this.bellOut, t);
    }
    this.played.bell++;
  }

  /** Two rising notes: a ring flown through. */
  chime(): void {
    const ctx = this.live;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    this.tone(1046.5, 'triangle', 0.16, 0.01, 0.5, this.master, t);
    this.tone(1568, 'triangle', 0.16, 0.01, 0.8, this.master, t + 0.14);
    this.played.chime++;
  }

  /**
   * The haul call, at the hauling run: a wooden mallet knocked on a
   * timber, a firm knock on the heave (start the stroke) and a light tap on
   * the off-beat (reach forward). Natural sounds rather than a drum: a
   * click of noise for the strike, through the timber's two body
   * resonances, each dying away fast as wood does.
   */
  haulCall(beat: 'heave' | 'reach'): void {
    const ctx = this.live;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    const heave = beat === 'heave';
    // A little variety, so a minute of hauling doesn't sound like a metronome.
    const pitch = (heave ? 1 : 1.35) * (0.97 + Math.random() * 0.06);
    const strike = ctx.createBufferSource();
    strike.buffer = this.noise;
    const level = heave ? 1 : 0.35;
    for (const [freq, q, gainAt, decay] of WOOD_MODES) {
      const body = ctx.createBiquadFilter();
      body.type = 'bandpass';
      body.frequency.value = freq * pitch;
      body.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(gainAt * level, t);
      gain.gain.exponentialRampToValueAtTime(0.0005, t + decay);
      strike.connect(body).connect(gain).connect(this.haulOut);
    }
    strike.start(t, Math.random() * (NOISE_SECONDS - 0.2), 0.012);
    // The knock's thud, felt more than heard, on the heave only.
    if (heave) {
      this.tone(95 * pitch, 'sine', 0.25, 0.003, 0.09, this.haulOut, t);
      this.played.heave++;
    }
  }

  /** The mooring line creaking through the fairlead under strain, harder and lower with `tension` (0 to 1). */
  lineCreak(tension: number): void {
    const ctx = this.live;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    const k = Math.max(0, Math.min(1, tension));
    const duration = 0.12 + 0.18 * k + Math.random() * 0.08;
    const pitch = 420 - 160 * k + Math.random() * 60;
    // Fibres catching and slipping: a fast, uneven train of clicks through a narrow band.
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(28 + 20 * k, t);
    osc.frequency.linearRampToValueAtTime(18 + 12 * k, t + duration);
    const body = ctx.createBiquadFilter();
    body.type = 'bandpass';
    body.frequency.value = pitch;
    body.Q.value = 8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12 + 0.2 * k, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(body).connect(gain).connect(this.lineOut);
    osc.start(t);
    osc.stop(t + duration + 0.05);
    this.played.lineCreak++;
  }

  /**
   * The hull scraping rock (docs/passages.md), louder with `strength` (0 to
   * 1): canvas rasping along it overhead for the envelope, or the gondola's
   * timbers grinding and knocking on it underfoot. Played over and over,
   * quieter, while the ship grinds along the rock.
   */
  scrape(envelope: boolean, strength: number): void {
    const ctx = this.live;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    const level = 0.12 + 0.5 * Math.max(0, Math.min(1, strength));
    const source = ctx.createBufferSource();
    source.buffer = this.noise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = envelope ? 0.9 : 1.6;
    band.frequency.setValueAtTime(envelope ? 1300 : 380, t);
    band.frequency.linearRampToValueAtTime(envelope ? 900 : 300, t + 0.45);
    // Rough: the level jumps about as the surface catches and slips.
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    for (let i = 0; i < 8; i++) {
      gain.gain.setValueAtTime(level * (0.4 + 0.6 * Math.random()), t + i * 0.055);
    }
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    source.connect(band).connect(gain).connect(envelope ? this.loftOut : this.master);
    source.start(t, Math.random() * (NOISE_SECONDS - 1), 0.55);
    if (!envelope) {
      // The timbers knocking on the rock.
      this.tone(90, 'triangle', level * 0.8, 0.005, 0.18, this.master, t);
    }
    this.played.scrape++;
  }

  /** The crewmate's whistle as it calls (docs/passages.md): rising for up, falling for down, two short blasts to steer, one for steady. */
  call(kind: 'up' | 'down' | 'steer' | 'steady'): void {
    const ctx = this.live;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    const blasts = kind === 'steer' ? 2 : 1;
    for (let i = 0; i < blasts; i++) {
      const start = t + i * 0.16;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      const from = kind === 'up' ? 1500 : kind === 'down' ? 2300 : 1900;
      const to = kind === 'up' ? 2300 : kind === 'down' ? 1500 : 1900;
      const length = blasts === 2 ? 0.1 : 0.32;
      osc.frequency.setValueAtTime(from, start);
      osc.frequency.linearRampToValueAtTime(to, start + length);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      gain.gain.setValueAtTime(0.12, start + length - 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
      osc.connect(gain).connect(this.master);
      osc.start(start);
      osc.stop(start + length + 0.05);
    }
    this.played.call++;
  }

  /** The gondola settling onto the ground, harder with a faster `speed` (m/s). */
  thump(speed: number): void {
    const ctx = this.live;
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
  loops(): { burner: number; wind: number; hiss: number; rain: number } {
    return {
      burner: this.burnerGain?.gain.value ?? 0,
      wind: this.windGain?.gain.value ?? 0,
      hiss: this.hissGain?.gain.value ?? 0,
      rain: this.rainGain?.gain.value ?? 0,
    };
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
