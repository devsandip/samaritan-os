/**
 * Inbound Recall mirror-table synchronization (Phase 5, P5-2).
 *
 * Backfills and refreshes the local SQLite mirror tables (`notion_decisions`,
 * `notion_insights`, `ticktick_tasks`) from the live Notion PM-OS databases and
 * TickTick Open API v1 so hybrid Recall (`structuredRetrieve` + semantic RRF)
 * queries existing workspace knowledge rather than only rows created through
 * Samaritan's outbound adapters.
 */
import { loadConfig, type Config } from "../config/index.js";
import { log } from "../logger.js";
import { getSecret } from "../secrets.js";
import type { Db } from "../store/db.js";

const logger = log("mirror-sync");

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const TICKTICK_API = "https://api.ticktick.com/open/v1";

export interface MirrorSyncResult {
  notion_decisions: number;
  notion_insights: number;
  ticktick_tasks: number;
  errors: Record<string, string>;
}

export interface MirrorSyncOptions {
  config?: Config;
  notionToken?: string;
  ticktickToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => string;
}

interface NotionRichTextItem {
  plain_text?: string;
  text?: { content?: string };
}

interface NotionPage {
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, Record<string, unknown>>;
}

function readPlainText(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return (items as NotionRichTextItem[])
    .map((item) => item.plain_text ?? item.text?.content ?? "")
    .join("")
    .trim();
}

function extractTitle(props: Record<string, Record<string, unknown>> | undefined, key: string): string {
  if (!props) return "";
  const preferred = props[key];
  if (preferred && Array.isArray(preferred["title"])) {
    const val = readPlainText(preferred["title"]);
    if (val) return val;
  }
  for (const prop of Object.values(props)) {
    if (prop && prop["type"] === "title" && Array.isArray(prop["title"])) {
      const val = readPlainText(prop["title"]);
      if (val) return val;
    }
  }
  return "";
}

function extractRichText(props: Record<string, Record<string, unknown>> | undefined, key: string): string {
  if (!props || !props[key]) return "";
  return readPlainText(props[key]["rich_text"]);
}

function extractSelect(props: Record<string, Record<string, unknown>> | undefined, key: string): string | null {
  if (!props || !props[key]) return null;
  const sel = props[key]["select"] as { name?: string } | null | undefined;
  return typeof sel?.name === "string" && sel.name ? sel.name : null;
}

function extractMultiSelect(props: Record<string, Record<string, unknown>> | undefined, key: string): string {
  if (!props || !props[key]) return "";
  const list = props[key]["multi_select"];
  if (!Array.isArray(list)) return "";
  return list
    .map((item) => (typeof (item as { name?: unknown })?.name === "string" ? (item as { name: string }).name : ""))
    .filter(Boolean)
    .join(",");
}

function extractRelationIds(props: Record<string, Record<string, unknown>> | undefined, key: string): string[] {
  if (!props || !props[key]) return [];
  const rel = props[key]["relation"];
  if (!Array.isArray(rel)) return [];
  return rel
    .map((r) => (typeof (r as { id?: unknown })?.id === "string" ? (r as { id: string }).id : ""))
    .filter(Boolean);
}

function recordCursorSuccess(db: Db, source: string, cursor: string | null, nowIso: string): void {
  db.prepare(
    `INSERT INTO sync_cursors (source, cursor, last_success_at, last_error)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(source) DO UPDATE SET
       cursor = excluded.cursor,
       last_success_at = excluded.last_success_at,
       last_error = NULL`,
  ).run(source, cursor, nowIso);
}

function recordCursorError(db: Db, source: string, error: string): void {
  db.prepare(
    `INSERT INTO sync_cursors (source, cursor, last_success_at, last_error)
     VALUES (?, NULL, NULL, ?)
     ON CONFLICT(source) DO UPDATE SET
       last_error = excluded.last_error`,
  ).run(source, error);
}

async function queryAllNotionPages(
  databaseId: string,
  token: string,
  fetchFn: typeof fetch,
): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let startCursor: string | undefined;

  for (let pageNum = 0; pageNum < 10; pageNum++) {
    const response = await fetchFn(`${NOTION_API}/databases/${databaseId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_size: 100,
        ...(startCursor ? { start_cursor: startCursor } : {}),
      }),
    });

    const body = (await response.json().catch(() => ({}))) as {
      results?: NotionPage[];
      has_more?: boolean;
      next_cursor?: string | null;
      message?: string;
    };

    if (!response.ok) {
      throw new Error(`notion ${response.status}: ${body.message ?? response.statusText}`);
    }

    if (Array.isArray(body.results)) {
      pages.push(...body.results);
    }

    if (!body.has_more || !body.next_cursor) break;
    startCursor = body.next_cursor;
  }

  return pages;
}

export async function syncRecallMirrors(
  db: Db,
  opts: MirrorSyncOptions = {},
): Promise<MirrorSyncResult> {
  const cfg = opts.config ?? loadConfig();
  const fetchFn = opts.fetchImpl ?? fetch;
  const nowFn = opts.now ?? (() => new Date().toISOString());

  const result: MirrorSyncResult = {
    notion_decisions: 0,
    notion_insights: 0,
    ticktick_tasks: 0,
    errors: {},
  };

  // 1. Notion Decisions & Insights
  const notionToken = opts.notionToken ?? getSecret(`notion:${cfg.notion.account}`);
  if (notionToken) {
    const projectMap = new Map<string, string>();
    if (cfg.notion.databases.projects) {
      try {
        const projectPages = await queryAllNotionPages(
          cfg.notion.databases.projects,
          notionToken,
          fetchFn,
        );
        for (const p of projectPages) {
          const name = extractTitle(p.properties, "Name");
          if (p.id && name) projectMap.set(p.id, name);
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "failed to load Notion projects map");
      }
    }

    if (cfg.notion.databases.decisions) {
      try {
        const pages = await queryAllNotionPages(
          cfg.notion.databases.decisions,
          notionToken,
          fetchFn,
        );
        const upsertDecision = db.prepare(
          `INSERT INTO notion_decisions
             (id, title, rationale, project, reversibility, notion_url, last_edited_time)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             rationale = excluded.rationale,
             project = excluded.project,
             reversibility = excluded.reversibility,
             notion_url = excluded.notion_url,
             last_edited_time = excluded.last_edited_time`,
        );

        const nowIso = nowFn();
        for (const page of pages) {
          const title = extractTitle(page.properties, "Decision");
          if (!title) continue;
          const rationale = extractRichText(page.properties, "Rationale") || null;
          const reversibility = extractSelect(page.properties, "Reversibility");
          const relIds = extractRelationIds(page.properties, "Project");
          const projectNames = relIds.map((id) => projectMap.get(id) ?? id).filter(Boolean);
          const project = projectNames.length > 0 ? projectNames.join(", ") : null;

          upsertDecision.run(
            page.id,
            title,
            rationale,
            project,
            reversibility,
            page.url ?? null,
            page.last_edited_time ?? nowIso,
          );
          result.notion_decisions += 1;
        }
        recordCursorSuccess(db, "notion.decisions", `rows:${result.notion_decisions}`, nowIso);
      } catch (err) {
        const message = (err as Error).message;
        result.errors["notion.decisions"] = message;
        recordCursorError(db, "notion.decisions", message);
      }
    }

    if (cfg.notion.databases.insights) {
      try {
        const pages = await queryAllNotionPages(
          cfg.notion.databases.insights,
          notionToken,
          fetchFn,
        );
        const upsertInsight = db.prepare(
          `INSERT INTO notion_insights
             (id, title, body, tags, notion_url, last_edited_time)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             body = excluded.body,
             tags = excluded.tags,
             notion_url = excluded.notion_url,
             last_edited_time = excluded.last_edited_time`,
        );

        const nowIso = nowFn();
        for (const page of pages) {
          const title = extractTitle(page.properties, "Insight");
          if (!title) continue;
          const body = extractRichText(page.properties, "Detail") || null;
          const tags = extractMultiSelect(page.properties, "Tags") || null;

          upsertInsight.run(
            page.id,
            title,
            body,
            tags,
            page.url ?? null,
            page.last_edited_time ?? nowIso,
          );
          result.notion_insights += 1;
        }
        recordCursorSuccess(db, "notion.insights", `rows:${result.notion_insights}`, nowIso);
      } catch (err) {
        const message = (err as Error).message;
        result.errors["notion.insights"] = message;
        recordCursorError(db, "notion.insights", message);
      }
    }
  }

  // 2. TickTick Open API v1 Tasks
  const ticktickToken =
    opts.ticktickToken ??
    (cfg.ticktick.enabled ? getSecret(`ticktick:${cfg.ticktick.account}`) : undefined);
  if (ticktickToken) {
    try {
      const projRes = await fetchFn(`${TICKTICK_API}/project`, {
        method: "GET",
        headers: { Authorization: `Bearer ${ticktickToken}` },
      });
      if (!projRes.ok) {
        throw new Error(`ticktick projects ${projRes.status}: ${projRes.statusText}`);
      }
      const projects = (await projRes.json().catch(() => [])) as Array<{
        id?: string;
        name?: string;
      }>;

      const upsertTask = db.prepare(
        `INSERT INTO ticktick_tasks
           (id, title, list, due, status, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           list = excluded.list,
           due = excluded.due,
           status = excluded.status,
           last_synced_at = excluded.last_synced_at`,
      );

      const nowIso = nowFn();
      for (const proj of projects) {
        if (!proj.id) continue;
        const dataRes = await fetchFn(
          `${TICKTICK_API}/project/${encodeURIComponent(proj.id)}/data`,
          {
            method: "GET",
            headers: { Authorization: `Bearer ${ticktickToken}` },
          },
        );
        if (!dataRes.ok) continue;
        const data = (await dataRes.json().catch(() => ({}))) as {
          tasks?: Array<{
            id?: string;
            title?: string;
            dueDate?: string;
            status?: number;
          }>;
        };
        for (const task of data.tasks ?? []) {
          if (!task.id || !task.title) continue;
          const statusStr = task.status === 2 ? "completed" : "open";
          upsertTask.run(
            task.id,
            task.title,
            proj.name ?? proj.id,
            task.dueDate ?? null,
            statusStr,
            nowIso,
          );
          result.ticktick_tasks += 1;
        }
      }
      recordCursorSuccess(db, "ticktick", `rows:${result.ticktick_tasks}`, nowIso);
    } catch (err) {
      const message = (err as Error).message;
      result.errors["ticktick"] = message;
      recordCursorError(db, "ticktick", message);
    }
  }

  return result;
}
