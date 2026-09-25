import {
  MapSchema,
  ModeSchema,
  MovementSchema,
  type GameMap,
  type Mode,
  type Movement,
  type Weapon,
  WeaponSchema,
} from './schemas.ts';
import teamDeathmatchJson from './modes/team-deathmatch.json' with { type: 'json' };
import arenaJson from './maps/arena.json' with { type: 'json' };
import greyboxJson from './maps/greybox.json' with { type: 'json' };
import movementJson from './movement.json' with { type: 'json' };
import kestrelJson from './weapons/kestrel-ar.json' with { type: 'json' };
import wrenJson from './weapons/wren-sp.json' with { type: 'json' };

export * from './schemas.ts';

/** All content is validated at load time; a bad file fails fast on both client and server. */
export const modes: Record<string, Mode> = {
  'team-deathmatch': ModeSchema.parse(teamDeathmatchJson),
};

export const maps: Record<string, GameMap> = {
  greybox: MapSchema.parse(greyboxJson),
  /** Open test arena with a clear line between spawns (netcode and hit-registration tests). */
  arena: MapSchema.parse(arenaJson),
};

export const movement: Movement = MovementSchema.parse(movementJson);

export const weapons: Record<string, Weapon> = {
  'kestrel-ar': WeaponSchema.parse(kestrelJson),
  'wren-sp': WeaponSchema.parse(wrenJson),
};

/** Phase 2 default loadout: [primary, secondary]. Loadouts become player choice in Phase 4. */
export const defaultLoadout: readonly [Weapon, Weapon] = [
  weapons['kestrel-ar']!,
  weapons['wren-sp']!,
];
