import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { PROTOCOL_VERSION } from '@sentinel/protocol';
import { MatchRoom } from './MatchRoom.ts';

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

await server.listen(port);
console.log(
  `[server] Colyseus listening on ws://localhost:${port} (protocol v${PROTOCOL_VERSION})`,
);
