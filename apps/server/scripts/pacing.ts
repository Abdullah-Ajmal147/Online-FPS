/**
 * Pacing check: one full 10-minute bot match; prints kills per minute, how often bots stand
 * still, and where. Use it after changing bots or maps.
 *   pnpm --filter @sentinel/server exec tsx scripts/pacing.ts
 */
import { defaultLoadout, maps, modes, movement } from '@sentinel/content';
import { initPhysics } from '@sentinel/shared';
import { DIFFICULTIES } from '../src/bots/brain.ts';
import { BotController } from '../src/bots/controller.ts';
import { Match } from '../src/match.ts';
import { TeamDeathmatch } from '../src/mode.ts';
import { MatchSim } from '../src/sim.ts';
const rapier = await initPhysics();
const map = maps['relay-yard']!;
const sim = new MatchSim(rapier, map, movement, defaultLoadout, 7);
const bots = new BotController(sim, map, DIFFICULTIES.normal);
bots.fill();
const match = new Match(
  sim,
  new TeamDeathmatch(modes['team-deathmatch']!),
  { warmupSeconds: 1, countdownSeconds: 1, liveSeconds: 600, resultsSeconds: 1 },
  'relay-yard',
);
const last = new Map<number, readonly [number, number, number]>();
let still = 0,
  samples = 0,
  prevKills = 0;
const stuckSpots = new Map<string, number>();
for (let t = 0; t < 60 * 602; t++) {
  bots.think();
  sim.step();
  match.update();
  if (t % 60 === 0 && t > 300)
    for (const p of sim.players.values()) {
      const prev = last.get(p.id);
      const cur = p.sim.move.position;
      if (prev && p.alive) {
        samples++;
        if (Math.hypot(cur[0] - prev[0], cur[2] - prev[2]) < 0.5) {
          still++;
          const k = `${Math.round(cur[0])},${Math.round(cur[1])},${Math.round(cur[2])}`;
          stuckSpots.set(k, (stuckSpots.get(k) ?? 0) + 1);
        }
      }
      last.set(p.id, cur);
    }
  if (t % 3600 === 3599) {
    const kills = [...sim.players.values()].reduce((n, p) => n + p.kills, 0);
    console.log(
      `min ${(t + 1) / 3600}: kills this minute ${kills - prevKills}, still ${((100 * still) / Math.max(1, samples)).toFixed(0)}%, phase ${match.phase}`,
    );
    prevKills = kills;
    still = 0;
    samples = 0;
  }
}
console.log(
  'top still spots (x,y,z: seconds):',
  [...stuckSpots.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k, v]) => `${k}:${v}`)
    .join('  '),
);
