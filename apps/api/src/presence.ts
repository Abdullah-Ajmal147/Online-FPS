/**
 * Who is in which match right now (friends' Join button). Game servers report each room's
 * human players (signed); entries expire when a room stops reporting. In memory on purpose:
 * it's live state, rebuilt within one heartbeat after an API restart.
 */
export interface RoomReport {
  region: string;
  roomId: string;
  mode: string;
  map: string;
  private: boolean;
  players: { code: string; inviteToken: string; allowJoin: boolean }[];
}

export interface PresenceEntry {
  region: string;
  roomId: string;
  mode: string;
  map: string;
  private: boolean;
  humans: number;
  /** Null when the player turned off "Let friends join me". */
  inviteToken: string | null;
  at: number;
}

/** Game servers report every 20 s; two missed reports and the player counts as gone. */
export const PRESENCE_TTL_MS = 50_000;

export class Presence {
  private byCode = new Map<string, PresenceEntry>();
  /** Codes last reported per room, to clear players who left. */
  private rooms = new Map<string, Set<string>>();

  report(r: RoomReport, now: number): void {
    const key = `${r.region}/${r.roomId}`;
    const before = this.rooms.get(key) ?? new Set<string>();
    const nowCodes = new Set(r.players.map((p) => p.code));
    for (const code of before) {
      if (!nowCodes.has(code) && this.byCode.get(code)?.roomId === r.roomId)
        this.byCode.delete(code);
    }
    if (nowCodes.size === 0) this.rooms.delete(key);
    else this.rooms.set(key, nowCodes);
    for (const p of r.players) {
      this.byCode.set(p.code, {
        region: r.region,
        roomId: r.roomId,
        mode: r.mode,
        map: r.map,
        private: r.private,
        humans: r.players.length,
        inviteToken: p.allowJoin ? p.inviteToken : null,
        at: now,
      });
    }
    this.prune(now);
  }

  get(code: string, now: number): PresenceEntry | null {
    const e = this.byCode.get(code);
    if (!e) return null;
    if (now - e.at > PRESENCE_TTL_MS) {
      this.byCode.delete(code);
      return null;
    }
    return e;
  }

  private prune(now: number): void {
    // Cheap sweep; the map holds at most the players online.
    for (const [code, e] of this.byCode) if (now - e.at > PRESENCE_TTL_MS) this.byCode.delete(code);
  }
}
