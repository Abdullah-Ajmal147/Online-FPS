import { describe, expect, it } from 'vitest';
import { declutter } from './declutter.ts';

describe('name tag declutter', () => {
  it('leaves separate labels where they are', () => {
    expect(
      declutter([
        { x: 100, y: 100, w: 60, h: 16, depth: 5 },
        { x: 300, y: 100, w: 60, h: 16, depth: 8 },
      ]),
    ).toEqual([0, 0]);
  });

  it('stacks overlapping labels upward, the nearest one stays put', () => {
    const shift = declutter([
      { x: 105, y: 100, w: 60, h: 16, depth: 9 }, // farther
      { x: 100, y: 100, w: 60, h: 16, depth: 3 }, // nearer
      { x: 110, y: 102, w: 60, h: 16, depth: 12 },
    ]);
    expect(shift[1]).toBe(0);
    expect(shift[0]).toBe(18);
    expect(shift[2]).toBe(36);
  });

  it('gives up after a few steps instead of climbing off screen', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ x: 100, y: 100, w: 60, h: 16, depth: i }));
    expect(Math.max(...declutter(many, 2, 6))).toBe(6 * 18);
  });
});
