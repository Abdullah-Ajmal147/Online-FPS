/**
 * Mutes, recent players and friends: kept in this browser (no presence server yet). Friends are
 * stored by public player code; the API looks up their name and level.
 */

const MUTED = 'sentinel.muted';
const RECENT = 'sentinel.recent';
const FRIENDS = 'sentinel.friends';
const MAX_RECENT = 20;

export interface RecentPlayer {
  code: string;
  name: string;
  at: number;
}

function load<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key);
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked: lists just won't persist.
  }
}

/** Session-only mutes (players without a code) live here; code mutes are saved. */
const sessionMutes = new Set<string>();

export function isMuted(key: string): boolean {
  return sessionMutes.has(key) || load<string[]>(MUTED, []).includes(key);
}

export function toggleMute(key: string): void {
  if (key.startsWith('id:')) {
    if (sessionMutes.has(key)) sessionMutes.delete(key);
    else sessionMutes.add(key);
    return;
  }
  const list = load<string[]>(MUTED, []);
  save(MUTED, list.includes(key) ? list.filter((k) => k !== key) : [...list, key].slice(-200));
}

export function recentPlayers(): RecentPlayer[] {
  return load<RecentPlayer[]>(RECENT, []);
}

export function rememberRecentPlayers(players: { code: string; name: string }[]): void {
  const now = Date.now();
  const fresh = players.map((p) => ({ code: p.code, name: p.name, at: now }));
  const kept = recentPlayers().filter((r) => !fresh.some((f) => f.code === r.code));
  save(RECENT, [...fresh, ...kept].slice(0, MAX_RECENT));
}

export function friends(): string[] {
  return load<string[]>(FRIENDS, []);
}

export function addFriend(code: string): void {
  if (!/^[0-9a-f]{16}$/.test(code) || friends().includes(code)) return;
  save(FRIENDS, [...friends(), code].slice(0, 100));
}

export function removeFriend(code: string): void {
  save(
    FRIENDS,
    friends().filter((c) => c !== code),
  );
}
