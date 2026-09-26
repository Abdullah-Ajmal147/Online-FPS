/**
 * Load test (Phase 7 task 7): N bot-filled matches at once in one process, in real time
 * (60 Hz), encoding every snapshot for every player like the room does. Reports what one
 * match costs: CPU, memory and outgoing bandwidth, and whether the process keeps up.
 *   pnpm --filter @sentinel/server exec tsx scripts/load.ts [matches=50] [seconds=60]
 * (No sockets: this measures the game server's own work; WebSocket framing adds ~2%.)
 */
import { maps, modes, movement, defaultLoadout } from '@sentinel/content';
import { encodeSnapshot } from '@sentinel/protocol';
import { TICK_RATE, TICKS_PER_SNAPSHOT, initPhysics } from '@sentinel/shared';
import { DIFFICULTIES } from '../src/bots/brain.ts';
import { BotController, prewarmNav } from '../src/bots/controller.ts';
import { Match } from '../src/match.ts';
import { TeamDeathmatch } from '../src/mode.ts';
import { MatchSim } from '../src/sim.ts';

const count = Number(process.argv[2] ?? 50);
const seconds = Number(process.argv[3] ?? 60);
const rapier = await initPhysics();
const tdm = modes['team-deathmatch']!;
const mapIds = ['relay-yard', 'saltline-depot'];
for (const id of mapIds) prewarmNav(rapier, movement, maps[id]!);

const rssBefore = process.memoryUsage().rss;
const rooms = Array.from({ length: count }, (_, i) => {
  const map = maps[mapIds[i % mapIds.length]!]!;
  const sim = new MatchSim(rapier, map, movement, defaultLoadout, 1000 + i);
  const bots = new BotController(sim, map, DIFFICULTIES.normal);
  bots.fill();
  const match = new Match(
    sim,
    new TeamDeathmatch(tdm),
    { warmupSeconds: 1, countdownSeconds: 1, liveSeconds: 600, resultsSeconds: 5 },
    map.id,
  );
  return { sim, bots, match };
});
const rssPerMatch = (process.memoryUsage().rss - rssBefore) / count;

let bytes = 0;
let lateTicks = 0;
let worstFrameMs = 0;
const frameMs: number[] = [];
const cpu0 = process.cpuUsage();
const start = performance.now();
const total = seconds * TICK_RATE;
for (let tick = 0; tick < total; tick++) {
  // Real time: wait for this tick's slot (busy-wait the last ms for precision).
  const due = start + (tick * 1000) / TICK_RATE;
  const wait = due - performance.now();
  if (wait > 2) await new Promise((r) => setTimeout(r, wait - 1));
  while (performance.now() < due);
  const t0 = performance.now();
  for (const r of rooms) {
    r.bots.think();
    r.sim.step();
    r.match.update();
    if (r.sim.tick % TICKS_PER_SNAPSHOT === 0) {
      for (const p of r.sim.players.values())
        bytes += encodeSnapshot(r.sim.snapshotFor(p.id)).length;
    }
  }
  const ms = performance.now() - t0;
  frameMs.push(ms);
  worstFrameMs = Math.max(worstFrameMs, ms);
  if (ms > 1000 / TICK_RATE) lateTicks++;
}
const wall = (performance.now() - start) / 1000;
const cpu = process.cpuUsage(cpu0);
const cpuSeconds = (cpu.user + cpu.system) / 1e6;
frameMs.sort((a, b) => a - b);
const pct = (q: number) => frameMs[Math.floor(frameMs.length * q)]!.toFixed(2);
const kbPerMatch = bytes / count / wall / 1024;

console.log(`${count} matches × 12 players (bots), ${seconds} s real time on one core`);
console.log(
  `  CPU: ${((100 * cpuSeconds) / wall).toFixed(0)}% of one core in total, ` +
    `${((100 * cpuSeconds) / wall / count).toFixed(2)}% per match`,
);
console.log(
  `  frame (all matches, one tick): median ${pct(0.5)} ms, p99 ${pct(0.99)} ms, ` +
    `worst ${worstFrameMs.toFixed(1)} ms; over the 16.7 ms budget: ${lateTicks} of ${total}`,
);
console.log(
  `  memory: ~${(rssPerMatch / 1024 / 1024).toFixed(1)} MB per match ` +
    `(RSS now ${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB)`,
);
console.log(
  `  bandwidth out: ${kbPerMatch.toFixed(0)} KB/s per match ` +
    `(${((kbPerMatch * 8) / 1024).toFixed(2)} Mbit/s), ${(kbPerMatch / 12).toFixed(1)} KB/s per player`,
);
console.log(
  `  → one core holds about ${Math.floor(100 / ((100 * cpuSeconds) / wall / count))} matches`,
);
