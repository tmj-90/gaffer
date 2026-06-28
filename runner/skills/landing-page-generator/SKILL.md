---
name: landing-page-generator
description: Use when asked to create a landing page, marketing page, homepage, lead-capture page, campaign page, or conversion-optimised web page. Outputs complete Next.js/React (TSX) + Tailwind CSS components with proven copy frameworks (PAS/AIDA/BAB), SEO meta tags, and Core Web Vitals targets. Triggers on "create a landing page", "marketing page", "homepage", "lead gen page", or "conversion page".
stack: [typescript, javascript, react, web]
area: marketing
---

# Generate high-converting landing pages

Not lorem ipsum — actual copy and structure that converts. Output complete, ready-to-ship TSX components with Tailwind.

**Performance targets:** LCP < 1s · CLS < 0.1 · FID < 100ms

## Copy frameworks

Pick one per page — don't mix:

| Framework | Structure | Best for |
|-----------|-----------|---------|
| **PAS** | Problem → Agitate → Solution | Pain-aware traffic; problem-first messaging |
| **AIDA** | Attention → Interest → Desire → Action | Cold traffic; brand-new product |
| **BAB** | Before → After → Bridge | Transformation products; outcome-led |

## Section blueprint (in order)

1. **Hero** — headline (value prop in ≤ 10 words) + subheadline (1 sentence expanding on the outcome) + primary CTA + social proof signal (count or logo strip).
2. **Problem / Pain** — articulate the cost of the status quo in the user's own language.
3. **Solution / Features** — 3–6 benefits (not feature names); each benefit has a one-line explanation.
4. **Social proof** — testimonials with name, role, company; star ratings if applicable; logos.
5. **Pricing** (if applicable) — 2–4 tiers; highlight the recommended one; FAQ accordion.
6. **FAQ** — answer the 5 objections that would stop a user converting; include FAQ schema markup.
7. **Footer CTA** — repeat the primary CTA; reduced friction (email-only, not full form).

## Steps

1. **Gather inputs.** Before writing: product name, tagline, primary audience, key pain point, main benefit, primary CTA label, design style (pick one: minimal light / editorial dark / neo-brutalist / SaaS clean). Ask for missing fields — one question at a time.
2. **Choose copy framework.** Based on traffic source and audience awareness level.
3. **Write copy first, structure second.** Headline variants: write 5, pick the clearest (not the cleverest). Subheadline must state the outcome, not the mechanism.
4. **Build sections in order.** Hero → social proof → problem → solution → pricing → FAQ → footer CTA. Each section is a standalone TSX component.
5. **SEO meta.** Title tag (≤ 60 chars), meta description (≤ 160 chars), OG tags, canonical.
6. **Performance.** Hero image: `loading="eager" fetchpriority="high"`. Everything below the fold: `loading="lazy"`. Fonts: `font-display: swap`; preload only the critical weight.
7. **Verify.** Type-check (`tsc --noEmit`); Lighthouse score on desktop; confirm LCP < 1s; record evidence.

## Build / Test

- `tsc --noEmit` — zero type errors.
- Lighthouse desktop: Performance ≥ 90, Accessibility ≥ 90, Best Practices ≥ 90.
- Validate structured data with Google Rich Results Test (FAQ schema).

## Review checklist

- **Headline states outcome** — not the product name or a feature.
- **CTA above the fold** — visible without scrolling on 1440px viewport.
- **Social proof specific** — names, roles, companies (not generic "thousands of customers").
- **Mobile layout tested** — 375px and 768px viewports; no overflow.
- **Hero image performance** — `eager`/`high` priority; next-gen format (AVIF/WebP).
- **No lorem ipsum** — every placeholder replaced with real or clearly marked copy.

## References

`references/copy-frameworks.md` — PAS/AIDA/BAB templates with fill-in-the-blank examples.
