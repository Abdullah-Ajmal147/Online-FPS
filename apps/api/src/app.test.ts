import { describe, expect, it } from 'vitest';
import { serviceHeaders } from '@sentinel/auth';
import { createApp } from './app.ts';
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
        headshots: 2,
        weaponKills: { 'kestrel-ar': 5, 'vireo-smg': 2 },
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

async function post(a: ReturnType<typeof app>, body: unknown, secret = SECRET, nowMs = Date.now()) {
  const text = JSON.stringify(body);
  return a.request('/matches', {
    method: 'POST',
    body: text,
    headers: {
      'content-type': 'application/json',
      ...serviceHeaders(secret, 'match', text, nowMs),
    },
  });
}

describe('xp rules', () => {
  it('levels need 500, 750, 1000… XP', () => {
    expect(xpToNext(1)).toBe(500);
    expect(levelFor(0)).toEqual({ level: 1, xpIntoLevel: 0, xpForNext: 500 });
    expect(levelFor(1250)).toEqual({ level: 3, xpIntoLevel: 0, xpForNext: 1000 });
  });

  it('awards participation + kills + result', () => {
    expect(xpForMatch({ kills: 7, team: 0, headshots: 0 }, 0)).toBe(150 + 700 + 250);
    expect(xpForMatch({ kills: 2, team: 1, headshots: 0 }, 0)).toBe(150 + 200);
    expect(xpForMatch({ kills: 0, team: 1, headshots: 0 }, 2)).toBe(150 + 100);
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
      { guestId: GUEST, xp: 1150 }, // 150 + 7 kills + 2 headshots × 25 + win
      { guestId: OTHER, xp: 350 },
    ]);
    const profile = (await (await a.request(`/profiles/${GUEST}`)).json()) as Record<
      string,
      unknown
    >;
    expect(profile).toMatchObject({
      name: 'Ayesha',
      xp: 1150,
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

describe('unlocks', () => {
  const access = (a: ReturnType<typeof app>, guestId: string, secret = SECRET) =>
    a.request(`/access/${guestId}`, { headers: serviceHeaders(secret, 'access', guestId) });

  it('headshots add XP and weapon kills are stored per weapon', async () => {
    const a = app();
    await post(a, result('11111111-2222-4333-8444-555555555555'));
    const res = await access(a, GUEST);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { level: number; weaponKills: Record<string, number> };
    expect(body.weaponKills).toEqual({ 'kestrel-ar': 5, 'vireo-smg': 2 });
    expect(body.level).toBe(levelFor(xpForMatch({ team: 0, kills: 7, headshots: 2 }, 0)).level);
    // Totals add up over matches.
    await post(a, result('11111111-2222-4333-8444-666666666666'));
    const again = (await (await access(a, GUEST)).json()) as {
      weaponKills: Record<string, number>;
    };
    expect(again.weaponKills['kestrel-ar']).toBe(10);
  });

  it('only the game server (signed) can read access; the public profile shows weapon kills', async () => {
    const a = app();
    expect((await a.request(`/access/${GUEST}`)).status).toBe(401);
    expect((await access(a, GUEST, 'wrong')).status).toBe(401);
    const profile = (await (await a.request(`/profiles/${GUEST}`)).json()) as {
      weaponKills: object;
      unlockAll: boolean;
    };
    expect(profile.weaponKills).toEqual({});
    expect(profile.unlockAll).toBe(false);
  });

  it('unlockAll (local play) is reported to the server and the menu', async () => {
    const a = createApp(new Store(':memory:'), SECRET, { unlockAll: true });
    const body = (await (await access(a, GUEST)).json()) as { unlockAll: boolean };
    expect(body.unlockAll).toBe(true);
  });
});

describe('challenges', () => {
  const MONDAY = Date.UTC(2026, 8, 21, 12); // pins which challenges are active
  const pinned = () => createApp(new Store(':memory:'), SECRET, { now: () => MONDAY });
  type Profile = {
    xp: number;
    challenges: { id: string; target: number; progress: number; xp: number; stat?: string }[];
    lastMatch: {
      lines: { label: string; xp: number }[];
      challenges: { text: string; xp: number }[];
      total: number;
      levelBefore: number;
      levelAfter: number;
    } | null;
  };
  const profile = async (a: ReturnType<typeof app>) =>
    (await (await a.request(`/profiles/${GUEST}`)).json()) as Profile;
  const ids = ['aaaaaaaa-0000-4000-8000-00000000000', 'bbbbbbbb-0000-4000-8000-00000000000'];

  it('progress moves only from signed results; a forged one changes nothing (Phase 6 exit test)', async () => {
    const a = pinned();
    const before = await profile(a);
    expect(before.challenges.length).toBeGreaterThan(0);
    expect(before.challenges.every((c) => c.progress === 0)).toBe(true);
    // A modified client posts "its" stats: no valid signature → rejected, nothing moves.
    const forged = await post(a, result(`${ids[0]}1`), 'not-the-server-secret', MONDAY);
    expect(forged.status).toBe(401);
    expect((await profile(a)).challenges.every((c) => c.progress === 0)).toBe(true);
    // The real server's result moves progress.
    expect((await post(a, result(`${ids[0]}2`), SECRET, MONDAY)).status).toBe(200);
    expect((await profile(a)).challenges.some((c) => c.progress > 0)).toBe(true);
  });

  it('a completed challenge pays its XP once, and the results breakdown adds up', async () => {
    const a = pinned();
    for (let i = 0; i < 6; i++) await post(a, result(`${ids[1]}${i}`), SECRET, MONDAY);
    const p = await profile(a);
    const completed = p.challenges.filter((c) => c.progress >= c.target);
    expect(completed.length).toBeGreaterThan(0);
    const bonus = completed.reduce((n, c) => n + c.xp, 0);
    // 6 matches × (150 + 700 kills + 50 headshots + 250 win) + each completed challenge once.
    expect(p.xp).toBe(6 * 1150 + bonus);
    const last = p.lastMatch!;
    expect(last.total).toBe(
      last.lines.reduce((n, l) => n + l.xp, 0) + last.challenges.reduce((n, c) => n + c.xp, 0),
    );
    expect(last.levelAfter).toBeGreaterThanOrEqual(last.levelBefore);
  });
});

describe('service request hardening (review)', () => {
  it('a match result signature expires and can not be reused for another purpose', async () => {
    const a = app();
    const text = JSON.stringify(result('cccccccc-0000-4000-8000-000000000001'));
    const old = serviceHeaders(SECRET, 'match', text, Date.now() - 5 * 60_000);
    const replay = await a.request('/matches', { method: 'POST', body: text, headers: old });
    expect(replay.status).toBe(401);
    const wrongPurpose = serviceHeaders(SECRET, 'access', text);
    expect(
      (await a.request('/matches', { method: 'POST', body: text, headers: wrongPurpose })).status,
    ).toBe(401);
  });

  it('rejects inconsistent stats and ignores unknown weapons', async () => {
    const a = app();
    const bad = result('cccccccc-0000-4000-8000-000000000002') as { players: object[] };
    bad.players[0] = { ...bad.players[0], headshots: 99 };
    expect((await post(a, bad)).status).toBe(400);
    const odd = result('cccccccc-0000-4000-8000-000000000003') as { players: object[] };
    odd.players[0] = { ...odd.players[0], weaponKills: { 'kestrel-ar': 3, 'laser-cannon': 2 } };
    expect((await post(a, odd)).status).toBe(200);
    const res = await a.request(`/access/${GUEST}`, {
      headers: serviceHeaders(SECRET, 'access', GUEST),
    });
    expect(((await res.json()) as { weaponKills: object }).weaponKills).toEqual({
      'kestrel-ar': 3,
    });
  });

  it('rate-limits failed /access attempts per IP', async () => {
    const a = app();
    let limited = false;
    for (let i = 0; i < 80 && !limited; i++) {
      limited = (await a.request(`/access/${GUEST}`)).status === 429;
    }
    expect(limited).toBe(true);
  });
});

describe('player codes (friends)', () => {
  it('a player who has played can be looked up by code; nothing reveals the guest id', async () => {
    const a = app();
    await post(a, result('dddddddd-0000-4000-8000-000000000001'));
    const me = (await (await a.request(`/profiles/${GUEST}`)).json()) as { code: string };
    expect(me.code).toMatch(/^[0-9a-f]{16}$/);
    const card = await a.request(`/players/${me.code}`);
    expect(card.status).toBe(200);
    const body = (await card.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: me.code, name: 'Ayesha', level: 2 });
    expect(JSON.stringify(body)).not.toContain(GUEST);
    expect((await a.request('/players/0000000000000000')).status).toBe(404);
    expect((await a.request('/players/not-a-code')).status).toBe(400);
  });

  it('adds the code column to a database made before it existed', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const path = join(mkdtempSync(join(tmpdir(), 'sentinel-')), 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE profiles (guest_id TEXT PRIMARY KEY, name TEXT NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0, matches INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0, kills INTEGER NOT NULL DEFAULT 0,
      deaths INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`);
    old.close();
    const seed = new DatabaseSync(path);
    seed
      .prepare('INSERT INTO profiles (guest_id, name, xp, updated_at) VALUES (?, ?, ?, ?)')
      .run(OTHER, 'Old Timer', 900, Date.UTC(2026, 0, 2, 15, 30));
    seed.close();
    const a = createApp(new Store(path), SECRET);
    // An old player who hasn't played since gets a code at startup and can be found by it,
    // with "last played" rounded to the day.
    const code = ((await (await a.request(`/profiles/${OTHER}`)).json()) as { code: string }).code;
    const card = (await (await a.request(`/players/${code}`)).json()) as { lastPlayed: number };
    expect(card.lastPlayed).toBe(Date.UTC(2026, 0, 2));
    expect((await post(a, result('dddddddd-0000-4000-8000-000000000002'))).status).toBe(200);
    const again = createApp(new Store(path), SECRET); // restart: backfill is idempotent
    expect((await again.request(`/players/${code}`)).status).toBe(200);
  });
});

describe('moderation (Phase 7)', () => {
  const ADMIN = 'correct-horse-battery';
  const auth = { authorization: `Basic ${Buffer.from(`admin:${ADMIN}`).toString('base64')}` };
  const modApp = () => createApp(new Store(':memory:'), SECRET, { adminPassword: ADMIN });
  const flagged = (matchId: string) => {
    const r = result(matchId) as { players: Record<string, unknown>[]; log?: unknown };
    r.players[0] = {
      ...r.players[0],
      flags: ['accuracy', 'snap-aim'],
      aim: { shots: 90, hits: 85 },
    };
    r.log = { samples: [[1, [[1, 2.5, -3, 100]]]], kills: [[1, 1, 2, 1, 1, 2.5, -3, 4, 5]] };
    return r;
  };
  const guestToken = async (a: ReturnType<typeof app>) =>
    ((await (await a.request('/guests', { method: 'POST' })).json()) as { token: string }).token;
  const codeOf = async (a: ReturnType<typeof app>, guest: string) =>
    ((await (await a.request(`/profiles/${guest}`)).json()) as { code: string }).code;

  it('the admin page is off without a password, and needs it when on', async () => {
    expect((await app().request('/admin')).status).toBe(404);
    const a = modApp();
    expect((await a.request('/admin')).status).toBe(401);
    expect((await a.request('/admin/api/queue')).status).toBe(401);
    const wrong = { authorization: `Basic ${Buffer.from('admin:nope').toString('base64')}` };
    expect((await a.request('/admin/api/queue', { headers: wrong })).status).toBe(401);
    expect((await a.request('/admin', { headers: auth })).status).toBe(200);
  });

  it('flags and match logs from the server reach the admin queue and player file', async () => {
    const a = modApp();
    await post(a, flagged('ffffffff-0000-4000-8000-000000000001'));
    const queue = (await (await a.request('/admin/api/queue', { headers: auth })).json()) as {
      code: string;
      flaggedMatches: number;
    }[];
    const code = await codeOf(a, GUEST);
    expect(queue.find((q) => q.code === code)?.flaggedMatches).toBe(1);
    const file = (await (
      await a.request(`/admin/api/players/${code}`, { headers: auth })
    ).json()) as {
      flags: { flags: string[]; matchId: string }[];
      profile: Record<string, unknown>;
    };
    expect(file.flags[0]!.flags).toEqual(['accuracy', 'snap-aim']);
    expect(JSON.stringify(file)).not.toContain(GUEST); // guest ids never leave the API
    const log = (await (
      await a.request(`/admin/api/matches/${file.flags[0]!.matchId}/log?code=${code}`, {
        headers: auth,
      })
    ).json()) as { log: { kills: unknown[] }; players: { focus: boolean; name: string }[] };
    expect(log.log.kills).toHaveLength(1);
    expect(log.players.find((p) => p.focus)?.name).toBe('Ayesha');
  });

  it('players report by code with their signed token; no self-reports; rate-limited', async () => {
    const a = modApp();
    await post(a, result('ffffffff-0000-4000-8000-000000000002'));
    const target = await codeOf(a, GUEST);
    const token = await guestToken(a);
    const report = (body: object) =>
      a.request('/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await report({ token: 'forged', code: target, reason: 'cheating' })).status).toBe(401);
    expect((await report({ token, code: target, reason: 'cheating' })).status).toBe(202);
    expect((await report({ token, code: target, reason: 'dancing' })).status).toBe(400);
    let limited = false;
    for (let i = 0; i < 10; i++)
      limited ||= (await report({ token, code: target, reason: 'abuse' })).status === 429;
    expect(limited).toBe(true);
    const queue = (await (await a.request('/admin/api/queue', { headers: auth })).json()) as {
      code: string;
      reports: number;
    }[];
    expect(queue.find((q) => q.code === target)!.reports).toBeGreaterThanOrEqual(2);
  });

  it('ban / shadow-ban reach the game server through /access', async () => {
    const a = modApp();
    await post(a, result('ffffffff-0000-4000-8000-000000000003'));
    const code = await codeOf(a, GUEST);
    const access = async () =>
      (
        (await (
          await a.request(`/access/${GUEST}`, { headers: serviceHeaders(SECRET, 'access', GUEST) })
        ).json()) as { status: string }
      ).status;
    expect(await access()).toBe('ok');
    const set = (status: string) =>
      a.request(`/admin/api/players/${code}/status`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    expect((await set('shadow')).status).toBe(200);
    expect(await access()).toBe('shadow');
    expect((await set('banned')).status).toBe(200);
    expect(await access()).toBe('banned');
    expect((await set('nonsense')).status).toBe(400);
  });
});
