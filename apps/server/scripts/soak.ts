/**
 * Soak test (Phase 3 exit test, local version): run N full bot-filled matches back to back as
 * fast as the CPU allows, and report tick times and any crash.
 *   pnpm --filter @sentinel/server exec tsx scripts/soak.ts [matches=10] [map=relay-yard]
 */
import { defaultLoadout, maps, modes, movement } from '@sentinel/content';
import { TICK_RATE, initPhysics } from '@sentinel/shared';
import { DIFFICULTIES } from '../src/bots/brain.ts';
import { BotController } from '../src/bots/controller.ts';
import { Match, type MatchSummary } from '../src/match.ts';
import { TeamDeathmatch } from '../src/mode.ts';
import { MatchSim } from '../src/sim.ts';

const matches = Number(process.argv[2] ?? 10);
const mapId = process.argv[3] ?? 'relay-yard';
const rapier = await initPhysics();
const map = maps[mapId]!;
const tdm = modes['team-deathmatch']!;
const sim = new MatchSim(rapier, map, movement, defaultLoadout, 1234);
const bots = new BotController(sim, map, DIFFICULTIES.normal);
bots.fill();
const match = new Match(
  sim,
  new TeamDeathmatch(tdm),
  { warmupSeconds: 2, countdownSeconds: 2, liveSeconds: tdm.timeLimitSeconds, resultsSeconds: 2 },
  mapId,
);
const summaries: MatchSummary[] = [];
match.onMatchEnd = (s) => summaries.push(s);

const tickMicros: number[] = [];
const started = performance.now();
while (summaries.length < matches) {
  const t = performance.now();
  bots.think();
  sim.step();
  match.update();
  tickMicros.push((performance.now() - t) * 1000);
  if (sim.tick % (TICK_RATE * 60) === 0) {
    process.stdout.write(
      `\r  simulated ${Math.round(sim.tick / TICK_RATE / 60)} min, ${summaries.length}/${matches} matches done`,
    );
  }
}
tickMicros.sort((a, b) => a - b);
const pct = (p: number) => (tickMicros[Math.floor((tickMicros.length - 1) * p)]! / 1000).toFixed(3);
console.log(
  `\n${matches} matches on ${mapId} in ${((performance.now() - started) / 1000).toFixed(0)} s wall time`,
);
for (const [i, s] of summaries.entries()) {
  const kills = s.players.reduce((n, p) => n + p.kills, 0);
  console.log(
    `  match ${i + 1}: ${s.teamScores[0]}–${s.teamScores[1]} winner ${s.winner === 2 ? 'draw' : `team ${s.winner}`}, ${s.durationSeconds} s, ${kills} kills`,
  );
}
console.log(
  `tick ms: median ${pct(0.5)}, p99 ${pct(0.99)}, max ${pct(1)} (budget 4 ms, 12 players)`,
);
