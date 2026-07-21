/**
 * The Recall service (TECH-SPEC §5.5, §7).
 *
 * One method every question flows through. `query()` retrieves the passages (the
 * semantic path), synthesises an answer over them, validates the citations, and
 * returns `{ answer, citations, retrieval_path }`.
 *
 * `retrieval_path` is always "semantic". The structured SQL path (§7 step 2,
 * querying the mirror tables) is not built, so labelling an answer "hybrid" — as
 * the spec's example does — would name a path that never ran. The label reports
 * what actually happened, which is the same honesty the citation guardrail
 * enforces one level down.
 *
 * The embedder and synthesiser are resolved from config once, at construction,
 * and both are injectable so the service can be tested without a model download
 * or a network call.
 */
import type { Config } from "../config/index.js";
import { log } from "../logger.js";
import type { Db } from "../store/db.js";
import { createEmbedder, type Embedder } from "./embed.js";
import { indexStats, type IndexStats } from "./index-store.js";
import { reindex, type IndexTally } from "./indexer.js";
import { retrieve } from "./retrieve.js";
import { chooseSynthesizer, validateCitations, type Citation, type Synthesizer } from "./synthesize.js";

const logger = log("recall");

export type RetrievalPath = "structured" | "semantic" | "hybrid";

export interface RecallAnswer {
  answer: string;
  citations: Citation[];
  retrieval_path: RetrievalPath;
}

const NOTHING_FOUND = "I couldn't find anything about that in your notes, journals or audit trail.";

export interface RecallDeps {
  db: Db;
  config: Config;
  /** Injectable for tests; defaults to the configured embedder. */
  embedder?: Embedder;
  /** Injectable for tests; defaults to the config-chosen synthesiser. */
  synthesizer?: Synthesizer;
}

export class RecallService {
  readonly #db: Db;
  readonly #config: Config;
  readonly #embedder: Embedder;
  readonly #synth: Synthesizer;
  readonly #contextChunks: number;

  constructor(deps: RecallDeps) {
    this.#db = deps.db;
    this.#config = deps.config;
    this.#embedder =
      deps.embedder ?? createEmbedder(deps.config.embeddings.provider, deps.config.embeddings.model);
    this.#synth = deps.synthesizer ?? chooseSynthesizer(deps.config.recall);
    this.#contextChunks = deps.config.recall.context_chunks;
    logger.info({ synthesis: this.#synth.kind, embedder: this.#embedder.model }, "recall ready");
  }

  /**
   * Rebuilds the index from the vault, journals and audit trail, reusing this
   * service's embedder so querying and indexing share one loaded model. The
   * daemon calls it on a schedule; idempotent by content hash, so a re-run only
   * touches what changed.
   */
  async reindex(): Promise<IndexTally> {
    return reindex({
      db: this.#db,
      embedder: this.#embedder,
      vaultDir: this.#config.paths.vault,
      journalRoot: this.#config.paths.journals,
    });
  }

  async query(question: string, opts: { maxCitations?: number } = {}): Promise<RecallAnswer> {
    const retrieval_path: RetrievalPath = "semantic";
    const passages = await retrieve(this.#db, this.#embedder, question, {
      limit: this.#contextChunks,
    });
    if (!passages.length) {
      return { answer: NOTHING_FOUND, citations: [], retrieval_path };
    }

    const raw = await this.#synth.synthesize(question, passages);
    const { answer, citations } = validateCitations(raw, passages);
    const capped =
      opts.maxCitations === undefined ? citations : citations.slice(0, opts.maxCitations);
    return { answer, citations: capped, retrieval_path };
  }

  /** Index coverage, for the API's health surface and the CLI's summary. */
  stats(): IndexStats {
    return indexStats(this.#db);
  }
}
