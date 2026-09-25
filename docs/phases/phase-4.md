# Phase 4 — Online shell (≈3 weeks)

Goal: a stranger clicks a link and is in a match in under 20 seconds, and progress persists.

## Tasks

1. Supabase project: anonymous (guest) sign-in with Cloudflare Turnstile; link Google/email later
   keeps the same profile.
2. Postgres schema + migrations: `profiles`, `matches`, `match_players`, `loadouts`, `progression`.
3. `apps/api` (Hono): verify Supabase JWT; `GET/PUT /me`, `GET/PUT /loadouts`,
   `POST /matches` (game-server only, HMAC/service key), `GET /progression`.
4. Game server verifies the player's token on join; submits signed match result at end.
5. API computes XP and level from the server's result (never from the client).
6. Main menu: Play (Quick Play), Loadout (placeholder), Profile, Settings.
7. Quick Play: Colyseus `joinOrCreate` with region and skill placeholder; show queue time.
8. Settings saved per account: sensitivity, FOV, keybinds, graphics preset, volume.
9. Sentry on client/server/API; PostHog events: `session_start`, `match_start`,
   `match_end`, `quit_mid_match`.
10. Rate limits on API and room joins.

## Exit test

- [ ] Cold link → in a match in < 20 s (Playwright measures it)
- [ ] XP and level still correct after reload and on another device after linking
- [ ] A forged `POST /matches` from a client is rejected
- [ ] Errors show up in Sentry; events show up in PostHog
