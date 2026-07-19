---
name: log
description: Append a 1-3 sentence "what just happened" entry to today's Hourly Log in Sandip's Obsidian vault. Use whenever Sandip types `/log [text]`, sends a Telegram message via Claude Channels starting with `/log`, or describes what he did in the last hour (e.g., "spent the last hour on X", "just finished Y", "worked on Z all afternoon"). This is high-value capture that fuels weekly synthesis — fire eagerly when in doubt rather than asking.
---

# /log — Hourly Log Capture

Append a short entry to today's Obsidian daily note under `## Hourly Log`. Granular hourly logs are the single richest input for weekly synthesis — treat them as high-value, capture them fast, format consistently.

## System contract

- **Vault root:** `/Users/sandipdev/Documents/Obsidian/Samaritan/`
- **Today's daily note:** `Areas/Daily/YYYY-MM-DD.md` (today's date in Sandip's local timezone)
- **Full system contract:** `AGENT_OS.md` at vault root — read it if anything below is unclear.

## Process

1. **Resolve today's date** in Sandip's local timezone. Use the date in Cowork's env header if available; otherwise ask the bash tool for `date +%Y-%m-%d`.

2. **Ensure today's daily note exists.** If `Areas/Daily/YYYY-MM-DD.md` doesn't exist, create it with this template:
   ```
   ---
   type: daily
   created: YYYY-MM-DD
   ---
   # YYYY-MM-DD

   ## Hourly Log

   ## Inbox

   ## Session
   ```

3. **Determine the hour heading.** Current hour rounded down (e.g., `14:00` if it's 14:37). Format: `### HH:00 [[Project or Area]]`.

4. **Determine the project link.**
   - If Sandip provided one explicitly, use it.
   - Otherwise scan recent context: prior `/log` entry today, calendar event happening now (Google Calendar MCP if connected), active project in conversation. Infer cautiously — wrong link is worse than no link.
   - If no clear signal, omit the wikilink entirely. The nightly inbox processor (22:00) re-tags it.

5. **Append.** Under `## Hourly Log`:
   - If no heading exists for this hour: add `### HH:00 [[Project]]` (or just `### HH:00` if no link) followed by the text on the next line.
   - If a heading already exists for this hour: append the new text as a new paragraph under it. Do not create a duplicate hour heading.

6. **Confirm in one line.** `Logged 14:00 → [[Onboarding Redesign]]`.

## Examples

**Sandip:** `/log Drafted the pricing section. Stuck on the comparison table.`

Append under `## Hourly Log`:
```
### 14:00 [[Onboarding Redesign]]
Drafted the pricing section. Stuck on the comparison table.
```

Reply: `Logged 14:00 → [[Onboarding Redesign]]`

**Sandip (Telegram, 10:07 AM):** `/log Standup. Pushed back on Q3 scope creep.`

No project named. Calendar shows "Acme weekly sync" 10:00–10:30 → infer Acme.

```
### 10:00 [[Acme]]
Standup. Pushed back on Q3 scope creep.
```

**Sandip:** `/log Quick break, made coffee.`

No project, no calendar signal. Leave link blank.

```
### 11:00
Quick break, made coffee.
```

## Edge cases

- **From Telegram (Claude Channels):** behavior is identical. Write to the vault on Sandip's machine. He'll see it on desktop.
- **Two `/log` calls in the same hour:** append as a new paragraph under the existing hour heading, not a new heading.
- **Sandip provides his own time** ("/log at 15:00 fixed the bug"): respect his override.
- **Out-of-hour reflection** ("/log thinking about yesterday's incident"): use the current hour, don't retro-date. He can edit if he wants.
- **Empty `/log`:** ask once for the text; don't fabricate.

## Why this matters

Hourly logs let the weekly synthesis say "you spent 14 hours on Onboarding, 6 on Acme, 4 on hiring" rather than vague vibes. They also feed the AI PM OS's answer to "what did I actually work on this week?" Treat each one as a small but precious data point.
