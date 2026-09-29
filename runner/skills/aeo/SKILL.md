---
name: aeo
description: Use when optimising content to be cited by AI answer engines and LLM search (ChatGPT search, Perplexity, Claude, Gemini, AI Overviews) as an authoritative source — distinct from click-through SEO. Triggers on "AEO audit", "generative engine optimisation", "optimize for ChatGPT", "get cited by Perplexity", "LLM citation strategy", "answer engine optimization", "content for AI search", or "E-E-A-T audit". For click-through SEO, use `seo-audit`. For structured data, use `schema-markup`.
stack: []
area: marketing
---

# Optimise content to be cited by answer engines

Answer engines (ChatGPT search, Perplexity, Claude with web search, Google AI Overviews and
AI Mode) mostly answer by **retrieving live pages from a search index** and citing them.
They are not recalling training data. A page gets cited when three things hold:

1. The engine's crawler can fetch it.
2. It ranks in the engine's retrieval for the question.
3. It contains a clear, quotable answer the model can attribute.

AEO is therefore mostly **SEO fundamentals plus extractable answers**. Treat claims of a
secret ranking signal as unproven.

What primary sources say:

- **Google (Search Central, "AI features and your website"):** AI Overviews and AI Mode
  have *no additional technical requirements*. A page must be indexed and eligible for a
  snippet. The usual advice applies: helpful, reliable, people-first content, and
  structured data that matches visible text.
- **GEO study (Aggarwal et al., KDD 2024):** adding **cited sources, quotations and
  statistics** raised visibility in generative answers by up to ~40% on their benchmark,
  with effects varying by domain. Keyword stuffing did not help.

## Crawler access (check first — blocked means uncitable)

| Engine | Search/citation crawler (allow for citation) | Training-only crawler (independent choice) |
|---|---|---|
| OpenAI / ChatGPT search | `OAI-SearchBot` (plus `ChatGPT-User` for user-triggered fetches) | `GPTBot` |
| Anthropic / Claude | `Claude-SearchBot` (plus `Claude-User`) | `ClaudeBot` |
| Perplexity | `PerplexityBot` (plus `Perplexity-User`) | n/a |
| Google AI Overviews / AI Mode | `Googlebot` (normal Search indexing) | `Google-Extended` (Gemini training; does not affect Search) |
| Microsoft Copilot | `Bingbot` | n/a |

Blocking a training crawler does not block citation, and the reverse also holds. Check
robots.txt, the WAF/CDN bot rules and any `noindex` or `nosnippet`. A CDN "block AI bots"
toggle often blocks the search crawlers too. No major engine has confirmed that it uses
`llms.txt`, so treat that file as optional and never as a fix.

## Page patterns that get cited

- **Question-shaped heading followed by a direct 1–2 sentence answer**, with detail after
  it (inverted pyramid).
- **Definition sentences**: "X is …" at the start of a section.
- **Specific, sourced facts**: numbers, dates, named sources and links to the primary
  source. Original data, benchmarks and first-hand testing are the strongest
  differentiator.
- **Tables and ordered steps** for comparisons and procedures.
- **Visible authorship and dates**: an author with credentials, a published date and an
  updated date, matching any `Article` markup.
- **Server-rendered text.** Content that only appears after client-side JavaScript
  runs, or behind a login or paywall, is often not retrieved.

Structured data helps engines understand a page, but it earns no special AI placement.
FAQ rich results are retired in Google Search, and HowTo rich results have been removed.
Use the `schema-markup` skill only where the markup matches visible content.

## Steps

**In the factory** you reach the repo and a local build only: no production site, Search
Console, analytics, CDN settings or answer engines (WebFetch and WebSearch are denied).
Do steps 4–6 in the repo, and check crawler access in the repo's own robots.txt, meta
robots and locally built HTML. List steps 1, 3 and 7 and every production or CDN check as
follow-ups for a human in your evidence; never claim a check you could not run.

1. **Pick the target questions.** Choose 10–30 real questions the page should answer,
   drawn from Search Console queries, support tickets and sales calls. Map each
   question to one page.
2. **Check crawler access** against the table above. For each engine, check
   robots.txt, the CDN/WAF rules and the meta robots tags. Fetch the page with curl and
   confirm the answer text is in the raw HTML:
   `curl -sA "OAI-SearchBot" https://example.com/page | grep -c "<answer phrase>"`
   A spoofed user agent only exercises UA-string rules. CDNs that verify bots by IP can
   still block the real crawler, so also check the CDN's bot/firewall log or settings.
3. **Check indexing and ranking basics.** The page must be indexed in Google and Bing,
   carry a canonical and return 200. Use the `seo-audit` skill for anything deeper.
4. **Restructure for extraction.** For each target question, add a question heading
   with a direct answer, then the supporting detail, a table or steps, and sources.
5. **Raise evidence density.** Replace unsupported adjectives with sourced numbers,
   quotes and first-hand results. Never fabricate a statistic, quote or case study.
6. **Add attribution.** Show the author bio, the organisation and dates on the page.
   Where markup exists, keep it consistent with the visible content.
7. **Measure.** Run each target question in each engine monthly (logged-out, same
   wording) and record whether you are cited and at what URL. Watch the referral
   traffic from `chatgpt.com`, `perplexity.ai` and similar in analytics.

## Done when

- The search crawlers for each target engine get 200 and the answer text appears in the
  raw HTML (in the factory: the repo's robots rules allow them and the answer text is in
  the locally built HTML; the live check is a listed follow-up).
- Every target question has a direct-answer block on exactly one page.
- Every factual claim on target pages has a source or first-party evidence.
- Author and dates are visible, and any markup matches them.
- A baseline citation log exists, so later runs can be compared against it, or (in the
  factory) it is listed as a follow-up for a human.

## Anti-patterns

- Blocking all AI user agents at the CDN, then wondering why nothing is cited.
- Rewriting prose for bots at the expense of readers. Google's people-first guidance
  still governs ranking.
- Adding FAQ markup expecting AI citations, or `llms.txt` expecting any effect.
- Fabricated or unsourced statistics: engines may cite them, and the error is then
  attributed to you.
