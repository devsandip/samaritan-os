/**
 * Synthesis and citation validation (TECH-SPEC §7 steps 4-5).
 *
 * Retrieval hands over a ranked set of passages; synthesis turns them into an
 * answer. There are two ways to do that and the choice is a privacy decision, not
 * a quality one:
 *
 *  - `none` (the default) writes nothing new. It lays the retrieved passages out,
 *    each tagged with its citation, and returns them. Nothing leaves the machine.
 *    You read the source rather than a paraphrase of it.
 *  - `anthropic` sends the passages to Claude to be written up as prose. Better to
 *    read, but it means the retrieved slices of your vault, journals and audit
 *    trail reach a third party — so §9 makes it a setting you turn on knowingly,
 *    never the default.
 *
 * Both paths run through the same guardrail: `validateCitations` keeps only the
 * citations whose ref was actually retrieved and strips the rest. A synthesiser
 * that invents a source is the one failure that would make Recall untrustworthy,
 * so the check is structural and not the model's to skip.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config/index.js";
import { log } from "../logger.js";
import { getSecret } from "../secrets.js";
import type { Passage } from "./retrieve.js";

const logger = log("recall.synth");

export interface Citation {
  kind: string;
  ref: string;
  excerpt?: string;
}

export interface Synthesized {
  answer: string;
  citations: Citation[];
}

export interface Synthesizer {
  readonly kind: "none" | "anthropic";
  synthesize(question: string, passages: Passage[]): Promise<string>;
}

/** The bracket tag that ties a passage to its citation, e.g. `[obsidian:foo.md#H]`. */
export function citationToken(passage: Pick<Passage, "kind" | "ref">): string {
  return `[${passage.kind}:${passage.ref}]`;
}

// A citation tag in synthesised prose: `[kind:ref]`. The kind is a lowercase
// word; the ref runs to the closing bracket, which covers file paths, ids and
// `#anchor` suffixes but not a literal `]` (which refs here never contain).
const CITATION = /\[([a-z_]+):([^\]]+)\]/g;

function excerpt(text: string, max = 240): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

/** Collapses the whitespace a stripped citation leaves behind. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * §7 step 5. Keeps only the citations whose ref was actually retrieved, strips
 * the rest out of the prose, and returns the supported citations with excerpts.
 * Refs are matched exactly against the retrieved set, so a hallucinated or
 * mangled ref is dropped rather than shown as a dead link.
 */
export function validateCitations(answer: string, passages: Passage[]): Synthesized {
  const byRef = new Map(passages.map((p) => [p.ref, p]));
  const cited = new Map<string, Citation>();
  let stripped = 0;

  const cleaned = answer.replace(CITATION, (whole, _kind: string, rawRef: string) => {
    const passage = byRef.get(rawRef.trim());
    if (!passage) {
      stripped += 1;
      return "";
    }
    if (!cited.has(passage.ref)) {
      cited.set(passage.ref, { kind: passage.kind, ref: passage.ref, excerpt: excerpt(passage.text) });
    }
    return whole;
  });

  if (stripped) {
    logger.warn({ stripped }, "stripped unsupported citations from a synthesised answer");
  }
  return { answer: tidy(cleaned), citations: [...cited.values()] };
}

/**
 * The default synthesiser: no model, no network. Returns the passages laid out
 * with their citation tags, so `validateCitations` collects every one of them.
 */
export class NoneSynthesizer implements Synthesizer {
  readonly kind = "none";

  async synthesize(_question: string, passages: Passage[]): Promise<string> {
    const blocks = passages.map((p, i) => `${i + 1}. ${citationToken(p)}\n${p.text.trim()}`);
    return `Synthesis is off, so these are the passages themselves, most relevant first:\n\n${blocks.join("\n\n")}`;
  }
}

const SYNTH_INSTRUCTIONS =
  "Answer the question using only the passages below. Cite every claim with the " +
  "bracketed tag shown above the passage it came from, copied exactly. If the " +
  "passages do not contain the answer, say so plainly rather than guessing.";

export type Complete = (prompt: string) => Promise<string>;

/**
 * The opt-in synthesiser. Sends the passages to Claude and returns its prose.
 * The completion call is injected so the prompt building and the citation
 * guardrail can be tested without a network round-trip; the default calls the
 * Anthropic SDK with a key resolved consciously from the Keychain.
 */
export class AnthropicSynthesizer implements Synthesizer {
  readonly kind = "anthropic";
  readonly #complete: Complete;

  constructor(opts: { apiKey: string; model: string; complete?: Complete }) {
    this.#complete = opts.complete ?? defaultComplete(opts.apiKey, opts.model);
  }

  async synthesize(question: string, passages: Passage[]): Promise<string> {
    const context = passages.map((p) => `${citationToken(p)}\n${p.text.trim()}`).join("\n\n");
    return this.#complete(`${SYNTH_INSTRUCTIONS}\n\nPassages:\n\n${context}\n\nQuestion: ${question}`);
  }
}

function defaultComplete(apiKey: string, model: string): Complete {
  return async (prompt) => {
    const response = await new Anthropic({ apiKey }).messages.create({
      model,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  };
}

/**
 * Picks the synthesiser from config. `anthropic` degrades to `none` when no key
 * is present, so a machine that asked for prose but never added a key returns
 * cited passages rather than erroring — the same fail-soft the whole path takes.
 */
export function chooseSynthesizer(recall: Config["recall"]): Synthesizer {
  if (recall.synthesis === "anthropic") {
    const apiKey = getSecret(`anthropic:${recall.account}`);
    if (apiKey) return new AnthropicSynthesizer({ apiKey, model: recall.model });
    logger.warn(
      { account: recall.account },
      'recall.synthesis is "anthropic" but no key is configured; returning passages instead',
    );
  }
  return new NoneSynthesizer();
}
