/**
 * core/queryTokens — the shared query normaliser (audit: stopword-or-query).
 * Stopwords leave the query, negations stay, an all-stopword query falls back
 * to its original terms, and 3+ content terms must match at least half.
 */
import { describe, expect, it } from "vitest";

import { absenceQueryMatches, normaliseAbsenceQuery } from "../src/core/absence.js";
import {
  MAX_QUERY_TERMS,
  denseQueryText,
  isStopword,
  queryTerms,
  toFtsMatch,
} from "../src/core/queryTokens.js";

describe("queryTerms", () => {
  it("drops stopwords using the embedder's tokeniser (punctuation and case don't hide them)", () => {
    expect(queryTerms("Why does the, kafka consumer lag?").terms).toEqual([
      "kafka",
      "consumer",
      "lag?",
    ]);
  });

  it("keeps negations — they carry meaning in lore", () => {
    expect(queryTerms("do not cache without a ttl").terms).toEqual([
      "not",
      "cache",
      "without",
      "ttl",
    ]);
    for (const w of ["not", "no", "never", "without"]) expect(isStopword(w)).toBe(false);
  });

  it("falls back to the original terms when every term is a stopword", () => {
    expect(queryTerms("the of and to")).toEqual({
      terms: ["the", "of", "and", "to"],
      allStopwords: true,
    });
  });

  it("keeps a compound part whose sub-tokens are not all stopwords", () => {
    expect(queryTerms("us-east-1 it's snake_case_name").terms).toEqual([
      "us-east-1",
      "snake_case_name",
    ]);
  });

  it("de-duplicates case-insensitively", () => {
    expect(queryTerms("Kafka kafka KAFKA retry").terms).toEqual(["Kafka", "retry"]);
  });

  it("denseQueryText embeds content terms only", () => {
    expect(denseQueryText("what is the retry policy for kafka")).toBe("retry policy kafka");
  });
});

describe("toFtsMatch", () => {
  it("one and two content terms stay plain OR (partial matches surface)", () => {
    expect(toFtsMatch("kafka", false)).toBe('"kafka"');
    expect(toFtsMatch("the deployment of kafka", false)).toBe('"deployment" OR "kafka"');
  });

  it("3+ content terms require at least half to match", () => {
    expect(toFtsMatch("kafka consumer lag", false)).toBe(
      '("kafka" AND "consumer") OR ("kafka" AND "lag") OR ("consumer" AND "lag")',
    );
    // 4 terms → any 2 of them: C(4, 2) = 6 AND-groups. 5 terms → any 3: C(5, 3) = 10.
    expect(toFtsMatch("kafka consumer group lag", false).split(" OR ")).toHaveLength(6);
    expect(toFtsMatch("kafka consumer group lag spike", false).split(" OR ")).toHaveLength(10);
  });

  it("never prefixes a stopword ('the*' would match theme / there)", () => {
    expect(toFtsMatch("the timez", true)).toBe('"timez"*');
    expect(toFtsMatch("the and", true)).toBe('"the" OR "and"');
  });

  it("strips double quotes so users cannot trip FTS operators", () => {
    expect(toFtsMatch('"kafka" NEAR', false)).toBe('"kafka" OR "NEAR"');
  });

  it("caps the term count, keeping the longest terms", () => {
    const q = "aa bb cc dd ee ff gg hh iiiiii jjjjjj";
    const m = toFtsMatch(q, false);
    expect(m).toContain('"iiiiii"');
    expect(m).toContain('"jjjjjj"');
    const distinct = new Set(m.match(/"[^"]+"/g));
    expect(distinct.size).toBe(MAX_QUERY_TERMS);
  });

  it("an empty query is the empty phrase", () => {
    expect(toFtsMatch("   ", false)).toBe('""');
  });
});

describe("absence matching ignores stopwords on either side", () => {
  it("'the retry policy' marker matches a 'retry policy timeout' query", () => {
    const marker = normaliseAbsenceQuery("the retry policy");
    expect(absenceQueryMatches(marker, normaliseAbsenceQuery("retry policy timeout"))).toBe(true);
    // Still containment, not overlap: a shared content term alone never matches.
    expect(
      absenceQueryMatches(
        normaliseAbsenceQuery("retry policy"),
        normaliseAbsenceQuery("the policy on timeouts"),
      ),
    ).toBe(false);
  });
});
