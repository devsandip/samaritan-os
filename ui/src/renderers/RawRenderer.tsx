/**
 * The §4.7 fallback: a missing or unrecognized layout must never drop the item.
 *
 * "Everything that needs Sandip lands in one inbox" is the guarantee at stake,
 * so the body degrades to a key/value list of whatever `custom` actually
 * arrived, and the caller collapses the action row to the universal set.
 */
import { FieldValue } from "./fields";
import { bodyFields, type RendererProps } from "./types";
import { titleCase } from "../lib/format";

export function RawRenderer(props: RendererProps) {
  const fields = bodyFields(props);

  return (
    <>
      <div className="strip" role="status">
        <div className="msg">
          This item&apos;s content couldn&apos;t be rendered as a{" "}
          {props.resolved?.spec.render.layout ?? "declared"} layout. Showing raw data.
        </div>
      </div>
      <div className="dcard">
        {fields.length === 0 ? (
          <div className="field-value empty">This item carries no custom attributes.</div>
        ) : (
          fields.map((field) => (
            <div className="field" key={field.name}>
              <span className="field-label">{titleCase(field.name)}</span>
              <FieldValue value={field.value} declared={field.declared} />
            </div>
          ))
        )}
      </div>
    </>
  );
}
