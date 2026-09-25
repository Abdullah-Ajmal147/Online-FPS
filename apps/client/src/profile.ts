import { setStatus } from './store.ts';

export interface Profile {
  level: number;
  xp: number;
  xpIntoLevel: number;
  xpForNext: number;
  matches: number;
  wins: number;
  kills: number;
  deaths: number;
}

const GUEST_KEY = 'sentinel.guest';

/**
 * This browser's guest id (Phase 4 lite): a random UUID kept in localStorage. It lets XP
 * persist without an account. It is NOT a secure identity — anyone who copies it can use it;
 * Supabase guest accounts replace it in Phase 4.
 */
export function guestId(): string {
  try {
    const existing = localStorage.getItem(GUEST_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(GUEST_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID(); // storage blocked: progress won't persist this time
  }
}

/** API base URL: `?api=` in the page URL, then VITE_API_URL, then this host on port 8787. */
export function apiUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get('api');
  if (fromQuery && /^https?:\/\//.test(fromQuery)) return fromQuery;
  const fromEnv = import.meta.env.VITE_API_URL as string | undefined;
  if (fromEnv) return fromEnv;
  return `${location.protocol}//${location.hostname}:8787`;
}

/** Load this guest's level and XP into the store (quietly does nothing if the API is down). */
export async function refreshProfile(): Promise<void> {
  try {
    const res = await fetch(`${apiUrl()}/profiles/${guestId()}`);
    if (!res.ok) return;
    setStatus({ profile: (await res.json()) as Profile });
  } catch {
    // API unreachable: the menu just hides the profile card.
  }
}
