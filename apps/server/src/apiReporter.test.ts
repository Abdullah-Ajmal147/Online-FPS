import { verifyService } from '@sentinel/auth';
import { describe, expect, it } from 'vitest';
import { createApiReporter } from './apiReporter.ts';
import type { MatchSummary } from './match.ts';

const summary: MatchSummary = {
  matchId: '11111111-1111-4111-8111-111111111111',
  mode: 'team-deathmatch',
  map: 'relay-yard',
  winner: 0,
  teamScores: [75, 60],
  durationSeconds: 512,
  mvp: 1,
  players: [
    {
      id: 1,
      guestId: null,
      name: 'Bot Heron',
      team: 0,
      bot: true,
      kills: 12,
      deaths: 4,
      headshots: 0,
      fragKills: 0,
      weaponKills: {},
      secondsPlayed: 512,
    },
  ],
};

describe('api reporter', () => {
  it('posts the summary signed with the server secret', async () => {
    let seen: { url: string; body: string; sig: string; time: string } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = {
        url,
        body: init.body as string,
        sig: (init.headers as Record<string, string>)['x-sentinel-signature']!,
        time: (init.headers as Record<string, string>)['x-sentinel-time']!,
      };
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const ok = await createApiReporter({ url: 'http://api', secret: 's3cret', fetchImpl })(summary);
    expect(ok).toBe(true);
    expect(seen!.url).toBe('http://api/matches');
    // What the API checks: purpose 'match', within a minute, this exact body.
    expect(verifyService('s3cret', 'match', seen!.body, seen!.time, seen!.sig)).toBe(true);
    expect(JSON.parse(seen!.body)).toEqual(summary);
  });

  it('treats "already recorded" as done and does not retry client errors', async () => {
    let calls = 0;
    const respond = (status: number) =>
      (async () => {
        calls++;
        return new Response('{}', { status });
      }) as unknown as typeof fetch;
    expect(
      await createApiReporter({ url: 'x', secret: 's', fetchImpl: respond(409) })(summary),
    ).toBe(true);
    calls = 0;
    expect(
      await createApiReporter({ url: 'x', secret: 's', fetchImpl: respond(401) })(summary),
    ).toBe(false);
    expect(calls).toBe(1);
  });
});
