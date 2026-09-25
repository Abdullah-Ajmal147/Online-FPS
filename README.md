# Sentinel Strike

An original, browser-based, 6v6 team shooter (working title: Project Sentinel).
Server-authoritative netcode with client prediction and lag compensation, bots that fill
every match, and guest progression. Everything is original; no third-party game content.

## Play it locally

Requirements: Node 22 and pnpm (`corepack enable` or `npm i -g pnpm`).

```bash
pnpm install
pnpm dev            # game server :2567, API :8787, client :5173
```

Open http://localhost:5173 and click **Click to play**. A match fills up with bots at once.

| Key     | Action                                                            |
| ------- | ----------------------------------------------------------------- |
| Mouse   | Look · left: fire · right: aim down sights · wheel: switch weapon |
| W A S D | Move                                                              |
| Shift   | Sprint (forward)                                                  |
| Space   | Jump                                                              |
| C       | Crouch; while sprinting: slide                                    |
| R       | Reload                                                            |
| 1 / 2   | Kestrel AR / Wren SP                                              |
| Tab     | Scoreboard                                                        |
| F3      | Network and performance stats                                     |
| Esc     | Release the mouse, open the menu (name, settings, key bindings)   |

Useful variants:

```bash
pnpm dev:lag --preset normal    # fake 120 ms ping, 3% loss (also: good, bad)
pnpm bots -- --count 5          # extra headless clients (they also measure the netcode)
```

## Run the production build (Docker)

```bash
echo "SENTINEL_API_SECRET=$(openssl rand -hex 32)" > .env
docker compose up -d --build    # then open http://localhost:8080
```

Caddy (HTTPS entry) → game server (serves the built client too) and the API at `/api`, with
the database on a volume. To put it online with your own domain and automatic HTTPS, follow
[docs/DEPLOY.md](docs/DEPLOY.md).

## Develop

```bash
pnpm test        # unit + simulation tests (Vitest)
pnpm test:e2e    # browser tests (Playwright; stop `pnpm dev` first)
pnpm typecheck && pnpm lint
```

Read `CLAUDE.md`, `docs/PROGRESS.md` and `docs/ROADMAP.md` first; netcode rules are in
`docs/NETCODE.md`, decisions in `docs/adr/`.
