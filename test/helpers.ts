import { join } from "node:path";
import { vi } from "vitest";
import { ActionCenter } from "../src/action-center/index.js";
import { repoRoot } from "../src/config/index.js";
import { registerV0Adapters } from "../src/execution/adapters/index.js";
import { Registry as ExecutionRegistry } from "../src/execution/registry.js";
import { CapabilityRegistry } from "../src/registry/index.js";
import { loadRoutingFile, RoutingResolver } from "../src/routing/index.js";
import { openDatabase, type Db } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";
import type {
  ActionItemContext,
  ActionItemExecution,
  ExecutionAdapter,
} from "../src/types/index.js";
import type { CreateActionItemInput } from "../src/store/action-items.js";

/** A migrated in-memory Action Store with one registered capability. */
export function testStore(capabilityId = "test-cap"): Db {
  const db = openDatabase(":memory:");
  migrate(db);
  db.prepare(
    `INSERT INTO capabilities (id, name, version, manifest_json, registered_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(capabilityId, "Test Capability", "0.1.0", "{}", new Date().toISOString());
  return db;
}

export function testContext(overrides: Partial<ActionItemContext> = {}): ActionItemContext {
  return {
    what_happened: "Wrapped a working session",
    source: { kind: "session", id: "sess-1" },
    provenance: ["wrap.run"],
    why_flagged: "extraction always gets a review gate",
    trigger_reason: "action_type",
    confidence: 0.8,
    decision_needed: "File this decision to Notion?",
    decision_surface: "inbox",
    execution_surface: "notion",
    outcome_preview: "Creates a Decision row in Notion",
    ...overrides,
  };
}

export function testExecution(overrides: Partial<ActionItemExecution> = {}): ActionItemExecution {
  return {
    mode: "automated",
    capability: "notion.decision.create",
    payload: { title: "Use SQLite" },
    ...overrides,
  };
}

export function testDraft(
  overrides: Partial<CreateActionItemInput> = {},
): CreateActionItemInput {
  return {
    capability_id: "test-cap",
    type: "wrap-item-review",
    context: testContext(),
    custom: { title: "Use SQLite", kind: "decision" },
    dedupe_key: "sha256:abc",
    responses: ["approve", "reject"],
    execution: testExecution(),
    ...overrides,
  };
}

/** A `wrap-item-review` draft shaped as the real wrap manifest declares it. */
export function wrapItem(overrides: Record<string, unknown> = {}) {
  return {
    type: "wrap-item-review",
    context: {
      what_happened: "Wrapped a session about the storage layer",
      source: { kind: "session", id: "sess-2026-07-19" },
      provenance: ["wrap.run"],
      why_flagged: "extraction always gets a review gate",
      trigger_reason: "action_type",
      confidence: 0.91,
      decision_needed: "File this decision?",
      decision_surface: "inbox",
      execution_surface: "notion",
      outcome_preview: "Creates a Decision row in Notion",
    },
    custom: {
      kind: "decision",
      title: "Use node:sqlite instead of better-sqlite3",
      detail: "No prebuilt binary for Node 26",
      project: "Samaritan",
      owner: "",
      due: "",
      evidence: "pnpm refused to run the build script",
    },
    dedupe_key: "wrap:sess-2026-07-19:0",
    ...overrides,
  };
}

/** Records every filing attempt so a test can assert nothing was written. */
export function spyAdapter(id: string): ExecutionAdapter & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return {
    id,
    provider: "spy",
    description: `spy for ${id}`,
    modes: ["automated", "assisted", "guided"],
    calls,
    async execute(request) {
      calls.push(request.payload);
      return { status: "succeeded", result: { notion_row_id: `row-${calls.length}` } };
    },
    async verify() {
      return "connected";
    },
  };
}

export interface Harness {
  db: Db;
  actionCenter: ActionCenter;
  capabilities: CapabilityRegistry;
  notionDecision: ReturnType<typeof spyAdapter>;
  notionInsight: ReturnType<typeof spyAdapter>;
}

export interface HarnessOptions
  extends Partial<ConstructorParameters<typeof ActionCenter>[0]> {
  /**
   * Where manifests are loaded from. Defaults to the repo's real `capabilities/`.
   * Point it at a copy to test what happens when one goes away mid-flight.
   */
  capabilitiesDir?: string;
}

/**
 * A full Action Center wired to the real `capabilities/` folder, with the Notion
 * adapters swapped for spies. Loading the real manifests is the point: a test
 * that invented its own would not notice a manifest drifting from what the code
 * expects.
 */
export function harness({ capabilitiesDir, ...deps }: HarnessOptions = {}): Harness {
  const db = openDatabase(":memory:");
  migrate(db);

  const execution = new ExecutionRegistry(db);
  registerV0Adapters(execution, db);

  // The registry refuses duplicate ids, so stub the registered instance rather
  // than registering a second one.
  const notionDecision = spyAdapter("notion.decision.create");
  const notionInsight = spyAdapter("notion.insight.create");
  for (const spy of [notionDecision, notionInsight]) {
    const real = execution.get(spy.id)!;
    vi.spyOn(real, "execute").mockImplementation(spy.execute.bind(spy));
  }

  const routing = new RoutingResolver(db);
  routing.setOverrides(loadRoutingFile(db, join(repoRoot(), "routing.yaml")));

  const capabilities = new CapabilityRegistry({
    db,
    capabilitiesDir: capabilitiesDir ?? join(repoRoot(), "capabilities"),
    executionCatalogue: execution,
  });
  capabilities.reload();

  return {
    db,
    actionCenter: new ActionCenter({ db, capabilities, execution, routing, ...deps }),
    capabilities,
    notionDecision,
    notionInsight,
  };
}
