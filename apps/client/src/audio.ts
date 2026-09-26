import type { Weapon } from '@sentinel/content';

type WeaponClass = Weapon['class'];

/** Synth parameters per weapon class: crack filter Hz, length s, loudness, thump Hz. */
const SHOT_SOUNDS: Record<
  WeaponClass,
  { crack: number; length: number; gain: number; thump: number; thumpGain: number }
> = {
  rifle: { crack: 1400, length: 0.11, gain: 0.9, thump: 120, thumpGain: 0.6 },
  smg: { crack: 1900, length: 0.07, gain: 0.7, thump: 150, thumpGain: 0.45 },
  shotgun: { crack: 800, length: 0.22, gain: 1, thump: 80, thumpGain: 0.9 },
  marksman: { crack: 1100, length: 0.18, gain: 1, thump: 95, thumpGain: 0.8 },
  sidearm: { crack: 2200, length: 0.08, gain: 0.7, thump: 160, thumpGain: 0.6 },
};
/**
 * Game sounds, synthesized with Web Audio (no audio files, so nothing to license).
 * Remote gunshots are positioned in 3D with an HRTF panner.
 */
export class GameAudio {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private master: GainNode | null = null;

  /** Browsers only allow audio after a user gesture: call from the "play" click. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 0.5;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null; // no audio available; the game still works
    }
  }

  /** Listener = the camera. Forward is -Z rotated by yaw. */
  setListener(x: number, y: number, z: number, yaw: number): void {
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

  /** A gunshot: filtered noise crack + low thump, shaped per weapon class. */
  shot(kind: WeaponClass, at?: readonly [number, number, number]): void {
    const p = SHOT_SOUNDS[kind];
    const ctx = this.ctx;
    if (!ctx || !this.noise || !this.master) return;
    const t = ctx.currentTime;
    let out: AudioNode = this.master;
    if (at) {
      const pan = ctx.createPanner();
      pan.panningModel = 'HRTF';
      pan.distanceModel = 'inverse';
      pan.refDistance = 4;
      pan.rolloffFactor = 1.2;
      pan.positionX.value = at[0];
      pan.positionY.value = at[1];
      pan.positionZ.value = at[2];
      pan.connect(this.master);
      out = pan;
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = p.crack;
    filter.Q.value = 0.7;
    const gain = ctx.createGain();
    const len = p.length;
    gain.gain.setValueAtTime(p.gain, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + len);
    src.connect(filter).connect(gain).connect(out);
    src.start(t);
    src.stop(t + len + 0.02);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(p.thump, t);
    thump.frequency.exponentialRampToValueAtTime(40, t + 0.09);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(p.thumpGain, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.1 + p.length * 0.3);
    thump.connect(tg).connect(out);
    thump.start(t);
    thump.stop(t + 0.14 + p.length * 0.3);
  }

  /** Short tick for a confirmed hit; higher for headshots, a two-tone chime for kills. */
  hit(kind: 'hit' | 'head' | 'kill'): void {
    const freqs = kind === 'kill' ? [880, 1320] : kind === 'head' ? [1500] : [1100];
    freqs.forEach((f, i) => this.tone(f, 0.05, 0.25, i * 0.06));
  }

  /** Rising arpeggio for a medal (double kill, spree…). */
  medal(): void {
    [660, 880, 1320].forEach((f, i) => this.tone(f, 0.12, 0.22, i * 0.07, 'triangle'));
  }

  /** Dull thud when you take damage. */
  hurt(): void {
    this.tone(90, 0.12, 0.5, 0, 'triangle');
  }

  /** Two quick clicks for reload / weapon switch. */
  click(): void {
    this.tone(2400, 0.02, 0.15, 0, 'square');
    this.tone(1800, 0.02, 0.12, 0.08, 'square');
  }

  private tone(
    freq: number,
    len: number,
    vol: number,
    delay = 0,
    type: OscillatorType = 'sine',
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + len + 0.02);
  }
}
