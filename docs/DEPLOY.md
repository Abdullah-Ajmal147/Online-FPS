# Deploying Sentinel Strike

The whole game runs as three containers from this repo: **Caddy** (HTTPS, public entry),
**game** (authoritative game server + the built web client) and **api** (guest tokens, XP,
SQLite on a volume). One region = one of these stacks (ADR 0002: EU, NA East, Asia).

## 1. A server

Any Linux VPS with 2 vCPU / 2 GB RAM is plenty for several matches (a 12-player match ticks in
~0.3 ms; memory ~250 MB per game process). Open ports 80 and 443. Install Docker:

```bash
curl -fsSL https://get.docker.com | sh
```

## 2. A domain

Point an A record (e.g. `play.example.com`) at the server's IP.

## 3. Configure and start

```bash
git clone https://github.com/<you>/Online-FPS.git && cd Online-FPS
cat > .env <<EOF2
SENTINEL_API_SECRET=$(openssl rand -hex 32)
SITE_ADDRESS=play.example.com
EOF2
docker compose up -d --build
```

Caddy gets a Let's Encrypt certificate automatically. Open `https://play.example.com`.

- `SENTINEL_API_SECRET` signs guest tokens and match results. Keep it secret, keep it the same
  across restarts (changing it logs every guest out of their progress), and never commit `.env`.
  The services refuse to start in production without a real one.
- Data: the API's SQLite database is in the `sentinel-data` volume. Back it up with
  `docker compose cp api:/data/sentinel.db ./backup.db` (Supabase replaces it in Phase 4).

## 4. Operate

| What                 | How                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Health               | `curl https://play.example.com/healthz` and `/api/healthz`                                                                                     |
| Metrics (Prometheus) | `docker compose exec game curl -s localhost:2567/metrics` (rooms, players, tick p50/p99, slow ticks, errors, matches) and `api …:8787/metrics` |
| Logs (JSON lines)    | `docker compose logs -f game api`                                                                                                              |
| Update               | `git pull && docker compose up -d --build` (in-progress matches end; players rejoin)                                                           |
| Settings             | `SENTINEL_BOT_DIFFICULTY=easy                                                                                                                  | normal | hard`, `SENTINEL_BOTS=0`to disable bots,`SENTINEL_MAP` |

Metrics are not exposed publicly by Caddy; scrape them from inside the network.

## Known limits before a public launch

- Guest identity is a signed token in the browser (no account recovery); Supabase accounts
  are Phase 4.
- Snapshots contain every player's position (a wallhack could read them); interest
  management is planned before a big public launch (see PROGRESS open issues).
- One process per region; scaling beyond one server per region needs Colyseus presence
  (Redis) and a shared rate-limit store.
