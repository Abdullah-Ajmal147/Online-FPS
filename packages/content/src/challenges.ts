import challengesJson from './challenges.json' with { type: 'json' };
import { ChallengesSchema, type Challenge } from './schemas.ts';

export const challengeData = ChallengesSchema.parse(challengesJson);

const DAY_MS = 86_400_000;

export interface ActiveChallenge extends Challenge {
  period: 'daily' | 'weekly';
  /** Day number (UTC) or week number (weeks start Monday 00:00 UTC): progress resets with it. */
  periodId: number;
}

/**
 * Today's and this week's challenges: picked from the pools by the date, the same for everyone
 * and on every server (nothing to store). Consecutive periods rotate through the pool.
 */
export function activeChallenges(nowMs: number): ActiveChallenge[] {
  const day = Math.floor(nowMs / DAY_MS);
  const week = Math.floor((day + 3) / 7); // 1970-01-01 was a Thursday
  const pick = (pool: readonly Challenge[], count: number, n: number, period: 'daily' | 'weekly') =>
    Array.from({ length: count }, (_, i) => ({
      ...pool[(n * count + i) % pool.length]!,
      period,
      periodId: n,
    }));
  return [
    ...pick(challengeData.daily, challengeData.dailyCount, day, 'daily'),
    ...pick(challengeData.weekly, challengeData.weeklyCount, week, 'weekly'),
  ];
}

/** How much one match advances a challenge (server-reported stats only). */
export function challengeProgress(
  c: Challenge,
  m: {
    kills: number;
    headshots: number;
    fragKills: number;
    won: boolean;
    weaponKills: Readonly<Record<string, number>>;
  },
): number {
  switch (c.stat) {
    case 'kills':
      return c.weapon
        ? Object.hasOwn(m.weaponKills, c.weapon)
          ? m.weaponKills[c.weapon]!
          : 0
        : m.kills;
    case 'headshots':
      return m.headshots;
    case 'fragKills':
      return m.fragKills;
    case 'wins':
      return m.won ? 1 : 0;
    case 'matches':
      return 1;
  }
}
