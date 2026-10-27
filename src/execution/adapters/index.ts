/**
 * Adapter wiring for v0 (TECH-SPEC §12 step 8).
 *
 * Registration order does not matter; the registry keys by id. What matters is
 * that `guided.fallback` is always present, because §10 degrades any action-item
 * type whose declared target is missing down to guided, and that degradation
 * needs somewhere to land.
 */
import { loadConfig } from "../../config/index.js";
import { getSecret } from "../../secrets.js";
import type { Db } from "../../store/db.js";
import type { ExecutionAdapter } from "../../types/index.js";
import type { Registry } from "../registry.js";
import { createCalendarEventAdapter } from "./calendar.js";
import { buildRfc2822Base64Url, createGmailDraftAdapter } from "./gmail.js";
import { guidedFallback } from "./guided.js";
import { createHevyRoutineCopyAdapter } from "./hevy.js";
import { notionAdapters } from "./notion.js";
import { obsidianNoteAppend, obsidianNoteCreate } from "./obsidian.js";
import { pmOsItemFile } from "./pm-os.js";
import { createThornhillPhoneAdapter } from "./thornhill.js";
import { createTickTickAdapter, sanitizeTickTickText, tickTickTaskCreate } from "./ticktick.js";

export function v0Adapters(db: Db): ExecutionAdapter[] {
  const cfg = loadConfig();
  const gmailConnected = cfg.gmail.enabled && Boolean(getSecret(`gmail:${cfg.gmail.account}`));
  return [
    guidedFallback,
    obsidianNoteCreate,
    obsidianNoteAppend,
    ...notionAdapters(db),
    createTickTickAdapter({ db }),
    createHevyRoutineCopyAdapter(),
    createCalendarEventAdapter(),
    createThornhillPhoneAdapter(),
    ...(gmailConnected ? [createGmailDraftAdapter()] : []),
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
export { createTickTickAdapter, sanitizeTickTickText, tickTickTaskCreate } from "./ticktick.js";
export { createGmailDraftAdapter, buildRfc2822Base64Url } from "./gmail.js";
export { createHevyRoutineCopyAdapter } from "./hevy.js";
export { createCalendarEventAdapter } from "./calendar.js";
export { createThornhillPhoneAdapter } from "./thornhill.js";
