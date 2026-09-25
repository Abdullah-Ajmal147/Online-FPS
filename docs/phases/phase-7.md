# Phase 7 — Security + operations (≈2–3 weeks)

Goal: safe to open to the public.

## Tasks

1. Audit every client→server message: size caps, rate limits, value ranges, seq checks.
2. Server-side visibility (anti-wallhack): only send enemies that are visible or audible
   to that client (PVS/raycast with a small margin), plus teammates.
3. Stat anomaly flags: reaction time, headshot %, snap angle speed, K/D vs. rank; store per match.
4. Match logs: compact event log per match (kills, positions sampled) for review; keep 14 days.
5. Report player button → admin queue. Simple admin page: view reports, match log, ban/shadow-ban.
6. Shadow-ban pool: flagged players matched with each other.
7. Load test with `tools/bots`: 50 concurrent matches; measure CPU, RAM, bandwidth per match.
8. Uptime checks + alerts; backups for Postgres; runbook in `docs/RUNBOOK.md`.

## Exit test

- [ ] 50 bot matches at once run on the target server type; per-match cost recorded
- [ ] A modified client with speed hack and 2× fire-rate is rejected/has no effect
- [ ] A wallhack test client receives no hidden enemy positions
- [ ] Restore-from-backup drill done once
