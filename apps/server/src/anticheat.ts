/**
 * Stat anomaly flags (Phase 7 task 3). Measured per player per match by the server (never
 * reported by a client), turned into flags at the end of the match and stored by the API for
 * review. A flag is a reason to look at the match log, not proof: good players trip some.
 * Every check needs a minimum sample so one lucky match doesn't flag anyone.
 */
export interface AimStats {
  /** Trigger pulls that fired (a shotgun blast counts once). */
  shots: number;
  /** Shots that damaged an enemy. */
  hits: number;
  /** Hits within 2 ticks of a view turn faster than SNAP_DEGREES in one tick. */
  snapHits: number;
  /** ms from an enemy coming into sight to the first hit on them, one per exposure. */
  reactionsMs: number[];
  /** Enemy id → tick they came into this player's line of sight (cleared on the first hit). */
  visibleSince: Map<number, number>;
  lastSnapTick: number;
}

export const newAimStats = (): AimStats => ({
  shots: 0,
  hits: 0,
  snapHits: 0,
  reactionsMs: [],
  visibleSince: new Map(),
  lastSnapTick: -Infinity,
});

/** A view turn this fast in one 1/60 s tick (3600°/s) is beyond a human flick. */
export const SNAP_DEGREES = 60;

export const THRESHOLDS = {
  accuracy: { min: 0.75, sample: 40 },
  headshotRate: { min: 0.65, sample: 10 },
  /** Median reaction faster than this is inhuman (visual reaction is ~200 ms + aim). */
  reactionMs: { max: 120, sample: 5 },
  snapHits: { min: 5 },
  /** Dominating far above your level: a fresh account that plays like a pro (smurf/cheat). */
  kdVsLevel: { kd: 6, minKills: 25, maxLevel: 3 },
} as const;

export interface MatchLine {
  kills: number;
  deaths: number;
  headshots: number;
  level: number;
  aim: AimStats;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function flagsFor(p: MatchLine): string[] {
  const t = THRESHOLDS;
  const flags: string[] = [];
  const a = p.aim;
  if (a.shots >= t.accuracy.sample && a.hits / a.shots >= t.accuracy.min) flags.push('accuracy');
  if (p.kills >= t.headshotRate.sample && p.headshots / p.kills >= t.headshotRate.min)
    flags.push('headshot-rate');
  if (a.reactionsMs.length >= t.reactionMs.sample && median(a.reactionsMs) < t.reactionMs.max)
    flags.push('reaction-time');
  if (a.snapHits >= t.snapHits.min) flags.push('snap-aim');
  const kd = p.kills / Math.max(1, p.deaths);
  if (p.kills >= t.kdVsLevel.minKills && kd >= t.kdVsLevel.kd && p.level <= t.kdVsLevel.maxLevel)
    flags.push('kd-vs-level');
  return flags;
}

/** The per-player numbers that go into the match result (for the admin page). */
export function aimSummary(a: AimStats) {
  return {
    shots: a.shots,
    hits: a.hits,
    snapHits: a.snapHits,
    reactionMedianMs: a.reactionsMs.length ? Math.round(median(a.reactionsMs)) : null,
    reactions: a.reactionsMs.length,
  };
}
