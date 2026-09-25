import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './app.ts';
import { Store } from './db.ts';

const port = Number(process.env.PORT ?? 8787);
const secret = process.env.SENTINEL_API_SECRET ?? 'dev-only-secret';
if (!process.env.SENTINEL_API_SECRET) {
  console.warn(
    '[api] SENTINEL_API_SECRET not set: using the dev secret (never do this in production)',
  );
}
const store = new Store(process.env.SENTINEL_DB ?? 'data/sentinel.db');

// Behind a reverse proxy (TRUST_PROXY=1) the real client IP is the first X-Forwarded-For entry.
const trustProxy = process.env.TRUST_PROXY === '1';
const app = createApp(store, secret, {
  clientIp: (c) =>
    (trustProxy && c.req.header('x-forwarded-for')?.split(',')[0]?.trim()) ||
    getConnInfo(c).remote.address ||
    'unknown',
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[api] Hono listening on http://localhost:${info.port}`);
});
