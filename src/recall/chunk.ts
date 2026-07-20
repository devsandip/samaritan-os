/**
 * Markdown-aware chunking (TECH-SPEC §7, "Chunking").
 *
 * Split by heading first, then by paragraph within an oversized section, target
 * 500-800 tokens with ~15% overlap, and retain the frontmatter and heading path
 * as metadata. The heading path is the part that earns its keep: a citation that
 * says `Meetings/2026-06-30-vendor-review.md#pricing` is checkable, and one that
 * says "somewhere in this file" is not.
 *
 * Tokens are estimated rather than counted. A real tokenizer would tie chunking
 * to whichever embedding model is configured, and the sizes here are soft
 * targets feeding a similarity search, so being within ~20% is worth more than
 * being exact and coupled.
 */

/** Rough tokens-per-character for English prose. Deliberately approximate. */
const CHARS_PER_TOKEN = 4;

export interface ChunkOptions {
  targetTokens?: number;
  maxTokens?: number;
  /** Fraction of the previous chunk repeated at the head of the next. */
  overlap?: number;
}

const DEFAULTS = { targetTokens: 650, maxTokens: 800, overlap: 0.15 } as const;

export interface Chunk {
  text: string;
  /** `##`-joined heading path, e.g. "Vendor review ## Pricing". Empty at root. */
  heading: string;
  index: number;
}

export interface ParsedDocument {
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Splits YAML-ish frontmatter off the top of a markdown file.
 *
 * Deliberately not a YAML parse: frontmatter here is metadata for retrieval
 * (date, tags), a malformed block should degrade to "no frontmatter" rather than
 * fail the file, and pulling in a parser to read `key: value` lines would be the
 * expensive way to be slightly more correct.
 */
export function parseFrontmatter(source: string): ParsedDocument {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { frontmatter: {}, body: source };

  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (pair?.[1]) frontmatter[pair[1]] = (pair[2] ?? "").trim();
  }
  return { frontmatter, body: source.slice(match[0].length) };
}

interface Section {
  heading: string;
  lines: string[];
}

/** Splits on ATX headings, carrying the full path down rather than just the last one. */
function sections(body: string): Section[] {
  const out: Section[] = [];
  const path: string[] = [];
  let current: Section = { heading: "", lines: [] };

  for (const line of body.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      current.lines.push(line);
      continue;
    }
    if (current.lines.some((l) => l.trim())) out.push(current);

    const depth = (heading[1] ?? "#").length;
    // A deeper heading nests; a shallower one pops back to its own level. Fenced
    // code can contain a line starting with '#', which is why this only ever
    // affects the heading path and never drops content.
    path.length = Math.min(path.length, depth - 1);
    path[depth - 1] = (heading[2] ?? "").trim();
    current = { heading: path.filter(Boolean).join(" ## "), lines: [] };
  }
  if (current.lines.some((l) => l.trim())) out.push(current);
  return out;
}

const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** Splits an oversized section on paragraph boundaries, with overlap. */
function splitLong(text: string, opts: Required<ChunkOptions>): string[] {
  const paragraphs = text.split(/\r?\n\s*\r?\n/).filter((p) => p.trim());
  const out: string[] = [];
  let buffer: string[] = [];

  const flush = () => {
    if (!buffer.length) return;
    const joined = buffer.join("\n\n");
    out.push(joined);
    // Carry the tail of this chunk into the next so a fact split across the
    // boundary is still retrievable from one side of it.
    const carry = Math.floor(joined.length * opts.overlap);
    buffer = carry > 0 ? [joined.slice(-carry)] : [];
  };

  for (const paragraph of paragraphs) {
    const candidate = [...buffer, paragraph].join("\n\n");
    if (buffer.length && estimateTokens(candidate) > opts.targetTokens) flush();

    // A single paragraph over the hard cap is split on whitespace: rare in
    // prose, common in a pasted log or a minified blob, and one chunk the
    // embedder truncates is worse than two it reads whole.
    if (estimateTokens(paragraph) > opts.maxTokens) {
      const size = opts.targetTokens * CHARS_PER_TOKEN;
      for (let i = 0; i < paragraph.length; i += size) {
        out.push(paragraph.slice(i, i + size));
      }
      buffer = [];
      continue;
    }
    buffer.push(paragraph);
  }
  if (buffer.some((b) => b.trim())) out.push(buffer.join("\n\n"));
  return out.filter((c) => c.trim());
}

/**
 * Chunks a markdown document. Frontmatter is returned separately rather than
 * embedded: `tags: [x]` matches every document that shares a tag and drags
 * unrelated results in with it.
 */
export function chunkMarkdown(source: string, options: ChunkOptions = {}): Chunk[] {
  const opts = { ...DEFAULTS, ...options };
  const { body } = parseFrontmatter(source);

  const chunks: Chunk[] = [];
  for (const section of sections(body)) {
    const text = section.lines.join("\n").trim();
    if (!text) continue;

    const parts =
      estimateTokens(text) <= opts.maxTokens ? [text] : splitLong(text, opts);
    for (const part of parts) {
      chunks.push({ text: part.trim(), heading: section.heading, index: chunks.length });
    }
  }
  return chunks;
}

/**
 * Chunks plain text that has no heading structure, e.g. an audit trail rendered
 * for indexing. Same size budget, no heading path to carry.
 */
export function chunkPlain(source: string, options: ChunkOptions = {}): Chunk[] {
  const opts = { ...DEFAULTS, ...options };
  const text = source.trim();
  if (!text) return [];

  const parts = estimateTokens(text) <= opts.maxTokens ? [text] : splitLong(text, opts);
  return parts.map((part, index) => ({ text: part.trim(), heading: "", index }));
}
