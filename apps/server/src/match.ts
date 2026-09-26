import { aimSummary, flagsFor } from './anticheat.ts';
import { randomUUID } from 'node:crypto';
import { MatchPhase, NO_WINNER, type MatchInfo, type MatchPhaseId } from '@sentinel/protocol';
import { TICK_RATE } from '@sentinel/shared';
import type { GameMode } from './mode.ts';
import type { MatchSim, SimPlayer } from './sim.ts';

export interface MatchTimings {
  warmupSeconds: number;
  countdownSeconds: number;
  /** Live phase length; the mode's time limit unless overridden (tests, SENTINEL_MATCH_SECONDS). */
  liveSeconds: number;
  resultsSeconds: number;
}

/** One match's summary (logged as JSON at the end, sent to the API in Phase 4). */
export interface MatchSummary {
  /** Unique per match: the API counts each id once. */
  matchId: string;
  mode: string;
  map: string;
  winner: number;
  teamScores: [number, number];
  durationSeconds: number;
  mvp: number;
  players: {
    id: number;
    /** Guest profile id (humans only; bots and unknown guests get null). */
    guestId: string | null;
    name: string;
    team: number;
    bot: boolean;
    kills: number;
    deaths: number;
    headshots: number;
    fragKills: number;
    /** Kills per weapon id (weapon levels). */
    weaponKills: Record<string, number>;
    level: number;
    /** Anti-cheat numbers and the anomaly flags they tripped (anticheat.ts). */
    aim: ReturnType<typeof aimSummary>;
    flags: string[];
    /** Time actually spent in the live match (the API requires a minimum for XP). */
    secondsPlayed: number;
  }[];
}

/**
 * The match loop (Phase 3): warm-up → countdown → live → ended (results) → next match.
 *   - warm-up: free play, kills don't count; starts once there are 2+ players
 *   - countdown: everyone respawned and frozen
 *   - live: kills score for the mode; ends at the score limit or when time runs out
 *   - ended: frozen, results on screen, then a new match starts
 */
export class Match {
  phase: MatchPhaseId = MatchPhase.Warmup;
  winner = NO_WINNER;
  mvp = 0;
  matchesPlayed = 0;
  private phaseEndsAt: number;
  private liveStartedAt = 0;
  /**
   * Called when the results screen closes, before the next warm-up: the room rotates the map
   * here. Returns the map id now in play.
   */
  onNextMatch: (() => string) | null = null;
  /** Set when a match ends; the room forwards it (log, API). */
  onMatchEnd: ((summary: MatchSummary) => void) | null = null;

  constructor(
    private readonly sim: MatchSim,
    private readonly mode: GameMode,
    private readonly timings: MatchTimings,
    private mapId: string,
  ) {
    this.phaseEndsAt = sim.tick + this.ticks(timings.warmupSeconds);
  }

  get secondsLeft(): number {
    return Math.max(0, (this.phaseEndsAt - this.sim.tick) / TICK_RATE);
  }

  /** Call after every sim step. Returns true when the phase changed (send MatchInfo now). */
  update(): boolean {
    // Score kills from this tick's events (only while live).
    if (this.phase === MatchPhase.Live) {
      for (const { event } of this.sim.events) {
        if (event.type !== 'kill') continue;
        const victim = this.sim.players.get(event.victim);
        const killer = event.killer === event.victim ? null : this.sim.players.get(event.killer);
        if (victim) this.mode.onKill(killer ? killer.team : null, victim.team);
      }
      const byScore = this.mode.winnerByScore();
      if (byScore !== null) return this.end(byScore);
    }

    if (this.sim.tick < this.phaseEndsAt) {
      // Warm-up waits for at least two players.
      if (this.phase === MatchPhase.Warmup && this.sim.players.size < 2) {
        this.phaseEndsAt = this.sim.tick + this.ticks(this.timings.warmupSeconds);
      }
      return false;
    }

    switch (this.phase) {
      case MatchPhase.Warmup:
        return this.enter(MatchPhase.Countdown);
      case MatchPhase.Countdown:
        return this.enter(MatchPhase.Live);
      case MatchPhase.Live:
        return this.end(this.mode.winnerAtTime());
      case MatchPhase.Ended:
        if (this.onNextMatch) this.mapId = this.onNextMatch();
        return this.enter(MatchPhase.Warmup);
    }
    return false;
  }

  info(): MatchInfo {
    const players = [...this.sim.players.values()].map((p) => ({
      id: p.id,
      team: p.team,
      bot: p.bot,
      kills: p.kills,
      deaths: p.deaths,
      name: p.name,
      code: p.code,
    }));
    return {
      phase: this.phase,
      secondsLeft: this.secondsLeft,
      scoreLimit: this.mode.def.scoreLimit,
      teamScores: this.mode.teamScores(),
      winner: this.winner,
      mvp: this.mvp,
      players,
    };
  }

  private enter(phase: MatchPhaseId): boolean {
    this.phase = phase;
    switch (phase) {
      case MatchPhase.Warmup:
        this.winner = NO_WINNER;
        this.mvp = 0;
        this.sim.frozen = false;
        this.phaseEndsAt = this.sim.tick + this.ticks(this.timings.warmupSeconds);
        break;
      case MatchPhase.Countdown:
        this.mode.reset();
        this.sim.resetStats();
        this.departed = [];
        this.sim.respawnAll();
        this.sim.frozen = true;
        this.phaseEndsAt = this.sim.tick + this.ticks(this.timings.countdownSeconds);
        break;
      case MatchPhase.Live:
        this.sim.frozen = false;
        this.liveStartedAt = this.sim.tick;
        this.phaseEndsAt = this.sim.tick + this.ticks(this.timings.liveSeconds);
        break;
      case MatchPhase.Ended:
        break;
    }
    return true;
  }

  private end(winner: number): boolean {
    this.winner = winner;
    this.mvp = this.pickMvp();
    this.sim.frozen = true;
    this.matchesPlayed++;
    this.phase = MatchPhase.Ended;
    this.phaseEndsAt = this.sim.tick + this.ticks(this.timings.resultsSeconds);
    this.onMatchEnd?.(this.summary());
    return true;
  }

  /** MVP: most kills, then fewest deaths, then lowest id. */
  private pickMvp(): number {
    let best = 0;
    let bestKey = [-1, Infinity];
    for (const p of this.sim.players.values()) {
      if (p.kills > bestKey[0]! || (p.kills === bestKey[0] && p.deaths < bestKey[1]!)) {
        best = p.id;
        bestKey = [p.kills, p.deaths];
      }
    }
    return best;
  }

  /** Humans who left during the live match keep their row (stats and time played). */
  private departed: MatchSummary['players'] = [];

  /** Call before removing a player from the sim. */
  playerLeaving(id: number): void {
    const p = this.sim.players.get(id);
    if (!p || p.bot || this.phase !== MatchPhase.Live) return;
    this.departed.push(this.row(p));
  }

  private row(p: SimPlayer): MatchSummary['players'][number] {
    const from = Math.max(p.joinedAtTick, this.liveStartedAt);
    return {
      id: p.id,
      guestId: p.bot ? null : p.guestId,
      name: p.name,
      team: p.team,
      bot: p.bot,
      kills: p.kills,
      deaths: p.deaths,
      headshots: p.headshots,
      fragKills: p.fragKills,
      weaponKills: Object.fromEntries(p.weaponKills),
      level: p.level,
      aim: aimSummary(p.aim),
      flags: p.bot ? [] : flagsFor(p),
      secondsPlayed: Math.max(0, Math.round((this.sim.tick - from) / TICK_RATE)),
    };
  }

  private summary(): MatchSummary {
    return {
      matchId: randomUUID(),
      mode: this.mode.def.id,
      map: this.mapId,
      winner: this.winner,
      teamScores: this.mode.teamScores(),
      durationSeconds: Math.round((this.sim.tick - this.liveStartedAt) / TICK_RATE),
      mvp: this.mvp,
      players: [...[...this.sim.players.values()].map((p) => this.row(p)), ...this.departed],
    };
  }

  private ticks(seconds: number): number {
    return Math.round(seconds * TICK_RATE);
  }
}
