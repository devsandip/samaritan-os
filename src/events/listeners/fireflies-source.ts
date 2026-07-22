/**
 * The Fireflies GraphQL source (TECH-SPEC §2.2, §9).
 *
 * The network half the meeting-notes capability keeps at arm's length. The
 * `meeting.transcribed` event carries only a meeting id; this is the
 * authenticated call that turns that id into the transcript, talking to the
 * Fireflies GraphQL API. Everything with a decision in it — which query, how the
 * response collapses into a `FirefliesTranscript` — lives next door in
 * `fireflies-transcript.ts` and is tested against an injected `fetch`, so the
 * only thing that genuinely needs the internet is the socket.
 *
 * It is idle when unconfigured, the Gmail source's "no token" case again: no
 * `fireflies:<account>` secret means `createFirefliesSource` returns `undefined`
 * and the capability reports a clean skip rather than throwing. §9 scopes this to
 * read-only — it fetches a transcript and never writes back to Fireflies.
 *
 * v0 carries a bearer token as the secret, the same shape the Gmail source has:
 * a 401 surfaces as "reauthorise" rather than being silently swallowed. The
 * endpoint is overridable so verification can point it at a local fixture without
 * a real token. See DECISIONS.md.
 */
import { log } from "../../logger.js";
import { getSecret } from "../../secrets.js";
import {
  firefliesTranscriptQuery,
  normalizeTranscript,
  type FirefliesTranscript,
  type RawFirefliesTranscript,
} from "./fireflies-transcript.js";

const logger = log("fireflies-source");

const FIREFLIES_API = "https://api.fireflies.ai/graphql";

export interface FirefliesSourceOptions {
  /** Keychain account: the API token is looked up as `fireflies:<account>`. */
  account: string;
  /** Test seam: the bearer token, as a value or a thunk. Falls back to the secret. */
  token?: string | (() => string | undefined);
  /** Test seam: the fetch implementation. Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Override the API endpoint (a local fixture in verification). Defaults to Fireflies. */
  apiBase?: string;
}

export interface FirefliesSource {
  fetchTranscript(meetingId: string): Promise<FirefliesTranscript>;
}

/** A FirefliesSource, or undefined when no token is configured (consumer then skips). */
export function createFirefliesSource(
  options: FirefliesSourceOptions,
): FirefliesSource | undefined {
  const token =
    typeof options.token === "function"
      ? options.token()
      : (options.token ?? getSecret(`fireflies:${options.account}`));
  if (!token) {
    logger.info({ account: options.account }, "no fireflies token; transcript fetch idle");
    return undefined;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.apiBase ?? FIREFLIES_API;

  return {
    async fetchTranscript(meetingId: string): Promise<FirefliesTranscript> {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(firefliesTranscriptQuery(meetingId)),
      });
      if (response.status === 401) {
        throw new Error(
          `fireflies rejected the token (401) — reauthorise fireflies:${options.account}`,
        );
      }
      if (!response.ok) throw new Error(`fireflies ${response.status} for transcript ${meetingId}`);

      const json = (await response.json()) as {
        data?: { transcript?: RawFirefliesTranscript | null };
        errors?: { message?: string }[];
      };
      // A GraphQL server answers 200 with an `errors` array on a bad query or a
      // revoked scope — an ok status is not an ok body, so this must be checked.
      if (json.errors?.length) {
        const messages = json.errors.map((e) => e.message ?? "unknown").join("; ");
        throw new Error(`fireflies graphql error for ${meetingId}: ${messages}`);
      }
      return normalizeTranscript(json.data?.transcript, meetingId);
    },
  };
}
