# Phase 8 — Public beta (≈3–4 weeks)

Goal: real players at scale.

## Tasks

1. Final game name (check trademarks and domain), logo, landing page with one big Play button.
2. Polish pass: audio mix, hit feedback, menus, onboarding tips, first-match tutorial prompts.
3. Domination mode (3 capture points) as a second playlist, using the `GameMode` interface.
4. Game servers on Edgegap (Docker image), at least NA-East, EU-West; region picked by ping.
5. WebTransport datagram transport behind the `Transport` interface; A/B against WebSocket.
6. CrazyGames Basic Launch build (SDK stub, size checks, PEGI 12 content check).
7. Feedback button + Discord link; weekly patch notes page.
8. Dashboards: CCU, matches/hour, D1/D7 retention, crash-free sessions, median ping by region.

## Exit test

- [ ] ≥ 99% crash-free sessions over a week
- [ ] Day-1 retention measured and recorded in PROGRESS.md
- [ ] Median ping < 80 ms in NA and EU
- [ ] Live on own domain and CrazyGames
