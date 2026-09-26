import { serviceHeaders, type Logger } from '@sentinel/auth';
import type { Access } from '@sentinel/content';

/** Checks the API's answer (defensive: it's another process). */
export function parseAccess(raw: unknown): Access {
  const r = raw as {
    level?: unknown;
    weaponKills?: unknown;
    unlockAll?: unknown;
    status?: unknown;
  } | null;
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
  const status = r.status === 'shadow' || r.status === 'banned' ? r.status : 'ok';
  return { level, weaponKills, unlockAll: r.unlockAll === true, status };
}

/**
 * Asks the API what a player has unlocked (level, weapon kills), signed with the server secret.
 * Returns null when it can't tell (no guest, API slow or down, bad answer): callers fall back
 * to a new player's unlocks on join (fail closed) and keep what they had on a refresh.
 * `allowUnlockAll`: this game server's own SENTINEL_UNLOCK_ALL; without it an "everything
 * unlocked" answer from the API is ignored.
 */
export function createAccessFetcher(opts: {
  url: string;
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  log?: Logger;
  allowUnlockAll?: boolean;
}) {
  const doFetch = opts.fetchImpl ?? fetch;
  return async function fetchAccess(guestId: string | null): Promise<Access | null> {
    if (!guestId) return null;
    try {
      const res = await doFetch(`${opts.url}/access/${guestId}`, {
        headers: serviceHeaders(opts.secret, 'access', guestId),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const access = parseAccess(await res.json());
      if (access.unlockAll && !opts.allowUnlockAll) access.unlockAll = false;
      return access;
    } catch (err) {
      opts.log?.warn('could not load unlocks', { err: String(err) });
      return null;
    }
  };
}
