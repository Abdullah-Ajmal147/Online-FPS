import { describe, expect, it } from 'vitest';
import { musicFor } from './director.ts';

const at = (phase: 'warmup' | 'countdown' | 'live' | 'ended') =>
  musicFor({ inMatch: true, match: { phase } as never });

describe('music director', () => {
  it('theme in menus and on results; heartbeat in the countdown; quiet in play', () => {
    expect(musicFor({ inMatch: false, match: null })).toBe('menu');
    expect(musicFor({ inMatch: true, match: null })).toBe('match'); // joining
    expect(at('warmup')).toBe('match');
    expect(at('countdown')).toBe('countdown');
    expect(at('live')).toBe('match');
    expect(at('ended')).toBe('menu');
  });
});
