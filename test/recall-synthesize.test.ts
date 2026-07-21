/**
 * Synthesis and citation validation (TECH-SPEC §7 steps 4-5).
 *
 * The Anthropic path's completion is injected, so these run with no network and
 * no key: what they pin down is the prompt the model would see, and the guardrail
 * that strips any citation the model returns for a source that was never
 * retrieved. That guardrail is the whole reason Recall can be trusted, so it is
 * tested against a synthesiser that deliberately hallucinates a ref.
 */
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config/index.js";
import type { Passage } from "../src/recall/retrieve.js";
import {
  AnthropicSynthesizer,
  NoneSynthesizer,
  chooseSynthesizer,
  validateCitations,
} from "../src/recall/synthesize.js";
import { __setSecretForTesting } from "../src/secrets.js";

const passage = (over: Partial<Passage> & { ref: string; text: string }): Passage => ({
  rowid: 1,
  kind: "obsidian",
  source_path: over.ref.split("#")[0] ?? over.ref,
  heading: null,
  score: 0.1,
  retrievers: ["vector"],
  ...over,
});

describe("validateCitations", () => {
  it("keeps a supported citation and lists it with an excerpt", () => {
    const passages = [passage({ ref: "a.md#H", text: "The answer is 42." })];
    const { answer, citations } = validateCitations("It is there [obsidian:a.md#H].", passages);
    expect(answer).toContain("[obsidian:a.md#H]");
    expect(citations).toEqual([{ kind: "obsidian", ref: "a.md#H", excerpt: "The answer is 42." }]);
  });

  it("strips a citation whose ref was never retrieved", () => {
    const passages = [passage({ ref: "a.md#H", text: "x" })];
    const { answer, citations } = validateCitations(
      "Real [obsidian:a.md#H] and fake [obsidian:ghost.md].",
      passages,
    );
    expect(answer).toContain("[obsidian:a.md#H]");
    expect(answer).not.toContain("ghost");
    expect(citations.map((c) => c.ref)).toEqual(["a.md#H"]);
  });

  it("dedupes repeated citations of the same ref", () => {
    const passages = [passage({ ref: "a.md#H", text: "x" })];
    const { citations } = validateCitations(
      "[obsidian:a.md#H] and again [obsidian:a.md#H]",
      passages,
    );
    expect(citations).toHaveLength(1);
  });

  it("truncates a long excerpt with an ellipsis", () => {
    const { citations } = validateCitations("[obsidian:a.md#H]", [
      passage({ ref: "a.md#H", text: "y".repeat(300) }),
    ]);
    expect(citations[0]?.excerpt?.endsWith("…")).toBe(true);
    expect(citations[0]?.excerpt?.length).toBeLessThanOrEqual(240);
  });
});

describe("NoneSynthesizer", () => {
  it("lays passages out tagged, and every one validates as a citation", async () => {
    const passages = [
      passage({ ref: "a.md#H", text: "Alpha." }),
      passage({ ref: "b.md#H", text: "Beta.", rowid: 2 }),
    ];
    const raw = await new NoneSynthesizer().synthesize("q", passages);
    expect(raw).toContain("Synthesis is off");
    expect(raw).toContain("[obsidian:a.md#H]");

    const { citations } = validateCitations(raw, passages);
    expect(citations.map((c) => c.ref)).toEqual(["a.md#H", "b.md#H"]);
  });
});

describe("AnthropicSynthesizer", () => {
  it("prompts with the tagged passages and the question, then validates the reply", async () => {
    let seenPrompt = "";
    const synth = new AnthropicSynthesizer({
      apiKey: "k",
      model: "m",
      complete: async (prompt) => {
        seenPrompt = prompt;
        return "Vendor A won [obsidian:a.md#H]; a second point [obsidian:phantom.md].";
      },
    });
    const passages = [passage({ ref: "a.md#H", text: "We picked Vendor A." })];

    const raw = await synth.synthesize("why vendor A?", passages);
    expect(seenPrompt).toContain("[obsidian:a.md#H]");
    expect(seenPrompt).toContain("We picked Vendor A.");
    expect(seenPrompt).toContain("Question: why vendor A?");

    const { answer, citations } = validateCitations(raw, passages);
    expect(answer).toContain("[obsidian:a.md#H]");
    // The hallucinated ref appears nowhere but its stripped token.
    expect(answer).not.toContain("phantom");
    expect(citations.map((c) => c.ref)).toEqual(["a.md#H"]);
  });
});

describe("chooseSynthesizer", () => {
  const recall = (over: Partial<Config["recall"]>): Config["recall"] => ({
    synthesis: "none",
    account: "default",
    model: "claude-sonnet-5",
    context_chunks: 8,
    ...over,
  });

  it("picks none by default", () => {
    expect(chooseSynthesizer(recall({ synthesis: "none" })).kind).toBe("none");
  });

  it("picks anthropic when configured and a key is present", () => {
    __setSecretForTesting("anthropic:with-key", "sk-test");
    expect(chooseSynthesizer(recall({ synthesis: "anthropic", account: "with-key" })).kind).toBe(
      "anthropic",
    );
    __setSecretForTesting("anthropic:with-key", undefined);
  });

  it("falls back to none when anthropic is set but no key exists", () => {
    __setSecretForTesting("anthropic:no-key", undefined);
    expect(chooseSynthesizer(recall({ synthesis: "anthropic", account: "no-key" })).kind).toBe(
      "none",
    );
  });
});
