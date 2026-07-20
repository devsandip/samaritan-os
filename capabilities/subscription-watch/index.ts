import type {
  DraftActionItem,
  RunContext,
  RunResult,
} from "../../src/run-layer/context.js";

/**
 * Subscription Watch (TECH-SPEC §9, §5.2).
 *
 * Surfaces recurring charges that are about to renew and no longer look worth
 * it. It forms an opinion, in `worth_keeping`, and that opinion has no
 * authority whatsoever: everything this capability emits is money-locked, so
 * the Policy Engine escalates it before it ever reads the manifest's policy
 * block.
 *
 * That is the interesting part. The capability is written as though it could
 * automate this. It cannot, and nothing it does can change that.
 */

interface Subscription {
  vendor: string;
  amount: number;
  currency?: string;
  renews_on: string;
  last_used?: string;
  seats?: number;
  note?: string;
}

const DAY = 86_400_000;

/** How many days out to care about. Anything further is not yet a decision. */
const HORIZON_DAYS = 14;

/** `+5d` / `-90d`, relative to the run. Anything else is parsed as a date. */
const RELATIVE = /^([+-]\d+)d$/;

function daysUntil(iso: string, from: Date): number | undefined {
  const relative = RELATIVE.exec(iso);
  // A real subscriptions feed sends dates. Fixtures cannot: a hardcoded date
  // falls outside the horizon a fortnight after it is written, and a demo that
  // quietly stops producing items is worse than one that never worked.
  if (relative) return Number(relative[1]);

  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  // Compared on calendar days, not elapsed milliseconds: "renews tomorrow" has
  // to mean tomorrow's date, not 24 hours from whenever the cron happened.
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const target = new Date(then);
  const end = Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  return Math.round((end - start) / DAY);
}

function money(amount: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function humanDays(days: number): string {
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

interface Judgement {
  worthKeeping: boolean;
  recommendation: string;
  confidence: number;
}

/** The seam. Rule-based, and the rule is stated so a wrong call is arguable. */
function judge(sub: Subscription, unusedDays: number | undefined): Judgement {
  const cost = money(sub.amount, sub.currency);

  if (unusedDays === undefined) {
    return {
      worthKeeping: true,
      recommendation: `${cost} renewing, and I have no usage data for it. Worth a look.`,
      confidence: 0.4,
    };
  }
  if (unusedDays >= 60) {
    return {
      worthKeeping: false,
      recommendation: `Untouched for ${unusedDays} days and about to take ${cost}. I would cancel.`,
      confidence: 0.85,
    };
  }
  if (unusedDays >= 21) {
    return {
      worthKeeping: false,
      recommendation: `Last used ${unusedDays} days ago. ${cost} is a lot for something you have stopped opening.`,
      confidence: 0.6,
    };
  }
  return {
    worthKeeping: true,
    recommendation: `Used ${unusedDays} days ago. ${cost} looks earned.`,
    confidence: 0.8,
  };
}

function asSubscription(value: unknown): Subscription | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const sub = value as Partial<Subscription>;
  if (!sub.vendor || typeof sub.amount !== "number" || !sub.renews_on) return undefined;
  return {
    vendor: sub.vendor,
    amount: sub.amount,
    renews_on: sub.renews_on,
    ...(sub.currency ? { currency: sub.currency } : {}),
    ...(sub.last_used ? { last_used: sub.last_used } : {}),
    ...(sub.seats ? { seats: sub.seats } : {}),
    ...(sub.note ? { note: sub.note } : {}),
  };
}

export async function run(context: RunContext): Promise<RunResult> {
  const raw = context.inputs["subscriptions.renewals"] ?? context.trigger.payload;
  const subs = (Array.isArray(raw) ? raw : [raw]).map(asSubscription).filter(Boolean) as Subscription[];

  if (!subs.length) {
    return {
      action_items: [],
      status: "ok",
      logs: ['no usable "subscriptions.renewals" input; pass one with --input-file'],
    };
  }

  const now = new Date(context.trigger.firedAt);
  const logs: string[] = [];
  const action_items: DraftActionItem[] = [];

  for (const sub of subs) {
    const until = daysUntil(sub.renews_on, now);
    if (until === undefined || until < 0 || until > HORIZON_DAYS) {
      logs.push(`${sub.vendor}: renews ${sub.renews_on}, outside the ${HORIZON_DAYS}-day horizon`);
      continue;
    }

    // Resolved to a real date so the card never shows "+5d" and the dedupe key
    // names the renewal it is actually about.
    const renewsOn = new Date(now.getTime() + until * DAY).toISOString().slice(0, 10);

    const unused = sub.last_used ? daysUntil(sub.last_used, now) : undefined;
    const unusedDays = unused === undefined ? undefined : Math.abs(unused);
    const { worthKeeping, recommendation, confidence } = judge(sub, unusedDays);
    logs.push(`${sub.vendor}: renews ${humanDays(until)}, worth_keeping=${worthKeeping}`);

    action_items.push({
      capability_id: "subscription-watch",
      type: "renewal-review",
      context: {
        what_happened: `${sub.vendor} renews ${humanDays(until)} for ${money(sub.amount, sub.currency)}`,
        source: { kind: "subscription", id: `${sub.vendor}:${renewsOn}` },
        provenance: ["schedule.daily", "subscription-watch.run", "policy.money_lock"],
        why_flagged: "money never moves automatically, whatever the capability thinks",
        // §4.2's vocabulary. Not confidence and not value: this is in front of
        // him because of what kind of action it is, full stop.
        trigger_reason: "action_type",
        confidence,
        decision_needed: `Let ${sub.vendor} renew, or cancel it?`,
        decision_surface: "inbox",
        // Deliberately not a provider. Nothing in Samaritan can execute this,
        // and naming one would imply otherwise.
        execution_surface: "you, by hand",
        outcome_preview:
          "Nothing is charged or cancelled by Samaritan. Approving hands you the steps.",
      },
      custom: {
        vendor: sub.vendor,
        amount: money(sub.amount, sub.currency),
        renews_on: renewsOn,
        renews_in: humanDays(until),
        last_used: unusedDays === undefined ? "unknown" : `${unusedDays} days ago`,
        recommendation,
        worth_keeping: worthKeeping,
      },
      dedupe_key: `subscription-watch:${sub.vendor}:${renewsOn}`,
    });
  }

  return { action_items, status: "ok", logs };
}
