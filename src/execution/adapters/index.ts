/**
 * Adapter wiring for v0 (TECH-SPEC §12 step 8).
 *
 * Registration order does not matter; the registry keys by id. What matters is
 * that `guided.fallback` is always present, because §10 degrades any action-item
 * type whose declared target is missing down to guided, and that degradation
 * needs somewhere to land.
 */
import type { Db } from "../../store/db.js";
import type { ExecutionAdapter } from "../../types/index.js";
import type { Registry } from "../registry.js";
import { guidedFallback } from "./guided.js";
import { notionAdapters } from "./notion.js";
import { obsidianNoteAppend, obsidianNoteCreate } from "./obsidian.js";
import { pmOsItemFile } from "./pm-os.js";
import { tickTickTaskCreate } from "./ticktick.js";

export function v0Adapters(db: Db): ExecutionAdapter[] {
  return [
    guidedFallback,
    obsidianNoteCreate,
    obsidianNoteAppend,
    ...notionAdapters(db),
    tickTickTaskCreate,
  ];
}

export function registerV0Adapters(registry: Registry, db: Db): void {
  for (const adapter of v0Adapters(db)) registry.register(adapter);
  // Registered last: it dispatches to the adapters above, so they have to exist
  // by the time it resolves anything.
  registry.register(pmOsItemFile(registry));
}

export { guidedFallback, renderPayload } from "./guided.js";
export { obsidianNoteAppend, obsidianNoteCreate, resolveInVault } from "./obsidian.js";
export { notionAdapters } from "./notion.js";
export { pmOsItemFile, PM_OS_KINDS } from "./pm-os.js";
export { tickTickTaskCreate } from "./ticktick.js";
