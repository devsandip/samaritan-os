/**
 * Capability Manifest (TECH-SPEC §4.1).
 *
 * The manifest is the whole pluggability story: a capability is a folder holding
 * this file plus an entrypoint. The registry validates it with these schemas and
 * persists it into the `capabilities` table, which every other component then
 * reads as the source of truth (§2.2).
 */
import { z } from "zod";
import { CONTEXT_VARIABLE_NAMES } from "./action-item.js";
import {
  CatchUpMode,
  ExecutionCapabilityId,
  ExecutionMode,
  KebabId,
  Priority,
  RenderLayout,
  ResponseOutcome,
  RunMode,
  isDuration,
} from "./common.js";
import { isValidCron } from "../scheduler/cron.js";

export const TriggerSpec = z
  .object({
    mode: RunMode,
    /**
     * Required when mode is "scheduled". Validated as a real five-field cron at
     * load, not just a non-empty string: a malformed cron that only failed when
     * the scheduler tried to parse it would be a capability that silently never
     * fires, discovered at 2am rather than at registration.
     */
    cron: z
      .string()
      .min(1)
      .refine(isValidCron, "must be a valid five-field cron expression")
      .optional(),
    /**
     * What to do about a scheduled run missed while the daemon was down (§11).
     * Only meaningful for scheduled triggers; the scheduler treats an absent
     * value as "skip".
     */
    catch_up: CatchUpMode.optional(),
    /** Required when mode is "event", e.g. ["email.received"]. */
    on: z.array(z.string().min(1)).optional(),
    filter: z.record(z.string(), z.unknown()).optional(),
    /** Required when mode is "manual", e.g. "/newsletter". */
    command: z.string().min(1).optional(),
  })
  .superRefine((spec, ctx) => {
    const require = (field: "cron" | "on" | "command", mode: string) => {
      const value = spec[field];
      const missing = value === undefined || (Array.isArray(value) && value.length === 0);
      if (missing) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `trigger.${field} is required when trigger.mode is "${mode}"`,
        });
      }
    };
    if (spec.mode === "scheduled") require("cron", "scheduled");
    if (spec.mode === "event") require("on", "event");
    if (spec.mode === "manual") require("command", "manual");

    // catch_up governs a missed cron fire, so it means nothing without a cron.
    // Rejecting it elsewhere keeps a manual capability from carrying a field that
    // reads as configured and never does anything.
    if (spec.catch_up !== undefined && spec.mode !== "scheduled") {
      ctx.addIssue({
        code: "custom",
        path: ["catch_up"],
        message: `trigger.catch_up is only meaningful when trigger.mode is "scheduled"`,
      });
    }
  });
export type TriggerSpec = z.infer<typeof TriggerSpec>;

/** The four attribute types a capability may declare on an action-item type. */
export const CustomAttributeType = z.enum(["string", "string[]", "number", "boolean"]);
export type CustomAttributeType = z.infer<typeof CustomAttributeType>;

export const RenderSpec = z.object({
  layout: RenderLayout,
  /** Field names drawn from custom_attributes. Cross-checked below. */
  primary: z.string().optional(),
  secondary: z.string().optional(),
  badges: z.array(z.string()).optional(),
});
export type RenderSpec = z.infer<typeof RenderSpec>;

export const ResponseSpec = z
  .object({
    id: KebabId,
    label: z.string().min(1),
    outcome: ResponseOutcome,
    /**
     * How long this response snoozes the item, e.g. "1d". The label alone is not
     * machine-readable ("Snooze 1 day" is prose), so the resurface time comes
     * from here; the Action Center falls back to its default when unset.
     */
    defer_for: z.string().refine(isDuration, 'must be a duration like "1d"').optional(),
  })
  .superRefine((spec, ctx) => {
    // A defer_for on a non-defer response would silently never fire, which reads
    // at a glance like a snooze that is configured and simply broken.
    if (spec.defer_for !== undefined && spec.outcome !== "defer") {
      ctx.addIssue({
        code: "custom",
        path: ["defer_for"],
        message: `defer_for is only meaningful on outcome "defer", not "${spec.outcome}"`,
      });
    }
  });
export type ResponseSpec = z.infer<typeof ResponseSpec>;

export const PolicySpec = z.object({
  /** Predicate over the flat variable map defined in §5.6. */
  escalate_when: z.string().min(1).optional(),
  auto_complete_when: z.string().min(1).optional(),
  confidence_threshold: z.number().min(0).max(1).optional(),
});
export type PolicySpec = z.infer<typeof PolicySpec>;

export const ActionItemTypeSpec = z
  .object({
    /** Unique within the capability. */
    type: KebabId,
    render: RenderSpec,
    custom_attributes: z.record(z.string().min(1), CustomAttributeType),
    responses: z.array(ResponseSpec).min(1),
    execution: z.object({
      mode: ExecutionMode,
      capability: ExecutionCapabilityId,
      /**
       * The abstract action type this execution represents, e.g. "note.file".
       * When set, the Routing resolver decides the concrete provider/account/
       * mode and may override `capability` per §5.4. When absent, the declared
       * capability and mode are used directly, which is what most v0 types do.
       */
      action_type: z
        .string()
        .regex(/^[a-z0-9]+(?:\.[a-z0-9_]+)+$/, "must be a dotted action type like note.file")
        .optional(),
    }),
    policy: PolicySpec.optional(),
    priority: Priority.default("normal"),
    /** e.g. "24h". Null means the item never expires. */
    ttl: z.string().nullable().default(null),
  })
  .superRefine((spec, ctx) => {
    const declared = new Set(Object.keys(spec.custom_attributes));

    // §5.6 merges context fields and custom attributes into one flat predicate
    // scope. A custom attribute named `confidence` would make it ambiguous which
    // one `confidence_threshold` reads, so shadowing is rejected outright rather
    // than resolved by a precedence rule nobody would remember.
    for (const name of CONTEXT_VARIABLE_NAMES) {
      if (declared.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["custom_attributes", name],
          message: `"${name}" is a reserved context variable and cannot be a custom_attribute`,
        });
      }
    }

    // A render spec pointing at a field that does not exist would render blank
    // at review time, which is exactly when a silent failure is most expensive.
    const referenced: [string, string | undefined][] = [
      ["primary", spec.render.primary],
      ["secondary", spec.render.secondary],
      ...(spec.render.badges ?? []).map((b, i) => [`badges[${i}]`, b] as [string, string]),
    ];
    for (const [path, field] of referenced) {
      if (field !== undefined && !declared.has(field)) {
        ctx.addIssue({
          code: "custom",
          path: ["render", ...path.split(/[[\]]/).filter(Boolean)],
          message: `render.${path} references "${field}", which is not a declared custom_attribute`,
        });
      }
    }

    const ids = spec.responses.map((r) => r.id);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) {
      ctx.addIssue({
        code: "custom",
        path: ["responses"],
        message: `duplicate response id "${duplicate}"`,
      });
    }
  });
export type ActionItemTypeSpec = z.infer<typeof ActionItemTypeSpec>;

export const CapabilityManifest = z
  .object({
    id: KebabId,
    name: z.string().min(1),
    description: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+].*)?$/, "must be semver"),
    owner: z.string().min(1),
    enabled: z.boolean().default(true),
    /** Path relative to capabilities/<id>/, e.g. "index.ts". */
    entrypoint: z.string().min(1).default("index.ts"),

    trigger: TriggerSpec,
    context: z
      .object({
        /** Context keys the OS injects into RunContext. */
        requires: z.array(z.string().min(1)).optional(),
        /** Payload types consumed in event mode. */
        inputs: z.array(z.string().min(1)).optional(),
        memory: z.array(z.enum(["recall"])).optional(),
      })
      .optional(),
    emits: z.array(ActionItemTypeSpec).min(1),
    /** Execution-registry ids. Missing ones degrade that type to guided (§10). */
    requires_capabilities: z.array(ExecutionCapabilityId).default([]),
    delivery: z
      .object({
        channels: z.array(z.enum(["inbox", "telegram"])).default(["inbox"]),
        quiet_hours: z
          .string()
          .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, 'must look like "22:00-07:00"')
          .optional(),
      })
      .optional(),
    audit: z.boolean().default(true),
    timeout_ms: z.number().int().positive().default(60_000),
  })
  .superRefine((manifest, ctx) => {
    const types = manifest.emits.map((e) => e.type);
    const duplicate = types.find((t, i) => types.indexOf(t) !== i);
    if (duplicate) {
      ctx.addIssue({
        code: "custom",
        path: ["emits"],
        message: `duplicate action-item type "${duplicate}" (types must be unique within a capability)`,
      });
    }

    // requires_capabilities is what the registry cross-checks against the
    // Execution Registry, so an execution target missing from it would skip that
    // check and fail at execute() time instead of at load time.
    const declared = new Set(manifest.requires_capabilities);
    for (const [i, emit] of manifest.emits.entries()) {
      if (!declared.has(emit.execution.capability)) {
        ctx.addIssue({
          code: "custom",
          path: ["emits", i, "execution", "capability"],
          message: `"${emit.execution.capability}" must also be listed in requires_capabilities`,
        });
      }
    }
  });
export type CapabilityManifest = z.infer<typeof CapabilityManifest>;

export function findEmit(
  manifest: CapabilityManifest,
  type: string,
): ActionItemTypeSpec | undefined {
  return manifest.emits.find((e) => e.type === type);
}

/**
 * Builds the runtime validator for an action-item type's `custom` payload from
 * its declared `custom_attributes` (§5.1, §8).
 *
 * Every declared attribute is required: §5.6 evaluates policy predicates over
 * the declared attributes, and a predicate cannot reference a variable that is
 * not on the item. Undeclared keys are rejected rather than stripped, so a
 * capability that drifts from its manifest fails loudly at ingest and lands in
 * the `rejected[]` array of the POST /api/actions response.
 */
export function customAttributesSchema(
  attributes: Record<string, CustomAttributeType>,
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, type] of Object.entries(attributes)) {
    shape[name] =
      type === "string"
        ? z.string()
        : type === "string[]"
          ? z.array(z.string())
          : type === "number"
            ? z.number()
            : z.boolean();
  }
  return z.strictObject(shape);
}
