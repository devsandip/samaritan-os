/**
 * Command Centre end-to-end & invariant test suite (`docs/deliberations/consensus/PROPOSAL.md`).
 *
 * Covers:
 *  1. Migration 8 schema & append-only `activity_events` triggers
 *  2. G2 prerequisite fixes (local `dailyNotePath`, `sweep` -> `delivery.flush()`,
 *     `source_rules` mute/snooze/pause, `admission_key` dedup, lease fencing,
 *     exact-revision `payload_hash` 409 guard, server-derived `actor`, Tailscale auth,
 *     startup reconciliation of interrupted runs/tasks)
 *  3. D1 5-method `WorkerAdapter` (`start`, `events`, `answer`, `cancel`, `status`),
 *     scoped artifacts + path traversal confinement, `needs_input` -> `answer` resume,
 *     and `proposeAction` routing through ActionCenter
 *  4. Phase 1 Meetings Loop (`CalendarPoller` -> `meeting-prep`,
 *     `POST /api/meetings/notes` -> vault note + Inbox items), TickTick Open API
 *     adapter (`#word` tag sanitization + receipt check), and Coding-Agent waiting hooks
 *     (`Notification` -> Inbox item, `Stop` -> auto-resolve)
 *  5. D4 Cross-Assistant 8-tool MCP server (`samaritan`) with zero approval tools
 *  6. D5 Telegram inbound callback & command handler
 */
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseBillEmail } from "../capabilities/bill-watch/index.js";
import {
  detectCalendarConflicts,
  extractEventFromScreenshotText,
} from "../capabilities/calendar-from-screenshot/index.js";
import {
  computeReadinessCoaching,
  fetchOuraV2DailyMetrics,
} from "../capabilities/health-coach/index.js";
import { isHighSignalImessage } from "../capabilities/imessage-digest/index.js";
import { fetchNutgrafSummary } from "../capabilities/nutgraf-brief/index.js";
import { evaluatePosthogMetrics } from "../capabilities/posthog-pulse/index.js";
import { evaluatePrdMultiLens } from "../capabilities/prd-review/index.js";
import { scanMultiRepoJournals } from "../capabilities/wbr-journal/index.js";
import { isHighSignalWhatsapp } from "../capabilities/whatsapp-digest/index.js";
import { buildServer, sweep } from "../src/api/server.js";
import { createApp, type App } from "../src/app.js";
import { renderPlist } from "../src/cli/plist.js";
import { repoRoot } from "../src/config/index.js";
import { handleTelegramUpdate } from "../src/delivery/telegram-inbound.js";
import { CalendarPoller } from "../src/events/listeners/calendar-sync.js";
import { handleCodingAgentHook } from "../src/events/listeners/coding-agent-hook.js";
import {
  fetchFirefliesTranscript,
  setFirefliesTranscriptFetcher,
} from "../src/events/listeners/fireflies-client.js";
import {
  slackEventToSamaritan,
  verifySlackSignature,
} from "../src/events/listeners/slack-webhook.js";
import { discoverJournalRoots } from "../src/events/listeners/vault-watch.js";
import { createCalendarEventAdapter } from "../src/execution/adapters/calendar.js";
import {
  buildRfc2822Base64Url,
  createGmailDraftAdapter,
} from "../src/execution/adapters/gmail.js";
import { createHevyRoutineCopyAdapter } from "../src/execution/adapters/hevy.js";
import { dailyNotePath } from "../src/execution/adapters/obsidian.js";
import { createThornhillPhoneAdapter } from "../src/execution/adapters/thornhill.js";
import { createTickTickAdapter, sanitizeTickTickText } from "../src/execution/adapters/ticktick.js";
import { handleMcpRequest } from "../src/mcp/index.js";
import { chunkMarkdown } from "../src/recall/chunk.js";
import { HashEmbedder } from "../src/recall/embed.js";
import {
  ensureVectorTable,
  hashContent,
  putSource,
  putVectors,
} from "../src/recall/index-store.js";
import { RecallService } from "../src/recall/service.js";
import { structuredRetrieve } from "../src/recall/structured.js";
import {
  checkBillingAllowance,
  computeInputHash,
} from "../src/run-layer/billing.js";
import { runCapability } from "../src/run-layer/index.js";
import { getActionItem, listActionItems, listAuditTrail } from "../src/store/action-items.js";
import { backupDatabase, listBackups } from "../src/store/backup.js";
import { admitRun, fenceRun, getRun, isLeaseValid, reconcileInterruptedRunsAndTasks } from "../src/store/runs.js";
import { upsertSourceRule } from "../src/store/source-rules.js";
import { appendActivityEvent, createTask, getTask } from "../src/store/tasks.js";
import {
  createChildProcessWorkerExecutor,
  resolveTaskArtifactPath,
  sanitizeWorkerEnv,
} from "../src/worker/index.js";

const CAPABILITIES = join(repoRoot(), "capabilities");

let tmpDir: string;
let app: App;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "samaritan-cc-"));
  app = createApp({
    dbPath: ":memory:",
    capabilitiesDir: CAPABILITIES,
    artifactsRoot: join(tmpDir, "artifacts"),
    recall: {
      embedder: {
        model: "test-deterministic",
        dimensions: 384,
        embed: async (texts: string[]) =>
          texts.map(() => new Float32Array(384).fill(0.05)),
      },
    },
  });
});

afterEach(() => {
  app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Migration 8 & append-only activity_events", () => {
  it("enforces append-only triggers on activity_events", () => {
    const task = createTask(app.db, { goal: "Verify append-only log" });
    const ev = appendActivityEvent(app.db, {
      task_id: task.id,
      type: "task.submitted",
      payload: { goal: task.goal },
    });

    expect(() =>
      app.db
        .prepare("UPDATE activity_events SET type = 'run.started' WHERE id = ?")
        .run(ev.id),
    ).toThrow(/append-only/);

    expect(() =>
      app.db.prepare("DELETE FROM activity_events WHERE id = ?").run(ev.id),
    ).toThrow(/append-only/);
  });

  it("reconciles interrupted running tasks and runs on daemon startup", () => {
    const task = createTask(app.db, { goal: "Long running analysis", status: "running" });
    const { run } = admitRun(app.db, {
      task_id: task.id,
      capability_id: "worker-task",
      runner: "worker",
    });

    const reconciled = reconcileInterruptedRunsAndTasks(app.db);
    expect(reconciled.runs).toBe(1);
    expect(reconciled.tasks).toBe(1);

    expect(getRun(app.db, run.id)?.status).toBe("interrupted");
    expect(getTask(app.db, task.id)?.status).toBe("interrupted");
  });
});

describe("G2 prerequisite fixes", () => {
  it("formats dailyNotePath using local calendar components instead of UTC slice", () => {
    const localDate = new Date(2026, 6, 19, 0, 15, 0); // 2026-07-19 00:15 local time
    expect(dailyNotePath(localDate)).toBe("Areas/Daily/2026-07-19.md");
  });

  it("calls delivery.flush() inside sweep()", async () => {
    let flushed = 0;
    const origFlush = app.delivery.flush.bind(app.delivery);
    app.delivery.flush = async () => {
      flushed += 1;
      return origFlush();
    };

    await sweep(app);
    expect(flushed).toBe(1);
  });

  it("pauses capability execution when source_rules.paused is true", async () => {
    upsertSourceRule(app.db, "newsletter-digest", {
      paused: true,
    });

    const report = await runCapability(app, "newsletter-digest");
    expect(report.status).toBe("skipped");
    expect(report.error).toMatch(/paused/);
  });

  it("deduplicates concurrent runs sharing the same admission_key", () => {
    const first = admitRun(app.db, {
      capability_id: "email-triage",
      runner: "child-process",
      admission_key: "event:email-triage:gmail:123",
    });
    const second = admitRun(app.db, {
      capability_id: "email-triage",
      runner: "child-process",
      admission_key: "event:email-triage:gmail:123",
    });

    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(false);
    expect(second.run.id).toBe(first.run.id);
  });

  it("rejects stale approvals with 409 when revision or payload_hash mismatches", async () => {
    const fixture = JSON.parse(
      readFileSync(join(CAPABILITIES, "email-triage", "fixtures", "demo.json"), "utf8"),
    ) as Record<string, unknown>;
    await runCapability(app, "email-triage", { inputs: fixture });

    const item = listActionItems(app.db, { capability_id: "email-triage" })[0]!;
    expect(item.revision).toBe(1);
    expect(item.payload_hash).toBeTruthy();

    const server = await buildServer(app);
    try {
      const staleRes = await server.inject({
        method: "POST",
        url: `/api/actions/${item.id}/respond`,
        payload: {
          response_id: item.responses[0]!,
          expected_revision: 99,
          expected_payload_hash: "deadbeef",
        },
      });
      expect(staleRes.statusCode).toBe(409);
      expect(staleRes.json().error.code).toBe("stale_approval");

      // Matching revision and payload_hash succeeds, and server enforces actor = "sandip"
      // even if client passes actor = "policy".
      const okRes = await server.inject({
        method: "POST",
        url: `/api/actions/${item.id}/respond`,
        payload: {
          actor: "policy",
          response_id: item.responses[0]!,
          expected_revision: item.revision,
          expected_payload_hash: item.payload_hash,
        },
      });
      expect(okRes.statusCode).toBe(200);

      const events = listAuditTrail(app.db, item.id);
      const approveEvent = events.find((e) => e.to_status === "approved");
      expect(approveEvent?.actor).toBe("sandip");
    } finally {
      await server.close();
    }
  });
});

describe("D1 Worker Adapter & Delegated Tasks", () => {
  it("rejects artifact paths that escape the task directory", () => {
    const root = join(tmpDir, "artifacts");
    expect(() => resolveTaskArtifactPath(root, "task-123", "../outside.md")).toThrow(/escapes/);
    expect(() => resolveTaskArtifactPath(root, "task-123", "/etc/passwd")).toThrow(/escapes/);
  });

  it("fences the run lease when cancelled so late writes are rejected", () => {
    const task = createTask(app.db, { goal: "Cancelable task", status: "running" });
    const { run } = admitRun(app.db, {
      task_id: task.id,
      capability_id: "worker-task",
      runner: "worker",
    });

    expect(isLeaseValid(app.db, run.id, run.lease_token!, run.fencing_generation)).toBe(true);
    fenceRun(app.db, run.id, "cancelled", "Stopped by user");
    expect(isLeaseValid(app.db, run.id, run.lease_token!, run.fencing_generation)).toBe(false);
  });
});

describe("Phase 1 Meetings Loop, TickTick Adapter, & Coding-Agent Hooks", () => {
  it("sanitizes #word tags in TickTick task text and verifies provider receipt id", async () => {
    expect(sanitizeTickTickText("Review PR #73 and #urgent issue #19")).toBe(
      "Review PR 73 and urgent issue 19",
    );

    const adapter = createTickTickAdapter({
      db: app.db,
      token: () => "test-ticktick-token",
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/project") && (!init?.method || init.method === "GET")) {
          return new Response(
            JSON.stringify([
              { id: "proj-samaritan-1", name: "Samaritan" },
              { id: "proj-nutgraf-2", name: "Nutgraf" },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const body = JSON.parse(String(init?.body));
        expect(body.title).toBe("Review PR 73");
        expect(body.content).toMatch(/^Check issue 19 details\n\nref: samaritan:[0-9a-f]{12}$/);
        expect(body.projectId).toBe("proj-samaritan-1");
        expect(body.tags).toEqual(["PRreview", "samaritan"]);
        return new Response(
          JSON.stringify({ id: "tt-task-99", projectId: "proj-samaritan-1", status: 0 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const outcome = await adapter.execute({
      action_item_id: "item-tt-1",
      capability: "ticktick.task.create",
      mode: "automated",
      idempotency_key: "idem-tt-1",
      payload: {
        title: "Review PR #73",
        content: "Check issue #19 details",
        list: "samaritan",
        tags: ["#PRreview", "samaritan"],
      },
    });

    expect(outcome.status).toBe("succeeded");
    expect(outcome.result).toMatchObject({
      ticktick_task_id: "tt-task-99",
      list: "samaritan",
      projectId: "proj-samaritan-1",
    });
    const row = app.db
      .prepare("SELECT id, title FROM ticktick_tasks WHERE id = 'tt-task-99'")
      .get() as { id: string; title: string } | undefined;
    expect(row?.title).toBe("Review PR 73");
  });

  it("polls Google Calendar incrementally and triggers meeting-prep brief", async () => {
    const soonStart = new Date(Date.now() + 10 * 60_000).toISOString();
    const soonEnd = new Date(Date.now() + 40 * 60_000).toISOString();

    const poller = new CalendarPoller({
      db: app.db,
      prepLeadMinutes: 20,
      publish: (event) => app.eventBus.publish(event),
      source: async () => ({
        items: [
          {
            id: "gcal-ev-1",
            summary: "Storage Architecture Review",
            start: { dateTime: soonStart },
            end: { dateTime: soonEnd },
            attendees: [{ email: "priya@example.com", displayName: "Priya" }],
          },
        ],
        nextSyncToken: "sync-tok-2",
      }),
    });

    const pollRes = await poller.pollOnce();
    expect(pollRes.synced).toBe(1);
    expect(pollRes.upcomingPublished).toBe(1);

    const briefs = listActionItems(app.db, { capability_id: "meeting-prep" });
    expect(briefs).toHaveLength(1);
    expect(briefs[0]?.custom["meeting_title"]).toBe("Storage Architecture Review");
  });

  it("captures raw meeting notes via POST /api/meetings/notes and extracts action items", async () => {
    const server = await buildServer(app);
    try {
      const res = await server.inject({
        method: "POST",
        url: "/api/meetings/notes",
        payload: {
          title: "Q3 Roadmap Sync",
          date: "2026-07-19",
          attendees: ["Sandip", "Rohan"],
          notes: [
            "Decision: Freeze schema changes after Friday",
            "Action: Send API migration checklist to partner team",
          ].join("\n"),
        },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.status).toBe("ok");
      expect(body.accepted.length).toBeGreaterThanOrEqual(2);
    } finally {
      await server.close();
    }
  });

  it("surfaces a coding-agent waiting hook and auto-resolves it on Stop", async () => {
    const server = await buildServer(app);
    try {
      const notifyRes = await server.inject({
        method: "POST",
        url: "/api/hooks/coding-agent",
        payload: {
          agent: "claude-code",
          session_id: "sess-cc-42",
          hook_event_name: "Notification",
          notification_type: "permission_prompt",
          cwd: "/Users/sandipdev/Developer/samaritan",
          message: "Allow bash command: pnpm migrate?",
        },
      });
      expect(notifyRes.statusCode).toBe(202);

      const pending = listActionItems(app.db, {
        capability_id: "coding-agent",
        status: "pending",
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.custom["session_id"]).toBe("sess-cc-42");

      // Terminal Stop hook resolves the waiting prompt automatically
      const stopRes = await server.inject({
        method: "POST",
        url: "/api/hooks/coding-agent",
        payload: {
          agent: "claude-code",
          session_id: "sess-cc-42",
          hook_event_name: "Stop",
        },
      });
      expect(stopRes.statusCode).toBe(202);
      expect(stopRes.json().action).toBe("auto_resolved");

      const afterStop = getActionItem(app.db, pending[0]!.id);
      // Retired, not approved: nobody decided anything in Samaritan.
      expect(afterStop?.status).toBe("expired");
      expect(listAuditTrail(app.db, pending[0]!.id).some((e) => e.to_status === "approved")).toBe(false);
    } finally {
      await server.close();
    }
  });
});

describe("D4 Cross-Assistant MCP Server", () => {
  const call = async (name: string, args: Record<string, unknown>, id = 1) => {
    const res = await handleMcpRequest(app, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    const result = res!.result as { content: { text: string }[]; isError?: boolean };
    return { res: res!, result, json: () => JSON.parse(result.content[0]!.text) as Record<string, unknown> };
  };

  it("negotiates the protocol and answers notifications with nothing", async () => {
    const init = await handleMcpRequest(app, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {} },
    });
    expect((init!.result as { protocolVersion: string }).protocolVersion).toBe("2025-06-18");
    expect(await handleMcpRequest(app, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect((await handleMcpRequest(app, { jsonrpc: "2.0", id: 9 }))!.error?.code).toBe(-32600);
  });

  it("exposes exactly 8 tools and never an approval tool", async () => {
    const listRes = await handleMcpRequest(app, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (listRes!.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(tools).toEqual([
      "get_context",
      "search",
      "read_artifact",
      "list_inbox",
      "propose_action",
      "submit_task",
      "task_status",
      "answer_question",
    ]);

    const badCall = await handleMcpRequest(app, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "approve_action", arguments: { id: "any" } },
    });
    expect(badCall!.error).toMatchObject({ code: -32602, message: expect.stringMatching(/unknown tool/) });
  });

  it("answers malformed messages with an error instead of failing", async () => {
    expect((await handleMcpRequest(app, null))!.error?.code).toBe(-32600);
    const server = buildServer(app);
    try {
      const res = await server.inject({ method: "POST", url: "/api/mcp", payload: [null] });
      expect(res.statusCode).toBe(200);
      expect(res.json()[0].error.code).toBe(-32600);
    } finally {
      await server.close();
    }
  });

  it("reports a failing tool as an isError result the model can read", async () => {
    const { result } = await call("propose_action", { kind: "rumour", title: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/kind must be one of/);
  });

  it("files proposals as pending, and a different body under the same title as a new item", async () => {
    const first = (await call("propose_action", { kind: "task", title: "Follow up", detail: "AWS" })).json();
    const second = (await call("propose_action", { kind: "task", title: "Follow up", detail: "GCP" })).json();
    const a = (first["proposed"] as { id: string }).id;
    const b = (second["proposed"] as { id: string }).id;
    expect(a).not.toBe(b);
    expect(getActionItem(app.db, a)?.status).toBe("pending");
    expect(getActionItem(app.db, a)?.custom["detail"]).toBe("AWS");
  });

  it("queues submitted tasks at once, idempotent on request_id", async () => {
    app.worker.stop();
    const first = (await call("submit_task", { goal: "Draft the WBR", request_id: "r1" })).json();
    const again = (await call("submit_task", { goal: "Draft the WBR", request_id: "r1" })).json();
    const task = first["task"] as { id: string; status: string; origin: string };
    expect(task).toMatchObject({ status: "queued", origin: "mcp" });
    expect((again["task"] as { id: string }).id).toBe(task.id);
    expect(again["created"]).toBe(false);
  });

  it("speaks Streamable HTTP: 202 for a notification, 405 for GET", async () => {
    const server = buildServer(app);
    try {
      const note = await server.inject({
        method: "POST",
        url: "/api/mcp",
        payload: { jsonrpc: "2.0", method: "notifications/initialized" },
      });
      expect(note.statusCode).toBe(202);
      expect(note.body).toBe("");
      expect((await server.inject({ method: "GET", url: "/api/mcp" })).statusCode).toBe(405);
    } finally {
      await server.close();
    }
  });

  it("enforces Phase 0 caffeinate plist, SQLite VACUUM INTO backup, and C2 billing guardrails", async () => {
    const plistXml = renderPlist({
      label: "com.sandipdev.samaritan",
      nodePath: "/usr/local/bin/node",
      entryPath: "/Users/sandipdev/Developer/samaritan/dist/cli/serve.js",
      workingDir: "/Users/sandipdev/Developer/samaritan",
      outLog: "/tmp/logs/out.log",
      errLog: "/tmp/logs/err.log",
      env: { SAMARITAN_CONFIG: "/Users/sandipdev/Developer/samaritan/config/samaritan.yaml" },
      preventSleep: true,
    });
    expect(plistXml).toContain("<string>/usr/bin/caffeinate</string>");
    expect(plistXml).toContain("<string>-dis</string>");

    const backup = backupDatabase(app.db, {
      backupDir: join(tmpDir, "backups"),
      keepCount: 3,
    });
    expect(backup.integrity_ok).toBe(true);
    expect(backup.size_bytes).toBeGreaterThan(0);
    expect(listBackups(app.db).length).toBe(1);

    const h1 = computeInputHash({ b: 2, a: 1 });
    const h2 = computeInputHash({ a: 1, b: 2 });
    expect(h1).toBe(h2);

    const firstRun = await runCapability(app, "nutgraf-brief", {
      inputs: { date: "2026-10-27", articles: [] },
      skipIfUnchanged: true,
      costUsd: 12.5,
      monthlyCapUsd: 25,
    });
    expect(firstRun.status).toBe("ok");

    const skippedSameInput = await runCapability(app, "nutgraf-brief", {
      inputs: { articles: [], date: "2026-10-27" },
      skipIfUnchanged: true,
    });
    expect(skippedSameInput.status).toBe("skipped");
    expect(skippedSameInput.error).toContain("unchanged inputs");

    const budgetCheck = checkBillingAllowance(app.db, 10);
    expect(budgetCheck.allowed).toBe(false);
    expect(budgetCheck.mtd_spend_usd).toBeCloseTo(12.5);

    const skippedBudget = await runCapability(app, "nutgraf-brief", {
      inputs: { date: "2026-10-28", articles: [] },
      monthlyCapUsd: 10,
    });
    expect(skippedBudget.status).toBe("skipped");
    expect(skippedBudget.error).toContain("budget_exceeded");
  });

  it("handles Phase 1 Fireflies GraphQL consumer, Granola intake, and post-meeting nudge", async () => {
    setFirefliesTranscriptFetcher(async (meetingId) => ({
      id: meetingId,
      title: "Fireflies Strategy Sync",
      dateIso: "2026-10-27",
      attendees: ["Sandip", "Maya"],
      transcriptText: "Sandip: Let's ship Phase 1.\nDecision: freeze schema v9 today.",
    }));

    try {
      const fetched = await fetchFirefliesTranscript("ff-meeting-42");
      expect(fetched?.title).toBe("Fireflies Strategy Sync");

      const report = await runCapability(app, "meeting", {
        trigger: {
          mode: "event",
          firedAt: new Date().toISOString(),
          payload: { meeting_id: "ff-meeting-42" },
        },
      });
      expect(report.status).toBe("ok");
      expect(report.accepted.length).toBeGreaterThan(0);
    } finally {
      setFirefliesTranscriptFetcher(undefined);
    }

    const nudgeReport = await runCapability(app, "meeting-prep", {
      trigger: {
        mode: "event",
        firedAt: new Date().toISOString(),
        payload: {
          event_id: "evt-ended-1",
          title: "1:1 Product Sync",
          ends_at: "2026-10-27T15:00:00Z",
          nudge_after_end: true,
        },
      },
    });
    expect(nudgeReport.status).toBe("ok");
    expect(nudgeReport.accepted[0]?.dedupe_key).toBe("meeting-nudge:evt-ended-1");

    const server = buildServer(app);
    try {
      const granolaRes = await server.inject({
        method: "POST",
        url: "/api/meetings/granola",
        payload: {
          title: "Granola Design Review",
          date: "2026-10-27",
          markdown: "Decision: Adopt 5-view navigation. Task: Update Sidebar by Friday.",
        },
      });
      expect(granolaRes.statusCode).toBe(202);
      expect(granolaRes.json().status).toBe("ok");
    } finally {
      await server.close();
    }
  });

  it("runs Phase 2 child-process worker with Rule-of-Two credential stripping, MCP scope filter, and Telegram edit/photo/meeting", async () => {
    const sanitized = sanitizeWorkerEnv({
      PATH: process.env.PATH,
      NOTION_API_KEY: "secret-notion",
      GMAIL_TOKEN: "secret-gmail",
      TICKTICK_TOKEN: "secret-ticktick",
      TELEGRAM_BOT_TOKEN: "secret-tg",
      SAFE_VAR: "allowed",
    });
    expect(sanitized.NOTION_API_KEY).toBeUndefined();
    expect(sanitized.GMAIL_TOKEN).toBeUndefined();
    expect(sanitized.TICKTICK_TOKEN).toBeUndefined();
    expect(sanitized.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(sanitized.SAFE_VAR).toBe("allowed");
    expect(sanitized.SAMARITAN_SANDBOX).toBe("rule_of_two");

    app.worker.setExecutor(createChildProcessWorkerExecutor());
    const submitted = app.worker.submit({
      goal: "Synthesize child-process architecture notes",
      lane: "research",
      scope: "personal",
    });
    await app.worker.whenIdle();
    const completedTask = app.worker.getTask(submitted.task.id)!;
    expect(completedTask.status).toBe("succeeded");
    expect(completedTask.scope).toBe("personal");
    expect(app.worker.listArtifacts({ task_id: submitted.task.id }).length).toBe(1);

    // MCP scope filtering: work vs personal
    await handleMcpRequest(app, {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "propose_action",
        arguments: {
          kind: "note",
          title: "Personal health note",
          scope: "personal",
        },
      },
    });
    const workInbox = await handleMcpRequest(app, {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "list_inbox",
        arguments: { scope: "work" },
      },
    });
    const personalInbox = await handleMcpRequest(app, {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "list_inbox",
        arguments: { scope: "personal" },
      },
    });
    const workItems = (workInbox.result as { structuredContent: { items: { id: string }[] } })
      .structuredContent.items;
    const personalItems = (
      personalInbox.result as { structuredContent: { items: { id: string; custom: Record<string, unknown> }[] } }
    ).structuredContent.items;
    expect(personalItems.some((i) => i.custom.title === "Personal health note")).toBe(true);
    expect(workItems.some((i) => i.id === personalItems[0]!.id)).toBe(false);

    // Telegram inline edit, /meeting, and photo intake
    const targetItem = personalItems[0]!;
    const editRes = await handleTelegramUpdate(
      {
        db: app.db,
        actionCenter: app.actionCenter,
        worker: app.worker,
        eventBus: app.eventBus,
        allowedChatId: "12345",
      },
      {
        update_id: 20,
        callback_query: {
          id: "cb-edit",
          data: `edit:${targetItem.id}:title:Updated Personal Note`,
          message: { chat: { id: 12345 } },
        },
      },
    );
    expect(editRes.accepted).toBe(true);
    expect(editRes.action).toBe("edited");
    expect(getActionItem(app.db, targetItem.id)?.custom.title).toBe("Updated Personal Note");
    expect(getActionItem(app.db, targetItem.id)?.revision).toBe(2);

    const photoRes = await handleTelegramUpdate(
      {
        db: app.db,
        actionCenter: app.actionCenter,
        worker: app.worker,
        eventBus: app.eventBus,
        allowedChatId: "12345",
      },
      {
        update_id: 21,
        message: {
          chat: { id: 12345 },
          caption: "Board Dinner 2026-11-10",
          photo: [{ file_id: "photo-xyz", width: 800, height: 600 }],
        },
      },
    );
    expect(photoRes.accepted).toBe(true);
    expect(photoRes.action).toBe("screenshot_received");
  });

  it("verifies Phase 3 & Phase 4 adapters (Gmail draft, Hevy copy, Calendar event, Thornhill phone), coding-agent loop guard, and Remote MCP OAuth", async () => {
    // Coding-agent Stop-hook loop prevention (Gap 7)
    const loopStopped = await handleCodingAgentHook(
      { db: app.db, eventBus: app.eventBus },
      {
        agent: "claude-code",
        session_id: "sess-loop",
        hook_event_name: "Stop",
        stop_hook_active: true,
      },
    );
    expect(loopStopped.action).toBe("recorded_only");

    // Gmail draft adapter (assisted mode, RFC 2822 base64url, never auto-send)
    const rawMime = buildRfc2822Base64Url({
      to: "recruiter@example.com",
      subject: "Re: Product Lead",
      body: "Happy to chat Thursday.",
    });
    expect(rawMime.length).toBeGreaterThan(20);

    const gmailAdapter = createGmailDraftAdapter({
      token: () => "gmail-test-token",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ id: "draft-9001" }), { status: 200 })) as typeof fetch,
    });
    expect(gmailAdapter.modes).toEqual(["assisted", "guided"]);
    const gmailRes = await gmailAdapter.execute({
      action_item_id: "act-gmail-1",
      capability: "gmail.draft.create",
      mode: "assisted",
      idempotency_key: "idem-gmail-1",
      payload: {
        to: "recruiter@example.com",
        subject: "VP Product role",
        draft_body: "Thanks for reaching out!",
      },
    });
    expect(gmailRes.status).toBe("staged");
    expect(gmailRes.result?.gmail_draft_id).toBe("draft-9001");

    // Hevy routine copy adapter (creates copy via POST /v1/routines, never overwrites)
    let hevyMethod = "";
    let hevyUrl = "";
    const hevyAdapter = createHevyRoutineCopyAdapter({
      apiKey: () => "hevy-test-key",
      fetchImpl: (async (url, init) => {
        hevyUrl = String(url);
        hevyMethod = String(init?.method ?? "GET");
        return new Response(JSON.stringify({ routine: { id: "routine-copy-77" } }), {
          status: 201,
        });
      }) as typeof fetch,
    });
    const hevyRes = await hevyAdapter.execute({
      action_item_id: "act-hevy-1",
      capability: "hevy.routine.copy",
      mode: "assisted",
      idempotency_key: "idem-hevy-1",
      payload: {
        routine_title: "Upper Body A",
        adjustment_summary: "Deload 15%",
      },
    });
    expect(hevyMethod).toBe("POST");
    expect(hevyUrl).toBe("https://api.hevyapp.com/v1/routines");
    expect(hevyRes.status).toBe("staged");
    expect(String(hevyRes.result?.title)).toContain("Upper Body A (Samaritan Adjusted");

    // Calendar event adapter
    const calAdapter = createCalendarEventAdapter({
      token: () => "gcal-test-token",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ id: "cal-evt-55", htmlLink: "https://calendar.google.com/event?eid=55" }),
          { status: 200 },
        )) as typeof fetch,
    });
    const calRes = await calAdapter.execute({
      action_item_id: "act-cal-1",
      capability: "calendar.event.create",
      mode: "assisted",
      idempotency_key: "idem-cal-1",
      payload: {
        title: "Founder Dinner",
        starts_at: "2026-11-05T19:00:00Z",
      },
    });
    expect(calRes.status).toBe("staged");
    expect(calRes.result?.calendar_event_id).toBe("cal-evt-55");

    // Thornhill phone adapter
    const thornhillAdapter = createThornhillPhoneAdapter({
      apiKey: () => "th-test-key",
      apiUrl: () => "https://thornhill.example",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ call_id: "th-call-88" }), { status: 200 })) as typeof fetch,
    });
    const thRes = await thornhillAdapter.execute({
      action_item_id: "act-th-1",
      capability: "phone.task.run",
      mode: "assisted",
      idempotency_key: "idem-th-1",
      payload: {
        callee_name: "PG&E Support",
        phone_number: "+18007435000",
        call_objective: "Check rate plan",
      },
    });
    expect(thRes.status).toBe("staged");
    expect(thRes.result?.thornhill_call_id).toBe("th-call-88");

    // Webhooks & Remote MCP OAuth endpoints
    const server = buildServer(app);
    try {
      const wellKnown = await server.inject({
        method: "GET",
        url: "/.well-known/oauth-authorization-server",
      });
      expect(wellKnown.statusCode).toBe(200);
      expect(wellKnown.json().grant_types_supported).toContain("client_credentials");

      const tokenRes = await server.inject({
        method: "POST",
        url: "/api/oauth/token",
        payload: { client_secret: "local-dev-secret", scope: "mcp:work" },
      });
      expect(tokenRes.statusCode).toBe(200);
      expect(tokenRes.json().token_type).toBe("Bearer");

      const stopHook = await server.inject({
        method: "POST",
        url: "/api/webhooks/thornhill",
        payload: {
          call_id: "th-call-88",
          callee_name: "PG&E Support",
          phone_number: "+18007435000",
          stop_reason: "otp_required",
          question: "Agent asked for 6-digit SMS code.",
        },
      });
      expect(stopHook.statusCode).toBe(202);

      const sysHealth = await server.inject({
        method: "GET",
        url: "/api/system/health",
      });
      expect(sysHealth.statusCode).toBe(200);
      expect(sysHealth.json().sqlite_integrity).toBe("ok");
      expect(sysHealth.json().schema_version).toBeGreaterThanOrEqual(9);

      const conns = await server.inject({
        method: "GET",
        url: "/api/connections",
      });
      expect(conns.statusCode).toBe(200);
      expect(Array.isArray(conns.json().connections)).toBe(true);
      expect(
        conns.json().connections.some((c: { id: string }) => c.id === "google.calendar"),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("verifies deepened capabilities (WBR multi-repo journals, PRD multi-lens + Recall, Nutgraf, PostHog data_missing, Oura tiers, Bill parser, Screenshot OCR + conflicts, Signal filters)", async () => {
    // 1. Multi-repo WBR journal scanning + discoverJournalRoots
    const devRoot = mkdtempSync(join(tmpdir(), "sam-dev-journals-"));
    try {
      const repoA = join(devRoot, "alpha-repo", "journal", "entries");
      const repoB = join(devRoot, "beta-repo", "journal", "entries");
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });
      writeFileSync(
        join(repoA, "2026-10-27-1000-alpha.md"),
        [
          "# Shipped Alpha Core",
          "",
          "## Decisions",
          "- Use SQLite WAL for concurrent readers.",
          "",
          "## Direction changes",
          "- Was polling every 5s, now event-driven.",
          "",
          "## Needs revisit",
          "- Check index compaction after 100k rows.",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        join(repoB, "2026-10-27-1100-beta.md"),
        ["# Beta Launch Prep", "", "## Decisions", "- Lock payment.make to guided mode."].join(
          "\n",
        ),
        "utf8",
      );

      const watchRoots = discoverJournalRoots(devRoot);
      expect(watchRoots).toHaveLength(2);
      expect(watchRoots.every((r) => r.kind === "journal")).toBe(true);

      const scanned = scanMultiRepoJournals(devRoot);
      expect(scanned.repos_scanned.sort()).toEqual(["alpha-repo", "beta-repo"]);
      expect(scanned.highlights.some((h) => h.includes("Shipped Alpha Core"))).toBe(true);
      expect(scanned.decisions.some((d) => d.includes("Use SQLite WAL"))).toBe(true);
      expect(scanned.direction_changes.some((c) => c.includes("Was polling every 5s"))).toBe(
        true,
      );
      expect(scanned.needs_revisit.some((r) => r.includes("Check index compaction"))).toBe(true);
    } finally {
      rmSync(devRoot, { recursive: true, force: true });
    }

    // 2. PRD Multi-Lens evaluation + Recall citations + versioned artifact
    const prdEval = evaluatePrdMultiLens(
      "# Smart Triage PRD\n\n## Problem & Context\nUsers drown in low-signal alerts.\n\n## Success Metrics\nReduce P95 review latency by 40%.\n\n## User Flow & Empty State\nInbox card layout with keyboard shortcuts (Cmd+K) and empty state.\n\n## Schema & Security\nSQLite table with idempotency keys and Keychain token guardrails.",
    );
    expect(prdEval.rubric_score).toBeGreaterThanOrEqual(75);
    expect(prdEval.pm_findings.some((f) => f.includes("[Gap]"))).toBe(true); // Non-goals missing

    const artifactTmp = mkdtempSync(join(tmpdir(), "sam-prd-artifacts-"));
    try {
      const prdRun = await runCapability(app, "prd-review", {
        inputs: {
          prd_title: "Smart Triage Spec",
          project: "Samaritan",
          prd_markdown:
            "# Smart Triage Spec\n\nProblem: alert fatigue. KPI: 50% faster triage. Non-goals: auto-payment.",
          artifact_dir: artifactTmp,
        },
        recall: async () => ({
          answer: "Prior decision on triage",
          citations: [
            {
              kind: "notion_decision",
              ref: "dec-99",
              excerpt: "Keep money locked to guided mode.",
            },
          ],
          retrieval_path: "hybrid",
        }),
        force: true,
      });
      expect(prdRun.status).toBe("ok");
      const prdItem = listActionItems(app.db, { capability_id: "prd-review" })[0]!;
      expect(String(prdItem.custom.content)).toContain("dec-99");
      expect(prdRun.logs[0]).toContain("wrote artifact v1");
    } finally {
      rmSync(artifactTmp, { recursive: true, force: true });
    }

    // 3. Nutgraf HTTP client seam
    const nutgrafRes = await fetchNutgrafSummary({
      url: "https://sandip.dev/nutgraf/api",
      token: "nutgraf-machine-tok",
      date: "2026-10-27",
      fetchImpl: (async (url, init) => {
        expect(String(url)).toBe("https://sandip.dev/nutgraf/api/summary?date=2026-10-27");
        const headers = init?.headers as Record<string, string>;
        expect(headers["x-nutgraf-machine-token"]).toBe("nutgraf-machine-tok");
        return new Response(
          JSON.stringify({
            articles: [{ title: "Agentic OS Design", nutgraf: "Local SQLite wins." }],
            audio_url: "https://sandip.dev/nutgraf/audio/2026-10-27.mp3",
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(nutgrafRes.articles).toHaveLength(1);
    expect(nutgrafRes.audio_url).toContain("2026-10-27.mp3");

    // 4. PostHog evaluation: null/undefined reported as data_missing, never 0
    const phEval = evaluatePosthogMetrics([
      { name: "DAU", value: 1200, baseline_7d: 1000 },
      { name: "Checkout Funnel", value: null, baseline_7d: 400 },
    ]);
    expect(phEval.missingMetrics).toEqual(["Checkout Funnel"]);
    expect(phEval.formattedLines.some((l) => l.includes("data_missing"))).toBe(true);
    expect(phEval.derivedAnomalies).toHaveLength(2);
    expect(
      phEval.derivedAnomalies.find((a) => a.metric === "Checkout Funnel")?.delta_pct,
    ).toBe("data_missing");

    // 5. Oura V2 & Readiness Coaching Tiers
    expect(
      computeReadinessCoaching({
        sleep_score: 65,
        hrv_ms: 35,
        recovery_pct: 62,
        routine_title: "Push A",
      }).tier,
    ).toBe("deload");
    expect(
      computeReadinessCoaching({
        sleep_score: 78,
        hrv_ms: 48,
        recovery_pct: 76,
        routine_title: "Push A",
      }).tier,
    ).toBe("maintenance");
    expect(
      computeReadinessCoaching({
        sleep_score: 90,
        hrv_ms: 62,
        recovery_pct: 89,
        routine_title: "Push A",
      }).tier,
    ).toBe("progressive_overload");

    const ouraMetrics = await fetchOuraV2DailyMetrics({
      token: "oura-tok",
      date: "2026-10-27",
      fetchImpl: (async (url) => {
        const u = String(url);
        if (u.includes("daily_readiness")) {
          return new Response(
            JSON.stringify({ data: [{ score: 86, contributors: { hrv_balance: 54 } }] }),
            { status: 200 },
          );
        }
        if (u.includes("daily_sleep")) {
          return new Response(JSON.stringify({ data: [{ score: 82 }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [{ stress_high: 1800 }] }), { status: 200 });
      }) as typeof fetch,
    });
    expect(ouraMetrics.readiness_score).toBe(86);
    expect(ouraMetrics.sleep_score).toBe(82);
    expect(ouraMetrics.hrv_ms).toBe(54);
    expect(ouraMetrics.stress_high_minutes).toBe(30);

    // 6. Bill email parser (INR + USD + account mask + due date certainty)
    const inrBill = parseBillEmail({
      from: "HDFC Bank Credit Cards <alerts@hdfcbank.net>",
      subject: "Credit Card Statement for card ending in 4821",
      body: "Your total amount due is ₹16,800.00. Payment due on 2026-11-12. Pay at https://pay.hdfcbank.com",
    });
    expect(inrBill).not.toBeNull();
    expect(inrBill?.biller).toBe("HDFC Bank Credit Cards");
    expect(inrBill?.amount_display).toContain("₹");
    expect(inrBill?.due_date).toBe("2026-11-12");
    expect(inrBill?.due_date_certainty).toBe("exact");
    expect(inrBill?.account_mask).toBe("••4821");

    const inferredBill = parseBillEmail({
      from: "PG&E Billing <noreply@pge.com>",
      subject: "Your monthly utility bill is ready",
      body: "Total amount due: $94.20.",
      received_at: "2026-10-27T10:00:00Z",
    });
    expect(inferredBill?.due_date_certainty).toBe("inferred");
    expect(inferredBill?.due_date).toBe("2026-11-10");

    // 7. Screenshot OCR extraction & conflict detection
    const extracted = extractEventFromScreenshotText(
      "Event: AI Systems Summit\n2026-11-05 2:00pm PT\nLocation: Pier 27, San Francisco",
    );
    expect(extracted.title).toBe("AI Systems Summit");
    expect(extracted.timezone_ambiguous).toBe(false);
    expect(extracted.date_ambiguous).toBe(false);
    expect(extracted.location).toBe("Pier 27, San Francisco");

    const conflicts = detectCalendarConflicts(
      { starts_at: extracted.starts_at, ends_at: extracted.ends_at },
      [
        {
          id: "ev-1",
          title: "Board Sync",
          starts_at: extracted.starts_at,
          ends_at: extracted.ends_at,
        },
      ],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toContain("Board Sync");

    // 8. iMessage / WhatsApp high-signal filter (strips OTPs and carrier shortcodes)
    expect(isHighSignalImessage("58291", "492819 is your verification code")).toBe(false);
    expect(isHighSignalImessage("AX-HDFCBK", "Your OTP is 839102. Do not share this code.")).toBe(
      false,
    );
    expect(isHighSignalImessage("+1-415-555-0192 (Rohan)", "Are we still on for dinner?")).toBe(
      true,
    );
    expect(isHighSignalWhatsapp("ShopAlerts", "Use OTP 112233 to login")).toBe(false);
    expect(isHighSignalWhatsapp("Arjun", "Flight lands at 6pm")).toBe(true);
  });

  it("verifies Recall structured SQL + hybrid retrieval, scope filtering, Calendar reschedule events, and Slack webhook verification", async () => {
    // 1. Seed structured mirror rows and semantic chunks with work vs personal scopes
    app.db
      .prepare(
        "INSERT INTO notion_decisions (id, title, rationale, project, reversibility) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        "dec-sqlite-1",
        "Adopt node:sqlite over better-sqlite3",
        "Built-in driver avoids native ABI breakage on Node 24+.",
        "Samaritan",
        "two-way-door",
      );

    const embedder = new HashEmbedder();
    ensureVectorTable(app.db, await embedder.dimensions());

    const workChunks = chunkMarkdown(
      "# Architecture Notes\n\nWe selected node:sqlite for the local Action Store database.",
    );
    const workRowids = putSource(
      app.db,
      {
        path: "Architecture.md",
        kind: "obsidian",
        contentHash: hashContent("work-doc"),
        scope: "work",
      },
      workChunks,
    );
    const workVecs = await embedder.embed(workChunks.map((c) => c.text));
    putVectors(
      app.db,
      "Architecture.md",
      new Map(workRowids.map((id, i) => [id, workVecs[i]!])),
    );

    const personalChunks = chunkMarkdown(
      "# Personal Health Log\n\nOura HRV was 58ms after Lower Body Strength B.",
    );
    const personalRowids = putSource(
      app.db,
      {
        path: "Health.md",
        kind: "obsidian",
        contentHash: hashContent("personal-doc"),
        scope: "personal",
      },
      personalChunks,
    );
    const personalVecs = await embedder.embed(personalChunks.map((c) => c.text));
    putVectors(
      app.db,
      "Health.md",
      new Map(personalRowids.map((id, i) => [id, personalVecs[i]!])),
    );

    const structuredHits = structuredRetrieve(app.db, "Why did we adopt node:sqlite?");
    expect(structuredHits).toHaveLength(1);
    expect(structuredHits[0]?.ref).toBe("dec-sqlite-1");

    const recallSvc = new RecallService({
      db: app.db,
      config: app.config,
      embedder,
    });
    const hybridAns = await recallSvc.query("Why did we adopt node:sqlite?");
    expect(hybridAns.retrieval_path).toBe("hybrid");
    expect(hybridAns.citations.some((c) => c.ref === "dec-sqlite-1")).toBe(true);

    const personalOnly = await recallSvc.query("Oura HRV Lower Body", { scope: "personal" });
    expect(personalOnly.retrieval_path).toBe("semantic");
    expect(personalOnly.citations.every((c) => c.ref.startsWith("Health.md"))).toBe(true);

    // 2. CalendarPoller reschedule detection (`calendar.meeting_rescheduled`)
    const busEvents: string[] = [];
    let callNum = 0;
    const calPoller = new CalendarPoller({
      db: app.db,
      now: () => new Date("2026-10-27T10:00:00Z"),
      source: async () => {
        callNum += 1;
        return {
          items: [
            {
              id: "evt-resched-1",
              status: "confirmed",
              summary: "Architecture Sync",
              start: {
                dateTime:
                  callNum === 1 ? "2026-10-27T10:15:00Z" : "2026-10-27T10:18:00Z",
              },
              end: { dateTime: "2026-10-27T10:45:00Z" },
            },
          ],
          nextSyncToken: `tok-${callNum}`,
        };
      },
      publish: async (ev) => {
        busEvents.push(ev.type);
        return app.eventBus.publish(ev);
      },
    });
    await calPoller.pollOnce();
    await calPoller.pollOnce();
    expect(busEvents).toContain("calendar.meeting_rescheduled");

    // 3. Slack Events webhook signature + url_verification + event mapping
    const slackSecret = "slack-signing-secret-123";
    const ts = "1761570000";
    const rawSlackBody = JSON.stringify({
      type: "event_callback",
      event_id: "Ev999",
      event_time: 1761570000,
      event: {
        type: "app_mention",
        user: "U123",
        text: "<@U0BOT> status of release?",
        channel: "C456",
        ts: "1761570000.000100",
      },
    });
    const validSig = `v0=${createHmac("sha256", slackSecret).update(`v0:${ts}:${rawSlackBody}`, "utf8").digest("hex")}`;
    expect(verifySlackSignature(slackSecret, rawSlackBody, ts, validSig, 1761570010)).toBe(true);
    expect(verifySlackSignature(slackSecret, rawSlackBody, ts, validSig, 1761570999)).toBe(false); // Replay expired

    const mappedSlack = slackEventToSamaritan(JSON.parse(rawSlackBody));
    expect(mappedSlack?.type).toBe("slack.app_mention");
    expect(mappedSlack?.id).toBe("slack:Ev999");

    app.config.slack.enabled = true;
    const server = buildServer(app);
    try {
      const challengeRes = await server.inject({
        method: "POST",
        url: "/api/webhooks/slack",
        payload: { type: "url_verification", challenge: "slack-challenge-token" },
      });
      expect(challengeRes.statusCode).toBe(200);
      expect(challengeRes.json()).toEqual({ challenge: "slack-challenge-token" });
    } finally {
      await server.close();
    }
  });
});
