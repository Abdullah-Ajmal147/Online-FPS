# Phase 1 plan — Networked movement

Status: **waiting for owner approval**. No code is written until the owner says OK.

Rules this plan follows: `docs/NETCODE.md` (60 Hz sim, 30 Hz snapshots, 3× input redundancy,
2-snapshot interpolation, 1/64 m position quantization), CLAUDE.md rules 1, 2, 5, 6, and ADR 0002
(worldwide players, so every netcode task is also checked with the `bad` preset).

## Key design choices (explained up front)

- **One movement function for client and server.** `packages/shared/movement` exports
  `step(state, input, world) -> state`. The server runs it to decide the truth; the client runs
  the same code to predict. Both use the same Rapier version, so results match.
- **Quantize inside the simulation, not just on the wire.** Snapshots send positions at 1/64 m
  (about 1.6 cm). If only the wire were quantized, every snapshot would differ from the
  client's prediction by up to 0.8 cm and cause constant tiny corrections. Instead, `step()`
  rounds position to 1/64 m and velocity to a fixed grid at the end of every tick. Server state
  is then exactly what the snapshot carries, and replaying from it reproduces the prediction.
- **No player-vs-player collision in Phase 1.** Players pass through each other. Pushing other
  players is where client prediction goes wrong most often, so it waits until movement feels
  right (see question 1).
- **Movement tuning is content data.** Speeds, jump height and slide times go in
  `packages/content/movement.json` with a zod schema (rule 3), not in code.

## Tasks

| #   | Task                                                                                                                                                                                                                                          | Files (expected)                                                                                                          | Proof (tests)                                                                                                                                                          | Risk / notes                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Greybox map as data (boxes, ramps, stairs, ledge) + movement tuning data; shared builder turns the map into Rapier colliders, client turns it into Three.js meshes                                                                            | `packages/content/{maps/greybox.json,movement.json,schemas.ts}`, `packages/shared/src/world.ts`, `apps/client/src/map.ts` | Schema tests; world test: raycast down hits the floor at the expected height                                                                                           | Rapier WASM must `init()` before use, in browser and Node                                                                                                 |
| 2   | Movement: kinematic capsule with Rapier's character controller; walk, sprint, crouch, jump, slide, step-up, slope limit, air control; quantized state                                                                                         | `packages/shared/src/movement/*`                                                                                          | Unit tests per feature (jump apex height, sprint speed, can't climb 50° slope, steps up 0.4 m, slide length); determinism test: same inputs twice give identical state | Biggest task. Character controller keeps internal state, so it is reset from `state` every step to keep `step()` pure                                     |
| 3   | Input capture: pointer lock (`unadjustedMovement` when supported), rebindable keys saved locally, sensitivity in degrees per mouse count                                                                                                      | `apps/client/src/input/*`                                                                                                 | Unit tests: key map → button bits; mouse counts → yaw/pitch; pitch clamped                                                                                             | Browser differences in pointer lock; fall back without `unadjustedMovement`                                                                               |
| 4   | First-person camera, FOV setting (default 90° horizontal), head bob off by default                                                                                                                                                            | `apps/client/src/camera.ts`, settings UI                                                                                  | Unit test: horizontal FOV → vertical FOV at several aspect ratios                                                                                                      | —                                                                                                                                                         |
| 5   | Protocol: `InputCmd` (carries the last 3 inputs), `Snapshot`, `SnapshotAck`; quantization helpers; `PROTOCOL_VERSION` → 2                                                                                                                     | `packages/protocol/src/{messages,quantize}.ts`                                                                            | Round-trip tests for each message; quantization error bounds; size test (12-player snapshot byte count)                                                                | Delta compression against the acked snapshot is done here only if the size test fails the 10 KB/s per player budget; otherwise it gets its own task later |
| 6   | Server `MatchRoom`: fixed 60 Hz loop with an accumulator, per-player input queue ordered by `seq`, missing input repeats last buttons (never trusts client position), 30 Hz snapshots                                                         | `apps/server/src/{MatchRoom,sim,inputQueue}.ts`                                                                           | Input queue tests (duplicates dropped, out-of-order handled, gaps repeat last buttons, queue size capped); tick-time measurement                                       | Timers drift in Node: the loop uses an accumulator, not `setInterval` ticks                                                                               |
| 7   | Client prediction + reconciliation (ring buffer of inputs/states; replay after each snapshot; blend errors < 5 cm over 100 ms, snap above); remote players interpolated 2 snapshots behind (adaptive up to 100 ms, extrapolate at most 50 ms) | `apps/client/src/net/{predictor,interpolator,clock}.ts`                                                                   | Predictor tests with a fake server; interpolator tests (between snapshots, gaps, late packets)                                                                         | Server-time estimate must be smooth; clock drift handled                                                                                                  |
| 8   | Fake-lag layer on the server transport: `pnpm dev:lag --preset good\|normal\|bad` (delay, jitter, loss per NETCODE.md)                                                                                                                        | `apps/server/src/fakeLag.ts`                                                                                              | Tests with a seeded RNG: loss rate within tolerance, delay within range                                                                                                | Loss must not reorder or drop control messages (join/leave), only fast-path messages                                                                      |
| 9   | Debug overlay (F3): ping, packet loss, server tick time, prediction error, correction counter, fps                                                                                                                                            | `apps/client/src/ui/DebugOverlay.tsx`, server stats message                                                               | Playwright: F3 shows the overlay with a ping value                                                                                                                     | Server tick time goes in snapshots (a few bytes)                                                                                                          |
| 10  | Replay test: 1,000 recorded inputs through the client predictor and the server sim, final positions within 1 cm; plus the same with simulated loss and reordering                                                                             | `packages/shared/src/movement/replay.test.ts`, `tools/bots` input recorder                                                | The test itself; runs in CI                                                                                                                                            | —                                                                                                                                                         |

Bots (in `tools/bots`) gain simple random walking in task 6 or 7, so two-tab and 12-player tests
don't need 12 people.

Each task: `pnpm typecheck && pnpm test` after, one commit, and `/review-net` (independent
reviewer) for tasks 2, 5, 6, 7 and 8.

## Exit test (from phase-1.md, plus worldwide check)

- [ ] Two browser tabs see each other move smoothly with `--preset normal`
- [ ] Also playable (no rubber-banding loops) with `--preset bad` (ADR 0002)
- [ ] Replay test: client and server final positions within 1 cm after 1,000 ticks
- [ ] Prediction corrections < 1% of the time at 120 ms (debug overlay counter)
- [ ] Server tick < 4 ms with 12 players (11 bots + 1)
- [ ] Owner has played it for 15 minutes and signed off on movement feel

## Questions for the owner

1. **Player collision:** players pass through each other in Phase 1, and collision is added
   later. OK? (Recommended.)
2. **Starting movement numbers** (all tunable later in `movement.json`): walk 5 m/s,
   sprint 7.5 m/s, crouch 2.5 m/s, jump height 1.1 m, slide 0.8 s starting at sprint speed.
   OK as a starting point?
3. **Sprint:** hold Shift by default, with a "toggle sprint" option? (Recommended.)
