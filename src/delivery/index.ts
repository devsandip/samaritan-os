/**
 * Delivery service (TECH-SPEC §2.2, §12 step 12).
 *
 * The only component allowed to push to Telegram. Formats an escalated item for
 * a phone-sized surface, respects quiet hours by queueing, and stays a thin
 * outbound layer: no lifecycle logic lives here, and a delivery failure never
 * affects an item that is already durably in the Inbox.
 */
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/index.js";
import { log } from "../logger.js";
import { getSecret } from "../secrets.js";
import type { Db } from "../store/db.js";
import { nowIso, type ActionItem } from "../types/index.js";
import { isWithinQuietHours, parseQuietHours, quietHoursEnd } from "./quiet-hours.js";

export { isWithinQuietHours, parseQuietHours, quietHoursEnd } from "./quiet-hours.js";

const logger = log("delivery");

export interface Delivery {
  notify(item: ActionItem): Promise<void>;
}

/** Used when Telegram is disabled. Keeps the Action Center free of null checks. */
export const noopDelivery: Delivery = {
  async notify() {
    // Nothing to do. The item is in the Inbox either way.
  },
};

export function inboxUrl(itemId: string): string {
  const { host, port } = loadConfig().server;
  return `http://${host}:${port}/actions/${itemId}`;
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

interface TelegramOptions {
  db: Db;
  /** Overridable for tests. Defaults to Telegram's Bot API. */
  send?: (chatId: string, text: string) => Promise<void>;
  now?: () => Date;
}

async function sendViaBotApi(chatId: string, text: string): Promise<void> {
  const token = getSecret("telegram:bot");
  if (!token) throw new Error("no telegram bot token (keychain: samaritan / telegram:bot)");

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { description?: string };
    throw new Error(`telegram ${response.status}: ${body.description ?? response.statusText}`);
  }
}

export class TelegramDelivery implements Delivery {
  readonly #db: Db;
  readonly #send: (chatId: string, text: string) => Promise<void>;
  readonly #now: () => Date;

  constructor(options: TelegramOptions) {
    this.#db = options.db;
    this.#send = options.send ?? sendViaBotApi;
    this.#now = options.now ?? (() => new Date());
  }

  async notify(item: ActionItem): Promise<void> {
    const config = loadConfig();
    const chatId = config.delivery.telegram.chat_id;
    if (!chatId) {
      logger.warn({ id: item.id }, "telegram enabled but no chat_id configured; not delivering");
      return;
    }

    const body = formatItem(item);
    const now = this.#now();
    const window = parseQuietHours(config.delivery.quiet_hours);

    if (isWithinQuietHours(now, window)) {
      const deliverAfter = quietHoursEnd(now, window);
      this.#enqueue(item.id, body, deliverAfter.toISOString());
      logger.info(
        { id: item.id, deliver_after: deliverAfter.toISOString() },
        "queued for after quiet hours",
      );
      return;
    }

    try {
      await this.#send(chatId, body);
      this.#enqueue(item.id, body, null, this.#now().toISOString());
    } catch (err) {
      // Queue it rather than lose it. The next flush retries.
      const message = err instanceof Error ? err.message : String(err);
      this.#enqueue(item.id, body, null, null, message);
      logger.warn({ id: item.id, err: message }, "telegram send failed; queued for retry");
    }
  }

  #enqueue(
    actionItemId: string,
    body: string,
    deliverAfter: string | null,
    deliveredAt: string | null = null,
    error: string | null = null,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO delivery_queue
           (id, action_item_id, channel, body, queued_at, deliver_after, delivered_at,
            last_error, attempts)
         VALUES (?, ?, 'telegram', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        actionItemId,
        body,
        nowIso(),
        deliverAfter,
        deliveredAt,
        error,
        deliveredAt ? 1 : error ? 1 : 0,
      );
  }

  /**
   * Sends everything whose quiet window has passed. Called on boot and, once the
   * daemon exists (v1), on a timer. Returns how many were delivered.
   */
  async flush(): Promise<number> {
    const config = loadConfig();
    const chatId = config.delivery.telegram.chat_id;
    if (!chatId) return 0;

    const now = this.#now();
    const due = this.#db
      .prepare<{ id: string; body: string }>(
        `SELECT id, body FROM delivery_queue
          WHERE delivered_at IS NULL
            AND (deliver_after IS NULL OR deliver_after <= ?)
          ORDER BY queued_at ASC`,
      )
      .all(now.toISOString());

    let delivered = 0;
    for (const row of due) {
      try {
        await this.#send(chatId, row.body);
        this.#db
          .prepare(
            "UPDATE delivery_queue SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?",
          )
          .run(nowIso(), row.id);
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

export function createDelivery(db: Db): Delivery {
  return loadConfig().delivery.telegram.enabled ? new TelegramDelivery({ db }) : noopDelivery;
}
