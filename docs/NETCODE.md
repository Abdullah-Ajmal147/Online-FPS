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

- (Implemented as a per-input `viewTick` — see ADR 0005 — governed per player: it may only move back
  0.25 tick per input, so it can't be jumped back for a shot.)
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

## Client → server message audit (Phase 7)

Every message a client can send, and what the server checks before it has any effect.
Nothing a client sends is ever trusted as a position, hit, number or result.

| Message        | Size                                   | Rate                                                                                                     | Values                                                                                                                                                                                                                                                            |
| -------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Join options   | WebSocket ≤ 2 KB                       | joins per IP: burst 20, then 1/s                                                                         | protocol version + content hash must match; guest token HMAC-verified; name cleaned + profanity-filtered; loadout rebuilt by `buildLoadout` against the player's server-side unlocks (only 16 entries of any array read); invite token ≤ 32 chars, party lead ≤ 3 |
| InputCmd       | exact layout, no trailing bytes        | 150 msgs/s per client (Colyseus); queue capped at 20, extra inputs dropped; one input simulated per tick | 1–3 inputs, u32 seq without overflow, seq must increase; unknown button bits masked, pitch clamped, weapon slot 0/1; view tick governed (back ≤ 0.25 tick per input, rewind ≤ 300 ms)                                                                             |
| SnapshotAck    | 4 bytes                                | message rate cap                                                                                         | clamped to the current server tick                                                                                                                                                                                                                                |
| Ping           | exactly 4 bytes                        | ≥ 400 ms apart                                                                                           | echoed only                                                                                                                                                                                                                                                       |
| SetLoadout     | strict decode, lists ≤ 3               | ≥ 250 ms apart                                                                                           | every index must exist; unlocks enforced; applied only at the next spawn                                                                                                                                                                                          |
| ChatSend       | ≤ 483 bytes before decoding            | per guest (or IP): burst 4, then 1 per 1.5 s                                                             | strict decode; cleaned (invisible/bidi removed, ≤ 120 chars, profanity filter); team chat only to the sender's team                                                                                                                                               |
| SwitchTeam     | empty (anything else is a bad message) | ≥ 2 s apart; private matches only                                                                        | server checks the other team has room for a human; a bot makes way; respawn without a death                                                                                                                                                                       |
| Private create | join options                           | static onAuth, before the room exists: per IP burst 3 then 1 per 30 s; ≤ 30 private rooms per process    | map must be in the rotation; after the creator, joining needs a valid invite token of someone inside                                                                                                                                                              |

Malformed messages count against the sender; more than 20 and the connection is closed.
Tests that prove the "no effect" part: a client flooding inputs gets no extra movement steps;
a client firing at twice the fire rate gets no extra hits (`apps/server/src/sim.test.ts`);
a hidden enemy never appears in a wallhack client's snapshots (ADR 0009).

## Testing

- `pnpm dev:lag` presets: `good` (40 ms, 0%), `normal` (120 ± 20 ms, 3%), `bad` (250 ± 60 ms, 8%).
- Replay test: feed a recorded input stream to client-predictor and server sim;
  final state must match exactly (ADR 0003; the phase exit test's 1 cm is the upper bound).
