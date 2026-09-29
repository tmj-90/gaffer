---
name: page-cro
description: Use when asked to optimise or improve conversions on a marketing page — homepage, landing page, pricing page, feature page. Triggers on "CRO", "conversion rate optimization", "this page isn't converting", "improve conversions", "why isn't this page working", or "increase sign-ups". For new page generation, use `landing-page-generator` instead.
stack: []
area: marketing
---

# Improve page conversion rates

A page converts when a visitor quickly understands **what this is, whether it is for them,
and what happens when they act**, and when nothing on the page raises doubt or distracts.
Diagnose with evidence, fix the biggest lever first, and test only what is genuinely
uncertain.

## Diagnostic framework (LIFT model, WiderFunnel; work in this order)

1. **Value proposition.** Is the reason to act clear and credible? This is the
   foundation, and every factor below amplifies or weakens it.
2. **Relevance.** Does the page match what brought the visitor: the ad, email or
   query? Headline scent should echo the source's wording. A message mismatch fails
   before anything else is read.
3. **Clarity.** Can a first-time visitor answer "what, for whom, what next" in ~5
   seconds from the above-the-fold content? Check that the headline states the
   outcome, the subhead explains how, and there is one visible primary CTA.
4. **Anxiety.** What makes the visitor hesitate? Price, commitment, privacy, "will it
   work for me". Answer it at the point of hesitation with specific proof, guarantees
   and security notes. The five core objections are listed in the
   `landing-page-generator` skill's `references/copy-frameworks.md`.
5. **Distraction.** Does anything compete with the primary action, such as full site
   navigation on a campaign page, several equal-weight CTAs, or autoplay media?
   Secondary actions are fine when visually subordinate.
6. **Urgency.** Is there a real reason to act now? Use only genuine deadlines or limits.
   Fake scarcity destroys trust.

### Friction checks

- **Forms:** ask only for what the next step needs. Every field must justify itself.
  Baymard's checkout benchmark (2024) finds most sites need about 8 fields but average 11.3. Label fields
  visibly, mark optional ones, validate inline, and keep entered data on error.
- **CTA label** states the outcome or next step ("Start free trial", "Get my quote"),
  not "Submit".
- **Speed and mobile:** field LCP ≤ 2.5 s and INP ≤ 200 ms. At 375 px the CTA is
  reachable and the tap targets are large enough.
- **Proof:** named, specific testimonials (name, role, company, result). Numbers
  ("4,200 teams"), recognisable logos and third-party ratings, placed near the
  decision.

## Steps

**In the factory** there is no analytics, traffic, heatmap or A/B tool: only the repo.
State the baseline as unknown, do the heuristic walk-through (step 3) on the page's code
and rendered output, fix obvious defects (step 4), and hand steps 1–2, 5 and 6 to a human
as a written measurement plan. Never invent a rate or a result.

1. **Define the goal and the baseline.** Name one primary conversion (sign-up, demo,
   purchase) and read its current rate and traffic by source and device from
   analytics. Without a baseline you cannot claim a result.
2. **Gather evidence before opinions.** Walk the funnel drop-off in analytics, look
   at scroll and click maps or session recordings if they exist, read form-field
   abandonment, and collect support and sales objections. On-page polls ("What's
   stopping you today?") are cheap and direct.
3. **Heuristic walk-through.** Go through the six LIFT factors and the friction checks
   on desktop and at 375 px. For each finding, record what is broken, the evidence,
   the LIFT factor, the proposed change and the expected impact.
4. **Prioritise.** Use a simple score (PIE: potential, importance, ease, or ICE). Fix
   obvious defects directly, without testing them: broken forms, a missing CTA, a
   slow LCP, a message mismatch.
5. **Test what is uncertain.** Write a hypothesis: "Because [evidence], changing [X]
   for [segment] will raise [metric]." Before starting, compute the sample size from
   the baseline rate, the minimum detectable effect, α = 0.05 and 80% power (Evan
   Miller's calculator). Run it for whole weeks and **do not stop early on a
   significant peek**: repeated peeking inflates false positives far above 5%. Low
   traffic cannot detect small lifts, so ship the best-evidenced change and monitor
   it instead.
6. **Verify and record.** Confirm the change is live on all devices, re-run the
   5-second check, and compare the post-change conversion against the baseline over
   an equal period. Record the result, including null results.

## Done when

- The goal, baseline and traffic mix are stated.
- Every recommendation cites evidence and a LIFT factor, and is prioritised.
- Obvious defects are fixed or ticketed. Uncertain changes have a hypothesis and a
  precomputed sample size.
- A post-change measurement plan exists.

## Anti-patterns

- Declaring a winner at "100 visitors", or stopping the moment p < 0.05.
- Copying "best practices" (button colour, a countdown timer) without evidence from
  this page's audience.
- Adding more content as a first move before removing friction.
- Fake urgency or scarcity, and hidden costs revealed at the last step.
- Optimising micro-conversions (clicks) while the real goal (paid, retained) drops.
