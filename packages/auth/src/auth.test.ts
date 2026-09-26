import { describe, expect, it } from 'vitest';
import {
  RateLimiter,
  TOKEN_MAX_AGE_SECONDS,
  issueGuestToken,
  resolveUnlockAll,
  serviceHeaders,
  verifyGuestToken,
  verifyService,
} from './index.ts';

const SECRET = 'test-secret';

describe('guest tokens', () => {
  it('issues a token that verifies to its guest id', () => {
    const { guestId, token } = issueGuestToken(SECRET);
    expect(verifyGuestToken(token, SECRET)).toBe(guestId);
  });

  it('rejects tampering, the wrong secret, junk and expired tokens', () => {
    const { token } = issueGuestToken(SECRET, 1_000_000);
    const [v, , at, sig] = token.split('.');
    const other = '11111111-1111-4111-8111-111111111111';
    expect(verifyGuestToken(`${v}.${other}.${at}.${sig}`, SECRET, 1_000_000)).toBeNull(); // someone else's id
    expect(verifyGuestToken(token, 'guessed', 1_000_000)).toBeNull();
    expect(verifyGuestToken('junk', SECRET)).toBeNull();
    expect(verifyGuestToken(42, SECRET)).toBeNull();
    expect(verifyGuestToken(token, SECRET, 1_000_000 + TOKEN_MAX_AGE_SECONDS + 1)).toBeNull();
    expect(verifyGuestToken(token, SECRET, 1_000_000)).not.toBeNull();
  });
});

describe('RateLimiter', () => {
  it('allows a burst, then refills at the sustained rate, per key', () => {
    let now = 0;
    const rl = new RateLimiter(3, 1, () => now);
    expect([rl.take('a'), rl.take('a'), rl.take('a'), rl.take('a')]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(rl.take('b')).toBe(true); // other clients unaffected
    now += 1000;
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
  });
});

describe('resolveApiSecret', () => {
  it('uses the dev secret only outside production', async () => {
    const { DEV_SECRET, resolveApiSecret } = await import('./secret.ts');
    expect(resolveApiSecret({})).toBe(DEV_SECRET);
    expect(() => resolveApiSecret({ NODE_ENV: 'production' })).toThrow();
    expect(() =>
      resolveApiSecret({ NODE_ENV: 'production', SENTINEL_API_SECRET: DEV_SECRET }),
    ).toThrow();
    expect(() =>
      resolveApiSecret({ NODE_ENV: 'production', SENTINEL_API_SECRET: 'short' }),
    ).toThrow();
    const good = 'x'.repeat(40);
    expect(resolveApiSecret({ NODE_ENV: 'production', SENTINEL_API_SECRET: good })).toBe(good);
  });
});

describe('ops', () => {
  it('renders Prometheus counters and gauges', async () => {
    const { Metrics } = await import('./ops.ts');
    const m = new Metrics();
    const c = m.counter('sentinel_matches_total', 'Matches finished');
    c.inc();
    c.inc(2);
    m.gauge('sentinel_players', 'Players connected', () => 7);
    const text = m.render();
    expect(text).toContain('# TYPE sentinel_matches_total counter\nsentinel_matches_total 3');
    expect(text).toContain('sentinel_players 7');
  });

  it('computes percentiles over a rolling window', async () => {
    const { Window } = await import('./ops.ts');
    const w = new Window(100);
    for (let i = 1; i <= 200; i++) w.add(i);
    expect(w.percentile(0.5)).toBe(151);
    expect(w.percentile(0.99)).toBe(200);
  });

  it('logs JSON lines in production', async () => {
    const { createLogger } = await import('./ops.ts');
    const lines: string[] = [];
    const orig = console.log;
    console.log = (s: string) => void lines.push(s);
    try {
      createLogger('test', { NODE_ENV: 'production' }).info('hello', { room: 'r1' });
    } finally {
      console.log = orig;
    }
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'info',
      service: 'test',
      msg: 'hello',
      room: 'r1',
    });
  });
});

describe('service signatures', () => {
  const now = Date.UTC(2026, 8, 26, 12);
  it('verify only for the same purpose, payload, secret and within a minute', () => {
    const h = serviceHeaders('s', 'access', 'guest-1', now);
    const t = h['x-sentinel-time'];
    const sig = h['x-sentinel-signature'];
    expect(verifyService('s', 'access', 'guest-1', t, sig, now + 30_000)).toBe(true);
    expect(verifyService('s', 'match', 'guest-1', t, sig, now)).toBe(false); // other purpose
    expect(verifyService('s', 'access', 'guest-2', t, sig, now)).toBe(false);
    expect(verifyService('x', 'access', 'guest-1', t, sig, now)).toBe(false);
    expect(verifyService('s', 'access', 'guest-1', t, sig, now + 61_000)).toBe(false); // replay
    expect(verifyService('s', 'access', 'guest-1', undefined, sig, now)).toBe(false);
    expect(verifyService('s', 'access', 'guest-1', t, 'zz', now)).toBe(false);
  });

  it('unlock-all is off unless explicitly set to 1', () => {
    expect(resolveUnlockAll({})).toBe(false);
    expect(resolveUnlockAll({ NODE_ENV: 'development' })).toBe(false);
    expect(resolveUnlockAll({ SENTINEL_UNLOCK_ALL: '0' })).toBe(false);
    expect(resolveUnlockAll({ SENTINEL_UNLOCK_ALL: 'true' })).toBe(false);
    expect(resolveUnlockAll({ SENTINEL_UNLOCK_ALL: '1', NODE_ENV: 'production' })).toBe(true);
  });
});
