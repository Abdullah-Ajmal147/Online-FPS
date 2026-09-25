import { describe, expect, it } from 'vitest';
import { createApp, sign } from './app.ts';
import { Store } from './db.ts';
import { levelFor, xpForMatch, xpToNext } from './xp.ts';

const SECRET = 'test-secret';
const GUEST = '0f8c2a6e-1b2c-4d3e-8f90-123456789abc';
const OTHER = '9e8d7c6b-5a49-4838-a271-605f4e3d2c1b';

function app() {
  return createApp(new Store(':memory:'), SECRET);
}

function result(matchId: string, winner = 0) {
  return {
    matchId,
    mode: 'team-deathmatch',
    map: 'relay-yard',
    winner,
    durationSeconds: 600,
    players: [
      {
        guestId: GUEST,
        name: 'Ayesha',
        team: 0,
        bot: false,
        kills: 7,
        deaths: 3,
        secondsPlayed: 600,
      },
      {
        guestId: null,
        name: 'Bot Heron',
        team: 1,
        bot: true,
        kills: 5,
        deaths: 7,
        secondsPlayed: 600,
      },
      {
        guestId: OTHER,
        name: 'Omar',
        team: 1,
        bot: false,
        kills: 2,
        deaths: 4,
        secondsPlayed: 420,
      },
    ],
  };
}

async function post(a: ReturnType<typeof app>, body: unknown, secret = SECRET) {
  const text = JSON.stringify(body);
  return a.request('/matches', {
    method: 'POST',
    body: text,
    headers: { 'content-type': 'application/json', 'x-sentinel-signature': sign(text, secret) },
  });
}

describe('xp rules', () => {
  it('levels need 500, 750, 1000… XP', () => {
    expect(xpToNext(1)).toBe(500);
    expect(levelFor(0)).toEqual({ level: 1, xpIntoLevel: 0, xpForNext: 500 });
    expect(levelFor(1250)).toEqual({ level: 3, xpIntoLevel: 0, xpForNext: 1000 });
  });

  it('awards participation + kills + result', () => {
    expect(xpForMatch({ kills: 7, team: 0 }, 0)).toBe(150 + 700 + 250);
    expect(xpForMatch({ kills: 2, team: 1 }, 0)).toBe(150 + 200);
    expect(xpForMatch({ kills: 0, team: 1 }, 2)).toBe(150 + 100);
  });
});

describe('guests', () => {
  it('POST /guests issues a signed token for a new guest id', async () => {
    const a = app();
    const res = await a.request('/guests', { method: 'POST' });
    const body = (await res.json()) as { guestId: string; token: string };
    expect(body.token.split('.')[1]).toBe(body.guestId);
    const { verifyGuestToken } = await import('@sentinel/auth');
    expect(verifyGuestToken(body.token, SECRET)).toBe(body.guestId);
  });

  it('rate-limits guest creation per IP', async () => {
    const a = createApp(new Store(':memory:'), SECRET, {
      guestLimit: { burst: 5, perSecond: 0.1 },
    });
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await a.request('/guests', { method: 'POST' })).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(codes.at(-1)).toBe(429);
  });
});

describe('api', () => {
  it('GET /healthz', async () => {
    const res = await app().request('/healthz');
    expect(await res.json()).toEqual({ ok: true, service: 'api' });
  });

  it('a signed match result awards XP to humans only, and profiles show it', async () => {
    const a = app();
    const res = await post(a, result('11111111-1111-4111-8111-111111111111'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { awarded: { guestId: string; xp: number }[] };
    expect(body.awarded).toEqual([
      { guestId: GUEST, xp: 1100 },
      { guestId: OTHER, xp: 350 },
    ]);
    const profile = (await (await a.request(`/profiles/${GUEST}`)).json()) as Record<
      string,
      unknown
    >;
    expect(profile).toMatchObject({
      name: 'Ayesha',
      xp: 1100,
      level: 2,
      matches: 1,
      wins: 1,
      kills: 7,
      deaths: 3,
    });
  });

  it('rejects a forged result (wrong or missing signature) — Phase 4 exit test', async () => {
    const a = app();
    expect(
      (await post(a, result('22222222-2222-4222-8222-222222222222'), 'guessed-secret')).status,
    ).toBe(401);
    const res = await a.request('/matches', {
      method: 'POST',
      body: JSON.stringify(result('33333333-3333-4333-8333-333333333333')),
    });
    expect(res.status).toBe(401);
    const profile = (await (await a.request(`/profiles/${GUEST}`)).json()) as { xp: number };
    expect(profile.xp).toBe(0);
  });

  it('counts each match once (replayed result rejected)', async () => {
    const a = app();
    const r = result('44444444-4444-4444-8444-444444444444');
    expect((await post(a, r)).status).toBe(200);
    expect((await post(a, r)).status).toBe(409);
    const profile = (await (await a.request(`/profiles/${GUEST}`)).json()) as { matches: number };
    expect(profile.matches).toBe(1);
  });

  it('gives no XP for joining at the last moment, and counts a guest only once', async () => {
    const a = app();
    const r = result('55555555-5555-4555-8555-555555555555');
    r.players[0]!.secondsPlayed = 20; // joined 20 s before the end of a 10-minute match
    r.players.push({ ...r.players[2]! }); // same guest twice
    const body = (await (await post(a, r)).json()) as { awarded: { guestId: string }[] };
    expect(body.awarded.map((x) => x.guestId)).toEqual([OTHER]);
  });

  it('validates input', async () => {
    const a = app();
    expect((await post(a, { nope: true })).status).toBe(400);
    expect((await a.request('/profiles/not-a-uuid')).status).toBe(400);
    const fresh = (await (await a.request(`/profiles/${OTHER}`)).json()) as {
      level: number;
      xp: number;
    };
    expect(fresh).toMatchObject({ level: 1, xp: 0 });
  });
});
