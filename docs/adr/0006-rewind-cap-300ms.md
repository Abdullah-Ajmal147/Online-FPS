# ADR 0006 — Lag-compensation cap 300 ms (was 200 ms)

Date: 2026-09-25
Status: accepted (amends "Max lag-compensation rewind" in `docs/NETCODE.md`)

## Context

The Phase 2 exit test asks for ≥ 95% of on-target shots to register at 150 ms ping. With a
200 ms cap only ~21% did. How far the server must rewind is, for a shot:

- the snapshot the shooter looked at was already one-way latency old when it arrived (≈ 75 ms)
- plus the client's interpolation delay (66–100 ms)
- plus the input's trip to the server (≈ 75 ms)
- plus the time it waits in the server's input buffer (≈ 33 ms)

≈ 250–283 ms at 150 ms RTT. NETCODE.md's `rtt/2 + interpDelay` left out the snapshot's
one-way age, so the 200 ms cap it implied was too tight even at "normal" pings, and much too
tight for a worldwide player base (ADR 0002).

## Decision

- `MAX_REWIND_MS = 300` (18 ticks). Hitbox history stays 1 s.
- The client's `viewTick` (ADR 0005) already measures the real rewind; the cap only limits it.

## Consequences

- Players up to ~170 ms RTT get full compensation; beyond that, shots are compensated up to
  300 ms and they must lead targets slightly.
- Victims can be hit up to 300 ms "behind cover" by a high-ping shooter (the classic trade-off;
  the medium-fast TTK from GAME_DESIGN reduces how often it matters). Revisit with playtest data.
- Measured after the change: see PROGRESS (Phase 2 exit test).
