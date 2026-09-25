import {
  MapSchema,
  ModeSchema,
  MovementSchema,
  type GameMap,
  type Mode,
  type Movement,
} from './schemas.ts';
import teamDeathmatchJson from './modes/team-deathmatch.json' with { type: 'json' };
import greyboxJson from './maps/greybox.json' with { type: 'json' };
import movementJson from './movement.json' with { type: 'json' };

export * from './schemas.ts';

/** All content is validated at load time; a bad file fails fast on both client and server. */
export const modes: Record<string, Mode> = {
  'team-deathmatch': ModeSchema.parse(teamDeathmatchJson),
};

export const maps: Record<string, GameMap> = {
  greybox: MapSchema.parse(greyboxJson),
};

export const movement: Movement = MovementSchema.parse(movementJson);
