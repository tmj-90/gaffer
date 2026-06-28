---
name: slides-deck
description: Use when asked to create a slide deck, presentation, pitch deck, or talk outline — or to convert a markdown document into a slides format. Triggers on "create a deck", "slide deck", "presentation", "pitch deck", "talk slides", "convert to slides", or "markdown to slides".
stack: []
area: marketing
---

# Convert ideas into structured, deliverable slide decks

Slides are not documents. One idea per slide. The constraint is a feature, not a bug.

## Deck archetypes (determine before writing)

| Archetype | Purpose | Structure |
|-----------|---------|-----------|
| **Pitch deck** | Fundraising or executive buy-in | Problem → Market → Solution → Traction → Ask |
| **Product demo** | Show a feature working | Context → Demo flow → Outcome → Next steps |
| **Report / update** | Status, data, retrospective | Summary → Data → Insights → Actions |
| **Talk / keynote** | Conference or all-hands | Hook → Thesis → 3 points → Call to action |
| **Design review** | Critique a design | Objective → Current state → Proposal → Trade-offs |

## Slide anatomy

Every slide has one job. Ask: "What should the viewer believe or do after this slide?" If the answer is two things, split the slide.

```
TITLE     — the claim (not the topic). "Revenue grew 43%" not "Q2 Revenue"
BODY      — the evidence for the claim (one paragraph, one chart, or one list)
TAKEAWAY  — optional; the one-sentence so-what if it isn't obvious
```

## Output formats

| Format | Use case |
|--------|---------|
| **Markdown slides** | Marp or Slidev; deliverable as `.md`; in version control |
| **Reveal.js HTML** | Self-contained; shareable as a URL; no install |
| **Structured outline** | For the user to paste into their own tool (Google Slides, Keynote, PowerPoint) |

Default: Markdown slides (Marp format) unless the user specifies otherwise.

## Marp frontmatter (standard)

```markdown
---
marp: true
theme: default
paginate: true
footer: "Company · Deck Title · Month Year"
---
```

Slides separated by `---`. Speaker notes after `<!--` on a blank line below the slide.

## Pitch deck structure (12 slides)

1. Title — company name + one-line value prop + date
2. Problem — the specific pain; quantify it
3. Solution — what you do; one sentence
4. Demo / Product — screenshot or flow; show don't tell
5. Market — TAM/SAM/SOM or specific segment size with source
6. Business model — how you make money; unit economics if available
7. Traction — the best metric you have; growth rate preferred
8. Competition — honest 2×2 or table; say why you win
9. Team — relevant prior experience only; no fluff
10. Roadmap — 12-month milestones; tied to the ask
11. Financials — 3-year projection; key assumptions
12. Ask — specific amount; use of funds; timeline

## Steps

1. **Determine archetype.** Ask if not obvious from context.
2. **Gather inputs.** Key message, audience, time limit (slides × 2 min is a rough guideline), any existing content.
3. **Outline first.** One line per slide, in order. Confirm the flow makes a logical argument before writing content.
4. **Write slides.** One claim per slide. Titles are claims, not topics. Cut any slide whose removal wouldn't weaken the argument.
5. **Add speaker notes.** 3–5 sentences per slide; the detail the audience gets verbally; not a transcript.
6. **Format and export.** Apply consistent heading hierarchy, spacing, and brand colours if provided.
7. **Verify.** Read the title of every slide in sequence — they should form a coherent summary of the argument without looking at the body.

## Review checklist

- **One idea per slide** — no slide makes two separate claims.
- **Titles are claims** — "Revenue grew 43%" not "Revenue".
- **Speaker notes present** on every substantive slide.
- **Deck tells a story** without body copy — title sequence is a coherent argument.
- **No wall-of-text slides** — body ≤ 5 bullet points or 1 chart or 1 short paragraph.
- **Ask/CTA explicit** — the last slide states what you want the audience to do.

## Rules

- Title = claim, not topic. This is the single most impactful change you can make to most decks.
- Cut slides ruthlessly — a 10-slide deck that lands beats a 40-slide deck that exhausts.
- Speaker notes are for the speaker, not a transcript — never read notes verbatim.
