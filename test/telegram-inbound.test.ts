/**
 * Telegram inbound (PROPOSAL D5, D9): only Sandip's own updates count, buttons
 * are bound to the exact revision they were sent for, a press works once, and
 * a reply to a worker's question answers that question.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { loadConfig, repoRoot } from "../src/config/index.js";
import { TelegramDelivery } from "../src/delivery/index.js";
import type { ReplyMarkup, TelegramApi, TelegramUpdate } from "../src/delivery/telegram-api.js";
import { handleTelegramUpdate, TelegramPoller } from "../src/delivery/telegram-inbound.js";
import { getActionItem, listActionItems, transition } from "../src/store/action-items.js";
import { getSourceRule } from "../src/store/source-rules.js";
import { getTask, listTasks } from "../src/store/tasks.js";
import { wrapItem } from "./helpers.js";

const CHAT = "4242";
let app: App;
let tmpDir: string;
let sent: { chatId: string; text: string; markup?: ReplyMarkup; message_id: number }[];
let api: TelegramApi & { answered: string[]; cleared: number[] };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "samaritan-tg-"));
  loadConfig().delivery.telegram.chat_id = CHAT;
  sent = [];
  let nextId = 100;
  api = {
    answered: [],
    cleared: [],
    sendMessage: async (chatId, text, markup) => {
      const message_id = nextId++;
      sent.push({ chatId, text, ...(markup ? { markup } : {}), message_id });
      return { message_id };
    },
    getUpdates: async () => [],
    answerCallbackQuery: async (_id, text) => void api.answered.push(text),
    clearButtons: async (_chat, messageId) => void api.cleared.push(messageId),
  };
  app = createApp({
    dbPath: ":memory:",
    capabilitiesDir: join(repoRoot(), "capabilities"),
    artifactsRoot: join(tmpDir, "artifacts"),
    workerExecutor: async (tools, context) => {
      if (context.answers.length === 0) await tools.askQuestion("Which quarter?");
      return { status: "succeeded", summary: "ok" };
    },
  });
});

afterEach(async () => {
  await app.worker.whenIdle();
  app.close();
  delete loadConfig().delivery.telegram.chat_id;
  rmSync(tmpDir, { recursive: true, force: true });
});

const deps = () => ({ db: app.db, actionCenter: app.actionCenter, worker: app.worker });
const fromSandip = { id: Number(CHAT) };
let updateId = 1;
const text = (t: string, extra: Partial<NonNullable<TelegramUpdate["message"]>> = {}): TelegramUpdate => ({
  update_id: updateId++,
  message: { message_id: updateId, chat: { id: CHAT }, from: fromSandip, text: t, ...extra },
});
const press = (data: string, messageId = 100): TelegramUpdate => ({
  update_id: updateId++,
  callback_query: { id: `q${updateId}`, from: fromSandip, data, message: { message_id: messageId, chat: { id: CHAT } } },
});

async function notifiedWrapItem() {
  const res = await app.actionCenter.ingest("wrap", [wrapItem({ dedupe_key: `wrap:tg:${updateId}` })]);
  const item = getActionItem(app.db, res.accepted[0]!.id)!;
  const delivery = new TelegramDelivery({
    db: app.db,
    api,
    now: () => new Date(2026, 6, 19, 14),
    describe: () => ({ approve: { id: "approve", label: "Approve" }, snooze: { id: "defer", label: "Snooze" } }),
  });
  await delivery.notify(item);
  const buttons = sent.at(-1)!.markup!.inline_keyboard.flat();
  return { item, buttons };
}

describe("who may talk to the bot", () => {
  it("ignores another chat, and another sender in the right chat", async () => {
    expect((await handleTelegramUpdate(deps(), { ...text("/task x"), message: { message_id: 1, chat: { id: 1 }, from: fromSandip, text: "/task x" } })).reason).toBe("unauthorized_chat_id");
    const stranger = await handleTelegramUpdate(deps(), {
      update_id: 99,
      message: { message_id: 1, chat: { id: CHAT }, from: { id: 7 }, text: "/task x" },
    });
    expect(stranger.reason).toBe("unauthorized_sender");
    expect(listTasks(app.db)).toHaveLength(0);
  });

  it("answers unknown text with help instead of guessing a task", async () => {
    const result = await handleTelegramUpdate(deps(), text("what's up"));
    expect(result.reply).toMatch(/\/task/);
    expect(listTasks(app.db)).toHaveLength(0);
  });
});

describe("buttons", () => {
  it("approve works once, bound to the revision it was sent for", async () => {
    const { item, buttons } = await notifiedWrapItem();
    const approve = buttons.find((b) => b.text === "Approve")!;

    const first = await handleTelegramUpdate(deps(), press(approve.callback_data!));
    expect(first.accepted).toBe(true);
    expect(getActionItem(app.db, item.id)?.status).not.toBe("pending");
    expect((await handleTelegramUpdate(deps(), press(approve.callback_data!))).reason).toBe("token_used");
  });

  it("refuses a button whose item changed after the message went out", async () => {
    const { item, buttons } = await notifiedWrapItem();
    transition(app.db, {
      id: item.id,
      to: "pending",
      actor: "capability",
      reason: "superseded_by_reingest",
      patch: { custom: { ...item.custom, title: "Something else entirely" } },
    });
    const approve = buttons.find((b) => b.text === "Approve")!;
    const result = await handleTelegramUpdate(deps(), press(approve.callback_data!));
    expect(result.reason).toBe("stale_button");
    expect(getActionItem(app.db, item.id)?.status).toBe("pending");
  });

  it("mutes the item's source from its Mute button", async () => {
    const { buttons } = await notifiedWrapItem();
    const mute = buttons.find((b) => b.text.startsWith("Mute"))!;
    await handleTelegramUpdate(deps(), press(mute.callback_data!));
    expect(getSourceRule(app.db, "wrap").muted).toBe(true);
  });
});

describe("text", () => {
  it("/task queues once per update, even if Telegram redelivers it", async () => {
    app.worker.stop();
    const update = text("/task Draft the WBR");
    const first = await handleTelegramUpdate(deps(), update);
    const again = await handleTelegramUpdate(deps(), update);
    expect(first.action).toBe("task_submitted");
    expect(again.detail).toBe(first.detail);
    expect(listTasks(app.db)).toHaveLength(1);
    expect(getTask(app.db, first.detail!)?.origin).toBe("telegram");
  });

  it("a reply to the question's message answers that question", async () => {
    const { task } = app.worker.submit({ goal: "Quarterly review" });
    await app.worker.whenIdle();
    const [question] = listActionItems(app.db, { task_id: task.id, type: "task-question" });
    app.db
      .prepare(
        `INSERT INTO delivery_queue (id, action_item_id, channel, body, queued_at, delivered_at, telegram_message_id)
         VALUES ('q1', ?, 'telegram', 'Which quarter?', ?, ?, 555)`,
      )
      .run(question!.id, new Date().toISOString(), new Date().toISOString());

    const result = await handleTelegramUpdate(deps(), text("Q3", { reply_to_message: { message_id: 555 } }));
    expect(result.action).toBe("question_answered");
    await app.worker.whenIdle();
    expect(getTask(app.db, task.id)?.status).toBe("succeeded");
  });
});

describe("TelegramPoller", () => {
  it("saves the offset, answers the press and clears its buttons", async () => {
    const { buttons } = await notifiedWrapItem();
    const update = press(buttons.find((b) => b.text === "Approve")!.callback_data!, 100);
    const offsets: number[] = [];
    api.getUpdates = async (offset) => {
      offsets.push(offset);
      return offsets.length === 1 ? [update] : [];
    };
    const poller = new TelegramPoller({ ...deps(), api });
    await poller.pollOnce(0);
    await poller.pollOnce(0);
    expect(offsets).toEqual([0, update.update_id + 1]);
    expect(api.answered[0]).toMatch(/^Done/);
    expect(api.cleared).toEqual([100]);
  });
});
