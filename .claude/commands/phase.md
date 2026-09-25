---
description: Start or continue a roadmap phase (plan first, then build task by task)
argument-hint: <phase number, e.g. 0>
---

We are working on Phase $ARGUMENTS of Project Sentinel.

1. Read `CLAUDE.md`, `docs/PROGRESS.md`, `docs/ROADMAP.md` and `docs/phases/phase-$ARGUMENTS.md`.
   If the phase touches networking, also read `docs/NETCODE.md`.
2. Check that the previous phase's exit tests are marked done in `docs/PROGRESS.md`.
   If not, stop and tell me what is missing.
3. Write a numbered task plan for this phase: for each task, the files you expect to
   touch, the tests that will prove it, and any risk or question.
   Mark tasks already done (from PROGRESS.md).
4. Ask me any open design questions (max 5), then STOP and wait for my approval.
   Do not write code before I approve the plan.
5. After approval: do ONE task at a time. After each task run
   `pnpm typecheck && pnpm test`, show a short summary of what changed, and wait for me
   to say "next" (or run /commit-task).
