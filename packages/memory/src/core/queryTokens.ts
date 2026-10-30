/**
 * Query-side normalisation shared by every free-text search (lore FTS, the
 * dense query embed, file-card FTS, absence-marker matching).
 *
 * Agents phrase searches as sentences ("why does the kafka consumer group lag
 * in production") and the runner sends a ticket title. The FTS index has no
 * stopword list (porter unicode61) and the lexical query is OR-joined, so
 * before this module a sentence matched almost the whole corpus on "the" /
 * "in" / "for" alone: an off-topic question never reached the zero-hit path
 * (absence markers, "search wider" coaching) and the hits it did return were
 * noise presented as strong matches. Two rules fix that:
 *
 *   1. Stopwords are dropped from the query (never from the index). Negations
 *      ("not", "no", "never", "without") are deliberately KEPT: they carry
 *      meaning in lore ("do not change ..."). A query made only of stopwords
 *      falls back to its original terms so it still behaves as before.
 *   2. A lexical hit must match {@link minMatches} of the content terms
 *      (2, or a third rounded up for 7+ terms) once a query has
 *      {@link MIN_MATCH_FROM} or more of them. One- and two-term queries stay
 *      plain OR, which keeps the "deployment kafka still surfaces kafka-only
 *      records" behaviour the OR mode exists for. The bar is deliberately not
 *      "half": lore records are terse, and a 6-8 term ticket title ("Switch
 *      password storage from bcrypt to something stronger") typically shares
 *      only 2-3 key terms with the decision that binds it ("Use Argon2id for
 *      password hashing ... bcrypt is not allowed"). Half the terms dropped
 *      those to zero hits — the absence-coaching path, wrong when a binding
 *      decision exists — while 2 already kept off-topic sentences at zero on
 *      the audit's noise corpus.
 *
 * Terms are whitespace-separated parts (each still matched by FTS as a quoted
 * phrase, so `snake_case_name` keeps its phrase semantics); a part counts as a
 * stopword only when every letter/digit run in it is one, using the same
 * tokeniser the embedder uses (so `the,` and `Why` are recognised). A part
 * with no letter/digit run at all (the " - " in "Area - do X") is dropped too.
 */
import { tokenise } from "./embedding.js";

/** Small English stopword set. Negations are intentionally absent (see module doc). */
const STOPWORDS: ReadonlySet<string> = new Set(
  (
    "a about above after again all also am an and any are as at be because been " +
    "before being below between both but by can could did do does doing done " +
    "down during each else every for from further had has have having he her " +
    "here hers him his how i if in into is it its itself just me more most my of " +
    "off on once onto only or other our ours out over own per s same shall she " +
    "should so some such t than that the their theirs them then there these they " +
    "this those through to too under until up us very via was we were what when " +
    "where which while who whom whose why will with would you your yours"
  ).split(" "),
);

/** "can't", "don't", "won't", "isn't" (ASCII or typographic apostrophe). */
const NEGATED_CONTRACTION = /n['\u2019]t$/i;

/** Queries with this many content terms or more must match {@link minMatches} of them. */
export const MIN_MATCH_FROM = 3;
/**
 * Cap on content terms in one lexical query. The min-match rule is an OR of
 * AND-groups (C(n, minMatches(n)) of them: 56 at n = 8), so n is bounded; the
 * longest terms are kept — a cheap specificity proxy. The dense side still
 * embeds every content term.
 */
export const MAX_QUERY_TERMS = 8;

/**
 * How many of `n` content terms a lexical hit must match: every term below
 * {@link MIN_MATCH_FROM} (plain OR, i.e. 1), otherwise max(2, ceil(n / 3)) —
 * 2 up to six terms, 3 for seven or eight (see the module doc for why not half).
 */
export function minMatches(n: number): number {
  if (n < MIN_MATCH_FROM) return 1;
  return Math.max(2, Math.ceil(n / 3));
}

export function isStopword(token: string): boolean {
  return STOPWORDS.has(token);
}

export interface QueryTerms {
  /** Whitespace parts with `"` stripped, de-duplicated case-insensitively, in query order. */
  readonly terms: string[];
  /** True when every part was a stopword (or punctuation) and `terms` is the original, unfiltered list. */
  readonly allStopwords: boolean;
}

/** Split a free-text query into its content terms (see the module doc). */
export function queryTerms(input: string): QueryTerms {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const raw of input.split(/\s+/)) {
    const p = raw.replace(/"/g, "");
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(p);
  }
  const content = parts.filter((p) => {
    const toks = tokenise(p);
    // A part with no letters/digits ("-", "/", "&", an em dash) is not a content
    // term: its FTS phrase matches nothing, yet it would still count toward the
    // min-match rule and dilute it.
    // A negated contraction ("can't", "don't", "isn't") splits into stopword
    // runs ("can" + "t") but is a negation, which the module doc keeps.
    return toks.length > 0 && (toks.some((t) => !STOPWORDS.has(t)) || NEGATED_CONTRACTION.test(p));
  });
  // All stopwords and/or punctuation: fall back to the original parts.
  if (content.length === 0) return { terms: parts, allStopwords: parts.length > 0 };
  return { terms: content, allStopwords: false };
}

/** The query text the dense side should embed: content terms only. */
export function denseQueryText(input: string): string {
  return queryTerms(input).terms.join(" ");
}

function combinations<T>(items: ReadonlyArray<T>, k: number): T[][] {
  const out: T[][] = [];
  const pick: T[] = [];
  const walk = (start: number): void => {
    if (pick.length === k) {
      out.push([...pick]);
      return;
    }
    for (let i = start; i <= items.length - (k - pick.length); i++) {
      pick.push(items[i]!);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return out;
}

/**
 * Translate a free-text query into an FTS5 MATCH expression. Every term is a
 * quoted phrase (stops users tripping FTS operators: NEAR, OR, ", :, ...).
 * With `prefix`, a term of 3+ chars matches as a prefix ("timez" → "timezone")
 * — never a stopword (the all-stopword fallback), since "the*" matches "theme".
 * Ranking stays bm25's job: records matching MORE terms rank first.
 */
export function toFtsMatch(input: string, prefix: boolean): string {
  const { terms, allStopwords } = queryTerms(input);
  if (terms.length === 0) return '""';
  let kept = terms;
  if (kept.length > MAX_QUERY_TERMS) {
    const keep = new Set(
      kept
        .map((t, i) => ({ t, i }))
        .sort((a, b) => b.t.length - a.t.length || a.i - b.i)
        .slice(0, MAX_QUERY_TERMS)
        .map((x) => x.i),
    );
    kept = kept.filter((_, i) => keep.has(i));
  }
  const quoted = kept.map((p) => (prefix && !allStopwords && p.length >= 3 ? `"${p}"*` : `"${p}"`));
  if (quoted.length === 1) return quoted[0]!;
  if (quoted.length < MIN_MATCH_FROM || allStopwords) return quoted.join(" OR ");
  return combinations(quoted, minMatches(quoted.length))
    .map((g) => `(${g.join(" AND ")})`)
    .join(" OR ");
}
