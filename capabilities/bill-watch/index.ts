import type { RunContext, RunResult } from "../../src/run-layer/context.js";
import type { DraftActionItem } from "../../src/types/index.js";

export interface BillStatement {
  id?: string;
  biller: string;
  amount_usd: number;
  amount_display?: string;
  due_date: string;
  due_date_certainty?: "exact" | "inferred";
  account_mask?: string;
  payment_url?: string;
  summary?: string;
}

export interface RawBillEmail {
  id?: string;
  from?: string;
  subject: string;
  body: string;
  received_at?: string;
}

const INR_TO_USD = 84;

export function parseBillEmail(email: RawBillEmail): BillStatement | null {
  const combined = `${email.subject}\n${email.body}`;
  if (!/\b(statement|bill|invoice|payment due|amount due|total due|minimum due)\b/i.test(combined)) {
    return null;
  }

  // Extract amount in USD ($) or INR (₹ / Rs / INR)
  let amountDisplay: string | undefined;
  let amountUsd = 0;

  const inrMatch = /(?:₹|INR\s*|Rs\.?\s*)([0-9][0-9,]*(?:\.\d{1,2})?)/i.exec(combined);
  const usdMatch = /(?:\$|USD\s*)([0-9][0-9,]*(?:\.\d{1,2})?)/i.exec(combined);

  if (inrMatch) {
    const rawNum = Number.parseFloat(inrMatch[1]!.replace(/,/g, ""));
    if (!Number.isFinite(rawNum) || rawNum <= 0) return null;
    amountDisplay = `₹${rawNum.toLocaleString("en-IN", { minimumFractionDigits: rawNum % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
    amountUsd = Math.round((rawNum / INR_TO_USD) * 100) / 100;
  } else if (usdMatch) {
    const rawNum = Number.parseFloat(usdMatch[1]!.replace(/,/g, ""));
    if (!Number.isFinite(rawNum) || rawNum <= 0) return null;
    amountDisplay = `$${rawNum.toFixed(2)}`;
    amountUsd = rawNum;
  } else {
    return null;
  }

  // Extract biller
  let biller = "Statement Biller";
  if (email.from) {
    const namePart = email.from.split("<")[0]?.replace(/["']/g, "").trim();
    if (namePart) biller = namePart;
  } else {
    const subjPrefix = /^([A-Za-z0-9 &.'-]+?)(?:\s+(?:statement|bill|invoice|credit card))/i.exec(
      email.subject.trim(),
    );
    if (subjPrefix?.[1]) biller = subjPrefix[1].trim();
  }

  // Extract due date (YYYY-MM-DD or Month DD, YYYY)
  let dueDate = "";
  let certainty: "exact" | "inferred" = "exact";
  const isoDateMatch = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(combined);
  const namedDateMatch =
    /\b(?:due(?:\s+date|\s+on|\s+by)?[:\s]+)?((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+20\d{2})/i.exec(
      combined,
    );

  if (isoDateMatch?.[1]) {
    dueDate = isoDateMatch[1];
  } else if (namedDateMatch?.[1]) {
    const parsed = Date.parse(namedDateMatch[1]);
    if (!Number.isNaN(parsed)) {
      dueDate = new Date(parsed).toISOString().slice(0, 10);
    }
  }

  if (!dueDate) {
    certainty = "inferred";
    const baseMs = email.received_at ? Date.parse(email.received_at) : Date.now();
    const safeBase = Number.isNaN(baseMs) ? Date.now() : baseMs;
    dueDate = new Date(safeBase + 14 * 86400_000).toISOString().slice(0, 10);
  }

  const maskMatch = /(?:ending in\s+|xx|\*{2,}|card\s+)(\d{4})\b/i.exec(combined);
  const accountMask = maskMatch?.[1] ? `••${maskMatch[1]}` : undefined;

  const urlMatch = /https?:\/\/[^\s)>"]+/i.exec(email.body);
  const paymentUrl = urlMatch?.[0] ?? "https://example.com/billing";

  const maskNote = accountMask ? ` (${accountMask})` : "";
  const certaintyNote = certainty === "inferred" ? " [due date inferred +14d]" : "";

  return {
    ...(email.id ? { id: email.id } : {}),
    biller,
    amount_usd: amountUsd,
    amount_display: amountDisplay,
    due_date: dueDate,
    due_date_certainty: certainty,
    ...(accountMask ? { account_mask: accountMask } : {}),
    payment_url: paymentUrl,
    summary: `${biller}${maskNote} statement for ${amountDisplay} due on ${dueDate}${certaintyNote}.`,
  };
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const payload = (ctx.trigger.payload ?? {}) as Record<string, unknown>;
  const rawEmails: RawBillEmail[] = Array.isArray(ctx.inputs.emails)
    ? (ctx.inputs.emails as RawBillEmail[])
    : typeof payload.subject === "string" && typeof payload.body === "string"
      ? [payload as unknown as RawBillEmail]
      : [];

  const parsedFromEmails = rawEmails
    .map((e) => parseBillEmail(e))
    .filter((b): b is BillStatement => b !== null);

  const bills: BillStatement[] = Array.isArray(ctx.inputs.bills)
    ? [...(ctx.inputs.bills as BillStatement[]), ...parsedFromEmails]
    : typeof payload.biller === "string"
      ? [payload as unknown as BillStatement, ...parsedFromEmails]
      : parsedFromEmails;

  const items: DraftActionItem[] = bills.map((bill) => {
    const amountDisplay = bill.amount_display ?? `$${bill.amount_usd.toFixed(2)}`;
    const summary =
      bill.summary ?? `${bill.biller} statement for ${amountDisplay} due on ${bill.due_date}.`;
    const url = bill.payment_url ?? "https://example.com/billing";
    const confidence = bill.due_date_certainty === "inferred" ? 0.78 : 0.96;

    return {
      capability_id: "bill-watch",
      type: "bill-payment-guided",
      scope: "personal",
      context: {
        what_happened: `Statement received from ${bill.biller} for ${amountDisplay} (due ${bill.due_date})`,
        source: { kind: "bill-watch", id: bill.id ?? `${bill.biller}:${bill.due_date}`, url },
        provenance: ["gmail.statements"],
        why_flagged: "payment.make is locked to guided mode; money never moves automatically",
        trigger_reason: "policy",
        confidence,
        stakes: bill.amount_usd,
        reversible: false,
        decision_needed: `Stage guided payment of ${amountDisplay} to ${bill.biller} (due ${bill.due_date})?`,
        decision_surface: "inbox",
        execution_surface: "manual-payment",
        outcome_preview: `Stages payment instructions and opens ${bill.biller} portal (never auto-pays)`,
      },
      custom: {
        biller: bill.biller,
        amount_display: amountDisplay,
        due_date: bill.due_date,
        summary,
        payment_url: url,
      },
      dedupe_key: `bill-watch:${bill.biller.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${bill.due_date}`,
    };
  });

  return { action_items: items, status: "ok", logs: [] };
}
