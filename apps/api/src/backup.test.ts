import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serviceHeaders } from '@sentinel/auth';
// @ts-expect-error plain .mjs ops script (runs in the production image without a build)
import { KEEP, backup, restore } from '../scripts/backup.mjs';
import { createApp } from './app.ts';
import { Store } from './db.ts';

const SECRET = 'drill-secret';
const GUEST = '0f8c2a6e-1b2c-4d3e-8f90-123456789abc';

async function playOneMatch(a: ReturnType<typeof createApp>) {
  const body = JSON.stringify({
    matchId: 'eeeeeeee-0000-4000-8000-000000000001',
    mode: 'team-deathmatch',
    map: 'relay-yard',
    winner: 0,
    durationSeconds: 600,
    players: [
      {
        guestId: GUEST,
        name: 'Drill',
        team: 0,
        bot: false,
        kills: 4,
        deaths: 2,
        secondsPlayed: 600,
      },
    ],
  });
  const res = await a.request('/matches', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...serviceHeaders(SECRET, 'match', body) },
  });
  expect(res.status).toBe(200);
}

describe('backup and restore (Phase 7 restore drill)', () => {
  it('a backup taken while running restores the same player data after the file is lost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-drill-'));
    const dbPath = join(dir, 'sentinel.db');
    const a = createApp(new Store(dbPath), SECRET);
    await playOneMatch(a);
    const before = await (await a.request(`/profiles/${GUEST}`)).json();

    const b = backup(dbPath, join(dir, 'backups'));
    expect(b.profiles).toBe(1);

    // Disaster: the database file is gone (or corrupt).
    rmSync(dbPath);
    writeFileSync(dbPath, 'garbage');
    restore(b.path, dbPath);

    const after = await (
      await createApp(new Store(dbPath), SECRET).request(`/profiles/${GUEST}`)
    ).json();
    expect(after).toEqual(before);
  });

  it('keeps only the newest backups and refuses a corrupt one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sentinel-drill-'));
    const dbPath = join(dir, 'sentinel.db');
    new Store(dbPath);
    for (let i = 0; i < KEEP + 3; i++)
      backup(dbPath, join(dir, 'b'), new Date(Date.UTC(2026, 0, 1, 0, i)));
    expect(readdirSync(join(dir, 'b'))).toHaveLength(KEEP);
    const bad = join(dir, 'bad.db');
    writeFileSync(bad, 'not a database');
    expect(() => restore(bad, dbPath)).toThrow();
  });
});
