/**
 * The handful of Telegram Bot API calls Samaritan makes (TECH-SPEC §2.2, PROPOSAL D5).
 *
 * One interface so the outbound sender, the inbound long-poll and the tests all
 * share a single seam. The bot token comes from the Keychain
 * (`samaritan` / `telegram:bot`) on every call, so adding it after boot works.
 */
import { getSecret } from "../secrets.js";

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface ReplyMarkup {
  inline_keyboard: InlineButton[][];
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
}

export interface TelegramPhotoSize {
  file_id: string;
  width?: number;
  height?: number;
}

export interface TelegramMessage {
  message_id?: number;
  chat: { id: number | string; type?: string };
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  reply_to_message?: { message_id: number };
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from?: TelegramUser;
    message?: TelegramMessage;
    data?: string;
  };
}

export interface TelegramApi {
  sendMessage(chatId: string, text: string, markup?: ReplyMarkup): Promise<{ message_id: number }>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  answerCallbackQuery(id: string, text: string): Promise<void>;
  clearButtons(chatId: string, messageId: number): Promise<void>;
}

async function call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const token = getSecret("telegram:bot");
  if (!token) throw new Error("no telegram bot token (keychain: samaritan / telegram:bot)");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const json = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
  };
  if (!response.ok || !json.ok) {
    throw new Error(`telegram ${method} ${response.status}: ${json.description ?? response.statusText}`);
  }
  return json.result as T;
}

export const botApi: TelegramApi = {
  sendMessage: (chatId, text, markup) =>
    call<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(markup ? { reply_markup: markup } : {}),
    }),
  getUpdates: (offset, timeoutSec, signal) =>
    call<TelegramUpdate[]>(
      "getUpdates",
      { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] },
      signal ?? AbortSignal.timeout((timeoutSec + 10) * 1000),
    ),
  answerCallbackQuery: async (id, text) => {
    await call("answerCallbackQuery", { callback_query_id: id, text });
  },
  clearButtons: async (chatId, messageId) => {
    await call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  },
};
