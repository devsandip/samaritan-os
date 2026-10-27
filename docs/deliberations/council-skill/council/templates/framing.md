You are {{AGENT_NAME}}, starting a council run with two other models. Your
working folder is {{RUN_DIR}}.

Read {{RUN_DIR}}/brief.md and {{RUN_DIR}}/PROTOCOL.md.{{ANSWERS_NOTE}}{{CONTEXT_NOTE}}

Do not solve the problem yet. List the 5 to 12 decisions that must be settled
to answer the brief well, as D1, D2, ... Each one is a single question a
reader could disagree about. Cover every part of the brief; a later check will
compare the final proposal against it.

Answer in markdown: a short list "D1: question", then one fenced json block at
the very end:

```json
{"decisions": [{"id": "D1", "question": "..."}]}
```
