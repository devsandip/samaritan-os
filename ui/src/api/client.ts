/**
 * Thin wrapper over the daemon's HTTP surface (TECH-SPEC §5.1).
 *
 * Every failure mode the UI has to render differently is turned into an
 * `ApiError` here rather than at each call site: a 409 from an illegal
 * transition and a dead daemon both reach the view as one type, carrying the
 * server's own message so the UI never has to invent an explanation.
 */
import type {
  ActionItem,
  ActionItemEvent,
  ActionItemStatus,
  ActivityEvent,
  Artifact,
  BatchResult,
  CapabilityManifest,
  ConnectionStatusEntry,
  Health,
  LoadProblem,
  NowSummary,
  Priority,
  RecallAnswer,
  RecallStats,
  RoutingEntry,
  RunRecord,
  RunReport,
  SourceRule,
  SyncCursor,
  SystemHealth,
  BackupRecord,
  Task,
  TaskLane,
  TaskStatus,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    /** 0 when the request never reached the daemon. */
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** True when nothing answered, as opposed to the daemon refusing the request. */
  get unreachable(): boolean {
    return this.status === 0 || this.code === "upstream_unavailable";
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * Fired on any 401 so the app can show the sign-in screen wherever the request
 * came from, instead of each view rendering its own "unauthorized" error.
 */
export const UNAUTHORIZED_EVENT = "samaritan:unauthorized";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
    });
  } catch (err) {
    throw new ApiError(
      `Cannot reach the Samaritan daemon (${(err as Error).message})`,
      0,
      "unreachable",
    );
  }

  if (!response.ok) {
    let body: ErrorBody = {};
    let parsed = false;
    try {
      body = (await response.json()) as ErrorBody;
      parsed = true;
    } catch {
      // Non-JSON error body: the status line is all we have.
    }
    // Every error this API raises is JSON. A 5xx without it did not come from
    // the daemon: it is the dev proxy, or a tunnel, reporting that nothing
    // answered. Same practical meaning as a failed fetch, so it says the same.
    const upstreamDown = !parsed && response.status >= 500;
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(
      body.error?.message ?? `${response.status} ${response.statusText}`,
      response.status,
      body.error?.code ?? (upstreamDown ? "upstream_unavailable" : "http_error"),
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface ListFilter {
  /** One, or several: the endpoint takes a repeated `status` param. */
  status?: ActionItemStatus | ActionItemStatus[];
  capability_id?: string;
  priority?: Priority;
  type?: string;
  limit?: number;
  offset?: number;
}

function query(filter: ListFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === "") continue;
    // Appended one by one: `set` would stringify the array into a single
    // comma-joined value, which is not a status the daemon recognises.
    if (Array.isArray(value)) for (const each of value) params.append(key, String(each));
    else params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export interface AuthSession {
  authenticated: boolean;
  token_configured: boolean;
  via: "session" | "bearer" | "local-open" | null;
}

export const api = {
  health: () => request<Health>("/healthz"),

  systemHealth: () => request<SystemHealth>("/api/system/health"),

  connections: () =>
    request<{ connections: ConnectionStatusEntry[] }>("/api/connections").then(
      (r) => r.connections,
    ),

  triggerBackup: () =>
    request<{ backup: BackupRecord }>("/api/system/backup", {
      method: "POST",
      body: JSON.stringify({}),
    }),

  session: () => request<AuthSession>("/api/auth/session"),

  login: (token: string) =>
    request<{ authenticated: boolean }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),

  logout: () => request<{ authenticated: boolean }>("/api/auth/logout", { method: "POST" }),
  listActions: (filter: ListFilter = {}) =>
    request<{ items: ActionItem[] }>(`/api/actions${query(filter)}`).then((r) => r.items),

  getAction: (id: string) => request<ActionItem>(`/api/actions/${id}`),

  getAudit: (id: string) =>
    request<{ events: ActionItemEvent[] }>(`/api/actions/${id}/audit`).then((r) => r.events),

  respond: (
    id: string,
    body: {
      response_id: string;
      edited_payload?: Record<string, unknown>;
      actor?: string;
      expected_payload_hash?: string;
      expected_revision?: number;
    },
  ) =>
    request<ActionItem>(`/api/actions/${id}/respond`, {
      method: "POST",
      body: JSON.stringify({ actor: "sandip", ...body }),
    }),

  /**
   * Batch-approve for similar low-risk items (§12 step 23). Per-item outcomes.
   * Each id carries the revision on screen, so nothing that changed since the
   * list loaded is approved (D9).
   */
  batch: (items: { id: string; revision: number }[], responseId: string) =>
    request<BatchResult>("/api/actions/batch", {
      method: "POST",
      body: JSON.stringify({
        ids: items.map((i) => i.id),
        revisions: Object.fromEntries(items.map((i) => [i.id, i.revision])),
        response_id: responseId,
      }),
    }),

  confirm: (
    id: string,
    body: { note?: string; expected_payload_hash?: string; expected_revision?: number } = {},
  ) =>
    request<ActionItem>(`/api/actions/${id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ actor: "sandip", ...body }),
    }),

  reopen: (id: string, body: { reason?: string } = {}) =>
    request<ActionItem>(`/api/actions/${id}/reopen`, {
      method: "POST",
      body: JSON.stringify({ actor: "sandip", ...body }),
    }),

  now: () => request<NowSummary>("/api/now"),

  listTasks: (filter: { status?: TaskStatus | TaskStatus[]; lane?: TaskLane; limit?: number } = {}) =>
    request<{ tasks: Task[] }>(`/api/tasks${query(filter as ListFilter)}`).then((r) => r.tasks),

  getTask: (id: string) =>
    request<{
      task: Task;
      runs: RunRecord[];
      artifacts: Artifact[];
      events: ActivityEvent[];
      action_items: ActionItem[];
      open_question: ActionItem | null;
    }>(`/api/tasks/${encodeURIComponent(id)}`),

  /** Queues a task and returns at once; the run happens in the background. */
  createTask: (body: { goal: string; lane?: TaskLane; request_key?: string }) =>
    request<{ task: Task; created: boolean }>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  retryTask: (id: string) =>
    request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}/retry`, { method: "POST" }),

  answerTask: (id: string, body: { answer: string; question_id?: string; expected_revision?: number }) =>
    request<{ task: Task }>(`/api/tasks/${encodeURIComponent(id)}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  cancelTask: (id: string, reason?: string) =>
    request<{ task: Task }>(
      `/api/tasks/${encodeURIComponent(id)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      },
    ),

  listRuns: (filter: { task_id?: string; status?: string; limit?: number } = {}) =>
    request<{ runs: RunRecord[] }>(`/api/runs${query(filter as ListFilter)}`).then((r) => r.runs),

  cancelRun: (id: string, reason?: string) =>
    request<{ run: RunRecord | null; stopped: boolean }>(
      `/api/runs/${encodeURIComponent(id)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify(reason ? { reason } : {}),
      },
    ),

  getArtifactContent: async (id: string): Promise<string> => {
    const res = await request<{ artifact: Artifact; content?: string }>(
      `/api/artifacts/${encodeURIComponent(id)}`,
    );
    return res.content ?? `(Artifact stored at ${res.artifact.path_or_url})`;
  },

  activity: (limit = 100) =>
    request<{
      events: ActivityEvent[];
      runs: RunRecord[];
      seen_events: { id: string; event_type: string; seen_at: string }[];
    }>(`/api/activity?limit=${limit}`),

  sourceRules: () =>
    request<{ rules: SourceRule[]; sync_cursors: SyncCursor[] }>("/api/source-rules"),

  updateSourceRule: (
    sourceId: string,
    body: {
      muted?: boolean;
      snoozed_until?: string | null;
      paused?: boolean;
    },
  ) =>
    request<SourceRule>(`/api/source-rules/${encodeURIComponent(sourceId)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  submitMeetingNotes: (body: {
    event_id?: string;
    title?: string;
    date?: string;
    attendees?: string[];
    notes: string;
  }) =>
    request<RunReport>("/api/meetings/notes", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  capabilities: () =>
    request<{ capabilities: CapabilityManifest[]; problems: LoadProblem[] }>("/api/capabilities"),

  /** Fires a capability now. A failed run is a 200 with the reason in the body. */
  runCapability: (id: string) =>
    request<RunReport>(`/api/capabilities/${encodeURIComponent(id)}/run`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  /** Re-walks capabilities/ so a folder dropped in is picked up without a restart. */
  reloadCapabilities: () =>
    request<{ reloaded: string[]; problems: LoadProblem[] }>("/api/capabilities/reload", {
      method: "POST",
    }),

  /** Ask-Samaritan (§5.5). Retrieves and cites; a miss is a 200 with no citations. */
  recall: (question: string, maxCitations?: number) =>
    request<RecallAnswer>("/api/recall/query", {
      method: "POST",
      body: JSON.stringify(
        maxCitations ? { question, max_citations: maxCitations } : { question },
      ),
    }),

  recallStats: () => request<RecallStats>("/api/recall/stats"),

  routing: () => request<{ routing: RoutingEntry[] }>("/api/routing").then((r) => r.routing),

  updateRouting: (
    actionType: string,
    body: { provider?: string; account?: string; mode?: string },
  ) =>
    request<RoutingEntry>(`/api/routing/${encodeURIComponent(actionType)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
};
