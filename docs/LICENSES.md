# Third-party assets and licenses

Every model, texture, sound, font and animation not made by us goes here BEFORE it is committed.

| Asset                                                           | File path                                                             | Source URL                                             | Author     | License                 | Date added |
| --------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ | ---------- | ----------------------- | ---------- |
| Soldier bodies (Superhero male + female, Standard/free version) | `apps/client/public/assets/characters/soldier-m.glb`, `soldier-f.glb` | https://quaternius.itch.io/universal-base-characters   | Quaternius | CC0 1.0                 | 2026-09-26 |
| Animations (17 of the 45 free clips)                            | `apps/client/public/assets/characters/animations.glb`                 | https://quaternius.itch.io/universal-animation-library | Quaternius | CC0 1.0                 | 2026-09-26 |
| Assault rifle (Kestrel AR model)                                | `apps/client/public/assets/weapons/rifle.glb`                         | https://poly.pizza/m/fpLucho45C                        | Quaternius | CC0 1.0 (Public Domain) | 2026-09-26 |
| Submachine gun (Vireo SMG model)                                | `apps/client/public/assets/weapons/smg.glb`                           | https://poly.pizza/m/7ehatxr7FY                        | Quaternius | CC0 1.0 (Public Domain) | 2026-09-26 |
| Shotgun (Thresher 12 model)                                     | `apps/client/public/assets/weapons/shotgun.glb`                       | https://poly.pizza/m/DcNE0HVdW8                        | Quaternius | CC0 1.0 (Public Domain) | 2026-09-26 |
| Sniper rifle (Halberd MR model)                                 | `apps/client/public/assets/weapons/marksman.glb`                      | https://poly.pizza/m/i65hEldsw6                        | Quaternius | CC0 1.0 (Public Domain) | 2026-09-26 |
| Pistol (Wren SP model)                                          | `apps/client/public/assets/weapons/sidearm.glb`                       | https://poly.pizza/m/52kQzphmeF                        | Quaternius | CC0 1.0 (Public Domain) | 2026-09-26 |

The files above are optimized copies made by `pnpm assets` (tools/assets): meshes compressed,
textures resized to WebP, unused clips and tracks removed. The original downloads are not in the
repository (see `tools/assets/README.md`).

Allowed by default: CC0, CC-BY (credit in game), purchased licenses that allow use in games.
Not allowed: anything ripped from other games, "free" assets without a stated license.

## Original assets made in this repo (no third-party license)

| Asset                                                                            | File path                                           | Made from                                                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Logo mark / favicon                                                              | `apps/client/public/favicon.svg`                    | hand-written SVG (same shape as the menu wordmark)                                             |
| Link-preview card                                                                | `apps/client/public/og.png`                         | `tools/brand/og-card.html`, rendered by `tools/brand/render.mjs` (system fonts)                |
| Music "Static" and all sound effects                                             | `apps/client/src/audio/`                            | generated at runtime with Web Audio (no audio files)                                           |
| Faction uniforms, camouflage and gear (helmets, plate carriers, pouches, radios) | `apps/client/src/game/soldier/outfit.ts`, `camo.ts` | built in code from simple shapes and a procedural camo painter, fitted to the CC0 bodies above |
