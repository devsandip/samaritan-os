/**
 * Telegram inbound handler (PROPOSAL D5).
 *
 * Processes inbound Telegram bot updates (inline button `callback_query` and
 * text commands/replies) restricted strictly to `config.delivery.telegram.chat_id`.
 *
 * Supported callback_data patterns:
 * - `approve:<itemId>` or `approve:<itemId>:r<revision>`
 * - `snooze:<itemId>`
 * - `mute:<sourceId>`
 *
 * Supported text messages:
 * - `/task <goal>` -> submits a delegated task
 * - `/note <text>` -> appends a quick note to today's Obsidian daily note
 * - `/answer <taskId> <text>` (or plain reply when a task is in `needs_input`)
 */
import type { ActionCenter } from "../action-center/index.js";
import { loadConfig } from "../config/index.js";
import type { EventBus } from "../events/index.js";
import { dailyNotePath, obsidianNoteAppend } from "../execution/adapters/obsidian.js";
import { getActionItem, transition } from "../store/action-items.js";
import type { Db } from "../store/db.js";
import { upsertSourceRule } from "../store/source-rules.js";
import { listTasks } from "../store/tasks.js";
import type { WorkerService } from "../worker/index.js";

export interface TelegramPhotoSize {
  file_id: string;
  width?: number;
  height?: number;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id?: number;
    chat: { id: number | string };
    text?: string;
    caption?: string;
    photo?: TelegramPhotoSize[];
  };
  callback_query?: {
    id: string;
    message?: { chat: { id: number | string } };
    data?: string;
  };
}

export interface TelegramInboundResult {
  accepted: boolean;
  action?: string;
  detail?: string;
  reason?: string;
}

export interface TelegramInboundDeps {
  db: Db;
  actionCenter: ActionCenter;
  worker: WorkerService;
  eventBus?: EventBus;
  onMeetingNotes?: (input: { topic: string; notes: string }) => Promise<void>;
  allowedChatId?: string;
}

export async function handleTelegramUpdate(
  deps: TelegramInboundDeps,
  update: TelegramUpdate,
): Promise<TelegramInboundResult> {
  const configuredChatId =
    deps.allowedChatId ?? loadConfig().delivery.telegram.chat_id ?? "";
  const incomingChatId = String(
    update.callback_query?.message?.chat.id ?? update.message?.chat.id ?? "",
  );

  if (!configuredChatId || incomingChatId !== String(configuredChatId)) {
    return {
      accepted: false,
      reason: "unauthorized_chat_id",
    };
  }

  if (update.callback_query?.data) {
    const data = update.callback_query.data.trim();

    if (data.startsWith("approve:")) {
      const parts = data.split(":");
      const itemId = parts[1] ?? "";
      const revPart = parts[2];
      const expectedRevision =
        revPart && revPart.startsWith("r") ? Number(revPart.slice(1)) : undefined;

      const item = getActionItem(deps.db, itemId);
      if (!item) {
        return { accepted: false, reason: "item_not_found" };
      }

      const approveResponse =
        item.responses.find((r) => r === "approve" || r.startsWith("send") || r.startsWith("save")) ??
        item.responses[0];
      if (!approveResponse) {
        return { accepted: false, reason: "no_approve_response" };
      }

      const updated = await deps.actionCenter.respond(itemId, {
        response_id: approveResponse,
        actor: "sandip",
        ...(expectedRevision !== undefined && !Number.isNaN(expectedRevision)
          ? { expected_revision: expectedRevision }
          : {}),
      });
      return {
        accepted: true,
        action: "approved",
        detail: `${updated.id}:${updated.status}`,
      };
    }

    if (data.startsWith("snooze:")) {
      const itemId = data.slice("snooze:".length).trim();
      const item = getActionItem(deps.db, itemId);
      if (!item) return { accepted: false, reason: "item_not_found" };

      const deferResponse =
        item.responses.find((r) => r === "defer" || r.includes("snooze")) ?? "defer";
      const updated = await deps.actionCenter.respond(itemId, {
        response_id: deferResponse,
        actor: "sandip",
      });
      return {
        accepted: true,
        action: "snoozed",
        detail: `${updated.id}:${updated.status}`,
      };
    }

    if (data.startsWith("mute:")) {
      const sourceId = data.slice("mute:".length).trim();
      if (!sourceId) return { accepted: false, reason: "missing_source_id" };
      upsertSourceRule(deps.db, sourceId, { muted: true });
      return {
        accepted: true,
        action: "muted_source",
        detail: sourceId,
      };
    }

    if (data.startsWith("edit:")) {
      const parts = data.split(":");
      const itemId = parts[1] ?? "";
      const field = parts[2] ?? "";
      const value = parts.slice(3).join(":");
      if (!itemId || !field) return { accepted: false, reason: "invalid_edit_callback" };
      const item = getActionItem(deps.db, itemId);
      if (!item) return { accepted: false, reason: "item_not_found" };
      const updated = transition(deps.db, {
        id: item.id,
        to: "in_review",
        actor: "sandip",
        reason: `telegram inline edit: ${field}`,
        patch: {
          custom: { ...item.custom, [field]: value },
        },
      });
      return {
        accepted: true,
        action: "edited",
        detail: `${updated.id}:r${updated.revision}`,
      };
    }

    return { accepted: false, reason: "unknown_callback_action" };
  }

  if (update.message?.photo && update.message.photo.length > 0) {
    const largest = update.message.photo[update.message.photo.length - 1]!;
    const caption = update.message.caption?.trim() ?? "";
    if (deps.eventBus) {
      await deps.eventBus.publish({
        id: `tg-photo:${largest.file_id}:${Date.now()}`,
        type: "screenshot.received",
        source: "telegram.photo",
        occurred_at: new Date().toISOString(),
        payload: {
          file_id: largest.file_id,
          caption,
          text: caption,
        },
      });
    }
    return {
      accepted: true,
      action: "screenshot_received",
      detail: largest.file_id,
    };
  }

  const text = update.message?.text?.trim() ?? "";
  if (!text) {
    return { accepted: false, reason: "empty_message" };
  }

  if (text.startsWith("/task ")) {
    const goal = text.slice("/task ".length).trim();
    if (!goal) return { accepted: false, reason: "empty_task_goal" };
    const { task } = await deps.worker.submit({ goal });
    return {
      accepted: true,
      action: "task_submitted",
      detail: task.id,
    };
  }

  if (text.startsWith("/note ")) {
    const noteBody = text.slice("/note ".length).trim();
    if (!noteBody) return { accepted: false, reason: "empty_note" };
    const path = dailyNotePath();
    await obsidianNoteAppend.execute({
      action_item_id: `tg-note-${Date.now()}`,
      capability: "obsidian.note.append",
      mode: "automated",
      idempotency_key: `tg-note:${Date.now()}`,
      payload: { path, content: `- ${noteBody}` },
    });
    return {
      accepted: true,
      action: "note_appended",
      detail: path,
    };
  }

  if (text.startsWith("/meeting ")) {
    const raw = text.slice("/meeting ".length).trim();
    if (!raw) return { accepted: false, reason: "empty_meeting_notes" };
    const pipeIdx = raw.indexOf("|");
    const topic =
      pipeIdx !== -1 ? raw.slice(0, pipeIdx).trim() || "Telegram Meeting Notes" : "Telegram Meeting Notes";
    const notes = pipeIdx !== -1 ? raw.slice(pipeIdx + 1).trim() : raw;
    if (deps.onMeetingNotes) {
      await deps.onMeetingNotes({ topic, notes });
    } else if (deps.eventBus) {
      await deps.eventBus.publish({
        id: `tg-meeting:${Date.now()}`,
        type: "meeting.transcribed",
        source: "telegram",
        occurred_at: new Date().toISOString(),
        payload: {
          meeting_topic: topic,
          notes,
        },
      });
    }
    return {
      accepted: true,
      action: "meeting_notes_ingested",
      detail: topic,
    };
  }

  if (text.startsWith("/answer ")) {
    const rest = text.slice("/answer ".length).trim();
    const spaceIdx = rest.indexOf(" ");
    if (spaceIdx === -1) return { accepted: false, reason: "missing_answer_text" };
    const taskId = rest.slice(0, spaceIdx).trim();
    const answerText = rest.slice(spaceIdx + 1).trim();
    const updated = await deps.worker.answer(taskId, answerText);
    return {
      accepted: true,
      action: "question_answered",
      detail: `${updated.id}:r${updated.revision}`,
    };
  }

  // Plain text reply: if a task is currently waiting in `needs_input`, route the
  // reply to that task's open question; otherwise submit it as a delegated task.
  const waitingTask = listTasks(deps.db, { status: "needs_input", limit: 1 })[0];
  if (waitingTask) {
    const updated = await deps.worker.answer(waitingTask.id, text);
    return {
      accepted: true,
      action: "question_answered",
      detail: `${updated.id}:r${updated.revision}`,
    };
  }

  const { task } = await deps.worker.submit({ goal: text });
  return {
    accepted: true,
    action: "task_submitted",
    detail: task.id,
  };
}
