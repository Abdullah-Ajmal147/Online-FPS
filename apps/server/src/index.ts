import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { PROTOCOL_VERSION } from '@sentinel/protocol';
import { MatchRoom } from './MatchRoom.ts';
import { createApiReporter } from './apiReporter.ts';

const port = Number(process.env.PORT ?? 2567);

const server = new Server({
  transport: new WebSocketTransport(),
  greet: false,
  express: (app) => {
    app.get('/healthz', (_req, res) => {
      res.json({ ok: true, service: 'server', protocolVersion: PROTOCOL_VERSION });
    });
  },
});

server.define('match', MatchRoom);

// Finished matches go to the API for XP (Phase 4 lite). Needs the same secret as the API.
const apiUrl = process.env.SENTINEL_API_URL ?? 'http://localhost:8787';
const report = createApiReporter({
  url: apiUrl,
  secret: process.env.SENTINEL_API_SECRET ?? 'dev-only-secret',
});
MatchRoom.onMatchEnd = (summary) => void report(summary);

await server.listen(port);
console.log(
  `[server] Colyseus listening on ws://localhost:${port} (protocol v${PROTOCOL_VERSION})`,
);
