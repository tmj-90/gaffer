---
name: aeo
description: Use when optimising content to be cited by AI language models (ChatGPT, Perplexity, Claude, Gemini) as an authoritative source — distinct from SEO. Triggers on "AEO audit", "optimize for ChatGPT", "get cited by Perplexity", "LLM citation strategy", "answer engine optimization", "content for AI search", or "E-E-A-T audit". For click-through SEO, use `seo-audit`. For structured data, use `schema-markup`.
stack: []
area: marketing
---

# Optimise content for LLM citation

AEO (Answer Engine Optimisation) optimises content to be **cited** in LLM-generated responses — distinct from SEO, which optimises for click-through rankings. The signal sets differ.

## AEO vs SEO

| | SEO | AEO |
|--|-----|-----|
| Optimises for | Click-through ranking | Citation as authoritative source |
| Success metric | Position 1-10, organic traffic | Citation count across LLMs |
| Key signals | Backlinks, keywords, page speed | E-E-A-T, structured facts, primary-source signals |
| Update cadence | Weeks–months | Days–weeks (LLM training cycles) |

Both coexist — a page can rank #1 on Google AND be cited by Perplexity.

## E-E-A-T signals for LLM citation

LLMs prefer content that looks like a primary source to their training data:

| Signal | Implementation |
|--------|---------------|
| **Experience** | First-person case studies; dated real examples ("In our 2026 audit of 50 repos…") |
| **Expertise** | Author bio with credentials; technical depth; cite primary sources |
| **Authoritativeness** | External backlinks from authority domains; schema.org markup; Wikipedia presence |
| **Trustworthiness** | HTTPS; contact info; transparent corrections; verifiable claims with data |

**Factual density** — LLMs prefer pages with a high ratio of verifiable claims per 1,000 words. Prose that states facts > prose that describes opinions.

## Content structure for citation

LLMs extract from:
1. **Direct-answer paragraphs** — a question as a heading followed immediately by a 1–2 sentence direct answer.
2. **Structured data** — FAQPage and HowTo schema (see `schema-markup`).
3. **Definition blocks** — "X is [concise definition]" sentences at the start of sections.
4. **Comparison tables** — LLMs reproduce tables well; use for vs. comparisons and feature matrices.

## Citation-hostile patterns to avoid

- Gated content (LLMs can't read it during training crawls).
- JavaScript-rendered text (crawlers often miss it).
- Opinion without evidence ("we believe X is important").
- Content updated without a `dateModified` schema field.
- No author or institutional attribution.

## Steps

1. **Identify citation-worthy content.** Pages that answer specific questions with unique data, first-party case studies, or authoritative comparisons are candidates. Brand-voice content without factual claims is not.
2. **Audit E-E-A-T gaps.** For each target page: score Experience (0–3), Expertise (0–3), Authoritativeness (0–3), Trustworthiness (0–3). Identify the lowest-scoring dimension and fix it first.
3. **Add direct-answer structure.** Rewrite the first paragraph of each target section as a direct answer to the implied question. Add schema (FAQPage/HowTo where appropriate).
4. **Improve factual density.** Replace opinion sentences with evidence sentences. Add specific numbers, dates, and attributable sources.
5. **Track citations.** Query each target LLM (ChatGPT, Perplexity, Claude) with the exact question the page answers. Note whether your domain is cited. Repeat monthly.
6. **Verify.** Rich Results Test for schema; check `dateModified` is present and accurate; confirm author bio is visible and crawlable.

## Review checklist

- **Direct-answer paragraph in each target section** — question heading + immediate direct answer.
- **E-E-A-T score ≥ 2/3 in all four dimensions** — no dimension at 0.
- **FAQPage or HowTo schema** on pages with question-and-answer structure.
- **Author bio visible and crawlable** — not loaded via JavaScript after parse.
- **`dateModified` in Article schema** and visible on page.
- **No gated content for citation-target pages** — if it needs a login, it won't be cited.

## Rules

- AEO applies only to pages with verifiable factual content — brand/opinion content is out of scope.
- Never fabricate statistics or case studies to improve E-E-A-T — citation by LLMs of false claims is a liability.
- Track citation rates monthly; treat uncited priority pages as an audit finding.
