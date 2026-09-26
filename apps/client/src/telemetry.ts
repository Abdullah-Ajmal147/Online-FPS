import { apiUrl } from './profile.ts';
import { getStatus, subscribe } from './store.ts';

/**
 * Anonymous session health for the dashboard (Phase 8): when the page closes, one beacon
 * says whether an uncaught error happened and the median ping. No player id, no URL, no
 * error text. Only sent for sessions that got as far as loading the game.
 */
export function startSessionTelemetry(region: () => string): void {
  let crashed = false;
  const pings: number[] = [];
  let lastSample = 0;
  addEventListener('error', () => (crashed = true));
  addEventListener('unhandledrejection', () => (crashed = true));
  // One ping sample a second while connected (the store updates many times a second).
  subscribe((s) => {
    const rtt = s.netStats?.rttMs;
    const now = performance.now();
    if (rtt == null || now - lastSample < 1000 || pings.length >= 3600) return;
    lastSample = now;
    pings.push(Math.round(rtt));
  });
  let sent = false;
  addEventListener('pagehide', () => {
    if (sent || getStatus().backend === 'starting') return;
    sent = true;
    const sorted = [...pings].sort((a, b) => a - b);
    const body = JSON.stringify({
      crashed,
      pingMs: sorted.length > 0 ? Math.min(5000, sorted[Math.floor(sorted.length / 2)]!) : null,
      region: region(),
    });
    try {
      navigator.sendBeacon(`${apiUrl()}/telemetry/session`, body);
    } catch {
      // Best effort.
    }
  });
}
