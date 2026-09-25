import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { Store } from './db.ts';
import { levelFor, xpForMatch } from './xp.ts';

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
      z.object({
        guestId: z.string().regex(GUEST_ID).nullable(),
        name: z.string().max(32),
        team: z.number().int().min(0).max(1),
        bot: z.boolean(),
        kills: z.number().int().nonnegative(),
        deaths: z.number().int().nonnegative(),
      }),
    )
    .max(12),
});

/** HMAC-SHA256 of the raw body with the shared server secret, hex. */
export function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function validSignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(sign(body, secret), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** The API app, separate from the Node listener so tests can call it directly. */
export function createApp(store: Store, secret: string): Hono {
  const app = new Hono();
  app.use('*', cors());

  app.get('/healthz', (c) => c.json({ ok: true, service: 'api' }));

  /**
   * Game server → API: a finished match. Signed with the server secret (a browser can't forge
   * it), each match counted once (replays rejected), XP computed here from the server's result.
   */
  app.post('/matches', async (c) => {
    const body = await c.req.text();
    if (!validSignature(body, c.req.header('x-sentinel-signature'), secret)) {
      return c.json({ error: 'bad signature' }, 401);
    }
    let parsed;
    try {
      parsed = MatchResultSchema.parse(JSON.parse(body));
    } catch {
      return c.json({ error: 'bad match result' }, 400);
    }
    if (!store.recordMatch(parsed.matchId, parsed))
      return c.json({ error: 'match already recorded' }, 409);
    const awarded: { guestId: string; xp: number }[] = [];
    for (const p of parsed.players) {
      if (p.bot || !p.guestId) continue;
      const xp = xpForMatch(p, parsed.winner);
      store.addResult(p.guestId, p.name, {
        xp,
        win: parsed.winner === p.team,
        kills: p.kills,
        deaths: p.deaths,
      });
      awarded.push({ guestId: p.guestId, xp });
    }
    return c.json({ ok: true, awarded });
  });

  /** Public profile: level, XP and totals (defaults for a new guest). */
  app.get('/profiles/:guestId', (c) => {
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
    });
  });

  return app;
}
