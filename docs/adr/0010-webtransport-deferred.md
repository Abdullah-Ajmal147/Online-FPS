# ADR 0010 — WebTransport deferred; WebSocket stays the only transport for the beta

Date: 2026-09-26
Status: accepted (Phase 8 task 5, deferred).

## Context

Phase 8 lists a WebTransport datagram transport behind the `Transport` interface, A/B tested
against WebSocket. Datagrams avoid head-of-line blocking: one lost packet no longer holds back
the snapshots behind it, which matters at the 3% loss we test with.

What it needs:

- An HTTP/3 (QUIC) endpoint with a real TLS certificate (browsers refuse self-signed ones
  except through certificate hashes, valid for at most 14 days). Colyseus 0.18 has no
  production-ready WebTransport transport for Node; it would mean a separate QUIC server.
- UDP open end to end on the host (Edgegap or other: the owner's hosting decision), and a
  fallback for networks that block UDP (many schools and offices), so WebSocket stays anyway.
- Safari support is still partial, so a sizeable share of players would stay on WebSocket.

## Decision

Keep WebSocket as the only transport for the public beta. The protocol already tolerates
loss the way datagrams would need (full snapshots, ADR 0004; redundant input history, see
NETCODE.md), so switching later is a transport change, not a protocol change.

Revisit when: hosting is chosen and allows UDP, and beta data (dashboard: median ping and
crash-free by region) shows loss-driven problems — e.g. many sessions above 100 ms or
players reporting rubber-banding on good connections.

## Consequences

- No A/B test in this phase; the exit tests don't depend on it.
- Players on lossy connections see occasional stalls of one round trip after a lost packet
  (TCP retransmit). Measured under `pnpm dev:lag` (3% loss): playable, corrections stay rare.
