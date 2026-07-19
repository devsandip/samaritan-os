log
capture
decision
meeting
file
wrap
recall


Here's what each does — I'll note the trigger, what it writes, and where, since that matters for where HITL gates make sense.

**Capture-side (fast, low-friction in):**

- **`capture`** — Dumps a raw thought into today's **Inbox in Obsidian**, with _no routing or categorizing_ at capture time. Deliberately dumb-on-purpose: fire instantly, no questions asked. For stray ideas with no clear home yet. (`/capture [thought]`, or Telegram.)
    
- **`log`** — Appends a 1-3 sentence "what just happened" entry to today's **Hourly Log in Obsidian**. Fuel for weekly synthesis. Fire eagerly whenever you describe what you just worked on. (`/log [text]`, or Telegram.)
    

**Structure-side (turn things into typed rows):**

- **`decision`** — Files a structured **Decision row to Notion** with rationale, project link, and a reversibility classification. For when you've made or are finalizing a decision. It's the audit trail. (`/decision [what + why]`.)
    
- **`file`** — Explicitly writes a typed row to **Notion** (decision / insight / person / project) with **no extraction or inference** — you've already decided exactly what to write, so it skips the conversation. (`/file [type] [content]`, or "just file it as X".)
    
- **`meeting`** — Processes a meeting (often a Fireflies transcript) into a structured **Obsidian note + extracted Notion rows + TickTick tasks**. Pulls decisions and next-steps out of the raw transcript. (`/meeting [topic]`.)
    
- **`wrap`** — Session-close routine. Scans the _whole conversation_ for decisions, insights, people mentioned, and next-step tasks, and files them all across **Notion / TickTick / Obsidian**. Auto-fires if a session yields ≥3 structured items. (`/wrap`, or "we're done".)
    

**Retrieve-side (get things back out):**

- **`recall`** — Answers a question by querying the OS — **Notion DBs first, then Obsidian** files for prose context — grounding every answer in row IDs and file paths so it's auditable. (`/recall [question]`, "what did we decide about X", "who owns Y".)

The arc is **capture → structure → recall**: dump cheaply (capture/log), promote to typed rows (decision/file/meeting/wrap), query later (recall).

And here's the distinction that's going to matter for our HITL design — split them by **how much the agent infers**:

- **Explicit, no inference:** `capture`, `log`, `file` — you told it exactly what to write, so there's low risk of the agent being _wrong_.
- **Extraction / inference — the agent makes judgment calls:** `meeting` and `wrap` read raw material and _decide_ what's a decision, what's a task, who's a person, and how to classify it. That's exactly where the agent can be wrong — mis-extract, hallucinate a task, misclassify reversibility, file a garbage row into Notion.

So the natural home for a HITL review gate is **`wrap` and `meeting`** — the two skills where an agent proposes structured writes it inferred, and you'd want to approve/edit before they commit. That's the anchor use case I'd argue for. Does that match how you actually use the system — is `wrap`/`meeting` where you'd most want a human check before things hit Notion?

7 scheduled jobs

I like this: https://youtu.be/w0S-khYCaB4?si=2eBgDbbGhZ9B45bq

What are PMs using agentic OS for?
work
1. Meeting - record notes, synthesize, record decision, send out minutes, generate tasks. before every meeting remind me the context and why this meeting has been scheduled
2. Calendaring - read messages and screenshots and schedule meetings, auto arrange my calendar
3. Tasks - create tasks based on what my pending items are, what meeting i have and any other priorities i have. remind me of recent tasks I added in backlog that dont have due date
4. Writing & reviewing PRDs - 
5. Decision- recall past decision, 
6. Email - reading email, preparing responses, holding off on things it needs me for 
7. How are my products doing - posthog etc

Personal stuff:
1. read whatsapp and imessage and tell me there is anything important
2. read bills and spending
3. remind me of payments

Coding/building
1. WBR from journal
2. are any claude code sessions waiting for any input

Job search
1. new jobs i should apply to
2. upcoming interviews
3. respond to recruiters
4. 