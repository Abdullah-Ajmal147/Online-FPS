import { describe, expect, it } from 'vitest';
import { flagsFor, median, newAimStats } from './anticheat.ts';

const line = (over: Partial<Parameters<typeof flagsFor>[0]> = {}) => ({
  kills: 10,
  deaths: 8,
  headshots: 2,
  level: 12,
  aim: newAimStats(),
  ...over,
});

describe('stat anomaly flags', () => {
  it('a normal good player trips nothing', () => {
    const aim = { ...newAimStats(), shots: 200, hits: 70, reactionsMs: [260, 310, 240, 400, 290] };
    expect(flagsFor(line({ kills: 22, deaths: 9, headshots: 6, aim }))).toEqual([]);
  });

  it('flags inhuman accuracy, headshot rate, reactions, snaps and a smurfing new account', () => {
    const aim = {
      ...newAimStats(),
      shots: 100,
      hits: 90,
      snapHits: 7,
      reactionsMs: [50, 66, 33, 83, 50, 66],
    };
    expect(flagsFor(line({ kills: 30, deaths: 2, headshots: 25, level: 1, aim }))).toEqual([
      'accuracy',
      'headshot-rate',
      'reaction-time',
      'snap-aim',
      'kd-vs-level',
    ]);
  });

  it('small samples never flag (one lucky match)', () => {
    const aim = { ...newAimStats(), shots: 5, hits: 5, reactionsMs: [40, 40] };
    expect(flagsFor(line({ kills: 3, deaths: 0, headshots: 3, level: 1, aim }))).toEqual([]);
  });

  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
