/** Progression rules (Phase 4 lite). XP comes only from server-reported match results. */
export const XP = {
  participation: 150,
  perKill: 100,
  win: 250,
  draw: 100,
} as const;

export const MAX_LEVEL = 50;

/** XP needed to go from `level` to `level + 1`: 500, 750, 1000, … */
export function xpToNext(level: number): number {
  return 500 + 250 * (level - 1);
}

export function levelFor(totalXp: number): {
  level: number;
  xpIntoLevel: number;
  xpForNext: number;
} {
  let level = 1;
  let rest = Math.max(0, Math.floor(totalXp));
  while (level < MAX_LEVEL && rest >= xpToNext(level)) {
    rest -= xpToNext(level);
    level++;
  }
  return { level, xpIntoLevel: rest, xpForNext: level < MAX_LEVEL ? xpToNext(level) : 0 };
}

export function xpForMatch(p: { kills: number; team: number }, winner: number): number {
  const result = winner === p.team ? XP.win : winner === 2 ? XP.draw : 0;
  return XP.participation + XP.perKill * p.kills + result;
}
