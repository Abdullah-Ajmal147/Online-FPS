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
      CREATE TABLE IF NOT EXISTS match_logs (
        match_id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS player_flags (
        guest_id TEXT NOT NULL,
        match_id TEXT NOT NULL,
        flags TEXT NOT NULL,
        aim TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (guest_id, match_id)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reporter TEXT NOT NULL,
        target_code TEXT NOT NULL,
        reason TEXT NOT NULL,
        match_id TEXT,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reports_target ON reports (target_code);
      CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL,
        summary TEXT NOT NULL
      );
    `);
    // Added later (Phase 6): the public player code. Existing databases get the column here,
    // inside one write transaction (two processes starting at once can't both add it).
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = this.db.prepare('PRAGMA table_info(profiles)').all() as { name: string }[];
      if (!columns.some((c) => c.name === 'code')) {
        this.db.exec('ALTER TABLE profiles ADD COLUMN code TEXT');
      }
      // Moderation status (Phase 7): 'ok', 'shadow' (plays only with other shadow players),
      // 'banned' (can't join).
      if (!columns.some((c) => c.name === 'status')) {
        this.db.exec("ALTER TABLE profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'");
      }
      this.db.exec('DROP INDEX IF EXISTS profiles_code');
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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
      code?: string;
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
        `INSERT INTO profiles (guest_id, name, xp, matches, wins, kills, deaths, updated_at, code)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
         ON CONFLICT(guest_id) DO UPDATE SET
           name = excluded.name,
           code = excluded.code,
           xp = xp + excluded.xp,
           matches = matches + 1,
           wins = wins + excluded.wins,
           kills = kills + excluded.kills,
           deaths = deaths + excluded.deaths,
           updated_at = excluded.updated_at`,
      )
      .run(guestId, name, r.xp, r.win ? 1 : 0, r.kills, r.deaths, Date.now(), r.code ?? null);
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

  // --- Moderation (Phase 7) ---------------------------------------------------------------

  /** Match logs are kept for review for LOG_DAYS, then deleted. */
  static readonly LOG_DAYS = 14;

  saveMatchLog(matchId: string, at: number, log: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO match_logs (match_id, at, data) VALUES (?, ?, ?)')
      .run(matchId, at, JSON.stringify(log));
    this.db.prepare('DELETE FROM match_logs WHERE at < ?').run(at - Store.LOG_DAYS * 86_400_000);
  }

  /** The stored result of a match (players with guest ids, teams, stats). */
  matchSummary(
    matchId: string,
  ): { players: { id: number; guestId: string | null; name: string; team: number }[] } | null {
    const row = this.db.prepare('SELECT summary FROM matches WHERE match_id = ?').get(matchId) as
      { summary: string } | undefined;
    return row ? (JSON.parse(row.summary) as never) : null;
  }

  matchLog(matchId: string): unknown {
    const row = this.db.prepare('SELECT data FROM match_logs WHERE match_id = ?').get(matchId) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as unknown) : null;
  }

  addFlags(guestId: string, matchId: string, flags: string[], aim: unknown, at: number): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO player_flags (guest_id, match_id, flags, aim, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(guestId, matchId, JSON.stringify(flags), JSON.stringify(aim), at);
  }

  addReport(r: {
    reporter: string;
    targetCode: string;
    reason: string;
    matchId: string | null;
    at: number;
  }): void {
    this.db
      .prepare(
        'INSERT INTO reports (reporter, target_code, reason, match_id, at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(r.reporter, r.targetCode, r.reason, r.matchId, r.at);
  }

  setStatus(code: string, status: 'ok' | 'shadow' | 'banned'): boolean {
    return (
      this.db.prepare('UPDATE profiles SET status = ? WHERE code = ?').run(status, code).changes > 0
    );
  }

  statusOf(guestId: string): 'ok' | 'shadow' | 'banned' {
    const row = this.db.prepare('SELECT status FROM profiles WHERE guest_id = ?').get(guestId) as
      { status: 'ok' | 'shadow' | 'banned' } | undefined;
    return row?.status ?? 'ok';
  }

  /** Players worth a look: reported or flagged, most first. */
  moderationQueue(): {
    code: string;
    name: string | null;
    status: string;
    reports: number;
    flaggedMatches: number;
    lastAt: number;
  }[] {
    return this.db
      .prepare(
        `WITH r AS (SELECT target_code AS code, COUNT(*) AS n, MAX(at) AS last FROM reports GROUP BY target_code),
              f AS (SELECT p.code AS code, COUNT(*) AS n, MAX(pf.at) AS last FROM player_flags pf
                    JOIN profiles p ON p.guest_id = pf.guest_id GROUP BY p.code),
              codes AS (SELECT code FROM r UNION SELECT code FROM f)
         SELECT codes.code AS code, p.name AS name, COALESCE(p.status, 'ok') AS status,
                COALESCE(r.n, 0) AS reports, COALESCE(f.n, 0) AS flaggedMatches,
                MAX(COALESCE(r.last, 0), COALESCE(f.last, 0)) AS lastAt
         FROM codes LEFT JOIN profiles p ON p.code = codes.code
         LEFT JOIN r ON r.code = codes.code LEFT JOIN f ON f.code = codes.code
         ORDER BY reports + flaggedMatches DESC, lastAt DESC LIMIT 200`,
      )
      .all() as never;
  }

  /** Everything the admin page shows about one player. */
  playerFile(code: string) {
    const profile = this.db
      .prepare(
        'SELECT guest_id, name, xp, matches, wins, kills, deaths, status FROM profiles WHERE code = ?',
      )
      .get(code) as
      | {
          guest_id: string;
          name: string;
          xp: number;
          matches: number;
          wins: number;
          kills: number;
          deaths: number;
          status: string;
        }
      | undefined;
    const reports = this.db
      .prepare(
        'SELECT reason, match_id AS matchId, at FROM reports WHERE target_code = ? ORDER BY at DESC LIMIT 100',
      )
      .all(code);
    const flags = profile
      ? (
          this.db
            .prepare(
              'SELECT match_id AS matchId, flags, aim, at FROM player_flags WHERE guest_id = ? ORDER BY at DESC LIMIT 50',
            )
            .all(profile.guest_id) as { matchId: string; flags: string; aim: string; at: number }[]
        ).map((f) => ({
          ...f,
          flags: JSON.parse(f.flags) as string[],
          aim: JSON.parse(f.aim) as unknown,
        }))
      : [];
    if (!profile && reports.length === 0) return null;
    // Never hand out the guest id (it is the player's login secret's subject).
    const publicProfile = profile
      ? {
          name: profile.name,
          xp: profile.xp,
          matches: profile.matches,
          wins: profile.wins,
          kills: profile.kills,
          deaths: profile.deaths,
          status: profile.status,
        }
      : null;
    return { code, profile: publicProfile, reports, flags };
  }

  /** Kills per weapon id, all time. */
  weaponKills(guestId: string): Record<string, number> {
    const rows = this.db
      .prepare('SELECT weapon_id, kills FROM weapon_kills WHERE guest_id = ?')
      .all(guestId) as { weapon_id: string; kills: number }[];
    return Object.fromEntries(rows.map((r) => [r.weapon_id, r.kills]));
  }

  /** Give every profile its current code (see createApp), then enforce uniqueness. */
  backfillCodes(codeOf: (guestId: string) => string): void {
    const rows = this.db.prepare('SELECT guest_id, code FROM profiles').all() as {
      guest_id: string;
      code: string | null;
    }[];
    const update = this.db.prepare('UPDATE profiles SET code = ? WHERE guest_id = ?');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const r of rows) {
        const code = codeOf(r.guest_id);
        if (r.code !== code) update.run(code, r.guest_id);
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS profiles_code_unique ON profiles (code)');
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  createProfile(guestId: string, code: string, at: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO profiles (guest_id, name, xp, matches, wins, kills, deaths, updated_at, code)
         VALUES (?, 'Player', 0, 0, 0, 0, 0, ?, ?)`,
      )
      .run(guestId, at, code);
  }

  /** Public lookup by player code: name, XP and when they last played (no guest id). */
  byCode(code: string): { name: string; xp: number; updated_at: number } | null {
    return (
      (this.db.prepare('SELECT name, xp, updated_at FROM profiles WHERE code = ?').get(code) as
        { name: string; xp: number; updated_at: number } | undefined) ?? null
    );
  }

  profile(guestId: string): ProfileRow | null {
    return (
      (this.db.prepare('SELECT * FROM profiles WHERE guest_id = ?').get(guestId) as
        ProfileRow | undefined) ?? null
    );
  }
}
