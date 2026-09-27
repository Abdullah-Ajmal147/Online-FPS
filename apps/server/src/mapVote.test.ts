import { describe, expect, it } from 'vitest';
import { MapVote } from './mapVote.ts';

const OPTIONS = ['relay-yard', 'saltline-depot', 'alder-street'];

describe('MapVote', () => {
  it('the most votes wins', () => {
    const v = new MapVote(OPTIONS, 'saltline-depot');
    v.vote(1, 2);
    v.vote(2, 2);
    v.vote(3, 0);
    expect(v.counts()).toEqual([1, 0, 2]);
    expect(v.winner()).toBe('alder-street');
  });

  it('no votes, or a tie, keeps the normal rotation (the default next map wins ties)', () => {
    expect(new MapVote(OPTIONS, 'saltline-depot').winner()).toBe('saltline-depot');
    const tie = new MapVote(OPTIONS, 'saltline-depot');
    tie.vote(1, 0);
    tie.vote(2, 1);
    expect(tie.winner()).toBe('saltline-depot');
    const tieWithout = new MapVote(OPTIONS, 'saltline-depot');
    tieWithout.vote(1, 2);
    tieWithout.vote(2, 0);
    expect(tieWithout.winner()).toBe('relay-yard'); // first of the leaders, in rotation order
  });

  it('one vote per player (changing it moves it), leavers are removed, bad options ignored', () => {
    const v = new MapVote(OPTIONS, 'relay-yard');
    v.vote(1, 0);
    v.vote(1, 1);
    expect(v.counts()).toEqual([0, 1, 0]);
    expect(v.vote(2, 3)).toBe(false);
    expect(v.vote(2, -1)).toBe(false);
    expect(v.vote(2, 0.5)).toBe(false);
    v.remove(1);
    expect(v.counts()).toEqual([0, 0, 0]);
  });
});
