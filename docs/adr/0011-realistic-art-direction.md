# ADR 0011 — Realistic art direction for v2 (replaces "stylized low-poly")

Date: 2026-09-26
Status: accepted (owner request: "game looks like original human", "guns, map, graphics …
original and realistic").

## Context

`docs/GAME_DESIGN.md` chose a stylized low-poly look with bright team colours: cheap to make,
readable, safe for integrated GPUs. Playtests and the owner's comparison with Counter-Strike,
Call of Duty and the browser shooters (Bullet Force, Venge) say the look is what makes people
take a shooter seriously, and browsers now handle much more: WebGPU in every major browser,
physically based materials, compressed textures.

## Decision

v2 aims for a grounded, realistic look:

- Soldiers: real human bodies (CC0 base characters) dressed in our own faction uniforms and
  gear; real weapon models (CC0) — done 2026-09-26.
- Maps: physically based materials from CC0 texture libraries, real props, sky and sun,
  baked ambient occlusion, colour grading (V2 roadmap Phase 10).
- Unchanged: original IP only (no real brands, maps or insignia), no blood or gore (PEGI 12),
  team colours stay readable (helmet bands, arm bands, patches, name tags), and the budgets —
  first download < 15 MB, 60 fps at Medium on an integrated GPU. Low keeps a light path.

## Consequences

- Assets go through `pnpm assets` (tools/assets): compression and size checks in CI.
- Higher GPU cost per scene: graphics presets must scale it (texture size, shadows, post
  effects), and heavy setup work happens while loading, never mid-match.
- Every third-party file is logged in `docs/LICENSES.md` before it is committed.
