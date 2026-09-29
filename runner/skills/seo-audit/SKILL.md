---
name: seo-audit
description: Use when auditing, reviewing, or diagnosing SEO issues on a site. Triggers on "SEO audit", "technical SEO", "why am I not ranking", "SEO issues", "on-page SEO", "meta tags review", or "SEO health check". For structured data specifically, use `schema-markup`. For AI-search citation optimisation, use `aeo`.
stack: []
area: marketing
---

# Audit SEO systematically

Work through the layers in impact order. First, can Google **crawl and index** the page?
Then does the page **match the searcher's intent** with helpful content? Then are titles,
links and page experience in order? A fix in a lower layer is worthless while a higher one
is broken. Base findings on Google Search Central (Search Essentials, the SEO Starter
Guide, the helpful-content guidance) and on real-user data, not folklore.

## Layer 1 — Crawl and index (blocking issues)

- **Status.** Pages meant to rank return 200. Moved pages use a single 301 hop to the
  final URL. Soft 404s ("not found" served with a 200) are fixed.
- **robots.txt.** It does not disallow pages that should rank, nor the CSS/JS needed to
  render them. Remember that robots.txt stops crawling, not indexing: use `noindex` to
  keep a page out.
- **Meta robots and `X-Robots-Tag`.** No stray `noindex` or `nosnippet` on pages that
  should rank.
- **Canonicals.** Each indexable page carries a self-referencing absolute
  `rel=canonical`, and duplicates point to one preferred URL. No canonical points at a
  redirect, a 404 or a noindexed URL.
- **Sitemap.** It contains only canonical 200 URLs, is referenced from robots.txt and is
  submitted in Search Console.
- **Rendering.** The main content and the links appear in the rendered HTML (URL
  Inspection → View crawled page). Links are real `<a href>` elements, not JS click
  handlers.
- **Search Console Page indexing report.** Explain each "Not indexed" reason that
  affects important URLs.

## Layer 2 — Content and intent

- **Intent match.** The page format is what the top results show for the query:
  a guide, a product page, a comparison or a tool.
- **Helpful, people-first content.** It shows first-hand experience or expertise,
  original information, sources, and a clear author and date. Word count is **not** a
  ranking factor. Judge thinness by whether the query is actually answered, not by a
  word threshold.
- **Duplication and cannibalisation.** Several pages targeting the same query should be
  consolidated or differentiated.
- **Scaled or low-value pages.** Mass-generated pages made to rank violate the spam
  policies. Improve them, consolidate them or noindex them.

## Layer 3 — On-page and experience

- **Title element.** Every page has a unique, descriptive title that leads with the
  topic. Google shows about 50–60 characters, so front-load; there is no hard limit.
- **Meta description.** Unique, and it summarises the page. It does not affect ranking,
  but it can raise clicks. Google may rewrite it.
- **Headings.** One clear `<h1>` for the topic, with a logical h2/h3 structure.
- **Internal links.** Important pages are reachable within a few clicks and linked with
  descriptive anchor text. No orphan pages.
- **Images.** Descriptive `alt` text. `width` and `height` set to prevent layout shift.
  Modern formats.
- **Core Web Vitals** (field data, 75th percentile, from the Search Console CWV report
  or CrUX):
  - LCP ≤ 2.5 s
  - INP ≤ 200 ms
  - CLS ≤ 0.1

  Lighthouse is lab data, useful for diagnosis but not for pass/fail. Google's
  mobile-friendly test was retired in December 2023: check mobile rendering with URL
  Inspection and a 375 px viewport instead.
- **HTTPS** everywhere, with no mixed content. `hreflang` is reciprocal where the site
  is multilingual.

## Steps

1. **Scope.** Decide between the whole site and a page set. Note which access you have
   (Search Console, analytics, a crawler). In the factory you have only the repo and a
   local build: audit the rendered output locally, and list every check that needs
   production, Search Console or field data as a follow-up for a human. Record the baseline: clicks, impressions,
   indexed pages and the target queries.
2. **Crawl.** Use Screaming Frog, `curl -sI` for status and headers, or a sitemap
   walk. Export status codes, canonicals, titles, h1s, meta robots and link depth.
3. **Work Layer 1**, then Layers 2 and 3, using
   `references/seo-audit-checklist.md`. Every finding records the URL(s), the evidence
   (a header, a screenshot or a report row) and the rule it breaks.
4. **Prioritise** by traffic affected × severity ÷ effort. Indexing blockers come
   first.
5. **Write the recommendations.** For each: what to change, where, the expected effect
   and how to verify it. In a repo, add automated checks where they are cheap. For
   example, a test asserting one `<h1>`, a canonical and a unique `<title>` per route,
   and a sitemap test asserting that every URL returns 200.
6. **Verify after the fix.** Use URL Inspection → "Test live URL", validate the fix in
   the Page indexing report, and compare field CWV after 28 days. In the factory these
   are post-deploy follow-ups; your verification is the in-repo tests from step 5.

## Done when

- Every important URL is confirmed crawlable, indexable and canonical, or its blocker
  is listed with evidence.
- Findings are ranked, each with a location, evidence, a fix and a verification step.
- Nothing in the report relies on retired or myth signals (see below).

## Anti-patterns (myths to drop)

- "LSI keywords", keyword density targets and "keyword in the first 100 words".
- Minimum word counts, or the idea that a longer page ranks better.
- `rel=prev/next` as a Google signal: Google does not use it (it said so in 2019, having
  ignored it for years).
- Treating a Lighthouse score as the CWV verdict.
- Using robots.txt to de-index a page. The page must be crawlable for Google to see
  its `noindex`.
