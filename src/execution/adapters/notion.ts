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

function date(iso = new Date().toISOString().slice(0, 10)) {
  return { date: { start: iso } };
}

interface CreatePageResult {
  id: string;
  url: string;
  last_edited_time: string;
}

async function createPage(
  databaseId: string,
  properties: Record<string, unknown>,
  which: string,
): Promise<CreatePageResult> {
  // Database ids are per-install config, not repo constants. An unset id would
  // otherwise reach Notion as an empty parent and come back as an opaque 400.
  if (!databaseId) {
    throw new Error(
      `no Notion ${which} database configured. Set notion.databases.${which} ` +
        `in ~/.samaritan/config.yaml to that database's id.`,
    );
  }
  const page = (await notionFetch("/pages", {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: databaseId }, properties }),
  })) as CreatePageResult;
  return page;
}

const projectIdCache = new Map<string, string | null>();

/**
 * Resolves a project name to its Projects page id, because `Project` on both
 * Decisions and Insights is a relation, not text.
 *
 * Returns null when the project does not exist or the lookup fails, and callers
 * then file with the relation blank. AGENT_OS.md's routing rules already treat a
 * blank project as a valid state, so a missing link is a small loss; failing the
 * whole write over it would be a large one.
 */
async function resolveProjectId(name: string): Promise<string | null> {
  if (!name) return null;
  const cached = projectIdCache.get(name);
  if (cached !== undefined) return cached;

  try {
    const { databases } = loadConfig().notion;
    const body = (await notionFetch(`/databases/${databases.projects}/query`, {
      method: "POST",
      body: JSON.stringify({
        filter: { property: "Name", title: { equals: name } },
        page_size: 1,
      }),
    })) as { results?: { id: string }[] };
    const id = body.results?.[0]?.id ?? null;
    projectIdCache.set(name, id);
    if (!id) logger.info({ project: name }, "no Projects row matched; filing with project blank");
    return id;
  } catch (err) {
    logger.warn({ project: name, err: (err as Error).message }, "project lookup failed");
    return null;
  }
}

/** Test seam so the relation lookup can be exercised without a live token. */
export function __setProjectIdForTesting(name: string, id: string | null): void {
  projectIdCache.set(name, id);
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

      // Property names and select values come from AGENT_OS.md's "Notion DB
      // schemas" section, which is the vault's own contract. The title property
      // is "Decision", not "Name".
      const properties: Record<string, unknown> = { Decision: title(heading) };
      const rationale = str(p, "rationale");
      const evidence = str(p, "evidence");
      const reversibility = str(p, "reversibility");
      const project = str(p, "project");

      if (rationale) properties["Rationale"] = richText(rationale);
      if (evidence) properties["Evidence"] = richText(evidence);
      if (reversibility === "one-way" || reversibility === "two-way") {
        properties["Reversibility"] = { select: { name: reversibility } };
      }
      properties["Decided On"] = date();
      // AGENT_OS routing rule: a decision with no rationale stays pending rather
      // than being recorded as settled. Do not invent a rationale to close it.
      properties["Status"] = { select: { name: rationale ? "resolved" : "pending" } };

      if (project) {
        const projectId = await resolveProjectId(project);
        if (projectId) properties["Project"] = { relation: [{ id: projectId }] };
      }

      try {
        const page = await createPage(databases.decisions, properties, "decisions");
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

      // Per AGENT_OS.md the title property is "Insight", and Project is a
      // relation rather than text.
      const properties: Record<string, unknown> = { Insight: title(heading) };
      if (body) properties["Detail"] = richText(body);
      if (tags.length) properties["Tags"] = { multi_select: tags.map((name) => ({ name })) };
      // "Captured On" is a created_time property. Notion computes it and rejects
      // any attempt to write it, so it is deliberately absent here.

      if (project) {
        const projectId = await resolveProjectId(project);
        if (projectId) properties["Project"] = { relation: [{ id: projectId }] };
      }

      try {
        const page = await createPage(databases.insights, properties, "insights");
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
