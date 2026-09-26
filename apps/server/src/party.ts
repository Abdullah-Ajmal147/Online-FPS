/** A party can put its team at most this many humans ahead of the other team. */
export const MAX_PARTY_LEAD = 3;

/**
 * Joining through a friend's invite: their team, if it has room for another human and it
 * wouldn't get more than MAX_PARTY_LEAD humans ahead of the other team (a leaked link can't
 * stack one side). Otherwise undefined: normal team balancing decides.
 */
export function partyTeamFor(
  humans: readonly [number, number],
  hostTeam: number,
  perTeam: number,
): number | undefined {
  const mine = humans[hostTeam as 0 | 1];
  const theirs = humans[(1 - hostTeam) as 0 | 1];
  return mine < perTeam && mine - theirs < MAX_PARTY_LEAD ? hostTeam : undefined;
}
