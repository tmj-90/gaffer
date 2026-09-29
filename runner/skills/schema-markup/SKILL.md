---
name: schema-markup
description: Use when implementing, auditing, or validating structured data (schema markup) on a website. Triggers on "structured data", "schema.org", "JSON-LD", "rich results", "rich snippets", "FAQ schema", "Product schema", "schema errors in Search Console", or "why no rich results". NOT for general SEO audits — use `seo-audit`. For AI-search citation optimisation, use `aeo`.
stack: []
area: marketing
---

# Implement structured data that is valid and eligible

Structured data uses the schema.org vocabulary to describe a page's content to machines.
Google supports JSON-LD, Microdata and RDFa, and **recommends JSON-LD**. Valid markup makes
a page *eligible* for a rich result. It never guarantees one, and it is not a ranking
factor in its own right. The two rules that matter most, from Google's structured data
guidelines:

- **Markup must describe content visible on the page.** A price, rating or FAQ that
  exists only in JSON-LD is a policy violation and can draw a manual action.
- **Use the most specific type that fits, and include every required property** listed
  on that feature's Google documentation page.

## Current Google support (verify the gallery before promising anything)

Google keeps retiring features, so check the Search Gallery and the documentation
changelog at developers.google.com/search before quoting a rich result to anyone.

| Type | Still useful for | Required (Google) — check the feature page |
|---|---|---|
| `Organization` | logo and knowledge panel details | none strictly; add `name`, `url`, `logo`, `sameAs` |
| `WebSite` (homepage) | the **site name** shown in results | `name`, `url` (the sitelinks search box was retired Nov 2024) |
| `BreadcrumbList` | breadcrumb trail in results | `itemListElement` of `ListItem` with `position`, `name`, `item` |
| `Article` / `BlogPosting` | article understanding, dates, author | none strictly; add `headline`, `image`, `datePublished`, `dateModified`, `author` |
| `Product` (+ `Offer`, `AggregateRating`, `Review`) | product snippets and merchant listings | `name`, plus one of `offers`, `review` or `aggregateRating` |
| `LocalBusiness` | local business details | `name`, `address` |
| `Event`, `Recipe`, `JobPosting`, `VideoObject`, `ProfilePage`, `DiscussionForumPosting` | their respective features | see each feature page |

**Retired or restricted:**

- **HowTo** rich results were removed in 2023.
- **FAQ** rich results were limited to authoritative government and health sites in
  2023, then stopped showing in Search on 7 May 2026. Existing `FAQPage` markup is
  harmless (other consumers may still read it), but it earns no Google rich result.
- **Sitelinks search box**: `WebSite` + `SearchAction` no longer does anything (retired
  November 2024).
- **Retired in Google's 2025 "simplifying search results" rounds:** e.g. Course Info,
  Claim Review, Estimated Salary, Learning Video, Special Announcement, Vehicle Listing
  and Practice Problems. The list has changed since (Book Actions was reinstated), so
  check the Search Gallery rather than this list.

## Placement

Use one `<script type="application/ld+json">` block per page, containing either one
entity or a `@graph` array that links the entities by `@id`. JSON-LD can go in `<head>` or
`<body>`, and Google also reads it when JavaScript injects it. Server-rendered markup is
still the safer default, because other consumers may not run JS.

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", "@id": "https://example.com/#org", "name": "Example", "url": "https://example.com/", "logo": "https://example.com/logo.png" },
    { "@type": "WebSite", "@id": "https://example.com/#site", "name": "Example", "url": "https://example.com/", "publisher": { "@id": "https://example.com/#org" } }
  ]
}
</script>
```

## Steps

**In the factory** the Rich Results Test, the Schema Markup Validator, Search Console
and URL Inspection are out of reach (no production access; WebFetch is denied). The
in-repo test in step 4 is your gate. List steps 1, 5 and 6 as follow-ups for a human
after deploy, and never claim a validator result you did not see.

1. **Inventory the current markup.** Run the Rich Results Test
   (search.google.com/test/rich-results) and the Schema Markup Validator
   (validator.schema.org), and review Search Console → Enhancements. List
   each page type with its markup, errors and warnings.
2. **Map page types to types**, using the table above:
   - homepage: `Organization` + `WebSite`
   - articles: `Article`
   - products: `Product`
   - inner pages: `BreadcrumbList`
   - anything else: the matching supported feature
3. **Generate the markup from the same data that renders the page**, such as a template
   or component props. Never hand-type values that could drift from the visible text.
   Dates are ISO 8601 with a timezone. URLs are absolute.
4. **Test it in the repo.** Add a test that parses the rendered HTML, `JSON.parse`s
   every `ld+json` block, and asserts that the required properties exist and that key
   values (name, price, date) equal the visible text. Invalid JSON silently drops the
   whole block.
5. **Validate** in the Rich Results Test with zero errors. Warnings concern recommended
   properties: fix the cheap ones.
6. **Monitor.** After deploy, use URL Inspection on a sample page. Over the following
   weeks, confirm that the Search Console enhancement report shows the pages as valid.

## Done when

- Every targeted page type emits parseable JSON-LD with the required properties.
- Every marked-up value is visible on the rendered page, and a test asserts this.
- The Rich Results Test reports zero errors (in the factory: listed as a post-deploy
  follow-up).
- No markup is added in the expectation of a retired feature (FAQ, HowTo, sitelinks
  search box).

## Anti-patterns

- Markup on content the user cannot see, or on `noindex` pages expecting results.
- Reviews or ratings the site wrote about itself (self-serving reviews on
  `LocalBusiness`/`Organization` are not eligible).
- Copy-pasted markup with stale prices or dates.
- Promising clients a specific rich result.
