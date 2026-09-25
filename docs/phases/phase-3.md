# Phase 3 — Match loop + bots (≈3 weeks)

Goal: one complete, fun match of 6v6 Team Deathmatch, playable over the internet.

## Tasks

1. Mode data: TDM, 10 minutes, first to 75 kills, teams of 6. Mode rules as a pluggable
   `GameMode` interface so Domination can be added later without rewrites.
2. Match states: warm-up, countdown, live, overtime (optional), ended → results.
3. Spawn system: team spawn zones, avoid enemy line of sight, spawn protection 1.5 s.
4. HUD (HTML/CSS): health, ammo, crosshair, score, timer, kill feed, minimap later.
5. Scoreboard (Tab) and match-end screen with MVP and stats.
6. Server bots: navmesh via recast-navigation (JS/WASM), patrol, see-and-shoot with
   reaction time and aim error by difficulty, fill empty slots to 12, leave when humans join.
7. First real map blockout (original, three-lane, compact).
8. Dockerfile for server; deploy server + client to one VPS/CDN with HTTPS/WSS.
9. Server logs match summary JSON (players, kills, duration) — used later by the API.

## Exit test

- [ ] 10 full bot-filled matches in a row on the remote server, no crash, tick < 4 ms
- [ ] 5 outside playtesters play; their feedback written in `docs/playtests/`
- [ ] Two humans + 10 bots in one match works end-to-end over the internet
