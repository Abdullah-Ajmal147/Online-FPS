# Project Sentinel — rules for Claude Code

Project Sentinel (working title) is an original, browser-based, Call of Duty-style
multiplayer FPS. It is NOT a clone: never use Call of Duty names, maps, factions,
weapons names, UI layouts, sounds, logos or story. Everything is original.

One developer + Claude Code build it. Work in small, tested steps.

## Where things are

- `docs/ROADMAP.md` — phases, exit tests, stack (summary of the full roadmap doc)
- `docs/PROGRESS.md` — current phase, what is done, what was learned. READ THIS FIRST every session.
- `docs/phases/phase-N.md` — tasks and exit tests for each phase
- `docs/GAME_DESIGN.md` — one-page game design
- `docs/NETCODE.md` — netcode rules (tick rates, prediction, rewind). Follow exactly.
- `docs/adr/` — architecture decisions. Don't reverse one without writing a new ADR.
- `docs/LICENSES.md` — every third-party asset with its source and license

## Stack (decided — see docs/adr/0001-web-stack.md)

- TypeScript everywhere, pnpm workspaces, Node 22 LTS, Vite
- Client: Three.js (WebGPURenderer, auto WebGL 2 fallback), HTML/CSS UI overlay (Preact)
- Physics: Rapier (`@dimforge/rapier3d-compat`), same version in client and server
- Game server: Colyseus rooms; fast input/snapshot traffic as custom binary messages
- Accounts + DB: Supabase (anonymous guest sign-in, Postgres)
- API: Hono
- Tests: Vitest, Playwright, headless bot clients in `tools/bots`

## Repo layout

```
apps/client      browser game
apps/server      Colyseus game server (authoritative)
apps/api         Hono API: profile, loadouts, progression, match results
packages/shared  simulation: movement, weapons, hit tests, constants
packages/protocol binary message encode/decode + PROTOCOL_VERSION
packages/content weapon / map / mode data (JSON + zod schemas)
tools/bots       headless bot clients
```

## Hard rules

1. **Server is the authority.** The client sends only inputs (sequence, buttons,
   view angles). The server decides movement, hits, damage, ammo, score, results.
   Never trust a position, hit or number sent by a client.
2. **`packages/shared` must be deterministic and portable.** No DOM, no Node-only
   APIs, no `Date.now()`/`performance.now()` inside simulation, no unseeded
   `Math.random`. Fixed timestep (1/60 s). Same code runs in browser and server.
3. **Content is data.** Weapon stats, maps, modes live in `packages/content`
   and are validated by schema. No weapon numbers hard-coded in logic.
4. **Every protocol change bumps `PROTOCOL_VERSION`.**
5. **Tests prove work.** Shared sim changes need Vitest tests (replay tests for
   movement/weapons). A bug fix starts with a failing test.
6. **Test under bad networks.** Netcode changes are checked with the fake-lag
   setting (default 120 ms ± 20 ms, 3% loss), not only on localhost.
7. **Performance budgets** (see ROADMAP): initial download < 15 MB, 60 fps on
   integrated GPU at Low, server tick < 4 ms for 12 players.
8. **Assets:** only CC0 / properly licensed assets; log each one in `docs/LICENSES.md`.
9. **No blood or gore** (target rating PEGI 12).

## How to work

- Start of session: read `docs/PROGRESS.md` and the current phase file.
- For any task touching more than ~5 files or any netcode/security code:
  write a short plan first and wait for approval.
- Do one task at a time. After each task run `pnpm typecheck && pnpm test`.
- Keep commits small; one task per commit, conventional commit messages
  (`feat(server): ...`, `fix(shared): ...`).
- When unsure about a design choice, ask; when a choice is made, add an ADR.
- At the end of a phase, update `docs/PROGRESS.md` (done, learned, open issues).
- Explain non-obvious netcode in code comments; the owner must be able to read it.

## Commands

- `pnpm dev` — client + server + api with hot reload
- `pnpm dev:lag` — same, with fake lag/jitter/loss on the server
- `pnpm test` — Vitest across the workspace
- `pnpm test:e2e` — Playwright browser smoke tests
- `pnpm typecheck`, `pnpm lint`
- `pnpm bots -- --count 11 --room <id>` — fill a room with bot clients
