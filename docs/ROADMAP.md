# Roadmap summary (v2)

The full roadmap with reasons, risks and sources is the "Project Sentinel — Browser FPS
Roadmap v2" doc. This file is the short version Claude Code reads.

## Decisions

- Browser-first desktop FPS; mobile in Phase 9
- Solo developer + Claude Code
- 6v6 Team Deathmatch first; bots fill matches
- Stylized original IP, no gore (PEGI 12)
- Guest play first; free-to-play; portal ads, cosmetics later
- Stack: see `docs/adr/0001-web-stack.md`

## Phases (details in docs/phases/)

| #   | Phase                 | Weeks   | Exit test (short)                              |
| --- | --------------------- | ------- | ---------------------------------------------- |
| 0   | Setup                 | 1       | dev runs, CI green                             |
| 1   | Networked movement    | 2–3     | smooth at 120 ms / 3% loss; replay within 1 cm |
| 2   | Gunplay               | 3–4     | ≥ 95% on-target hits register at 150 ms        |
| 3   | Match loop + bots     | 3       | 10 remote matches, no crash; 5 playtesters     |
| 4   | Online shell          | 3       | link → match < 20 s; XP persists               |
| 5   | Content pipeline      | 3–4     | weapon = data + model; download < 15 MB        |
| 6   | Progression + social  | 3       | party of 3 via link                            |
| 7   | Security + operations | 2–3     | 50 bot matches; hacked client rejected         |
| 8   | Public beta           | 3–4     | 99% crash-free; live on domain + CrazyGames    |
| 9   | Live service          | ongoing | per season                                     |

## Budgets

- Initial download < 15 MB; total < 50 MB; < 1,500 files
- 60 fps at Low on integrated GPU; server tick < 4 ms (12 players)
- Snapshots < 10 KB/s per player
