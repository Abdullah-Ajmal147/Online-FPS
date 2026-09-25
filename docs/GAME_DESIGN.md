# Game design — one page

## Pitch

A fast, fair, free browser FPS: click a link, land in a 6v6 match in under 20 seconds,
with gunplay and movement that feel as good as a console shooter.

## Pillars

1. **Instant** — no install, no login wall, fast loads.
2. **Fair** — server decides everything; good hit registration at normal pings.
3. **Tight gunplay** — readable recoil, clear hit feedback, fast time-to-kill.
4. **Always a match** — bots fill every lobby.

## Name

**Sentinel Strike** (decided 2026-09-25). Run a trademark and domain check before the
public beta (Phase 8); the name only appears in UI strings, so a change stays cheap.

## Setting (original IP)

Near-future, fictional factions. Stylized low-poly look, clean readable silhouettes,
bright team colors. No blood or gore (target PEGI 12).

- **Aegis Directive** (team color: blue): a disciplined private security force that protects
  the world's automated cities. Clean armor, hard edges, cool lighting.
- **Ember Syndicate** (team color: orange): a network of engineers and salvagers who took
  control of abandoned infrastructure. Patched gear, warm lighting, asymmetric shapes.

Blue vs orange stays readable for the most common kinds of colour blindness; silhouettes
and a team marker above allies must also tell teams apart without colour.

## Core loop

Menu → Quick Play → 10-min Team Deathmatch → results + XP → unlocks → play again.

## Launch content (beta)

- Modes: Team Deathmatch (6v6), Domination
- Maps: 2 compact three-lane maps
- Weapons: 5–6 (rifle, SMG, shotgun, marksman, sidearm) + attachments
- Equipment: frag, smoke
- Progression: account level 1–50, weapon levels, daily/weekly challenges

## Movement

Walk, sprint, crouch, jump, slide. Mantle later.

## Combat rules (decided 2026-09-25)

- **Time-to-kill: medium-fast.** 100 HP; rifles kill in 4–5 body shots, about 0.40–0.50 s at
  close range (tune in Phase 2). Deliberately not the fastest arcade TTK: players join from
  all over the world, and a slightly longer TTK makes deaths behind cover rarer at high ping.
- **Health regeneration.** Health starts refilling 4 s after the last damage taken and is
  full about 2 s later. There are no health packs: maps stay small and the pace stays high.
- **No killstreak rewards at launch.** They add balancing work and punish new players.
  Revisit after the beta, and only as non-lethal score rewards (for example a short
  radar-style "recon pulse"), with original names.

## Players and regions (decided 2026-09-25, see ADR 0002)

The game is for players everywhere, not one region.

- Launch servers in three regions: **EU (Frankfurt)**, **NA East (Virginia)** and
  **Asia (Singapore)**. Together they cover Europe, the Americas, the Middle East, and
  South and East Asia at playable pings.
- Add NA West, South America (São Paulo), India (Mumbai) and Oceania (Sydney) when
  player numbers there justify it.
- Quick Play measures ping to every region and picks the lowest; bots fill matches,
  so a region with few players still starts matches quickly.
- English at launch. All UI text lives in string tables so translation needs no code change.
- Accessibility: rebindable keys, colour-blind-safe team colours, subtitles for voice lines.

## Open questions for the owner

- [x] Final name and the two faction names: Sentinel Strike; Aegis Directive vs Ember Syndicate
- [x] Time-to-kill: medium-fast (4–5 rifle shots, ~0.4–0.5 s)
- [x] Health regeneration or health packs? Regeneration
- [x] Killstreak-style rewards at launch, or not until later? Later, non-lethal only
- [x] Which regions first? Worldwide: EU, NA East, Asia (Singapore) at launch; more later

The owner delegated these choices to Claude on 2026-09-25 ("this game will be played all
over the world"). All of them can be changed; say so before Phase 2 (TTK, health) or
Phase 5 (factions, art).
