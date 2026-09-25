import { ModeSchema, type Mode } from './schemas.ts';
import teamDeathmatchJson from './modes/team-deathmatch.json' with { type: 'json' };

export { ModeSchema, type Mode } from './schemas.ts';

/** All content is validated at load time; a bad file fails fast on both client and server. */
export const modes: Record<string, Mode> = {
  'team-deathmatch': ModeSchema.parse(teamDeathmatchJson),
};
