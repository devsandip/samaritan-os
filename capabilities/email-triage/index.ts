import type {
  DraftActionItem,
  RunContext,
  RunResult,
} from "../../src/run-layer/context.js";

/**
 * Email Triage (TECH-SPEC §11(b), §5.2).
 *
 * Classifies a message, and drafts a reply for the ones that need one. Mail
 * that needs no reply produces no action item at all: an Inbox that shows you
 * everything is the thing this system exists to replace, so the capability's
 * first job is deciding what not to surface.
 *
 * `classify()` and `draft()` are the seams where a model call belongs. They
 * are rule-based here for the same reason the rest of the roster is, and the
 * rules are visible enough that a wrong classification is obvious rather than
 * mysterious.
 */

interface EmailMessage {
  id: string;
  from: string;
  from_name?: string;
  subject: string;
  body: string;
  thread_id?: string;
  permalink?: string;
  received_at?: string;
}

type Urgency = "routine" | "timely" | "urgent";

/** Phrases that mean someone is waiting on Sandip specifically. */
const ASK = [
  /\bcould you\b/i,
  /\bcan you\b/i,
  /\bwould you\b/i,
  /\bplease (?:review|send|confirm|sign|approve|share)\b/i,
  /\bwhat(?:'s| is) your (?:take|view|read)\b/i,
  /\blet me know\b/i,
  /\bthoughts\?/i,
  /\bany update\b/i,
];

const URGENT = /\b(?:today|eod|end of day|asap|urgent|blocked|blocker|deadline|by tomorrow)\b/i;
const TIMELY = /\b(?:this week|by friday|soon|shortly|before the|ahead of)\b/i;

/** Mail that is announcing rather than asking. Never worth a reply. */
const BROADCAST = /\b(?:no-?reply|do-?not-?reply|newsletter|notification|automated)\b/i;

interface Classification {
  needsReply: boolean;
  urgency: Urgency;
  asks: string[];
  reason: string;
}

function classify(email: EmailMessage): Classification {
  const text = `${email.subject}\n${email.body}`;

  if (BROADCAST.test(email.from) || BROADCAST.test(email.subject)) {
    return { needsReply: false, urgency: "routine", asks: [], reason: "broadcast sender" };
  }

  // The sentences that actually contain a request, kept verbatim. A summary of
  // an ask is a paraphrase of someone else's words, and getting that subtly
  // wrong in a draft reply is worse than not drafting at all.
  const sentences = text.split(/(?<=[.?!])\s+/).map((s) => s.replace(/\s+/g, " ").trim());
  const asks = sentences.filter((s) => ASK.some((pattern) => pattern.test(s))).slice(0, 3);

  const urgency: Urgency = URGENT.test(text) ? "urgent" : TIMELY.test(text) ? "timely" : "routine";

  return {
    needsReply: asks.length > 0,
    urgency,
    asks,
    reason: asks.length ? `${asks.length} direct ask(s)` : "nothing addressed to you",
  };
}

function firstName(email: EmailMessage): string {
  const name = email.from_name ?? email.from.split("<")[0]?.trim() ?? "";
  const first = name.replace(/["']/g, "").split(/\s+/)[0];
  return first && !first.includes("@") ? first : "there";
}

/** The other seam. A holding reply Sandip edits, not a finished one. */
function draft(email: EmailMessage, classification: Classification): string {
  const lines = [`Hi ${firstName(email)},`, ""];

  if (classification.asks.length === 1) {
    lines.push(`On "${classification.asks[0]}" —`, "");
  } else if (classification.asks.length > 1) {
    lines.push("Taking these in order:", "");
    for (const ask of classification.asks) lines.push(`- ${ask}`, "");
  }

  lines.push(
    "[TODO: the actual answer]",
    "",
    classification.urgency === "urgent"
      ? "I know this is time-sensitive, so shout if you need it sooner."
      : "Happy to go deeper on any of this.",
    "",
    "Sandip",
  );
  return lines.join("\n");
}

function asEmail(value: unknown): EmailMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const email = value as Partial<EmailMessage>;
  if (!email.id || !email.subject || typeof email.body !== "string") return undefined;
  return { ...email, id: email.id, from: email.from ?? "unknown", subject: email.subject, body: email.body };
}

export async function run(context: RunContext): Promise<RunResult> {
  const raw = context.inputs["email.message"] ?? context.trigger.payload;
  const emails = (Array.isArray(raw) ? raw : [raw]).map(asEmail).filter(Boolean) as EmailMessage[];

  if (!emails.length) {
    return {
      action_items: [],
      status: "ok",
      logs: ['no usable "email.message" input; pass one with --input-file'],
    };
  }

  const logs: string[] = [];
  const action_items: DraftActionItem[] = [];

  for (const email of emails) {
    const classification = classify(email);
    logs.push(`${email.subject}: ${classification.reason}, urgency=${classification.urgency}`);
    // Silence is the common case and it is a feature, not a gap in coverage.
    if (!classification.needsReply) continue;

    action_items.push({
      capability_id: "email-triage",
      type: "email-reply-review",
      context: {
        what_happened: `${email.from} asked you something in "${email.subject}"`,
        source: {
          kind: "email",
          id: email.id,
          ...(email.permalink ? { link: email.permalink } : {}),
        },
        provenance: ["email.received", "email-triage.run"],
        why_flagged: classification.reason,
        // §11(b): sending email escalates on what it is, not on how sure the
        // capability is. Saying "confidence" here would be a lie about why
        // this is in front of him.
        trigger_reason: "action_type",
        confidence: 0.74,
        decision_needed: "Send this reply, or edit it first?",
        decision_surface: "inbox",
        execution_surface: "gmail",
        outcome_preview:
          "Stages a Gmail draft. Nothing is sent until you open it and hit send.",
      },
      custom: {
        from: email.from,
        subject: email.subject,
        thread_summary: classification.asks.join(" ") || email.subject,
        draft_body: draft(email, classification),
        urgency: classification.urgency,
        asks: classification.asks,
      },
      // Threaded, so a second message on the same thread supersedes the draft
      // rather than stacking a second review on top of it (§5.1 branch 2).
      dedupe_key: `email-triage:${email.thread_id ?? email.id}`,
    });
  }

  return { action_items, status: "ok", logs };
}
