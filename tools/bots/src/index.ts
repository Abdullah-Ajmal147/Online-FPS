import { Client, type Room } from '@colyseus/sdk';
import {
  MessageType,
  PROTOCOL_VERSION,
  encodeInputCmd,
  decodeSnapshot,
  type SequencedInput,
} from '@sentinel/protocol';
import { INPUT_REDUNDANCY, TICK_DT } from '@sentinel/shared';
import { parseArgs } from './args.ts';
import { WanderBrain } from './brain.ts';

/**
 * Headless bot clients: they join like a browser would and send inputs at 60 Hz.
 * They send inputs only (never positions), so the server treats them exactly like players.
 */
const args = parseArgs(process.argv.slice(2));
const options = { protocolVersion: PROTOCOL_VERSION };

interface Bot {
  room: Room;
  brain: WanderBrain;
  history: SequencedInput[];
  seq: number;
  ack: number;
}

const bots: Bot[] = [];
for (let i = 0; i < args.count; i++) {
  const client = new Client(args.url);
  const room = args.room
    ? await client.joinById(args.room, options)
    : await client.joinOrCreate('match', options);
  const bot: Bot = { room, brain: new WanderBrain(1000 + i), history: [], seq: 0, ack: 0 };
  room.onMessage(MessageType.Snapshot, (bytes: Uint8Array) => {
    bot.ack = Math.max(bot.ack, decodeSnapshot(bytes).serverTick);
  });
  room.onMessage('*', () => {}); // ignore Hello / Pong
  bots.push(bot);
  console.log(`[bot ${i + 1}] joined room ${room.roomId} as ${room.sessionId}`);
}

// Fixed 60 Hz input loop with an accumulator (timers drift).
let last = performance.now();
let acc = 0;
setInterval(() => {
  const now = performance.now();
  acc = Math.min(acc + (now - last), 250);
  last = now;
  while (acc >= TICK_DT * 1000) {
    acc -= TICK_DT * 1000;
    for (const bot of bots) {
      const input: SequencedInput = { ...bot.brain.next(), seq: ++bot.seq, weaponSlot: 0 };
      bot.history.push(input);
      if (bot.history.length > INPUT_REDUNDANCY) bot.history.shift();
      bot.room.sendBytes(
        MessageType.InputCmd,
        encodeInputCmd({ ackServerTick: bot.ack, inputs: bot.history }),
      );
    }
  }
}, 4);

console.log(`[bots] ${args.count} bot(s) wandering. Ctrl+C to stop.`);
