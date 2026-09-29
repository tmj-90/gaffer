---
name: copywriting
description: Use when asked to write, rewrite, or improve marketing copy for any page — homepage, landing page, pricing, feature page, about page, or product page. Triggers on "write copy for", "improve this copy", "rewrite this page", "marketing copy", "headline help", or "CTA copy". For full page generation with structure and code, use `landing-page-generator`.
stack: []
area: marketing
---

# Write marketing copy that converts

Clarity beats cleverness. Good copy meets the reader where their awareness is, speaks in
their words, makes specific claims it can prove, and asks for one clear action.

## Inputs (collect before writing)

1. **Page type and the ONE primary action.**
2. **Audience**: who they are, the job they are trying to get done, and the words they
   use for it. Pull those words from reviews, support tickets, interview notes and
   sales calls (voice-of-customer).
3. **Awareness level** (Eugene Schwartz, *Breakthrough Advertising*). This decides
   where the copy opens:
   - **Unaware**: open on a story or insight about the situation.
   - **Problem-aware**: open on the problem (PAS).
   - **Solution-aware**: open on why this approach beats the others.
   - **Product-aware**: open on the proof and the offer.
   - **Most aware**: open on the offer and the CTA, and not much else.
4. **Differentiation**: why this rather than the obvious alternative, including "do
   nothing".
5. **Proof you actually have**: numbers, named customers, testimonials, guarantees.
6. **Traffic source**: it sets the awareness level and the message the headline must
   match.

When running unattended, take these from the ticket, the repo (`BRAND.md`, existing
pages) and the lore (`search_lore`). **Never invent proof.** A missing testimonial or
number becomes a clearly marked `[TODO: proof]` placeholder and is listed in your
report. It is never a fabricated quote or statistic.

## Principles

- **Outcome over mechanism.** Translate each feature into what the user gets. "256-bit
  encryption" becomes "Only you can read your files".
- **Customer language.** If users say "reconciliation is a nightmare", write that, not
  "streamline financial operations".
- **Specific over general.** "Save 2 hours a week" beats "save time". "4,200 teams"
  beats "thousands". Specific claims are believed, and they must be true.
- **One idea per section.** Each section answers one question a visitor has, in the
  order they would ask it.
- **Plain words.** Use short sentences and active voice, and cut filler ("we're
  passionate about…", "world-class", "seamless").

## Frameworks

| Framework | Shape | Use when |
|---|---|---|
| **PAS** | Problem → Agitate → Solution | problem-aware readers |
| **AIDA** | Attention → Interest → Desire → Action | cold or unaware readers; long pages |
| **BAB** | Before → After → Bridge | transformation-led offers |
| **4 U's** (headline test) | Useful, Urgent, Unique, Ultra-specific | scoring headline variants |

`landing-page-generator/references/copy-frameworks.md` has fill-in templates.

## Headlines and CTAs

- Test headline formulas:
  - outcome + timeframe
  - problem reversal ("Stop losing deals to slow follow-up")
  - who + outcome ("For teams who hate waiting on CI")
  - proof + outcome
- CTAs state what happens next and match the commitment level. Cold traffic gets "See
  pricing" or "Start free". Warm traffic gets "Book a 20-min demo". Avoid "Submit",
  "Click here" and "Learn more" as the primary CTA.
- Put risk reducers next to the CTA: "No card required", "Cancel anytime". Use them only
  if they are true.

## Steps

1. **Read the existing copy.** Keep what is specific and working. Flag what is vague,
   feature-first, or written for the company rather than the reader.
2. **Set the awareness level and the framework.**
3. **Draft 5+ headline variants** across different formulas before judging any of them.
   Score each on the 4 U's and on the 5-second test: would a cold visitor know what
   this is and who it is for? Pick the clearest.
4. **Write the sections in visitor-question order.** For each section: one idea,
   benefit first, then the proof.
5. **Write the CTA and its microcopy**, including any risk reducer.
6. **Edit.** Read it aloud. Cut every sentence that does not move the reader toward the
   action. Replace hedges ("may help you") with a specific claim or remove them. Check
   that every claim has proof.

## Done when

- A cold reader can state the outcome and the audience from the headline and subhead.
- Every claim is specific and backed by real proof, or marked `[TODO: proof]`.
- There is one primary CTA, labelled with its outcome, on the page.
- The copy uses the customer's words, has no filler, and on mobile no paragraph runs
  past about three lines.

## Anti-patterns

- Clever or punny headlines that need a second read.
- Superlatives without proof ("best", "fastest", "#1").
- Fabricated testimonials, logos or numbers. These are a legal and trust risk.
- Several competing CTAs of equal weight.
