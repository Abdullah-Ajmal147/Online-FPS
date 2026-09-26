import { resolveApiSecret } from '@sentinel/auth';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './app.ts';
import { Store } from './db.ts';
import { log } from './ops.ts';

const port = Number(process.env.PORT ?? 8787);
const secret = resolveApiSecret(process.env); // refuses to start in production without a real one
const store = new Store(process.env.SENTINEL_DB ?? 'data/sentinel.db');

// Behind a reverse proxy (TRUST_PROXY=1) the real client IP is the first X-Forwarded-For entry.
const trustProxy = process.env.TRUST_PROXY === '1';
const app = createApp(store, secret, {
  // Local play unlocks everything so every weapon can be tried; production never, unless set.
  unlockAll:
    process.env.SENTINEL_UNLOCK_ALL === '1' ||
    (process.env.SENTINEL_UNLOCK_ALL === undefined && process.env.NODE_ENV !== 'production'),
  clientIp: (c) =>
    (trustProxy && c.req.header('x-forwarded-for')?.split(',')[0]?.trim()) ||
    getConnInfo(c).remote.address ||
    'unknown',
});

process.on('uncaughtException', (err) => {
  log.fatal('uncaught exception', { err });
  process.exit(1);
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  log.info('listening', { port: info.port });
});

// Deploys send SIGTERM: finish in-flight requests, then exit.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
