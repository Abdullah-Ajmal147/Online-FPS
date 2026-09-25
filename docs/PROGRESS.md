# Progress

**Current phase:** 1 — Networked movement

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
- `pnpm dev:lag --preset <good|normal|bad>` sets `SENTINEL_LAG`, but the fake-lag layer is Phase 1 task 8 (server only warns for now).

Open issues carried forward:

- Owner should confirm the delegated design choices before Phase 2 (TTK, health) and Phase 5 (factions, art).
- WebGPU backend not yet seen running (only the WebGL 2 fallback).
- Worldwide play (ADR 0002): test netcode with the `bad` preset too, not only `normal`.
- Client bundle 964 KB (271 KB gzip), mostly Three.js; fine for the 15 MB budget, split later if needed.

## Phase 1 — Networked movement

Status: in progress (plan approved 2026-09-25: no player collision, starting movement numbers, hold-to-sprint + toggle option)

Tasks done:

- 1. Greybox map + movement tuning as data (`packages/content`, zod schemas); `expandMap()` turns box/ramp/stairs primitives into solids; `buildWorld()` makes Rapier colliders; client draws the same solids. Yaw limited to quarter turns so geometry is bit-identical everywhere.
- 2. Deterministic movement `step(state, input, ctx, body)` in `packages/shared/movement`: walk/sprint/crouch/jump/slide, autostep 0.4 m, 45° slope limit, wall sliding, air control; float32 state (ADR 0003), `detSinCos` instead of Math.sin. Netcode review fixed: crouch-spam slides (sprint required + 0.6 s cooldown), bunny-hop speed kept only for one slide-jump, server clamps pitch and masks buttons.
- 3. Input: pointer lock (raw `unadjustedMovement` where supported), rebindable keys (crouch on C, not Ctrl: Ctrl+W closes the tab), sensitivity in °/count, hold or toggle sprint; settings saved per browser.
- 4. First-person camera: horizontal FOV setting (default 90°), head bob off by default, crouch eye height eased. Local practice mode runs the shared `step()` at a fixed 60 Hz with render interpolation (becomes client prediction in task 7).

<!-- Copy this block for each new phase. Claude updates it via /commit-task and /phase-done. -->
