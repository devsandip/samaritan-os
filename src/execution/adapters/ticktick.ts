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
 * 3. Check-or-create (PROPOSAL Phase 1: "restart after approval creates no
 *    duplicate task"). TickTick takes no idempotency key, so the adapter writes
 *    a `provider_intents` row before the POST and puts a short reference in the
 *    task's content. If the next attempt finds that row still pending (the
 *    daemon died mid-call, or the call timed out), it looks for the reference in
 *    TickTick first and only posts if it is not there. If it cannot look, it
 *    fails rather than risk a second task.
 */
import { createHash } from "node:crypto";
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
  // Every "#" that touches a character goes, including "##73" and "#été";
  // a lone "#" followed by a space cannot become a tag and is kept.
  return input.replace(/#+(?=\S)/g, "");
}

/** `2026-11-02` becomes TickTick's `2026-11-02T00:00:00+0000`; full timestamps pass through. */
function tickTickDue(due: string): { dueDate: string; isAllDay?: boolean } {
  return /^\d{4}-\d{2}-\d{2}$/.test(due)
    ? { dueDate: `${due}T00:00:00+0000`, isAllDay: true }
    : { dueDate: due };
}

interface IntentRow {
  marker: string;
  state: string;
  receipt: string | null;
}

export interface TickTickAdapterOptions {
  db?: Db;
  token?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

interface TickTickProject {
  id?: string;
  name?: string;
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
  let projectCache: { expiresAt: number; byName: Map<string, string> } | undefined;

  async function resolveProjectId(auth: string, listName: string | undefined): Promise<string | undefined> {
    if (!listName || !listName.trim()) return undefined;
    const key = listName.trim().toLowerCase();
    if (projectCache && projectCache.expiresAt > Date.now()) {
      return projectCache.byName.get(key);
    }
    try {
      const res = await fetchFn(`${TICKTICK_API}/project`, {
        method: "GET",
        headers: { Authorization: `Bearer ${auth}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return undefined;
      const projects = (await res.json()) as TickTickProject[];
      if (!Array.isArray(projects)) return undefined;
      const byName = new Map<string, string>();
      for (const p of projects) {
        if (typeof p.name === "string" && typeof p.id === "string" && p.name.trim() && p.id.trim()) {
          byName.set(p.name.trim().toLowerCase(), p.id.trim());
        }
      }
      projectCache = { expiresAt: Date.now() + 5 * 60_000, byName };
      return byName.get(key);
    } catch {
      return undefined;
    }
  }

  return {
    id: "ticktick.task.create",
    provider: "ticktick",
    description: "Creates a TickTick task via Open API v1, falling back to guided staging when unconfigured",
    modes: ["automated", "guided"],

    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      const { title, content, due, list, project, projectId, tags } = request.payload as {
        title?: string;
        content?: string;
        due?: string;
        list?: string;
        project?: string;
        projectId?: string;
        tags?: string[];
      };
      if (!title || typeof title !== "string" || !title.trim()) {
        return { status: "failed", error: 'payload requires a "title"' };
      }

      const cleanTitle = sanitizeTickTickText(title.trim());
      const cleanContent = typeof content === "string" ? sanitizeTickTickText(content) : undefined;
      const targetList = list ?? project;
      const auth = resolveToken();

      if (request.mode === "guided" || !auth) {
        return {
          status: "staged",
          guided_instructions: renderPayload({
            task: cleanTitle,
            ...(cleanContent ? { content: cleanContent } : {}),
            ...(due ? { due } : {}),
            ...(targetList ? { list: targetList } : {}),
          }),
          guided_link: "ticktick://",
          result: { staged_task: cleanTitle },
        };
      }

      const resolvedProjectId = projectId ?? (await resolveProjectId(auth, targetList));
      const db = options.db;
      const marker = `samaritan:${createHash("sha256").update(request.idempotency_key).digest("hex").slice(0, 12)}`;
      const headers = { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" };
      const succeeded = (receiptId: string): ExecutionResult => {
        db?.prepare(
          "UPDATE provider_intents SET state = 'committed', receipt = ?, updated_at = ? WHERE idempotency_key = ?",
        ).run(receiptId, nowIso(), request.idempotency_key);
        return {
          status: "succeeded",
          result: {
            ticktick_task_id: receiptId,
            title: cleanTitle,
            ...(targetList ? { list: targetList } : {}),
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
          },
        };
      };

      const intent = db
        ?.prepare<IntentRow>("SELECT marker, state, receipt FROM provider_intents WHERE idempotency_key = ?")
        .get(request.idempotency_key);
      if (intent?.state === "committed" && intent.receipt) return succeeded(intent.receipt);
      if (intent?.state === "pending") {
        // The last attempt's outcome is unknown. Look before writing again.
        try {
          const res = await fetchFn(`${TICKTICK_API}/project/${encodeURIComponent(resolvedProjectId ?? "inbox")}/data`, {
            headers,
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) throw new Error(`ticktick ${res.status} listing tasks`);
          const data = (await res.json()) as { tasks?: { id?: string; content?: string }[] };
          const found = (data.tasks ?? []).find((t) => t.content?.includes(intent.marker) && t.id);
          if (found?.id) return succeeded(found.id);
        } catch (err) {
          return {
            status: "failed",
            error:
              `an earlier attempt may already have created this task, and TickTick could not be checked ` +
              `(${(err as Error).message}); look for "${intent.marker}" in TickTick before retrying`,
          };
        }
      } else if (db) {
        db.prepare(
          `INSERT INTO provider_intents (idempotency_key, provider, marker, state, created_at, updated_at)
           VALUES (?, 'ticktick', ?, 'pending', ?, ?)`,
        ).run(request.idempotency_key, marker, nowIso(), nowIso());
      }

      try {
        const reference = `ref: ${intent?.marker ?? marker}`;
        const body: Record<string, unknown> = {
          title: cleanTitle,
          content: cleanContent ? `${cleanContent}\n\n${reference}` : reference,
          ...(due ? tickTickDue(due) : {}),
          ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
          ...(Array.isArray(tags) ? { tags: tags.map((t) => String(t).replace(/#/g, "")) } : {}),
        };

        const response = await fetchFn(`${TICKTICK_API}/task`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
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

        if (db) {
          db
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
            .run(receiptId, cleanTitle, targetList ?? resolvedProjectId ?? null, due ?? null, nowIso());
        }

        return succeeded(receiptId);
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
