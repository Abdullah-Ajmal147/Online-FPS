import type { Weapon } from '@sentinel/content';
import { Music, type MusicState } from './music.ts';

type WeaponClass = Weapon['class'];
type Vec3 = readonly [number, number, number];

/**
 * Gunshot recipe per weapon class: a sharp transient, a noise "body" around `body` Hz, a
 * pitched-down thump, and how much of it rings in the room.
 */
const SHOT_SOUNDS: Record<
  WeaponClass,
  {
    body: number;
    q: number;
    length: number;
    gain: number;
    thump: number;
    thumpGain: number;
    room: number;
  }
> = {
  rifle: { body: 1300, q: 0.8, length: 0.12, gain: 0.85, thump: 120, thumpGain: 0.7, room: 0.35 },
  smg: { body: 1800, q: 0.9, length: 0.075, gain: 0.65, thump: 150, thumpGain: 0.5, room: 0.28 },
  shotgun: { body: 700, q: 0.6, length: 0.24, gain: 1, thump: 75, thumpGain: 1, room: 0.45 },
  marksman: { body: 1000, q: 0.7, length: 0.2, gain: 1, thump: 90, thumpGain: 0.9, room: 0.55 },
  sidearm: { body: 2100, q: 1, length: 0.085, gain: 0.65, thump: 165, thumpGain: 0.55, room: 0.3 },
};

const SHOT_LEVEL = 1.8;
/** At most this many effect voices at once. */
const MAX_VOICES = 40;

export interface Volumes {
  /** 0–1 each. */
  master: number;
  music: number;
  effects: number;
}

/**
 * Game sound, synthesized with Web Audio (no audio files, so nothing to license).
 *
 * Mix: effects and music on their own buses → a compressor (keeps a frag next to rifle fire
 * from clipping) → speakers. A generated room reverb gives shots a tail; sounds placed in the
 * world go through an HRTF panner, and get darker and more reverberant with distance (air
 * soaks up the highs). One instance for the whole page: the menu plays music before the game
 * has loaded.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private sfx: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private master: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private music: Music | null = null;
  private listener: Vec3 = [0, 0, 0];
  private volumes: Volumes = { master: 0.8, music: 0.6, effects: 0.9 };
  private wantedMusic: MusicState = 'off';
  /** Sounds playing now (approximate: counted for their expected length). */
  private voices = 0;
  private analyser: AnalyserNode | null = null;

  /** Browsers only allow audio after a user gesture: call from any click or key press. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      const ctx = (this.ctx = new AudioContext());
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 6;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      // Make-up gain after the compressor, then a hard ceiling so nothing ever clips.
      const makeup = ctx.createGain();
      makeup.gain.value = 1.8;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -2;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.1;
      comp.connect(makeup).connect(limiter).connect(ctx.destination);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      limiter.connect(this.analyser);
      this.master = ctx.createGain();
      this.master.connect(comp);
      this.sfx = ctx.createGain();
      this.sfx.connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.connect(this.master);

      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      this.reverb = ctx.createConvolver();
      this.reverb.buffer = roomImpulse(ctx, 1.0, 2.4); // short IR: convolution cost scales with it
      const wet = ctx.createGain();
      wet.gain.value = 0.9;
      this.reverb.connect(wet).connect(this.sfx);

      this.music = new Music(ctx, this.musicBus, this.noise);
      this.applyVolumes();
      this.music.setState(this.wantedMusic);
    } catch {
      this.ctx = null; // no audio available; the game still works
    }
  }

  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Output level right now (RMS and peak of the last ~43 ms, 0–1): tests and debugging. */
  meter(): { rms: number; peak: number } {
    if (!this.analyser) return { rms: 0, peak: 0 };
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (const v of buf) {
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    return { rms: Math.sqrt(sum / buf.length), peak };
  }

  setVolumes(v: Volumes): void {
    this.volumes = v;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    const t = this.ctx?.currentTime ?? 0;
    // Perceived loudness is roughly logarithmic: square the slider value.
    this.master?.gain.setTargetAtTime(this.volumes.master ** 2 * 1.5, t, 0.05);
    this.sfx?.gain.setTargetAtTime(this.volumes.effects ** 2, t, 0.05);
    this.musicBus?.gain.setTargetAtTime(this.volumes.music ** 2, t, 0.05);
  }

  /** Menu music, countdown tension, or quiet during play. */
  setMusic(state: MusicState): void {
    this.wantedMusic = state;
    this.music?.setState(state);
  }

  get musicState(): MusicState {
    return this.wantedMusic;
  }

  /** End-of-match sting. */
  sting(result: 'win' | 'loss' | 'draw'): void {
    this.music?.sting(result);
  }

  /** Listener = the camera. Forward is -Z rotated by yaw. */
  setListener(x: number, y: number, z: number, yaw: number): void {
    this.listener = [x, y, z];
    const l = this.ctx?.listener;
    if (!l || !l.positionX) return;
    const t = this.ctx!.currentTime;
    l.positionX.setValueAtTime(x, t);
    l.positionY.setValueAtTime(y, t);
    l.positionZ.setValueAtTime(z, t);
    l.forwardX.setValueAtTime(-Math.sin(yaw), t);
    l.forwardY.setValueAtTime(0, t);
    l.forwardZ.setValueAtTime(-Math.cos(yaw), t);
    l.upX.setValueAtTime(0, t);
    l.upY.setValueAtTime(1, t);
    l.upZ.setValueAtTime(0, t);
  }

  /**
   * Where a sound goes: straight to the effects bus (our own sounds), or through a panner at a
   * world position with distance darkening. `room` = how much reverb (more when far away).
   */
  private output(
    at: Vec3 | undefined,
    refDistance: number,
    room: number,
    opts: { hrtf?: boolean; maxDistance?: number; lifeS?: number } = {},
  ): AudioNode | null {
    const ctx = this.ctx;
    if (!ctx || !this.sfx || !this.reverb) return null;
    let dist = 0;
    if (at) {
      const [lx, ly, lz] = this.listener;
      dist = Math.hypot(at[0] - lx, at[1] - ly, at[2] - lz);
      if (opts.maxDistance !== undefined && dist > opts.maxDistance) return null;
    }
    // Voice budget: with a dozen players firing and running, skip the least important sounds
    // rather than overload weak CPUs (each voice is a small node graph).
    // Our own sounds (no position) always play.
    if (at) {
      if (this.voices >= MAX_VOICES) return null;
      this.voices++;
      setTimeout(() => this.voices--, (opts.lifeS ?? 1) * 1000);
    }
    const dry = ctx.createGain();
    if (at) {
      const pan = ctx.createPanner();
      // HRTF (true 3D) for gunfire; cheaper equal-power panning for frequent small sounds.
      pan.panningModel = opts.hrtf === false ? 'equalpower' : 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = refDistance;
      pan.rolloffFactor = 1.1;
      pan.positionX.value = at[0];
      pan.positionY.value = at[1];
      pan.positionZ.value = at[2];
      const air = ctx.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = Math.max(900, 16000 / (1 + dist / 12));
      dry.connect(air).connect(pan).connect(this.sfx);
    } else dry.connect(this.sfx);
    const send = ctx.createGain();
    send.gain.value = Math.min(0.9, room * (1 + dist / 25));
    dry.connect(send).connect(this.reverb);
    return dry;
  }

  /** A gunshot: transient click + noise body + thump, a touch different every time. */
  shot(kind: WeaponClass, at?: Vec3): void {
    const base = SHOT_SOUNDS[kind];
    // Gunfire is the loudest thing in the mix (the band-pass eats most of the noise's energy).
    const p = { ...base, gain: base.gain * SHOT_LEVEL, thumpGain: base.thumpGain * SHOT_LEVEL };
    const ctx = this.ctx;
    const out = this.output(at, 4, p.room, { lifeS: 0.4 });
    if (!ctx || !this.noise || !out) return;
    const t = ctx.currentTime;
    const vary = 1 + (Math.random() - 0.5) * 0.08; // ±4 %: no machine-gun sample repetition

    // Transient: a few ms of bright noise.
    this.noiseBurst(out, t, 0.012, 1.1 * p.gain, 'highpass', 3500, 0.7);
    // Body.
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = vary;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(p.body * vary, t);
    filter.frequency.exponentialRampToValueAtTime(p.body * 0.55, t + p.length);
    filter.Q.value = p.q;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(p.gain, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + p.length);
    src.connect(filter).connect(gain).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + p.length + 0.02);
    // Thump.
    const thump = ctx.createOscillator();
    thump.frequency.setValueAtTime(p.thump * vary, t);
    thump.frequency.exponentialRampToValueAtTime(38, t + 0.1);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(p.thumpGain, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.12 + p.length * 0.3);
    thump.connect(tg).connect(out);
    thump.start(t);
    thump.stop(t + 0.16 + p.length * 0.3);
  }

  /** Frag explosion (deep boom + debris) or smoke release (hiss), placed in 3D. */
  explosion(kind: 'frag' | 'smoke', at: Vec3): void {
    const ctx = this.ctx;
    const out = this.output(at, kind === 'frag' ? 8 : 3, kind === 'frag' ? 0.6 : 0.15, {
      lifeS: 1.5,
    });
    if (!ctx || !this.noise || !out) return;
    const t = ctx.currentTime;
    const len = kind === 'frag' ? 1.1 : 1.8;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = kind === 'frag' ? 'lowpass' : 'highpass';
    filter.frequency.setValueAtTime(kind === 'frag' ? 1400 : 2500, t);
    if (kind === 'frag') filter.frequency.exponentialRampToValueAtTime(110, t + len);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(kind === 'frag' ? 1.5 : 0.22, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(filter).connect(gain).connect(out);
    src.start(t);
    src.stop(t + len + 0.05);
    if (kind === 'frag') {
      const boom = ctx.createOscillator();
      boom.frequency.setValueAtTime(80, t);
      boom.frequency.exponentialRampToValueAtTime(26, t + 0.7);
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(1.5, t);
      bg.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
      boom.connect(bg).connect(out);
      boom.start(t);
      boom.stop(t + 0.85);
      // Debris: a scatter of tiny ticks falling after the blast.
      for (let i = 0; i < 7; i++) {
        const dt = 0.15 + Math.random() * 0.6;
        this.noiseBurst(out, t + dt, 0.02, 0.12, 'bandpass', 2500 + Math.random() * 2500, 4);
      }
    }
  }

  /**
   * A footstep: soft low thud + grit. `loud` 0–1 (crouch-walking is nearly silent, sprinting
   * loud). Our own steps have no position; others' are placed where they walk.
   */
  footstep(loud: number, at?: Vec3): void {
    const ctx = this.ctx;
    if (loud <= 0) return;
    const out = this.output(at, 2.5, 0.08, { hrtf: false, maxDistance: 25, lifeS: 0.2 });
    if (!ctx || !out) return;
    const t = ctx.currentTime;
    const v = loud * (0.85 + Math.random() * 0.3);
    this.noiseBurst(out, t, 0.06, 0.35 * v, 'lowpass', 500 + Math.random() * 200, 0.8);
    this.noiseBurst(out, t + 0.01, 0.035, 0.12 * v, 'bandpass', 2600 + Math.random() * 900, 1.5);
  }

  /** Reload: magazine out, magazine in, bolt/slide, spread over the reload time. */
  reload(seconds: number): void {
    const out = this.output(undefined, 1, 0.05);
    const ctx = this.ctx;
    if (!ctx || !out) return;
    const t = ctx.currentTime;
    this.mech(out, t + seconds * 0.15, 1400, 0.25);
    this.mech(out, t + seconds * 0.55, 900, 0.35);
    this.mech(out, t + seconds * 0.58, 2200, 0.15);
    this.mech(out, t + seconds * 0.85, 1700, 0.3);
    this.mech(out, t + seconds * 0.88, 2600, 0.2);
  }

  /** Weapon switch: cloth rustle and a click. */
  click(): void {
    const out = this.output(undefined, 1, 0.03);
    const ctx = this.ctx;
    if (!ctx || !out) return;
    const t = ctx.currentTime;
    this.noiseBurst(out, t, 0.12, 0.08, 'bandpass', 1200, 0.6);
    this.mech(out, t + 0.12, 2000, 0.22);
  }

  /** Trigger on an empty magazine. */
  dryFire(): void {
    const out = this.output(undefined, 1, 0.02);
    if (!this.ctx || !out) return;
    this.mech(out, this.ctx.currentTime, 3000, 0.25);
  }

  /** Confirmed hit tick; a metallic tink for headshots; a deeper double for kills. */
  hit(kind: 'hit' | 'head' | 'kill'): void {
    const out = this.uiOut();
    const ctx = this.ctx;
    if (!ctx || !out) return;
    const t = ctx.currentTime;
    if (kind === 'head') {
      // Inharmonic partials read as metal.
      for (const [f, v] of [
        [2300, 0.2],
        [3450, 0.12],
        [5100, 0.07],
      ] as const)
        this.tone(f, 0.12, v, 0, 'sine', out);
    } else if (kind === 'kill') {
      this.noiseBurst(out, t, 0.03, 0.3, 'lowpass', 900, 0.7);
      this.tone(740, 0.09, 0.2, 0, 'triangle', out);
      this.tone(1110, 0.14, 0.18, 0.07, 'triangle', out);
    } else {
      this.noiseBurst(out, t, 0.012, 0.25, 'highpass', 4000, 0.7);
      this.tone(1250, 0.04, 0.14, 0, 'sine', out);
    }
  }

  /** Rising arpeggio for a medal (double kill, spree…). */
  medal(): void {
    const out = this.uiOut();
    if (!out) return;
    [660, 880, 1320].forEach((f, i) => this.tone(f, 0.14, 0.18, i * 0.07, 'triangle', out));
  }

  /** Domination: a node became ours (up) or theirs (down). */
  capture(ours: boolean): void {
    const out = this.uiOut();
    if (!out) return;
    const notes = ours ? [587, 740, 880] : [659, 523, 415];
    notes.forEach((f, i) => this.tone(f, 0.18, 0.14, i * 0.09, 'triangle', out));
  }

  /** Dull thud when you take damage. */
  hurt(): void {
    const out = this.uiOut();
    const ctx = this.ctx;
    if (!ctx || !out) return;
    this.tone(85, 0.16, 0.5, 0, 'sine', out);
    this.noiseBurst(out, ctx.currentTime, 0.06, 0.2, 'lowpass', 600, 0.7);
  }

  /** Menu button. */
  uiClick(): void {
    const out = this.uiOut();
    if (!out) return;
    this.tone(1800, 0.025, 0.06, 0, 'triangle', out);
  }

  private uiOut(): AudioNode | null {
    return this.sfx;
  }

  private mech(out: AudioNode, t: number, freq: number, vol: number): void {
    this.noiseBurst(out, t, 0.018, vol, 'bandpass', freq, 3);
    this.tone(freq * 0.5, 0.03, vol * 0.3, t - (this.ctx?.currentTime ?? 0), 'square', out);
  }

  private noiseBurst(
    out: AudioNode,
    t: number,
    len: number,
    vol: number,
    type: BiquadFilterType,
    freq: number,
    q: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.9);
    src.stop(t + len + 0.02);
  }

  private tone(
    freq: number,
    len: number,
    vol: number,
    delay = 0,
    type: OscillatorType = 'sine',
    out: AudioNode | null = this.sfx,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !out) return;
    const t = ctx.currentTime + Math.max(0, delay);
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + len + 0.02);
  }
}

/**
 * A room's echo, made up: stereo noise with an exponential decay and a short pre-delay.
 * `seconds` long; bigger `decay` = dies faster. Outdoor-ish yards: short and diffuse.
 */
function roomImpulse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const pre = Math.floor(rate * 0.012);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = pre; i < len; i++) {
      const x = (i - pre) / (len - pre);
      d[i] = (Math.random() * 2 - 1) * (1 - x) ** decay * 0.6;
    }
  }
  return buf;
}

/** The page's one audio engine (menu music plays before the game has loaded). */
export const gameAudio = new GameAudio();
