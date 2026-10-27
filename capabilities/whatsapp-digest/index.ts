import type { RunContext, RunResult } from "../../src/run-layer/context.js";
import type { DraftActionItem } from "../../src/types/index.js";

export interface WhatsappThreadInput {
  id?: string;
  contact: string;
  chat_name?: string;
  last_message: string;
  suggested_reply?: string;
}

export function isHighSignalWhatsapp(contact: string, text: string): boolean {
  const cleanText = text.trim();
  if (!cleanText || !contact.trim()) return false;
  if (
    /\b(otp|verification code|security code|do not share this code|reply stop to opt out)\b/i.test(
      cleanText,
    )
  ) {
    return false;
  }
  return true;
}

export async function run(ctx: RunContext): Promise<RunResult> {
  const rawThreads: WhatsappThreadInput[] = Array.isArray(ctx.inputs.threads)
    ? (ctx.inputs.threads as WhatsappThreadInput[])
    : [];

  const logs: string[] = [];
  const threads = rawThreads.filter((t) => {
    const keep = isHighSignalWhatsapp(t.contact, t.last_message);
    if (!keep) logs.push(`filtered low-signal WhatsApp message from ${t.contact}`);
    return keep;
  });

  const items: DraftActionItem[] = threads.map((t) => {
    const chatName = t.chat_name ?? t.contact;
    const suggested =
      t.suggested_reply ?? `Sounds good, following up on "${t.last_message.slice(0, 50)}".`;
    const deepLink = `whatsapp://send?text=${encodeURIComponent(suggested)}`;
    return {
      capability_id: "whatsapp-digest",
      type: "whatsapp-reply-nudge",
      scope: "personal",
      context: {
        what_happened: `Unanswered WhatsApp message from ${t.contact} in "${chatName}"`,
        source: { kind: "whatsapp", id: t.id ?? `whatsapp:${t.contact}`, url: deepLink },
        provenance: ["whatsapp.local_export"],
        why_flagged: "personal WhatsApp threads are guided-only and never auto-send",
        trigger_reason: "policy",
        confidence: 0.87,
        decision_needed: `Stage WhatsApp reply to ${t.contact}?`,
        decision_surface: "inbox",
        execution_surface: "whatsapp",
        outcome_preview: `Copies suggested reply to ${t.contact} for WhatsApp (${deepLink})`,
      },
      custom: {
        contact: t.contact,
        chat_name: chatName,
        last_message: t.last_message,
        suggested_reply: suggested,
      },
      dedupe_key: `whatsapp-digest:${t.id ?? t.contact.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    };
  });

  return { action_items: items, status: "ok", logs };
}
