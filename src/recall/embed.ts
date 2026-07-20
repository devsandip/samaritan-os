/**
 * Embeddings (TECH-SPEC §7, "Embeddings").
 *
 * Local by default, in-process, so raw text never leaves the machine (§9). The
 * first call downloads the model and takes the better part of a minute, so the
 * pipeline is built once and reused; every later call is fast.
 *
 * Vectors are stored as float32 BLOBs, which is what sqlite-vec reads. That
 * means the on-disk format is tied to the model's dimension, so switching models
 * invalidates the index. `dimensions()` is exposed for exactly that check.
 */
import { log } from "../logger.js";

const logger = log("recall.embed");

export interface Embedder {
  /** Model id, recorded alongside the index so a change can be detected. */
  readonly model: string;
  dimensions(): Promise<number>;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Serialises a vector for a BLOB column. */
export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(0));
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // Copied rather than viewed: node:sqlite reuses its buffers, so a view would
  // change out from under the caller on the next row read.
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const norm = Math.sqrt(na) * Math.sqrt(nb);
  return norm === 0 ? 0 : dot / norm;
}

type Extractor = (
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

/**
 * `@huggingface/transformers` running the ONNX model in-process.
 *
 * §7 names `@xenova/transformers`, which is the same library before it moved
 * under the Hugging Face org and stopped being updated. The project already
 * rejected one archived dependency (keytar) for that reason, so this follows the
 * spec's intent rather than its spelling. The model id is unchanged.
 */
export class LocalEmbedder implements Embedder {
  #extractor: Promise<Extractor> | undefined;
  #dimensions: number | undefined;

  constructor(readonly model = "Xenova/all-MiniLM-L6-v2") {}

  async #pipeline(): Promise<Extractor> {
    if (!this.#extractor) {
      logger.info({ model: this.model }, "loading embedding model (first call downloads it)");
      this.#extractor = (async () => {
        const { pipeline, env } = await import("@huggingface/transformers");
        // The model comes from the hub cache, not from the vault. Without this
        // a path that looks model-shaped could be read off disk.
        env.allowLocalModels = false;
        return (await pipeline("feature-extraction", this.model)) as unknown as Extractor;
      })();
    }
    return this.#extractor;
  }

  async dimensions(): Promise<number> {
    if (this.#dimensions === undefined) {
      const [probe] = await this.embed(["dimension probe"]);
      this.#dimensions = probe?.length ?? 0;
    }
    return this.#dimensions;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const extractor = await this.#pipeline();
    // Normalised at the source so cosine similarity is a dot product and
    // sqlite-vec's L2 distance ranks identically to cosine.
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist().map((row) => Float32Array.from(row));
  }
}

/**
 * A deterministic stand-in used by tests.
 *
 * Hashing tokens into a small vector is not semantic, but it is stable, instant,
 * and shares the real embedder's contract, so the pipeline around it can be
 * tested without a 90MB download or a network call in CI.
 */
export class HashEmbedder implements Embedder {
  readonly model = "hash-test-embedder";

  constructor(private readonly size = 64) {}

  async dimensions(): Promise<number> {
    return this.size;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => {
      const vector = new Float32Array(this.size);
      for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let hash = 0;
        for (let i = 0; i < token.length; i++) hash = (hash * 31 + token.charCodeAt(i)) | 0;
        const slot = Math.abs(hash) % this.size;
        vector.set([(vector[slot] ?? 0) + 1], slot);
      }
      let norm = 0;
      for (const value of vector) norm += value * value;
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < vector.length; i++) {
          const value = vector[i] ?? 0;
          vector.set([value / norm], i);
        }
      }

      return vector;
    });
  }
}

export function createEmbedder(provider: string, model: string): Embedder {
  if (provider !== "local") {
    // §7 lists openai and voyage as opt-in upgrades. Neither is built, and
    // silently falling back to local would mean a config that says text leaves
    // the machine while it does not, or the reverse later. Fail loudly instead.
    throw new Error(
      `embeddings.provider "${provider}" is not implemented; only "local" is available`,
    );
  }
  return new LocalEmbedder(model);
}
