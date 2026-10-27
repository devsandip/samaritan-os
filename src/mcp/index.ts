/**
 * Cross-Assistant MCP Server (PROPOSAL D4).
 *
 * Exposes 8 tools with plain JSON Schemas (no oneOf/anyOf/$ref) so Claude Code,
 * Codex, and Gemini CLI share one memory, task queue, and Inbox:
 *   1. get_context
 *   2. search
 *   3. read_artifact
 *   4. list_inbox
 *   5. propose_action
 *   6. submit_task
 *   7. task_status
 *   8. answer_question
 *
 * Approval tools (`respond`, `confirm`, `batch`) are deliberately excluded from
 * the MCP surface so a connected coding assistant can propose actions or answer
 * task clarifications, but can never approve an Inbox item on Sandip's behalf.
 */
import type { App } from "../app.js";
import { listActionItems } from "../store/action-items.js";
import { listRuns } from "../store/runs.js";
import { listSourceRules } from "../store/source-rules.js";
import { listActivityEvents, listArtifacts, listTasks } from "../store/tasks.js";
import type { DraftActionItem, DataScope, TaskLane } from "../types/index.js";

function parseScope(raw: unknown): DataScope | undefined {
  return raw === "work" || raw === "personal" ? raw : undefined;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "get_context",
    description:
      "Returns Samaritan's active operational snapshot: pending Inbox count, active delegated tasks, upcoming calendar events, and per-source notification rules.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description: "Optional data scope filter: work or personal",
        },
      },
    },
  },
  {
    name: "search",
    description:
      "Searches Samaritan Recall across the Obsidian vault, Notion decisions/insights mirrors, project journals, and audit trail, returning cited passages.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language question or search query",
        },
        max_citations: {
          type: "number",
          description: "Maximum number of citations to return (default 8)",
        },
        scope: {
          type: "string",
          description: "Optional data scope filter: work or personal",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_artifact",
    description:
      "Reads the metadata and text content of an artifact produced by a delegated task.",
    inputSchema: {
      type: "object",
      properties: {
        artifact_id: {
          type: "string",
          description: "The artifact ID to read",
        },
      },
      required: ["artifact_id"],
    },
  },
  {
    name: "list_inbox",
    description:
      "Lists items currently waiting in Sandip's Samaritan Inbox (pending, in_review, awaiting_confirmation).",
    inputSchema: {
      type: "object",
      properties: {
        capability_id: {
          type: "string",
          description: "Optional capability ID filter",
        },
        scope: {
          type: "string",
          description: "Optional data scope filter: work or personal",
        },
        limit: {
          type: "number",
          description: "Maximum items to return (default 25)",
        },
      },
    },
  },
  {
    name: "propose_action",
    description:
      "Proposes a structured decision, insight, task, person, or note into the Samaritan Inbox for Sandip's review. Never executes without human approval.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          description: "One of: decision, insight, task, person, note",
        },
        title: {
          type: "string",
          description: "Concise title of the proposed item",
        },
        detail: {
          type: "string",
          description: "Supporting rationale, body, or task description",
        },
        project: {
          type: "string",
          description: "Optional project name (e.g. Samaritan)",
        },
        due: {
          type: "string",
          description: "Optional ISO date for tasks (YYYY-MM-DD)",
        },
        evidence: {
          type: "string",
          description: "Optional evidence or source reference",
        },
      },
      required: ["kind", "title"],
    },
  },
  {
    name: "submit_task",
    description:
      "Submits a delegated background task to Samaritan's WorkerService and returns the created task and run record.",
    inputSchema: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "Clear description of the delegated task goal",
        },
        lane: {
          type: "string",
          description: "Task lane: general, coding, research, or operations",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: "task_status",
    description:
      "Returns the current status, latest run, registered artifacts, and recent activity events for a delegated task.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The delegated task ID",
        },
      },
      required: ["task_id"],
    },
  },
  {
    name: "answer_question",
    description:
      "Provides a clarifying answer to a delegated task currently in needs_input status and resumes the worker. Cannot approve Inbox action items.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task ID (or task-question action item ID) waiting for clarification",
        },
        answer: {
          type: "string",
          description: "Clarification text to pass to the worker",
        },
        expected_revision: {
          type: "number",
          description: "Optional expected task revision number for optimistic concurrency",
        },
      },
      required: ["task_id", "answer"],
    },
  },
] as const;

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export async function callMcpTool(
  app: App,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  switch (name) {
    case "get_context": {
      const scope = parseScope(args["scope"]);
      const inbox = listActionItems(app.db, {
        status: ["pending", "in_review", "awaiting_confirmation"],
        ...(scope ? { scope } : {}),
        limit: 20,
      });
      const tasks = listTasks(app.db, {
        ...(scope ? { scope } : {}),
        limit: 15,
      });
      const activeRuns = listRuns(app.db, { status: "running", limit: 15 });
      const upcomingMeetings = app.db
        .prepare<{ id: string; title: string; starts_at: string; ends_at: string | null }>(
          "SELECT id, title, starts_at, ends_at FROM calendar_events ORDER BY starts_at ASC LIMIT 10",
        )
        .all();
      const sourceRules = listSourceRules(app.db);
      return {
        inbox_count: inbox.length,
        inbox_preview: inbox.slice(0, 5).map((i) => ({
          id: i.id,
          capability_id: i.capability_id,
          type: i.type,
          priority: i.priority,
          decision_needed: i.context.decision_needed,
          revision: i.revision,
        })),
        tasks,
        active_runs: activeRuns,
        upcoming_meetings: upcomingMeetings,
        source_rules: sourceRules,
      };
    }

    case "search": {
      const query = String(args["query"] ?? "").trim();
      if (!query) throw new Error("search requires a non-empty query");
      const maxCitations =
        typeof args["max_citations"] === "number" ? args["max_citations"] : undefined;
      const scope = parseScope(args["scope"]);
      return app.recall.query(query, {
        ...(maxCitations ? { maxCitations } : {}),
        ...(scope ? { scope } : {}),
      });
    }

    case "read_artifact": {
      const artifactId = String(args["artifact_id"] ?? "").trim();
      if (!artifactId) throw new Error("read_artifact requires artifact_id");
      const found = app.worker.getArtifact(artifactId);
      if (!found) throw new Error(`artifact ${artifactId} not found`);
      return found;
    }

    case "list_inbox": {
      const capabilityId =
        typeof args["capability_id"] === "string" && args["capability_id"]
          ? args["capability_id"]
          : undefined;
      const scope = parseScope(args["scope"]);
      const limit = typeof args["limit"] === "number" ? args["limit"] : 25;
      const items = listActionItems(app.db, {
        status: ["pending", "in_review", "awaiting_confirmation"],
        ...(capabilityId ? { capability_id: capabilityId } : {}),
        ...(scope ? { scope } : {}),
        limit,
      });
      return { items };
    }

    case "propose_action": {
      const kind = String(args["kind"] ?? "note").trim();
      const title = String(args["title"] ?? "").trim();
      if (!title) throw new Error("propose_action requires a non-empty title");
      const scope = parseScope(args["scope"]) ?? "work";

      const draft: DraftActionItem = {
        capability_id: "worker-task",
        type: "task-action-proposal",
        scope,
        context: {
          what_happened: `MCP client proposed a ${kind}: "${title}"`,
          source: { kind: "mcp", id: `mcp:${Date.now()}` },
          provenance: ["mcp.propose_action"],
          why_flagged: "external MCP proposals always require review before execution",
          trigger_reason: "policy",
          confidence: 0.85,
          decision_needed: `Approve ${kind}: "${title}"?`,
          decision_surface: "inbox",
          execution_surface:
            kind === "task" ? "ticktick" : kind === "note" ? "obsidian" : "notion",
          outcome_preview: `Files "${title}" as a ${kind}`,
        },
        custom: {
          kind,
          title,
          detail: String(args["detail"] ?? ""),
          project: String(args["project"] ?? ""),
          owner: "sandip",
          due: String(args["due"] ?? ""),
          evidence: String(args["evidence"] ?? ""),
          task_id: "",
          run_id: "",
        },
        dedupe_key: `mcp-proposal:${kind}:${title}`,
      };

      const res = await app.actionCenter.ingest("worker-task", [draft]);
      if (res.rejected.length) {
        throw new Error(`proposal rejected: ${res.rejected[0]!.errors.join("; ")}`);
      }
      return { proposed: res.accepted[0] };
    }

    case "submit_task": {
      const goal = String(args["goal"] ?? "").trim();
      if (!goal) throw new Error("submit_task requires a non-empty goal");
      const laneRaw = String(args["lane"] ?? "general");
      const lane: TaskLane = ["general", "coding", "research", "operations"].includes(laneRaw)
        ? (laneRaw as TaskLane)
        : "general";
      const scope = parseScope(args["scope"]) ?? "work";
      return app.worker.submit({ goal, lane, scope });
    }

    case "task_status": {
      const taskId = String(args["task_id"] ?? "").trim();
      if (!taskId) throw new Error("task_status requires task_id");
      const task = app.worker.getTask(taskId);
      if (!task) throw new Error(`task ${taskId} not found`);
      const runs = listRuns(app.db, { task_id: taskId, limit: 5 });
      const artifacts = listArtifacts(app.db, { task_id: taskId });
      const events = listActivityEvents(app.db, { task_id: taskId, limit: 50 });
      return { task, runs, artifacts, events };
    }

    case "answer_question": {
      const taskId = String(args["task_id"] ?? "").trim();
      const answer = String(args["answer"] ?? "").trim();
      if (!taskId || !answer) {
        throw new Error("answer_question requires task_id and answer");
      }
      const expectedRevision =
        typeof args["expected_revision"] === "number" ? args["expected_revision"] : undefined;
      const updated = await app.worker.answer(taskId, answer, expectedRevision);
      return { task: updated };
    }

    default:
      throw new Error(`unknown MCP tool "${name}"`);
  }
}

export async function handleMcpRequest(
  app: App,
  req: JsonRpcRequest,
): Promise<JsonRpcResponse> {
  const id = req.id ?? null;

  try {
    switch (req.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "samaritan", version: "0.1.0" },
          },
        };

      case "notifications/initialized":
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: MCP_TOOLS },
        };

      case "tools/call": {
        const params = (req.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        if (!params.name) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "tools/call requires params.name" },
          };
        }
        const output = await callMcpTool(app, params.name, params.arguments ?? {});
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          },
        };
      }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `method "${req.method}" not found` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
