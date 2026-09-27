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
| Asphalt 026 C (Relay Yard ground)                               | `apps/client/public/assets/textures/yard/floor/`                      | https://ambientcg.com/view?id=Asphalt026C              | ambientCG  | CC0 1.0                 | 2026-09-26 |
| Concrete 031 (Relay Yard walls)                                 | `apps/client/public/assets/textures/yard/wall/`                       | https://ambientcg.com/view?id=Concrete031              | ambientCG  | CC0 1.0                 | 2026-09-26 |
| Corrugated Steel 005 (containers, props)                        | `apps/client/public/assets/textures/*/prop/`                          | https://ambientcg.com/view?id=CorrugatedSteel005       | ambientCG  | CC0 1.0                 | 2026-09-26 |
| Diamond Plate 008 C (ramps)                                     | `apps/client/public/assets/textures/*/ramp/`                          | https://ambientcg.com/view?id=DiamondPlate008C         | ambientCG  | CC0 1.0                 | 2026-09-26 |
| Metal Walkway 009 (stairs)                                      | `apps/client/public/assets/textures/*/stairs/`                        | https://ambientcg.com/view?id=MetalWalkway009          | ambientCG  | CC0 1.0                 | 2026-09-26 |
| Metal Plates 013 (Relay Yard platforms)                         | `apps/client/public/assets/textures/yard/platform/`                   | https://ambientcg.com/view?id=MetalPlates013           | ambientCG  | CC0 1.0                 | 2026-09-26 |
| Concrete 044 B (Saltline Depot floor)                           | `apps/client/public/assets/textures/depot/floor/`                     | https://ambientcg.com/view?id=Concrete044B             | ambientCG  | CC0 1.0                 | 2026-09-26 |
| Corrugated Steel 007 A (Saltline Depot walls)                   | `apps/client/public/assets/textures/depot/wall/`                      | https://ambientcg.com/view?id=CorrugatedSteel007A      | ambientCG  | CC0 1.0                 | 2026-09-26 |
| Concrete 034 (Saltline Depot platforms)                         | `apps/client/public/assets/textures/depot/platform/`                  | https://ambientcg.com/view?id=Concrete034              | ambientCG  | CC0 1.0                 | 2026-09-26 |

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
