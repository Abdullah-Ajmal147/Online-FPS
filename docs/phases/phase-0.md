# Phase 0 — Setup (≈1 week)

Goal: a repo Claude Code can work in safely, with tests and CI from day one.

## Tasks

1. pnpm workspace with `apps/client`, `apps/server`, `apps/api`, `packages/shared`,
   `packages/protocol`, `packages/content`, `tools/bots`. Strict TypeScript, shared tsconfig base.
2. ESLint + Prettier. Root scripts: `dev`, `dev:lag`, `test`, `test:e2e`, `typecheck`, `lint`, `bots`.
3. `apps/client`: Vite + Three.js. Render a spinning cube with WebGPURenderer
   (log which backend is active: WebGPU or WebGL 2).
4. `apps/server`: Colyseus server with an empty `MatchRoom`; health endpoint `/healthz`.
5. `apps/api`: Hono with `/healthz`.
6. `packages/protocol`: `PROTOCOL_VERSION = 1` and a tiny binary writer/reader
   (DataView based) with Vitest round-trip tests.
7. Client connects to the room and shows "connected, protocol v1" in the corner.
8. Vitest across the workspace; one Playwright test that opens the client and
   checks the "connected" text.
9. GitHub Actions: install, lint, typecheck, test, build.
10. Fill `docs/GAME_DESIGN.md` with the owner (ask them the open questions in it).

## Exit test

- [ ] `pnpm dev` starts all three apps; the browser shows the cube and "connected, protocol v1"
- [ ] `pnpm test` and `pnpm test:e2e` pass locally
- [ ] CI is green on a push
- [ ] `docs/PROGRESS.md` updated
