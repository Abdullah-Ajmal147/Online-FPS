import { describe, expect, it } from 'vitest';
import { FakeLag, LAG_PRESETS, presetFromEnv, type LagPreset } from './fakeLag.ts';

function harness(preset: LagPreset = LAG_PRESETS.normal, seed = 7) {
  let now = 0;
  const pending: { at: number; fn: () => void }[] = [];
  const lag = new FakeLag(
    preset,
    seed,
    () => now,
    (fn, ms) => pending.push({ at: now + ms, fn }),
  );
  const flush = (until: number) => {
    pending.sort((a, b) => a.at - b.at);
    while (pending.length && pending[0]!.at <= until) {
      const p = pending.shift()!;
      now = p.at;
      p.fn();
    }
    now = until;
  };
  return { lag, flush };
}

describe('FakeLag', () => {
  it('drops about the preset share of droppable messages (3% for normal)', () => {
    const { lag, flush } = harness();
    let delivered = 0;
    for (let i = 0; i < 20_000; i++) lag.pass(`c${i % 10}:out`, () => delivered++, true);
    flush(1e9);
    const lossRate = 1 - delivered / 20_000;
    expect(lossRate).toBeGreaterThan(0.025);
    expect(lossRate).toBeLessThan(0.035);
  });

  it('never drops reliable messages', () => {
    const { lag, flush } = harness(LAG_PRESETS.bad);
    let delivered = 0;
    for (let i = 0; i < 1000; i++) lag.pass('c:out', () => delivered++, false);
    flush(1e9);
    expect(delivered).toBe(1000);
  });

  it('delays each direction by half the RTT, within ± half the jitter', () => {
    const recorded: number[] = [];
    const lag2 = new FakeLag(
      LAG_PRESETS.normal,
      3,
      () => 0,
      (_fn, ms) => recorded.push(ms),
    );
    for (let i = 0; i < 500; i++) lag2.pass(`lane${i}`, () => {}, false);
    expect(Math.min(...recorded)).toBeGreaterThanOrEqual(60 - 10);
    expect(Math.max(...recorded)).toBeLessThanOrEqual(60 + 10);
  });

  it('keeps messages on one lane in order despite jitter', () => {
    const { lag, flush } = harness(LAG_PRESETS.bad);
    const got: number[] = [];
    for (let i = 0; i < 200; i++) lag.pass('c:in', () => got.push(i), false);
    flush(1e9);
    expect(got).toEqual([...Array(200).keys()]);
  });

  it('reads the preset from the environment', () => {
    expect(presetFromEnv(undefined)).toBeNull();
    expect(presetFromEnv('bad')).toBe('bad');
    expect(() => presetFromEnv('terrible')).toThrow();
  });
});
