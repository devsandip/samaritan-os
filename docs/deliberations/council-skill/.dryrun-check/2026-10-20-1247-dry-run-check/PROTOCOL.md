# Council protocol

Three models (Claude, Codex, Gemini) work on one problem in rounds and end with
one proposal they all sign. A conductor script runs each of you headless, one
call per round, and writes every file. You only read files and answer.

## What you can see

- `brief.md`: the problem, in the user's words. This is the thing to solve.
- `DECISIONS.md`: the decisions to settle, with IDs (D1, D2, ...).
- `ANSWERS.md`, if present: the user's answers to earlier questions. They
  override any assumption.
- Each participant's folder (`claude/`, `codex/`, `gemini/`) with its round
  files `round-N.md`.
- Any context folders listed in your prompt.

You may read anything above and research the web. Do not try to edit files.
Everything you want recorded goes in your answer.

## Rules

1. Round 1 is blind. Do not open the other participants' folders.
2. From round 2, read every other participant's latest round first.
3. Change a position only for evidence: a source, a code check, or a clear
   argument. Say which. Do not agree to be agreeable, and do not hold a
   position only because it was yours.
4. Disagree specifically: cite the file and section you are answering.
5. Facts that can change (prices, versions, policies, availability) need a
   source with a date. Mark anything you could not verify.
6. If a decision is missing from DECISIONS.md, add it with your prefix
   (Claude C1, Codex X1, Gemini G1).
7. Questions only the user can answer go in `questions_for_user`. Keep going
   on your best assumption and state it.
8. Style for anything the user reads: short, plain sentences, lead with the
   answer, no em dashes, no emojis, no filler adjectives.

## Round answer format

Markdown with these sections, then one fenced json block at the very end:

1. Recommendation in one paragraph
2. Decision table: one row per ID, with position, confidence and one-line reason
3. What changed since my last round, and why (round 2 on)
4. Pushback on the others (round 2 on)
5. Questions for the other participants
6. Assumptions I made
7. Sources

```json
{
  "agent": "claude | codex | gemini",
  "round": 1,
  "positions": [{"id": "D1", "position": "one line", "confidence": "high | med | low"}],
  "new_decisions": [{"id": "C1", "question": "one line"}],
  "open_disagreements": ["D3"],
  "questions_for_user": ["one question per item"],
  "converged": false
}
```

Set `converged` to true only when you believe all three participants now hold
the same position on every decision and you accept it. List any decision you
still dispute in `open_disagreements`.
