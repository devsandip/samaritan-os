import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { CapabilityManifest, customAttributesSchema, findEmit } from "../src/types/manifest.js";
import { ActionItemContext, DraftActionItem } from "../src/types/action-item.js";
import { isSettled, SETTLED_STATUSES, UNSETTLED_STATUSES } from "../src/types/common.js";
import { isMoneyLocked, isMoneyLockedExecutionId } from "../src/guardrails.js";

/**
 * Verbatim from TECH-SPEC §4.6. If the spec's own worked example stops
 * validating, either the schema or the spec is wrong and we want to know.
 */
const NEWSLETTER_MANIFEST_YAML = `
id: newsletter-digest
name: Newsletter Digest
description: Reads configured newsletters, summarizes, flags items worth acting on
version: 0.1.0
owner: sandip
enabled: true
entrypoint: index.ts

trigger:
  mode: event
  on: [email.received]
  filter: { from_in: ["@newsletters"] }

context:
  requires: [user.interests, projects.active]
  inputs:   [email.message]
  memory:   [recall]

emits:
  - type: newsletter-digest-review
    render:
      layout: card
      primary: summary
      secondary: top_links
      badges: [relevance_notes]
    custom_attributes:
      summary: string
      top_links: string[]
      relevance_notes: string
      worth_acting: boolean
    responses:
      - { id: file_insight, label: "File to Notion", outcome: execute }
      - { id: open_link,    label: "Open link",      outcome: guided }
      - { id: dismiss,      label: "Dismiss",        outcome: discard }
    execution:
      mode: automated
      capability: notion.insight.create
    policy:
      escalate_when: "worth_acting == true"
      auto_complete_when: "worth_acting == false"
      confidence_threshold: 0.7
    priority: normal
    ttl: null

requires_capabilities:
  - notion.insight.create
  - url.open

delivery:
  channels: [inbox, telegram]
  quiet_hours: "22:00-07:00"

audit: true
timeout_ms: 60000
`;

const newsletter = () => parseYaml(NEWSLETTER_MANIFEST_YAML) as Record<string, unknown>;

/** A minimal valid manifest, for mutating in negative tests. */
function minimal(overrides: Record<string, unknown> = {}) {
  return {
    id: "test-cap",
    name: "Test",
    description: "A test capability",
    version: "0.1.0",
    owner: "sandip",
    trigger: { mode: "manual", command: "/test" },
    emits: [
      {
        type: "test-review",
        render: { layout: "card", primary: "summary" },
        custom_attributes: { summary: "string" },
        responses: [{ id: "ok", label: "OK", outcome: "execute" }],
        execution: { mode: "automated", capability: "notion.insight.create" },
      },
    ],
    requires_capabilities: ["notion.insight.create"],
    ...overrides,
  };
}

describe("CapabilityManifest", () => {
  it("accepts the §4.6 worked example verbatim", () => {
    const parsed = CapabilityManifest.parse(newsletter());
    expect(parsed.id).toBe("newsletter-digest");
    expect(parsed.trigger.mode).toBe("event");
    expect(parsed.emits).toHaveLength(1);

    const emit = findEmit(parsed, "newsletter-digest-review");
    expect(emit?.execution.capability).toBe("notion.insight.create");
    expect(emit?.policy?.confidence_threshold).toBe(0.7);
    expect(emit?.ttl).toBeNull();
  });

  it("applies the documented defaults", () => {
    const parsed = CapabilityManifest.parse(minimal());
    expect(parsed.enabled).toBe(true);
    expect(parsed.entrypoint).toBe("index.ts");
    expect(parsed.audit).toBe(true);
    expect(parsed.timeout_ms).toBe(60_000);
    expect(parsed.emits[0]!.priority).toBe("normal");
    expect(parsed.emits[0]!.ttl).toBeNull();
  });

  describe("trigger requirements", () => {
    it("requires cron when scheduled", () => {
      const r = CapabilityManifest.safeParse(minimal({ trigger: { mode: "scheduled" } }));
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("trigger.cron is required");
    });

    it("requires on[] when event", () => {
      const r = CapabilityManifest.safeParse(minimal({ trigger: { mode: "event", on: [] } }));
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("trigger.on is required");
    });

    it("requires command when manual", () => {
      const r = CapabilityManifest.safeParse(minimal({ trigger: { mode: "manual" } }));
      expect(r.success).toBe(false);
      expect(JSON.stringify(r.error?.issues)).toContain("trigger.command is required");
    });

    it("accepts a scheduled trigger with a cron expression", () => {
      const r = CapabilityManifest.safeParse(
        minimal({ trigger: { mode: "scheduled", cron: "0 20 * * 0" } }),
      );
      expect(r.success).toBe(true);
    });
  });

  it("rejects a render field that is not a declared custom_attribute", () => {
    const m = minimal();
    (m.emits as Record<string, unknown>[])[0]!["render"] = { layout: "card", primary: "nope" };
    const r = CapabilityManifest.safeParse(m);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("not a declared custom_attribute");
  });

  it("rejects an execution target missing from requires_capabilities", () => {
    const r = CapabilityManifest.safeParse(minimal({ requires_capabilities: [] }));
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("must also be listed in requires_capabilities");
  });

  it("rejects duplicate action-item types within one capability", () => {
    const m = minimal();
    const emits = m.emits as Record<string, unknown>[];
    m.emits = [emits[0], structuredClone(emits[0])];
    const r = CapabilityManifest.safeParse(m);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("duplicate action-item type");
  });

  it("rejects duplicate response ids", () => {
    const m = minimal();
    (m.emits as Record<string, unknown>[])[0]!["responses"] = [
      { id: "ok", label: "OK", outcome: "execute" },
      { id: "ok", label: "Also OK", outcome: "discard" },
    ];
    const r = CapabilityManifest.safeParse(m);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("duplicate response id");
  });

  it("rejects a non-semver version", () => {
    expect(CapabilityManifest.safeParse(minimal({ version: "v1" })).success).toBe(false);
  });
});

describe("customAttributesSchema", () => {
  const schema = customAttributesSchema({
    summary: "string",
    top_links: "string[]",
    score: "number",
    worth_acting: "boolean",
  });

  it("accepts a payload matching the declared shape", () => {
    const r = schema.safeParse({
      summary: "s",
      top_links: ["a", "b"],
      score: 3,
      worth_acting: true,
    });
    expect(r.success).toBe(true);
  });

  it("requires every declared attribute, since policy predicates read them", () => {
    const r = schema.safeParse({ summary: "s", top_links: [], score: 1 });
    expect(r.success).toBe(false);
  });

  it("enforces the declared type", () => {
    const r = schema.safeParse({
      summary: "s",
      top_links: "not-an-array",
      score: 1,
      worth_acting: false,
    });
    expect(r.success).toBe(false);
  });

  it("rejects undeclared keys rather than silently dropping them", () => {
    const r = schema.safeParse({
      summary: "s",
      top_links: [],
      score: 1,
      worth_acting: false,
      surprise: "x",
    });
    expect(r.success).toBe(false);
  });
});

describe("DraftActionItem", () => {
  const context = {
    what_happened: 'Read "Weekly Roundup"',
    source: { kind: "email", id: "msg-1", link: "https://mail.example/1" },
    provenance: ["email.received", "newsletter-digest.run"],
    why_flagged: "matches an active project",
    trigger_reason: "value",
    confidence: 0.82,
    decision_needed: "File this as an insight?",
    decision_surface: "inbox",
    execution_surface: "notion",
    outcome_preview: "Creates an Insight row in Notion",
  };

  it("accepts a well-formed draft", () => {
    const r = DraftActionItem.safeParse({
      capability_id: "newsletter-digest",
      type: "newsletter-digest-review",
      context,
      custom: { summary: "s" },
      dedupe_key: "sha256:abc",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a confidence outside 0..1", () => {
    expect(ActionItemContext.safeParse({ ...context, confidence: 1.5 }).success).toBe(false);
  });

  it("rejects an unknown trigger_reason", () => {
    expect(ActionItemContext.safeParse({ ...context, trigger_reason: "vibes" }).success).toBe(false);
  });

  it("rejects an empty dedupe_key, which would collapse every item onto one row", () => {
    const r = DraftActionItem.safeParse({
      capability_id: "c",
      type: "t",
      context,
      custom: {},
      dedupe_key: "",
    });
    expect(r.success).toBe(false);
  });
});

describe("status partitioning", () => {
  it("splits every status into exactly one of settled or unsettled", () => {
    const all = [...SETTLED_STATUSES, ...UNSETTLED_STATUSES];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(9);
  });

  it("treats executed as settled and pending as not", () => {
    expect(isSettled("executed")).toBe(true);
    expect(isSettled("pending")).toBe(false);
    expect(isSettled("awaiting_confirmation")).toBe(false);
  });

  it("treats deferred as unsettled, because a snooze is a pause and not an end", () => {
    // It read as settled once, on the grounds that Sandip had decided something.
    // But the test the partition applies is whether the logical event has run its
    // course, and a snoozed item is explicitly waiting to. Calling it settled sent
    // a re-ingest down the fork-a-fresh-row branch, which orphaned the snoozed row
    // with its defer_until intact and woke it as a duplicate (§5.1).
    expect(isSettled("deferred")).toBe(false);
  });
});

describe("money lock (§9)", () => {
  it("locks payment action types", () => {
    expect(isMoneyLocked("payment.make")).toBe(true);
    expect(isMoneyLocked("payment.schedule")).toBe(true);
    expect(isMoneyLocked("transfer.send")).toBe(true);
    expect(isMoneyLocked("trade.execute")).toBe(true);
  });

  it("leaves ordinary action types alone", () => {
    expect(isMoneyLocked("email.send")).toBe(false);
    expect(isMoneyLocked("note.file")).toBe(false);
    expect(isMoneyLocked("task.create")).toBe(false);
  });

  it("catches a locked namespace anywhere in a provider-first execution id", () => {
    expect(isMoneyLockedExecutionId("stripe.payment.create")).toBe(true);
    expect(isMoneyLockedExecutionId("notion.insight.create")).toBe(false);
  });
});
