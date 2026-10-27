---
name: council
description: Run a multi-round debate between Claude, Codex (ChatGPT) and Gemini on this Mac through their CLIs, ending in one proposal all three sign. Use when the user says /council, or asks to get all three models (or "the other AIs") to debate, cross-check, deliberate or reach consensus on a problem.
---

# Council

Three models work on one problem in rounds and end with a proposal they all
sign. You do not take part in the debate yourself. You write the brief, start
the conductor script, relay any questions to the user, and report the result.
The script calls Claude, Codex and Gemini headless and read-only, writes every
file in a run folder under `~/Council/`, and strips API keys so all three run
on the user's subscriptions.

Script: `scripts/council.py` in this skill's folder. Python 3, standard library
only. Below, `COUNCIL` means the absolute path to that script.

## 1. Write the brief

Restate the problem in the user's own words. Add what a newcomer would need:
goal, constraints, what a good answer looks like, and any decisions already
made. List folders the participants should read (they can read, never write).
Show the brief to the user in two or three lines and ask about anything
essential that is missing. Do not ask about things the participants can
research themselves.

## 2. Start the run

Pass the brief on stdin and say which app you are (`claude`, `codex` or
`gemini`). The starting app also frames the list of decisions to settle.

```bash
python3 "$COUNCIL" start --from <claude|codex|gemini> --brief - \
  --context ~/Developer/some-project <<'EOF'
<the brief>
EOF
```

The first output line is `RUN_DIR=...`. Keep it.

A full run takes about 30 to 90 minutes. Start it in the background and check
with `python3 "$COUNCIL" status <RUN_DIR>` every few minutes; do not wait in a
blocking call.

- Claude Code: run the command as a background Bash command.
- Codex: the default sandbox blocks network, and the script needs it to reach
  the other two CLIs. Request to run this one command outside the sandbox
  (escalated permissions) and let the user approve it.
- Gemini CLI: run it with `nohup ... > <RUN_DIR>/../council-last.log 2>&1 &`
  so the shell tool returns, then poll status.

Options: `--rounds N` (default 4, hard stop), `--ask first|every|never` (when
to stop for the user's answers, default after round 1), `--drafter`,
`--only claude,gemini` (fewer participants), `--dry-run` (no models called,
exercises the whole flow).

## 3. Exit codes and what to do

- `3` waiting: read `<RUN_DIR>/QUESTIONS-FOR-YOU.md`, ask the user, write their
  answers verbatim to `<RUN_DIR>/ANSWERS.md`, then run
  `python3 "$COUNCIL" continue <RUN_DIR>` (again in the background). If the user
  does not want to answer, use `continue <RUN_DIR> --skip-questions`.
- `1` error: read the last lines of `<RUN_DIR>/log.md` and the `raw/` folder of
  the participant that failed. Common causes: a CLI is logged out, a timeout
  (set `COUNCIL_TIMEOUT_SEC`), or the script ran inside a sandbox without
  network. Fix it and run `continue`. Work already done is kept.
- `0` done: go to step 4.

## 4. Report the result

Read `<RUN_DIR>/consensus/FINAL.md` and `PROPOSAL.md`, and skim each
participant's last round. Tell the user, briefly:

- the answer, in two or three sentences;
- whether all three signed, and anything left unresolved;
- where they disagreed and what changed minds;
- anything the coverage check marks "Not covered";
- the path to `PROPOSAL.md`.

## Rules

- Never edit a participant's round file, a review, or the proposal. If
  something is wrong, say so to the user or run `continue`.
- Never write `ANSWERS.md` from your own judgment. Only the user's words go
  there.
- Do not approve or sign on the user's behalf. The council's sign-off is the
  three models'; acting on the proposal is the user's call.
- Do not pass API keys or add `--bare` to any call; the user wants
  subscription logins only.

## Checks

`python3 "$COUNCIL" doctor` lists the three CLIs it found.
`python3 "$COUNCIL" doctor --live` also sends each a one-line prompt.
Binaries can be overridden with `COUNCIL_CLAUDE_BIN`, `COUNCIL_CODEX_BIN`,
`COUNCIL_GEMINI_BIN`; extra flags with `COUNCIL_CODEX_ARGS` and the like.
