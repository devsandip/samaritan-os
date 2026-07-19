/**
 * `@samaritan/sdk` (TECH-SPEC §8).
 *
 * The one function every capability calls. In-process the Run Layer binds a
 * direct call into RunContext; out-of-process (a Claude scheduled task or slash
 * command shelling out to the CLI) the same signature POSTs to the local API.
 * A capability author writes the same code either way.
 */
import type { DraftActionItem } from "../types/index.js";

export interface EmitAccepted {
  id: string;
  dedupe_key: string;
  status: string;
  policy?: { outcome: string; reason: string; matched_rule: string };
}

export interface EmitRejected {
  item: unknown;
  errors: string[];
}

export interface EmitResult {
  accepted: EmitAccepted[];
  rejected: EmitRejected[];
}

export interface EmitOptions {
  /** Defaults to http://127.0.0.1:4173, or SAMARITAN_API_URL when set. */
  baseUrl?: string;
  signal?: AbortSignal;
}

export function apiBaseUrl(override?: string): string {
  return override ?? process.env["SAMARITAN_API_URL"] ?? "http://127.0.0.1:4173";
}

export class EmitError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EmitError";
  }
}

export async function emit(
  capabilityId: string,
  items: DraftActionItem[] | Record<string, unknown>[],
  options: EmitOptions = {},
): Promise<EmitResult> {
  const url = `${apiBaseUrl(options.baseUrl)}/api/actions`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability_id: capabilityId, items }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (err) {
    throw new EmitError(
      `could not reach the Action Center at ${url}. Is it running? ` +
        `Start it with "pnpm serve". (${(err as Error).message})`,
    );
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = (body["error"] as { message?: string } | undefined)?.message ?? response.statusText;
    throw new EmitError(`Action Center rejected the emit: ${detail}`, response.status);
  }

  return body as unknown as EmitResult;
}
