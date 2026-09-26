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
  /**
   * Recent moderation answers, kept for an hour: if the API is briefly unreachable, a player
   * who was banned (by profile or IP) a moment ago still can't walk back in.
   */
  const recent = new Map<string, { status: Access['status']; at: number }>();
  const remember = (key: string, status: Access['status']) => {
    recent.set(key, { status, at: Date.now() });
    if (recent.size > 50_000) recent.delete(recent.keys().next().value!);
  };
  const cached = (key: string) => {
    const r = recent.get(key);
    return r && Date.now() - r.at < 3_600_000 ? r.status : undefined;
  };

  return async function fetchAccess(
    guestId: string | null,
    ipHashValue: string,
  ): Promise<Access | null> {
    try {
      const q = new URLSearchParams({ guest: guestId ?? '', ip: ipHashValue });
      const res = await doFetch(`${opts.url}/access?${q.toString()}`, {
        headers: serviceHeaders(opts.secret, 'access', `${guestId ?? ''}|${ipHashValue}`),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const access = parseAccess(await res.json());
      if (access.unlockAll && !opts.allowUnlockAll) access.unlockAll = false;
      remember(`ip:${ipHashValue}`, access.status);
      if (guestId) remember(`g:${guestId}`, access.status);
      return access;
    } catch (err) {
      opts.log?.warn('could not load unlocks', { err: String(err) });
      // API unreachable: unknown unlocks, but a recently known ban or shadow still applies.
      const known = (guestId && cached(`g:${guestId}`)) || cached(`ip:${ipHashValue}`);
      return known && known !== 'ok' ? { level: 1, weaponKills: {}, status: known } : null;
    }
  };
}
