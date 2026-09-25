# ADR 0005 — Lag compensation from the client's view tick

Date: 2026-09-25
Status: accepted (refines "Hit registration" in `docs/NETCODE.md`)

## Context

NETCODE.md says the server rewinds to `now - (rtt/2 + interpDelay)`. The server doesn't
measure RTT itself (the client pings), RTT jitters, and the interpolation delay is adaptive on
the client, so that formula would rewind to a slightly different moment than the one the
shooter actually saw.

## Decision

- Every input carries `viewTick`: the fractional server tick at which the client was drawing
  other players when it made that input (its render tick = server-time estimate − interp delay).
- On a shot the server rewinds other players' hitboxes to `viewTick`, clamped to
  `[now − 200 ms, now]` (12 ticks), interpolating between the recorded ticks.
- The ray starts at the shooter's own, current, server-side eye position, with the shot's aim
  angles (view + recoil, from the shared weapon simulation) plus server-side random spread.
- History: 1 s of hitbox transforms per player (60 ticks).

## Consequences

- Rewinds to exactly what the shooter saw, within the 200 ms cap, whatever the jitter.
- A modified client can lie about `viewTick`, but only within the same 200 ms window the
  original design already grants; the clamp is the protection in both designs.
- +5 bytes per input on the wire (u32 tick + u8 fraction).
- Spread is random on the server only; the client shows its own guess (tracers, predicted hit
  marker) and the server's result is final.

## Amendment (2026-09-25, netcode review H1)

A raw client-chosen `viewTick` allowed a "backtrack" cheat: picking a different rewind point
for every shot inside the window. The server now governs it per player: it keeps a slow moving
average of the view offset (server tick − viewTick) and accepts only view ticks within ±2 ticks
of it. Honest drift (jitter, interpolation-delay changes) is followed; per-shot jumps are not.
Measured after the change: 150/150 on-target shots registered at 150 ms.
