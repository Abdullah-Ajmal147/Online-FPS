# ADR 0009 — Server-side visibility (anti-wallhack)

Date: 2026-09-26
Status: accepted (Phase 7 task 2). Amends ADR 0004 (full snapshots): snapshots are still full
for everything they contain, but enemies a player can't perceive are left out.

## Context

With every position sent to every client, a wallhack is a few lines of code. The server
already has the exact collision world, so it can decide what each player could see.

## Decision

Per snapshot, per viewer, an enemy is sent if any of these holds (`MatchSim.shouldSend`):

- within 8 m (footsteps), or fired in the last 0.5 s within 60 m (gunfire);
- a clear map line from the viewer's eye to the enemy's head, chest, or chest 0.25 s ahead
  along their velocity, or from the viewer's eye 0.25 s ahead to the enemy's chest.

Once sent, an enemy stays sent for 0.5 s (no flicker at edges); a hidden enemy is re-checked
every 6 ticks (0.1 s, less than the 0.25 s look-ahead). Teammates are always sent. Smoke rule
from ADR 0008 applies on top. Clients drop players missing from a snapshot.

## Consequences

- A modified client learns positions only of enemies it could see or hear (tested).
- Cost: about 45–65 ms of CPU per second of play for a 12-player match in the worst case
  (everyone hidden); tick p99 unchanged at ~1.2 ms.
- An enemy appearing starts a fresh interpolation buffer (brief pop-in two snapshots late);
  the look-ahead hides most of it for peeks.
