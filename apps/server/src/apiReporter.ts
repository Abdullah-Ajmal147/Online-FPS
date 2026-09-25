import { createHmac } from 'node:crypto';
import type { MatchSummary } from './match.ts';

/**
 * Sends finished matches to the API (Phase 4 lite), signed with the shared server secret so a
 * browser can never post a result. Failures are logged and retried a few times; they never
 * affect the running game.
 */
export function createApiReporter(opts: { url: string; secret: string; fetchImpl?: typeof fetch }) {
  const doFetch = opts.fetchImpl ?? fetch;
  return async function report(summary: MatchSummary): Promise<boolean> {
    const body = JSON.stringify(summary);
    const signature = createHmac('sha256', opts.secret).update(body).digest('hex');
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await doFetch(`${opts.url}/matches`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-sentinel-signature': signature },
          body,
        });
        if (res.ok || res.status === 409) return true; // 409 = already recorded
        console.warn(
          `[api-report] ${res.status} for match ${summary.matchId} (attempt ${attempt})`,
        );
        if (res.status < 500) return false; // our request is wrong; retrying won't help
      } catch (err) {
        console.warn(`[api-report] ${String(err)} (attempt ${attempt})`);
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    return false;
  };
}
