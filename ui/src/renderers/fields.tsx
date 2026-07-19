/**
 * The field → component table (UI-SPEC §4.4), shared by all four layouts.
 *
 * The manifest declares four attribute types (`string`, `string[]`, `number`,
 * `boolean`), so the component is chosen from the declared type when there is
 * one and inferred from the runtime JSON type when there is not. §4.4's richer
 * tags (`quote`, `editable`, `checklist`) are not expressible in the v0 manifest
 * schema, so the layout that needs one derives it from position instead: see the
 * comment on each renderer.
 */
import type { CustomAttributeType } from "../api/types";
import { renderScalar, titleCase } from "../lib/format";

export interface FieldProps {
  name: string;
  value: unknown;
  declared?: CustomAttributeType | undefined;
  editing: boolean;
  onChange: (value: unknown) => void;
}

export function inferType(value: unknown, declared?: CustomAttributeType): CustomAttributeType {
  if (declared) return declared;
  if (Array.isArray(value)) return "string[]";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}

/** A string long enough to want a textarea rather than a single-line input. */
function isLong(value: unknown): boolean {
  return typeof value === "string" && (value.length > 90 || value.includes("\n"));
}

export function FieldLabel({ name }: { name: string }) {
  return <span className="field-label">{titleCase(name)}</span>;
}

/** Read-only rendering of one attribute. */
export function FieldValue({ value, declared }: { value: unknown; declared?: CustomAttributeType }) {
  const type = inferType(value, declared);

  if (type === "string[]") {
    const items = Array.isArray(value) ? value : [];
    if (items.length === 0) return <div className="field-value empty">none</div>;
    return (
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {items.map((entry, i) => (
          <li key={i} style={{ fontSize: 13.5, padding: "2px 0" }}>
            {renderScalar(entry)}
          </li>
        ))}
      </ul>
    );
  }

  if (type === "boolean") {
    return <div className="field-value">{value ? "yes" : "no"}</div>;
  }

  const text = renderScalar(value);
  if (!text) return <div className="field-value empty">not set</div>;
  return <div className="field-value">{text}</div>;
}

/**
 * Editable rendering. The warm off-white background (§2.1, "draft field bg") is
 * what marks a value as provisional and Sandip's to change, so every editable
 * control carries it, not only the textarea the mockup happens to show.
 */
export function FieldEditor({ name, value, declared, onChange }: Omit<FieldProps, "editing">) {
  const type = inferType(value, declared);
  const id = `field-${name}`;

  if (type === "string[]") {
    const items = Array.isArray(value) ? (value as unknown[]) : [];
    return (
      <div>
        {items.map((entry, i) => (
          <div className="listrow" key={i}>
            <input
              type="text"
              className="fi"
              aria-label={`${titleCase(name)} ${i + 1}`}
              value={renderScalar(entry)}
              onChange={(e) => {
                const next = [...items];
                next[i] = e.target.value;
                onChange(next);
              }}
            />
            <button
              type="button"
              className="btn small"
              onClick={() => onChange(items.filter((_, j) => j !== i))}
              aria-label={`Remove ${titleCase(name)} ${i + 1}`}
            >
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn small" onClick={() => onChange([...items, ""])}>
          Add line
        </button>
      </div>
    );
  }

  if (type === "boolean") {
    return (
      <label className="chk">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {titleCase(name)}
      </label>
    );
  }

  if (type === "number") {
    return (
      <input
        id={id}
        type="number"
        className="fi"
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
      />
    );
  }

  if (isLong(value)) {
    return (
      <textarea
        id={id}
        className="draft"
        value={typeof value === "string" ? value : renderScalar(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <input
      id={id}
      type="text"
      className="fi"
      value={typeof value === "string" ? value : renderScalar(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Label + value or editor, the unit every layout composes from.
 *
 * The label is only a `<label for>` when there is a control with that id to
 * point at. A checkbox brings its own wrapping label (§10 requires a real
 * associated one), and a read-only value has no control at all, so both get a
 * plain span instead of a label that resolves to nothing.
 */
export function Field({ name, value, declared, editing, onChange }: FieldProps) {
  const type = inferType(value, declared);

  if (editing && type === "boolean") {
    return (
      <div className="field">
        <FieldEditor name={name} value={value} declared={declared} onChange={onChange} />
      </div>
    );
  }

  return (
    <div className="field">
      {editing && type !== "string[]" ? (
        <label htmlFor={`field-${name}`}>
          <FieldLabel name={name} />
        </label>
      ) : (
        <FieldLabel name={name} />
      )}
      {editing ? (
        <FieldEditor name={name} value={value} declared={declared} onChange={onChange} />
      ) : (
        <FieldValue value={value} declared={declared} />
      )}
    </div>
  );
}
