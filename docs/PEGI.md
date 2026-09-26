# Content rating self-check (target PEGI 12)

Checked 2026-09-26 against the PEGI content descriptors and the CrazyGames content rules.
Repeat before every portal submission and when content changes (new weapons, maps, chat).

| Area                    | What the game has                                                                                                                                                                                                                      | PEGI 12 fit                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Violence                | Firearms and grenades against human-like soldiers; stylized low-detail figures, no blood, no gore, no dismemberment, no ragdoll lingering (bodies vanish). Hits show a white marker and a red screen-edge arc only for the player hit. | Fits "non-realistic violence towards human-like characters" (PEGI 12). Realistic graphic violence would be 16. |
| Fear / horror           | None.                                                                                                                                                                                                                                  | OK                                                                                                             |
| Bad language            | None in game text. Player chat: server-side filter (`packages/content/src/chat.json`), mute, report.                                                                                                                                   | OK (user content is filtered; online-interaction notice applies)                                               |
| Discrimination          | None. The two factions are fictional organisations, not real groups, countries or ethnicities.                                                                                                                                         | OK                                                                                                             |
| Drugs, alcohol, tobacco | None.                                                                                                                                                                                                                                  | OK                                                                                                             |
| Sex / nudity            | None.                                                                                                                                                                                                                                  | OK                                                                                                             |
| Gambling                | None: no loot boxes, no random paid rewards.                                                                                                                                                                                           | OK                                                                                                             |
| In-game purchases       | None (all unlocks are earned by playing).                                                                                                                                                                                              | OK                                                                                                             |
| Online interaction      | Text chat and player names. Filter, mute, report, admin review, bans.                                                                                                                                                                  | Needs the "in-game interactions" notice where the portal asks for it.                                          |

Rules this depends on (CLAUDE.md hard rule 9, no blood or gore): keep the white hit marker,
no red particles on hits, no body persistence. Any new weapon or effect gets checked here.

## CrazyGames Basic Launch checklist

- [x] Portal build: `pnpm --filter @sentinel/client build:crazygames` → `apps/client/dist-crazygames`
      (relative asset paths; SDK loaded from their CDN at runtime; missing SDK is harmless).
- [x] Size: `node scripts/size-budget.mjs dist-crazygames` (currently ~5.4 MB, 1.9 MB gzipped; 5 files).
- [x] SDK events: loading stop when the engine is ready; gameplay start/stop around actual play
      (menus and pause are not gameplay); happy time on a won match.
- [x] No external links in the portal build (community link hidden).
- [x] Guest play without sign-up; keyboard + mouse; pointer lock on click.
- [ ] Owner: CrazyGames developer account, game page, submit the build.
- [ ] Owner: game server and API reachable over HTTPS from their domain (VITE_SERVER_URL or
      VITE_REGIONS, VITE_API_URL at build time); check the SDK calls against their current docs.
