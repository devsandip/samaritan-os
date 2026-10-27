#!/usr/bin/env python3
"""Council: a multi-round debate between Claude, Codex and Gemini, run through
their CLIs on this Mac, ending in a proposal all three sign.

The three models never write files. Each one is called headless, read-only,
once per step; this script captures the answer and writes every file inside
the run folder. API keys are stripped from the child environment so all three
run on their subscription logins.

Usage:
  council.py start --problem "..." | --brief FILE|-  [--context DIR ...]
                   [--from claude|codex|gemini] [--rounds 4] [--ask first|every|never]
                   [--home ~/Council] [--title SLUG] [--dry-run]
  council.py continue RUN_DIR [--skip-questions] [--dry-run]
  council.py status RUN_DIR
  council.py doctor [--live]

Exit codes: 0 done, 3 waiting for the user's answers, 1 error, 2 usage.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATES = HERE.parent / "templates"
AGENTS = ["claude", "codex", "gemini"]
NAMES = {"claude": "Claude", "codex": "Codex (ChatGPT)", "gemini": "Gemini"}
EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", str(Path.home() / ".local/bin"),
              str(Path.home() / ".npm-global/bin"), str(Path.home() / ".bun/bin")]
CODEX_FALLBACKS = ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
                   "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex"]
STRIP_ENV = {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY",
             "GEMINI_API_KEY", "GOOGLE_API_KEY", "CLAUDECODE"}
STRIP_PREFIX = ("CLAUDE_CODE_", "GEMINI_CLI", "CODEX_SANDBOX")
KEEP_ENV = {"CLAUDE_CODE_OAUTH_TOKEN", "CODEX_HOME", "GEMINI_CLI_HOME"}  # logins and config dirs stay
CALL_TIMEOUT = int(os.environ.get("COUNCIL_TIMEOUT_SEC", "1800"))
EXIT_DONE, EXIT_ERROR, EXIT_USAGE, EXIT_WAITING = 0, 1, 2, 3


# ---------- small helpers ----------

def now():
    return dt.datetime.now().astimezone()


def stamp():
    return now().strftime("%Y-%m-%d %H:%M %Z")


def log(run, msg):
    line = f"- {now().strftime('%H:%M:%S')} {msg}"
    with open(run / "log.md", "a") as f:
        f.write(line + "\n")
    print(line, flush=True)


def load_state(run):
    return json.loads((run / "state.json").read_text())


def save_state(run, st):
    tmp = run / "state.json.tmp"
    tmp.write_text(json.dumps(st, indent=2))
    tmp.replace(run / "state.json")


def template(name, **kw):
    text = (TEMPLATES / name).read_text()
    for k, v in kw.items():
        text = text.replace("{{" + k + "}}", str(v))
    return text


def last_json_block(text):
    blocks = re.findall(r"```json\s*(.*?)```", text, flags=re.S)
    for b in reversed(blocks):
        try:
            return json.loads(b)
        except json.JSONDecodeError:
            continue
    return None


def slugify(s):
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s.lower()).strip("-")
    return (s[:48] or "council").rstrip("-")


# ---------- running the three CLIs ----------

def find_bin(agent):
    override = os.environ.get(f"COUNCIL_{agent.upper()}_BIN")
    if override:
        return override
    path = os.pathsep.join([os.environ.get("PATH", "")] + EXTRA_PATH)
    found = shutil.which(agent, path=path)
    if found:
        return found
    if agent == "codex":
        for p in CODEX_FALLBACKS:
            if os.access(p, os.X_OK):
                return p
    return None


def child_env():
    env = {k: v for k, v in os.environ.items()
           if k in KEEP_ENV or (k not in STRIP_ENV and not k.startswith(STRIP_PREFIX))}
    env["PATH"] = os.pathsep.join([env.get("PATH", "")] + EXTRA_PATH)
    return env


def build_cmd(agent, prompt, run, context, out_file):
    b = find_bin(agent)
    if not b:
        raise RuntimeError(f"{agent} CLI not found; set COUNCIL_{agent.upper()}_BIN")
    extra = os.environ.get(f"COUNCIL_{agent.upper()}_ARGS", "").split()
    if agent == "claude":
        cmd = [b, "-p", prompt, "--output-format", "json",
               "--allowedTools", "Read,Glob,Grep,WebSearch,WebFetch",
               "--permission-prompts", "none", "--add-dir", str(run)]
        for c in context:
            cmd += ["--add-dir", c]
    elif agent == "codex":
        cmd = [b, "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
               "-C", str(run), "-o", str(out_file)]
        cmd += extra
        extra = []
        cmd.append(prompt)
    else:  # gemini
        cmd = [b, "-p", prompt, "--approval-mode", "plan", "-o", "json"]
        if context:
            cmd += ["--include-directories", ",".join(context)]
    return cmd + extra


def parse_output(agent, stdout, out_file):
    if agent == "codex":
        if out_file.exists() and out_file.stat().st_size:
            return out_file.read_text()
        return stdout
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return stdout
    if agent == "claude":
        return data.get("result") or stdout
    return data.get("response") or stdout


def fake_answer(agent, kind, rnd):
    """Dry-run stand-in so the whole pipeline can be exercised without models."""
    if kind == "framing":
        return ("D1: Which option to choose?\nD2: In what order to build?\n\n```json\n"
                '{"decisions": [{"id": "D1", "question": "Which option?"},'
                ' {"id": "D2", "question": "Build order?"}]}\n```')
    if kind == "round":
        conv = rnd >= 2
        return (f"# {NAMES[agent]}, round {rnd} (dry run)\n\nRecommendation: option A.\n\n```json\n"
                + json.dumps({"agent": agent, "round": rnd,
                              "positions": [{"id": "D1", "position": "option A", "confidence": "med"}],
                              "new_decisions": [], "open_disagreements": [] if conv else ["D2"],
                              "questions_for_user": ["Which calendar should it use?"] if rnd == 1 and agent == "codex" else [],
                              "converged": conv}) + "\n```")
    if kind in ("draft", "revise"):
        return "# Proposal (dry run)\n\n1. The answer\n\nOption A.\n\n5. Coverage check\n\n| Item | Covered |\n|---|---|\n| D1 | yes |\n"
    if kind == "review":
        return ("Looks right.\n\n```json\n"
                + json.dumps({"agent": agent, "version": 1, "sign": True, "amendments": []}) + "\n```")
    return ""


def call(agent, prompt, run, context, label, kind, rnd, dry):
    raw = run / agent / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    out_file = raw / f"{label}.last.md"
    (raw / f"{label}.prompt.md").write_text(prompt)
    if dry:
        cmd = build_cmd(agent, "<prompt>", run, context, out_file) if find_bin(agent) else [agent, "<not found>"]
        (raw / f"{label}.cmd.txt").write_text(" ".join(cmd))
        return fake_answer(agent, kind, rnd), 0
    cmd = build_cmd(agent, prompt, run, context, out_file)
    last_err = ""
    for attempt in (1, 2):
        start = time.time()
        try:
            p = subprocess.run(cmd, cwd=str(run), env=child_env(), capture_output=True,
                               text=True, timeout=CALL_TIMEOUT, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            last_err = f"timed out after {CALL_TIMEOUT}s"
            continue
        (raw / f"{label}.stdout.txt").write_text(p.stdout or "")
        (raw / f"{label}.stderr.txt").write_text(p.stderr or "")
        text = parse_output(agent, p.stdout or "", out_file).strip()
        if p.returncode == 0 and text:
            return text, round(time.time() - start)
        last_err = f"exit {p.returncode}: {(p.stderr or p.stdout or '')[-400:]}"
    raise RuntimeError(f"{agent} failed on {label}: {last_err}")


def call_many(jobs, run, context, dry):
    """jobs: list of (agent, prompt, label, kind, rnd). Runs in parallel."""
    results, errors = {}, {}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = {pool.submit(call, a, p, run, context, l, k, r, dry): a for a, p, l, k, r in jobs}
        for f, a in futs.items():
            try:
                results[a] = f.result()
            except Exception as e:  # keep the others' work
                errors[a] = str(e)
    return results, errors


# ---------- phases ----------

def common(run, st, agent):
    answers = run / "ANSWERS.md"
    ctx = st["context"]
    return {
        "AGENT_NAME": NAMES[agent], "RUN_DIR": str(run), "NOW": stamp(),
        "MAX_ROUNDS": st["max_rounds"],
        "ANSWERS_NOTE": " Also read ANSWERS.md: the user's answers override assumptions." if answers.exists() else "",
        "CONTEXT_NOTE": (" Context folders you may read: " + ", ".join(ctx) + ".") if ctx else "",
    }


def phase_framing(run, st, dry):
    a = st["from"]
    prompt = template("framing.md", **common(run, st, a))
    (res, errs) = call_many([(a, prompt, "framing", "framing", 0)], run, st["context"], dry)
    if a in errs:
        raise RuntimeError(errs[a])
    text, secs = res[a]
    data = last_json_block(text) or {}
    decs = data.get("decisions") or []
    lines = [f"# Decisions to settle\n\nProposed by {NAMES[a]} at {stamp()}. Participants may add IDs with their prefix (C, X, G).\n"]
    lines += [f"- **{d.get('id')}**: {d.get('question')}" for d in decs] or [text]
    (run / "DECISIONS.md").write_text("\n".join(lines) + "\n")
    log(run, f"framing by {a} done in {secs}s: {len(decs)} decisions")
    st["phase"], st["round"] = "round", 1


def round_files(run, agent, upto):
    return [f"{agent}/round-{i}.md" for i in range(1, upto + 1) if (run / agent / f"round-{i}.md").exists()]


def phase_round(run, st, dry):
    n = st["round"]
    jobs = []
    for a in st["agents"]:
        kw = common(run, st, a)
        if n == 1:
            others = ", ".join(f"{o}/" for o in st["agents"] if o != a)
            prompt = template("round1.md", OTHERS_DIRS=others, **kw)
        else:
            others = ", ".join(f"{o}/round-{n - 1}.md" for o in st["agents"] if o != a)
            last = (" This is the last round. Settle what you can; anything still split will be"
                    " recorded as unresolved with each position." if n == st["max_rounds"] else "")
            prompt = template("roundN.md", ROUND=n, OWN_FILES=", ".join(round_files(run, a, n - 1)) or "none",
                              OTHERS_FILES=others, LAST_ROUND_NOTE=last, **kw)
        jobs.append((a, prompt, f"round-{n}", "round", n))
    log(run, f"round {n} started")
    res, errs = call_many(jobs, run, st["context"], dry)
    verdicts = {}
    for a, (text, secs) in res.items():
        (run / a / f"round-{n}.md").write_text(text + "\n")
        v = last_json_block(text) or {"agent": a, "round": n, "parse_error": True, "converged": False}
        (run / a / f"verdict-{n}.json").write_text(json.dumps(v, indent=2))
        verdicts[a] = v
        log(run, f"round {n}: {a} done in {secs}s, converged={v.get('converged')}, open={v.get('open_disagreements')}")
    for a, e in errs.items():
        log(run, f"round {n}: {a} FAILED: {e}")
    if errs and len(res) < 2:
        raise RuntimeError(f"round {n}: fewer than two participants answered")
    if errs:
        st["agents"] = [a for a in st["agents"] if a in res]
        st.setdefault("dropped", []).extend(errs.keys())
        log(run, f"continuing without {', '.join(errs)}")

    # new decision IDs added by participants
    added = [d for v in verdicts.values() for d in (v.get("new_decisions") or [])]
    if added:
        with open(run / "DECISIONS.md", "a") as f:
            for d in added:
                f.write(f"- **{d.get('id')}** (added round {n}): {d.get('question')}\n")

    # questions for the user
    qs = sorted({q.strip() for v in verdicts.values() for q in (v.get("questions_for_user") or []) if q.strip()})
    ask = st["ask"] == "every" or (st["ask"] == "first" and n == 1)
    if qs and ask:
        with open(run / "QUESTIONS-FOR-YOU.md", "a") as f:
            f.write(f"\n## After round {n} ({stamp()})\n\nAnswer under each question in ANSWERS.md, then run `council.py continue`.\n\n")
            f.writelines(f"{i}. {q}\n" for i, q in enumerate(qs, 1))
        st["waiting"] = {"after": f"round-{n}", "since": stamp()}

    converged = n >= 2 and all(v.get("converged") and not v.get("open_disagreements") for v in verdicts.values())
    if converged:
        log(run, f"converged after round {n}")
        st["phase"] = "draft"
    elif n >= st["max_rounds"]:
        log(run, f"no full convergence after {n} rounds; drafting with unresolved items")
        st["phase"], st["unresolved"] = "draft", True
    else:
        st["round"] = n + 1


def all_round_files(run, st):
    return ", ".join(f for a in AGENTS for f in round_files(run, a, st["round"]))


def phase_draft(run, st, dry):
    d = st["drafter"] if st["drafter"] in st["agents"] else st["agents"][0]
    st["drafter"] = d
    prompt = template("draft.md", ALL_ROUND_FILES=all_round_files(run, st), **common(run, st, d))
    res, errs = call_many([(d, prompt, "draft-v1", "draft", 0)], run, st["context"], dry)
    if d in errs:
        raise RuntimeError(errs[d])
    (run / "consensus").mkdir(exist_ok=True)
    (run / "consensus" / "PROPOSAL-v1.md").write_text(res[d][0] + "\n")
    log(run, f"draft v1 by {d} in {res[d][1]}s")
    st["phase"], st["version"] = "review", 1


def phase_review(run, st, dry):
    v = st["version"]
    pf = f"consensus/PROPOSAL-v{v}.md"
    reviewers = [a for a in st["agents"] if a != st["drafter"]]
    jobs = []
    for a in reviewers:
        prompt = template("review.md", PROPOSAL_FILE=pf, VERSION=v,
                          OWN_FILES=", ".join(round_files(run, a, st["round"])) or "none", **common(run, st, a))
        jobs.append((a, prompt, f"review-v{v}", "review", 0))
    res, errs = call_many(jobs, run, st["context"], dry)
    signs = {}
    for a, (text, secs) in res.items():
        (run / "consensus" / f"review-{a}-v{v}.md").write_text(text + "\n")
        verdict = last_json_block(text) or {"sign": False, "amendments": [{"section": "?", "change": "unparseable review", "reason": ""}]}
        signs[a] = verdict
        log(run, f"review v{v}: {a} sign={verdict.get('sign')} amendments={len(verdict.get('amendments') or [])}")
    for a, e in errs.items():
        log(run, f"review v{v}: {a} FAILED: {e}")
    st.setdefault("signatures", {})[f"v{v}"] = {a: bool(s.get("sign")) for a, s in signs.items()}
    needs_change = any(not s.get("sign") or s.get("amendments") for s in signs.values())
    if not needs_change and not errs:
        st["phase"] = "final"
    elif v >= 3:
        log(run, "stopping revisions at v3; recording reviewers' remaining objections")
        st["phase"] = "final"
    else:
        st["phase"] = "revise"


def phase_revise(run, st, dry):
    v, d = st["version"], st["drafter"]
    reviews = ", ".join(f"consensus/review-{a}-v{v}.md" for a in st["agents"] if a != d
                        and (run / "consensus" / f"review-{a}-v{v}.md").exists())
    prompt = template("revise.md", PROPOSAL_FILE=f"consensus/PROPOSAL-v{v}.md", VERSION=v,
                      NEXT_VERSION=v + 1, REVIEW_FILES=reviews, **common(run, st, d))
    res, errs = call_many([(d, prompt, f"revise-v{v + 1}", "revise", 0)], run, st["context"], dry)
    if d in errs:
        raise RuntimeError(errs[d])
    (run / "consensus" / f"PROPOSAL-v{v + 1}.md").write_text(res[d][0] + "\n")
    log(run, f"revision v{v + 1} by {d} in {res[d][1]}s")
    st["version"], st["phase"] = v + 1, "review"


def phase_final(run, st):
    v = st["version"]
    src = run / "consensus" / f"PROPOSAL-v{v}.md"
    body = src.read_text()
    digest = hashlib.sha256(body.encode()).hexdigest()
    shutil.copyfile(src, run / "consensus" / "PROPOSAL.md")
    sigs = st.get("signatures", {}).get(f"v{v}", {})
    all_signed = sigs and all(sigs.values())
    lines = [
        "# Council result", "",
        f"Finished {stamp()}. Proposal version v{v}, drafted by {NAMES[st['drafter']]}.",
        f"SHA-256 of consensus/PROPOSAL.md: `{digest}`", "",
        "## Sign-off", "",
        f"- {NAMES[st['drafter']]}: drafter",
    ]
    lines += [f"- {NAMES[a]}: {'signed' if ok else 'did not sign, see review file'}" for a, ok in sigs.items()]
    lines += ["", "## Status", "",
              "All participants signed." if all_signed else "Not unanimous. Read the review files before acting."]
    if st.get("unresolved"):
        lines.append("Some decisions were still split after the last round; see the Unresolved rows.")
    if st.get("dropped"):
        lines.append(f"Participants dropped after errors: {', '.join(st['dropped'])}.")
    lines += ["", f"Rounds: {st['round']}. Full timeline in log.md."]
    (run / "consensus" / "FINAL.md").write_text("\n".join(lines) + "\n")
    log(run, f"final: v{v}, unanimous={bool(all_signed)}, sha256={digest[:12]}")
    st["phase"], st["sha256"] = "done", digest


def run_loop(run, dry):
    st = load_state(run)
    while st["phase"] != "done":
        if st.get("waiting"):
            save_state(run, st)
            print(f"\nWAITING: questions for the user in {run}/QUESTIONS-FOR-YOU.md")
            print(f"Write answers to {run}/ANSWERS.md, then: council.py continue {run}")
            return EXIT_WAITING
        try:
            if st["phase"] == "framing":
                phase_framing(run, st, dry)
            elif st["phase"] == "round":
                phase_round(run, st, dry)
            elif st["phase"] == "draft":
                phase_draft(run, st, dry)
            elif st["phase"] == "review":
                phase_review(run, st, dry)
            elif st["phase"] == "revise":
                phase_revise(run, st, dry)
            elif st["phase"] == "final":
                phase_final(run, st)
        except Exception as e:
            st["error"] = str(e)
            save_state(run, st)
            log(run, f"ERROR in {st['phase']}: {e}")
            print(f"Fix the problem and run: council.py continue {run}")
            return EXIT_ERROR
        st.pop("error", None)
        save_state(run, st)
    print(f"\nDONE: {run}/consensus/PROPOSAL.md and {run}/consensus/FINAL.md")
    return EXIT_DONE


# ---------- commands ----------

def cmd_start(a):
    if a.brief:
        text = sys.stdin.read() if a.brief == "-" else Path(a.brief).expanduser().read_text()
    elif a.problem:
        text = a.problem
    else:
        print("Give --problem or --brief", file=sys.stderr)
        return EXIT_USAGE
    home = Path(a.home).expanduser().resolve()
    title = a.title or slugify(text.strip().splitlines()[0] if text.strip() else "council")
    run = home / f"{now().strftime('%Y-%m-%d-%H%M')}-{title}"
    for ag in AGENTS:
        (run / ag).mkdir(parents=True, exist_ok=True)
    (run / "brief.md").write_text(f"# Brief\n\nStarted from {NAMES[a.start_from]} at {stamp()}.\n\n{text.strip()}\n")
    shutil.copyfile(TEMPLATES / "protocol.md", run / "PROTOCOL.md")
    context = [str(Path(c).expanduser().resolve()) for c in (a.context or [])]
    agents = [x for x in AGENTS if x in (a.only.split(",") if a.only else AGENTS)]
    st = {"phase": "framing", "round": 0, "max_rounds": a.rounds, "from": a.start_from,
          "drafter": a.drafter or "claude", "ask": a.ask, "context": context, "agents": agents,
          "started": stamp()}
    save_state(run, st)
    log(run, f"run created from {a.start_from}; agents={agents}; context={context}")
    print(f"RUN_DIR={run}")
    return run_loop(run, a.dry_run)


def cmd_continue(a):
    run = Path(a.run_dir).expanduser().resolve()
    st = load_state(run)
    if st.get("waiting"):
        if not (run / "ANSWERS.md").exists() and not a.skip_questions:
            print(f"No ANSWERS.md in {run}. Write it or pass --skip-questions.")
            return EXIT_WAITING
        log(run, "continuing " + ("with ANSWERS.md" if (run / "ANSWERS.md").exists() else "without answers"))
        st.pop("waiting")
        save_state(run, st)
    return run_loop(run, a.dry_run)


def cmd_status(a):
    run = Path(a.run_dir).expanduser().resolve()
    st = load_state(run)
    print(json.dumps({k: st.get(k) for k in ("phase", "round", "max_rounds", "version", "agents", "drafter",
                                              "waiting", "error", "sha256")}, indent=2))
    tail = (run / "log.md").read_text().splitlines()[-8:]
    print("\n".join(tail))
    return EXIT_DONE


def cmd_doctor(a):
    ok = True
    for ag in AGENTS:
        b = find_bin(ag)
        ver = ""
        if b:
            try:
                ver = subprocess.run([b, "--version"], capture_output=True, text=True, timeout=30,
                                     env=child_env()).stdout.strip().splitlines()[0]
            except Exception as e:
                ver = f"version check failed: {e}"
        print(f"{ag:7} {'found' if b else 'MISSING'}  {b or ''}  {ver}")
        ok = ok and bool(b)
    stripped = sorted(k for k in os.environ if k in STRIP_ENV)
    if stripped:
        print(f"note: these will be removed from the child environment: {', '.join(stripped)}")
    if a.live and ok:
        import tempfile
        tmp = Path(tempfile.mkdtemp(prefix="council-doctor-"))
        for ag in AGENTS:
            (tmp / ag).mkdir()
            try:
                text, secs = call(ag, 'Reply with exactly: ```json\n{"ok": true}\n```', tmp, [], "doctor", "doctor", 0, False)
                good = (last_json_block(text) or {}).get("ok") is True
                print(f"{ag:7} live call {'OK' if good else 'answered but not in the expected format'} ({secs}s)")
            except Exception as e:
                ok = False
                print(f"{ag:7} live call FAILED: {e}")
        print(f"doctor files: {tmp}")
    return EXIT_DONE if ok else EXIT_ERROR


def main():
    p = argparse.ArgumentParser(description="Claude, Codex and Gemini debate to a signed proposal.")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("start")
    s.add_argument("--problem")
    s.add_argument("--brief", help="file with the brief, or - for stdin")
    s.add_argument("--context", action="append", help="folder the participants may read (repeatable)")
    s.add_argument("--from", dest="start_from", choices=AGENTS, default="claude",
                   help="which app started the run; it also frames the decisions")
    s.add_argument("--drafter", choices=AGENTS)
    s.add_argument("--rounds", type=int, default=4)
    s.add_argument("--ask", choices=["first", "every", "never"], default="first")
    s.add_argument("--only", help="comma list to run fewer participants, e.g. claude,gemini")
    s.add_argument("--home", default=os.environ.get("COUNCIL_HOME", "~/Council"))
    s.add_argument("--title")
    s.add_argument("--dry-run", action="store_true")
    c = sub.add_parser("continue")
    c.add_argument("run_dir")
    c.add_argument("--skip-questions", action="store_true")
    c.add_argument("--dry-run", action="store_true")
    t = sub.add_parser("status")
    t.add_argument("run_dir")
    d = sub.add_parser("doctor")
    d.add_argument("--live", action="store_true", help="send one tiny prompt to each CLI")
    a = p.parse_args()
    return {"start": cmd_start, "continue": cmd_continue, "status": cmd_status, "doctor": cmd_doctor}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
