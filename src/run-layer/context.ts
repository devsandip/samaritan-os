/**
 * The Run Layer's half of the capability contract (TECH-SPEC §5.2).
 *
 * A capability is a folder with a manifest and an entrypoint exporting
 * `run(context)`. This file defines what that context is and builds one. The
 * runner in `./index.ts` is what calls it.
 *
 * The point of the indirection is that a capability author writes the same
 * `run()` whether the Run Layer invokes it in-process or a Claude scheduled
 * task shells out to the CLI. In-process `emit` is a direct call into the
 * Action Center; out-of-process it POSTs to the same ingest endpoint (§8). The
 * capability cannot tell the difference and must not need to.
 */
import type { IngestResult } from "../action-center/index.js";
import type { CapabilityManifest, DraftActionItem, RunMode } from "../types/index.js";

/** §5.5's answer shape. Declared here so capabilities need not import Recall. */
export interface RecallAnswer {
  answer: string;
  citations: { kind: string; ref: string; excerpt?: string }[];
  retrieval_path: "structured" | "semantic" | "hybrid";
}

export interface RunTrigger {
  mode: RunMode;
  firedAt: string;
  payload?: unknown;
}

export interface RunContext {
  capability_id: string;
  trigger: RunTrigger;
  /** Resolved from `manifest.context.inputs`. Absent keys are reported, not fatal. */
  inputs: Record<string, unknown>;
  memory: { recall?: (question: string) => Promise<RecallAnswer> };
  /**
   * §5.2 types this `Promise<void>`; it returns the ingest result instead so a
   * capability can see what its own emission did. Returning more than the
   * contract promises is safe for callers that ignore it, and a capability that
   * emits blind cannot log anything useful about rejections.
   */
  emit: (items: DraftActionItem[]) => Promise<IngestResult>;
}

export interface RunResult {
  action_items: DraftActionItem[];
  status: "ok" | "error";
  logs: string[];
}

export type CapabilityEntrypoint = (context: RunContext) => Promise<RunResult>;

/** What the Action Center exposes to the Run Layer. Narrow so tests need not build one. */
export interface Ingestor {
  ingest(capabilityId: string, drafts: unknown[]): Promise<IngestResult>;
}

export interface BuildContextOptions {
  manifest: CapabilityManifest;
  ingestor: Ingestor;
  trigger: RunTrigger;
  inputs?: Record<string, unknown>;
  recall?: (question: string) => Promise<RecallAnswer>;
}

export interface BuiltContext {
  context: RunContext;
  /**
   * Drafts passed to `ctx.emit()` during the run, in call order. The runner
   * reports these separately from `RunResult.action_items` so "the capability
   * emitted five and returned none" is distinguishable from the reverse.
   */
  emitted: DraftActionItem[];
  /** Declared in `manifest.context.inputs` but not supplied. */
  missingInputs: string[];
}

/**
 * Binds a context for one run.
 *
 * `emit` and the returned `RunResult.action_items` are two routes to the same
 * place, and a capability may legitimately use both — §4.6's worked example
 * returns items, §5.2's signature offers emit. Using both does not duplicate:
 * ingest upserts on `(capability_id, dedupe_key)` (§10), so the same logical
 * item arriving twice is one row. That is the existing idempotency guarantee
 * doing its job rather than a rule capability authors have to remember.
 */
export function buildRunContext(options: BuildContextOptions): BuiltContext {
  const { manifest, ingestor, trigger } = options;
  const supplied = options.inputs ?? {};

  const declaredInputs = manifest.context?.inputs ?? [];
  const missingInputs = declaredInputs.filter((key) => !(key in supplied));

  const emitted: DraftActionItem[] = [];

  const memory: RunContext["memory"] = {};
  if (manifest.context?.memory?.includes("recall")) {
    // Declared but unwired is the common case today: §7's index exists, its
    // query pipeline does not. Throwing with the reason beats handing over an
    // undefined that crashes somewhere less informative.
    memory.recall =
      options.recall ??
      (async () => {
        throw new Error(
          `"${manifest.id}" declares context.memory: [recall], but the Recall query ` +
            `pipeline is not built yet (TECH-SPEC §7). Remove the declaration or ` +
            `run the capability with a recall provider.`,
        );
      });
  }

  const context: RunContext = {
    capability_id: manifest.id,
    trigger,
    inputs: supplied,
    memory,
    emit: async (items) => {
      // Recorded before ingest, so a throw mid-ingest still shows what was
      // attempted. The run report is a debugging surface first.
      emitted.push(...items);
      return ingestor.ingest(manifest.id, items);
    },
  };

  return { context, emitted, missingInputs };
}
