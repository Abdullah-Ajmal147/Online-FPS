import { describe, expect, it } from 'vitest';
import { NEW_PLAYER } from '@sentinel/content';
import { createAccessFetcher, parseAccess } from './access.ts';

const GUEST = '0f8c2a6e-1b2c-4d3e-8f90-123456789abc';

describe('access fetcher', () => {
  it('asks the API with a signature and returns the unlocks', async () => {
    let seen: { url: string; sig: string | null } | null = null;
    const fetchAccess = createAccessFetcher({
      url: 'http://api',
      secret: 's',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, sig: new Headers(init.headers).get('x-sentinel-signature') };
        return new Response(JSON.stringify({ level: 7, weaponKills: { 'kestrel-ar': 40 } }));
      }) as typeof fetch,
    });
    expect(await fetchAccess(GUEST)).toEqual({
      level: 7,
      weaponKills: { 'kestrel-ar': 40 },
      unlockAll: false,
    });
    expect(seen!.url).toBe(`http://api/access/${GUEST}`);
    expect(seen!.sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed: no guest, API down or a bad answer → a new player', async () => {
    const down = createAccessFetcher({
      url: 'http://api',
      secret: 's',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(await down(GUEST)).toEqual(NEW_PLAYER);
    expect(await down(null)).toEqual(NEW_PLAYER);
    expect(() => parseAccess({ level: 0, weaponKills: {} })).toThrow();
    expect(() => parseAccess('x')).toThrow();
    expect(parseAccess({ level: 3, weaponKills: { a: -1, b: 2 } }).weaponKills).toEqual({ b: 2 });
  });
});
