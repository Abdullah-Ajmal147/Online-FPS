import { describe, expect, it } from 'vitest';
import { SprintToggle } from './sprintToggle.ts';

/** Sample one tick every 1000/60 ms from `from` to `to`, returning the Sprint bits. */
function bits(t: SprintToggle, from: number, to: number): boolean[] {
  const out: boolean[] = [];
  for (let ms = from; ms < to; ms += 1000 / 60) out.push(t.sample(ms));
  return out;
}
/** Rising edges of the Sprint bit (what the simulation counts as presses). */
const edges = (b: boolean[], prev = false) =>
  b.filter((v, i) => v && !(i === 0 ? prev : b[i - 1])).length;

describe('SprintToggle', () => {
  it('a single press latches sprint on and a later single press turns it off', () => {
    const t = new SprintToggle(0.3);
    t.press(0);
    expect(bits(t, 0, 1000).every(Boolean)).toBe(true);
    t.press(1000);
    const after = bits(t, 1000, 2000);
    expect(after.at(-1)).toBe(false);
  });

  it('double tap from standing: two edges within the window, sprint stays on', () => {
    const t = new SprintToggle(0.3);
    t.press(0);
    const a = bits(t, 0, 100);
    t.press(100);
    const b = bits(t, 100, 1000);
    expect(edges([...a, ...b])).toBe(2);
    expect(b.at(-1)).toBe(true);
  });

  it('double tap while already sprinting also gives two edges and keeps sprinting', () => {
    const t = new SprintToggle(0.3);
    t.press(0);
    bits(t, 0, 2000);
    t.press(2000);
    const a = bits(t, 2000, 2100);
    t.press(2100);
    const b = bits(t, 2100, 3000);
    expect(edges([...a, ...b], true)).toBe(2);
    expect(b.at(-1)).toBe(true);
  });
});
