import { getStatus, setStatus } from './store.ts';

/**
 * Game server regions (Phase 8 task 4). The list is fixed at build time (VITE_REGIONS, a JSON
 * array of {id, name, url}); never from the page URL, so a link can't point players at an
 * unknown host. Without it there is one region: the default game server.
 */
export interface Region {
  id: string;
  name: string;
  url: string;
}

/** Parse the build-time list; anything malformed falls back to the single default region. */
export function parseRegions(raw: string | undefined, fallbackUrl: string): Region[] {
  const fallback = [{ id: 'default', name: 'Default', url: fallbackUrl }];
  if (!raw) return fallback;
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list) || list.length === 0) return fallback;
    const regions = list.map((r: Partial<Region>) => {
      if (
        typeof r.id !== 'string' ||
        !/^[a-z0-9-]{1,24}$/.test(r.id) ||
        typeof r.name !== 'string' ||
        typeof r.url !== 'string' ||
        !/^https?:$/.test(new URL(r.url).protocol)
      )
        throw new Error('bad region');
      return { id: r.id, name: r.name.slice(0, 32), url: r.url };
    });
    return new Set(regions.map((r) => r.id)).size === regions.length ? regions : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Which region to join: an invite's region first (friends must land on the same server), then
 * the player's pick, then the lowest measured ping, then the first listed.
 */
export function pickRegion(
  regions: readonly Region[],
  pings: Readonly<Record<string, number | null>>,
  choice: string,
  inviteRegion: string | null = null,
): Region {
  const byId = (id: string | null) => regions.find((r) => r.id === id);
  const measured = regions.filter((r) => typeof pings[r.id] === 'number');
  const fastest = measured.sort((a, b) => pings[a.id]! - pings[b.id]!)[0];
  return byId(inviteRegion) ?? byId(choice) ?? fastest ?? regions[0]!;
}

/**
 * Round trip to a region's /healthz: best of a few (the first includes connection setup).
 * `no-cors` is enough: we only time the response, never read it.
 */
export async function measurePing(
  url: string,
  tries = 3,
  timeoutMs = 2000,
): Promise<number | null> {
  let best: number | null = null;
  for (let i = 0; i < tries; i++) {
    const t0 = performance.now();
    try {
      await fetch(`${url.replace(/\/$/, '')}/healthz`, {
        mode: 'no-cors',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const ms = Math.round(performance.now() - t0);
      best = best === null ? ms : Math.min(best, ms);
    } catch {
      // Unreachable this time.
    }
  }
  return best;
}

/** Ping every region (in parallel) and publish the results for the Play screen. */
export async function probeRegions(regions: readonly Region[]): Promise<void> {
  const results = await Promise.all(regions.map((r) => measurePing(r.url)));
  // Keep the best reading per region: a probe during page load (busy main thread) reads high.
  const before = getStatus().regionPings;
  const merged = regions.map((r, i) => {
    const vals = [before[r.id], results[i]].filter((v): v is number => typeof v === 'number');
    return [r.id, vals.length > 0 ? Math.min(...vals) : null] as const;
  });
  setStatus({ regionPings: Object.fromEntries(merged) });
}

function defaultServerUrl(): string {
  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv;
  // Production: the page and the game server share one origin (behind Caddy, or the game
  // server serving the client itself). Development: the Vite page is on :5173, server on :2567.
  if (!import.meta.env.DEV) return location.origin;
  return `${location.protocol}//${location.hostname}:2567`;
}

let list: readonly Region[] | undefined;

/** The build's region list (read on first use: it needs the page's location). */
export function regions(): readonly Region[] {
  list ??= parseRegions(import.meta.env.VITE_REGIONS as string | undefined, defaultServerUrl());
  return list;
}
