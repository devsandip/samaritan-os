# Council skill

Draft, not installed. Give a problem to Claude Code, Codex or Gemini CLI; it
runs a debate between all three through their CLIs and comes back with a
proposal all three signed. Same skill folder for all three apps.

## How it works

- The app you start from writes the brief and runs `scripts/council.py`.
- The script calls `claude -p`, `codex exec` and `gemini -p` headless, one call
  per step, in parallel within a round. Each call is read-only: the models read
  the run folder, your context folders and the web, and answer. The script
  writes every file.
- Steps: the starting model lists the decisions to settle; round 1 is blind;
  rounds 2 to 4 answer each other; stop when all three report convergence;
  one model drafts a proposal with a coverage check against the brief; the
  other two review and sign or ask for amendments; up to two revisions; the
  result gets a SHA-256 checksum.
- It pauses once after round 1 if anyone has questions only you can answer.
- API keys are removed from the child environment, so all three run on your
  Claude, ChatGPT and Google subscriptions.

Checked on this Mac (2026-10-20): Claude Code 2.1.304 at `~/.local/bin/claude`;
Gemini CLI 0.46.0 at `/opt/homebrew/bin/gemini`, signed in with your Google
account; Codex CLI 0.163.0 inside `/Applications/ChatGPT.app`, signed in with
ChatGPT. The script finds the Codex binary there even though it is not on PATH.

## Install (when you decide to)

```bash
SRC=~/Developer/samaritan/docs/deliberations/council-skill/council
mkdir -p ~/.agents/skills ~/.claude/skills
cp -R "$SRC" ~/.agents/skills/council   # Codex and Gemini CLI both read ~/.agents/skills
cp -R "$SRC" ~/.claude/skills/council   # Claude Code
python3 ~/.agents/skills/council/scripts/council.py doctor
```

Then try a dry run (no models called) and a live smoke test:

```bash
python3 ~/.agents/skills/council/scripts/council.py start --dry-run --problem "Test" --home /tmp/council-test
python3 ~/.agents/skills/council/scripts/council.py doctor --live
```

## Not yet verified on your Mac

1. Web search inside each read-only call. Claude allows WebSearch and
   WebFetch explicitly. Gemini runs in `plan` mode; check it still searches.
   Codex search depends on your Codex config; if it does not search, set
   `COUNCIL_CODEX_ARGS` to the right `-c` option for your version.
2. Codex as the starting app: its sandbox must let this one script use the
   network. Approve it once when Codex asks.
3. Time and quota. A real run is roughly 10 to 20 model calls across three
   plans.

## Starting from the chat apps

The skill runs in the three coding apps. To start from the Claude desktop
chat, add a small local MCP server with three tools (start, status, result)
that wraps this script. ChatGPT web and the Gemini app need the remote MCP
endpoint planned for Samaritan Phase 4; a council could then be a Samaritan
task type.

## Files

```
council/
  SKILL.md               instructions for the starting app
  scripts/council.py     the conductor
  templates/             protocol and the prompts for each step
```
