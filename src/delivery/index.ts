/**
 * Delivery service (TECH-SPEC §2.2, §12 step 12).
 *
 * The only component allowed to push to Telegram. Formats an escalated item for
 * a phone-sized surface, respects quiet hours by queueing, and stays a thin
 * outbound layer: no lifecycle logic lives here, and a delivery failure never
 * affects an item that is already durably in the Inbox.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { loadConfig } from "../config/index.js";
import { log } from "../logger.js";
import type { Db } from "../store/db.js";
import { isSourceDeliverySilenced } from "../store/source-rules.js";
import { nowIso, type ActionItem } from "../types/index.js";
import { isWithinQuietHours, parseQuietHours, quietHoursEnd } from "./quiet-hours.js";
import { botApi, type InlineButton, type ReplyMarkup, type TelegramApi } from "./telegram-api.js";

export { isWithinQuietHours, parseQuietHours, quietHoursEnd } from "./quiet-hours.js";

const logger = log("delivery");

/** A message Telegram refused this many times is given up on; the item is still in the Inbox. */
const MAX_ATTEMPTS = 10;

export interface Delivery {
  notify(item: ActionItem): Promise<void>;
  flush(): Promise<number>;
}

/** Used when Telegram is disabled. Keeps the Action Center free of null checks. */
export const noopDelivery: Delivery = {
  async notify() {
    // Nothing to do. The item is in the Inbox either way.
  },
  async flush() {
    return 0;
  },
};

export function inboxUrl(itemId: string): string {
  const { host, port, public_url } = loadConfig().server;
  const base = public_url ? public_url.replace(/\/+$/, "") : `http://${host}:${port}`;
  return `${base}/actions/${itemId}`;
}

/**
 * A phone-sized summary. Leads with what will happen if approved, because that
 * is what Sandip is actually deciding on, and keeps the body short enough to
 * read in a notification without opening anything.
 */
export function formatItem(item: ActionItem): string {
  const c = item.context;
  const confidence = `${Math.round(c.confidence * 100)}%`;
  const title =
    typeof item.custom["title"] === "string" && item.custom["title"]
      ? (item.custom["title"] as string)
      : c.decision_needed;

  return [
    `${item.capability_id}: ${title}`,
    "",
    c.outcome_preview,
    "",
    `Why you: ${c.why_flagged}`,
    `Confidence: ${confidence}  Priority: ${item.priority}`,
    "",
    inboxUrl(item.id),
  ].join("\n");
}

/** The responses a notification can offer as buttons, resolved from the item's manifest. */
export interface ButtonResponses {
  approve?: { id: string; label: string };
  snooze?: { id: string; label: string };
}

interface TelegramOptions {
  db: Db;
  /** Overridable for tests. Defaults to Telegram's Bot API. */
  api?: TelegramApi;
  /** Older test seam: plain text sends, no buttons, no message id. */
  send?: (chatId: string, text: string) => Promise<void>;
  /** Which of the item's responses are its Approve and Snooze. */
  describe?: (item: ActionItem) => ButtonResponses;
  now?: () => Date;
}

interface QueuedRow {
  id: string;
  body: string;
  reply_markup_json: string | null;
}

export class TelegramDelivery implements Delivery {
  readonly #db: Db;
  readonly #api: TelegramApi;
  readonly #describe: ((item: ActionItem) => ButtonResponses) | undefined;
  readonly #now: () => Date;
  #flushing = false;

  constructor(options: TelegramOptions) {
    this.#db = options.db;
    const send = options.send;
    this.#api = options.api ??
      (send
        ? {
            ...botApi,
            sendMessage: async (chatId, text) => {
              await send(chatId, text);
              return { message_id: 0 };
            },
          }
        : botApi);
    this.#describe = options.describe;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Buttons for this exact revision of the item. Each one is a random token
   * whose row records the revision and payload hash it was minted for; the
   * inbound handler refuses it once either has moved on (D9).
   */
  #buttonsFor(item: ActionItem): ReplyMarkup | undefined {
    const responses = this.#describe?.(item) ?? {};
    const mint = (row: {
      action: "respond" | "mute";
      response_id?: string;
      source_id?: string;
    }): string => {
      const token = randomBytes(12).toString("hex");
      this.#db
        .prepare(
          `INSERT INTO telegram_callbacks
             (token, action, action_item_id, response_id, revision, payload_hash, source_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          token,
          row.action,
          item.id,
          row.response_id ?? null,
          item.revision,
          item.payload_hash,
          row.source_id ?? null,
          nowIso(),
        );
      return `cb:${token}`;
    };

    const first: InlineButton[] = [];
    if (responses.approve) {
      first.push({
        text: responses.approve.label,
        callback_data: mint({ action: "respond", response_id: responses.approve.id }),
      });
    }
    if (responses.snooze) {
      first.push({
        text: responses.snooze.label,
        callback_data: mint({ action: "respond", response_id: responses.snooze.id }),
      });
    }
    const second: InlineButton[] = [];
    // Edit happens in the full UI, which only makes sense once the phone can reach it.
    if (loadConfig().server.public_url) second.push({ text: "Edit", url: inboxUrl(item.id) });
    second.push({
      text: `Mute ${item.capability_id}`,
      callback_data: mint({ action: "mute", source_id: item.capability_id }),
    });
    return { inline_keyboard: [first, second].filter((row) => row.length > 0) };
  }

  async notify(item: ActionItem): Promise<void> {
    const config = loadConfig();
    const chatId = config.delivery.telegram.chat_id;
    if (!chatId) {
      logger.warn({ id: item.id }, "telegram enabled but no chat_id configured; not delivering");
      return;
    }

    const now = this.#now();
    if (isSourceDeliverySilenced(this.#db, item.capability_id, now)) {
      logger.info(
        { id: item.id, capability: item.capability_id },
        "delivery silenced by source_rules (muted or snoozed)",
      );
      return;
    }

    const dedupeKey = `${item.id}:r${item.revision ?? 1}`;
    const already = this.#db
      .prepare<{ id: string }>("SELECT id FROM delivery_queue WHERE dedupe_key = ?")
      .get(dedupeKey);
    if (already) {
      logger.info({ id: item.id, dedupeKey }, "notification already queued or delivered");
      return;
    }

    const body = formatItem(item);
    const markup = this.#buttonsFor(item);
    const window = parseQuietHours(config.delivery.quiet_hours);
    const rowId = randomUUID();

    if (isWithinQuietHours(now, window)) {
      const deliverAfter = quietHoursEnd(now, window);
      this.#enqueue(rowId, item.id, body, markup, deliverAfter.toISOString(), null, null, dedupeKey);
      logger.info(
        { id: item.id, deliver_after: deliverAfter.toISOString() },
        "queued for after quiet hours",
      );
      return;
    }

    try {
      const sent = await this.#api.sendMessage(chatId, body, markup);
      this.#enqueue(rowId, item.id, body, markup, null, this.#now().toISOString(), null, dedupeKey);
      this.#recordMessageId(rowId, sent.message_id);
    } catch (err) {
      // Queue it rather than lose it. The next flush retries.
      const message = err instanceof Error ? err.message : String(err);
      this.#enqueue(rowId, item.id, body, markup, null, null, message, dedupeKey);
      logger.warn({ id: item.id, err: message }, "telegram send failed; queued for retry");
    }
  }

  #recordMessageId(rowId: string, messageId: number): void {
    if (!messageId) return;
    this.#db
      .prepare("UPDATE delivery_queue SET telegram_message_id = ? WHERE id = ?")
      .run(messageId, rowId);
  }

  #enqueue(
    rowId: string,
    actionItemId: string,
    body: string,
    markup: ReplyMarkup | undefined,
    deliverAfter: string | null,
    deliveredAt: string | null = null,
    error: string | null = null,
    dedupeKey: string | null = null,
  ): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO delivery_queue
           (id, action_item_id, channel, body, queued_at, deliver_after, delivered_at,
            last_error, attempts, dedupe_key, reply_markup_json)
         VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rowId,
        actionItemId,
        body,
        nowIso(),
        deliverAfter,
        deliveredAt,
        error,
        deliveredAt ? 1 : error ? 1 : 0,
        dedupeKey,
        markup ? JSON.stringify(markup) : null,
      );
  }

  /**
   * Sends everything whose quiet window has passed. The daemon's sweep calls
   * this every minute (G2). Returns how many were delivered.
   */
  async flush(): Promise<number> {
    const config = loadConfig();
    const chatId = config.delivery.telegram.chat_id;
    // One flush at a time: a slow Telegram must not let the next sweep resend
    // the same rows. Retries wait out quiet hours like first sends do.
    if (!chatId || this.#flushing) return 0;
    const now = this.#now();
    if (isWithinQuietHours(now, parseQuietHours(config.delivery.quiet_hours))) return 0;
    this.#flushing = true;
    try {
      return await this.#flushDue(chatId, now);
    } finally {
      this.#flushing = false;
    }
  }

  async #flushDue(chatId: string, now: Date): Promise<number> {
    const due = this.#db
      .prepare<QueuedRow>(
        `SELECT id, body, reply_markup_json FROM delivery_queue
          WHERE delivered_at IS NULL
            AND attempts < ?
            AND (deliver_after IS NULL OR deliver_after <= ?)
          ORDER BY queued_at ASC`,
      )
      .all(MAX_ATTEMPTS, now.toISOString());

    let delivered = 0;
    for (const row of due) {
      try {
        const markup = row.reply_markup_json
          ? (JSON.parse(row.reply_markup_json) as ReplyMarkup)
          : undefined;
        const sent = await this.#api.sendMessage(chatId, row.body, markup);
        this.#db
          .prepare(
            "UPDATE delivery_queue SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?",
          )
          .run(nowIso(), row.id);
        this.#recordMessageId(row.id, sent.message_id);
        delivered++;
      } catch (err) {
        this.#db
          .prepare("UPDATE delivery_queue SET attempts = attempts + 1, last_error = ? WHERE id = ?")
          .run(err instanceof Error ? err.message : String(err), row.id);
      }
    }

    if (delivered > 0) logger.info({ delivered }, "flushed queued notifications");
    return delivered;
  }
}

export function createDelivery(
  db: Db,
  describe?: (item: ActionItem) => ButtonResponses,
): Delivery {
  return loadConfig().delivery.telegram.enabled
    ? new TelegramDelivery({ db, ...(describe ? { describe } : {}) })
    : noopDelivery;
}
