/**
 * `layout: document` (UI-SPEC §4.2) — one card, several named sections.
 *
 * Section order and headings come from `custom_attributes` in manifest order,
 * which is what §4.5's WBR example declares (`sections: [shipped, in_progress,
 * blockers, next_week]` maps 1:1 onto the attribute names). A `string[]` becomes
 * a bulleted list, a `string` a paragraph. Read-mostly by definition, so empty
 * sections are dropped rather than shown as "not set", which would turn a
 * synthesized narrative into a form.
 */
import { FieldEditor, FieldValue } from "./fields";
import { bodyFields, isBlank, type RendererProps } from "./types";
import { titleCase } from "../lib/format";

export function DocumentRenderer(props: RendererProps) {
  const { resolved, editing, onChange } = props;
  const primary = resolved?.spec.render.primary;
  const fields = bodyFields(props, editing || !primary ? [] : [primary]);
  const visible = fields.filter((field) => editing || !isBlank(field.value));

  if (visible.length === 0) {
    return (
      <div className="dcard">
        <div className="field-value empty">This document has no sections with content.</div>
      </div>
    );
  }

  return (
    <div className="dcard">
      {visible.map((field) => (
        <div className="sec" key={field.name}>
          <h5>{titleCase(field.name)}</h5>
          {editing ? (
            <FieldEditor
              name={field.name}
              value={field.value}
              declared={field.declared}
              onChange={(value) => onChange(field.name, value)}
            />
          ) : (
            <FieldValue value={field.value} declared={field.declared} />
          )}
        </div>
      ))}
    </div>
  );
}
