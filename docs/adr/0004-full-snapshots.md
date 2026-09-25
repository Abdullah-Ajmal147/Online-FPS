# ADR 0004 — Full snapshots, no delta compression (for now)

Date: 2026-09-25
Status: accepted (amends the "delta-compressed" line of `docs/NETCODE.md`)

## Context

`docs/NETCODE.md` says snapshots are delta-compressed against the last snapshot the client
acked, with int16 position deltas. The Phase 1 plan said delta compression would be added
only if the size budget (10 KB/s per player) required it.

## Decision

- Send full snapshots. A full 12-player snapshot is ~245 bytes: ≈ 7.6 KB/s per player at
  30 Hz including framing, under the 10 KB/s budget (checked by a unit test in
  `packages/protocol`). Other players' positions are int16 at 1/64 m since protocol v3
  (was int32): maps must stay within ±500 m, enforced by the map schema.
- Keep collecting acks (`InputCmd.ackServerTick`, `SnapshotAck`) on the server so delta
  compression can be added later without a protocol redesign.
- Revisit when snapshots carry more per-player data (weapons, health; Phase 2–3) and the size
  test gets close to the budget, or when mobile data use matters (Phase 9).

## Consequences

- Simpler code; any single snapshot is enough to resynchronise (no baseline to lose).
- A lost snapshot costs nothing extra to recover from.
- More bytes than necessary; fine within budget today.
