import { describe, expect, it } from 'vitest';
import { gainLabel, splitScore } from './scoreSplit.ts';

describe('Domination score split', () => {
  it('one kill worth 2 plus 32 node points (the live report: "1 kill but 34")', () => {
    expect(splitScore(34, 0, 2)).toEqual({ fromKills: 0, fromNodes: 34 });
    expect(splitScore(2, 1, 2)).toEqual({ fromKills: 2, fromNodes: 0 });
    expect(splitScore(35, 1, 2)).toEqual({ fromKills: 2, fromNodes: 33 });
  });

  it('never goes negative when a player with kills leaves', () => {
    expect(splitScore(2, 3, 2)).toEqual({ fromKills: 2, fromNodes: 0 });
  });

  it('labels why the score went up', () => {
    expect(gainLabel({ score: 0, kills: 0 }, { score: 2, kills: 1 }, 2)).toBe('+2 kill');
    expect(gainLabel({ score: 5, kills: 1 }, { score: 6, kills: 1 }, 2)).toBe('+1 node');
    expect(gainLabel({ score: 5, kills: 1 }, { score: 8, kills: 2 }, 2)).toBe('+3 kill + node');
    expect(gainLabel({ score: 5, kills: 1 }, { score: 5, kills: 1 }, 2)).toBeNull();
  });
});
