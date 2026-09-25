---
description: Close the current phase after all exit tests pass
---

1. Run /verify. If any exit test is FAIL or NEEDS OWNER without my sign-off, stop.
2. Update `docs/PROGRESS.md`:
   - mark the phase done with today's date
   - "What we learned" (3–6 bullets: surprises, things that took longer, tech notes)
   - "Open issues carried forward"
   - set "Current phase" to the next one
3. If any big technical choice was made during the phase, make sure it has an ADR in `docs/adr/`.
4. Commit: `chore: close phase N`.
5. Suggest starting a fresh Claude session for the next phase with `/phase <N+1>`.
