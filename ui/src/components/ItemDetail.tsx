/**
 * The Inbox detail pane: chrome (§4.3) + schema-driven body (§4) + responses
 * (§4.6) + audit trail (§5.4) + Command Centre exact-revision hash guard.
 *
 * It refetches the item by id rather than reusing the list row, because the list
 * is a snapshot and a response has to be sent against current state (a stale
 * `responses[]` produces a 400 the user cannot explain). Every approve/confirm
 * binds `expected_payload_hash` and `expected_revision` so a concurrent re-ingest
 * raises a 409 (`stale_approval`) instead of approving modified parameters.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError, api } from "../api/client";
import type { ActionItem, ResponseSpec } from "../api/types";
import { ActionBar, isEditResponse } from "./ActionBar";
import { AuditTrail } from "./AuditTrail";
import { DetailHeader } from "./DetailHeader";
import { Button } from "./primitives";
import { ErrorBanner, ErrorStrip, SkeletonDetail } from "./states";
import { ItemBody } from "../renderers";
import type { Catalogue } from "../lib/manifest";
import { itemTitle, layoutFor, responsesFor } from "../lib/manifest";
import { changedFields, cloneDraft, deepEqual, preparePayload } from "../lib/payload";
import { clockTime, titleCase } from "../lib/format";
import { navigate } from "../lib/router";
import { INBOX_STATUSES } from "../lib/transitions";
import { useAsync } from "../lib/useAsync";

interface Confirmation {
  text: string;
  at: string;
}

export function ItemDetail({
  itemId,
  catalogue,
  onSettled,
  onUpdated,
}: {
  itemId: string;
  catalogue: Catalogue;
  /** The item left the Inbox: advance to the next one. `outcome` is the same
   * sentence the inline confirmation showed, so the toast cannot contradict it. */
  onSettled: (item: ActionItem, outcome: string) => void;
  /** The item changed but still needs Sandip: refresh in place. */
  onUpdated: (item: ActionItem) => void;
}) {
  const item = useAsync(() => api.getAction(itemId), [itemId]);
  // Refetched on every version bump: the trail's whole job is to show what just
  // happened, so a stale one after an approve would be worse than none.
  const version = item.data?.updated_at ?? "";
  const audit = useAsync(() => api.getAudit(itemId), [itemId, version]);

  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [editing, setEditing] = useState(false);
  const [pendingId, setPendingId] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [staleApproval, setStaleApproval] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | undefined>(undefined);
  const [workerAnswer, setWorkerAnswer] = useState("");
  const [answeringWorker, setAnsweringWorker] = useState(false);

  const loaded = item.data;
  const stamp = loaded ? `${loaded.id}:${loaded.updated_at}:${loaded.revision ?? 1}` : "";

  // Resetting on `updated_at` and `revision` means a re-ingest that supersedes
  // the item while it is open discards the stale draft rather than letting
  // Sandip approve text that no longer matches the source (§5.1).
  useEffect(() => {
    if (!loaded) return;
    setDraft(cloneDraft(loaded.custom));
    setEditing(false);
    setActionError(undefined);
    setStaleApproval(false);
    setConfirmation(undefined);
    setPendingId(undefined);
  }, [stamp, loaded]);

  const onChange = useCallback((field: string, value: unknown) => {
    setDraft((current) => ({ ...current, [field]: value }));
  }, []);

  if (item.loading && !loaded) return <SkeletonDetail />;
  if (item.error && !loaded) return <ErrorBanner error={item.error} onRetry={item.reload} />;
  if (!loaded) return null;

  const resolved = catalogue.resolveItem(loaded);
  const layout = layoutFor(resolved);
  const responses = responsesFor(loaded, resolved);
  const payload = preparePayload(draft);
  const edited = !deepEqual(preparePayload(loaded.custom), payload);

  const finish = (updated: ActionItem, text: string) => {
    setConfirmation({ text, at: clockTime(updated.updated_at) });
    // §5.2: the confirmation holds in place for a beat before the item moves, so
    // the outcome is readable rather than a row vanishing under the cursor.
    window.setTimeout(() => {
      if (INBOX_STATUSES.includes(updated.status)) {
        // Still needs Sandip (staged, or execution failed): stay on it, but
        // re-render from the server's copy rather than the pre-action one.
        item.set(updated);
        onUpdated(updated);
      } else {
        onSettled(updated, text);
      }
    }, 1200);
  };

  const run = async (key: string, work: () => Promise<ActionItem>, describe: (u: ActionItem) => string) => {
    setPendingId(key);
    setActionError(undefined);
    setStaleApproval(false);
    try {
      const updated = await work();
      finish(updated, describe(updated));
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.code === "stale_approval")) {
        setStaleApproval(true);
      }
      const message =
        err instanceof ApiError ? err.message : `Unexpected failure: ${String(err)}`;
      setActionError(message);
      setPendingId(undefined);
    }
  };

  const onRespond = (response: ResponseSpec) =>
    void run(
      response.id,
      () =>
        api.respond(loaded.id, {
          response_id: response.id,
          // Only send a payload when something actually changed: otherwise the
          // audit trail records an edit that never happened.
          ...(edited || (editing && isEditResponse(response)) ? { edited_payload: payload } : {}),
          ...(loaded.payload_hash ? { expected_payload_hash: loaded.payload_hash } : {}),
          ...(loaded.revision !== undefined ? { expected_revision: loaded.revision } : {}),
        }),
      (updated) => {
        const fields = changedFields(loaded.custom, payload);
        const suffix = fields.length ? ` (edited ${fields.map(titleCase).join(", ")})` : "";
        switch (updated.status) {
          case "executed":
            return `Filed to ${loaded.context.execution_surface || "its destination"}${suffix}`;
          case "awaiting_confirmation":
            return `Staged, waiting on your confirmation${suffix}`;
          case "rejected":
            return "Discarded, nothing was filed";
          case "deferred":
            return "Deferred, it will come back to the inbox";
          case "in_review":
            return "Kept open for more information";
          case "failed":
            return "Execution failed";
          default:
            return `Now ${updated.status.replace(/_/g, " ")}`;
        }
      },
    );

  const submitWorkerAnswer = async (event: FormEvent) => {
    event.preventDefault();
    const answerText = workerAnswer.trim();
    if (!answerText || !loaded.task_id) return;
    setAnsweringWorker(true);
    setActionError(undefined);
    try {
      await api.answerTask(loaded.task_id, { answer: answerText });
      const refreshed = await api.getAction(loaded.id);
      setWorkerAnswer("");
      finish(refreshed, "Answered clarification and resumed worker task");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : String(err);
      setActionError(message);
    } finally {
      setAnsweringWorker(false);
    }
  };

  const title = itemTitle(loaded, resolved, draft);

  return (
    <div className="detail-inner">
      <DetailHeader item={loaded} resolved={resolved} title={title} />

      {loaded.task_id ? (
        <div className="d-meta" style={{ marginTop: "-6px" }}>
          <button
            type="button"
            className="link"
            style={{ fontSize: "12px", color: "var(--core)", fontWeight: 600, background: "none", border: 0, padding: 0, cursor: "pointer" }}
            onClick={() => navigate(`/tasks/${encodeURIComponent(loaded.task_id!)}`)}
          >
            Open parent task ({loaded.task_id})
          </button>
        </div>
      ) : null}

      {item.error ? (
        <ErrorStrip message={`Couldn't refresh this item: ${item.error.message}`} onRetry={item.reload} />
      ) : null}

      {staleApproval ? (
        <div className="banner" role="alert">
          <div className="msg">
            <div>
              <b>409 Conflict (stale_approval):</b> This item was updated while you were reviewing
              it (revision or payload hash changed).
            </div>
            <div className="detail-text">
              {actionError ?? "Reload the latest revision to inspect the updated parameters before approving."}
            </div>
          </div>
          <Button small variant="primary" onClick={() => item.reload()}>
            Reload Revision
          </Button>
        </div>
      ) : null}

      {loaded.status === "failed" ? (
        <div className="strip" role="alert">
          <div className="msg">
            Execution failed after approval. Nothing was filed. Re-approving retries with the same
            idempotency key.
          </div>
        </div>
      ) : null}

      <ItemBody
        layout={layout}
        item={loaded}
        resolved={resolved}
        draft={draft}
        editing={editing}
        onChange={onChange}
      />

      {loaded.type === "task-question" && loaded.task_id && INBOX_STATUSES.includes(loaded.status) ? (
        <form className="dcard" onSubmit={(e) => void submitWorkerAnswer(e)}>
          <h4>Reply to Worker &amp; Resume Task</h4>
          <p className="detail-text" style={{ marginTop: 0, marginBottom: 8 }}>
            Your answer will be passed directly to <code>worker.answer()</code> and the background
            task will resume from its checkpoint.
          </p>
          <textarea
            className="draft short"
            rows={3}
            placeholder="Type your clarification for the worker..."
            value={workerAnswer}
            disabled={answeringWorker}
            onChange={(e) => setWorkerAnswer(e.target.value)}
          />
          <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
            <Button
              type="submit"
              variant="good"
              small
              pending={answeringWorker}
              disabled={answeringWorker || !workerAnswer.trim()}
            >
              Send Answer &amp; Resume Worker
            </Button>
          </div>
        </form>
      ) : null}

      {actionError && !staleApproval ? <ErrorStrip message={actionError} /> : null}

      {confirmation ? (
        <div className="confirm-line" role="status" aria-live="polite">
          <span aria-hidden="true">✓</span>
          <span>{confirmation.text}</span>
          <span className="tstamp">· {confirmation.at}</span>
        </div>
      ) : (
        <ActionBar
          item={loaded}
          resolved={resolved}
          responses={responses}
          editing={editing}
          edited={edited}
          pendingId={pendingId}
          fallback={layout === "raw"}
          onRespond={onRespond}
          onStartEditing={() => setEditing(true)}
          onCancelEditing={() => {
            setDraft(cloneDraft(loaded.custom));
            setEditing(false);
          }}
          onConfirm={() =>
            void run(
              "confirm",
              () =>
                api.confirm(loaded.id, {
                  ...(loaded.payload_hash ? { expected_payload_hash: loaded.payload_hash } : {}),
                  ...(loaded.revision !== undefined ? { expected_revision: loaded.revision } : {}),
                }),
              () => "Marked as done",
            )
          }
          onReopen={() =>
            void run(
              "reopen",
              () => api.reopen(loaded.id, { reason: "did not do it" }),
              () => "Reopened, it is back in the inbox",
            )
          }
        />
      )}

      <div className="dcard" style={{ marginTop: 22 }}>
        <h4>Audit trail</h4>
        {audit.loading && !audit.data ? (
          <SkeletonDetail />
        ) : audit.error ? (
          <ErrorStrip message={`Couldn't load the audit trail: ${audit.error.message}`} onRetry={audit.reload} />
        ) : (
          <AuditTrail events={audit.data ?? []} itemCreatedAt={loaded.created_at} />
        )}
        <div className="mode-note">
          Provenance: {loaded.context.provenance.join(" → ") || "not recorded"} · dedupe key{" "}
          <code>{loaded.dedupe_key}</code>
          {loaded.revision !== undefined ? (
            <>
              {" · "}rev <code>r{loaded.revision}</code>
            </>
          ) : null}
          {loaded.payload_hash ? (
            <>
              {" · "}hash <code>{loaded.payload_hash.slice(0, 12)}</code>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
