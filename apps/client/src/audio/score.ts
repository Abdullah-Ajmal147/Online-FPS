/**
 * "Static", the Season 0 theme: a slow A-minor loop, written as data and generated note by
 * note (no audio files, nothing to license). Pure and deterministic so it can be tested; the
 * music engine (music.ts) turns these events into Web Audio voices.
 */

export const BPM = 84;
export const BEAT_S = 60 / BPM;
/** Eighth notes per bar (4/4). */
export const STEPS_PER_BAR = 8;
export const STEP_S = BEAT_S / 2;

/** One chord per bar: Am F C G | Am F Dm E (the E major pulls back home to A minor). */
export const PROGRESSION: readonly { name: string; root: number; notes: readonly number[] }[] = [
  // root = pitch class of the bass note; notes = the pad voicing (inversions stay close).
  { name: 'Am', root: 9, notes: [57, 60, 64] },
  { name: 'F', root: 5, notes: [53, 57, 60] },
  { name: 'C', root: 0, notes: [55, 60, 64] },
  { name: 'G', root: 7, notes: [55, 59, 62] },
  { name: 'Am', root: 9, notes: [57, 60, 64] },
  { name: 'F', root: 5, notes: [53, 57, 60] },
  { name: 'Dm', root: 2, notes: [57, 62, 65] },
  { name: 'E', root: 4, notes: [56, 59, 64] },
];

/** A natural minor, plus G# (the E chord's leading tone). */
export const SCALE_PITCH_CLASSES: ReadonlySet<number> = new Set([9, 11, 0, 2, 4, 5, 7, 8]);

export type Voice = 'pad' | 'bass' | 'pluck' | 'pulse';

export interface NoteEvent {
  voice: Voice;
  /** MIDI note number. */
  midi: number;
  /** Seconds after the start of the step. */
  offset: number;
  /** Seconds. */
  length: number;
  /** 0–1. */
  velocity: number;
}

/** How busy the music is: the menu plays everything, the countdown only bass and pulse. */
export type Arrangement = 'menu' | 'countdown';

/** Small deterministic PRNG (mulberry32): the same bar always plays the same melody. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const midiToHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);

/**
 * Notes that start on step `step` (0–7) of bar `bar` (counting from 0 since the music began).
 * The 8-bar progression loops; the pluck melody only comes in on the second pass of each
 * 16-bar cycle, so the loop breathes.
 */
export function stepEvents(bar: number, step: number, arrangement: Arrangement): NoteEvent[] {
  const chord = PROGRESSION[bar % PROGRESSION.length]!;
  const root = chord.root;
  const out: NoteEvent[] = [];
  const bassMidi = 33 + ((root - 9 + 12) % 12); // A1 = 33, other roots just above it

  if (arrangement === 'countdown') {
    // Heartbeat on every beat, bass on the bar.
    if (step % 2 === 0)
      out.push({ voice: 'pulse', midi: 36, offset: 0, length: 0.25, velocity: 0.9 });
    if (step === 0)
      out.push({ voice: 'bass', midi: bassMidi, offset: 0, length: BEAT_S * 4, velocity: 0.6 });
    return out;
  }

  if (step === 0) {
    for (const n of chord.notes)
      out.push({ voice: 'pad', midi: n, offset: 0, length: BEAT_S * 4, velocity: 0.5 });
  }
  if (step === 0 || step === 4 || (step === 7 && bar % 2 === 1)) {
    out.push({
      voice: 'bass',
      midi: bassMidi,
      offset: 0,
      length: step === 7 ? STEP_S : BEAT_S * 1.6,
      velocity: step === 0 ? 0.8 : 0.55,
    });
  }
  if (bar % 16 >= 8) {
    const r = rng(bar * 131 + step * 7 + 1);
    // Mostly chord tones an octave up, sometimes a passing scale tone; some steps rest.
    if (r() < 0.72) {
      const tones = chord.notes.map((n) => n + 12);
      let midi = tones[Math.floor(r() * tones.length)]!;
      if (r() < 0.2) {
        const up = midi + (r() < 0.5 ? 2 : -2);
        if (SCALE_PITCH_CLASSES.has(up % 12)) midi = up;
      }
      out.push({
        voice: 'pluck',
        midi,
        offset: 0,
        length: STEP_S * 1.5,
        velocity: 0.4 + r() * 0.3,
      });
    }
  }
  return out;
}
