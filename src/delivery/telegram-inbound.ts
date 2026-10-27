/**
 * Telegram inbound: buttons, capture, tasks and answers (PROPOSAL D5 Phase 2).
 *
 * The daemon long-polls `getUpdates`, so nothing on this Mac is exposed to the
 * internet for Telegram's sake. Every update must come from Sandip: the
 * configured chat *and* the configured sender. A group member pressing a button
 * in a shared chat is refused.
 *
 * Buttons carry a random token (`cb:<token>`). Its `telegram_callbacks`
 * row says which item, response, revision and payload hash it was minted for,
 * and a press is refused if the item has changed since, or if the token was
 * already used. So a stale message on the phone can never approve new content.
 *
 * Text:
 * - `/task <goal>`  delegates a task (idempotent on the update id)
 * - `/note <text>`  appends to today's daily note
 * - `/meeting <topic> | <notes>` files meeting notes and extracts items
 * - `/answer <task-id> <text>`, or a reply to a worker's question message
 * - `/mute <capability>` silences that source's notifications
 * Anything else gets the list above, rather than being guessed into a task.
 */
import type { ActionCenter } from "../action-center/index.js";
import { ActionCenterError } from "../action-center/index.js";
import { loadConfig } from "../config/index.js";
import type { EventBus } from "../events/index.js";
import { dailyNotePath, obsidianNoteAppend } from "../execution/adapters/obsidian.js";
import { log } from "../logger.js";
import { getActionItem, transition } from "../store/action-items.js";
import type { Db } from "../store/db.js";
import { StoreCheckpoint } from "../store/poll-state.js";
import { upsertSourceRule } from "../store/source-rules.js";
import { nowIso } from "../types/index.js";
import type { WorkerService } from "../worker/index.js";
import { botApi, type TelegramApi, type TelegramPhotoSize, type TelegramUpdate } from "./telegram-api.js";

export type { TelegramPhotoSize, TelegramUpdate } from "./telegram-api.js";

const logger = log("telegram-inbound");

export interface TelegramInboundResult {
  accepted: boolean;
  action?: string;
  detail?: string;
  reason?: string;
  /** What the bot says back. */
  reply?: string;
}

export interface TelegramInboundDeps {
  db: Db;
  actionCenter: ActionCenter;
  worker: WorkerService;
  eventBus?: EventBus;
  onMeetingNotes?: (input: { topic: string; notes: string }) => Promise<void>;
  allowedChatId?: string;
  allowedUserId?: string;
}

const HELP =
  "Commands: /task <what to do>, /note <text>, /meeting <topic> | <notes>, /answer <task-id> <text>, /mute <source>. " +
  "To answer a worker's question, reply to its message.";

interface CallbackRow {
  token: string;
  action: string;
  action_item_id: string | null;
  response_id: string | null;
  revision: number | null;
  payload_hash: string | null;
  source_id: string | null;
  used_at: string | null;
}

function refuse(reason: string, reply?: string): TelegramInboundResult {
  return { accepted: false, reason, ...(reply ? { reply } : {}) };
}

async function handleCallback(
  deps: TelegramInboundDeps,
  data: string,
): Promise<TelegramInboundResult> {
  if (data.startsWith("mute:")) {
    const sourceId = data.slice(5).trim();
    if (!sourceId) return refuse("missing_source_id");
    upsertSourceRule(deps.db, sourceId, { muted: true });
    return { accepted: true, action: "muted_source", detail: sourceId, reply: `Muted ${sourceId}.` };
  }

  if (data.startsWith("edit:")) {
    const parts = data.split(":");
    const itemId = parts[1] ?? "";
    const field = parts[2] ?? "";
    const value = parts.slice(3).join(":");
    if (!itemId || !field) return refuse("invalid_edit_callback");
    const item = getActionItem(deps.db, itemId);
    if (!item) return refuse("item_not_found");
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
      reply: `Edited ${field}.`,
    };
  }

  if (data.startsWith("approve:") || data.startsWith("defer:") || data.startsWith("discard:")) {
    const [actionVerb, itemId, revPart] = data.split(":");
    if (!itemId) return refuse("missing_item_id");
    const expectedRevision = revPart?.startsWith("r") ? Number(revPart.slice(1)) : undefined;
    try {
      const updated = await deps.actionCenter.respond(itemId, {
        response_id: actionVerb!,
        actor: "sandip",
        ...(expectedRevision !== undefined && Number.isFinite(expectedRevision)
          ? { expected_revision: expectedRevision }
          : {}),
      });
      return {
        accepted: true,
        action: "responded",
        detail: `${updated.id}:${updated.status}`,
        reply: `Done: ${updated.status.replace(/_/g, " ")}.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return refuse("respond_failed", message.slice(0, 180));
    }
  }

  if (!data.startsWith("cb:")) return refuse("unknown_callback", "That button is not one of mine.");
  const row = deps.db
    .prepare<CallbackRow>("SELECT * FROM telegram_callbacks WHERE token = ?")
    .get(data.slice(3));
  if (!row) return refuse("unknown_token", "That button has expired.");
  if (row.used_at) return refuse("token_used", "Already done.");

  const markUsed = () =>
    deps.db.prepare("UPDATE telegram_callbacks SET used_at = ? WHERE token = ?").run(nowIso(), row.token);

  if (row.action === "mute" && row.source_id) {
    upsertSourceRule(deps.db, row.source_id, { muted: true });
    markUsed();
    return { accepted: true, action: "muted_source", detail: row.source_id, reply: `Muted ${row.source_id}.` };
  }

  if (row.action !== "respond" || !row.action_item_id || !row.response_id) {
    return refuse("malformed_token", "That button has expired.");
  }
  const item = getActionItem(deps.db, row.action_item_id);
  if (!item) return refuse("item_not_found", "That item is gone.");
  if (item.revision !== row.revision || item.payload_hash !== row.payload_hash) {
    return refuse("stale_button", "This item changed after the message was sent. Open it in Samaritan.");
  }
  try {
    const updated = await deps.actionCenter.respond(item.id, {
      response_id: row.response_id,
      actor: "sandip",
      expected_revision: row.revision,
      ...(row.payload_hash ? { expected_payload_hash: row.payload_hash } : {}),
      require_binding: true,
    });
    markUsed();
    return {
      accepted: true,
      action: "responded",
      detail: `${updated.id}:${updated.status}`,
      reply: `Done: ${updated.status.replace(/_/g, " ")}.`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return refuse("respond_failed", message.slice(0, 180));
  }
}

/** The worker question whose Telegram message this text replies to, if any. */
function questionRepliedTo(db: Db, messageId: number | undefined): string | undefined {
  if (!messageId) return undefined;
  const row = db
    .prepare<{ action_item_id: string }>(
      "SELECT action_item_id FROM delivery_queue WHERE telegram_message_id = ? ORDER BY queued_at DESC LIMIT 1",
    )
    .get(messageId);
  if (!row) return undefined;
  const item = getActionItem(db, row.action_item_id);
  return item?.type === "task-question" ? item.id : undefined;
}

async function answer(
  deps: TelegramInboundDeps,
  taskOrQuestionId: string,
  text: string,
): Promise<TelegramInboundResult> {
  try {
    const task = await deps.worker.answer(taskOrQuestionId, text, { actor: "sandip" });
    return {
      accepted: true,
      action: "question_answered",
      detail: `${task.id}:r${task.revision}`,
      reply: "Thanks, the task is resuming.",
    };
  } catch (err) {
    if (err instanceof ActionCenterError) return refuse(err.code, err.message);
    throw err;
  }
}

export async function handleTelegramUpdate(
  deps: TelegramInboundDeps,
  update: TelegramUpdate,
): Promise<TelegramInboundResult> {
  const config = loadConfig().delivery.telegram;
  const chatId = deps.allowedChatId ?? config.chat_id ?? "";
  const userId = deps.allowedUserId ?? config.user_id ?? chatId;
  const message = update.callback_query?.message ?? update.message;
  const from = update.callback_query?.from ?? update.message?.from;

  if (!chatId || String(message?.chat.id ?? "") !== String(chatId)) {
    return refuse("unauthorized_chat_id");
  }
  if (from && String(from.id) !== String(userId)) {
    return refuse("unauthorized_sender");
  }

  if (update.callback_query) return handleCallback(deps, update.callback_query.data?.trim() ?? "");

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
      reply: "Screenshot received.",
    };
  }

  const text = update.message?.text?.trim() ?? "";
  if (!text) return refuse("empty_message");

  const repliedQuestion = questionRepliedTo(deps.db, update.message?.reply_to_message?.message_id);
  if (repliedQuestion && !text.startsWith("/")) return answer(deps, repliedQuestion, text);

  const [command, ...rest] = text.split(/\s+/);
  const argument = text.slice(command!.length).trim();
  switch (command) {
    case "/task": {
      if (!argument) return refuse("empty_task_goal", "Say what to do: /task <goal>");
      const { task, created } = deps.worker.submit({
        goal: argument,
        origin: "telegram",
        ...(update.update_id !== undefined ? { request_key: `telegram:${update.update_id}` } : {}),
      });
      return {
        accepted: true,
        action: "task_submitted",
        detail: task.id,
        reply: created ? `Queued task ${task.id}. I'll message you if it needs you.` : "Already queued.",
      };
    }
    case "/note": {
      if (!argument) return refuse("empty_note", "Nothing to note: /note <text>");
      const path = dailyNotePath();
      const result = await obsidianNoteAppend.execute({
        action_item_id: `telegram-note-${update.update_id ?? Date.now()}`,
        capability: "obsidian.note.append",
        mode: "automated",
        idempotency_key: `telegram-note:${update.update_id ?? Date.now()}`,
        payload: { path, content: `- ${argument}` },
      });
      return result.status === "succeeded"
        ? { accepted: true, action: "note_appended", detail: path, reply: "Noted." }
        : refuse("note_failed", result.error ?? "Could not write the note.");
    }
    case "/meeting": {
      if (!argument) return refuse("empty_meeting_notes", "Use /meeting <topic> | <notes>");
      const pipeIdx = argument.indexOf("|");
      const topic =
        pipeIdx !== -1
          ? argument.slice(0, pipeIdx).trim() || "Telegram Meeting Notes"
          : "Telegram Meeting Notes";
      const notes = pipeIdx !== -1 ? argument.slice(pipeIdx + 1).trim() : argument;
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
        reply: `Ingested meeting notes for ${topic}.`,
      };
    }
    case "/answer": {
      const [taskId] = rest;
      const answerText = argument.slice((taskId ?? "").length).trim();
      if (!taskId || !answerText) return refuse("missing_answer_text", "Use /answer <task-id> <text>");
      return answer(deps, taskId, answerText);
    }
    case "/mute": {
      if (!argument) return refuse("missing_source_id", "Use /mute <source>");
      upsertSourceRule(deps.db, argument, { muted: true });
      return { accepted: true, action: "muted_source", detail: argument, reply: `Muted ${argument}.` };
    }
    default:
      return refuse("no_command", HELP);
  }
}

/**
 * Long-polls the Bot API and hands each update to the handler, one at a time.
 * The offset is saved after each update, and every handler is idempotent on the
 * update id, so a crash between the two costs at most a repeat that does nothing.
 */
export class TelegramPoller {
  readonly #deps: TelegramInboundDeps;
  readonly #api: TelegramApi;
  readonly #checkpoint: StoreCheckpoint;
  #abort: AbortController | undefined;
  #running = false;

  constructor(deps: TelegramInboundDeps & { api?: TelegramApi }) {
    this.#deps = deps;
    this.#api = deps.api ?? botApi;
    this.#checkpoint = new StoreCheckpoint(deps.db, "telegram");
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    void this.#loop();
  }

  stop(): void {
    this.#running = false;
    this.#abort?.abort();
  }

  /** One getUpdates round. Exposed for tests; the loop calls it forever. */
  async pollOnce(timeoutSec = 30): Promise<number> {
    this.#abort = new AbortController();
    const updates = await this.#api.getUpdates(
      this.#checkpoint.load(),
      timeoutSec,
      AbortSignal.any([this.#abort.signal, AbortSignal.timeout((timeoutSec + 10) * 1000)]),
    );
    for (const update of updates) {
      let result: TelegramInboundResult;
      try {
        result = await handleTelegramUpdate(this.#deps, update);
      } catch (err) {
        logger.error({ update: update.update_id, err: String(err) }, "telegram update failed");
        result = refuse("error", "Something went wrong; check Samaritan.");
      }
      if (update.update_id !== undefined) {
        this.#checkpoint.save(update.update_id + 1);
      }
      await this.#reply(update, result);
    }
    return updates.length;
  }

  async #reply(update: TelegramUpdate, result: TelegramInboundResult): Promise<void> {
    if (result.reason === "unauthorized_chat_id" || result.reason === "unauthorized_sender") {
      logger.warn({ update: update.update_id, reason: result.reason }, "ignored telegram update");
      return; // say nothing to strangers
    }
    try {
      const query = update.callback_query;
      if (query) {
        await this.#api.answerCallbackQuery(query.id, result.reply ?? (result.accepted ? "Done." : "Not done."));
        if (result.accepted && query.message && query.message.message_id !== undefined) {
          await this.#api.clearButtons(String(query.message.chat.id), query.message.message_id);
        }
      } else if (result.reply && update.message) {
        await this.#api.sendMessage(String(update.message.chat.id), result.reply);
      }
    } catch (err) {
      logger.warn({ update: update.update_id, err: String(err) }, "telegram reply failed");
    }
  }

  async #loop(): Promise<void> {
    let backoffMs = 1_000;
    while (this.#running) {
      try {
        await this.pollOnce();
        backoffMs = 1_000;
      } catch (err) {
        if (!this.#running) return;
        logger.warn({ err: String(err), retry_ms: backoffMs }, "telegram poll failed");
        await new Promise((r) => setTimeout(r, backoffMs).unref());
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  }
}
