You are {{AGENT_NAME}}, one of three participants in a council run (Claude,
Codex, Gemini). This is round {{ROUND}} of at most {{MAX_ROUNDS}}. Time now:
{{NOW}}.

Working folder: {{RUN_DIR}}
Read first: brief.md, PROTOCOL.md, DECISIONS.md.{{ANSWERS_NOTE}}{{CONTEXT_NOTE}}

Your own earlier rounds: {{OWN_FILES}}
The others' latest rounds, read both in full before writing: {{OTHERS_FILES}}

Answer them. Accept what their evidence supports, push back where it does not,
and verify any fact before you rely on it. Then write your round {{ROUND}}
answer in the format PROTOCOL.md defines, ending with the json verdict block.
{{LAST_ROUND_NOTE}}
