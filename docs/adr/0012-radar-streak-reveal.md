# ADR 0012 — Radar sweep: an earned exception to server-side visibility

Date: 2026-09-27
Status: accepted. Amends ADR 0009 (and the smoke rule of ADR 0008) for one event.

## Context

The 3-kill streak reward is a radar sweep: the earner's team sees where the enemies are. That
needs positions of enemies the team can't see, which ADR 0009 otherwise never sends.

## Decision

- When a player reaches the radar's kill count in one life (server-decided, content
  `streaks.json`), the server sends one `radar` event to each player on that player's team.
  Nothing goes to the other team.
- It lists every living enemy at that moment, including behind walls and inside smoke: the
  reward is meant to beat cover. Ground plan only (x, z; no height, no ids, no view angles),
  rounded to 2 m, as a one-time snapshot: no live tracking, and snapshots stay filtered as in
  ADR 0009.
- At most `MAX_RADAR_ENEMIES` (16) entries; the server clamps, the decoder rejects more.

## Consequences

- ADR 0009's guarantee now reads: a modified client learns positions only of enemies it could
  see or hear, plus, when its team earns a radar, every enemy's position to within ~2 m at
  that moment (tested in apps/server/src/sim.test.ts).
- A cheat client can keep the dots on screen longer than the 5 s the real client shows them;
  they go stale as enemies move, which is the same information an honest player remembers.
