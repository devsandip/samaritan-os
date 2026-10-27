/**
 * TickTick adapter (TECH-SPEC §12 step 8, PROPOSAL Phase 1).
 *
 * Supports both `automated` (TickTick Open API v1 when enabled and a token is
 * present in Keychain under `ticktick:<account>`) and `guided` (copy-ready
 * fallback when unconfigured or when routing selects guided).
 *
 * Enforces two universal invariants:
 * 1. Global TickTick tag rule: `#word` in a title or content string turns into
 *    an unwanted tag in TickTick (e.g. `#73` becomes tag `73`). `sanitizeTickTickText`
 *    strips `#` before numbers/words on every path.
 * 2. Provider receipt verification: an automated call only reports `succeeded`
 *    when the TickTick API returns a non-empty task `id` receipt.
 */
import { loadConfig } from "../../config/index.js";
import { getSecret } from "../../secrets.js";
import type { Db } from "../../store/db.js";
import {
  nowIso,
  type ExecutionAdapter,
  type ExecutionRequest,
  type ExecutionResult,
} from "../../types/index.js";
import { renderPayload } from "./guided.js";

const TICKTICK_API = "https://api.ticktick.com/open/v1";

/**
 * Strips `#` prefixes from words/numbers so TickTick never turns `#73` or
 * `#urgent` in task text into a tag (Global AGENTS.md rule).
 */
export function sanitizeTickTickText(input: string): string {
  return input.replace(/#([A-Za-z0-9_-]+)/g, "$1");
}

export interface TickTickAdapterOptions {
  db?: Db;
  token?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export function createTickTickAdapter(options: TickTickAdapterOptions = {}): ExecutionAdapter {
  const resolveToken =
    options.token ??
    (() => {
      const cfg = loadConfig();
      if (!cfg.ticktick?.enabled) return undefined;
      return getSecret(`ticktick:${cfg.ticktick.account}`);
    });
  const fetchFn = options.fetchImpl ?? fetch;

  return {
    id: "ticktick.task.create",
    provider: "ticktick",
    description: "Creates a TickTick task via Open API v1, falling back to guided staging when unconfigured",
    modes: ["automated", "guided"],

    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      const { title, content, due, list, projectId, tags } = request.payload as {
        title?: string;
        content?: string;
        due?: string;
        list?: string;
        projectId?: string;
        tags?: string[];
      };
      if (!title || typeof title !== "string" || !title.trim()) {
        return { status: "failed", error: 'payload requires a "title"' };
      }

      const cleanTitle = sanitizeTickTickText(title.trim());
      const cleanContent = typeof content === "string" ? sanitizeTickTickText(content) : undefined;
      const auth = resolveToken();

      if (request.mode === "guided" || !auth) {
        return {
          status: "staged",
          guided_instructions: renderPayload({
            task: cleanTitle,
            ...(cleanContent ? { content: cleanContent } : {}),
            ...(due ? { due } : {}),
            ...(list ? { list } : {}),
          }),
          guided_link: "ticktick://",
          result: { staged_task: cleanTitle },
        };
      }

      try {
        const body: Record<string, unknown> = {
          title: cleanTitle,
          ...(cleanContent ? { content: cleanContent } : {}),
          ...(due ? { dueDate: due } : {}),
          ...(projectId ? { projectId } : {}),
          ...(Array.isArray(tags) ? { tags } : {}),
        };

        const response = await fetchFn(`${TICKTICK_API}/task`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          return {
            status: "failed",
            error: `ticktick ${response.status}: ${String(data["errorMessage"] ?? data["message"] ?? response.statusText)}`,
          };
        }

        const receiptId = typeof data["id"] === "string" && data["id"].trim() ? data["id"].trim() : "";
        if (!receiptId) {
          return {
            status: "failed",
            error: "ticktick API returned 200 without a task id receipt",
          };
        }

        if (options.db) {
          options.db
            .prepare(
              `INSERT INTO ticktick_tasks (id, title, list, due, status, last_synced_at)
               VALUES (?, ?, ?, ?, 'open', ?)
               ON CONFLICT(id) DO UPDATE SET
                 title = excluded.title,
                 list = excluded.list,
                 due = excluded.due,
                 status = excluded.status,
                 last_synced_at = excluded.last_synced_at`,
            )
            .run(receiptId, cleanTitle, list ?? projectId ?? null, due ?? null, nowIso());
        }

        return {
          status: "succeeded",
          result: {
            ticktick_task_id: receiptId,
            title: cleanTitle,
            ...(list ? { list } : {}),
          },
        };
      } catch (err) {
        return {
          status: "failed",
          error: (err as Error).message,
        };
      }
    },

    async verify() {
      const auth = resolveToken();
      if (!auth) return "not_configured";
      try {
        const res = await fetchFn(`${TICKTICK_API}/project`, {
          method: "GET",
          headers: { Authorization: `Bearer ${auth}` },
        });
        return res.ok ? "connected" : "error";
      } catch {
        return "error";
      }
    },
  };
}

export const tickTickTaskCreate: ExecutionAdapter = createTickTickAdapter();
