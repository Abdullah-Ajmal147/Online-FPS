import type { Mode } from '@sentinel/content';
import { DRAW } from '@sentinel/protocol';
import { TICK_RATE, type Vec3 } from '@sentinel/shared';
import type { MatchSim } from './sim.ts';

/**
 * Game-mode rules, pluggable so Domination (Phase 5+) can be added without touching the match
 * loop. The match calls these; the mode keeps its own score.
 */
export interface GameMode {
  readonly def: Mode;
  reset(): void;
  /** A player died. `killerTeam` is null for suicides/falls. */
  onKill(killerTeam: number | null, victimTeam: number): void;
  teamScores(): [number, number];
  /** Winning team when a limit is reached during play, else null. */
  winnerByScore(): number | null;
  /** Winner when time runs out: the team ahead, or DRAW. */
  winnerAtTime(): number;
  /** Every live tick (objective modes: capture points). */
  tick?(sim: MatchSim): void;
  /** Every tick in every phase: follow the current map (points visible from warm-up on). */
  sync?(sim: MatchSim): void;
  /** Capture points for the HUD and bots (objective modes only). */
  points?(): CapturePoint[];
}

export interface CapturePoint {
  id: string;
  position: Vec3;
  /** 0 or 1 = held by that team; -1 = neutral. */
  owner: number;
  /** −1 (Ember side) … +1 (Aegis side): how far capture has gone. */
  control: number;
}

/** Team Deathmatch: each kill scores one point for the killer's team. */
export class TeamDeathmatch implements GameMode {
  private scores: [number, number] = [0, 0];

  constructor(readonly def: Mode) {}

  reset(): void {
    this.scores = [0, 0];
  }

  onKill(killerTeam: number | null, victimTeam: number): void {
    if (killerTeam === null || killerTeam === victimTeam) return; // no points for suicides
    this.scores[killerTeam as 0 | 1]++;
  }

  teamScores(): [number, number] {
    return [...this.scores];
  }

  winnerByScore(): number | null {
    if (this.scores[0] >= this.def.scoreLimit) return 0;
    if (this.scores[1] >= this.def.scoreLimit) return 1;
    return null;
  }

  winnerAtTime(): number {
    if (this.scores[0] === this.scores[1]) return DRAW;
    return this.scores[0] > this.scores[1] ? 0 : 1;
  }
}

/**
 * Domination (Phase 8): three capture points. A team alone on a point pushes its control
 * meter toward its side (neutralising an enemy point first); each held point scores every
 * second; kills score a little. Data: modes/domination.json and each map's `points`.
 */
export class Domination implements GameMode {
  private scores: [number, number] = [0, 0];
  private state: CapturePoint[] = [];
  private mapId = '';
  private ticks = 0;

  constructor(readonly def: Mode) {}

  reset(): void {
    this.scores = [0, 0];
    this.state = [];
    this.mapId = '';
    this.ticks = 0;
  }

  onKill(killerTeam: number | null, victimTeam: number): void {
    if (killerTeam === null || killerTeam === victimTeam) return;
    this.scores[killerTeam as 0 | 1] += this.def.capture?.scorePerKill ?? 0;
  }

  sync(sim: MatchSim): void {
    const map = sim.currentMap;
    if (this.mapId !== map.id) {
      this.mapId = map.id;
      this.state = map.points.map((p) => ({
        id: p.id,
        position: p.position,
        owner: -1,
        control: 0,
      }));
    }
    sim.objectives = this.state;
  }

  tick(sim: MatchSim): void {
    const rules = this.def.capture;
    if (!rules) return;
    this.sync(sim);
    const perTick = 1 / (rules.seconds * TICK_RATE);
    for (const pt of this.state) {
      const on: [number, number] = [0, 0];
      for (const p of sim.players.values()) {
        if (!p.alive) continue;
        const [x, y, z] = p.sim.move.position;
        const [px, py, pz] = pt.position;
        if (Math.hypot(x - px, z - pz) <= rules.radius && Math.abs(y - py) <= rules.radius)
          on[p.team as 0 | 1]++;
      }
      // Alone on the point: move the meter (a second teammate speeds it up a little).
      const team = on[0] > 0 && on[1] === 0 ? 0 : on[1] > 0 && on[0] === 0 ? 1 : -1;
      if (team >= 0) {
        const speed = perTick * Math.min(1.5, 1 + 0.25 * (on[team as 0 | 1] - 1));
        pt.control = Math.max(-1, Math.min(1, pt.control + (team === 0 ? speed : -speed)));
      }
      if (pt.control >= 1) pt.owner = 0;
      else if (pt.control <= -1) pt.owner = 1;
      else if ((pt.owner === 0 && pt.control <= 0) || (pt.owner === 1 && pt.control >= 0))
        pt.owner = -1;
    }
    if (++this.ticks % TICK_RATE === 0) {
      for (const pt of this.state) {
        if (pt.owner >= 0) this.scores[pt.owner as 0 | 1] += rules.scorePerSecond;
      }
    }
    sim.objectives = this.state;
  }

  points(): CapturePoint[] {
    return this.state;
  }

  teamScores(): [number, number] {
    return [Math.floor(this.scores[0]), Math.floor(this.scores[1])];
  }

  winnerByScore(): number | null {
    if (this.scores[0] >= this.def.scoreLimit) return 0;
    if (this.scores[1] >= this.def.scoreLimit) return 1;
    return null;
  }

  winnerAtTime(): number {
    if (this.scores[0] === this.scores[1]) return DRAW;
    return this.scores[0] > this.scores[1] ? 0 : 1;
  }
}

/** The GameMode implementation for a mode id. */
export function createMode(def: Mode): GameMode {
  return def.capture ? new Domination(def) : new TeamDeathmatch(def);
}
