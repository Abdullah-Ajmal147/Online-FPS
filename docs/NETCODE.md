# Netcode rules

These numbers are the contract between client and server. Change them only with an ADR.

| Setting                                      | Value                                                  |
| -------------------------------------------- | ------------------------------------------------------ |
| Simulation tick (server + client prediction) | 60 Hz fixed (dt = 1/60 s)                              |
| Snapshot rate (server → client)              | 30 Hz                                                  |
| Input rate (client → server)                 | 60 Hz, each packet repeats the last 3 inputs           |
| Interpolation delay for remote players       | 2 snapshots (~66 ms), adaptive up to 100 ms            |
| Max lag-compensation rewind                  | 300 ms (ADR 0006)                                      |
| History kept on server for rewind            | 1 s of hitbox transforms per player                    |
| Transport                                    | WebSocket, binary frames, behind `Transport` interface |

## Message flow

1. Client joins a Colyseus room with its auth token and `PROTOCOL_VERSION`.
   Mismatch → server replies `RELOAD_REQUIRED`.
2. Every client tick: `InputCmd { seq, tick, buttons(bitfield), yaw, pitch, weaponSlot }`.
3. Server applies inputs in `seq` order, one per tick. Missing input → repeat last
   buttons, never extrapolate position from the client.
4. Every 2nd server tick: `Snapshot { serverTick, lastProcessedSeq[forClient], entities[] }`
   sent as full snapshots for now (ADR 0004); delta compression against the last acked
   snapshot is kept as a later option.
5. Client ack: `SnapshotAck { serverTick }` (can ride on InputCmd).

## Client prediction and reconciliation

- Apply local inputs immediately with `packages/shared` movement.
- Keep a ring buffer of unacknowledged inputs + predicted states.
- On snapshot: set local player to server state for `lastProcessedSeq`, replay
  every newer input. If the resulting error is < 5 cm, blend visually over 100 ms;
  otherwise snap.

## Remote entities

- Render at `renderTime = serverTimeEstimate - interpDelay`, interpolating between
  the two snapshots around it. Never extrapolate more than 50 ms.

## Hit registration (hitscan)

- (Implemented as a per-input `viewTick` — see ADR 0005 — governed per player to ±2 ticks of its
  average offset, so it can't be chosen per shot.)
- Firing is a button bit inside `InputCmd`; the server uses that input's `yaw`, `pitch`
  and the client's interpolation delay to decide what the shooter saw.
- Server: validate fire rate / ammo from server weapon state → compute
  `rewindTime = clamp(viewTick, now - 300 ms, now)` (ADR 0005, 0006) → move other
  players' hitboxes to their recorded transforms at `rewindTime` → raycast from
  the server's own eye position with the given angles → restore → apply damage.
- The client plays muzzle flash, tracer and a _predicted_ hit marker; the damage
  number/kill only shows once the server confirms.

## Quantization

- Position of other players: 1/64 m resolution, int16 per axis (maps within ±500 m; ADR 0004)
- The receiving player's own state: exact float32, and the simulation rounds its state to
  float32 every tick (see ADR 0003)
- Yaw/pitch: 16 bits each
- Health/ammo: uint8

## Testing

- `pnpm dev:lag` presets: `good` (40 ms, 0%), `normal` (120 ± 20 ms, 3%), `bad` (250 ± 60 ms, 8%).
- Replay test: feed a recorded input stream to client-predictor and server sim;
  final state must match exactly (ADR 0003; the phase exit test's 1 cm is the upper bound).
