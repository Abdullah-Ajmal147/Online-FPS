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
      CREATE TABLE IF NOT EXISTS weapon_kills (
        guest_id TEXT NOT NULL,
        weapon_id TEXT NOT NULL,
        kills INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guest_id, weapon_id)
      );
      CREATE TABLE IF NOT EXISTS challenge_progress (
        guest_id TEXT NOT NULL,
        challenge_id TEXT NOT NULL,
        period_id INTEGER NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (guest_id, challenge_id, period_id)
      );
      CREATE TABLE IF NOT EXISTS last_match (
        guest_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
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
    r: {
      xp: number;
      win: boolean;
      kills: number;
      deaths: number;
      weaponKills?: Readonly<Record<string, number>>;
    },
  ): void {
    const addKills = this.db.prepare(
      `INSERT INTO weapon_kills (guest_id, weapon_id, kills) VALUES (?, ?, ?)
       ON CONFLICT(guest_id, weapon_id) DO UPDATE SET kills = kills + excluded.kills`,
    );
    for (const [weaponId, kills] of Object.entries(r.weaponKills ?? {})) {
      if (kills > 0) addKills.run(guestId, weaponId, kills);
    }
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

  /** Adds progress; true if this completed the challenge (only ever once per period). */
  addChallengeProgress(
    guestId: string,
    ch: { id: string; periodId: number; target: number },
    add: number,
  ): boolean {
    const before = this.challengeProgress(guestId, ch);
    if (before >= ch.target) return false;
    this.db
      .prepare(
        `INSERT INTO challenge_progress (guest_id, challenge_id, period_id, progress)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(guest_id, challenge_id, period_id)
         DO UPDATE SET progress = progress + excluded.progress`,
      )
      .run(guestId, ch.id, ch.periodId, add);
    return before + add >= ch.target;
  }

  challengeProgress(guestId: string, ch: { id: string; periodId: number }): number {
    const row = this.db
      .prepare(
        'SELECT progress FROM challenge_progress WHERE guest_id = ? AND challenge_id = ? AND period_id = ?',
      )
      .get(guestId, ch.id, ch.periodId) as { progress: number } | undefined;
    return row?.progress ?? 0;
  }

  /** The XP breakdown of a guest's last counted match (results screen). */
  setLastMatch(guestId: string, data: unknown): void {
    this.db
      .prepare(
        `INSERT INTO last_match (guest_id, data) VALUES (?, ?)
         ON CONFLICT(guest_id) DO UPDATE SET data = excluded.data`,
      )
      .run(guestId, JSON.stringify(data));
  }

  lastMatch(guestId: string): unknown {
    const row = this.db.prepare('SELECT data FROM last_match WHERE guest_id = ?').get(guestId) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as unknown) : null;
  }

  /** Kills per weapon id, all time. */
  weaponKills(guestId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT weapon_id, kills FROM weapon_kills WHERE guest_id = ?')
      .all(guestId) as { weapon_id: string; kills: number }[];
    return Object.fromEntries(rows.map((r) => [r.weapon_id, r.kills]));
  }

  profile(guestId: string): ProfileRow | null {
    return (
      (this.db.prepare('SELECT * FROM profiles WHERE guest_id = ?').get(guestId) as
        ProfileRow | undefined) ?? null
    );
  }
}
