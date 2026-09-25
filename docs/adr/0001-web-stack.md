# ADR 0001 — Browser game on a TypeScript stack

Date: 2026-09-25
Status: accepted

## Context

The original roadmap (v1) chose Unreal Engine 5, PC-first. The product is meant to be
played in a web browser, and Unreal has no browser export. The team is one developer
working with Claude Code.

## Decision

- Browser-first, desktop keyboard + mouse; mobile later.
- TypeScript monorepo (pnpm). Three.js (WebGPURenderer with WebGL 2 fallback),
  Rapier physics shared by client and server, Colyseus game server with custom binary
  messages for the fast path, Supabase (guest auth + Postgres), Hono API.
- WebSocket transport behind an interface; WebTransport trial in Phase 8.

## Consequences

- One language and one shared simulation for client and server.
- Visual ceiling lower than Unreal; stylized art direction chosen to match.
- No kernel anti-cheat is possible; security relies on server authority and detection.
- If the game later moves to Unreal, design docs, netcode rules and the backend carry over.

## Alternatives considered

- Unreal 5.8 (PC): best visuals, official Claude Code MCP plugin, but no web.
- Babylon.js: built-in Havok physics and editor; Three.js chosen for size and code-first workflow.
- PlayCanvas: good editor, but editor-centric workflow suits Claude Code less.
