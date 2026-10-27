/**
 * Gmail Draft adapter (PROPOSAL-v1 Phase 3, P3-2).
 *
 * Implements `gmail.draft.create` in `assisted` and `guided` modes.
 * Guardrail: Samaritan never auto-sends emails (`automated` mode is intentionally
 * omitted). Approval in `assisted` mode creates a draft in the user's Gmail
 * account via `POST /gmail/v1/users/me/drafts` and transitions the item to
 * `awaiting_confirmation` until the user sends or confirms the draft.
 */
import { loadConfig } from "../../config/index.js";
import { getSecret } from "../../secrets.js";
import type {
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "../../types/index.js";
import { renderPayload } from "./guided.js";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface Rfc2822Input {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * Encodes an email header + body into RFC 2822 base64url format as required by
 * the Gmail REST API (`users.drafts.create`).
 */
export function buildRfc2822Base64Url(input: Rfc2822Input): string {
  const headers = [
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
  ];
  const rawMessage = `${headers.join("\r\n")}\r\n\r\n${input.body}`;
  return Buffer.from(rawMessage, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export interface GmailDraftAdapterOptions {
  token?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export function createGmailDraftAdapter(
  options: GmailDraftAdapterOptions = {},
): ExecutionAdapter {
  const resolveToken =
    options.token ??
    (() => {
      const cfg = loadConfig();
      if (!cfg.gmail.enabled) return undefined;
      return getSecret(`gmail:${cfg.gmail.account}`);
    });
  const fetchFn = options.fetchImpl ?? fetch;

  return {
    id: "gmail.draft.create",
    provider: "gmail",
    description:
      "Creates a Gmail reply draft via Gmail REST API v1 in assisted mode; never auto-sends.",
    modes: ["assisted", "guided"],

    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      const payload = request.payload as {
        to?: string;
        from?: string;
        recipient?: string;
        subject?: string;
        draft_body?: string;
        body?: string;
        thread_id?: string;
        message_id?: string;
      };

      const to = (payload.to ?? payload.recipient ?? payload.from ?? "").trim();
      const subject = (payload.subject ?? "Re: Follow-up").trim();
      const body = (payload.draft_body ?? payload.body ?? "").trim();

      if (!body) {
        return { status: "failed", error: 'payload requires "draft_body" or "body"' };
      }

      const auth = resolveToken();
      if (request.mode === "guided" || !auth || !to) {
        return {
          status: "staged",
          guided_instructions: renderPayload({
            to: to || "(recipient)",
            subject,
            draft_body: body,
          }),
          guided_link: "https://mail.google.com/mail/u/0/#inbox",
          result: { staged_draft: true, subject },
        };
      }

      try {
        const raw = buildRfc2822Base64Url({
          to,
          subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
          body,
          ...(payload.message_id ? { inReplyTo: payload.message_id } : {}),
        });

        const response = await fetchFn(`${GMAIL_API}/drafts`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              raw,
              ...(payload.thread_id ? { threadId: payload.thread_id } : {}),
            },
          }),
        });

        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok) {
          return {
            status: "failed",
            error: `gmail ${response.status}: ${String(data["error"] ? JSON.stringify(data["error"]) : response.statusText)}`,
          };
        }

        const draftId = typeof data["id"] === "string" ? data["id"].trim() : "";
        if (!draftId) {
          return {
            status: "failed",
            error: "gmail API returned 200 without a draft id receipt",
          };
        }

        return {
          status: "staged",
          guided_instructions: `Draft ${draftId} created in Gmail for ${to}. Review and press Send in Gmail, then confirm here.`,
          guided_link: "https://mail.google.com/mail/u/0/#drafts",
          result: {
            gmail_draft_id: draftId,
            to,
            subject,
          },
        };
      } catch (err) {
        return {
          status: "failed",
          error: (err as Error).message,
        };
      }
    },
  };
}
