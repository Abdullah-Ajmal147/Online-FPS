# ADR 0002 — Worldwide audience, three launch regions

Date: 2026-09-25
Status: accepted

## Context

The owner wants the game played worldwide, not in one home region. A fast shooter
needs round-trip times under about 150 ms to feel good, so one server location cannot
serve everyone. Hosting budget for a solo developer is small.

## Decision

- Launch game servers in three regions: EU (Frankfurt), NA East (Virginia), Asia (Singapore).
- Later regions, driven by player data: NA West, South America (São Paulo), India (Mumbai),
  Oceania (Sydney).
- The client measures ping to every region's `/healthz` and Quick Play picks the lowest.
  Bots fill matches, so thin regions still start fast.
- The API and Supabase database stay in one region (EU). They are not on the real-time path;
  only game servers need to be close to players.
- Netcode stays as in `docs/NETCODE.md` (200 ms max rewind). Players above that ping still
  play, but their shots are compensated only up to 200 ms.
- Time-to-kill is medium-fast (see GAME_DESIGN.md) to reduce "died behind cover" at high ping.

## Consequences

- Phase 3: the server must run on any host from one container image, configured by env.
- Phase 4: the client needs a region list and a ping probe; matchmaking is per region.
- Phase 7/8: deploy, monitor and load-test three regions, not one.
- Test with the `bad` lag preset (250 ms ± 60 ms, 8% loss) regularly, not only `normal`.

## Alternatives considered

- One region only (for example EU): cheapest, but unplayable ping for Asia and the Americas.
- Peer-to-peer or player hosting: breaks the "server is the authority" rule.
