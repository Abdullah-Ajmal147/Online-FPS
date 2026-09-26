# ADR 0008 — Server-simulated grenades, smoke culling in snapshots

Date: 2026-09-26
Status: accepted (Phase 5 task 5)

## Context

Frag and smoke grenades need to fly, bounce and go off the same way for everyone, and smoke has
to actually hide players. Snapshots are full (ADR 0004): every client receives every player's
position, so a smoke drawn only by the client can be switched off in devtools.

## Decision

- Grenades are simulated only on the server (`apps/server/src/grenades.ts`): plain ballistic
  flight with bounces off the Rapier map, fuse, then explosion or cloud. Clients send only the
  G/Q button bits; throws are not predicted (the grenade appears after about one round trip).
- Frag damage needs a clear map line from the blast to the chest; it never hurts teammates,
  hurts the thrower at half, and a self-kill scores nothing.
- Snapshots leave out an enemy whose head and chest are both behind a smoke cloud from the
  viewer's eye (per viewer, per snapshot). Clients drop players missing from a snapshot. This
  is the first piece of the Phase 7 "only send what can be seen" (PVS) rule.
- Spawn selection ignores smoke (map-only line checks), so smoke can't steer spawns.
- Limits: 64 live grenades per match; a throw cooldown from content; keys held since spawn
  or since the countdown must be released before they throw.

## Consequences

- Throws feel ~RTT delayed; acceptable for a lob. Predicting throws is a later option.
- A player walking out of smoke pops in (no interpolation history yet); acceptable.
- Only smoke is culled; walls are not yet (full PVS in Phase 7).
