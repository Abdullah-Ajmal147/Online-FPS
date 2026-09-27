/**
 * Map vote on the results screen: the players pick the next map from the room's rotation.
 * One vote per player (they may change it); bots don't vote. The most votes wins; a tie (or
 * no votes at all) goes to the map the rotation would have played next anyway.
 */
export class MapVote {
  private readonly votes = new Map<number, number>();

  constructor(
    /** Map ids on offer, in rotation order. */
    readonly options: readonly string[],
    /** The map the rotation would play next: the fallback and the tie-breaker. */
    private readonly defaultNext: string,
  ) {}

  /** Record a player's vote; false (ignored) for an option that doesn't exist. */
  vote(playerId: number, option: number): boolean {
    if (!Number.isInteger(option) || option < 0 || option >= this.options.length) return false;
    this.votes.set(playerId, option);
    return true;
  }

  /** A player left: their vote no longer counts. */
  remove(playerId: number): void {
    this.votes.delete(playerId);
  }

  counts(): number[] {
    const counts = this.options.map(() => 0);
    for (const option of this.votes.values()) counts[option]!++;
    return counts;
  }

  /** The next map: most votes; ties and no votes go to the rotation's next map. */
  winner(): string {
    const counts = this.counts();
    const top = Math.max(...counts);
    if (top === 0) return this.defaultNext;
    const leaders = this.options.filter((_, i) => counts[i] === top);
    return leaders.includes(this.defaultNext) ? this.defaultNext : leaders[0]!;
  }
}
