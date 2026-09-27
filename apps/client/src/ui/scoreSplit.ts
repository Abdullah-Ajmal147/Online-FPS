/**
 * Domination team scores mix two sources: kills (worth `perKill` each) and held nodes. The HUD
 * only gets the total, so the split is worked out from the team's kill count.
 */
export interface ScoreSplit {
  fromKills: number;
  fromNodes: number;
}

export function splitScore(score: number, teamKills: number, perKill: number): ScoreSplit {
  const fromKills = Math.min(score, teamKills * perKill);
  return { fromKills, fromNodes: Math.max(0, score - fromKills) };
}

/**
 * The popup shown by a team's score when it goes up, e.g. "+2 kill", "+1 node",
 * "+3 kill + node". Null when the score did not rise.
 */
export function gainLabel(
  prev: { score: number; kills: number },
  now: { score: number; kills: number },
  perKill: number,
): string | null {
  const gain = now.score - prev.score;
  if (gain <= 0) return null;
  const killPart = Math.min(gain, Math.max(0, now.kills - prev.kills) * perKill);
  const why = [killPart > 0 && 'kill', gain > killPart && 'node'].filter(Boolean).join(' + ');
  return `+${gain} ${why}`;
}
