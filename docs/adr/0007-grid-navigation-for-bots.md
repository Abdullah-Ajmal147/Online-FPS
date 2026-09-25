# ADR 0007 — Grid navigation for server bots (instead of recast-navigation)

Date: 2026-09-25
Status: accepted (Phase 3 task 6 said "navmesh via recast-navigation")

## Context

Server bots need to find their way around maps. The phase plan named recast-navigation
(JS/WASM navmesh). Our maps are small (≤ 70 m), single-level, and built from simple
primitives, and the server already has the exact collision world in Rapier.

## Decision

- Build a 1 m navigation grid at room start from the Rapier world itself: a cell is walkable if
  a downward ray finds ground and a standing capsule fits; neighbours connect if the ground
  between them never steps more than the character's step height (stairs and ramps connect,
  ledges don't). Diagonals can't cut corners.
- A* with an octile heuristic; bots follow cell centres and jump/re-plan when stuck.

## Consequences

- No extra WASM dependency; the grid can never disagree with the real colliders.
- Build takes a few ms per map; a cross-map path is found in well under 20 ms (tested).
- Limits: single-level maps only (a floor under a bridge would be missed), 1 m resolution
  (narrow gaps < 1 m aren't used), no jump links. Revisit with recast if maps get multi-level.
