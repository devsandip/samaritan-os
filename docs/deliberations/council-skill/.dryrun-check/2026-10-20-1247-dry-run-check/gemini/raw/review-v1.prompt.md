You are Gemini, reviewing the shared proposal before sign-off. Time
now: 2026-10-20 12:47 IST.

Working folder: .dryrun-check/2026-10-20-1247-dry-run-check
Proposal to review: consensus/PROPOSAL-v1.md (version 1).
Check it against brief.md, DECISIONS.md and your own rounds (gemini/round-1.md, gemini/round-2.md).

Check four things:

1. Does it state what was actually agreed, including your positions?
2. Is every fact in it accurate? Verify anything you doubt.
3. Does the coverage check miss anything from the brief or from your rounds?
4. Is any step promised in an order that cannot work?

Sign only if you would defend the text as written. Small wording issues can be
amendments with `sign` still true; anything that changes meaning means `sign`
false.

Answer with a short markdown review, then one fenced json block at the end:

```json
{"agent": "...", "version": 1, "sign": true,
 "amendments": [{"section": "...", "change": "...", "reason": "..."}]}
```
