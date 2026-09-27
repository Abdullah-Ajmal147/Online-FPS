# Sentinel Strike v2 — compete with the big shooters

Owner's brief (2026-09-26): study Counter-Strike and the other big shooters; guns, maps,
graphics and everything else should look original and real; players want fast, quick play;
make v2 a plan and start on it; something to pitch to friends and pro gamers.

v1 (Phases 0–9) proved the engine: server-authoritative netcode, hit registration, bots,
progression, parties, private matches, live on https://play.remoteref.com. v2 is about
**looking and feeling like a real shooter** while keeping the one thing no big shooter has:
**a link that puts you in a match in seconds, on any computer, no install**.

## What the competition does (research, September 2026)

| Game                               | Why people play it                                                                                                             | What we take (original, never copied)                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| **Counter-Strike 2**               | Pure skill: precise gunplay, movement tricks (counter-strafing, peeking), round economy; 64-tick + "sub-tick" input timestamps | Precise, readable recoil; round-based competitive mode; input timestamps so the earlier shot wins    |
| **Valorant**                       | 128-tick servers, very tight hit registration, clean readable art, short sightlines                                            | Readability first (silhouettes, team colours), strict netcode budgets, clean map lines               |
| **Call of Duty (Black Ops 6/7)**   | Fast: sprint, slide and dive in any direction, wall jump; short time-to-kill; loadouts, perks, streaks; three-lane maps        | Fast movement (slide, mantle, tactical sprint), quick respawns, loadout depth, three-lane map design |
| **Krunker** (browser)              | Instant, very fast (slide-hopping), 16 classes, custom maps, cash tournaments, runs on anything                                | Speed and skill ceiling of movement; custom/private lobbies; community maps later                    |
| **Bullet Force / Venge** (browser) | "Console quality in a tab": real weapon models, fluid animation                                                                | Proof that realistic art in the browser sells — our soldier models are the start                     |

Research notes that shaped the plan:

- **Hit feedback and responsiveness decide whether a shooter "feels good"** — players never say
  "the hit feedback is weak", they say "boring" and leave. Input-to-screen latency matters more
  than any single feature.
- **Hit registration**: rewind with a cap (we have it, ADR 0005/0006); CS2's sub-tick input
  timestamps settle trades fairly.
- **Maps**: three lanes, each with its own range (close / mid / long), flanks connecting them,
  no single choke point that stalls play; Counter-Strike maps are loops over loops.
- **Graphics in the browser (2026)**: WebGPU is in every major browser (Safari 26); physically
  based materials + baked lighting look real at the cost of an image; CC0 texture libraries
  (Poly Haven, ambientCG) give real surfaces.

Sources: [CS2 vs Valorant (CSDB)](https://csdb.gg/cs2-vs-valorant-comparison/),
[Valorant 128-tick vs CS2 sub-tick](https://biggo.com/news/202510070716_Valorant_128_Tick_vs_CS2_Sub_Tick),
[Peeking into VALORANT's netcode (Riot)](https://technology.riotgames.com/news/peeking-valorants-netcode),
[Black Ops 7 multiplayer (GamesRadar+)](https://www.gamesradar.com/games/call-of-duty/i-played-black-ops-7-multiplayer-for-4-hours-and-heres-my-10-takeaways-you-need-to-know/),
[Omnimovement](https://callofduty.fandom.com/wiki/Omnimovement),
[Krunker slide-hopping](https://krunkerio.fandom.com/wiki/Slidehopping),
[Top browser FPS 2026 (FRVR)](https://frvr.com/blog/guides/lists/best-fps-browser-games/),
[Analyzing level layouts in competitive FPS](https://www.gamedeveloper.com/design/analyzing-level-layouts-to-improve-level-design-in-competitive-fps),
[Good FPS map design](https://critpoints.net/2018/02/18/good-fps-map-design/),
[Feedback, friction and why players stay](https://dev.to/hiroshi_takamura_c851fe71/the-invisible-conversation-feedback-friction-and-why-players-stay-4lac),
[Three.js best practices 2026](https://www.utsubo.com/blog/threejs-best-practices-100-tips).

## Where we stand (honest)

| Area                | Today                                       | Big-shooter bar                               | Gap                                           |
| ------------------- | ------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| Time to first match | ~4 s warm server                            | 1–5 min (launcher, queue)                     | **We win** — keep it                          |
| Netcode / hit-reg   | 60 Hz sim, rewind, 150/150 at 150 ms        | 64–128 tick                                   | Close; add input timestamps                   |
| Soldiers            | Real human models, faction uniforms, IK aim | Scanned, fully animated                       | Good start; reloads and hit reactions missing |
| Weapons             | Real models, sights, recoil patterns        | Detailed models, attachments visible, inspect | Attachments not drawn; no reload animation    |
| Maps                | 2 maps + arena, **flat-coloured boxes**     | Realistic, dense, lit                         | **Biggest gap**                               |
| Movement            | Sprint, slide, jump                         | + mantle, dive, wall jump, tactical sprint    | Medium                                        |
| Modes               | TDM, Domination                             | + round-based bomb mode, FFA, ranked          | Medium                                        |
| Progression         | Levels, unlocks, challenges                 | + seasons, cosmetics, store, ranked           | Medium                                        |
| Social              | Friends, parties, private matches           | + clans, spectating, replays                  | Medium                                        |

## v2 phases

Each phase ends with exit tests, like v1. Order = what players notice first.

### Phase 10 — Real world (graphics)

The maps stop looking like prototypes.

1. PBR materials for every surface class (concrete, metal, painted steel, asphalt, wood,
   corrugated panels) from CC0 libraries, resized and compressed by `pnpm assets`.
2. Lighting that sells it: sky + sun per map, image-based ambient light, baked ambient
   occlusion into vertex colours / lightmaps, tone mapping; soft shadows on High.
3. Props that make places believable (containers, crates, cable spools, barriers, pipes,
   lamps, signage with our own text) — CC0 models, instanced.
4. Post-processing on Medium/High: bloom on lights and muzzle flashes, colour grade per map,
   subtle vignette; screen-space AO on High only.
5. Relay Yard and Saltline Depot rebuilt with the new kit (same collision, same lanes: gameplay
   unchanged, look replaced).
6. Start-up: no blocky soldiers or pop-in, no hitch when the first enemy appears (shaders set up
   while loading).

Exit: side-by-side screenshots v1 vs v2 approved by the owner; 60 fps at Medium on the target
laptop; first download still < 15 MB; no frame over 100 ms in the first minute.

### Phase 11 — Fast (movement and feel)

1. Tactical sprint (double-tap), mantle over waist-high cover, slide cancel, dive; all in the
   shared deterministic sim with replay tests.
2. Quicker loop: respawn 3 s → 2 s in TDM, spawn straight into action, match join into the
   next free slot mid-match.
3. Hit feedback pass: stronger hit markers and sounds, kill confirm, damage direction,
   camera punch; weapon handling times (ADS, sprint-to-fire) tuned per class.
4. Third-person animation: reloads, weapon switch, hit reactions, mantle (needs reload/switch
   flags in snapshots: protocol bump).
5. Input timestamps (CS2-style) so the earlier shot wins a trade.

Exit: owner and 3 friends rate "feels fast" ≥ 4/5; replay tests exact; corrections < 1 % at
120 ms.

### Phase 12 — Competitive

1. Round-based objective mode (original: "Uplink" — attackers plant a relay jammer, defenders
   stop it; one life per round, round economy for weapons).
2. Free-for-all and a gun-progression party mode.
3. Ranked playlist: skill rating, placement matches, rank badges, season reset.
4. Spectator camera and match replays (we already record snapshots for the killcam).
5. Custom lobbies with rules (for tournaments and friends).

Exit: a 5v5 "Uplink" match with friends start to finish; rating moves sensibly over 20 games.

### Phase 13 — Maps

Three new maps on the Phase 10 kit, each built on the three-lane / loop rules above, one
close-quarters, one mixed, one long-range; plus a small 2v2/FFA map.

Exit: bot-soak win rates within 45–55 % per side; playtest heatmaps show all lanes used.

### Phase 14 — Store and seasons

1. Cosmetics only (never power): weapon skins, uniforms, helmets, charms, player cards.
2. Earned currency first; a free season track of rewards.
3. Real-money purchases after accounts (Supabase) and a payments decision (tax, refunds,
   age rating) — owner's call.

Exit: a full season track playable; no item changes damage, speed or visibility.

### Phase 15 — Community and esports

Clans, tournaments in custom lobbies, a creator/streamer mode (hide names, delay), map
editor later.

### Phase 16 — Mobile

Touch controls and a lighter preset in the same web app, then store wrappers.

## Budgets for v2 (unchanged unless an ADR says so)

First download < 15 MB (the world streams after the menu); 60 fps at Medium on an integrated
GPU; server tick < 4 ms for 12 players; snapshots < 10 KB/s per player.
