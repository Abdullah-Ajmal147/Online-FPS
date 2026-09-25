import type { Mode } from '@sentinel/content';
import { DRAW } from '@sentinel/protocol';

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
