# Phase 1 — Networked movement (≈2–3 weeks)

Goal: moving around feels good online. Server authority from the first line.

Read `docs/NETCODE.md` before starting. Plan first; this phase sets the foundation.

## Tasks

1. Greybox test map (boxes, ramps, stairs, a ledge) defined as data in `packages/content`
   and turned into both Three.js meshes and Rapier colliders by shared code.
2. `packages/shared/movement`: fixed-step (1/60 s) kinematic capsule using Rapier's
   character controller: walk, sprint, crouch, jump, slide, step-up, slope limits, air control.
   Pure function style: `step(state, input, world) -> state`.
3. Input capture in the client: pointer lock (request `unadjustedMovement` where supported),
   rebindable keys, sensitivity in degrees per mouse count.
4. First-person camera with FOV setting; head bob off by default.
5. Protocol messages: `InputCmd`, `Snapshot`, `SnapshotAck` (see NETCODE.md). Bump version.
6. Server `MatchRoom`: 60 Hz fixed loop, per-player input queues, 30 Hz snapshots.
7. Client prediction + reconciliation + smoothing; remote players interpolated.
8. Fake-lag layer on the server transport, driven by `pnpm dev:lag --preset normal`.
9. Debug overlay (F3): ping, packet loss, server tick time, prediction error, fps.
10. Replay test in Vitest: 1,000 recorded inputs through client predictor and server sim.

## Exit test

- [ ] Two browser tabs see each other move smoothly with `--preset normal`
- [ ] Replay test: client and server final position within 1 cm after 1,000 ticks
- [ ] Prediction corrections visible < 1% of the time at 120 ms (debug overlay counter)
- [ ] Owner has played it for 15 minutes and signed off on movement feel
