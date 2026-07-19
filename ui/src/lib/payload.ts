/**
 * Working-copy helpers for edit-then-approve.
 *
 * `POST /api/actions/:id/respond` replaces both `custom` and
 * `execution.payload` with whatever `edited_payload` contains, so what leaves
 * this file is exactly what gets executed. Two rules follow: send
 * `edited_payload` only when something actually changed (an unnecessary edit
 * writes a `payload_diff` into the audit trail and mislabels the item as
 * edited), and strip the UI's own bookkeeping keys before sending.
 */

/** Checklist rows carry this while under review; it never leaves the browser. */
export const CHECKED_KEY = "_checked";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for the `object[]` shape the form layout renders as a record group. */
export function isRecordGroup(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject);
}

/**
 * Applies the batch-approve rule from §7 pattern 6: unchecked rows are dropped
 * rather than filed, and the bookkeeping flag is removed from the rows that stay.
 */
export function preparePayload(draft: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(draft)) {
    if (!isRecordGroup(value)) {
      out[key] = value;
      continue;
    }
    out[key] = value
      .filter((row) => row[CHECKED_KEY] !== false)
      .map((row) => {
        const { [CHECKED_KEY]: _checked, ...rest } = row;
        return prepareNested(rest);
      });
  }

  return out;
}

function prepareNested(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = isRecordGroup(value) ? preparePayload({ v: value }).v : value;
  }
  return out;
}

/** Structural equality over JSON-shaped values. Used to detect a real edit. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => deepEqual(entry, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => key in b && deepEqual(a[key], b[key]));
  }
  return false;
}

/** A deep copy that is safe to mutate. `custom` is always JSON by contract. */
export function cloneDraft(custom: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(custom);
}

/** Field-level before/after, for showing what an edit changed. */
export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !deepEqual(before[key], after[key]));
}
