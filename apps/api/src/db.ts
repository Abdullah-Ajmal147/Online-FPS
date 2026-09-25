import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ProfileRow {
  guest_id: string;
  name: string;
  xp: number;
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
}

/**
 * Local SQLite store (Phase 4 lite). The real schema moves to Supabase Postgres in Phase 4
 * (profiles, matches, match_players, loadouts, progression); this keeps the same shape small.
 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        guest_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0,
        matches INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        kills INTEGER NOT NULL DEFAULT 0,
        deaths INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        summary TEXT NOT NULL
      );
    `);
  }

  /** Records a match once. Returns false if this match id was already recorded (replay). */
  recordMatch(matchId: string, summary: unknown): boolean {
    try {
      this.db
        .prepare('INSERT INTO matches (match_id, received_at, summary) VALUES (?, ?, ?)')
        .run(matchId, Date.now(), JSON.stringify(summary));
      return true;
    } catch {
      return false;
    }
  }

  addResult(
    guestId: string,
    name: string,
    r: { xp: number; win: boolean; kills: number; deaths: number },
  ): void {
    this.db
      .prepare(
        `INSERT INTO profiles (guest_id, name, xp, matches, wins, kills, deaths, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(guest_id) DO UPDATE SET
           name = excluded.name,
           xp = xp + excluded.xp,
           matches = matches + 1,
           wins = wins + excluded.wins,
           kills = kills + excluded.kills,
           deaths = deaths + excluded.deaths,
           updated_at = excluded.updated_at`,
      )
      .run(guestId, name, r.xp, r.win ? 1 : 0, r.kills, r.deaths, Date.now());
  }

  profile(guestId: string): ProfileRow | null {
    return (
      (this.db.prepare('SELECT * FROM profiles WHERE guest_id = ?').get(guestId) as
        ProfileRow | undefined) ?? null
    );
  }
}
