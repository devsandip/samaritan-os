/**
 * Notion adapters (TECH-SPEC §12 step 8).
 *
 * Talks to Notion's REST API directly rather than through an MCP tool: MCP tools
 * only exist inside a Claude session, and these have to work from a daemon with
 * no session attached (§6).
 *
 * On success each adapter also write-throughs the row into the matching
 * `notion_*` mirror table, which §7 makes the primary sync path for Recall so a
 * decision is queryable the moment it is filed rather than up to 15 minutes
 * later.
 */
import { loadConfig } from "../../config/index.js";
import { log } from "../../logger.js";
import { getSecret } from "../../secrets.js";
import type { Db } from "../../store/db.js";
import type { ExecutionAdapter, ExecutionRequest, ExecutionResult } from "../../types/index.js";

const logger = log("notion");

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

function token(): string | undefined {
  return getSecret(`notion:${loadConfig().notion.account}`);
}

function title(text: string) {
  return { title: [{ text: { content: text.slice(0, 2000) } }] };
}

function richText(text: string) {
  return { rich_text: [{ text: { content: text.slice(0, 2000) } }] };
}

async function notionFetch(path: string, init: RequestInit): Promise<unknown> {
  const auth = token();
  if (!auth) throw new Error("notion is not connected");

  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${auth}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `notion ${response.status}: ${String(body["message"] ?? response.statusText)}`,
    );
  }
  return body;
}

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value ? value : undefined;
}

interface CreatePageResult {
  id: string;
  url: string;
  last_edited_time: string;
}

async function createPage(
  databaseId: string,
  properties: Record<string, unknown>,
): Promise<CreatePageResult> {
  const page = (await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
  })) as CreatePageResult;
  return page;
}

/**
 * Builds the two Notion adapters. They take the store so a successful write can
 * populate the Recall mirror in the same call.
 */
export function notionAdapters(db: Db): ExecutionAdapter[] {
  const verify = async () => {
    if (!token()) return "not_configured" as const;
    try {
      await notionFetch("/users/me", { method: "GET" });
      return "connected" as const;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "notion verify failed");
      return "error" as const;
    }
  };

  const decisionCreate: ExecutionAdapter = {
    id: "notion.decision.create",
    provider: "notion",
    description: "Creates a row in the Notion Decisions database",
    modes: ["automated", "guided"],
    scopes_required: ["insert_content"],

    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      const { databases } = loadConfig().notion;
      const p = request.payload;
      const heading = str(p, "title");
      if (!heading) return { status: "failed", error: 'payload requires a "title"' };

      const properties: Record<string, unknown> = { Name: title(heading) };
      const rationale = str(p, "rationale");
      const evidence = str(p, "evidence");
      const reversibility = str(p, "reversibility");
      const project = str(p, "project");
      if (rationale) properties["Rationale"] = richText(rationale);
      if (evidence) properties["Evidence"] = richText(evidence);
      if (reversibility) properties["Reversibility"] = { select: { name: reversibility } };
      if (project) properties["Project (text)"] = richText(project);
      properties["Status"] = { select: { name: rationale ? "decided" : "pending" } };

      try {
        const page = await createPage(databases.decisions, properties);
        db.prepare(
          `INSERT INTO notion_decisions
             (id, title, rationale, project, reversibility, notion_url, last_edited_time)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, rationale = excluded.rationale,
             project = excluded.project, reversibility = excluded.reversibility,
             notion_url = excluded.notion_url, last_edited_time = excluded.last_edited_time`,
        ).run(
          page.id,
          heading,
          rationale ?? null,
          project ?? null,
          reversibility ?? null,
          page.url,
          page.last_edited_time,
        );
        return { status: "succeeded", result: { notion_row_id: page.id, notion_url: page.url } };
      } catch (err) {
        return { status: "failed", error: (err as Error).message };
      }
    },

    verify,
  };

  const insightCreate: ExecutionAdapter = {
    id: "notion.insight.create",
    provider: "notion",
    description: "Creates a row in the Notion Insights database",
    modes: ["automated", "guided"],
    scopes_required: ["insert_content"],

    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      const { databases } = loadConfig().notion;
      const p = request.payload;
      const heading = str(p, "title");
      if (!heading) return { status: "failed", error: 'payload requires a "title"' };

      const body = str(p, "body") ?? str(p, "detail");
      const tags = Array.isArray(p["tags"]) ? (p["tags"] as string[]) : [];
      const project = str(p, "project");

      const properties: Record<string, unknown> = { Name: title(heading) };
      if (body) properties["Detail"] = richText(body);
      if (tags.length) properties["Tags"] = { multi_select: tags.map((name) => ({ name })) };
      if (project) properties["Project (text)"] = richText(project);

      try {
        const page = await createPage(databases.insights, properties);
        db.prepare(
          `INSERT INTO notion_insights (id, title, body, tags, notion_url, last_edited_time)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title, body = excluded.body, tags = excluded.tags,
             notion_url = excluded.notion_url, last_edited_time = excluded.last_edited_time`,
        ).run(
          page.id,
          heading,
          body ?? null,
          tags.join(","),
          page.url,
          page.last_edited_time,
        );
        return { status: "succeeded", result: { notion_row_id: page.id, notion_url: page.url } };
      } catch (err) {
        return { status: "failed", error: (err as Error).message };
      }
    },

    verify,
  };

  return [decisionCreate, insightCreate];
}
