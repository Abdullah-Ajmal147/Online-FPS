---
description: Run all checks and report against the current phase's exit tests
---

1. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm test:e2e` (if the client exists).
2. Read the current phase from `docs/PROGRESS.md` and its exit tests in `docs/phases/`.
3. For each exit test, report: PASS (with evidence: test name or command output),
   FAIL (why), or NEEDS OWNER (things only a human can judge, like "feels right").
4. If anything fails, propose the smallest fix but do not apply it until I say so.
   Keep the report short: a checklist, then at most 5 lines of notes.
