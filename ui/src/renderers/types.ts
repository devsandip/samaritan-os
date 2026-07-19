/** Shared contract for the four layout renderers (UI-SPEC §4.2). */
import type { ActionItem, CustomAttributeType } from "../api/types";
import type { ResolvedType } from "../lib/manifest";

export interface RendererProps {
  item: ActionItem;
  resolved: ResolvedType | undefined;
  /** Working copy of `custom`. Equals `item.custom` until something is edited. */
  draft: Record<string, unknown>;
  editing: boolean;
  onChange: (field: string, value: unknown) => void;
}

export interface BodyField {
  name: string;
  value: unknown;
  declared?: CustomAttributeType;
}

/**
 * The attributes a body should render, in manifest order.
 *
 * Manifest order matters: it is the only ordering signal a capability author
 * has, and `Object.keys` on the persisted JSON is not guaranteed to preserve it
 * once a payload has been through an edit round-trip. Fields already consumed by
 * the chrome (title, badges) are excluded so nothing renders twice.
 */
export function bodyFields(
  props: Pick<RendererProps, "item" | "resolved" | "draft">,
  exclude: string[] = [],
): BodyField[] {
  const { resolved, draft } = props;
  const declared = resolved?.spec.custom_attributes ?? {};
  const skip = new Set([...(resolved?.spec.render.badges ?? []), ...exclude]);

  const names = Object.keys(declared).length > 0 ? Object.keys(declared) : Object.keys(draft);
  const extras = Object.keys(draft).filter((name) => !names.includes(name));

  return [...names, ...extras]
    .filter((name) => !skip.has(name) && !name.startsWith("_"))
    .map((name) => ({
      name,
      value: draft[name],
      ...(declared[name] ? { declared: declared[name] } : {}),
    }));
}

/** True when a value has nothing worth rendering. Empty strings are common: a
 * capability sends "" for attributes that do not apply to a given item kind. */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}
