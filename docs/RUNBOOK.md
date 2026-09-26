# Runbook — Sentinel Strike (operations)

For whoever runs the live game. Setup and first deploy: `docs/DEPLOY.md`.

## What runs

| Service | Port (inside compose) | Health                         | Notes                                                      |
| ------- | --------------------- | ------------------------------ | ---------------------------------------------------------- |
| `caddy` | 80/443 public         | —                              | HTTPS, `/api/*` → api, everything else → game              |
| `game`  | 2567                  | `GET /healthz`                 | Colyseus rooms, serves the built client, `/metrics`        |
| `api`   | 8787                  | `GET /api/healthz` (via Caddy) | guests, match results, XP, unlocks, challenges, `/metrics` |

The database is one SQLite file: `/data/sentinel.db` in the `sentinel-data` volume.

## Uptime checks and alerts

Set up an external monitor (UptimeRobot, Better Stack, … — needs the owner's account) on:

- `https://<domain>/healthz` and `https://<domain>/api/healthz` every minute; alert after 2 fails.

Scrape `/metrics` from inside the network (Prometheus/Grafana Agent) and alert on:

| Metric                          | Alert when                                                 |
| ------------------------------- | ---------------------------------------------------------- |
| `sentinel_tick_errors_total`    | any increase (a tick threw; 30 in a row close the room)    |
| `sentinel_slow_ticks_total`     | > 1% of `sentinel_ticks_total` over 5 min (CPU starved)    |
| `sentinel_rejected_joins_total` | sudden jump (version skew after a deploy, or a join flood) |
| API `…_rejected_total`          | any steady rate (someone forging results/unlock reads)     |
| process restarts                | > 1 per hour (crash loop; see logs)                        |

## Logs

`docker compose logs -f game api` — JSON lines. Useful fields: `msg`, `room`, `err`. Every
finished match logs `match ended` with its summary.

## Deploy / update / rollback

- Update: `git pull && docker compose up -d --build`. Running matches end; players rejoin. The
  protocol version and content hash make old browser tabs reload (they can't play stale code).
- Rollback: `git checkout <last good tag> && docker compose up -d --build`. The database is
  forward-compatible (new columns are added on start, nothing is dropped).

## Backups

Take one at least daily (host cron) and copy it off the machine:

```sh
docker compose exec api node apps/api/scripts/backup.mjs backup
# → /data/backups/sentinel-<UTC time>.db, integrity-checked; the newest 14 are kept
docker compose cp api:/data/backups ./backups-$(date +%F)   # then to off-site storage
```

A backup is taken while the API runs (`VACUUM INTO`, consistent). Nothing else needs
backing up: game servers keep no state between matches.

### Restore

1. `docker compose stop api` (games keep running, but XP for matches that end while the API
   is down is lost: the game server retries a report for only a few seconds).
2. Copy the backup into the volume, e.g. `docker compose cp ./sentinel-X.db api:/data/restore.db`.
3. `docker compose run --rm api node apps/api/scripts/backup.mjs restore /data/restore.db`
   (integrity-checked; the old file is kept as `sentinel.db.before-restore`).
4. `docker compose start api`, then open a known player's profile to check.

**Drill:** automated in `apps/api/src/backup.test.ts` (back up a live database, destroy the
file, restore, compare the player's profile) — runs with every `pnpm test`. Repeat by hand on
the real server once after the first deploy and note the date here.

## Incidents

| Symptom                                       | Likely cause                       | Do                                                                                                                                                                                                        |
| --------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Players can't connect, `/healthz` fails       | game container down                | `docker compose ps`, `logs game`; it restarts itself on crash                                                                                                                                             |
| "update required, please reload" for everyone | deploy with a new protocol/content | expected; old tabs reload                                                                                                                                                                                 |
| No XP after matches, unlocks look reset       | API down or secret mismatch        | `logs api`; `SENTINEL_API_SECRET` must match in both services. Players keep their unlocks for the running match; XP for matches that end during the outage is lost (reports retry for a few seconds only) |
| Rubber-banding for everyone on one server     | CPU starved (`slow_ticks` up)      | fewer matches per process (see Capacity); check for a runaway room in logs                                                                                                                                |
| Chat abuse                                    | —                                  | lines are filtered and rate-limited; players can mute. Bans: admin page (Phase 7 task 5)                                                                                                                  |
| Suspected cheater                             | —                                  | stat flags per match (Phase 7 task 3); aim/wall hacks gain little: server authority, anti-wallhack snapshots                                                                                              |

## Moderation

Admin page: `https://<domain>/api/admin` (user `admin`, `SENTINEL_ADMIN_PASSWORD`).

- **Queue:** players who were reported (pause menu → Squad → Report) or whose matches tripped
  anomaly flags (accuracy, headshot rate, reaction time, snap aim, K/D far above level).
- **Player file:** stats, every report, every flagged match with its aim numbers.
- **Replay:** a top-down replay of a logged match (positions each second, kills), the player
  highlighted. Logs are kept 14 days.
- **Actions:** _Shadow-ban_ (the player only ever gets matched with other shadow-banned
  players, from their next match; they aren't told), _Ban_ (can't join; removed at the end of
  the current match), _Clear_.

A flag alone isn't proof: look at the replay and several matches before acting.

Bans and shadow-bans cover the profile **and the connection it last played from** (stored only
as a keyed hash of the IP), so a new guest or a player without a profile from that connection
is caught too. If the API is unreachable, game servers still apply bans they saw in the last
hour; unknown players are let in (availability over strictness). The admin page locks an
address out for 15 minutes after 10 wrong passwords, only accepts same-origin JSON writes,
and can't be framed.

## Capacity (load test, `apps/server/scripts/load.ts`)

Measured on the development machine, bots in every slot, all snapshots encoded:

| Matches in one process | CPU (one core) | Frame p99 (all matches) | Late ticks |
| ---------------------- | -------------- | ----------------------- | ---------- |
| 15                     | 68%            | 20 ms                   | 2.4%       |
| 25                     | 78%+           | 27 ms                   | 6%         |
| 50                     | saturated      | 45 ms                   | 45%        |

- One match (12 players): ~0.5 ms per tick of CPU, ~1 MB RAM, **67 KB/s out** (5.6 KB/s per player).
- One game process (one core): **≤ 15 matches** for good tick times.
- 50 matches at once therefore need ≥ 4 game processes. Colyseus needs a shared presence
  (Redis) to matchmake across processes: add a Redis service and `RedisPresence` /
  `RedisDriver` when one process is no longer enough (owner's hosting decision). Re-run the
  load test on the real server type and record the numbers here.

## Portal build (CrazyGames)

```bash
VITE_REGIONS='[{"id":"eu-west","name":"EU West","url":"https://eu.<domain>"}]' \
VITE_API_URL=https://<domain>/api \
pnpm --filter @sentinel/client build:crazygames
node scripts/size-budget.mjs dist-crazygames
# zip apps/client/dist-crazygames and upload it on the CrazyGames developer portal
```

The portal serves the page from its own domain, so the game server(s) and API need absolute
HTTPS URLs. Content rating and portal checklist: `docs/PEGI.md`.

## Regions

`VITE_REGIONS` (build time) lists the game server regions as JSON: `[{"id","name","url"}]`.
The client pings each `/healthz` and joins the lowest, or the player's pick. Invite links carry
the region. The dashboard (admin page) shows median ping per region.
