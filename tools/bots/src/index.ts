import { Client } from '@colyseus/sdk';
import { PROTOCOL_VERSION } from '@sentinel/protocol';
import { parseArgs } from './args.ts';

/**
 * Headless bot clients. Phase 0: they only join and idle.
 * Movement and shooting come with Phases 1–3.
 */
const args = parseArgs(process.argv.slice(2));
const options = { protocolVersion: PROTOCOL_VERSION };

for (let i = 0; i < args.count; i++) {
  const client = new Client(args.url);
  const room = args.room
    ? await client.joinById(args.room, options)
    : await client.joinOrCreate('match', options);
  console.log(`[bot ${i + 1}] joined room ${room.roomId} as ${room.sessionId}`);
}
console.log(`[bots] ${args.count} bot(s) connected. Ctrl+C to stop.`);
