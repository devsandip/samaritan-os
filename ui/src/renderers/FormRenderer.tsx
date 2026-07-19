/**
 * `layout: form` (UI-SPEC §4.2) — discrete, individually approvable facts.
 *
 * Two shapes, one renderer:
 *
 *  - An `object[]` attribute is the record group of §4.4: a header bar plus a
 *    body of checkbox rows, sub-grouped by any nested `object[]` inside it. Rows
 *    are real `<input type="checkbox">` with a `<label>` (§10), and unchecking
 *    drops the row at submit time rather than deleting it now, so the decision
 *    stays reversible until the batch action is pressed.
 *  - Everything else renders as a labelled control. A form layout means the
 *    review *is* the editing, so its fields are always live: `editing` gates the
 *    other three layouts, not this one.
 */
import { Field } from "./fields";
import { bodyFields, type RendererProps } from "./types";
import { CHECKED_KEY, isRecordGroup } from "../lib/payload";
import { renderScalar, titleCase } from "../lib/format";

/** Field names that read as a row's headline, in preference order. */
const LABEL_KEYS = ["title", "name", "label", "summary", "text", "decision", "task"];
/** Field names that read as a row's trailing meta, e.g. "· you · due Thu". */
const META_KEYS = ["owner", "assignee", "due", "date", "time", "when"];

function rowLabel(row: Record<string, unknown>): string {
  for (const key of LABEL_KEYS) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const first = Object.entries(row).find(
    ([key, value]) => key !== CHECKED_KEY && typeof value === "string" && value.trim(),
  );
  return first ? String(first[1]) : "Untitled row";
}

function rowMeta(row: Record<string, unknown>): string {
  const parts = META_KEYS.map((key) => row[key])
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim());
  return parts.length ? `· ${parts.join(" · ")}` : "";
}

function reversibilityTag(row: Record<string, unknown>): { label: string; cls: string } | undefined {
  const value = row["reversible"];
  if (typeof value !== "boolean") return undefined;
  return value ? { label: "Reversible", cls: "r" } : { label: "Irreversible", cls: "i" };
}

function ChecklistRow({
  row,
  index,
  onToggle,
}: {
  row: Record<string, unknown>;
  index: number;
  onToggle: (index: number, checked: boolean) => void;
}) {
  const tag = reversibilityTag(row);
  const meta = rowMeta(row);
  return (
    <label className="chk">
      <input
        type="checkbox"
        checked={row[CHECKED_KEY] !== false}
        onChange={(e) => onToggle(index, e.target.checked)}
      />
      <span>
        {rowLabel(row)}
        {tag ? <span className={`rev ${tag.cls}`}>{tag.label}</span> : null}
        {meta ? <span className="due"> {meta}</span> : null}
      </span>
    </label>
  );
}

function RecordGroup({
  name,
  rows,
  onChange,
}: {
  name: string;
  rows: Record<string, unknown>[];
  onChange: (rows: Record<string, unknown>[]) => void;
}) {
  const toggle = (index: number, checked: boolean) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, [CHECKED_KEY]: checked } : row)));
  };

  const checked = rows.filter((row) => row[CHECKED_KEY] !== false).length;

  return (
    <div className="meeting">
      <div className="meeting-h">
        {titleCase(name)}
        <span>
          {checked} of {rows.length} checked
        </span>
      </div>
      <div className="meeting-b">
        {rows.map((row, i) => {
          const nested = Object.entries(row).filter(([, value]) => isRecordGroup(value));
          return (
            <div key={i}>
              <ChecklistRow row={row} index={i} onToggle={toggle} />
              {nested.map(([key, value]) => (
                <div key={key} style={{ paddingLeft: 26 }}>
                  <h5
                    style={{
                      margin: "6px 0 2px",
                      fontSize: 11.5,
                      color: "var(--muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                    }}
                  >
                    {titleCase(key)}
                  </h5>
                  {(value as Record<string, unknown>[]).map((child, j) => (
                    <ChecklistRow
                      key={j}
                      row={child}
                      index={j}
                      onToggle={(childIndex, isChecked) => {
                        const nextChildren = (value as Record<string, unknown>[]).map((c, k) =>
                          k === childIndex ? { ...c, [CHECKED_KEY]: isChecked } : c,
                        );
                        onChange(
                          rows.map((r, k) => (k === i ? { ...r, [key]: nextChildren } : r)),
                        );
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function FormRenderer(props: RendererProps) {
  const { onChange } = props;
  const fields = bodyFields(props);

  const groups = fields.filter((field) => isRecordGroup(field.value));
  const scalars = fields.filter((field) => !isRecordGroup(field.value));

  return (
    <>
      {groups.map((field) => (
        <RecordGroup
          key={field.name}
          name={field.name}
          rows={field.value as Record<string, unknown>[]}
          onChange={(rows) => onChange(field.name, rows)}
        />
      ))}

      {scalars.length > 0 ? (
        <div className="dcard">
          {scalars.map((field) => (
            <Field
              key={field.name}
              name={field.name}
              value={field.value}
              declared={field.declared}
              editing
              onChange={(value) => onChange(field.name, value)}
            />
          ))}
        </div>
      ) : null}

      {groups.length === 0 && scalars.length === 0 ? (
        <div className="dcard">
          <div className="field-value empty">
            This item declares no fields. {renderScalar(props.item.context.decision_needed)}
          </div>
        </div>
      ) : null}
    </>
  );
}
