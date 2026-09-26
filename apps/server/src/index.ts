import { existsSync } from 'node:fs';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { resolveApiSecret, resolveUnlockAll } from '@sentinel/auth';
import { PROTOCOL_VERSION } from '@sentinel/protocol';
import express from 'express';
import { MatchRoom } from './MatchRoom.ts';
import { createAccessFetcher } from './access.ts';
import { createApiReporter } from './apiReporter.ts';
import { log, metrics } from './ops.ts';

const port = Number(process.env.PORT ?? 2567);

// A crash we didn't expect leaves the process in an unknown state: log it and exit so the
// platform (Docker restart policy, Fly.io, systemd) starts a clean one.
process.on('uncaughtException', (err) => {
  log.fatal('uncaught exception', { err });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.fatal('unhandled promise rejection', { reason: String(reason) });
  process.exit(1);
});

const server = new Server({
  // 2 KB per message: the largest thing a client may send is a chat line (< 500 bytes).
  transport: new WebSocketTransport({ maxPayload: 2048 }),
  greet: false,
  express: (app) => {
    app.get('/healthz', (_req, res) => {
      res.json({ ok: true, service: 'server', protocolVersion: PROTOCOL_VERSION });
    });
    // Prometheus metrics: rooms, players, tick times, errors, matches.
    app.get('/metrics', (_req, res) => {
      res.type('text/plain; version=0.0.4').send(metrics.render());
    });
    // Production: serve the built client from this same port (one container = the whole game).
    const clientDir = process.env.SENTINEL_CLIENT_DIR;
    if (clientDir && existsSync(clientDir)) {
      // Vite's /assets/* names carry a content hash: cache them for a year (repeat visits load
      // instantly). index.html must never be cached, or players keep an old build after a
      // deploy and loop on the protocol/content-version reload.
      app.use(
        express.static(clientDir, {
          index: 'index.html',
          setHeaders: (res, path) => {
            res.setHeader(
              'Cache-Control',
              /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
            );
          },
        }),
      );
      log.info('serving client', { dir: clientDir });
    }
  },
});

server.define('match', MatchRoom);

// Finished matches go to the API for XP. Needs the same secret as the API.
const report = createApiReporter({
  url: process.env.SENTINEL_API_URL ?? 'http://localhost:8787',
  secret: resolveApiSecret(process.env),
  log,
});
MatchRoom.onMatchEnd = (summary) => report(summary);
// Unlocks (level, weapon kills) come from the API, signed with the same secret.
if (resolveUnlockAll(process.env)) {
  log.warn('SENTINEL_UNLOCK_ALL=1: everything unlocked for every player (local play/tests only)');
}
MatchRoom.fetchAccess = createAccessFetcher({
  allowUnlockAll: resolveUnlockAll(process.env),
  url: process.env.SENTINEL_API_URL ?? 'http://localhost:8787',
  secret: resolveApiSecret(process.env),
  log,
});

// Colyseus already handles SIGTERM/SIGINT: it stops matchmaking, disposes rooms and exits.
server.onShutdown(() => log.info('shutting down: closing rooms'));

await server.listen(port);
log.info('listening', { port, protocol: PROTOCOL_VERSION });
