# Progress

**Current phase:** 3 — Match loop + bots

## Phase 0 — Setup

Status: **done 2026-09-25**

Tasks done:

- 1. pnpm workspace: `apps/{client,server,api}`, `packages/{shared,protocol,content}`, `tools/bots`; strict shared `tsconfig.base.json`
- 2. ESLint (flat config, typescript-eslint) + Prettier; root scripts `dev`, `dev:lag`, `test`, `test:e2e`, `typecheck`, `lint`, `bots`, `build`.
     ESLint blocks `window`/`document`/`performance`/`process`/`Date.now`/`Math.random` in `packages/shared` (rule 2).
- 3. Client: Vite + Three.js `WebGPURenderer` spinning cube; logs and shows active backend (WebGPU / WebGL 2)
- 4. Server: Colyseus `MatchRoom` (`match`), max 12 players, rejects wrong `protocolVersion` with `RELOAD_REQUIRED`; `GET /healthz` on :2567
- 5. API: Hono `GET /healthz` on :8787
- 6. Protocol: `PROTOCOL_VERSION = 1`, DataView `BinaryWriter`/`BinaryReader`, binary `Hello` message; round-trip tests
- 7. Client joins the room and shows "connected, protocol v1" after the server's binary `Hello` arrives
- 8. Vitest across workspace (17 tests); Playwright test checks the "connected" text and the renderer backend
- 9. `.github/workflows/ci.yml`: install, lint, typecheck, test, build, e2e. Green on GitHub (github.com/Abdullah-Ajmal147/Online-FPS).
- 10. `docs/GAME_DESIGN.md` filled. The owner delegated the choices (worldwide audience): Sentinel Strike; Aegis Directive vs Ember Syndicate; medium-fast TTK; health regen; no killstreaks at launch; EU + NA East + Asia regions (ADR 0002).
- Also: `packages/content` has a zod `ModeSchema` + Team Deathmatch data; `tools/bots` joins N idle bots.

Exit tests:

- [x] `pnpm dev` starts all three apps; the browser shows the cube and "connected, protocol v1" (checked in Chrome)
- [x] `pnpm test` and `pnpm test:e2e` pass locally
- [x] CI is green on a push
- [x] `docs/PROGRESS.md` updated

What we learned:

- Tooling versions: Node 22.23 LTS, pnpm 12.6, TypeScript 6.0 (TS 7 is not supported by typescript-eslint yet), Vite 8, Vitest 5, Colyseus 0.18 (`@colyseus/core` + `@colyseus/ws-transport`, client `@colyseus/sdk`), Three 0.186.
- pnpm 12 uses `allowBuilds:` in `pnpm-workspace.yaml` (not `onlyBuiltDependencies`).
- Workspace packages export TypeScript source (`.ts` import extensions); server/api bundle them with tsdown (`noExternal: /^@sentinel\//`).
- Portable packages compile without DOM/Node libs; `packages/protocol/src/globals.d.ts` declares only TextEncoder/TextDecoder.
- Playwright must launch servers directly (not via `pnpm --filter … dev` / `tsx watch`), or it hangs on shutdown.
- Bug fixed: HUD stayed on "connecting…" when updates arrived before Preact's `useEffect` subscribed (always in hidden tabs). `subscribe()` now calls the listener immediately.
- Run `pnpm lint` after editing docs too: Prettier checks Markdown, and CI caught an unformatted PROGRESS.md.
- Headless Chromium and the Chrome used for testing ran the WebGL 2 fallback; WebGPU path still needs a check in a WebGPU-enabled browser.
- Chrome automation tabs report `visibilityState: hidden`: no animation frames and no pointer lock, so the game can't be play-tested there; use Playwright (headless is visible to itself) for scripted play sessions.
- Headless Chromium renders in software here (~4 fps with two pages): client catch-up bursts overflowed the old input-queue cap of 8 and caused corrections; cap raised to 20 (15-tick burst + 2 queued).
- `pnpm dev:lag --preset <good|normal|bad>` sets `SENTINEL_LAG`, but the fake-lag layer is Phase 1 task 8 (server only warns for now).

Open issues carried forward:

- Owner should confirm the delegated design choices before Phase 2 (TTK, health) and Phase 5 (factions, art).
- WebGPU backend not yet seen running (only the WebGL 2 fallback).
- Worldwide play (ADR 0002): test netcode with the `bad` preset too, not only `normal`.
- Client bundle 964 KB (271 KB gzip), mostly Three.js; fine for the 15 MB budget, split later if needed.

## Phase 1 — Networked movement

Status: **done 2026-09-25** (plan approved 2026-09-25: no player collision, starting movement numbers, hold-to-sprint + toggle option)

Tasks done:

- 1. Greybox map + movement tuning as data (`packages/content`, zod schemas); `expandMap()` turns box/ramp/stairs primitives into solids; `buildWorld()` makes Rapier colliders; client draws the same solids. Yaw limited to quarter turns so geometry is bit-identical everywhere.
- 2. Deterministic movement `step(state, input, ctx, body)` in `packages/shared/movement`: walk/sprint/crouch/jump/slide, autostep 0.4 m, 45° slope limit, wall sliding, air control; float32 state (ADR 0003), `detSinCos` instead of Math.sin. Netcode review fixed: crouch-spam slides (sprint required + 0.6 s cooldown), bunny-hop speed kept only for one slide-jump, server clamps pitch and masks buttons.
- 3. Input: pointer lock (raw `unadjustedMovement` where supported), rebindable keys (crouch on C, not Ctrl: Ctrl+W closes the tab), sensitivity in °/count, hold or toggle sprint; settings saved per browser.
- 4. First-person camera: horizontal FOV setting (default 90°), head bob off by default, crouch eye height eased. Local practice mode runs the shared `step()` at a fixed 60 Hz with render interpolation (becomes client prediction in task 7).
- 5. Protocol v2: `InputCmd` (last 3 inputs + ack, 30 bytes), `Snapshot` (own state exact float32 per ADR 0003, others at 1/64 m; 12 players ≈ 7.6 KB/s, no delta compression needed), `SnapshotAck`, `Ping`/`Pong`. Decoder rejects malformed client bytes.
- 6. Server: 60 Hz accumulator loop, 30 Hz snapshots, per-player `InputQueue` (seq order, duplicates dropped, start buffer 2, cap 20, exactly one step per tick so flooding gains nothing). 12-player tick ≈ 0.5 ms.
- 7. Client prediction + reconciliation (exact-match fast path, blend < 5 cm over 100 ms, else snap), remote interpolation 2 snapshots behind (adaptive to 100 ms, ≤ 50 ms extrapolation), input pacing on server queue depth. Bots now wander with inputs only.
- 8. Fake lag (`pnpm dev:lag --preset good|normal|bad`, server-side): per-direction FIFO delay with jitter, loss on fast-path messages only, seeded. Predictor moved to `packages/shared` so bots run real prediction; `pnpm bots -- --count 11 --duration 60` prints the correction rate. Measured with 11 bots: **normal 0.08%**, **bad 0.94%** corrections (target < 1%).
- 9. F3 debug overlay: fps, ping, snapshot loss, server tick time, correction %, last error, server input-queue depth, interpolation delay, players seen.
- 10. Replay test (`apps/server/src/replay.test.ts`): 1,000 inputs recorded from a real bot session (`pnpm bots -- --record`) through the client predictor and the server `MatchSim` at ~130 ms RTT: **exact match, zero corrections**; within 1 cm with 10% input + 10% snapshot loss. It caught three join-time bugs (fixed): idle steps during the start buffer, offline seqs rejected as garbage, practice history replayed after spawn.
- Netcode review of tasks 5–10 fixed: catch-up "debt" drops inputs already simulated with a guess (keeps presses) so a hitch no longer moves you twice or adds seconds of lag; silent clients stop after 250 ms; 150 msg/s limit + ping limit; SnapshotAck handler; range-checked binary writes; slide timers capped to fit u8; spawn required per team; replay runs through the wire format with 11 real players in the path; remote teleports snap; disconnect returns to practice mode. ADR 0004: full snapshots (no delta compression) within budget. Re-measured: normal 0.03% corrections.

Exit tests:

- [x] Two browser tabs see each other move (Playwright e2e `two players in two tabs see each other move`)
- [x] Replay test: exact match after 1,000 recorded inputs (limit was 1 cm)
- [x] Prediction corrections < 1% at 120 ms: 0.03% with 11 bots (`bad` preset 0.94%)
- [~] Owner sign-off on movement feel: signed off in offline practice ("movement feels good"); owner asked to continue to an end-to-end game, online re-check still open

What we learned:

- Rounding the simulation to the 1/64 m wire grid would have broken speeds and diagonals; float32 state + exact own-state snapshots gives exact prediction (ADR 0003).
- Rapier's character controller stalls if gravity pushes the capsule into its skin while grounded; don't push down when grounded, rely on snap-to-ground. Keep velocity and clip it against wall normals instead of deriving it from the moved distance (stairs braked every step otherwise).
- The replay test was worth it: it found three join-time bugs no unit test did.
- One server step per tick is the anti-speedhack rule, but guessed ticks must be "paid back" when late inputs arrive, or hitches double-move the player and leave seconds of queue lag.
- Headless Chromium renders in software here (~4 fps): use bots for netcode measurements, Playwright for functional checks.

Open issues carried forward:

- Owner online movement-feel check (two tabs, `pnpm dev:lag --preset normal`).
- `weaponSlot` must be range-checked once weapons exist (review L8).
- Cross-browser determinism (Firefox/WebKit state hash vs Node) not yet tested (ADR 0003).
- WebGPU path still not seen running.

## Phase 2 — Gunplay

Status: **done 2026-09-25**. The owner asked for a complete end-to-end game and delegated
decisions (2026-09-25), so Phases 2–3 continue without per-task approval stops; decisions go in ADRs.

Tasks done:

- 1–2. Weapon schema (zod) and two original weapons as data: **Kestrel AR** (600 rpm auto, 22 torso → 5 shots / 0.4 s) and **Wren SP** (semi sidearm). Loadout = [rifle, sidearm].
- 3. Shared weapon state machine (`packages/shared/combat`): fire rate, ammo, reload (auto on empty), switching, ADS, deterministic recoil pattern (recovers only after you stop firing) and bloom; runs on server, predicted on client; `stepSim` = movement + weapon, ADS slows movement.
- 4–5. Hitboxes (head sphere, torso and legs capsules) + 1 s history; server hitscan rewinds to the client's `viewTick` clamped to 200 ms (ADR 0005), walls block, server-side random spread, damage falloff, no friendly fire.
- 6. Health 100, death, respawn after 3 s at the team spawn farthest from enemies, regen after 4 s; falling out of the map kills.
- 7 (greybox version). Procedural viewmodel (kick, ADS, reload dip, switch), muzzle flash, tracers, impact marks, recoil on camera, spread-driven crosshair, predicted + confirmed hit markers, damage direction arcs, kill feed, death screen, synthesized Web Audio with 3D positioned remote shots (no asset files; ADR pending in Phase 5 for real assets).
- 8. Anti-cheat basics are the shared weapon rules on the server: a client firing at 2× rate gets no extra shots (unit test).
- Protocol v3: inputs carry `viewTick`, own block carries weapon + health + lifeId, entities carry alive/weapon/shot counter (int16 positions, ADR 0004 update), reliable `Events` (kill/hit/damaged). E2E: two browsers, one shoots the other, server confirms hits.
- 9. Bots: shared `Bot` client (prediction + interpolation like a browser), `--mode duel` = strafing target + aim bot that aims at the target as drawn and counts on-target shots vs server hit confirmations. Server can run a map from `SENTINEL_MAP` (Hello carries the map id, protocol v4) and test-only `SENTINEL_TEST_NO_DEATH`.
- Fixes found by the hit-registration test: rewind cap 200 → 300 ms (ADR 0006: real rewind = RTT + interp + input buffer ≈ 283 ms at 150 ms); respawn replays in-flight inputs (was 3% corrections for a dying player); bloom suppressed to 15% while aiming (sprays were randomly missing).

Exit tests:

- [x] Bot test at 150 ms ping: **150/150 = 100%** of on-target shots registered (arena, 60 s, 3% loss); corrections 0%. For reference, `bad` preset (261 ms): 22% — beyond the 300 ms cap, players that far need a closer region.
- [x] A test client firing at 2× the allowed rate gets 0 extra shots (unit test)
- [~] Owner plays 30 minutes and signs off on feel — owner asked to continue to the end-to-end game; playtest with the finished match loop
- [x] All weapon numbers come from data files (`packages/content/src/weapons/*.json`)

What we learned:

- Measure before trusting formulas: NETCODE's `rtt/2 + interp` rewind left out the snapshot's one-way age; the bot duel exposed it in one run.
- Separate netcode from game design in tests: spread, bloom and shots at already-dead targets all looked like "hit-reg failures" until isolated.
- Prettier reformats code between edits; scripted exact-text edits must re-read the file (a tolerant edit helper now reports misses instead of silently skipping).

Open issues carried forward:

- Rewind cap for high-ping regions (300 ms) — tune with playtests; consider region-based matchmaking first.
- Real weapon/character models and sounds (Phase 5 content pipeline; licenses in docs/LICENSES.md).
- Owner feel sign-off for movement and gunplay (online).

## Phase 3 — Match loop + bots

Status: in progress (owner delegated decisions; continuing without per-task stops).

Tasks done:

- 1. `GameMode` interface + Team Deathmatch (10 min / 75 kills from mode data); suicides and falls score nothing.
- 2. Match loop: warm-up (needs 2+ players) → countdown (everyone respawned, frozen) → live → ended (frozen, results, MVP) → next match. `MatchInfo` message (protocol v5) at 2 Hz + on phase change.
- 3. Spawns: team spawn not visible to any living enemy if possible, else farthest from enemies; 1.5 s spawn protection ended early by firing.
- 4–5. HUD: score bar + clock, warm-up/countdown banners, Tab scoreboard (names, K/D, BOT tags), results screen (Victory/Defeat/Draw, MVP, table); names chosen in the menu, sanitized on the server.
- 6. Server bots (ADR 0007: nav grid instead of recast): 1 m nav grid from the physics world + A*; roam, spot enemies (FOV + line of sight), react after a delay, aim with shrinking error and limited turn rate, partial recoil control, strafe, ADS at range, reload; difficulty easy/normal/hard. Fill to 12, keep teams even, swap a bot out when a human joins.
- 7. First real map **Relay Yard** (original, 44×68 m, three lanes, central platform with ramps, balcony with stairs/ramp, spawn barriers). Default map.
- 8 (local part). `Dockerfile` (Debian trixie base: pnpm 12's native binary segfaults on bookworm) + `docker-compose.yml`: the game server serves the built client on :2567, API on :8787 with SQLite on a volume. Verified: compose up → page loads from the game server, joins, 11 bots, profile card. CI builds the image. Remote VPS/HTTPS deploy needs the owner's hosting account.
- 9. Match summary JSON logged at match end (`[match-summary] {...}`).
- Tests: full bots-only match on Relay Yard in-process (fights, winner, MVP, < 4 ms/tick); e2e full match flow against a bot-filled server with 20 s matches.
- Netcode review of Phases 2–3 fixed: **C1** a crafted InputCmd (seq near 2^32) crashed the whole process → decoder rejects it, and a failing tick is now logged and skipped (30 in a row close only that room); **H1** view-tick "backtrack" cheat → per-player governor (ADR 0005 amendment); **H2** production refuses to start without a real `SENTINEL_API_SECRET` (compose requires it); **H3** one XP seat per guest (server + API); **M1** same-tick trades both count; **M2** guessed ticks keep a held trigger ≤ 3 ticks and never reload; **M3** humans spread across teams; **M4** XP needs ≥ 60 s played (or ¼ of a short match), leavers keep their stats; **M5** `?server=`/`?api=` only in dev or for allow-listed hosts; lows: schema bounds, client skips frozen/dead ticks like the server, hitbox history kept across respawn, cached spawn/nav work, "Bot " name prefix reserved. Hit-reg re-measured: 150/150 at 150 ms.
- Soak (`apps/server/scripts/soak.ts`): 10 full bot-filled TDM matches back to back on Relay Yard, no crash; every match went to 75 kills (~145 kills, 6.5–8.5 min each); tick median 0.32 ms, p99 2.7 ms, one 47 ms spike (GC/JIT warm-up, to watch).

Exit tests:

- [~] 10 full bot-filled matches, no crash, tick < 4 ms — **passed locally** (in-process soak); the remote-server run needs the owner's VPS/Fly.io account
- [ ] 5 outside playtesters, feedback in `docs/playtests/` — needs the owner
- [ ] Two humans + 10 bots over the internet — needs hosting (works locally: e2e two players, and bots fill to 12)

Open issues carried forward:

- ~~Balance: team 1 won 8/10 on the asymmetric Relay Yard~~ → map made point-symmetric (test-enforced); re-run 4/6.
- Deploy to a VPS/Fly.io with HTTPS/WSS (owner account), then run the exit tests remotely.
- 47 ms worst-case tick spike in the soak: add tick-time monitoring (Phase 7).
- Snapshots send every player's position to everyone (wallhack-able): add interest management / PVS before public launch (review L7).
- Phase 4 (lite, pulled forward for the end-to-end game): API with SQLite (`node:sqlite`) — `POST /matches` accepts only HMAC-signed results from the game server, each match id once; XP (150 + 100/kill + 250 win / 100 draw) and levels (500, 750, 1000… XP) computed by the API; `GET /profiles/:guestId`. Browser keeps a random guest id (not a secure identity; Supabase replaces it in Phase 4); menu shows level/XP, refreshed after each match. E2E checks XP after a full bot match.
- Secure guest identity (replaces the unsigned guest id): `packages/auth` issues HMAC-signed guest tokens (`POST /guests`); the game server verifies them on join and only verified guests earn XP. Rate limits per IP: guest creation (burst 30, 0.5/s), profile reads, room joins (burst 20, 1/s) — generous because many players can share one IP.

<!-- Copy this block for each new phase. Claude updates it via /commit-task and /phase-done. -->
