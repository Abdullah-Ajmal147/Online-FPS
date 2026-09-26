import progressionJson from './progression.json' with { type: 'json' };
import { ProgressionSchema, type Progression } from './schemas.ts';

/** XP rules, level curve and unlock tables (data: progression.json). */
export const progression: Progression = ProgressionSchema.parse(progressionJson);

export const MAX_LEVEL = progression.levels.max;

/** XP needed to go from `level` to `level + 1`. */
export function xpToNext(level: number): number {
  return progression.levels.first + progression.levels.step * (level - 1);
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

/** One player's result in a match, as the game server reports it. */
export interface MatchStats {
  team: number;
  kills: number;
  headshots: number;
}

/**
 * XP for a match, line by line (the results screen shows the lines; the API awards the sum).
 * `winner`: team index, or 2 for a draw.
 */
export function xpBreakdown(p: MatchStats, winner: number): { label: string; xp: number }[] {
  const x = progression.xp;
  const lines = [{ label: 'Match played', xp: x.participation }];
  if (p.kills > 0) lines.push({ label: `Kills × ${p.kills}`, xp: x.perKill * p.kills });
  if (p.headshots > 0)
    lines.push({ label: `Headshots × ${p.headshots}`, xp: x.perHeadshot * p.headshots });
  if (winner === p.team) lines.push({ label: 'Victory', xp: x.win });
  else if (winner === 2) lines.push({ label: 'Draw', xp: x.draw });
  return lines;
}

export function xpForMatch(p: MatchStats, winner: number): number {
  return xpBreakdown(p, winner).reduce((n, l) => n + l.xp, 0);
}

/** Weapon level from kills with it (1 = new). */
export function weaponLevelFor(kills: number): number {
  const table = progression.weaponLevels.killsForLevel;
  let level = 1;
  while (level < table.length && kills >= table[level]!) level++;
  return level;
}

export const MAX_WEAPON_LEVEL = progression.weaponLevels.killsForLevel.length;

/** What a player has unlocked: from their profile (the API), never from the client. */
export interface Access {
  level: number;
  /** Kills per weapon id. */
  weaponKills: Readonly<Record<string, number>>;
  /** Test/dev switch (API env SENTINEL_UNLOCK_ALL): everything available. */
  unlockAll?: boolean;
}

/** A brand-new player. */
export const NEW_PLAYER: Access = { level: 1, weaponKills: {} };

/** Account level a weapon or perk unlocks at (1 = from the start). */
export function unlockLevel(kind: 'weapons' | 'perks', id: string): number {
  const row = progression.accountUnlocks.find((u) => u[kind].includes(id));
  return row?.level ?? 1;
}

/** Weapon level an attachment unlocks at, on each weapon (1 = from the start). */
export function attachmentUnlockLevel(id: string): number {
  const row = progression.weaponLevels.attachmentUnlocks.find((u) => u.attachments.includes(id));
  return row?.level ?? 1;
}

export function hasWeapon(a: Access, id: string): boolean {
  return a.unlockAll === true || a.level >= unlockLevel('weapons', id);
}

export function hasPerk(a: Access, id: string): boolean {
  return a.unlockAll === true || a.level >= unlockLevel('perks', id);
}

export function hasAttachment(a: Access, weaponId: string, attachmentId: string): boolean {
  if (a.unlockAll) return true;
  const kills = Object.hasOwn(a.weaponKills, weaponId) ? a.weaponKills[weaponId]! : 0;
  return weaponLevelFor(kills) >= attachmentUnlockLevel(attachmentId);
}
