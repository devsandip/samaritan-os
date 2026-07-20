import type {
  DraftActionItem,
  RunContext,
  RunResult,
} from "../../src/run-layer/context.js";

/**
 * Newsletter Digest (TECH-SPEC §4.6, §5.2).
 *
 * Reads one newsletter email and decides whether it is worth Sandip's
 * attention. What it decides does not settle anything: it sets `worth_acting`,
 * and the Policy Engine reads that and either escalates the item or files it.
 * The capability has an opinion; the OS has the authority.
 *
 * The matching here is keyword-based and deliberately dumb. §4.6 sketches an
 * LLM `summarizeNewsletter()` and that is the right long-term shape, but a
 * demo capability that needs a network call and an API key has a failure mode
 * on stage that no amount of testing removes. `score()` is the seam: replace
 * its body with a model call and nothing else in this file changes.
 */

/** Fallback for `user.interests`, which nothing injects yet (§5.2 context.requires). */
const DEFAULT_INTERESTS = [
  "agent",
  "evals",
  "local-first",
  "product management",
  "pricing",
  "retrieval",
  "sqlite",
];

interface EmailMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
  permalink?: string;
  received_at?: string;
}

interface Score {
  worthActing: boolean;
  confidence: number;
  matched: string[];
  summary: string;
  links: string[];
}

const LINK = /https?:\/\/[^\s<>")\]]+/g;
// Separate and non-global on purpose: `test()` on a /g regex advances its
// lastIndex between calls, so sharing one instance makes the same paragraph
// match or not depending on what was checked before it.
const HAS_LINK = /https?:\/\//;

/** First sentence or two, collapsed onto one line. */
function lead(body: string, limit = 240): string {
  const prose = body
    .split(/\n{2,}/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .find((p) => p.length > 40 && !HAS_LINK.test(p));
  const text = (prose ?? body.replace(/\s+/g, " ")).trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/**
 * The judgement seam. Everything above is parsing; this is the part that would
 * become a model call.
 */
function score(email: EmailMessage, interests: string[]): Score {
  const haystack = `${email.subject}\n${email.body}`.toLowerCase();
  const matched = interests.filter((interest) => haystack.includes(interest.toLowerCase()));
  const links = [...new Set(email.body.match(LINK) ?? [])].slice(0, 5);

  // Two or more hits reads as on-topic rather than coincidental. One hit is the
  // ambiguous case, and it lands below confidence_threshold on purpose so the
  // manifest escalates it rather than this function guessing.
  const worthActing = matched.length >= 2;
  const confidence = matched.length === 0 ? 0.82 : matched.length === 1 ? 0.55 : 0.88;

  return { worthActing, confidence, matched, summary: lead(email.body), links };
}

function asEmail(value: unknown): EmailMessage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const email = value as Partial<EmailMessage>;
  if (!email.id || !email.subject || typeof email.body !== "string") return undefined;
  return {
    id: email.id,
    from: email.from ?? "unknown",
    subject: email.subject,
    body: email.body,
    ...(email.permalink ? { permalink: email.permalink } : {}),
    ...(email.received_at ? { received_at: email.received_at } : {}),
  };
}

export async function run(context: RunContext): Promise<RunResult> {
  const raw = context.inputs["email.message"] ?? context.trigger.payload;
  const emails = (Array.isArray(raw) ? raw : [raw]).map(asEmail).filter(Boolean) as EmailMessage[];

  if (!emails.length) {
    return {
      action_items: [],
      status: "ok",
      logs: [
        'no usable "email.message" input. Pass one with ' +
          "--input-file, or wait for the Event Bus to supply it (§12 step 18).",
      ],
    };
  }

  const interests = Array.isArray(context.inputs["user.interests"])
    ? (context.inputs["user.interests"] as string[])
    : DEFAULT_INTERESTS;

  const logs: string[] = [];
  const action_items: DraftActionItem[] = emails.map((email) => {
    const { worthActing, confidence, matched, summary, links } = score(email, interests);
    logs.push(
      `${email.subject}: ${matched.length} interest match(es), ` +
        `worth_acting=${worthActing}, confidence=${confidence}`,
    );

    const notes = matched.length
      ? `matches ${matched.join(", ")}`
      : "no overlap with your interests";

    return {
      capability_id: "newsletter-digest",
      type: "newsletter-digest-review",
      context: {
        what_happened: `Read "${email.subject}" from ${email.from}`,
        source: {
          kind: "email",
          id: email.id,
          ...(email.permalink ? { link: email.permalink } : {}),
        },
        provenance: ["email.received", "newsletter-digest.run"],
        why_flagged: notes,
        // §4.2's vocabulary: something worth acting on is flagged for its value,
        // something ambiguous is flagged because the capability is unsure.
        trigger_reason: worthActing ? "value" : "confidence",
        confidence,
        decision_needed: worthActing
          ? "File this as an insight?"
          : "Nothing needed; filing this as a note",
        decision_surface: "inbox",
        execution_surface: worthActing ? "notion" : "obsidian",
        outcome_preview: worthActing
          ? `Creates an Insight row in Notion: "${summary.slice(0, 60)}…"`
          : "Appends a line to today's daily note",
      },
      custom: {
        // The kind is what pm-os.item.file dispatches on, so this one field
        // decides whether approving reaches Notion or the vault.
        kind: worthActing ? "insight" : "note",
        title: email.subject,
        detail: summary,
        project: "",
        owner: "",
        due: "",
        evidence: email.permalink ?? `email:${email.id}`,
        worth_acting: worthActing,
        top_links: links,
        relevance_notes: notes,
      },
      dedupe_key: `newsletter:${email.id}`,
    };
  });

  return { action_items, status: "ok", logs };
}
