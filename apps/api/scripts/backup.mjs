// Database backups for the API's SQLite file (RUNBOOK.md: backups and restore drill).
//   node apps/api/scripts/backup.mjs backup  [db=$SENTINEL_DB] [dir=$SENTINEL_BACKUP_DIR]
//   node apps/api/scripts/backup.mjs restore <backup-file> [db=$SENTINEL_DB]   (API stopped!)
// A backup is a consistent copy taken while the API runs (VACUUM INTO), checked with
// PRAGMA integrity_check, named by UTC time; the newest KEEP backups are kept.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export const KEEP = 14;

function check(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    if (row.integrity_check !== 'ok')
      throw new Error(`integrity check failed: ${JSON.stringify(row)}`);
    return db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n;
  } finally {
    db.close();
  }
}

/** Take a backup; returns its path and the number of profiles in it. */
export function backup(dbPath, dir, now = new Date()) {
  mkdirSync(dir, { recursive: true });
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const out = join(dir, `sentinel-${stamp}.db`);
  const tmp = `${out}.partial`;
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
  } finally {
    db.close();
  }
  const profiles = check(tmp);
  renameSync(tmp, out);
  const old = readdirSync(dir)
    .filter((f) => /^sentinel-\d{8}T\d{6}Z\.db$/.test(f))
    .sort()
    .slice(0, -KEEP);
  for (const f of old) rmSync(join(dir, f));
  return { path: out, profiles };
}

/** Replace the database with a backup (the API must be stopped). Keeps the old file aside. */
export function restore(backupPath, dbPath) {
  const profiles = check(backupPath);
  if (existsSync(dbPath)) renameSync(dbPath, `${dbPath}.before-restore`);
  for (const suffix of ['-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
  mkdirSync(dirname(dbPath), { recursive: true });
  copyFileSync(backupPath, dbPath);
  return { profiles };
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  const [cmd, a, b] = process.argv.slice(2);
  const db = process.env.SENTINEL_DB ?? '/data/sentinel.db';
  if (cmd === 'backup') {
    const r = backup(a ?? db, b ?? process.env.SENTINEL_BACKUP_DIR ?? join(dirname(db), 'backups'));
    console.log(`backup ok: ${r.path} (${r.profiles} profiles)`);
  } else if (cmd === 'restore' && a) {
    const r = restore(a, b ?? db);
    console.log(`restored ${a} → ${b ?? db} (${r.profiles} profiles); start the API again`);
  } else {
    console.error('usage: backup.mjs backup [db] [dir] | restore <file> [db]');
    process.exit(2);
  }
}
