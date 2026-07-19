/**
 * The response row and the mode note (UI-SPEC §4.3 steps 6-7, §4.6, §4.8).
 *
 * Three things this owns that are easy to get subtly wrong:
 *
 *  1. Button variant comes from `outcome` plus the item's execution mode, not
 *     from the label. §4.6 splits `execute` into green (a direct commit) and
 *     indigo (a forward action still needing an external step); an automated
 *     item is the former, a guided or assisted one the latter, because those are
 *     exactly the modes that finish off-system.
 *  2. Edit is a mode, not a response. `ResponseOutcome` has no `edit` member, so
 *     a manifest expresses edit-then-approve as a second `execute` response
 *     (`edit_approve` in both anchor capabilities). Pressing it the first time
 *     opens the fields; pressing it again submits with `edited_payload`.
 *  3. `awaiting_confirmation` collapses the row to confirm / reopen (§4.8 rule
 *     2). The substantive decision is already past, and every other response
 *     would be refused by the server anyway.
 */
import type { ActionItem, ResponseSpec } from "../api/types";
import type { ItemResponse, ResolvedType } from "../lib/manifest";
import { MODE_LABEL } from "../lib/format";
import { blockedReason, canRespond } from "../lib/transitions";
import { Button, type ButtonVariant } from "./primitives";

export function isEditResponse(response: ResponseSpec): boolean {
  return /edit/i.test(response.id) || /^edit\b/i.test(response.label);
}

function variantFor(response: ResponseSpec, item: ActionItem): ButtonVariant {
  if (response.outcome !== "execute") return "default";
  if (isEditResponse(response)) return "default";
  return item.execution.mode === "automated" ? "good" : "primary";
}

/**
 * Why this button cannot be pressed, or undefined if it can. Two different
 * reasons, and the item's status is only one of them: a response whose manifest
 * entry is gone would be refused from any status at all.
 */
function disabledReason(response: ItemResponse, item: ActionItem): string | undefined {
  if (!response.answerable) {
    return (
      `${item.capability_id} no longer declares "${response.id}", so the daemon would refuse it. ` +
      `Restore the capability under capabilities/ and reload, or use Dismiss to clear this item.`
    );
  }
  if (!canRespond(item.status, response.outcome)) {
    return blockedReason(item.status, response.outcome);
  }
  return undefined;
}

export interface ActionBarProps {
  item: ActionItem;
  resolved: ResolvedType | undefined;
  responses: ItemResponse[];
  editing: boolean;
  edited: boolean;
  pendingId: string | undefined;
  onRespond: (response: ResponseSpec) => void;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  onConfirm: () => void;
  onReopen: () => void;
  /** Present only on the §4.7 raw fallback, which drops the declared row. */
  fallback?: boolean;
}

export function ActionBar(props: ActionBarProps) {
  const { item, resolved, responses, editing, edited, pendingId } = props;
  const busy = pendingId !== undefined;

  if (item.status === "awaiting_confirmation") {
    const link = item.execution.payload["_guided_link"];
    const instructions = item.execution.payload["_guided_instructions"];
    return (
      <>
        <div className="notice">
          <b>Awaiting your confirmation.</b> Samaritan staged this but cannot see whether the
          external step happened. Confirm once you have done it.
          {typeof instructions === "string" && instructions ? (
            <div className="staged">{instructions}</div>
          ) : null}
        </div>
        <div className="actions">
          {typeof link === "string" && link ? (
            <a className="btn" href={link} target="_blank" rel="noreferrer">
              Open {item.context.execution_surface || "the target"}
            </a>
          ) : null}
          {/* Not green: green means the OS executed it, and this is a human
              reporting work done outside the OS (§4.8 rule 1). */}
          <Button pending={pendingId === "confirm"} disabled={busy} onClick={props.onConfirm}>
            Mark as done
          </Button>
          <Button pending={pendingId === "reopen"} disabled={busy} onClick={props.onReopen}>
            Didn&apos;t do it
          </Button>
        </div>
        <ModeNote item={item} resolved={resolved} />
      </>
    );
  }

  if (props.fallback) {
    // Every response still renders, so the row does not go silent about what the
    // item used to offer, but only Dismiss can actually be sent. What is also
    // dropped is the styling that implies a consequence: with no manifest, the
    // UI cannot say which button commits, so none gets the green or indigo that
    // would claim it knows.
    return (
      <>
        <div className="actions">
          {responses.map((response) => {
            const blocked = disabledReason(response, item);
            return (
              <Button
                key={response.id}
                pending={pendingId === response.id}
                disabled={busy || blocked !== undefined}
                {...(blocked ? { title: blocked } : {})}
                onClick={() => props.onRespond(response)}
              >
                {response.label}
              </Button>
            );
          })}
        </div>
        <div className="mode-note">
          This type&apos;s manifest is not loaded, so these buttons are labelled by response id and
          the daemon will refuse them until the capability is back: restore it under{" "}
          <code>capabilities/</code> and reload. <b>Dismiss</b> is the exception: it is answered
          without consulting a manifest, so it works now and discards the item without filing
          anything. What the OS still knows: this executes <b>{item.execution.capability}</b> in{" "}
          <b>{MODE_LABEL[item.execution.mode]}</b> mode against{" "}
          {item.context.execution_surface || "an unnamed surface"}.
          {item.context.outcome_preview ? ` ${item.context.outcome_preview}` : ""}
        </div>
      </>
    );
  }

  // An item with nothing it can legally do renders a row of greyed buttons,
  // which on its own reads as a broken UI. Saying so is the honest version.
  // Rare now that Dismiss is always sendable: it takes a terminal status, where
  // even discarding is refused.
  const allBlocked =
    responses.length > 0 &&
    responses.every((response) => disabledReason(response, item) !== undefined);

  return (
    <>
      {allBlocked ? (
        <div className="strip" role="status">
          <div className="msg">
            Nothing can be done from <b>{item.status.replace(/_/g, " ")}</b>. The daemon has no
            endpoint that returns an item to the inbox from here, so this one is parked until a
            capability re-sends it.
          </div>
        </div>
      ) : null}

      <div className="actions">
        {responses.map((response) => {
          const blocked = disabledReason(response, item);
          const isEdit = isEditResponse(response);

          return (
            <Button
              key={response.id}
              variant={variantFor(response, item)}
              pending={pendingId === response.id}
              disabled={busy || blocked !== undefined}
              title={blocked}
              onClick={() => {
                if (isEdit && !editing) props.onStartEditing();
                else props.onRespond(response);
              }}
            >
              {response.label}
            </Button>
          );
        })}

        {editing ? (
          <Button disabled={busy} onClick={props.onCancelEditing}>
            Cancel edits
          </Button>
        ) : null}
      </div>

      {editing ? (
        <div className="mode-note">
          Editing. {edited ? "Your changes will be sent with the next approve." : "Nothing changed yet."}
        </div>
      ) : null}

      <ModeNote item={item} resolved={resolved} />
    </>
  );
}

/** §4.3 step 7: one caption saying what approval actually does. */
export function ModeNote({
  item,
  resolved,
}: {
  item: ActionItem;
  resolved: ResolvedType | undefined;
}) {
  const mode = item.execution.mode;
  const surface = item.context.execution_surface;
  const preview = item.context.outcome_preview;

  const consequence =
    mode === "automated"
      ? `on approve, this is filed to ${surface || item.execution.capability} directly.`
      : mode === "assisted"
        ? `Samaritan stages it in ${surface || item.execution.capability}; the final step is yours.`
        : `Samaritan cannot commit this for you. Approving stages instructions and waits for your confirmation.`;

  return (
    <div className="mode-note">
      <b>{MODE_LABEL[mode]} mode</b> — {consequence}
      {preview ? ` ${preview}` : ""}
      {resolved?.degradedReason ? (
        <>
          <br />
          Degraded to guided: {resolved.degradedReason}
        </>
      ) : null}
    </div>
  );
}
