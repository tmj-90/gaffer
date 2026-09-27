import { describe, expect, it } from "vitest";

import {
  HASHED_NGRAM_DIM,
  HASHED_NGRAM_MODEL,
  HashedNgramEmbedder,
  cosine,
  deserialiseVector,
  hybridRetrievalEnabled,
  l2Normalise,
  loreEmbeddingText,
  serialiseVector,
  tokenise,
} from "../src/core/embedding.js";
import { fuseHybrid } from "../src/core/lore.js";

const E = new HashedNgramEmbedder();

describe("tokenise", () => {
  it("lowercases, folds diacritics and splits on non-alphanumerics", () => {
    expect(tokenise("Kafka-Consumer  RETRY_policy: café v2")).toEqual([
      "kafka",
      "consumer",
      "retry",
      "policy",
      "cafe",
      "v2",
    ]);
  });
  it("returns [] for empty / punctuation-only input", () => {
    expect(tokenise("")).toEqual([]);
    expect(tokenise("--- !!! ...")).toEqual([]);
  });
});

describe("HashedNgramEmbedder", () => {
  it("is deterministic and unit-length", () => {
    const a = E.embed("Kafka consumer retry policy");
    const b = E.embed("Kafka consumer retry policy");
    expect(a).toEqual(b);
    expect(a.length).toBe(HASHED_NGRAM_DIM);
    let norm = 0;
    for (const x of a) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
    expect(E.model).toBe(HASHED_NGRAM_MODEL);
  });

  it("embeds empty text to the zero vector (cosine 0 against anything)", () => {
    const z = E.embed("");
    expect(Array.from(z).every((x) => x === 0)).toBe(true);
    expect(cosine(z, E.embed("anything"))).toBe(0);
  });

  it("puts a typo closer to the intended term than to an unrelated one", () => {
    const kafka = E.embed("Kafka consumer retry policy");
    const typo = E.embed("kafak retry");
    const unrelated = E.embed("timezone handling in payments");
    expect(cosine(typo, kafka)).toBeGreaterThan(cosine(typo, unrelated));
    expect(cosine(typo, kafka)).toBeGreaterThan(0.25);
    expect(cosine(typo, unrelated)).toBeLessThan(0.15);
  });

  it("matches a differently split compound ('time out' vs 'timeout')", () => {
    const rec = E.embed("HTTP client timeout defaults");
    expect(cosine(E.embed("http time out"), rec)).toBeGreaterThan(0.25);
  });

  it("is case- and punctuation-insensitive", () => {
    expect(cosine(E.embed("Retry-Policy!"), E.embed("retry policy"))).toBeCloseTo(1, 5);
  });

  it("rejects an unusably small dimension", () => {
    expect(() => new HashedNgramEmbedder(8)).toThrow(/dim/);
  });
});

describe("vector storage round trip", () => {
  it("serialise → deserialise is exact for float32", () => {
    const v = E.embed("round trip");
    const back = deserialiseVector(serialiseVector(v), v.length);
    expect(back).toEqual(v);
  });
  it("deserialise rejects a byte length that does not match dim", () => {
    expect(() => deserialiseVector(Buffer.alloc(8), 4)).toThrow(/expected 16/);
  });
  it("l2Normalise leaves a zero vector at zero", () => {
    const z = l2Normalise(new Float32Array(4));
    expect(Array.from(z)).toEqual([0, 0, 0, 0]);
  });
  it("cosine rejects mismatched lengths", () => {
    expect(() => cosine(new Float32Array(2), new Float32Array(3))).toThrow(/mismatch/);
  });
});

describe("loreEmbeddingText", () => {
  it("weights the title double and omits the body", () => {
    expect(loreEmbeddingText("T", "S")).toBe("T\nT\nS");
  });
});

describe("hybridRetrievalEnabled", () => {
  it("defaults on and is disabled only by the literal '0'", () => {
    expect(hybridRetrievalEnabled({})).toBe(true);
    expect(hybridRetrievalEnabled({ MEMORY_HYBRID_RETRIEVAL: "1" })).toBe(true);
    expect(hybridRetrievalEnabled({ MEMORY_HYBRID_RETRIEVAL: "false" })).toBe(true);
    expect(hybridRetrievalEnabled({ MEMORY_HYBRID_RETRIEVAL: "0" })).toBe(false);
  });
});

describe("fuseHybrid (pure fusion contract)", () => {
  const r = (id: string) => ({ id });
  it("normalises bm25 to (0,1] with the top lexical hit at 1 and tags sides", () => {
    const out = fuseHybrid(
      [
        { row: r("a"), score: -10 },
        { row: r("b"), score: -5 },
      ],
      [{ row: r("c"), cosine: 0.6 }],
    );
    const byId = new Map(out.map((o) => [o.row.id, o]));
    expect(byId.get("a")).toMatchObject({ fused: 1, lexScore: -10, retrieval: "lexical" });
    expect(byId.get("b")).toMatchObject({ fused: 0.5, lexScore: -5, retrieval: "lexical" });
    expect(byId.get("c")).toMatchObject({ fused: 0.3, lexScore: undefined, retrieval: "dense" });
  });
  it("a record found by both sides gets the sum and retrieval 'both'", () => {
    const out = fuseHybrid([{ row: r("a"), score: -4 }], [{ row: r("a"), cosine: 0.5 }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fused: 1.25, lexScore: -4, retrieval: "both" });
  });
  it("a dense-only hit can never outrank the top lexical hit", () => {
    const out = fuseHybrid([{ row: r("lex"), score: -0.001 }], [{ row: r("dense"), cosine: 1 }]);
    const byId = new Map(out.map((o) => [o.row.id, o.fused]));
    expect(byId.get("lex")!).toBeGreaterThan(byId.get("dense")!);
  });
  it("all-zero bm25 scores (degenerate tiny corpus) still normalise to 1", () => {
    const out = fuseHybrid([{ row: r("a"), score: 0 }], []);
    expect(out[0]!.fused).toBe(1);
  });
});
