import { describe, expect, it } from 'vitest';
import { PROGRESSION, SCALE_PITCH_CLASSES, STEPS_PER_BAR, stepEvents } from './score.ts';

const bars = (n: number, arrangement: 'menu' | 'countdown' | 'match' = 'menu') =>
  Array.from({ length: n }, (_, bar) =>
    Array.from({ length: STEPS_PER_BAR }, (_, step) => stepEvents(bar, step, arrangement)).flat(),
  );

describe('music score', () => {
  it('every note is in A minor (with the G# of the E chord)', () => {
    for (const bar of bars(32))
      for (const n of bar) expect(SCALE_PITCH_CLASSES.has(n.midi % 12)).toBe(true);
  });

  it('the bass plays each chord’s root (named root, not the lowest pad note)', () => {
    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    bars(8).forEach((events, bar) => {
      const chord = PROGRESSION[bar]!;
      expect(NAMES[chord.root]).toBe(chord.name.replace('m', ''));
      const root = chord.root;
      for (const n of events.filter((e) => e.voice === 'bass')) expect(n.midi % 12).toBe(root);
    });
  });

  it('is deterministic, and the melody enters on the second pass only', () => {
    expect(bars(16)).toEqual(bars(16));
    const plucks = bars(16).map((b) => b.filter((e) => e.voice === 'pluck').length);
    expect(plucks.slice(0, 8).every((n) => n === 0)).toBe(true);
    expect(plucks.slice(8).reduce((a, b) => a + b, 0)).toBeGreaterThan(30);
  });

  it('in a match: a softer, sparser theme (no heartbeat, melody only on the second pass)', () => {
    const all = bars(16, 'match');
    const events = all.flat();
    expect(new Set(events.map((e) => e.voice))).toEqual(new Set(['pad', 'bass', 'pluck']));
    expect(events.every((e) => e.velocity <= 0.4)).toBe(true);
    expect(events.filter((e) => e.voice === 'bass')).toHaveLength(32); // beats 1 and 3
    const plucks = all.map((b) => b.filter((e) => e.voice === 'pluck').length);
    expect(plucks.slice(0, 8).every((n) => n === 0)).toBe(true);
    // Sparser than the menu melody.
    const menuPlucks = bars(16)
      .flat()
      .filter((e) => e.voice === 'pluck').length;
    const matchPlucks = plucks.reduce((a, b) => a + b, 0);
    expect(matchPlucks).toBeGreaterThan(4);
    expect(matchPlucks).toBeLessThan(menuPlucks / 2);
  });

  it('the countdown is only bass and a heartbeat', () => {
    const voices = new Set(
      bars(4, 'countdown')
        .flat()
        .map((e) => e.voice),
    );
    expect([...voices].sort()).toEqual(['bass', 'pulse']);
  });
});
