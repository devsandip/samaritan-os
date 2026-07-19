# samaritan

Sandip's AI PM operating system — capture, file, wrap, recall, weekly across Obsidian + Notion + TickTick.

## What's inside

8 capture skills that implement the contract defined in `AGENT_OS.md` (in the Obsidian vault root):

| Skill | Purpose |
|---|---|
| `log` | Append a 1–3 sentence "what I just did" to today's hourly log |
| `capture` | Dump a raw thought to today's Inbox, no routing |
| `decision` | File a structured Decision row to Notion with rationale + reversibility |
| `meeting` | Process a meeting → Obsidian note + Notion rows + TickTick tasks |
| `file` | Explicit, typed file to Notion (decision/insight/person/project) |
| `wrap` | Session close — file everything from the conversation silently |
| `recall` | Grounded lookup across Notion + Obsidian + TickTick |
| `weekly` | 7-day digest written to `Areas/Weekly/YYYY-Www.md` |

## Configuration assumed

- Obsidian vault: `~/Documents/Obsidian/Samaritan/`
- Notion PM OS workspace with four databases (Projects, People, Decisions, Insights) — data source IDs are baked into the skill bodies
- TickTick MCP connected
- Optional: Fireflies MCP for meeting transcripts, Telegram via Claude Channels for mobile capture

## Source of truth

The full contract Claude follows is `AGENT_OS.md` at the vault root. Every skill points back to it. Edit the contract there, not in individual skill files.

## Versioning

v0.1.0 — initial. Skills implement the contract but haven't been benchmarked. Plan to add evals in a future iteration.
