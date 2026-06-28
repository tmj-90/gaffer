---
name: schema-markup
description: Use when implementing, auditing, or validating structured data (schema markup) on a website. Triggers on "structured data", "schema.org", "JSON-LD", "rich results", "rich snippets", "FAQ schema", "Product schema", "schema errors in Search Console", or "why no rich results". NOT for general SEO audits — use `seo-audit`. For AI-search citation optimisation, use `aeo`.
stack: []
area: marketing
---

# Implement structured data that earns rich results

JSON-LD is the recommended format (Google's preference). Schema.org types are the vocabulary. Rich results in Google and citations in AI search engines are the outcomes.

## High-value schema types (implement these first)

| Type | Rich result earned | Required fields |
|------|--------------------|----------------|
| `Organization` | Knowledge panel, sitelinks search | `name`, `url`, `logo` |
| `WebSite` | Sitelinks search box | `url`, `potentialAction` (SearchAction) |
| `FAQPage` | FAQ dropdowns in SERP | `mainEntity` → `Question` → `acceptedAnswer` |
| `Article` | Top stories, rich snippet | `headline`, `author`, `datePublished`, `image` |
| `Product` | Product snippet with price/rating | `name`, `offers`, `aggregateRating` |
| `HowTo` | How-to steps in SERP | `name`, `step` array |
| `BreadcrumbList` | Breadcrumb in SERP URL | `itemListElement` array |
| `LocalBusiness` | Local pack, knowledge panel | `name`, `address`, `telephone` |

## JSON-LD placement

Prefer `<head>` as a `<script type="application/ld+json">` block. Google also supports JSON-LD placed in the `<body>` (including markup injected by JavaScript), so in-body placement is valid when `<head>` injection isn't practical — `<head>` is simply the cleaner default. One `<script>` block per schema type per page (or a `@graph` array for multiple types).

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What is your refund policy?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "We offer a 30-day full refund, no questions asked."
      }
    }
  ]
}
</script>
```

## Common mistakes that block rich results

- **Content mismatch** — schema claims a `price` or `rating` that doesn't appear on the page. Google requires visible content to match.
- **Missing required fields** — check Google's required/recommended fields per type at developers.google.com/search/docs/appearance.
- **Incorrect `datePublished` format** — must be ISO 8601 (`2026-06-17T09:00:00+00:00`).
- **Markup on 404/noindex pages** — Google won't process structured data on non-indexable pages.
- **Multiple conflicting types** — use `@graph` array to combine without conflict.

## Steps

1. **Audit existing markup.** Paste page source into Google Rich Results Test; review Search Console → Enhancements for errors. Identify what's present, what's broken, what's missing.
2. **Prioritise by page type.** Homepage → Organization + WebSite. Blog posts → Article. FAQs → FAQPage. Product pages → Product. All inner pages → BreadcrumbList.
3. **Implement in JSON-LD.** Populate all required fields; add recommended fields for richer results. Confirm all schema claims match visible page content.
4. **Validate.** Run through Google Rich Results Test (schema.googleapis.com/v1/richResults); fix any `errors` (not just `warnings`).
5. **Monitor.** After deployment, check Search Console → Enhancements in 48–72 hours for indexation of new schema.
6. **Record evidence.** Screenshot Rich Results Test passing; note which enhancements are expected.

## Review checklist

- **JSON-LD in `<head>`** — not inline or in body.
- **All required fields present** — per Google's type documentation.
- **Content matches page** — every schema claim visible on the rendered page.
- **Rich Results Test passes** — zero errors (warnings acceptable).
- **BreadcrumbList on all inner pages** — not just the homepage.
- **Search Console errors cleared** — no existing structured data errors before adding new.

## Rules

- Schema that describes content not visible on the page is spam — Google may penalise it.
- Fix Search Console errors on existing schema before adding new types.
- Never use Microdata or RDFa — JSON-LD only (maintainable and Google's preference).
