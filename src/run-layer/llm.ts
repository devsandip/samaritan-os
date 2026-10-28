/**
 * Shared Anthropic structured-JSON and Vision helper for capabilities (Phase 6, P6-1).
 *
 * Calls the Anthropic Messages API (`https://api.anthropic.com/v1/messages`)
 * using the `anthropic:default` Keychain secret (or an injected `apiKey`),
 * supports optional base64 image blocks for vision capabilities such as
 * `calendar-from-screenshot`, and parses the JSON response.
 *
 * Returns `undefined` when unconfigured, running inside unit tests without an
 * injected `fetchImpl`/`apiKey`, or on network/parse errors so capabilities
 * fall back cleanly to their deterministic extractors.
 */
import { loadConfig } from "../config/index.js";
import { getSecret } from "../secrets.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export interface ClaudeStructuredOptions {
  system: string;
  prompt: string;
  imageBase64?: string;
  imageMediaType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  model?: string;
  maxTokens?: number;
  apiKey?: string;
  useLlm?: boolean;
  fetchImpl?: typeof fetch;
}

export interface ClaudeStructuredResult<T> {
  data: T;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("no valid JSON object found in Claude response");
  }
}

export async function callClaudeStructured<T>(
  opts: ClaudeStructuredOptions,
): Promise<ClaudeStructuredResult<T> | undefined> {
  if (opts.useLlm === false) return undefined;

  // Keep unit tests deterministic unless the test explicitly injects fetchImpl,
  // apiKey, or useLlm: true.
  const isTestEnv = Boolean(process.env["VITEST"] || process.env["NODE_ENV"] === "test");
  if (isTestEnv && !opts.fetchImpl && !opts.apiKey && opts.useLlm !== true) {
    return undefined;
  }

  const cfg = loadConfig();
  const key = opts.apiKey ?? getSecret(`anthropic:${cfg.recall.account}`);
  if (!key) return undefined;

  const model = opts.model ?? cfg.recall.model ?? "claude-sonnet-5";
  const maxTokens = opts.maxTokens ?? 1024;
  const fetchFn = opts.fetchImpl ?? fetch;

  const contentBlocks: Record<string, unknown>[] = [];
  if (opts.imageBase64) {
    contentBlocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: opts.imageMediaType ?? "image/png",
        data: opts.imageBase64.replace(/^data:image\/[a-z]+;base64,/i, ""),
      },
    });
  }
  contentBlocks.push({
    type: "text",
    text: opts.prompt,
  });

  try {
    const response = await fetchFn(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: `${opts.system}\nRespond ONLY with a single valid JSON object. Do not include markdown prose outside the JSON.`,
        messages: [
          {
            role: "user",
            content: contentBlocks,
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return undefined;

    const body = (await response.json()) as {
      model?: string;
      content?: { type?: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) return undefined;

    const parsed = extractJsonObject(text) as T;
    return {
      data: parsed,
      model: body.model ?? model,
      input_tokens: body.usage?.input_tokens ?? 0,
      output_tokens: body.usage?.output_tokens ?? 0,
    };
  } catch {
    return undefined;
  }
}
