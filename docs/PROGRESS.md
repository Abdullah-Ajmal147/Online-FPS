# Progress

**Current phase:** 8 — Public beta (Phases 3–7: everything that doesn't need the owner's accounts or hardware is done)

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

Status: **done locally 2026-09-26**; the remaining exit tests need hosting and outside playtesters.

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
- Operations: structured JSON logs (`LOG_FORMAT`/production), Prometheus `/metrics` on game server and API (rooms, players, tick p50/p99, slow ticks, tick errors, joins, matches; guests, results, rejections, rate limits), crash → log + exit for a clean restart, graceful shutdown on SIGTERM, nav grid cached per map (room creation no longer blocks ~330 ms).
- Deployment: Caddy (automatic HTTPS) → game + API on one origin (`/api`), `docker compose` stack verified end to end locally (guest token via /api, same-origin WebSocket, bots, JSON logs); production refuses to start without a real secret. Owner steps in `docs/DEPLOY.md`.
- ~~Tick spikes~~: 0.54% of ticks were over 4 ms, almost all bot path planning (unreachable rooftop goals made A* search the whole map, and many bots re-planned on the same tick). Fixed with connected-region labelling, a 2-searches-per-tick budget and a tighter A* loop: now 0.03% (p99 1.16 ms); the worst tick is first-tick JIT warm-up.
- Snapshots send every player's position to everyone (wallhack-able): add interest management / PVS before public launch (review L7).
- Phase 4 (lite, pulled forward for the end-to-end game): API with SQLite (`node:sqlite`) — `POST /matches` accepts only HMAC-signed results from the game server, each match id once; XP (150 + 100/kill + 250 win / 100 draw) and levels (500, 750, 1000… XP) computed by the API; `GET /profiles/:guestId`. Browser keeps a random guest id (not a secure identity; Supabase replaces it in Phase 4); menu shows level/XP, refreshed after each match. E2E checks XP after a full bot match.
- Secure guest identity (replaces the unsigned guest id): `packages/auth` issues HMAC-signed guest tokens (`POST /guests`); the game server verifies them on join and only verified guests earn XP. Rate limits per IP: guest creation (burst 30, 0.5/s), profile reads, room joins (burst 20, 1/s) — generous because many players can share one IP.

## Owner playtest feedback (2026-09-25): "enemies don't die, not interesting"

Investigated with a scripted human-like player and server shot logs (client and server always
agreed on hits, so not a netcode bug). Causes and fixes:

- Hip-fire spread 2.4° (+1.4° moving) made a ~1.5 m cone at fight distance: aimed shots missed.
  → hip 0.6° (+0.4° moving), ADS exact, lighter bloom.
- Recoil climbed for the whole spray (no recovery until you stop): after 5 shots aim was 0.7 m
  high at 28 m. → smaller kicks (~0.2°), partial settle between shots (`recoil.sprayRecovery`,
  data), a full magazine climbs < 2°.
- Bots were too accurate for a casual player once spread tightened → default "normal" bots
  slower to react, bigger initial aim error, less recoil control ("hard" stays hard).
- Bots got permanently stuck beside walls (their grid cell resolved to the barrier's rooftop
  region; failed plans retried every tick and starved everyone's planning budget). By minute 7
  nobody moved. → height-aware cell lookup + back-off. Now ~40 kills/min all match.
- Few fights: bots wandered randomly → bots hunt (towards enemies 60%, centre 25%).
- Low-fps players got short rewinds (view-tick governor v2 bounded the saw-toothing gap) →
  governor v3: view tick may move forward freely, back only 0.25 tick per input.
- Engagement: kill pop-ups ("ELIMINATED … +100"), medals (First Blood, Double/Triple/Multi Kill,
  Killing Spree, Unstoppable), floating damage numbers, red crosshair over enemies, enemy hit
  flash, death fall, soldier models instead of capsules, teammate name tags, brighter map,
  ammo refilled per kill (a magazine per weapon).
- New regression test: a hip-firing, crosshair-re-centring player gets kills against bots in a
  real match (`e2e/fun.spec.ts`).

## Phase 4 — Online shell

Status: **partly done** (lite version pulled into Phase 3, see above). Blocked on the owner:
Supabase project (accounts, Postgres), Sentry and PostHog keys, a domain/hosting.

Done: signed guest identity, API with server-signed match results (forged results rejected,
tested), XP/levels from the server's result, rate limits on API and joins, menu with name,
settings (sensitivity, FOV, keybinds, graphics), profile card.

Exit tests:

- [x] Cold link → in a match in < 20 s: 4.6 s locally (Playwright measures it on every run)
- [x] A forged `POST /matches` from a client is rejected (API tests)
- [ ] XP/level on another device after linking — needs Supabase accounts
- [ ] Errors in Sentry, events in PostHog — needs the owner's keys

## Phase 5 — Content pipeline

Status: **in progress** (2026-09-26).

Tasks done:

- 2. Weapon catalog: Kestrel AR (rifle), Vireo SMG, Thresher 12 (shotgun, 8 pellets whose damage
     adds up per victim), Halberd MR (marksman, 2.5× scope zoom), Wren SP (sidearm). Weapons are data:
     a JSON file in `packages/content/src/weapons/` + `pnpm --filter @sentinel/content gen`
     (a test fails if a file isn't registered). Content hash in the join handshake: a client built
     from different content must reload.
- 3–4. Attachments (10, five slots, up to 3) and perks (5, up to 3) as JSON stat modifiers; the
  loadout editor in the menu; loadout applied at the next spawn; protocol v9.
- 5. Frag and smoke grenades simulated on the server (ADR 0008): bounces, line-of-sight blast
     damage, no team damage, self damage halved; smoke blocks bot vision and enemies fully behind
     smoke are left out of snapshots. G / Q, one each per life. Bots lob frags (normal/hard).
- 6. Second map **Saltline Depot** (dusk depot, central platform, flank warehouses,
     point-symmetric). Maps have a lighting preset. Map rotation between matches
     (`SENTINEL_MAP_ROTATION`), nav grids pre-built per room.
- 7 (part). Download budget check (`pnpm size`, in CI): 5.2 MB / 1.9 MB gzipped today.
  Hashed assets cached for a year, `index.html` never cached. A service worker was not added:
  with immutable hashed assets it adds stale-version risk for little gain.
- 8. Graphics presets Low / Medium / High + render scale (shadow quality applies at start:
     three's WebGPU shadow node can't be toggled at runtime).
- Netcode reviews after each change; all findings fixed (content drift, SetLoadout abuse,
  grenade key held through respawn, smoke leaking positions, spawn steering by smoke, map
  rotation version skew, nav build inside a tick, old-world rewinds).

Exit tests:

- [x] Adding a weapon needs only a JSON file (+ model, once there are models)
- [x] First download < 15 MB; total < 50 MB; < 1,500 files (checked in CI)
- [ ] 60 fps at Low on an integrated-GPU laptop on both maps — needs the owner's hardware
- Task 1 (glTF asset pipeline) waits for the first real models; everything is greybox today.

What we learned:

- Headless Chrome sometimes never answers `navigator.gpu.requestAdapter()`; the client now gives
  it 2 s, then uses WebGL 2. Closing a WebGL tab and opening another in the same browser
  context can fail to get a context, so e2e tests avoid that pattern.
- Parallel e2e tests on one server interfere (teams, grenades); tests that need isolation get
  their own server port.
- An edit script that silently failed once left a documented feature unimplemented; edit
  scripts now exit loudly on any mismatch.

## Phase 6 — Progression + social

Status: **done locally 2026-09-26**.

- 1–2. Unlock table as data (`progression.json`): account levels unlock weapons and perks,
  weapon levels (kills with that weapon) unlock attachments. The game server reads each
  player's unlocks from the API (signed `GET /access`) and enforces them; the menu shows locks.
- 3. Daily and weekly challenges (data), picked from the date; progress only from the game
     server's signed match stats; bonus XP once per challenge.
- 4. Party invites: a link with a server-issued invite token joins your match on your team
     (a party can lead the other team by at most 3 humans). No ready-up lobby yet.
- 5. Recent players (per browser) and friends by public player code (API shows name, level,
     day last played).
- 6. Results screen: this match's XP line by line, completed challenges, level-up.
- 7. Text chat (Enter / T for team), server-side profanity filter (normalisation, look-alike
     letters, spacing tricks, allow-list), rate limits, mute. Names are filtered too.

Exit tests:

- [x] Three people join a party by link and land on the same team (e2e)
- [x] Challenge progress only moves from server-reported stats (a forged result is rejected)
- [x] Unlock table is data; changing it needs no code change

## Phase 7 — Security + operations

Status: **done locally** (the real-server load test and restore drill need the owner's host).

Done:

- 1. Message audit (NETCODE.md table): size, rate and value checks for every client message;
     2 KB WebSocket cap.
- 2. Anti-wallhack (ADR 0009): enemies a player can't see or hear are not in their snapshots.
- 3. Stat anomaly flags per match (accuracy, headshot rate, reaction time, snap aim,
     K/D vs level), in the signed match result.
- 7. Load test (`apps/server/scripts/load.ts`): a match costs ~0.5 ms/tick, ~1 MB, 67 KB/s out;
     one process holds ~15 matches, so 50 need several processes (Redis presence; hosting
     decision).
- 8. Backups (`apps/api/scripts/backup.mjs`), restore drill as a test, `docs/RUNBOOK.md`.

- 4–6. Match logs (14 days, capped per match), report button (one report per reporter per
  match), admin page at `/api/admin` (password, lockout, same-origin writes, CSP): ban and
  shadow-ban cover the profile and a keyed hash of the IP; shadow-banned players are matched
  in their own opaque pool.

Learned: create the profile row on first join, not first match result — otherwise a banned
guest can simply make a new one before anything is stored.

Exit tests:

- [~] 50 bot matches at once, per-match cost recorded — measured locally; the target server
  type is the owner's choice
- [x] A modified client with speed hack and 2× fire-rate gains nothing (tests)
- [x] A wallhack test client receives no hidden enemy positions (tests)
- [x] Restore-from-backup drill (automated test; repeat once on the real server)

## Front end redesign + story (owner feedback, 2026-09-26)

Owner: "the first page is bulky, everything on the same page; make it look like a real game,
not made by an AI agent; add a story; the first page (start game) still has an issue."

Found by testing the first page as a player:

- The menu was one 2,300 px column (profile, challenges, invite, friends, Play, loadout,
  settings, controls). The Play button sat mid-page and the friend-code row collided with it.
- You were already spawned in a live match while reading the menu (idle target for bots,
  holding a team slot). The in-game HUD showed through behind the menu.
- DEPLOY clicked in the first second or two (engine still loading) did nothing.
- After spawning you kept looking wherever you last looked (one team faced a wall).

Now:

- Main menu with separate screens: Play (mode, next site briefing, season, today's orders),
  Loadout, Career, Squad, Intel (story), Settings (Game / Graphics / Controls). A slow
  flyover of the map runs behind it. Its own look: condensed display type from system fonts
  (nothing to download or license), signal amber, faction colours, clipped corners.
- Nothing joins until DEPLOY; a deploy screen shows the site briefing and your faction. Esc is
  a pause menu (RESUME / LEAVE MATCH); the match keeps running meanwhile. In-game HUD
  restyled to match.
- Story (`docs/STORY.md`, `lore.json`, map briefings): 2071, the Relay after the Blackout
  Winter; Aegis Directive vs Ember Syndicate; Season 0 "Static".
- Fixes: spawn faces the spawn direction; an early DEPLOY is remembered; guest creation
  race; no backdrop blur (expensive on weak GPUs). Checked in headless Chrome and in the
  owner's Chrome (menu, screens, DEPLOY → connected and spawned with bots).

## Phase 8 — Public beta

Status: **in progress**.

Done:

- 3. Domination (protocol v12): nodes A, B, C on Relay Yard and Saltline Depot (content data:
     radius 4 m, 5 s to capture, faster with more teammates, contested = frozen; 1 point per
     held node per second + 1 per kill, 200 to win). Picked on the Play screen; the server
     filters rooms by mode. Nodes shown as coloured rings/beams and A/B/C badges in the score
     bar. Bots go for nodes they don't hold.
- 7. Comms screen: patch notes (`news.json`, newest first), a feedback form (bug / idea /
     other, 1000 chars, sends build + renderer + mode, rate-limited per guest and IP, kept 180
     days, listed on the admin page), community link slot (hidden until the owner has a
     Discord). Deploy screen shows a gameplay tip.

Learned: points must be built during warm-up too (`GameMode.sync`), not only in the live
tick — otherwise the first MatchInfo has no nodes and the HUD stays empty.

<!-- Copy this block for each new phase. Claude updates it via /commit-task and /phase-done. -->
