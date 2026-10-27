import { readRecentImessages } from "../../src/events/listeners/imessage-reader.js";
import type { RunContext, RunResult } from "../../src/run-layer/context.js";
import type { DraftActionItem } from "../../src/types/index.js";

export interface ImessageThreadInput {
  id?: string;
  sender: string;
  last_message: string;
  suggested_reply?: string;
}

export function isHighSignalImessage(sender: string, text: string): boolean {
  const cleanSender = sender.trim();
  const cleanText = text.trim();
  if (!cleanText) return false;
  // Filter 5-6 digit shortcodes or carrier/bank sender headers (e.g. "58291", "AX-HDFCBK")
  if (/^\d{4,6}$/.test(cleanSender) || /^[A-Z]{2}-[A-Z0-9]{4,8}$/i.test(cleanSender)) {
    return false;
  }
  // Filter OTPs, verification codes, and automated unsubscribe blasts
  if (
    /\b(otp|verification code|security code|one-time password|do not share this code|reply stop to unsubscribe)\b/i.test(
      cleanText,
    )
  ) {
    return false;
  }
  return true;
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const rawThreads: ImessageThreadInput[] = Array.isArray(ctx.inputs.threads)
    ? (ctx.inputs.threads as ImessageThreadInput[])
    : ctx.inputs.use_live_chat_db === true
      ? readRecentImessages({ limit: 15 }).messages.map((m) => ({
          id: String(m.rowid),
          sender: m.sender,
          last_message: m.text,
        }))
      : [];

  const logs: string[] = [];
  const threads = rawThreads.filter((t) => {
    const keep = isHighSignalImessage(t.sender, t.last_message);
    if (!keep) logs.push(`filtered low-signal message from ${t.sender}`);
    return keep;
  });

  const items: DraftActionItem[] = threads.map((t) => {
    const suggested =
      t.suggested_reply ?? `Hey! Saw your message ("${t.last_message.slice(0, 60)}"), following up now.`;
    const handle = t.sender.split("(")[0]?.trim() || t.sender;
    const deepLink = `imessage://${encodeURIComponent(handle)}`;
    return {
      capability_id: "imessage-digest",
      type: "imessage-reply-nudge",
      scope: "personal",
      context: {
        what_happened: `Unanswered iMessage from ${t.sender}: "${t.last_message}"`,
        source: { kind: "imessage", id: t.id ?? `imessage:${t.sender}`, url: deepLink },
        provenance: ["imessage.chat_db"],
        why_flagged: "personal messages are guided-only; Samaritan never auto-replies on iMessage",
        trigger_reason: "policy",
        confidence: 0.88,
        decision_needed: `Stage reply to ${t.sender} in Messages?`,
        decision_surface: "inbox",
        execution_surface: "imessage",
        outcome_preview: `Copies suggested reply to ${t.sender} and opens Messages.app (${deepLink})`,
      },
      custom: {
        sender: t.sender,
        last_message: t.last_message,
        suggested_reply: suggested,
      },
      dedupe_key: `imessage-digest:${t.id ?? t.sender.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    };
  });

  return { action_items: items, status: "ok", logs };
}
