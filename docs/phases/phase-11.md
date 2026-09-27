# Phase 11 — Fast (movement and feel)

Goal: the game feels quick and responsive like the big fast shooters, without breaking the
netcode rules (server authority, deterministic shared sim, replay tests). Plan: `docs/V2_ROADMAP.md`.

Our base speeds are already quick (walk 5 m/s, sprint 7.5 m/s, slide); what is missing is
fluidity (getting over cover, bursts of speed) and a faster loop between fights.

## Tasks (in order: cheapest and safest first)

1. **Quicker loop** — respawn 3 s → 2 s in Team Deathmatch (Domination keeps 3 s: objectives
   need a real cost), as mode data instead of a server constant. Server-only; e2e timings.
2. **Hit feedback pass** (client only) — louder, crisper hit markers and sounds, a distinct
   kill confirm, small camera punch when hit, damage direction already exists. Measured with
   the audio test.
3. **Mantle** (shared sim, needs netcode review) — jumping at waist-to-chest-high cover
   (0.5–1.3 m) with forward input climbs over it in ~0.35 s instead of bumping. Deterministic
   (ray/shape casts in the Rapier world both sides already share); replay test; bots use it.
4. **Tactical sprint** (shared sim + protocol bump, needs netcode review) — double-tap sprint:
   9 m/s for up to 3 s, weapon lowered (no firing), then a 4 s cooldown. Numbers as data in
   `movement.json`.
5. **Third-person reloads and weapon switches** (protocol bump) — snapshot flags so other
   players visibly reload and switch.
6. **Input timestamps** (netcode, ADR) — CS2-style: the server orders same-tick shots by when
   they were fired within the tick, so the earlier shot wins a trade.

## Exit test

- [ ] Owner + 3 friends rate "feels fast" ≥ 4/5
- [ ] Movement replay tests exact after the sim changes; corrections < 1 % at 120 ms
- [ ] Bots mantle and tactical-sprint without getting stuck (soak)
