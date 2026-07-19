---
name: capture
description: Dump a raw thought to today's Inbox in Sandip's Obsidian vault with no routing logic at capture time. Use whenever Sandip types `/capture [thought]`, sends a Telegram message via Claude Channels starting with `/capture`, or fires off a stray idea with no clear filing destination. The whole point is that capture is dumb-on-purpose — fire instantly, do not ask clarifying questions, do not try to route or categorize.
---

# /capture — Inbox Capture

Append a raw thought to today's daily note `## Inbox` section as a timestamped bullet. No routing, no categorization, no questions — that all happens later in the nightly inbox processor.

## Why this exists

The hardest part of any second brain is the moment of capture. If Sandip has to decide where a thought goes, he doesn't capture it. `/capture` removes that decision entirely. The thought lands in today's Inbox; the nightly sweep (22:00) routes it. Two-step capture beats one-step organization every time.

## System contract

- **Vault root:** `~/Documents/Obsidian/Samaritan/`
- **Today's daily note:** `Areas/Daily/YYYY-MM-DD.md`
- **Full system contract:** `AGENT_OS.md` at vault root.

## Process

1. **Resolve today's date** (Sandip's local timezone).

2. **Ensure today's daily note exists.** If not, create with the standard template (see `log` skill for the template).

3. **Append under `## Inbox`** as a bullet:
   ```
   - HH:MM — <thought>
   ```
   HH:MM is the current time. Append at the end of the section.

4. **One-line confirm.** `Captured. (HH:MM)`

## Examples

**Sandip:** `/capture maybe we should rethink the empty state for first-time users`
Append:
```
- 14:23 — maybe we should rethink the empty state for first-time users
```
Reply: `Captured. (14:23)`

**Sandip (Telegram, 22:14):** `/capture Sarah from Acme mentioned a pricing model I want to look up later`
Append:
```
- 22:14 — Sarah from Acme mentioned a pricing model I want to look up later
```

## What this skill does NOT do

- It does **not** ask which project this belongs to.
- It does **not** classify it as decision/insight/task.
- It does **not** create a Notion row.
- It does **not** create a TickTick task.

All of that is the nightly inbox processor's job. The cost of getting capture wrong (and losing the thought entirely) is much higher than the cost of routing it suboptimally later.

## Edge cases

- **Empty `/capture`:** ask once for the thought; don't fabricate.
- **Long capture (a paragraph or more):** append as a single bullet with the full text — Markdown will wrap it cleanly. Don't truncate.
- **Capture with a Project name in it** (e.g., "Onboarding: pricing feels weak"): leave it as written. The nightly sweep notices the project mention and tags it then. Capture is dumb on purpose.
