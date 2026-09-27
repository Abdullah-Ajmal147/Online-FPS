# Phase 10 — Real world (graphics)

Goal: the maps stop looking like prototypes. Gameplay and collision stay exactly as they are;
only the look changes. Art direction: ADR 0011. Full v2 plan: `docs/V2_ROADMAP.md`.

## Tasks

1. [x] Real surfaces: CC0 PBR textures (colour, normal, roughness) per map material through
       `pnpm assets`; world-space texture coordinates (true scale, no stretching); containers
       painted in real container colours; map drawn as one mesh per material.
2. [x] Sky: physical sky with sun, haze and clouds per map lighting preset; filmic tone mapping.
3. [ ] Per-map texture themes (Saltline Depot: concrete depot floor, painted warehouse walls).
4. [ ] Image-based ambient light from the sky (metals reflect the sky), baked ambient occlusion
       in corners and under containers.
5. [ ] Props that make places believable: container doors and ribs, barriers, cable spools,
       lamps, pipes, signage with our own text (CC0 models, instanced).
6. [ ] Post-processing on Medium/High: bloom on lights and muzzle flashes, colour grade per map;
       screen-space AO on High only.
7. [x] Start-up: soldiers dressed and shaders compiled while loading (no hitch when the first
       enemy appears); map materials compiled before they are drawn.
8. [ ] First-person polish: the marksman rifle's left hand grip; reload and weapon-switch
       animations with the real models.

## Exit test

- [ ] Side-by-side screenshots v1 vs v2 approved by the owner
- [ ] 60 fps at Medium on the target laptop (integrated GPU), both maps
- [ ] First download still < 15 MB (checked in CI)
- [ ] No frame over 100 ms in the first minute of a match
