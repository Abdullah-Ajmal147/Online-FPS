# ADR 0003 — Round simulation state to float32, send own state exactly

Date: 2026-09-25
Status: accepted (amends the Quantization section of `docs/NETCODE.md`)

## Context

`docs/NETCODE.md` quantizes positions to 1/64 m on the wire. For client prediction to match
the server exactly, the state the client replays from must equal the state the server
simulated. The Phase 1 plan first proposed rounding the simulation itself to 1/64 m every
tick. Worked through, that breaks movement: one walking tick is 5.33 grid units, so walk
speed rounds to 4.69 m/s (−6%), crouch to 2.81 m/s (+12%), and a small sideways component
rounds to zero every tick, so shallow diagonal movement is impossible.

## Decision

- `packages/shared` movement rounds position and velocity with `Math.fround` (float32) at the
  end of every tick. Float32 keeps sub-millimetre precision inside the map, and `Math.fround`,
  `+ - * /` and `Math.sqrt` give identical results in every JS engine. Rapier works in f32
  internally already. Trigonometry uses our own polynomial (`detSinCos`), never `Math.sin`,
  whose last bit can differ between engines.
- Snapshots send **the receiving player's own state** so reconciliation replays from exactly
  the server's state. It must contain every field `step()` reads (`PlayerState`):

  | Field              | Wire type                               | Bytes |
  | ------------------ | --------------------------------------- | ----- |
  | position x, y, z   | 3 × float32                             | 12    |
  | velocity x, y, z   | 3 × float32                             | 12    |
  | slideTicks         | uint8                                   | 1     |
  | slideCooldownTicks | uint8                                   | 1     |
  | flags              | uint8 (bit 0 grounded, bit 1 crouching) | 1     |
  | prevButtons        | uint16                                  | 2     |

  29 bytes. yaw/pitch are not needed: the client replays its own inputs, which carry them.
  Adding a field to `PlayerState` means adding it here and bumping `PROTOCOL_VERSION`.

- **Other players** keep the 1/64 m position quantization from NETCODE.md; they are only
  interpolated for display and hit tests use the server's own history.
- View angles stay 16-bit (yaw uint16, pitch int16) and the simulation uses the quantized
  angle, so client and server turn identically.

## Consequences

- Determinism relies on client and server loading the exact same Rapier WASM build: the
  version is pinned exactly. A cross-browser test (state hash in Chrome, Firefox, WebKit vs
  Node) is part of Phase 1 task 10.

- 29 extra bytes per snapshot for the own-player block (≈0.9 KB/s at 30 Hz), well within
  the 10 KB/s budget.
- The replay test can require an exact match, not just 1 cm.
- `docs/NETCODE.md` Quantization section updated to point here.

## Alternatives considered

- Round the simulation to 1/64 m: rejected, distorts speeds and directions (see Context).
- Round the simulation to a finer grid (e.g. 1/1024 m) and widen the wire format: works, but
  float32 is simpler and just as deterministic.
