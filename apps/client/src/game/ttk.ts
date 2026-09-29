import type { Weapon } from '@sentinel/content';
import { MAX_HEALTH, damageAt } from '@sentinel/shared';

export interface TtkRow {
  /** Metres. */
  range: number;
  /** Shots to kill, all to the body (every pellet landing, for shotguns). */
  bodyShots: number;
  bodyMs: number;
  /** Same, all to the head. */
  headShots: number;
  headMs: number;
}

/**
 * Time to kill from the weapon's data, as the server works it out: damage after range
 * falloff per shot (pellets add up), shots until full health is gone, and the time between
 * the first and the last shot at the weapon's fire rate. No regen, armor or perks.
 */
export function ttk(weapon: Weapon, range: number): TtkRow {
  const shots = (base: number) => {
    const perShot = damageAt(base, range, weapon.falloff) * weapon.pellets;
    return Math.ceil(MAX_HEALTH / perShot);
  };
  const ms = (n: number) => Math.round(((n - 1) * 60_000) / weapon.rpm);
  const bodyShots = shots(weapon.damage.torso);
  const headShots = shots(weapon.damage.head);
  return { range, bodyShots, bodyMs: ms(bodyShots), headShots, headMs: ms(headShots) };
}

/** Ranges the tuning panel lists. */
export const TTK_RANGES = [5, 15, 30, 50] as const;
