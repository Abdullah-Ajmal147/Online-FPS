# Start here

This kit sets up a new folder so Claude Code can build Project Sentinel phase by phase.

## What you need

- Node.js 22 LTS and pnpm (`npm i -g pnpm`)
- Git and a GitHub account
- Claude Code (the `claude` CLI)
- A desktop browser (Chrome or Edge is easiest for WebGPU testing)
- Later: a Supabase account (Phase 4), a VPS or Fly.io (Phase 3), Sentry and PostHog (Phase 4)

## Steps

1. Make an empty folder, e.g. `sentinel/`, and copy everything from this kit into it
   (including the hidden `.claude/` folder).
2. In that folder: `git init`
3. Run `claude`
4. Type: `/phase 0`
   Claude reads the rules and the Phase 0 file, writes a plan, and waits for your OK.
5. Approve the plan, then let it work one task at a time.
   - `/verify` — run all checks against the phase's exit tests
   - `/commit-task` — test and commit the finished task
   - `/review-net` — independent review of netcode/security changes
   - `/phase-done` — close the phase when every exit test passes
6. Start a fresh Claude session for each new phase: `/phase 1`, `/phase 2`, ...

## Files in this kit

- `CLAUDE.md` — the rules Claude follows in this repo
- `docs/ROADMAP.md` — short roadmap; `docs/phases/phase-0..9.md` — tasks + exit tests
- `docs/NETCODE.md` — netcode contract (tick rates, prediction, lag compensation)
- `docs/GAME_DESIGN.md` — one-page design with open questions for you
- `docs/PROGRESS.md` — Claude's memory between sessions
- `docs/adr/0001-web-stack.md` — why this stack
- `docs/LICENSES.md` — log every third-party asset here
- `.claude/commands/` — the slash commands above
- `.claude/agents/netcode-reviewer.md` — the independent reviewer
- `.claude/settings.json` — safe default permissions (tests allowed, .env hidden)

## Tip

Play every build yourself. Claude can write the systems fast; only you can tell
whether it is fun.
