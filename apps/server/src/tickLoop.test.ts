import { describe, expect, it } from 'vitest';
import { MAX_CATCH_UP_TICKS, TickLoop } from './tickLoop.ts';

describe('TickLoop', () => {
  it('runs 60 ticks per second of wall time, whatever the timer jitter', () => {
    let now = 0;
    let ticks = 0;
    const loop = new TickLoop(
      () => ticks++,
      () => now,
    );
    const jitter = [3, 11, 7, 9, 2, 14, 8, 6];
    let i = 0;
    while (now < 10_000) {
      now += jitter[i++ % jitter.length]!;
      loop.pump();
    }
    expect(ticks).toBeGreaterThanOrEqual(599);
    expect(ticks).toBeLessThanOrEqual(601);
  });

  it('limits catch-up after a stall instead of spiralling', () => {
    let now = 0;
    let ticks = 0;
    const loop = new TickLoop(
      () => ticks++,
      () => now,
    );
    now = 2000; // 2 s freeze
    expect(loop.pump()).toBe(MAX_CATCH_UP_TICKS);
    now += 1;
    expect(loop.pump()).toBeLessThanOrEqual(1);
  });
});
