import { describe, expect, it } from 'vitest';
import { parseArgs } from './args.ts';

describe('parseArgs', () => {
  it('uses defaults', () => {
    expect(parseArgs([])).toEqual({ count: 1, url: 'http://localhost:2567', mode: 'wander' });
  });

  it('reads flags, skipping the pnpm "--" separator', () => {
    expect(parseArgs(['--', '--count', '11', '--room', 'abc'])).toEqual({
      count: 11,
      room: 'abc',
      url: 'http://localhost:2567',
      mode: 'wander',
    });
  });

  it('reads --duration', () => {
    expect(parseArgs(['--duration', '60']).duration).toBe(60);
    expect(() => parseArgs(['--duration', '-1'])).toThrow();
  });

  it('reads --mode', () => {
    expect(parseArgs(['--mode', 'duel']).mode).toBe('duel');
    expect(() => parseArgs(['--mode', 'chaos'])).toThrow();
  });

  it('rejects bad input', () => {
    expect(() => parseArgs(['--count', '0'])).toThrow();
    expect(() => parseArgs(['--nope', '1'])).toThrow();
    expect(() => parseArgs(['--count'])).toThrow();
  });
});
