import { describe, expect, it } from 'vitest';
import { CHAT_MAX_LENGTH } from '@sentinel/content';
import { CHAT_MAX_CHARS } from '@sentinel/protocol';
import { MAX_PARTY_LEAD, partyTeamFor } from './party.ts';

describe('party team', () => {
  it('a party of three joins together', () => {
    expect(partyTeamFor([1, 0], 0, 6)).toBe(0);
    expect(partyTeamFor([2, 0], 0, 6)).toBe(0);
  });

  it('a leaked link can not stack a team: 4 against 1 is refused', () => {
    expect(MAX_PARTY_LEAD).toBe(3);
    expect(partyTeamFor([3, 0], 0, 6)).toBeUndefined();
    expect(partyTeamFor([4, 1], 0, 6)).toBeUndefined();
    expect(partyTeamFor([4, 2], 0, 6)).toBe(0); // still within the lead
  });

  it('never beyond a full team', () => {
    expect(partyTeamFor([6, 5], 0, 6)).toBeUndefined();
    expect(partyTeamFor([2, 5], 1, 6)).toBeUndefined();
  });

  it('"play against me" puts the friend on the other team, with the same fairness', () => {
    expect(partyTeamFor([1, 0], 0, 6, true)).toBe(1);
    expect(partyTeamFor([1, 1], 1, 6, true)).toBe(0);
    // Friends split 2 v 2, 3 v 3: every challenger lands opposite the host.
    expect(partyTeamFor([3, 2], 0, 6, true)).toBe(1);
    // Can't stack the other side either, or overfill it.
    expect(partyTeamFor([0, 3], 0, 6, true)).toBeUndefined();
    expect(partyTeamFor([5, 6], 0, 6, true)).toBeUndefined();
  });
});

describe('chat limits', () => {
  it('protocol and content agree on the longest chat line', () => {
    expect(CHAT_MAX_CHARS).toBe(CHAT_MAX_LENGTH);
  });
});
