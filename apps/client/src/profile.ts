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

const TOKEN_KEY = 'sentinel.guestToken';

/**
 * This browser's guest identity: a token signed by the API (`g1.<guestId>.<issued>.<sig>`),
 * kept in localStorage. The game server verifies it on join, so XP can only go to the guest
 * who holds the token. Accounts (Supabase) can replace guests in Phase 4.
 */
let cached: { guestId: string; token: string } | null = null;

function readStored(): { guestId: string; token: string } | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    const guestId = token?.split('.')[1];
    return token && guestId ? { guestId, token } : null;
  } catch {
    return null;
  }
}

/** Our guest token, asking the API for a new guest the first time. Null if the API is down. */
export async function ensureGuest(): Promise<{ guestId: string; token: string } | null> {
  cached ??= readStored();
  if (cached) return cached;
  try {
    const res = await fetch(`${apiUrl()}/guests`, { method: 'POST' });
    if (!res.ok) return null;
    cached = (await res.json()) as { guestId: string; token: string };
    try {
      localStorage.setItem(TOKEN_KEY, cached.token);
    } catch {
      // storage blocked: this session still works, progress won't survive a reload
    }
    return cached;
  } catch {
    return null;
  }
}

/** Forget a token the API or server refused (e.g. expired), so a fresh guest is created. */
export function forgetGuest(): void {
  cached = null;
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
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
  const guest = await ensureGuest();
  if (!guest) return;
  try {
    const res = await fetch(`${apiUrl()}/profiles/${guest.guestId}`);
    if (!res.ok) return;
    setStatus({ profile: (await res.json()) as Profile });
  } catch {
    // API unreachable: the menu just hides the profile card.
  }
}
