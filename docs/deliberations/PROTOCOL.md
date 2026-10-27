# Deliberation protocol

Shared by the three research agents (Claude, Gemini, ChatGPT/Codex) working on
Sandip's brief in `scratch-pad.md`. Written by Claude on 2026-10-20 at 10:40 IST,
before the others arrived. If you already started with a different layout, keep
your files and add the status file below; the rest is a proposal, edit
`PROTOCOL.md` only by appending a "Proposed change" section at the bottom.

## Folders

One folder per agent. Each agent writes only inside its own folder.

```
deliberations/
  scratch-pad.md        the brief (read-only)
  PROTOCOL.md           this file
  claude/
  gemini/
  chatgpt/              (or codex/; either name is fine, say which in STATUS.md)
  consensus/            created only at the end, see "Convergence"
```

## Signalling (how we know where each other is)

Each agent owns exactly one status file: `<agent>/STATUS.md`. Nobody edits
another agent's status file. Keep it in this shape so it can be grepped:

```
agent: claude
round: 1
state: researching        # researching | complete | waiting | converged
updated: 2026-10-20 10:40 IST
file: claude/round-1.md
note: one line, optional
```

Rules:
- Set `state: researching` when you start a round.
- Write the round file completely, then flip to `state: complete`. A round file
  is final once its status says complete. Do not edit it after that; corrections
  go in the next round.
- While waiting for the others, set `state: waiting`.
- Poll the other two STATUS.md files. Start round N+1 only when all three show
  `round: N` with `state: complete` or `waiting`.
- If an agent has not updated its status for 6 hours, the other two may proceed
  and note the absence. Sandip may also restart a stalled agent.

## Round files

`<agent>/round-N.md`. Same sections every round, so the three are easy to diff:

1. **Recommendation in one paragraph.**
2. **Decision table.** One row per decision ID below: position, confidence
   (high/med/low), one-line reason. Use the IDs exactly.
3. **What changed since my last round** (round 2+), and why.
4. **Pushback on the others** (round 2+). Cite the file and section. Disagree
   specifically; agreeing to be agreeable defeats the purpose.
5. **Open questions for the other agents.**
6. **Open questions for Sandip.** Also copy these to `<agent>/QUESTIONS.md` so he
   can answer in one place. He may answer inline there.
7. **Sources.**

Supporting material (detailed research notes, diagrams, code sketches) can go in
`<agent>/notes/` and be linked from the round file.

Round 1 is independent: write it from your own research before reading the
other agents' folders. From round 2 on, read every other agent's latest round
file first.

## Decision IDs

Every round file takes a position on each of these. Add new IDs at the end of
your table if you think one is missing (prefix with your agent name, e.g.
`G1`, `X1`, `C1`); the others will adopt or reject it next round.

- **D1 Agent runtime.** OpenClaw, Hermes Agent, Claude Agent SDK / Claude Code,
  another framework, or extend Samaritan's own run layer. What actually runs the
  agents.
- **D2 Command centre.** The dashboard/inbox: build, extend Samaritan's Action
  Center, or adopt something. What it shows and what you can action from it.
- **D3 Second brain.** Where memory and generated files live (Obsidian vault,
  Notion, SQLite, other) and what is canonical.
- **D4 Cross-assistant context.** How ChatGPT, Claude and Gemini on the laptop
  find and use the second brain and the system's outputs (MCP server, files,
  AGENTS.md, etc).
- **D5 Surfaces.** Laptop, phone, Telegram. What each one is for and how they
  share state.
- **D6 Hosting.** Where the always-on parts run (this Mac, a Mac mini, a VPS,
  cloud), and why.
- **D7 Integrations.** How each source in the brief gets connected (calendar,
  email, WhatsApp, iMessage, Oura, Hevy, PostHog, bills, job boards, Claude Code
  sessions, the-library newsletter app, music).
- **D8 Phone control.** Role of `esp32-iphone-agent`.
- **D9 Trust and safety.** Approval gates, what can run unattended, secrets,
  prompt-injection exposure from reading messages and email.
- **D10 Build sequence.** What to build first, second, third, with rough effort.

## Convergence

- Convergence means all three agents mark every D-row "agree" (or "agree with
  reservation", reservation stated) with the same position.
- When an agent believes positions have converged, it says so in its round file
  and drafts `consensus/PROPOSAL.md`. Only one agent drafts; if two try at once,
  the alphabetically first agent name keeps the draft (chatgpt, claude, gemini)
  and the other comments in its own round file.
- The other two sign off by setting `state: converged` in their STATUS.md and
  adding a line to their round file: "I sign off on consensus/PROPOSAL.md as of
  <time>", with any reservations.
- Hard stop after round 4. Whatever is still split goes into
  `consensus/PROPOSAL.md` as "Unresolved, Sandip decides", with each agent's
  position in two lines.

## Style

Sandip's rules for anything written here: short and concise, no em dashes, no
emojis, no filler adjectives ("robust", "comprehensive", "production-ready",
"seamless", "leverage"). Lead with the answer. Times in IST.

## Amendments

### A1 (Claude, 2026-10-20 10:45 IST), accepting Codex's note in codex/STATUS.md

- The 6-hour rule above is withdrawn. Sandip asked us to wait for all three, so
  nobody proceeds to round N+1 on someone else's silence. If an agent looks
  stalled, the others say so in their messages file and Sandip decides.
- Each agent may keep `<agent>/messages-to-peers.md`, append-only, newest at the
  bottom, timestamped in IST. Check the other two at least every time you check
  status files.
- Answers Sandip gives any one agent directly go in `<agent>/USER-ANSWERS.md` so
  all three see them. Codex started `codex/USER-ANSWERS.md`; treat it as shared.
- `<agent>/STATUS.md` is the source of truth for progress. `COORDINATION.md`
  is Gemini's overview; useful, but if the two disagree, STATUS.md wins.
