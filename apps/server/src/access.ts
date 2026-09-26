import { createHmac } from 'node:crypto';
import type { Logger } from '@sentinel/auth';
import { NEW_PLAYER, type Access } from '@sentinel/content';

/** Checks the API's answer (defensive: it's another process). */
export function parseAccess(raw: unknown): Access {
  const r = raw as { level?: unknown; weaponKills?: unknown; unlockAll?: unknown } | null;
  if (!r || typeof r !== 'object') throw new Error('not an object');
  const level = r.level;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 100)
    throw new Error('bad level');
  const weaponKills: Record<string, number> = {};
  if (r.weaponKills && typeof r.weaponKills === 'object') {
    for (const [id, k] of Object.entries(r.weaponKills)) {
      if (typeof k === 'number' && Number.isInteger(k) && k >= 0) weaponKills[id] = k;
    }
  }
  return { level, weaponKills, unlockAll: r.unlockAll === true };
}

/**
 * Asks the API what a player has unlocked (level, weapon kills), signed with the server secret.
 * Unknown guests, a slow or unreachable API: a new player's unlocks (fail closed: nobody gets
 * locked gear because the API is down).
 */
export function createAccessFetcher(opts: {
  url: string;
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: Logger;
}) {
  const doFetch = opts.fetchImpl ?? fetch;
  return async function fetchAccess(guestId: string | null): Promise<Access> {
    if (!guestId) return NEW_PLAYER;
    try {
      const res = await doFetch(`${opts.url}/access/${guestId}`, {
        headers: {
          'x-sentinel-signature': createHmac('sha256', opts.secret).update(guestId).digest('hex'),
        },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      return parseAccess(await res.json());
    } catch (err) {
      opts.log?.warn("could not load unlocks; using a new player's", { err: String(err) });
      return NEW_PLAYER;
    }
  };
}
