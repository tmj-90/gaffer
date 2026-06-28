---
name: page-cro
description: Use when asked to optimise or improve conversions on a marketing page — homepage, landing page, pricing page, feature page. Triggers on "CRO", "conversion rate optimization", "this page isn't converting", "improve conversions", "why isn't this page working", or "increase sign-ups". For new page generation, use `landing-page-generator` instead.
stack: []
area: marketing
---

# Improve page conversion rates

A page that converts well is one where the visitor's question ("is this for me?") is answered before they think to ask it. Diagnose in order of impact; fix the biggest lever first.

## Analysis framework (work top-to-bottom)

### 1. Value proposition clarity (highest impact)

Can a first-time visitor understand what this is and why they should care within 5 seconds?

Signs it's broken:
- Headline describes the product, not the outcome for the user.
- Subheadline is a marketing tagline, not a one-sentence expansion of the benefit.
- First CTA is below the fold on desktop (1440px).

### 2. Headline effectiveness

- Specific > clever. "Cut your Shopify return rate by 23%" beats "Returns, reinvented."
- Must match the ad/email/referral that sent the visitor — message mismatch kills conversions.
- A/B test at ≥ 100 visitors per variant before concluding.

### 3. CTA friction

- One primary action per page. Two CTAs = zero conversions.
- CTA label states what happens next: "Start free trial" not "Submit".
- Reduce fields: every additional form field costs ~10% completion. Ask for email only until you need more.

### 4. Social proof specificity

- Named testimonials (first name + company) outperform anonymous quotes.
- Numbers anchor trust: "4,200 teams" > "thousands of teams".
- Logo strips: name-recognisable logos; max 6 (more = noise).

### 5. Objection handling

Map the 5 core objections for the page's conversion goal (sign-up / purchase / demo). Confirm each is addressed somewhere on the page. See `landing-page-generator` references for the standard objection list.

### 6. Mobile and speed

- 60%+ of traffic is mobile for most marketing pages. Check layout at 375px.
- LCP > 2.5s is a conversion killer — check Lighthouse and fix the hero image.

## Steps

1. **Identify page type and primary conversion goal.** Single goal per analysis — don't try to optimise for multiple actions simultaneously.
2. **Run the 5-second test.** Read only the above-the-fold content. Can you answer: what is this, who is it for, what happens when I click? If not — fix the hero first, everything else is secondary.
3. **Work the framework in order.** Value prop → headline → CTA → social proof → objections → mobile/speed. Don't skip to lower items until the higher ones are solid.
4. **Produce prioritised recommendations.** For each finding: what's broken, why it hurts, what to change, estimated impact (high/medium/low).
5. **Verify.** After implementing: re-run Lighthouse; confirm primary CTA is above the fold; confirm the 5-second test passes.

## Review checklist

- **Primary CTA above the fold** — visible on 1440px without scrolling.
- **Headline states user outcome** — not product name or tagline.
- **One primary action** — secondary CTAs are visually de-emphasised.
- **Social proof specific** — names, companies, numbers.
- **5 objections addressed** — mapped and answered somewhere on the page.
- **Mobile layout passes** — no overflow at 375px; primary CTA still above the fold.
- **LCP < 2.5s** — Lighthouse desktop.

## Rules

- Fix the hero (value prop, headline, CTA) before anything else — it's the highest-leverage real estate.
- Never recommend A/B testing something that obviously needs fixing — fix it first, then test variations.
- Never recommend adding more content to a page as a first CRO move — remove friction first.
