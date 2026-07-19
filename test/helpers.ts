import { openDatabase, type Db } from "../src/store/db.js";
import { migrate } from "../src/store/migrate.js";
import type { ActionItemContext, ActionItemExecution } from "../src/types/index.js";
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
