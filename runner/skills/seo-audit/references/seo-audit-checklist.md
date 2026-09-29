# SEO Audit Checklist

Walk this checklist in order. Each unchecked item becomes a finding that records the
URL(s), the evidence and the fix. Sources are Google Search Central (Search Essentials,
the SEO Starter Guide, the crawling and indexing docs, the helpful-content guidance, the
Core Web Vitals docs) and web.dev.

## 1. Crawl & index (blocking — fix first)

### Status & redirects
- [ ] Every URL that should rank returns 200.
- [ ] Moved URLs 301 straight to the final URL. There are no chains longer than 1 hop
      and no loops.
- [ ] HTTP → HTTPS and non-canonical host → canonical host each redirect in one hop.
- [ ] No soft 404s: "not found" or empty pages do not return 200.

### robots.txt & robots directives
- [ ] robots.txt is reachable and does not disallow ranking pages or the CSS/JS needed
      to render them.
- [ ] No `noindex` (meta or `X-Robots-Tag`) on pages that should rank.
- [ ] Pages that must stay out of the index use `noindex` and are **not**
      robots-blocked, because Google has to crawl a page to see the tag.
- [ ] No unintended `nosnippet` or `max-snippet:0`, which also removes a page from AI
      features.

### Canonicalisation
- [ ] Every indexable page has an absolute, self-referencing `rel=canonical`.
- [ ] Duplicates and parameter variants canonicalise to one URL.
- [ ] No canonical points to a redirect, a 404, a noindexed URL or another language.

### Sitemaps
- [ ] The XML sitemap lists only canonical, indexable 200 URLs.
- [ ] It is referenced in robots.txt and submitted in Search Console.
- [ ] Its `lastmod` values are accurate: set when the page changes, not on every
      build.

### Rendering & links
- [ ] The main content is present in the rendered HTML (URL Inspection → crawled page).
- [ ] Navigation uses `<a href>` links that crawlers can follow.
- [ ] Important pages sit within about 3 clicks of the homepage. No orphan pages.
- [ ] Paginated series link to their pages with plain links. Google ignores
      `rel=prev/next`.

### Search Console
- [ ] The Page indexing report's "Not indexed" reasons are explained for important
      URLs.
- [ ] There are no manual actions or security issues.

## 2. Content & intent

- [ ] The page type matches the dominant intent of the target query (compare against
      the current top results).
- [ ] The content answers the query fully, with first-hand experience, original data or
      expertise where relevant.
- [ ] A clear author and dates (published and updated) are shown where readers expect
      them.
- [ ] Claims cite their sources, and outdated statistics are updated.
- [ ] No two pages compete for the same query (cannibalisation). Consolidate or
      differentiate them.
- [ ] No scaled, auto-generated or doorway pages made mainly to rank.
- [ ] Thin pages are improved, merged or noindexed. Judge thinness by usefulness, not by
      word count.

## 3. On-page

### Titles & descriptions
- [ ] Every indexable page has a unique, descriptive `<title>` that leads with its
      topic (about 50–60 characters are shown).
- [ ] Meta descriptions are unique summaries of the page, not boilerplate.

### Headings & structure
- [ ] One clear `<h1>` states the page topic.
- [ ] h2/h3 follow the content's logical structure.

### Internal links
- [ ] Key pages are linked from several relevant pages with descriptive anchor text
      (not "click here").
- [ ] There are no broken internal links (4xx/5xx).
- [ ] Breadcrumbs appear on deep sections, with `BreadcrumbList` markup (see the
      schema-markup skill).

### Images & media
- [ ] Informative images have descriptive `alt` text. Decorative ones use `alt=""`.
- [ ] Images declare `width`/`height`, use modern formats (AVIF/WebP) and are
      responsive (`srcset`).
- [ ] Video pages have an indexable watch page and `VideoObject` markup.

### Structured data
- [ ] JSON-LD parses and has zero errors in the Rich Results Test.
- [ ] Every marked-up value is visible on the page.
- [ ] No markup relies on retired features (FAQ and HowTo rich results, the sitelinks
      search box).

## 4. Page experience

- [ ] Field Core Web Vitals, at the 75th percentile (Search Console or CrUX), are:
      LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1.
- [ ] The LCP element is known. If it is an image, it is not lazy-loaded, has
      `fetchpriority="high"` and is served from a fast origin or CDN.
- [ ] No layout shift from late fonts, ads or embeds (reserve their space).
- [ ] Pages render correctly at a 375 px viewport with the viewport meta tag, have no
      horizontal scroll, and have tap targets ≥ 24×24 px (WCAG 2.2 AA; 44 px is
      preferred).
- [ ] HTTPS is on every page, with no mixed content.
- [ ] No intrusive interstitials cover the content on mobile.

## 5. International (if applicable)

- [ ] `hreflang` annotations are reciprocal, include self-references and use valid
      language/region codes.
- [ ] `x-default` is set for language pickers or global pages.
- [ ] Each language version is canonical to itself, not to another language.
