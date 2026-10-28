import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  clearGoogleTokenCache,
  resolveGoogleAccessToken,
} from "../src/events/listeners/google-oauth.js";
import { createGmailSource } from "../src/events/listeners/gmail-source.js";
import { createGmailDraftAdapter } from "../src/execution/adapters/gmail.js";
import { createCalendarEventAdapter } from "../src/execution/adapters/calendar.js";
import { syncRecallMirrors } from "../src/recall/mirror-sync.js";
import { structuredRetrieve } from "../src/recall/structured.js";
import { backupDatabase, listBackups, pruneBackups } from "../src/store/backup.js";
import { openDatabase } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";
import { ConfigSchema } from "../src/config/index.js";

describe("Phase 5: Mirror Sync, Google OAuth Refresh & Backup Pruning", () => {
  beforeEach(() => {
    clearGoogleTokenCache();
  });

  it("syncs Notion decisions/insights (with Project relation resolution) and TickTick tasks into mirror tables", async () => {
    const db = openDatabase(":memory:");
    migrate(db);

    const cfg = ConfigSchema.parse({
      notion: {
        account: "pm-os-workspace",
        databases: {
          decisions: "db-decisions",
          insights: "db-insights",
          projects: "db-projects",
          people: "db-people",
        },
      },
      ticktick: {
        enabled: true,
        account: "default",
      },
    });

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/databases/db-projects/query")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "proj-1",
                properties: {
                  Name: { type: "title", title: [{ plain_text: "Samaritan OS" }] },
                },
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/databases/db-decisions/query")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "dec-101",
                url: "https://notion.so/dec-101",
                last_edited_time: "2026-10-28T02:00:00.000Z",
                properties: {
                  Decision: {
                    type: "title",
                    title: [{ plain_text: "Keep MCP server strictly approval-free" }],
                  },
                  Rationale: {
                    type: "rich_text",
                    rich_text: [{ plain_text: "External coding agents must never self-approve side effects." }],
                  },
                  Reversibility: {
                    type: "select",
                    select: { name: "two-way" },
                  },
                  Project: {
                    type: "relation",
                    relation: [{ id: "proj-1" }],
                  },
                },
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/databases/db-insights/query")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "ins-202",
                url: "https://notion.so/ins-202",
                last_edited_time: "2026-10-28T02:05:00.000Z",
                properties: {
                  Insight: {
                    type: "title",
                    title: [{ plain_text: "Pure decision functions shrink integration bugs" }],
                  },
                  Detail: {
                    type: "rich_text",
                    rich_text: [{ plain_text: "Splitting pure mappers from I/O shells keeps tests fast." }],
                  },
                  Tags: {
                    type: "multi_select",
                    multi_select: [{ name: "architecture" }, { name: "testing" }],
                  },
                },
              },
            ],
            has_more: false,
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/open/v1/project")) {
        return new Response(
          JSON.stringify([{ id: "tt-proj-1", name: "Work Inbox" }]),
          { status: 200 },
        );
      }
      if (url.includes("/open/v1/project/tt-proj-1/data")) {
        return new Response(
          JSON.stringify({
            tasks: [
              {
                id: "tt-task-9",
                title: "Review Q4 roadmap with engineering",
                dueDate: "2026-11-01",
                status: 0,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const synced = await syncRecallMirrors(db, {
      config: cfg,
      notionToken: "ntn_test",
      ticktickToken: "tt_test",
      fetchImpl: mockFetch,
    });

    expect(synced.notion_decisions).toBe(1);
    expect(synced.notion_insights).toBe(1);
    expect(synced.ticktick_tasks).toBe(1);
    expect(Object.keys(synced.errors)).toHaveLength(0);

    const passages = structuredRetrieve(db, "approval-free Samaritan OS roadmap");
    expect(passages.length).toBeGreaterThanOrEqual(2);
    expect(passages.some((p) => p.ref === "dec-101" && p.text.includes("Samaritan OS"))).toBe(
      true,
    );
    expect(passages.some((p) => p.ref === "tt-task-9")).toBe(true);

    const cursors = db
      .prepare<{ source: string; cursor: string }>("SELECT source, cursor FROM sync_cursors")
      .all();
    expect(cursors.map((c) => c.source).sort()).toEqual([
      "notion.decisions",
      "notion.insights",
      "ticktick",
    ]);
  });

  it("exchanges expired Google OAuth2 refresh_token bundles for Gmail and Calendar", async () => {
    let refreshCalls = 0;
    let lastBearer = "";

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://oauth2.googleapis.com/token") {
        refreshCalls += 1;
        return new Response(
          JSON.stringify({
            access_token: `ya29.refreshed_${refreshCalls}`,
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      const headers = new Headers(init?.headers);
      lastBearer = headers.get("Authorization") ?? "";
      if (url.includes("gmail.googleapis.com/gmail/v1/users/me/messages?")) {
        return new Response(JSON.stringify({ messages: [] }), { status: 200 });
      }
      if (url.includes("gmail.googleapis.com/gmail/v1/users/me/drafts")) {
        return new Response(
          JSON.stringify({ id: "draft-123", message: { id: "msg-123" } }),
          { status: 200 },
        );
      }
      if (url.includes("googleapis.com/calendar/v3/calendars/")) {
        return new Response(
          JSON.stringify({ id: "evt-456", htmlLink: "https://calendar.google.com/event?eid=456" }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    };

    const expiredBundle = JSON.stringify({
      client_id: "cid-1",
      client_secret: "csec-1",
      refresh_token: "1//refresh-xyz",
      access_token: "ya29.stale",
      expires_at: 1000,
    });

    const token1 = await resolveGoogleAccessToken(expiredBundle, { fetchImpl: mockFetch });
    expect(token1).toBe("ya29.refreshed_1");
    expect(refreshCalls).toBe(1);

    // Cached token is reused without a second OAuth POST
    const token2 = await resolveGoogleAccessToken(expiredBundle, { fetchImpl: mockFetch });
    expect(token2).toBe("ya29.refreshed_1");
    expect(refreshCalls).toBe(1);

    // Gmail source uses the refreshed token
    const gmailSource = createGmailSource({
      account: "default",
      token: expiredBundle,
      fetchImpl: mockFetch,
    });
    expect(gmailSource).toBeDefined();
    await gmailSource!.fetchSince(Date.now() - 60_000);
    expect(lastBearer).toBe("Bearer ya29.refreshed_1");

    // Gmail draft adapter uses the refreshed token
    const draftAdapter = createGmailDraftAdapter({
      token: () => expiredBundle,
      fetchImpl: mockFetch,
    });
    const draftRes = await draftAdapter.execute({
      action_item_id: "item-1",
      action_type: "email.reply",
      mode: "assisted",
      payload: {
        to: "alice@example.com",
        subject: "Update",
        draft_body: "Sounds good.",
      },
    });
    expect(draftRes.status).toBe("staged");
    expect(draftRes.result?.["gmail_draft_id"]).toBe("draft-123");

    // Calendar event adapter uses the refreshed token
    const calAdapter = createCalendarEventAdapter({
      token: () => expiredBundle,
      fetchImpl: mockFetch,
    });
    const calRes = await calAdapter.execute({
      action_item_id: "item-2",
      action_type: "calendar.event",
      mode: "assisted",
      payload: {
        title: "Architecture Sync",
        starts_at: "2026-10-29T10:00:00Z",
      },
    });
    expect(calRes.status).toBe("staged");
    expect(calRes.result?.["calendar_event_id"]).toBe("evt-456");
  });

  it("prunes old SQLite backups on disk and in db_backups beyond retainCount", () => {
    const dir = mkdtempSync(join(tmpdir(), "sam-backup-prune-"));
    try {
      const dbPath = join(dir, "live.db");
      const backupDir = join(dir, "backups");
      const db = openDatabase(dbPath);
      migrate(db);

      const b1 = backupDatabase(db, { backupDir, retainCount: 2 });
      const b2 = backupDatabase(db, { backupDir, retainCount: 2 });
      const b3 = backupDatabase(db, { backupDir, retainCount: 2 });

      const rows = listBackups(db, 10);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.id)).toEqual([b3.id, b2.id]);
      expect(existsSync(b3.backup_path)).toBe(true);
      expect(existsSync(b2.backup_path)).toBe(true);
      expect(existsSync(b1.backup_path)).toBe(false);

      const pruned = pruneBackups(db, 1, backupDir);
      expect(pruned).toBe(1);
      expect(listBackups(db, 10)).toHaveLength(1);
      expect(existsSync(b2.backup_path)).toBe(false);
      expect(existsSync(b3.backup_path)).toBe(true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
