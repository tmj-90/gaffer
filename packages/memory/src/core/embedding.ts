/**
 * Dense retrieval side of hybrid lore search.
 *
 * `searchLore` ranks by SQLite FTS5 bm25 (lexical). Lexical-only retrieval has
 * a known blind spot: a typo ("kafak"), a morphological form the Porter
 * stemmer does not fold, or a term split differently from the record
 * ("time out" vs "timeout") returns zero hits even though the record is
 * obviously the one the agent needs. The dense side closes that gap: every
 * record carries a fixed-size vector, the query is embedded the same way,
 * and cosine similarity surfaces near-misses that FTS cannot see. The two
 * result lists are then fused (see `fuseHybrid` in lore.ts).
 *
 * An {@link Embedder} is the seam. The built-in {@link HashedNgramEmbedder}
 * needs no model, network or credential: it is the classic hashing trick over
 * word unigrams, word bigrams and character trigrams, signed and L2
 * normalised, so it is deterministic, cheap (microseconds per record) and
 * reproducible across machines — the vectors it stores are as portable as the
 * SQLite file. It captures surface similarity (typos, inflections, shared
 * subwords), NOT meaning: two paraphrases with no shared characters do not
 * match. A model-backed embedder (local ONNX, or an HTTP embedding API) plugs
 * in behind the same interface; its `model` id keys the stored vectors so a
 * switch re-embeds lazily instead of mixing spaces.
 */

import { createHash } from "node:crypto";

/** A text → fixed-dimension unit vector function. Must be pure and deterministic. */
export interface Embedder {
  /** Identifier stored beside every vector; a change re-embeds the corpus lazily. */
  readonly model: string;
  /** Vector length. Every `embed` result has exactly this many components. */
  readonly dim: number;
  /** Embed one text. Returns an L2-normalised vector (or all zeros for empty text). */
  embed(text: string): Float32Array;
}

/** Default dimension of the hashed n-gram space. */
export const HASHED_NGRAM_DIM = 256;
/** Model id of the built-in embedder (bump on any change to its features/weights). */
export const HASHED_NGRAM_MODEL = "hashed-ngram-v1";

const W_UNIGRAM = 1.0;
const W_BIGRAM = 0.75;
const W_TRIGRAM = 0.5;

/** FNV-1a 32-bit over a UTF-16 string. Fast, well distributed, no dependency. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Lowercase, fold diacritics, and split on anything that is not a letter or
 * digit. Exported for tests and for callers that want to see what the
 * embedder sees.
 */
export function tokenise(text: string): string[] {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The built-in, credential-free embedder (see the module doc). */
export class HashedNgramEmbedder implements Embedder {
  readonly model = HASHED_NGRAM_MODEL;
  readonly dim: number;

  constructor(dim: number = HASHED_NGRAM_DIM) {
    if (!Number.isInteger(dim) || dim < 16)
      throw new Error(`embedding dim must be >= 16 (got ${dim})`);
    this.dim = dim;
  }

  embed(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    const tokens = tokenise(text);
    const add = (feature: string, weight: number): void => {
      const h = fnv1a(feature);
      // Low bits pick the bucket; an independent high bit picks the sign, so
      // unrelated features cancel rather than pile up (signed hashing trick).
      const idx = h % this.dim;
      const sign = (h >>> 16) & 1 ? 1 : -1;
      v[idx] = (v[idx] ?? 0) + sign * weight;
    };
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      add(`w:${t}`, W_UNIGRAM);
      const padded = `_${t}_`;
      for (let j = 0; j + 3 <= padded.length; j++) add(`c:${padded.slice(j, j + 3)}`, W_TRIGRAM);
      if (i + 1 < tokens.length) add(`b:${t} ${tokens[i + 1]!}`, W_BIGRAM);
    }
    return l2Normalise(v);
  }
}

/** Scale `v` to unit length in place; an all-zero vector stays zero. */
export function l2Normalise(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  if (sum === 0) return v;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! * inv;
  return v;
}

/** Cosine similarity of two vectors of equal length (unit vectors → plain dot). */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`vector length mismatch (${a.length} vs ${b.length})`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Little-endian float32 bytes for storage in a BLOB column. */
export function serialiseVector(v: Float32Array): Buffer {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i]!, i * 4);
  return buf;
}

/** Inverse of {@link serialiseVector}. Alignment-safe (a SQLite BLOB may be unaligned). */
export function deserialiseVector(buf: Buffer, dim: number): Float32Array {
  if (buf.byteLength !== dim * 4) {
    throw new Error(`stored vector has ${buf.byteLength} bytes, expected ${dim * 4}`);
  }
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = buf.readFloatLE(i * 4);
  return v;
}

/**
 * The text a lore record is embedded from: title (weighted double by
 * repetition) + summary. The body is deliberately left out — it is the long
 * tail FTS already indexes, and folding hundreds of body n-grams into a
 * 256-dim vector drowns the curated signal the dense side is for.
 */
export function loreEmbeddingText(title: string, summary: string): string {
  return `${title}\n${title}\n${summary}`;
}

/** Content hash stored beside a vector so an unchanged record is never re-embedded. */
export function embeddingTextHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Whether hybrid (lexical + dense) retrieval is on. Default on; set
 * MEMORY_HYBRID_RETRIEVAL=0 for the pure bm25 ranking (the pre-hybrid
 * behaviour), e.g. to bisect a ranking surprise.
 */
export function hybridRetrievalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["MEMORY_HYBRID_RETRIEVAL"] !== "0";
}

let defaultEmbedder: Embedder | null = null;

/** The process-wide embedder. Only the built-in hashed n-gram embedder exists today. */
export function getEmbedder(): Embedder {
  if (!defaultEmbedder) defaultEmbedder = new HashedNgramEmbedder();
  return defaultEmbedder;
}
