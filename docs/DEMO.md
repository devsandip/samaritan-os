# Demoing Samaritan

Three beats: an agent posts to the Inbox, you act on it, and you add a new
agent live. Twelve minutes at a walk.

Everything below runs offline. No API key, no OAuth, no network.

---

## Setup

Use a demo store rather than your real one, so nothing you do on stage touches
your actual vault or Notion.

```bash
mkdir -p ~/.samaritan/demo/vault
cat > ~/.samaritan/demo/config.yaml <<'EOF'
server:
  port: 4199
paths:
  db: ~/.samaritan/demo/samaritan.db
  vault: ~/.samaritan/demo/vault
EOF
export SAMARITAN_CONFIG=~/.samaritan/demo/config.yaml

pnpm install
pnpm build:ui
pnpm seed
pnpm serve
```

Open `http://127.0.0.1:4199/`.

`pnpm seed` fills the Inbox by running every agent against its demo fixture,
**through the real ingest path**. Nothing is hand-written into the database, so
every audit trail you open on stage is true. Expect roughly:

| status | count | where it shows |
|---|---|---|
| `pending` | 9 | Inbox |
| `awaiting_confirmation` | 1 | Inbox, waiting on you to confirm you did it |
| `executed` | 2 | Handled automatically today |
| `deferred` | 1 | Deferred |
| `rejected` | 1 | Completed |

The Inbox badge reads **10**: it counts `awaiting_confirmation` too, because
that item still needs something from you.

To start over: `pnpm seed --clear` then `pnpm seed --force`. `--clear` resolves
the open items rather than deleting them, because the audit trail is
append-only and erasing it would be both impossible and wrong.

---

## Beat 1: an agent posts to the Inbox

Start on the **Dashboard**. Six agents, each with a status dot and a last-run
time.

Point at **Email Triage**, which is red: *"degraded to guided:
`gmail.draft.create` is not registered."* Nothing is broken. The manifest asks
for assisted mode; no Gmail adapter exists; the OS dropped it to a mode that
works rather than failing. It promotes itself the day that adapter registers.

Now hit **Run now** on **Newsletter Digest**.

It reads two newsletters. One matches your interests and lands in the Inbox.
The other clears the confidence threshold and files itself without ever being
seen. Same agent, same item type, two outcomes, and the capability did not
decide either one: it set `worth_acting` and the Policy Engine decided.

> This is the pitch in one click. The agent has an opinion. The OS has the
> authority.

---

## Beat 2: acting on one

Open the **Inbox**. Three things to show, in order.

### The audit trail is real

Open any item and scroll to **Audit trail**. Creation by the capability, the
policy decision, and every response since. Nothing here was written by a demo
script; the seed drove the same API you are about to click.

### The assisted loop does not end at approve

Filter to **Email · 1**. This is a draft reply to a real-looking ask.

Edit a line of the draft, then **Send it**.

It goes to **awaiting confirmation**, not to done. Samaritan staged a draft; it
did not send anything. The item stays open until you click **Mark as done**,
because the truthful answer to "did this happen?" lives in Gmail, not here.

Click **Mark as done**. Now it is executed, and the trail shows both halves.

### The money lock

Filter to **Subscription · 3**. Open **Figma Organization**: $540 renewing in
four days, untouched for 97.

Show the manifest if the room is technical:

```yaml
execution:
  mode: automated        # asks to be automated
  action_type: payment.make
policy:
  auto_complete_when: "true"   # asks to skip review entirely
```

It asks for both. It gets neither. The badge reads **Guided**, and clicking
**Let it renew** does not pay anything — it hands you the steps and waits.

Three independent layers refuse, and they do not consult each other: the Policy
Engine checks the money lock before any manifest predicate, Routing ships
`payment.make` locked so the mode is decided elsewhere, and the Execution
Registry will not register an automated adapter in that namespace at all.

> The strongest thing you can say about an autonomous system is what it refuses
> to do.

---

## Beat 3: adding an agent, live

```bash
pnpm new-capability standup-notes
```

Two files. Show `capabilities/standup-notes/manifest.yaml` briefly — what it
emits, how it renders, when it escalates.

```bash
pnpm run-capability standup-notes
```

Go to **Settings** → **Rescan capabilities/**. It appears in the grid. Back to
the **Inbox**: its item is there, reviewable, with an audit trail.

No restart. No registration list. No code anywhere else that knows the name
`standup-notes`. Adding an agent is dropping a folder in.

### The version that lands harder, if you have an audience with scheduled tasks

```bash
pbpaste | pnpm import-task --id morning-brief --cron "0 7 * * *"
```

Paste the instructions from any Claude scheduled task you already run. Out
comes an agent that keeps calling Claude with that exact prompt, unchanged, but
whose output now waits in the Inbox instead of committing itself.

Needs `ANTHROPIC_API_KEY` to actually run, so decide beforehand whether you are
demoing the conversion or the execution.

---

## Questions you will get

**"Is this data real?"** The fixtures are written. Everything else is: the
policy decisions, the audit trails, the state machine, the files written to the
vault. Open `~/.samaritan/demo/vault/Areas/Weekly/` and show the digest the
weekly agent actually wrote.

**"How smart are the agents?"** Four of the six are rule-based, on purpose. A
demo agent that needs a network round-trip and an API key has a failure mode on
stage that testing does not remove. `wrap` and `meeting` are LLM-driven and
already in daily use, and `import-task` produces LLM-backed agents. The point
of the platform is that it does not care which kind posts to it.

**"What happens when an agent breaks?"** Run this if you want to show it:

```bash
echo 'export async function run() { throw new Error("boom"); }' \
  > capabilities/standup-notes/index.ts
pnpm run-capability standup-notes
```

The report says what failed, the card goes red, and every other agent is
unaffected. Then restore it or delete the folder.

**"What is not built?"** Say it plainly: no daemon, so nothing fires on a
schedule yet — the crons are declarations. No Event Bus, so event-mode agents
run when you run them. Recall is indexed but not queryable, which is why the
sidebar says so instead of pretending. Everything on screen works.

---

## Before you present

```bash
pnpm test        # 330 tests. test/agents.test.ts is this document, executable.
pnpm typecheck
```

`test/agents.test.ts` asserts every beat above. If a demo step here is wrong,
that file fails first.
