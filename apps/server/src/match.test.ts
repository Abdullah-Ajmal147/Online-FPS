import { beforeAll, describe, expect, it } from 'vitest';
import { defaultLoadout, maps, modes, movement } from '@sentinel/content';
import { DRAW, MatchPhase, NO_WINNER } from '@sentinel/protocol';
import { TICK_RATE, initPhysics, type Rapier } from '@sentinel/shared';
import { DIFFICULTIES } from './bots/brain.ts';
import { BotController } from './bots/controller.ts';
import { Match, type MatchSummary } from './match.ts';
import { TeamDeathmatch } from './mode.ts';
import { MatchSim } from './sim.ts';

let rapier: Rapier;
beforeAll(async () => {
  rapier = await initPhysics();
});

const tdmDef = modes['team-deathmatch']!;

describe('TeamDeathmatch', () => {
  it('scores a point per enemy kill, none for suicides or team kills', () => {
    const m = new TeamDeathmatch(tdmDef);
    m.onKill(0, 1);
    m.onKill(1, 0);
    m.onKill(0, 1);
    m.onKill(null, 0); // fell
    m.onKill(1, 1); // (no friendly fire, but just in case)
    expect(m.teamScores()).toEqual([2, 1]);
    expect(m.winnerAtTime()).toBe(0);
  });

  it('wins at the score limit; a tied clock is a draw', () => {
    const m = new TeamDeathmatch({ ...tdmDef, scoreLimit: 2 });
    expect(m.winnerAtTime()).toBe(DRAW);
    m.onKill(1, 0);
    m.onKill(1, 0);
    expect(m.winnerByScore()).toBe(1);
  });
});

describe('Match phases', () => {
  function setup(liveSeconds = 2) {
    const sim = new MatchSim(rapier, maps.arena!, movement, defaultLoadout, 3);
    sim.addPlayer({ name: 'A' });
    sim.addPlayer({ name: 'B' });
    const match = new Match(
      sim,
      new TeamDeathmatch(tdmDef),
      { warmupSeconds: 1, countdownSeconds: 1, liveSeconds, resultsSeconds: 1 },
      'arena',
    );
    const run = (seconds: number) => {
      for (let i = 0; i < seconds * TICK_RATE; i++) {
        sim.step();
        match.update();
      }
    };
    return { sim, match, run };
  }

  it('goes warm-up → countdown (frozen) → live → ended (frozen) → warm-up', () => {
    const { sim, match, run } = setup();
    expect(match.phase).toBe(MatchPhase.Warmup);
    run(1.05);
    expect(match.phase).toBe(MatchPhase.Countdown);
    expect(sim.frozen).toBe(true);
    run(1);
    expect(match.phase).toBe(MatchPhase.Live);
    expect(sim.frozen).toBe(false);
    run(2);
    expect(match.phase).toBe(MatchPhase.Ended);
    expect(match.winner).toBe(DRAW);
    expect(sim.frozen).toBe(true);
    run(1);
    expect(match.phase).toBe(MatchPhase.Warmup);
    expect(match.winner).toBe(NO_WINNER);
  });

  it('waits in warm-up while fewer than two players are present', () => {
    const sim = new MatchSim(rapier, maps.arena!, movement, defaultLoadout, 3);
    sim.addPlayer();
    const match = new Match(
      sim,
      new TeamDeathmatch(tdmDef),
      { warmupSeconds: 1, countdownSeconds: 1, liveSeconds: 5, resultsSeconds: 1 },
      'arena',
    );
    for (let i = 0; i < 5 * TICK_RATE; i++) {
      sim.step();
      match.update();
    }
    expect(match.phase).toBe(MatchPhase.Warmup);
  });

  it('reports the scoreboard with names in MatchInfo', () => {
    const { match } = setup();
    expect(match.info().players.map((p) => p.name)).toEqual(['A', 'B']);
  });
});

describe('a full bots-only match on Relay Yard', () => {
  it('bots navigate, fight and finish a match with a winner, MVP and summary; ticks stay in budget', () => {
    const map = maps['relay-yard']!;
    const sim = new MatchSim(rapier, map, movement, defaultLoadout, 11);
    const bots = new BotController(sim, map, DIFFICULTIES.normal);
    bots.fill();
    expect(sim.players.size).toBe(12);
    expect(sim.teamCounts()).toEqual([6, 6]);

    const match = new Match(
      sim,
      new TeamDeathmatch(tdmDef),
      { warmupSeconds: 1, countdownSeconds: 1, liveSeconds: 90, resultsSeconds: 1 },
      'relay-yard',
    );
    let summary: MatchSummary | null = null;
    match.onMatchEnd = (s) => (summary = s);
    const start = new Map([...sim.players.values()].map((p) => [p.id, p.sim.move.position]));
    let totalMicros = 0;
    let ticks = 0;
    for (let i = 0; i < 100 * TICK_RATE && !summary; i++) {
      bots.think();
      sim.step();
      match.update();
      totalMicros += sim.lastTickMicros;
      ticks++;
    }
    expect(summary).not.toBeNull();
    const s = summary!;
    const kills = s.players.reduce((n, p) => n + p.kills, 0);
    expect(kills).toBeGreaterThan(5); // they found each other and fought
    expect(s.teamScores[0] + s.teamScores[1]).toBe(kills);
    expect(s.mvp).toBeGreaterThan(0);
    // Bots actually moved around the map.
    const moved = [...sim.players.values()].filter((p) => {
      const a = start.get(p.id)!;
      const b = p.sim.move.position;
      return Math.hypot(b[0] - a[0], b[2] - a[2]) > 3;
    });
    expect(moved.length).toBeGreaterThan(6);
    expect(totalMicros / ticks / 1000).toBeLessThan(4); // Phase 3 budget: < 4 ms per tick
  }, 120_000);
});
