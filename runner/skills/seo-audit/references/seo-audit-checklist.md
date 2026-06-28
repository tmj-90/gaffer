# SEO Audit Checklist — 80-point

## Technical (40 points)

### Crawl & Indexation
- [ ] robots.txt present and not blocking critical pages
- [ ] XML sitemap present, valid, and submitted to Search Console
- [ ] Sitemap contains only indexable URLs (no 4xx/5xx/redirected)
- [ ] No orphan pages (every page reachable from at least one internal link)
- [ ] Crawl depth ≤ 3 clicks from homepage for important pages
- [ ] Pagination handled correctly (rel=next/prev or proper internal linking)
- [ ] No noindex on pages that should rank
- [ ] No disallow in robots.txt for pages that should rank
- [ ] Canonical tags present and pointing to correct URL
- [ ] No canonical to noindexed page

### HTTPS & URLs
- [ ] HTTPS on all pages; no mixed-content warnings
- [ ] HTTP redirects to HTTPS (301)
- [ ] No redirect chains longer than 1 hop
- [ ] No broken redirect loops
- [ ] URL slugs lowercase, hyphens, no special chars, descriptive
- [ ] No session IDs or tracking params in canonical URLs

### Speed & Core Web Vitals
- [ ] LCP ≤ 2.5s (real-user, Search Console)
- [ ] INP ≤ 200ms (real-user, Search Console)
- [ ] CLS ≤ 0.1 (real-user, Search Console)
- [ ] Hero image uses next-gen format (AVIF/WebP)
- [ ] Hero image preloaded with `fetchpriority="high"`
- [ ] Render-blocking CSS eliminated or deferred
- [ ] No large layout shifts from late-loading fonts or images
- [ ] Images have explicit width + height attributes

### Mobile
- [ ] Passes Google Mobile-Friendly Test
- [ ] Viewport meta tag present
- [ ] Touch targets ≥ 44×44px
- [ ] No horizontal scroll at 375px viewport

### Structured Data
- [ ] At least one structured data type implemented (Organization, WebSite, BreadcrumbList)
- [ ] No structured data errors in Search Console → Enhancements
- [ ] FAQ schema on FAQ pages (if applicable)
- [ ] Article schema on blog posts with datePublished + author

### International (if applicable)
- [ ] hreflang tags correct and bidirectional
- [ ] No missing hreflang return tags

---

## On-Page (25 points)

### Title Tags
- [ ] Unique per page
- [ ] ≤ 60 characters
- [ ] Primary keyword near the front
- [ ] Describes page content accurately
- [ ] No keyword stuffing

### Meta Descriptions
- [ ] Present on all key pages
- [ ] ≤ 160 characters
- [ ] Unique per page
- [ ] Includes a soft CTA or benefit statement

### Headings
- [ ] Exactly one H1 per page
- [ ] H1 includes primary keyword
- [ ] Logical heading hierarchy (H1 → H2 → H3, no gaps)
- [ ] No keyword stuffing in headings

### Internal Linking
- [ ] Money pages linked from ≥ 3 internal pages
- [ ] Anchor text is descriptive (no "click here")
- [ ] No broken internal links
- [ ] No nofollow on internal links to important pages
- [ ] Breadcrumbs present on inner pages

### Images
- [ ] Alt text on all images (descriptive, not keyword-stuffed)
- [ ] File names descriptive (product-name.jpg, not IMG_4521.jpg)

---

## Content (15 points)

### Intent Match
- [ ] Page format matches dominant search intent (informational/transactional/navigational/commercial)
- [ ] Featured snippet opportunity identified and format matched (paragraph/list/table)

### E-E-A-T
- [ ] Author bio with credentials on articles
- [ ] Publication date and last-updated date visible
- [ ] Primary sources cited where claims are made
- [ ] Specific examples and data (not only generic claims)

### Quality
- [ ] No thin pages (< 300 words unique content) targeting commercial queries
- [ ] No duplicate content (use canonical or consolidate)
- [ ] Primary keyword in: title + H1 + first 100 words + URL slug
- [ ] LSI/related terms used naturally in body
- [ ] No keyword stuffing

### Freshness
- [ ] Evergreen pages reviewed and updated in last 12 months
- [ ] Outdated statistics replaced with current data
