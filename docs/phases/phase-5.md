# Phase 5 — Content pipeline (≈3–4 weeks)

Goal: new weapons and maps are data and art, not code.

## Tasks

1. Asset pipeline script: glTF → gltf-transform (meshopt, KTX2, dedupe, prune) into `apps/client/public/assets`.
   Fail the build if a file breaks the size budget.
2. Weapon catalog: 4–6 original weapons across classes (rifle, SMG, shotgun, marksman, sidearm).
3. Attachments as stat modifiers in data (optic, barrel, magazine, grip, stock), max 3 per weapon at first.
4. Loadout editor UI: primary, secondary, lethal, tactical, 3 perks (data-driven perks).
5. Equipment: frag grenade (server-simulated projectile), smoke.
6. Second original map; map data includes spawns, bounds, nav mesh, lighting preset.
7. Loading flow: menu first, map streams while the player picks a loadout; service worker caching.
8. Graphics presets Low/Medium/High + render scale; test on integrated GPU.

## Exit test

- [ ] Adding a new weapon needs only a JSON file + model (prove it by adding one)
- [ ] First download < 15 MB; total < 50 MB; < 1,500 files
- [ ] 60 fps at Low on an integrated-GPU laptop on both maps
