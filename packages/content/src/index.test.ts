import { describe, expect, it } from 'vitest';
import { ModeSchema, modes } from './index.ts';

describe('content', () => {
  it('loads Team Deathmatch as 6v6', () => {
    const tdm = modes['team-deathmatch'];
    expect(tdm?.teams).toBe(2);
    expect(tdm?.playersPerTeam).toBe(6);
  });

  it('rejects invalid mode data', () => {
    expect(() => ModeSchema.parse({ id: 'Bad Id', name: '' })).toThrow();
  });
});
