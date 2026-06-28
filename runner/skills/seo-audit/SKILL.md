---
name: seo-audit
description: Use when auditing, reviewing, or diagnosing SEO issues on a site. Triggers on "SEO audit", "technical SEO", "why am I not ranking", "SEO issues", "on-page SEO", "meta tags review", or "SEO health check". For structured data specifically, use `schema-markup`. For AI-search citation optimisation, use `aeo`.
stack: []
area: marketing
---

# Audit SEO systematically

Three layers in impact order: technical (crawl/index/speed) → on-page (titles/headings/links) → content (intent match / E-E-A-T / thin pages). Fix the highest layer first.

## Core Web Vitals pass/fail thresholds (75th percentile real-user data)

| Metric | Good | Needs work | Poor |
|--------|------|-----------|------|
| LCP | ≤ 2.5s | 2.5–4.0s | > 4.0s |
| INP | ≤ 200ms | 200–500ms | > 500ms |
| CLS | ≤ 0.1 | 0.1–0.25 | > 0.25 |

## Technical layer (check first)

- **Crawlability** — `robots.txt` not blocking important paths; XML sitemap present and submitted to Search Console; no orphan pages (no internal links).
- **Indexation** — `noindex` not set on pages that should rank; canonical tags point to the correct URL; HTTPS on all pages.
- **Speed** — LCP from real-user data (Search Console → Core Web Vitals report); identify LCP element; check image optimisation + CDN + render-blocking resources.
- **Mobile** — Google uses mobile-first indexing; test with Mobile-Friendly Test.

## On-page layer

- **Title tags** — ≤ 60 chars; primary keyword near the front; unique per page; describes content accurately.
- **Meta descriptions** — ≤ 160 chars; includes a CTA-like phrase; unique per page.
- **H1** — one per page; matches or closely mirrors the title tag; primary keyword present.
- **Heading hierarchy** — H1 → H2 → H3 without gaps; no keyword stuffing.
- **Internal linking** — key pages linked from multiple internal pages; anchor text descriptive (not "click here").

## Content layer

- **Search intent match** — is the page format what the searcher expects? (Informational → guide/article; transactional → product/pricing page; navigational → homepage).
- **E-E-A-T signals** — author bio with credentials; publication date + last-updated date; primary-source citations; specific examples and data.
- **Thin/duplicate content** — pages with < 300 words of unique content; pages with duplicated sections across the site.
- **Keyword targeting** — primary keyword in title + H1 + first 100 words + URL slug; LSI terms used naturally in body.

## Steps

1. **Scope the audit.** Full site or specific pages? Technical + on-page, or one focus? Access to Search Console and analytics? Establish baseline: current organic traffic trend, target keywords, known issues.
2. **Technical audit.** Crawl with Screaming Frog or Search Console; flag crawl errors, indexation issues, redirect chains, broken internal links.
3. **Core Web Vitals.** Pull from Search Console → Core Web Vitals report (real-user data). Identify pages failing LCP/CLS; prioritise by traffic volume.
4. **On-page audit.** Check title tags, H1s, meta descriptions for top 20 pages by traffic. Flag duplicates, over-length, keyword mismatches.
5. **Content audit.** Identify thin pages (< 300 words unique); spot intent mismatches; E-E-A-T gaps.
6. **Prioritised recommendations.** Order by: impact × effort. Technical blocking issues first; then on-page quick wins; then content investment.
7. **Verify.** After implementing: recheck Search Console for crawl/index errors; re-run Lighthouse for CWV; confirm fixes appear in next crawl.

## Review checklist

- **No pages blocked in robots.txt that should rank.**
- **Sitemap submitted and valid** — no 4xx/5xx URLs in sitemap.
- **Title tags unique and ≤ 60 chars** on all indexed pages.
- **LCP ≤ 2.5s** on mobile for highest-traffic pages.
- **No thin-content pages** (< 300 words unique) ranking for commercial queries.
- **Internal links to key pages** from multiple relevant pages with descriptive anchor text.

## Rules

- Technical issues that block crawl/index are fixed before content work — no point optimising a page Google can't read.
- Never recommend keyword stuffing — intent match and E-E-A-T outperform density in modern search.
- Core Web Vitals from real-user data (Search Console) override Lighthouse scores — both matter but prioritise the real-user signal.

## References

`references/seo-audit-checklist.md` — full 80-point checklist by layer.
