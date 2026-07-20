/**
 * The Run Layer (TECH-SPEC §5.2, §10).
 *
 * These tests write real capability folders to a temp dir and let the runner
 * import them, rather than injecting a fake entrypoint. The dynamic import is
 * most of what this module does — the resolution, the type stripping, the
 * module cache — so stubbing it would leave the interesting part untested.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCapability } from "../src/run-layer/index.js";
import { harness, testContext } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(id: string, extra = ""): string {
  return `id: ${id}
name: Test ${id}
description: A capability written by the run-layer tests.
version: 0.1.0
owner: test
entrypoint: index.ts
trigger:
  mode: manual
  command: /${id}
emits:
  - type: ${id}-review
    render: { layout: card, primary: title }
    custom_attributes: { title: string }
    responses:
      - { id: approve, label: File it, outcome: execute }
    execution: { mode: guided, capability: guided.fallback }
    policy: { escalate_when: "true" }
requires_capabilities: [guided.fallback]
${extra}`;
}

/** Writes a capability folder and returns a harness pointed at its parent. */
function capability(id: string, entrypoint: string, extra = "") {
  const root = mkdtempSync(join(tmpdir(), "samaritan-run-"));
  roots.push(root);
  mkdirSync(join(root, id));
  writeFileSync(join(root, id, "manifest.yaml"), manifest(id, extra));
  writeFileSync(join(root, id, "index.ts"), entrypoint);

  const h = harness({ capabilitiesDir: root });
  return { ...h, root, path: join(root, id, "index.ts") };
}

/** A draft the ingest pipeline will accept, as a capability would build it. */
const DRAFT = (id: string, key = "k1") =>
  JSON.stringify({
    type: `${id}-review`,
    context: testContext({ execution_surface: "guided" }),
    custom: { title: "A thing worth reviewing" },
    dedupe_key: key,
  });

describe("running a capability", () => {
  it("imports the entrypoint and ingests what run() returns", async () => {
    const cap = capability(
      "returner",
      `export async function run(ctx) {
         return { action_items: [${DRAFT("returner")}], status: "ok", logs: ["done"] };
       }`,
    );

    const report = await runCapability(cap, "returner");

    expect(report.status).toBe("ok");
    expect(report.accepted).toHaveLength(1);
    expect(report.accepted[0]!.status).toBe("pending");
    expect(report.logs).toEqual(["done"]);
    expect(report.rejected).toEqual([]);
  });

  it("ingests through ctx.emit() as well", async () => {
    const cap = capability(
      "emitter",
      `export async function run(ctx) {
         const result = await ctx.emit([${DRAFT("emitter")}]);
         return { action_items: [], status: "ok", logs: ["emitted " + result.accepted.length] };
       }`,
    );

    const report = await runCapability(cap, "emitter");

    expect(report.status).toBe("ok");
    expect(report.logs).toEqual(["emitted 1"]);
    // Emitted items ingest during the run, so they are not in the report's
    // accepted list — that covers the returned batch. The store is the truth.
    const rows = cap.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM action_items").get();
    expect(rows?.n).toBe(1);
  });

  it("does not duplicate an item that is both emitted and returned", async () => {
    // The two routes into ingest are documented as safe to combine because the
    // upsert keys on (capability_id, dedupe_key). If that ever stops being
    // true, a capability author's reasonable code silently doubles every item.
    const cap = capability(
      "both",
      `export async function run(ctx) {
         const item = ${DRAFT("both", "same-key")};
         await ctx.emit([item]);
         return { action_items: [item], status: "ok", logs: [] };
       }`,
    );

    await runCapability(cap, "both");

    const rows = cap.db.prepare<{ n: number }>("SELECT COUNT(*) AS n FROM action_items").get();
    expect(rows?.n).toBe(1);
  });

  it("reports a capability that says it failed", async () => {
    const cap = capability(
      "sad",
      `export async function run() { return { action_items: [], status: "error", logs: ["nope"] }; }`,
    );

    const report = await runCapability(cap, "sad");
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/status: error/);
  });

  it("records the outcome on the capabilities row", async () => {
    const cap = capability("telemetry", `export async function run() {
      return { action_items: [], status: "ok", logs: [] };
    }`);

    await runCapability(cap, "telemetry");

    const row = cap.db
      .prepare<{ last_run_at: string | null; last_run_status: string | null }>(
        "SELECT last_run_at, last_run_status FROM capabilities WHERE id = ?",
      )
      .get("telemetry");
    expect(row?.last_run_status).toBe("ok");
    expect(row?.last_run_at).toBeTruthy();
  });

  it("picks up an edited entrypoint rather than serving the cached module", async () => {
    // Node caches ES modules by URL forever. Without the mtime buster, editing
    // a capability and re-running it would keep running the old code, which is
    // exactly the loop a capability author works in.
    const cap = capability("edited", `export async function run() {
      return { action_items: [], status: "ok", logs: ["first"] };
    }`);

    expect((await runCapability(cap, "edited")).logs).toEqual(["first"]);

    writeFileSync(
      cap.path,
      `export async function run() { return { action_items: [], status: "ok", logs: ["second"] }; }`,
    );
    expect((await runCapability(cap, "edited")).logs).toEqual(["second"]);
  });
});

describe("isolation", () => {
  it("catches a throwing entrypoint instead of propagating", async () => {
    const cap = capability("thrower", `export async function run() { throw new Error("boom"); }`);

    const report = await runCapability(cap, "thrower");
    expect(report.status).toBe("error");
    expect(report.error).toBe("boom");

    const row = cap.db
      .prepare<{ last_run_status: string }>("SELECT last_run_status FROM capabilities WHERE id = ?")
      .get("thrower");
    expect(row?.last_run_status).toBe("error");
  });

  it("stops waiting on a run that exceeds timeout_ms", async () => {
    const cap = capability(
      "hanger",
      `export function run() { return new Promise(() => {}); }`,
      "timeout_ms: 50\n",
    );

    const report = await runCapability(cap, "hanger");
    expect(report.status).toBe("timeout");
    expect(report.error).toMatch(/timeout_ms of 50/);
  });

  it("explains a missing entrypoint file", async () => {
    const cap = capability("gone", `export async function run() {}`);
    rmSync(cap.path);

    const report = await runCapability(cap, "gone");
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/not found/);
    expect(report.error).toMatch(/new-capability/);
  });

  it("explains an entrypoint with no run export", async () => {
    const cap = capability("wrong", `export const notRun = 1;`);

    const report = await runCapability(cap, "wrong");
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/does not export a "run" function/);
    expect(report.error).toMatch(/notRun/);
  });

  it("reports a syntax error in the entrypoint without crashing", async () => {
    const cap = capability("broken", `export async function run( {{{`);

    const report = await runCapability(cap, "broken");
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/failed to load/);
  });

  it("rejects an unknown capability", async () => {
    const cap = capability("known", `export async function run() {}`);

    const report = await runCapability(cap, "nope");
    expect(report.status).toBe("error");
    expect(report.error).toMatch(/unknown capability/);
  });
});

describe("the manifest's declarations", () => {
  it("skips a disabled capability unless forced", async () => {
    const cap = capability(
      "off",
      `export async function run() { return { action_items: [], status: "ok", logs: ["ran"] }; }`,
      "enabled: false\n",
    );

    expect((await runCapability(cap, "off")).status).toBe("skipped");
    expect((await runCapability(cap, "off", { force: true })).logs).toEqual(["ran"]);
  });

  it("reports declared inputs that were not supplied", async () => {
    const cap = capability(
      "hungry",
      `export async function run() { return { action_items: [], status: "ok", logs: [] }; }`,
      "context:\n  inputs: [email.message, calendar.event]\n",
    );

    const report = await runCapability(cap, "hungry", {
      inputs: { "email.message": { subject: "hi" } },
    });
    expect(report.missing_inputs).toEqual(["calendar.event"]);
  });

  it("hands recall a function that explains itself when the pipeline is unbuilt", async () => {
    const cap = capability(
      "asker",
      `export async function run(ctx) {
         try {
           await ctx.memory.recall("why?");
           return { action_items: [], status: "ok", logs: ["recalled"] };
         } catch (err) {
           return { action_items: [], status: "ok", logs: [err.message] };
         }
       }`,
      "context:\n  memory: [recall]\n",
    );

    const report = await runCapability(cap, "asker");
    expect(report.logs[0]).toMatch(/Recall query.*not built yet/);
  });

  it("leaves memory.recall undefined when the manifest does not declare it", async () => {
    const cap = capability(
      "quiet",
      `export async function run(ctx) {
         return { action_items: [], status: "ok", logs: [String(ctx.memory.recall)] };
       }`,
    );

    expect((await runCapability(cap, "quiet")).logs).toEqual(["undefined"]);
  });
});
