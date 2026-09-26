import {
  issueGuestToken,
  publicCode,
  RateLimiter,
  verifyGuestToken,
  verifyService,
} from '@sentinel/auth';
import { mountAdmin } from './admin.ts';
import { Presence } from './presence.ts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { Store } from './db.ts';
import { counters, metrics } from './ops.ts';
import { activeChallenges, challengeProgress, weapons } from '@sentinel/content';
import { levelFor, xpBreakdown } from './xp.ts';

const GUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the game server reports at the end of a match (never accepted from a browser). */
/** Match log (review replay). Validated on its own: a bad log is dropped, the result kept. */
const MatchLogSchema = z.object({
  samples: z.array(z.tuple([z.number(), z.array(z.array(z.number()).max(4)).max(24)])).max(4000),
  kills: z.array(z.array(z.number()).max(9)).max(3000),
});

const MatchResultSchema = z.object({
  matchId: z.string().regex(GUEST_ID),
  mode: z.string(),
  map: z.string(),
  winner: z.number().int().min(0).max(255),
  durationSeconds: z.number().nonnegative(),
  players: z
    .array(
      z
        .object({
          guestId: z.string().regex(GUEST_ID).nullable(),
          name: z.string().max(32),
          team: z.number().int().min(0).max(1),
          bot: z.boolean(),
          kills: z.number().int().nonnegative().max(1000),
          deaths: z.number().int().nonnegative().max(1000),
          headshots: z.number().int().nonnegative().max(1000).default(0),
          fragKills: z.number().int().nonnegative().max(1000).default(0),
          /** Kills per weapon id (weapon levels); ids not in the weapon catalog are dropped. */
          weaponKills: z
            .record(z.string().regex(/^[a-z0-9-]{1,32}$/), z.number().int().nonnegative().max(1000))
            .default({})
            .refine((r) => Object.keys(r).length <= 16, 'too many weapons')
            .transform((r) =>
              Object.fromEntries(Object.entries(r).filter(([id]) => Object.hasOwn(weapons, id))),
            ),
          secondsPlayed: z.number().nonnegative(),
          /** Anti-cheat numbers and anomaly flags (Phase 7 task 3). */
          aim: z.record(z.string(), z.number().nullable()).optional(),
          flags: z
            .array(
              z.enum(['accuracy', 'headshot-rate', 'reaction-time', 'snap-aim', 'kd-vs-level']),
            )
            .max(8)
            .default([]),
        })
        // Consistent stats only (a buggy or misconfigured server can't inflate weapon levels).
        .refine(
          (p) =>
            p.headshots <= p.kills &&
            p.fragKills <= p.kills &&
            Object.values(p.weaponKills).reduce((n, k) => n + k, 0) <= p.kills,
          'headshots, frag kills and weapon kills can not exceed kills',
        ),
    )
    .max(24), // players present at the end plus those who left during the match
});

export interface AppOptions {
  /** How to find the caller's IP for rate limits (the Node listener passes the socket address). */
  clientIp?: (c: Context) => string;
  /**
   * New guests per IP: burst, then per second. Generous on purpose: many players can share
   * one IP (schools, offices, internet cafés, mobile carriers).
   */
  guestLimit?: { burst: number; perSecond: number };
  /**
   * Everything counts as unlocked (SENTINEL_UNLOCK_ALL=1: local play and tests). Reported in
   * each profile, so the game server and the menu follow the same switch.
   */
  unlockAll?: boolean;
  /** Admin page password (SENTINEL_ADMIN_PASSWORD); without one the admin page is off. */
  adminPassword?: string | undefined;
  /** Clock (tests pin it to a date to know which challenges are active). */
  now?: () => number;
}

/** The API app, separate from the Node listener so tests can call it directly. */
export function createApp(store: Store, secret: string, opts: AppOptions = {}): Hono {
  const app = new Hono();
  const corsAll = cors();
  const now = opts.now ?? Date.now;
  // Every profile gets its current public code (rows from before codes existed, or from an
  // older code format), so friends can always find them.
  store.backfillCodes((guestId) => publicCode(secret, guestId));
  // Open CORS for the game's public API; never for the admin page (credentials + CSRF).
  app.use('*', async (c, next) => (c.req.path.startsWith('/admin') ? next() : corsAll(c, next)));
  app.use('*', async (_c, next) => {
    counters.requests.inc();
    await next();
  });

  app.get('/metrics', (c) =>
    c.text(metrics.render(), 200, { 'content-type': 'text/plain; version=0.0.4' }),
  );
  const ipOf = opts.clientIp ?? (() => 'local');
  const g = opts.guestLimit ?? { burst: 30, perSecond: 0.5 };
  const guestLimit = new RateLimiter(g.burst, g.perSecond);
  const readLimit = new RateLimiter(60, 5);

  /** New guest: a random id and a token signed with the server secret (Phase 4 lite). */
  app.post('/guests', (c) => {
    if (!guestLimit.take(ipOf(c))) {
      counters.rateLimited.inc();
      return c.json({ error: 'too many requests' }, 429);
    }
    counters.guests.inc();
    // No database row here (guests are free to create); the row appears on the first join.
    return c.json(issueGuestToken(secret));
  });

  app.get('/healthz', (c) => c.json({ ok: true, service: 'api' }));

  /**
   * Game server → API: a finished match. Signed with the server secret (a browser can't forge
   * it), each match counted once (replays rejected), XP computed here from the server's result.
   */
  // Results carry a match log (~150 KB); anything far bigger is refused before parsing.
  app.post('/matches', bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c) => {
    const body = await c.req.text();
    const signed = verifyService(
      secret,
      'match',
      body,
      c.req.header('x-sentinel-time'),
      c.req.header('x-sentinel-signature'),
      now(),
    );
    if (!signed) {
      counters.rejected.inc();
      return c.json({ error: 'bad signature' }, 401);
    }
    let parsed;
    let log: z.infer<typeof MatchLogSchema> | null;
    try {
      const json = JSON.parse(body) as { log?: unknown };
      parsed = MatchResultSchema.parse(json);
      const logResult = MatchLogSchema.safeParse(json.log);
      log = logResult.success ? logResult.data : null;
    } catch {
      counters.rejected.inc();
      return c.json({ error: 'bad match result' }, 400);
    }
    if (!store.recordMatch(parsed.matchId, parsed, now())) {
      counters.rejected.inc();
      return c.json({ error: 'match already recorded' }, 409);
    }
    if (log) store.saveMatchLog(parsed.matchId, now(), log);
    counters.matches.inc();
    const awarded: { guestId: string; xp: number }[] = [];
    const seen = new Set<string>();
    for (const p of parsed.players) {
      if (p.bot || !p.guestId || seen.has(p.guestId)) continue; // each guest once per match
      seen.add(p.guestId);
      // Flags count whatever the time played (a hacker who quits early is still flagged).
      if (p.flags.length > 0)
        store.addFlags(p.guestId, parsed.matchId, p.flags, p.aim ?? {}, now());
      // No XP for joining in the last seconds: at least 60 s, or a quarter of a short match.
      if (p.secondsPlayed < Math.min(60, parsed.durationSeconds / 4)) continue;
      const won = parsed.winner === p.team;
      const lines = xpBreakdown(p, parsed.winner);
      // Challenges move only here, from the server's signed stats.
      const done: { text: string; xp: number }[] = [];
      for (const ch of activeChallenges(now())) {
        const add = challengeProgress(ch, { ...p, won });
        if (add > 0 && store.addChallengeProgress(p.guestId, ch, add)) {
          done.push({ text: ch.text, xp: ch.xp });
        }
      }
      const xp = [...lines, ...done].reduce((n, l) => n + l.xp, 0);
      const before = store.profile(p.guestId)?.xp ?? 0;
      store.setLastMatch(p.guestId, {
        matchId: parsed.matchId,
        at: now(),
        lines,
        challenges: done,
        total: xp,
        levelBefore: levelFor(before).level,
        levelAfter: levelFor(before + xp).level,
      });
      store.addResult(p.guestId, p.name, {
        code: publicCode(secret, p.guestId),
        xp,
        win: parsed.winner === p.team,
        kills: p.kills,
        deaths: p.deaths,
        weaponKills: p.weaponKills,
      });
      awarded.push({ guestId: p.guestId, xp });
    }
    return c.json({ ok: true, awarded });
  });

  /**
   * Game server → API: what a player has unlocked (level, weapon kills). Signed like match
   * results (HMAC of the guest id), so it isn't rate-limited per IP: one game server asks for
   * every player it hosts.
   */
  /**
   * Game server → API at every join: what this player has unlocked and whether they may play.
   * `guest` (may be empty: players without a profile) and `ip` (keyed hash of their IP) are
   * signed by the game server. A ban on the profile or on the IP applies; a first-time guest
   * gets their profile row here (so moderators can act on them by code).
   */
  app.get('/access', (c) => {
    const guestId = c.req.query('guest') ?? '';
    const ip = c.req.query('ip') ?? '';
    if ((guestId && !GUEST_ID.test(guestId)) || !/^[0-9a-f]{16}$/.test(ip))
      return c.json({ error: 'bad request' }, 400);
    const signed = verifyService(
      secret,
      'access',
      `${guestId}|${ip}`,
      c.req.header('x-sentinel-time'),
      c.req.header('x-sentinel-signature'),
      now(),
    );
    if (!signed) {
      // Game servers are never limited; failed attempts are, per IP (it's reachable publicly).
      counters.rejected.inc();
      if (!readLimit.take(ipOf(c))) return c.json({ error: 'too many requests' }, 429);
      return c.json({ error: 'bad signature' }, 401);
    }
    if (guestId) store.touchProfile(guestId, publicCode(secret, guestId), ip, now());
    const row = guestId ? store.profile(guestId) : null;
    return c.json({
      level: levelFor(row?.xp ?? 0).level,
      weaponKills: guestId ? store.weaponKills(guestId) : {},
      unlockAll: opts.unlockAll === true,
      status: store.worstStatus(guestId || null, ip),
    });
  });

  /**
   * A player reports another (by public code) from the pause menu. The reporter proves who
   * they are with their signed guest token; a few reports per player, then one per 10 min.
   */
  const reportLimit = new RateLimiter(5, 1 / 600);
  const reportIpLimit = new RateLimiter(20, 1 / 120);
  const ReportSchema = z.object({
    token: z.string().max(200),
    code: z.string().regex(/^[0-9a-f]{16}$/),
    reason: z.enum(['cheating', 'abuse', 'name']),
    matchId: z.string().regex(GUEST_ID).nullable().default(null),
  });
  app.post('/reports', async (c) => {
    let body;
    try {
      body = ReportSchema.parse(await c.req.json());
    } catch {
      return c.json({ error: 'bad report' }, 400);
    }
    const reporter = verifyGuestToken(body.token, secret);
    if (!reporter) return c.json({ error: 'bad token' }, 401);
    if (publicCode(secret, reporter) === body.code) return c.json({ error: 'that is you' }, 400);
    if (!reportLimit.take(reporter) || !reportIpLimit.take(ipOf(c)))
      return c.json({ error: 'too many reports' }, 429);
    // Only players who exist (joined a match at least once) can be reported.
    if (!store.profileExists(body.code)) return c.json({ error: 'no such player' }, 404);
    store.addReport({
      reporter,
      targetCode: body.code,
      reason: body.reason,
      matchId: body.matchId,
      at: now(),
    });
    counters.reports.inc();
    return c.json({ ok: true }, 202);
  });

  /**
   * Anonymous session report, sent by the browser when the page closes (sendBeacon, so the
   * body arrives as text/plain): did the session hit an uncaught error, median ping, region.
   * No ids of any kind: only counts for the dashboard.
   */
  const sessionLimit = new RateLimiter(20, 1 / 60);
  const SessionSchema = z.object({
    crashed: z.boolean(),
    pingMs: z.number().int().min(0).max(5000).nullable(),
    region: z.string().regex(/^[a-z0-9-]{1,24}$/),
  });
  app.post('/telemetry/session', bodyLimit({ maxSize: 1024 }), async (c) => {
    if (!sessionLimit.take(ipOf(c))) return c.body(null, 429);
    let parsed;
    try {
      parsed = SessionSchema.parse(JSON.parse(await c.req.text()));
    } catch {
      return c.body(null, 400);
    }
    store.addSession({ ...parsed, at: now() });
    return c.body(null, 204);
  });

  const feedbackLimit = new RateLimiter(3, 1 / 300);
  const feedbackIpLimit = new RateLimiter(10, 1 / 360);
  const FeedbackSchema = z.object({
    token: z.string().max(200),
    kind: z.enum(['bug', 'idea', 'other']),
    text: z.string().trim().min(3).max(1000),
    // What the game was doing (helps with bug reports); nothing personal.
    context: z
      .object({
        build: z.string().max(40).optional(),
        renderer: z.string().max(20).optional(),
        screen: z.string().max(20).optional(),
        mode: z.string().max(40).optional(),
        userAgent: z.string().max(300).optional(),
      })
      .strict()
      .default({}),
  });
  app.post('/feedback', bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const parsed = FeedbackSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad feedback' }, 400);
    const guest = verifyGuestToken(parsed.data.token, secret);
    if (!guest) return c.json({ error: 'bad token' }, 401);
    if (!feedbackLimit.take(guest) || !feedbackIpLimit.take(ipOf(c)))
      return c.json({ error: 'too much feedback' }, 429);
    store.addFeedback({
      code: publicCode(secret, guest),
      kind: parsed.data.kind,
      text: parsed.data.text,
      context: parsed.data.context,
      at: now(),
    });
    return c.json({ ok: true }, 202);
  });

  mountAdmin(app, store, opts.adminPassword, (guestId) => publicCode(secret, guestId), ipOf, now);

  /**
   * Game server → API: the humans in one room right now (every 20 s and on changes). Signed.
   * Guest ids become public codes here; the game server never needs the API's code secret.
   */
  const presence = new Presence();
  const PresenceSchema = z.object({
    region: z.string().regex(/^[a-z0-9-]{1,24}$/),
    roomId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    mode: z.string().max(40),
    map: z.string().max(40),
    private: z.boolean(),
    players: z
      .array(
        z.object({
          guestId: z.string().regex(GUEST_ID),
          inviteToken: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
          allowJoin: z.boolean(),
        }),
      )
      .max(12),
  });
  app.post('/presence', bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
    const body = await c.req.text();
    const signed = verifyService(
      secret,
      'presence',
      body,
      c.req.header('x-sentinel-time'),
      c.req.header('x-sentinel-signature'),
      now(),
    );
    if (!signed) {
      counters.rejected.inc();
      if (!readLimit.take(ipOf(c))) return c.json({ error: 'too many requests' }, 429);
      return c.json({ error: 'bad signature' }, 401);
    }
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return c.json({ error: 'bad presence' }, 400);
    }
    const parsed = PresenceSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: 'bad presence' }, 400);
    const r = parsed.data;
    presence.report(
      {
        ...r,
        players: r.players.map((p) => ({
          code: publicCode(secret, p.guestId),
          inviteToken: p.inviteToken,
          allowJoin: p.allowJoin,
        })),
      },
      now(),
    );
    return c.body(null, 204);
  });

  /**
   * Where a player is playing, for anyone who has their code (the owner's choice: a code is
   * what you give friends; it's 64 random bits, so it can't be guessed). Needs a guest token
   * (rate limits per player). Join details only if the player allows friends to join.
   */
  const presenceLimit = new RateLimiter(60, 1);
  app.get('/players/:code/presence', (c) => {
    const code = c.req.param('code');
    if (!/^[0-9a-f]{16}$/.test(code)) return c.json({ error: 'bad code' }, 400);
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer /, '');
    const viewer = verifyGuestToken(token, secret);
    if (!viewer) return c.json({ error: 'bad token' }, 401);
    if (!presenceLimit.take(viewer)) return c.json({ error: 'too many requests' }, 429);
    const e = presence.get(code, now());
    if (!e) return c.json({ status: 'offline' });
    return c.json({
      status: 'in-match',
      region: e.region,
      mode: e.mode,
      map: e.map,
      private: e.private,
      humans: e.humans,
      join: e.inviteToken ? { roomId: e.roomId, invite: e.inviteToken } : null,
    });
  });

  /** Friends: a player's public card by code (name, level, last played). */
  app.get('/players/:code', (c) => {
    if (!readLimit.take(ipOf(c))) {
      counters.rateLimited.inc();
      return c.json({ error: 'too many requests' }, 429);
    }
    const code = c.req.param('code');
    if (!/^[0-9a-f]{16}$/.test(code)) return c.json({ error: 'bad code' }, 400);
    const row = store.byCode(code);
    if (!row) return c.json({ error: 'not found' }, 404);
    // Last played rounded to the day: friends see "played today", not a minute-by-minute log.
    const day = 86_400_000;
    return c.json({
      code,
      name: row.name,
      level: levelFor(row.xp).level,
      lastPlayed: Math.floor(row.updated_at / day) * day,
    });
  });

  /** Public profile: level, XP and totals (defaults for a new guest). */
  app.get('/profiles/:guestId', (c) => {
    if (!readLimit.take(ipOf(c))) {
      counters.rateLimited.inc();
      return c.json({ error: 'too many requests' }, 429);
    }
    const guestId = c.req.param('guestId');
    if (!GUEST_ID.test(guestId)) return c.json({ error: 'bad guest id' }, 400);
    const row = store.profile(guestId);
    const xp = row?.xp ?? 0;
    return c.json({
      guestId,
      name: row?.name ?? null,
      xp,
      ...levelFor(xp),
      matches: row?.matches ?? 0,
      wins: row?.wins ?? 0,
      kills: row?.kills ?? 0,
      deaths: row?.deaths ?? 0,
      weaponKills: store.weaponKills(guestId),
      unlockAll: opts.unlockAll === true,
      challenges: activeChallenges(now()).map((ch) => ({
        id: ch.id,
        text: ch.text,
        period: ch.period,
        target: ch.target,
        xp: ch.xp,
        progress: Math.min(ch.target, store.challengeProgress(guestId, ch)),
      })),
      lastMatch: store.lastMatch(guestId),
      code: publicCode(secret, guestId),
    });
  });

  return app;
}
