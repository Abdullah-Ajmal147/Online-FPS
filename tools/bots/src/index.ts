import { writeFileSync } from 'node:fs';
import { MessageType, encodePing } from '@sentinel/protocol';
import { initPhysics } from '@sentinel/shared';
import { parseArgs } from './args.ts';
import { Bot } from './bot.ts';
import { AimBrain, StrafeBrain, WanderBrain } from './brains.ts';

/**
 * Headless bot clients. They join like a browser, send inputs only (never positions or hits)
 * and run the same prediction + interpolation as the browser, so bots also measure the netcode:
 *   pnpm bots -- --count 11 --duration 60          prediction-correction rate
 *   pnpm bots -- --mode duel --duration 60         Phase 2: % of on-target shots registered
 */
const args = parseArgs(process.argv.slice(2));
const rapier = await initPhysics();

const bots: Bot[] = [];
const aimers: AimBrain[] = [];
const count = args.mode === 'duel' ? 2 : args.count;
for (let i = 0; i < count; i++) {
  let brain;
  if (args.mode === 'duel') {
    brain = i === 0 ? new StrafeBrain(7) : new AimBrain();
    if (brain instanceof AimBrain) aimers.push(brain);
  } else {
    brain = new WanderBrain(1000 + i);
  }
  const bot = await Bot.join({
    name: `bot ${i + 1}`,
    url: args.url,
    ...(args.room ? { room: args.room } : {}),
    brain,
    rapier,
  });
  bots.push(bot);
  console.log(`[${bot.name}] joined room ${bot.room.roomId} as ${bot.room.sessionId}`);
}

let last = performance.now();
const loop = setInterval(() => {
  const now = performance.now();
  const elapsed = Math.min(now - last, 250);
  last = now;
  bots.forEach((bot, i) => bot.update(elapsed, !!args.record && i === 0));
}, 4);

const pinger = setInterval(() => {
  for (const bot of bots) bot.room.sendBytes(MessageType.Ping, encodePing(performance.now()));
}, 1000);

console.log(`[bots] ${count} bot(s) running (${args.mode}). Ctrl+C to stop.`);

if (args.duration) {
  setTimeout(() => {
    clearInterval(loop);
    clearInterval(pinger);
    let snaps = 0;
    let corrections = 0;
    for (const b of bots) {
      const s = b.predictor.stats;
      snaps += s.snapshots;
      corrections += s.corrections;
      const rtt = b.rttMs.length ? b.rttMs.reduce((x, y) => x + y, 0) / b.rttMs.length : NaN;
      console.log(
        `${b.name}: ${s.corrections}/${s.snapshots} corrections (${((100 * s.corrections) / Math.max(1, s.snapshots)).toFixed(2)}%), rtt ${rtt.toFixed(0)} ms`,
      );
    }
    console.log(
      `[bots] SUMMARY corrections ${((100 * corrections) / Math.max(1, snaps)).toFixed(2)}% of ${snaps} snapshots`,
    );
    for (const a of aimers) {
      const pct = (100 * a.stats.registered) / Math.max(1, a.stats.onTarget);
      console.log(
        `[bots] HITREG ${a.stats.registered}/${a.stats.onTarget} on-target shots registered (${pct.toFixed(1)}%)`,
      );
    }
    if (args.record) {
      writeFileSync(args.record, JSON.stringify({ inputs: bots[0]!.recorded }) + '\n');
      console.log(`[bots] recorded ${bots[0]!.recorded.length} inputs to ${args.record}`);
    }
    for (const b of bots) void b.room.leave();
    setTimeout(() => process.exit(0), 500);
  }, args.duration * 1000);
}
