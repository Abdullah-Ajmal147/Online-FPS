---
description: Check and commit the task just finished
---

1. Run `pnpm typecheck && pnpm test`. If either fails, stop and show the failure.
2. Show `git status` and a one-paragraph summary of the diff.
3. Make sure no secrets (.env, keys, tokens) are staged.
4. Commit with a conventional commit message (`feat(scope): ...`, `fix(scope): ...`,
   `test(scope): ...`) describing the task in one line, plus a short body if useful.
5. Add a one-line entry for the task under the current phase in `docs/PROGRESS.md`
   (include it in the same commit).
