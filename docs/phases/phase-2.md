# Phase 2 — Gunplay (≈3–4 weeks)

Goal: shooting feels good online and hits are fair.

## Tasks

1. Weapon data schema in `packages/content` (zod): fire rate, damage by zone and range,
   magazine, reload time, spread (hip/ADS/moving), recoil pattern, ADS time, move speed multiplier.
2. Two original weapons: an automatic rifle and a sidearm (original names).
3. Shared weapon state machine: idle, firing, reloading, switching, ADS. Runs on server; client predicts.
4. Server hitboxes (head, torso, limbs) per player + 1 s transform history.
5. Server-side hitscan with rewind (NETCODE.md). Clamp rewind to 200 ms.
6. Health, damage, death, respawn after 3 s at a safe spawn.
7. Client feel: viewmodel arms + weapon (placeholder CC0 model), muzzle flash, tracers,
   impact decals, recoil camera kick, crosshair bloom, hit markers (predicted, confirmed by server),
   damage direction indicator, sounds via Howler with 3D positioning.
8. Anti-cheat basics: server drops shots faster than fire rate, with no ammo, or while reloading.
9. Bot test client in `tools/bots` that strafes and a shooter bot that aims exactly at it.

## Exit test

- [ ] Bot test at 150 ms ping: ≥ 95% of on-target shots register on the server
- [ ] A test client that fires 2× the allowed rate gets 0 extra hits
- [ ] Owner plays 30 minutes vs. a friend or a bot and signs off on feel
- [ ] All weapon numbers come from data files
