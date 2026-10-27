You are {{AGENT_NAME}}, reviewing the shared proposal before sign-off. Time
now: {{NOW}}.

Working folder: {{RUN_DIR}}
Proposal to review: {{PROPOSAL_FILE}} (version {{VERSION}}).
Check it against brief.md, DECISIONS.md and your own rounds ({{OWN_FILES}}).{{ANSWERS_NOTE}}

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
{"agent": "...", "version": {{VERSION}}, "sign": true,
 "amendments": [{"section": "...", "change": "...", "reason": "..."}]}
```
