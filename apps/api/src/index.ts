import { serve } from '@hono/node-server';
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

serve({ fetch: createApp(store, secret).fetch, port }, (info) => {
  console.log(`[api] Hono listening on http://localhost:${info.port}`);
});
