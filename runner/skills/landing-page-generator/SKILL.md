---
name: landing-page-generator
description: Use when asked to create a landing page, marketing page, homepage, lead-capture page, campaign page, or conversion-optimised web page. Outputs complete Next.js/React (TSX) + Tailwind CSS components with proven copy frameworks (PAS/AIDA/BAB), SEO meta tags, and Core Web Vitals targets. Triggers on "create a landing page", "marketing page", "homepage", "lead gen page", or "conversion page".
stack: []
area: marketing
---

# Generate high-converting landing pages

Ship a real page: working TSX components, real copy structure and measured performance.
Match the repo's existing framework, styling and component conventions, using only
dependencies it already has: a delivery never installs one (the safety hook blocks it). A
greenfield bootstrap with no stack chosen may default to Next.js + Tailwind; anywhere else,
if the page truly needs a missing dependency, call `mark_ticket_blocked` naming it.

**Targets** (Core Web Vitals "good", field p75): LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1.
Also meet WCAG 2.2 AA: text contrast ≥ 4.5:1, a visible focus ring, labelled inputs, and
a keyboard-operable page.

## Copy framework (pick one per page)

| Framework | Structure | Best for |
|---|---|---|
| **PAS** | Problem → Agitate → Solution | problem-aware traffic |
| **AIDA** | Attention → Interest → Desire → Action | cold traffic, new category |
| **BAB** | Before → After → Bridge | outcome/transformation offers |

Templates and the five-objection FAQ are in `references/copy-frameworks.md`. The
`copywriting` skill covers headline and CTA craft.

## Section blueprint

1. **Hero**: an outcome headline (≤ ~10 words), a one-sentence subhead on how, one
   primary CTA, and a proof signal (a count, logos or a rating). No carousel.
2. **Problem**: the cost of the status quo, in the customer's words.
3. **Solution / benefits**: 3–6 benefits, each with a one-line explanation and an
   optional visual.
4. **Social proof**: testimonials with name, role, company and result; logos.
5. **Pricing** (if applicable): 2–4 tiers with the recommended one highlighted.
6. **FAQ**: the five objections. Use native `<details>`/`<summary>` or an accessible
   accordion. `FAQPage` markup is optional because Google no longer shows FAQ rich
   results.
7. **Footer CTA**: repeats the primary action with minimal friction (e.g. email only).

## Steps

1. **Collect the inputs.** Product name, audience, key pain, main outcome, primary CTA
   and its destination, the proof available, and the style direction. Read the ticket,
   `BRAND.md`/tokens and the existing pages first. When unattended, do not stop to ask:
   use what exists and mark gaps as `[TODO: …]` in the copy.
   **Never fabricate testimonials, logos, customer counts or ratings.**
2. **Choose the framework** from the traffic source and awareness level. Write the copy
   before the layout. Draft five headlines and keep the clearest.
3. **Build the sections** as separate components in the repo's component directory.
   Put the copy in props or a content object, not scattered through the JSX. Keep the
   page mostly server-rendered, with client components only where interaction needs
   them.
4. **SEO metadata.** Set a unique `<title>`, a meta description, a canonical, Open
   Graph and Twitter tags, and one `<h1>`. In Next.js App Router, use the `metadata`
   export.
5. **Performance.**
   - Load the hero/LCP image eagerly with `fetchpriority="high"`. In Next.js 16+ use
     `<Image preload>` (or `loading="eager"` + `fetchPriority="high"`); `priority` is the
     Next.js ≤ 15 form, deprecated in 16. Never lazy-load it.
   - Lazy-load images below the fold.
   - Every image gets explicit `width`/`height` and AVIF/WebP.
   - Fonts use `font-display: swap` (or `next/font`) with only the needed weights.
   - No third-party scripts above the fold.
6. **Form** (lead capture). Use labelled inputs with the correct `type` and
   `autocomplete`, inline validation, and an error summary that keeps what the user
   typed. Show a success state, disable double-submit, and post to the real endpoint
   named in the ticket.
7. **Verify.** Run and record each check:
   - the type check (`npx --no -- tsc --noEmit`, which fails rather than downloading)
     and the repo's lint;
   - the repo's build script (e.g. `npm run build`);
   - a component test that renders the page and asserts the h1, the primary CTA href
     and the form's success and error states;
   - Lighthouse (mobile) as a lab check, recording LCP, CLS, TBT and the accessibility
     score, only if it is already installed (`npx --no -- lighthouse`);
   - a viewport check at 375 px, 768 px and 1440 px for overflow and for the CTA above
     the fold, through the repo's browser test runner if it has one.

   Never install or fetch a tool to run a check. Name any check you could not run in
   your evidence instead of claiming it.

## Done when

- The page builds, type-checks and passes its component tests.
- The hero states an outcome and the primary CTA is above the fold at 375 px and
  1440 px (checked by a viewport test, or named as unchecked).
- Where Lighthouse or axe is available, the lab run shows LCP ≤ 2.5 s and CLS ≤ 0.1 on
  mobile and no automated accessibility violations; otherwise the evidence says these
  were not measured.
- No invented proof. Every gap is marked `[TODO]` and listed in the report.

## Anti-patterns

- A lazy-loaded hero image, or layout shift from unsized media or late fonts.
- Several equal-weight CTAs, or full site navigation on a paid-campaign page.
- Lorem ipsum or generic filler copy left in the build. The only allowed placeholder is
  an explicit `[TODO: …]` gap that the report lists.
- Carousels and autoplay video in the hero.
