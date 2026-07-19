/**
 * `layout: diff` (UI-SPEC §4.7) — a proposed change to something that exists.
 *
 * §4.7 sketches `render: { layout: diff, fields: [...] }`, but the v0 manifest
 * schema (`src/types/manifest.ts`, `RenderSpec`) carries only primary /
 * secondary / badges, so there is nowhere to declare which pairs of attributes
 * form a diff. The convention used here instead: an attribute named `x` is the
 * proposed value, and whichever of `x_was` / `x_before` / `old_x` / `previous_x`
 * exists is the current one. Anything unpaired renders as a plain row rather
 * than being hidden, so a mis-named field is visible rather than silently lost.
 */
import { FieldEditor, FieldValue } from "./fields";
import { bodyFields, isBlank, type RendererProps } from "./types";
import { renderScalar, titleCase } from "../lib/format";

function oldValueKey(name: string, available: Set<string>): string | undefined {
  const candidates = [`${name}_was`, `${name}_before`, `old_${name}`, `previous_${name}`];
  return candidates.find((candidate) => available.has(candidate));
}

export function DiffRenderer(props: RendererProps) {
  const { resolved, editing, onChange } = props;
  const primary = resolved?.spec.render.primary;
  const all = bodyFields(props, editing || !primary ? [] : [primary]);
  const names = new Set(all.map((field) => field.name));

  const pairedOldKeys = new Set<string>();
  for (const field of all) {
    const key = oldValueKey(field.name, names);
    if (key) pairedOldKeys.add(key);
  }

  const rows = all.filter((field) => !pairedOldKeys.has(field.name));

  return (
    <div className="dcard">
      {rows.map((field) => {
        const oldKey = oldValueKey(field.name, names);
        const oldValue = oldKey ? props.draft[oldKey] : undefined;

        return (
          <div className="diff-row" key={field.name}>
            <div className="dkey">{titleCase(field.name)}</div>
            <div>
              {editing ? (
                <FieldEditor
                  name={field.name}
                  value={field.value}
                  declared={field.declared}
                  onChange={(value) => onChange(field.name, value)}
                />
              ) : oldKey ? (
                <span>
                  <span className="old">{isBlank(oldValue) ? "not set" : renderScalar(oldValue)}</span>
                  <span className="arrow" aria-label="changes to">
                    →
                  </span>
                  <span className="new">
                    {isBlank(field.value) ? "cleared" : renderScalar(field.value)}
                  </span>
                </span>
              ) : (
                <FieldValue value={field.value} declared={field.declared} />
              )}
            </div>
          </div>
        );
      })}
      {rows.length === 0 ? <div className="field-value empty">No fields to compare.</div> : null}
    </div>
  );
}
