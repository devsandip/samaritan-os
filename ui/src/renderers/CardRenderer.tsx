/**
 * `layout: card` (UI-SPEC §4.2) — a compact bundle of context.
 *
 * `render.secondary` is treated as the item's body copy and gets the quote
 * treatment the mockup gives an original message; everything else renders as a
 * labelled field. §4.4's `editable: true` tag does not exist in the v0 manifest
 * schema, so editability is a property of the review session rather than of a
 * field: pressing an edit response turns every attribute into a control at once.
 * That is the behaviour §7 pattern 2 describes ("the relevant field(s) become
 * in-place editable inputs") without needing a tag the manifest cannot carry.
 */
import { Field, FieldValue } from "./fields";
import { bodyFields, isBlank, type RendererProps } from "./types";
import { titleCase } from "../lib/format";

export function CardRenderer(props: RendererProps) {
  const { resolved, draft, editing, onChange } = props;
  const primary = resolved?.spec.render.primary;
  const secondary = resolved?.spec.render.secondary;

  // `primary` is the detail header's title, so rendering it again in the body
  // would duplicate it. In edit mode it comes back as a field, because a title
  // Sandip cannot correct is a title he has to reject the item over.
  const hoisted = editing ? [] : primary ? [primary] : [];
  const fields = bodyFields(props, [...hoisted, ...(secondary ? [secondary] : [])]);

  const secondaryValue = secondary ? draft[secondary] : undefined;
  const showSecondary = secondary && !isBlank(secondaryValue);

  return (
    <>
      {showSecondary ? (
        <div className="dcard">
          <h4>{titleCase(secondary)}</h4>
          {editing ? (
            <Field
              name={secondary}
              value={secondaryValue}
              declared={resolved?.spec.custom_attributes[secondary]}
              editing
              onChange={(value) => onChange(secondary, value)}
            />
          ) : (
            <FieldValue
              value={secondaryValue}
              declared={resolved?.spec.custom_attributes[secondary]}
            />
          )}
        </div>
      ) : null}

      {fields.length > 0 ? (
        <div className="dcard">
          {fields
            .filter((field) => editing || !isBlank(field.value))
            .map((field) => (
              <Field
                key={field.name}
                name={field.name}
                value={field.value}
                declared={field.declared}
                editing={editing}
                onChange={(value) => onChange(field.name, value)}
              />
            ))}
        </div>
      ) : null}
    </>
  );
}
