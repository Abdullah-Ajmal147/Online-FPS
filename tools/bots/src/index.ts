import { writeFileSync } from 'node:fs';
import { Client, type Room } from '@colyseus/sdk';
import { defaultLoadout, maps, movement } from '@sentinel/content';
import {
  MessageType,
  PROTOCOL_VERSION,
  decodePing,
  decodeSnapshot,
  encodeInputCmd,
  encodePing,
} from '@sentinel/protocol';
import {
  Predictor,
  TARGET_QUEUE_DEPTH,
  TICK_DT,
  buildWorld,
  createMovementContext,
  createPlayerBody,
  createPlayerState,
  createSimContext,
  createWeaponState,
  expandMap,
  initPhysics,
  inputPacing,
  type PlayerInput,
} from '@sentinel/shared';
import { parseArgs } from './args.ts';
import { WanderBrain } from './brain.ts';

/**
 * Headless bot clients. They join like a browser, send inputs only (never positions) and run
 * the same client prediction + reconciliation as the browser, so a room full of bots also
 * measures the netcode: `--duration 60` prints the prediction-correction rate per bot.
 */
const args = parseArgs(process.argv.slice(2));
const options = { protocolVersion: PROTOCOL_VERSION };
const rapier = await initPhysics();
const solids = expandMap(maps.greybox!);

interface Bot {
  name: string;
  room: Room;
  brain: WanderBrain;
  predictor: Predictor;
  spawned: boolean;
  lifeId: number;
  ack: number;
  queueDepth: number;
  accumulatorMs: number;
  rttMs: number[];
  recorded: PlayerInput[];
}

const bots: Bot[] = [];
for (let i = 0; i < args.count; i++) {
  const client = new Client(args.url);
  const room = args.room
    ? await client.joinById(args.room, options)
    : await client.joinOrCreate('match', options);
  const ctx = createMovementContext(rapier, buildWorld(rapier, solids), movement);
  const simCtx = createSimContext(ctx, defaultLoadout);
  const bot: Bot = {
    name: `bot ${i + 1}`,
    room,
    brain: new WanderBrain(1000 + i),
    predictor: new Predictor(
      { move: createPlayerState([0, 0, 0], 0), weapon: createWeaponState(simCtx.loadout) },
      simCtx,
      createPlayerBody(ctx),
    ),
    lifeId: -1,
    spawned: false,
    ack: 0,
    queueDepth: TARGET_QUEUE_DEPTH,
    accumulatorMs: 0,
    rttMs: [],
    recorded: [],
  };
  room.onMessage(MessageType.Snapshot, (bytes: Uint8Array) => {
    const snap = decodeSnapshot(bytes);
    if (snap.serverTick <= bot.ack) return;
    bot.ack = snap.serverTick;
    bot.queueDepth += (snap.inputQueueDepth - bot.queueDepth) * 0.1;
    if (!snap.own) return;
    const own = snap.own;
    if (!bot.spawned || own.lifeId !== bot.lifeId) {
      // Joined or respawned: predict from the server's state.
      bot.spawned = true;
      bot.lifeId = own.lifeId;
      bot.predictor.reset({ move: { ...own.sim.move, yaw: 0, pitch: 0 }, weapon: own.sim.weapon });
    } else if (own.respawnTicks === 0) {
      bot.predictor.onServerState(own.sim, snap.lastProcessedSeq);
    }
  });
  room.onMessage(MessageType.Pong, (bytes: Uint8Array) => {
    bot.rttMs.push(((Math.floor(performance.now()) >>> 0) - decodePing(bytes)) >>> 0);
  });
  room.onMessage('*', () => {}); // Hello
  bots.push(bot);
  console.log(`[${bot.name}] joined room ${room.roomId} as ${room.sessionId}`);
}

// Fixed 60 Hz loop per bot with an accumulator (timers drift), paced like the browser client.
let last = performance.now();
const loop = setInterval(() => {
  const now = performance.now();
  const elapsed = Math.min(now - last, 250);
  last = now;
  for (const bot of bots) {
    if (!bot.spawned) continue;
    bot.accumulatorMs += elapsed * inputPacing(bot.queueDepth);
    while (bot.accumulatorMs >= TICK_DT * 1000) {
      bot.accumulatorMs -= TICK_DT * 1000;
      const input = bot.brain.next();
      if (args.record && bot === bots[0]) bot.recorded.push(input);
      bot.predictor.tick({ ...input, weaponSlot: 0, viewTick: bot.ack });
      bot.room.sendBytes(
        MessageType.InputCmd,
        encodeInputCmd({ ackServerTick: bot.ack, inputs: bot.predictor.recentInputs() }),
      );
    }
  }
}, 4);

const pinger = setInterval(() => {
  for (const bot of bots) bot.room.sendBytes(MessageType.Ping, encodePing(performance.now()));
}, 1000);

console.log(`[bots] ${args.count} bot(s) wandering. Ctrl+C to stop.`);

if (args.duration) {
  setTimeout(() => {
    clearInterval(loop);
    clearInterval(pinger);
    let snaps = 0;
    let corrections = 0;
    const rows = bots.map((b) => {
      const s = b.predictor.stats;
      snaps += s.snapshots;
      corrections += s.corrections;
      const rtt = b.rttMs.length ? b.rttMs.reduce((x, y) => x + y, 0) / b.rttMs.length : NaN;
      return `${b.name}: ${s.corrections}/${s.snapshots} corrections (${((100 * s.corrections) / Math.max(1, s.snapshots)).toFixed(2)}%), rtt ${rtt.toFixed(0)} ms`;
    });
    console.log(rows.join('\n'));
    const pct = (100 * corrections) / Math.max(1, snaps);
    console.log(`[bots] SUMMARY corrections ${pct.toFixed(2)}% of ${snaps} snapshots`);
    if (args.record) {
      writeFileSync(args.record, JSON.stringify({ inputs: bots[0]!.recorded }) + '\n');
      console.log(`[bots] recorded ${bots[0]!.recorded.length} inputs to ${args.record}`);
    }
    for (const b of bots) void b.room.leave();
    setTimeout(() => process.exit(0), 500);
  }, args.duration * 1000);
}
