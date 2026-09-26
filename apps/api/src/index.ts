import { resolveApiSecret, resolveUnlockAll } from '@sentinel/auth';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createApp } from './app.ts';
import { Store } from './db.ts';
import { log } from './ops.ts';

if (resolveUnlockAll(process.env)) {
  log.warn('SENTINEL_UNLOCK_ALL=1: every player has everything unlocked (local play/tests only)');
}

const port = Number(process.env.PORT ?? 8787);
const secret = resolveApiSecret(process.env); // refuses to start in production without a real one
const store = new Store(process.env.SENTINEL_DB ?? 'data/sentinel.db');

// Behind a reverse proxy (TRUST_PROXY=1) the real client IP is the first X-Forwarded-For entry.
const trustProxy = process.env.TRUST_PROXY === '1';
// Match logs are deleted after 14 days even when no new matches arrive (privacy).
setInterval(() => store.pruneLogs(Date.now()), 3_600_000).unref();
store.pruneLogs(Date.now());

const app = createApp(store, secret, {
  // Only with SENTINEL_UNLOCK_ALL=1 (`pnpm dev` sets it so every weapon can be tried locally).
  unlockAll: resolveUnlockAll(process.env),
  adminPassword: process.env.SENTINEL_ADMIN_PASSWORD,
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
