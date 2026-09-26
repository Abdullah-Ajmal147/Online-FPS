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
});

describe('chat limits', () => {
  it('protocol and content agree on the longest chat line', () => {
    expect(CHAT_MAX_CHARS).toBe(CHAT_MAX_LENGTH);
  });
});
