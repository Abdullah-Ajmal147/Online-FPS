import { describe, expect, it } from 'vitest';
import { SNAPSHOT_RATE, TICK_DT, TICK_RATE, TICKS_PER_SNAPSHOT } from './constants.ts';

describe('netcode constants', () => {
  it('match docs/NETCODE.md', () => {
    expect(TICK_RATE).toBe(60);
    expect(TICK_DT).toBeCloseTo(1 / 60);
    expect(SNAPSHOT_RATE).toBe(30);
    expect(Number.isInteger(TICKS_PER_SNAPSHOT)).toBe(true);
  });
});
