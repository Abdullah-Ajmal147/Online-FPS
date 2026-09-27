# Asset pipeline

`pnpm assets` turns the source models in `assets-src/` (not in git) into the small `.glb` files
in `apps/client/public/assets/` (in git). Run it after changing a source or `build.mjs`. Every
asset is logged in `docs/LICENSES.md`.

## Getting the sources (all CC0)

Put them in `assets-src/` at the repository root:

| Folder / file                             | Download                                                                                                                |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `assets-src/universal-base-characters/`   | https://quaternius.itch.io/universal-base-characters → "Universal Base Characters[Standard].zip", unzipped, renamed     |
| `assets-src/universal-animation-library/` | https://quaternius.itch.io/universal-animation-library → "Universal Animation Library[Standard].zip", unzipped, renamed |
| `assets-src/guns/*.glb`                   | the Poly Pizza pages listed in `guns.json` (the "source" file names end in the page id)                                 |
| `assets-src/textures/<id>/`               | https://ambientcg.com/view?id=<id> → the 1K-JPG zip, unzipped (ids per theme in `surfaces.json`)                        |

## What it does

- **Bodies**: keeps position, normal, UV and skinning only; drops the 3 MB roughness maps;
  textures to 1024 px WebP; meshopt compression.
- **Animations**: keeps the clips in `CLIPS`, rotations only (plus the pelvis position): about
  420 KB for 17 clips.
- **Weapons** (`guns.json`): scaled to real length, barrel turned to -Z, centred.
- **Map surfaces** (`surfaces.json`): colour, normal (OpenGL) and roughness per material and
  theme, as WebP (`textures/<theme>/<material>/`).

The client decodes meshopt with three.js's `MeshoptDecoder`. How the soldiers are dressed,
animated and made to hold the weapons is in `apps/client/src/game/soldier/`; tune them in the
dev-only model lab at `http://localhost:5173/lab.html?view=hold` (also `dressed`, `guns`, `fp`,
`bench`).
