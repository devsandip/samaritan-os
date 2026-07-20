/**
 * The capability roster.
 *
 * Each agent claims something in its manifest comment: this one shows policy
 * deciding, this one shows the assisted loop, this one auto-completes, this one
 * gets refused. These tests are those claims, run against the real folder, the
 * real registry, the real Run Layer and the real Action Center.
 *
 * That makes them the demo's regression suite. If a beat here changes, the
 * script in docs/DEMO.md is wrong and this fails before a room finds out.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type App } from "../src/app.js";
import { loadConfig, repoRoot } from "../src/config/index.js";
import { runCapability, type RunReport } from "../src/run-layer/index.js";
import { listActionItems } from "../src/store/action-items.js";

const CAPABILITIES = join(repoRoot(), "capabilities");

let app: App;

beforeEach(() => {
  app = createApp({ dbPath: ":memory:", capabilitiesDir: CAPABILITIES });
});

afterEach(() => app.close());

function fixture(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(CAPABILITIES, id, "fixtures", "demo.json"), "utf8"));
}

/** Runs an agent against its own demo fixture, as `samaritan seed` will. */
async function runWithFixture(id: string): Promise<RunReport> {
  return runCapability(app, id, { inputs: fixture(id) });
}

const folders = readdirSync(CAPABILITIES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
  .map((entry) => entry.name);

/** The agents that ship a fixture and are therefore seedable. */
const SEEDABLE = folders.filter((id) => existsSync(join(CAPABILITIES, id, "fixtures", "demo.json")));

describe("every capability on disk", () => {
  it("loads with no problems", () => {
    expect(app.capabilities.problems()).toEqual([]);
    expect(app.capabilities.all().map((c) => c.manifest.id).sort()).toEqual([...folders].sort());
  });

  it.each(folders)("%s declares an entrypoint that exists", (id) => {
    const manifest = app.capabilities.get(id)!.manifest;
    expect(existsSync(join(CAPABILITIES, id, manifest.entrypoint))).toBe(true);
  });

  it.each(SEEDABLE)("%s runs against its fixture without erroring", async (id) => {
    const report = await runWithFixture(id);
    expect(report.status).toBe("ok");
    // Every emitted item validated against the manifest. A rejection here means
    // the capability and its own manifest have drifted apart.
    expect(report.rejected).toEqual([]);
  });

  it.each(SEEDABLE)("%s handles being run with nothing at all", async (id) => {
    // The Event Bus does not exist yet, so a scheduled run with no inputs is
    // the normal case, not an edge one. It must not throw.
    const report = await runCapability(app, id);
    expect(report.status).toBe("ok");
  });
});

describe("newsletter-digest: policy decides", () => {
  it("escalates the on-topic issue and files the low-signal one, unattended", async () => {
    const report = await runWithFixture("newsletter-digest");

    const statuses = report.accepted.map((a) => a.status).sort();
    expect(statuses).toEqual(["executed", "pending"]);
  });

  it("routes the two outcomes to different destinations", async () => {
    await runWithFixture("newsletter-digest");
    const items = listActionItems(app.db, { capability_id: "newsletter-digest" });

    const escalated = items.find((i) => i.status === "pending")!;
    const filed = items.find((i) => i.status === "executed")!;

    // `kind` is what pm-os.item.file dispatches on, so this one field decides
    // whether approving reaches Notion or stays in the vault.
    expect(escalated.custom["kind"]).toBe("insight");
    expect(escalated.custom["worth_acting"]).toBe(true);
    expect(filed.custom["kind"]).toBe("note");
    expect(filed.custom["worth_acting"]).toBe(false);
  });

  it("writes the auto-filed one to the vault for real", async () => {
    await runWithFixture("newsletter-digest");
    const daily = join(loadConfig().paths.vault, "Areas", "Daily");
    const notes = readdirSync(daily);
    expect(notes.length).toBeGreaterThan(0);
    expect(readFileSync(join(daily, notes[0]!), "utf8")).toContain("Coffee futures");
  });
});

describe("email-triage: the assisted loop", () => {
  it("surfaces only the message with a direct ask", async () => {
    const report = await runWithFixture("email-triage");
    // Three messages in, one item out. Deciding what not to surface is the
    // capability's first job, not a gap in its coverage.
    expect(report.accepted).toHaveLength(1);
  });

  it("degrades to guided because no Gmail adapter exists", () => {
    const type = app.capabilities.getType("email-triage", "email-reply-review")!;
    expect(type.spec.execution.mode).toBe("assisted");
    expect(type.effectiveMode).toBe("guided");
    expect(type.degradedReason).toMatch(/gmail\.draft\.create/);
  });

  it("stages on approve and only reaches executed on confirm", async () => {
    const report = await runWithFixture("email-triage");
    const id = report.accepted[0]!.id;

    const approved = await app.actionCenter.respond(id, {
      response_id: "send_reply",
      actor: "sandip",
      edited_payload: { draft_body: "Hi Priya,\n\nSlides 8-11 hold up.\n\nSandip" },
    });
    // Not executed. Nothing has been sent, and saying otherwise would be the
    // one lie this whole state exists to prevent.
    expect(approved.status).toBe("awaiting_confirmation");

    const confirmed = await app.actionCenter.confirm(id, { actor: "sandip" });
    expect(confirmed.status).toBe("executed");
  });

  it("carries the edit into what was staged", async () => {
    const report = await runWithFixture("email-triage");
    const id = report.accepted[0]!.id;
    await app.actionCenter.respond(id, {
      response_id: "send_reply",
      actor: "sandip",
      edited_payload: { draft_body: "EDITED BODY" },
    });

    const row = app.db
      .prepare<{ guided_instructions: string }>(
        "SELECT guided_instructions FROM executions WHERE action_item_id = ?",
      )
      .get(id);
    expect(row?.guided_instructions).toContain("EDITED BODY");
  });
});

describe("weekly-digest: auto-completes", () => {
  it("never reaches the Inbox", async () => {
    const report = await runWithFixture("weekly-digest");
    expect(report.accepted).toHaveLength(1);
    expect(report.accepted[0]!.status).toBe("executed");
  });

  it("writes the note it said it would", async () => {
    await runWithFixture("weekly-digest");
    const items = listActionItems(app.db, { capability_id: "weekly-digest" });
    const path = items[0]!.custom["path"] as string;

    const written = readFileSync(join(loadConfig().paths.vault, path), "utf8");
    expect(written).toContain("### Decided");
    expect(written).toContain("Use node:sqlite instead of better-sqlite3");
  });

  it("derives stuck items rather than being told about them", async () => {
    await runWithFixture("weekly-digest");
    const item = listActionItems(app.db, { capability_id: "weekly-digest" })[0]!;

    // The fixture's one unresolved decision, and the next-week item derived
    // from it. Neither is stated anywhere in the fixture.
    expect(item.custom["stuck"]).toEqual([
      "Whether the middle pricing tier stays usage-based (Northwind) — still pending",
    ]);
    expect(item.custom["next_week"]).toEqual([
      "Unblock: Whether the middle pricing tier stays usage-based (Northwind)",
    ]);
  });

  it("says so when the week was empty instead of padding it", async () => {
    const report = await runCapability(app, "weekly-digest");
    expect(report.accepted).toHaveLength(1);
    const item = listActionItems(app.db, { capability_id: "weekly-digest" })[0]!;
    expect(item.custom["headline"]).toBe("a quiet week, nothing to report");
  });
});

describe("subscription-watch: refused", () => {
  it("escalates every item despite asking to auto-complete", async () => {
    const type = app.capabilities.getType("subscription-watch", "renewal-review")!;
    // The manifest really does ask. That is the point of the test.
    expect(type.spec.policy?.auto_complete_when).toBe("true");
    expect(type.spec.execution.mode).toBe("automated");

    const report = await runWithFixture("subscription-watch");
    expect(report.accepted.length).toBeGreaterThan(0);
    expect(report.accepted.every((a) => a.status === "pending")).toBe(true);
  });

  it("filters renewals outside the horizon before an item exists", async () => {
    const report = await runWithFixture("subscription-watch");
    expect(report.logs.some((line) => line.includes("outside the 14-day horizon"))).toBe(true);
    expect(report.accepted).toHaveLength(3);
  });

  it("still refuses to pay after an explicit approval", async () => {
    const report = await runWithFixture("subscription-watch");
    const id = report.accepted[0]!.id;

    const approved = await app.actionCenter.respond(id, {
      response_id: "let_it_renew",
      actor: "sandip",
    });
    expect(approved.status).toBe("awaiting_confirmation");

    const row = app.db
      .prepare<{ capability: string; mode: string }>(
        "SELECT capability, mode FROM executions WHERE action_item_id = ?",
      )
      .get(id);
    expect(row?.mode).toBe("guided");
    expect(row?.capability).toBe("guided.fallback");
  });

  it("keeps payment.make locked against the routing API", () => {
    const entry = app.routing.list().find((r) => r.action_type === "payment.make");
    expect(entry?.locked).toBe(true);
    expect(() => app.routing.update("payment.make", { mode: "automated" })).toThrow();
  });
});

describe("what the Inbox promises before you decide", () => {
  it("shows a money-locked item as guided, not automated", async () => {
    // The manifest declares automated and the adapter is registered, so the
    // item used to be stored as automated and the card read "Automated — on
    // approve, this is filed directly". On the one action the system can never
    // automate. Routing decides this, and now it decides it at ingest too.
    await runWithFixture("subscription-watch");
    const items = listActionItems(app.db, { capability_id: "subscription-watch" });

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.execution.mode).toBe("guided");
  });

  it("matches what dispatch actually does", async () => {
    const report = await runWithFixture("subscription-watch");
    const id = report.accepted[0]!.id;
    const promised = listActionItems(app.db, { capability_id: "subscription-watch" }).find(
      (i) => i.id === id,
    )!.execution.mode;

    await app.actionCenter.respond(id, { response_id: "let_it_renew", actor: "sandip" });
    const row = app.db
      .prepare<{ mode: string }>("SELECT mode FROM executions WHERE action_item_id = ?")
      .get(id);

    // The promise and the outcome are the same string. That is the assertion.
    expect(row?.mode).toBe(promised);
  });

  it("does not let routing promote past what the manifest asked for", async () => {
    // note.file routes to automated, but wrap's items declare no action_type,
    // so nothing here should be able to raise a type above its own ceiling.
    await runWithFixture("email-triage");
    const item = listActionItems(app.db, { capability_id: "email-triage" })[0]!;
    expect(item.execution.mode).toBe("guided");
  });
});
