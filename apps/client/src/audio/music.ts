import {
  midiToHz,
  STEP_S,
  STEPS_PER_BAR,
  stepEvents,
  type Arrangement,
  type NoteEvent,
} from './score.ts';

export type MusicState = 'off' | 'menu' | 'countdown' | 'match';

/** Schedule this far ahead (s); the timer runs much more often than a step lasts. */
const LOOKAHEAD_S = 0.25;
const TIMER_MS = 60;

/**
 * Plays the score (score.ts) with small Web Audio synths: detuned pads through a slowly
 * moving filter, a round sub bass, plucks with a dotted-eighth echo, a heartbeat pulse, and a
 * quiet bed of radio static (the Relay is a radio network). During live play the music gets
 * out of the way (footsteps matter); stings mark the match's end.
 */
export class Music {
  private state: MusicState = 'off';
  private timer: ReturnType<typeof setInterval> | undefined;
  private nextStepAt = 0;
  private bar = 0;
  private step = 0;
  private readonly bus: GainNode;
  private readonly padFilter: BiquadFilterNode;
  private readonly echo: DelayNode;
  private readonly staticGain: GainNode;
  /** Stings bypass the state fades (they play while the match music is silent). */
  private readonly stingBus: GainNode;

  constructor(
    private readonly ctx: AudioContext,
    out: AudioNode,
    noise: AudioBuffer,
  ) {
    this.bus = ctx.createGain();
    this.bus.gain.value = 0;
    this.bus.connect(out);
    this.stingBus = ctx.createGain();
    this.stingBus.gain.value = 0.9;
    this.stingBus.connect(out);

    // Pads: a low-pass whose cutoff drifts (a slow LFO) so the chords breathe.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.8;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 380;
    lfo.connect(lfoDepth).connect(this.padFilter.frequency);
    lfo.start();
    this.padFilter.connect(this.bus);

    // Pluck echo: dotted eighth, a few repeats, darker each time.
    this.echo = ctx.createDelay(2);
    this.echo.delayTime.value = STEP_S * 1.5;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const dark = ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 2200;
    this.echo.connect(dark).connect(fb).connect(this.echo);
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    dark.connect(wet).connect(this.bus);

    // Radio static bed: band-passed noise, barely there.
    const hiss = ctx.createBufferSource();
    hiss.buffer = noise;
    hiss.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 3200;
    band.Q.value = 0.6;
    this.staticGain = ctx.createGain();
    this.staticGain.gain.value = 0;
    hiss.connect(band).connect(this.staticGain).connect(this.bus);
    hiss.start();
  }

  get current(): MusicState {
    return this.state;
  }

  setState(next: MusicState): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    const t = this.ctx.currentTime;
    // Sits well under the effects: about -22 dBFS RMS at default volume in the menu, a quiet
    // bed during play (footsteps and gunfire must stay on top).
    const level = next === 'menu' ? 0.32 : next === 'countdown' ? 0.3 : next === 'match' ? 0.13 : 0;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setTargetAtTime(level, t, next === 'match' ? 0.6 : 0.8);
    this.staticGain.gain.setTargetAtTime(
      next === 'off' ? 0 : next === 'match' ? 0.05 : 0.035,
      t,
      1,
    );
    if (next === 'off') {
      // Let the fade finish, then stop scheduling notes.
      setTimeout(() => this.state === next && this.stopTimer(), 3000);
      return;
    }
    if (prev === 'off' || !this.timer) {
      this.bar = 0;
      this.step = 0;
      this.nextStepAt = t + 0.1;
    }
    this.startTimer();
  }

  /** End of match: a short swell, bright for a win, falling for a loss. */
  sting(result: 'win' | 'loss' | 'draw'): void {
    const t = this.ctx.currentTime + 0.05;
    const notes =
      result === 'win' ? [57, 61, 64, 69] : result === 'loss' ? [57, 60, 63, 56] : [57, 60, 64];
    notes.forEach((m, i) => {
      this.padNote(m, t + i * 0.09, 2.6 - i * 0.2, 0.1, this.stingBus);
      this.pluck(m + 12, t + i * 0.18, 0.5, 0.2, this.stingBus);
    });
  }

  private startTimer(): void {
    this.timer ??= setInterval(() => this.schedule(), TIMER_MS);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.state === 'off') return;
    const arrangement: Arrangement = this.state;
    // After a long stall (tab in the background) skip ahead instead of playing a burst.
    if (this.nextStepAt < this.ctx.currentTime - 0.5) this.nextStepAt = this.ctx.currentTime + 0.05;
    while (this.nextStepAt < this.ctx.currentTime + LOOKAHEAD_S) {
      for (const e of stepEvents(this.bar, this.step, arrangement)) this.play(e, this.nextStepAt);
      this.nextStepAt += STEP_S;
      if (++this.step === STEPS_PER_BAR) {
        this.step = 0;
        this.bar++;
      }
    }
  }

  private play(e: NoteEvent, at: number): void {
    const t = at + e.offset;
    if (e.voice === 'pad') this.padNote(e.midi, t, e.length, e.velocity * 0.16, this.padFilter);
    else if (e.voice === 'bass') this.bass(e.midi, t, e.length, e.velocity * 0.5);
    else if (e.voice === 'pluck') this.pluck(e.midi, t, e.length, e.velocity * 0.22);
    else this.pulse(t, e.velocity * 0.6);
  }

  /** Two detuned saws: slow attack, long release. */
  private padNote(midi: number, t: number, len: number, vol: number, out: AudioNode): void {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + Math.min(1.2, len * 0.4));
    g.gain.setTargetAtTime(0, t + len * 0.85, 0.6);
    g.connect(out);
    for (const cents of [-7, 7]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midiToHz(midi);
      o.detune.value = cents;
      o.connect(g);
      o.start(t);
      o.stop(t + len + 3);
    }
  }

  private bass(midi: number, t: number, len: number, vol: number): void {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiToHz(midi);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 320;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.03);
    g.gain.setTargetAtTime(vol * 0.6, t + 0.05, 0.2);
    g.gain.setTargetAtTime(0, t + len, 0.12);
    o.connect(f).connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + len + 1);
  }

  private pluck(
    midi: number,
    t: number,
    len: number,
    vol: number,
    out: AudioNode = this.bus,
  ): void {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiToHz(midi);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + len);
    o.connect(g);
    g.connect(out);
    g.connect(this.echo);
    o.start(t);
    o.stop(t + len + 0.05);
  }

  /** Heartbeat: a soft double thump. */
  private pulse(t: number, vol: number): void {
    for (const [dt, v] of [
      [0, vol],
      [0.16, vol * 0.6],
    ] as const) {
      const o = this.ctx.createOscillator();
      o.frequency.setValueAtTime(70, t + dt);
      o.frequency.exponentialRampToValueAtTime(38, t + dt + 0.15);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(v, t + dt);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.18);
      o.connect(g).connect(this.bus);
      o.start(t + dt);
      o.stop(t + dt + 0.2);
    }
  }
}
