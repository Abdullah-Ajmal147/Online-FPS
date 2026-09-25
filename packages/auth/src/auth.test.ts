import { describe, expect, it } from 'vitest';
import { RateLimiter, TOKEN_MAX_AGE_SECONDS, issueGuestToken, verifyGuestToken } from './index.ts';

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
