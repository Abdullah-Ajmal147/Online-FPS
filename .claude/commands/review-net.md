---
description: Independent review of netcode / security changes by the netcode-reviewer agent
---

Use the `netcode-reviewer` subagent to review the uncommitted changes
(or, if there are none, the last commit: `git diff HEAD~1`).
Give it only the diff, `docs/NETCODE.md` and `CLAUDE.md` — not your own reasoning —
so the review is independent. Then show me its findings ranked by severity,
and say which ones you agree with. Do not fix anything until I choose.
