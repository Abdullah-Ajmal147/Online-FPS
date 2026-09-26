import { describe, expect, it } from 'vitest';
import { createAccessFetcher, parseAccess } from './access.ts';

const GUEST = '0f8c2a6e-1b2c-4d3e-8f90-123456789abc';

describe('access fetcher', () => {
  it('asks the API with a signature and returns the unlocks', async () => {
    let seen: { url: string; sig: string | null; time: string | null } | null = null;
    const fetchAccess = createAccessFetcher({
      url: 'http://api',
      secret: 's',
      fetchImpl: (async (url: string, init: RequestInit) => {
        const h = new Headers(init.headers);
        seen = { url, sig: h.get('x-sentinel-signature'), time: h.get('x-sentinel-time') };
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
    expect(Number(seen!.time)).toBeGreaterThan(0);
  });

  it('an API saying "everything unlocked" is ignored unless this server allows it', async () => {
    const answer = (async () =>
      new Response(JSON.stringify({ level: 1, weaponKills: {}, unlockAll: true }))) as typeof fetch;
    const strict = createAccessFetcher({ url: 'http://api', secret: 's', fetchImpl: answer });
    expect((await strict(GUEST))!.unlockAll).toBe(false);
    const dev = createAccessFetcher({
      url: 'http://api',
      secret: 's',
      fetchImpl: answer,
      allowUnlockAll: true,
    });
    expect((await dev(GUEST))!.unlockAll).toBe(true);
  });

  it('unknown when there is no guest, the API is down or answers badly (null)', async () => {
    const down = createAccessFetcher({
      url: 'http://api',
      secret: 's',
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    });
    expect(await down(GUEST)).toBeNull();
    expect(await down(null)).toBeNull();
    expect(() => parseAccess({ level: 0, weaponKills: {} })).toThrow();
    expect(() => parseAccess('x')).toThrow();
    expect(parseAccess({ level: 3, weaponKills: { a: -1, b: 2 } }).weaponKills).toEqual({ b: 2 });
  });
});
