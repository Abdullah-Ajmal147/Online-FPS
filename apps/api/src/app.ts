import { issueGuestToken, RateLimiter, verifyService } from '@sentinel/auth';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { Store } from './db.ts';
import { counters, metrics } from './ops.ts';
import { activeChallenges, challengeProgress, weapons } from '@sentinel/content';
import { levelFor, xpBreakdown } from './xp.ts';

const GUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the game server reports at the end of a match (never accepted from a browser). */
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
  /** Clock (tests pin it to a date to know which challenges are active). */
  now?: () => number;
}

/** The API app, separate from the Node listener so tests can call it directly. */
export function createApp(store: Store, secret: string, opts: AppOptions = {}): Hono {
  const app = new Hono();
  const now = opts.now ?? Date.now;
  app.use('*', cors());
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
    return c.json(issueGuestToken(secret));
  });

  app.get('/healthz', (c) => c.json({ ok: true, service: 'api' }));

  /**
   * Game server → API: a finished match. Signed with the server secret (a browser can't forge
   * it), each match counted once (replays rejected), XP computed here from the server's result.
   */
  app.post('/matches', async (c) => {
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
    try {
      parsed = MatchResultSchema.parse(JSON.parse(body));
    } catch {
      counters.rejected.inc();
      return c.json({ error: 'bad match result' }, 400);
    }
    if (!store.recordMatch(parsed.matchId, parsed)) {
      counters.rejected.inc();
      return c.json({ error: 'match already recorded' }, 409);
    }
    counters.matches.inc();
    const awarded: { guestId: string; xp: number }[] = [];
    const seen = new Set<string>();
    for (const p of parsed.players) {
      if (p.bot || !p.guestId || seen.has(p.guestId)) continue; // each guest once per match
      seen.add(p.guestId);
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
  app.get('/access/:guestId', (c) => {
    const guestId = c.req.param('guestId');
    if (!GUEST_ID.test(guestId)) return c.json({ error: 'bad guest id' }, 400);
    const signed = verifyService(
      secret,
      'access',
      guestId,
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
    const row = store.profile(guestId);
    return c.json({
      level: levelFor(row?.xp ?? 0).level,
      weaponKills: store.weaponKills(guestId),
      unlockAll: opts.unlockAll === true,
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
    });
  });

  return app;
}
