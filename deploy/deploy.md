# Production deploy: EC2 + Docker Hub image + nginx + HTTPS

How **https://play.remoteref.com** runs today, step by step, so it can be rebuilt from scratch.
(General options — Caddy instead of nginx, building on the server — are in `docs/DEPLOY.md`.)

```
players ──HTTPS/WSS──▶ nginx (host, :443, Let's Encrypt)
                         ├── /api/*  ──▶ api  container  127.0.0.1:8787  (SQLite on a volume)
                         └── /*      ──▶ game container  127.0.0.1:2567  (game server + web page)
```

Both containers run the same image, `abdullah211/sentinelstrike:latest`, which GitHub Actions
builds and pushes to Docker Hub after CI passes on `main` (`.github/workflows/docker-publish.yml`).

## 1. Server (once)

- EC2, Ubuntu, 2 vCPU (not a `t2`/`t3` burstable type for real traffic), Elastic IP attached.
- Security group: **80** and **443** from anywhere, **22** only from your IP. Never open 2567
  or 8787 (they only listen on `127.0.0.1`).
- DNS: an **A record** `play.remoteref.com` → the Elastic IP.
- Software:

```bash
curl -fsSL https://get.docker.com | sudo sh
docker compose version || sudo apt install -y docker-compose-v2
sudo apt install -y nginx certbot python3-certbot-nginx
```

## 2. The game (containers)

```bash
mkdir -p ~/sentinel && cd ~/sentinel
nano .env                 # the two lines below
nano docker-compose.yml   # paste deploy/docker-compose.ec2.yml from the repo
sudo docker compose up -d
```

`.env` (runtime secrets: stays on the server, never in git or chat):

```
SENTINEL_API_SECRET=<openssl rand -hex 32>
SENTINEL_ADMIN_PASSWORD=<openssl rand -base64 18>
```

Keep `SENTINEL_API_SECRET` the same forever: changing it logs every player's guest out.

Check:

```bash
sudo docker compose ps               # api and game: Up
curl -s localhost:2567/healthz       # {"ok":true,"service":"server","protocolVersion":…}
curl -s localhost:8787/healthz       # {"ok":true,"service":"api"}
```

## 3. nginx

```bash
sudo nano /etc/nginx/sites-available/sentinel    # paste deploy/nginx.conf, set server_name
sudo ln -s /etc/nginx/sites-available/sentinel /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

`server_name play.remoteref.com _;` — the `_` also answers on the bare IP. The config
overwrites `X-Real-IP` / `X-Forwarded-For` with the real client address (IP bans and rate
limits depend on it) and returns 404 for `/metrics` and `/api/metrics`.

## 4. HTTPS (Let's Encrypt)

Only after the A record points at the server (`ping play.remoteref.com` shows the Elastic IP):

```bash
sudo certbot --nginx -d play.remoteref.com --redirect
```

Certbot asks for an email and the terms once, gets the certificate, adds `listen 443 ssl` and
an HTTP → HTTPS redirect to `/etc/nginx/sites-enabled/sentinel`, and installs automatic renewal
(certificates last 90 days). Check renewal works:

```bash
sudo certbot renew --dry-run
sudo systemctl list-timers | grep certbot
```

Optional once HTTPS is stable: in the `listen 443` server block add
`add_header Strict-Transport-Security "max-age=31536000" always;` then
`sudo nginx -t && sudo systemctl reload nginx` (browsers then always use HTTPS).

## 5. Check from anywhere

```bash
curl -s https://play.remoteref.com/healthz        # game server, protocol version
curl -s https://play.remoteref.com/api/healthz    # API
curl -sI http://play.remoteref.com | head -1      # 301 (redirect to https)
curl -s -o /dev/null -w '%{http_code}\n' https://play.remoteref.com/metrics   # 404
```

Then open https://play.remoteref.com and press DEPLOY. After a server restart, the **first**
match takes ~30 s to start (the server builds its bot navigation once); later joins take a
few seconds.

## 6. Everyday operations

| What                                                      | Command (in `~/sentinel`)                                                                                                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update to the newest image (after CI + publish on `main`) | `sudo docker compose pull && sudo docker compose up -d`                                                                                                          |
| Logs (JSON lines)                                         | `sudo docker compose logs -f --tail 100 game api`                                                                                                                |
| Restart                                                   | `sudo docker compose restart`                                                                                                                                    |
| Admin / moderation page                                   | https://play.remoteref.com/api/admin (user `admin`, password from `.env`)                                                                                        |
| Metrics (from the server only)                            | `curl -s localhost:2567/metrics` and `curl -s localhost:8787/metrics`                                                                                            |
| Backup the database                                       | `sudo docker compose exec api node apps/api/scripts/backup.mjs backup /data/sentinel.db /data/backups` then `sudo docker compose cp api:/data/backups ./backups` |
| nginx config changed                                      | `sudo nginx -t && sudo systemctl reload nginx`                                                                                                                   |

An update ends matches in progress (players rejoin); the database is on the `sentinel-data`
volume and survives updates. A new protocol version makes open game pages ask for a reload.

## 7. If something is wrong

| Symptom                                           | Look at                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Site down / 502                                   | `sudo docker compose ps` (containers up?), `sudo docker compose logs game api`                                  |
| Page loads, DEPLOY hangs                          | WebSocket through nginx: the `Upgrade` / `Connection` lines in the config, `sudo tail /var/log/nginx/error.log` |
| "Update required, please reload"                  | old page after an update: reload                                                                                |
| Certificate errors                                | `sudo certbot certificates`, `sudo certbot renew --dry-run`                                                     |
| Containers won't start: "Set SENTINEL_API_SECRET" | `.env` missing or not in `~/sentinel`                                                                           |
