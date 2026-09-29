---
name: slides-deck
description: Use when asked to create a slide deck, presentation, pitch deck, or talk outline — or to convert a markdown document into a slides format (Marp, Slidev, reveal.js). Triggers on "create a deck", "slide deck", "presentation", "pitch deck", "talk slides", "convert to slides", or "markdown to slides".
stack: []
area: marketing
---

# Build slide decks that make an argument

A deck is an argument delivered one claim at a time. Use the **assertion–evidence**
structure (Michael Alley, *The Craft of Scientific Presentations*): each slide's title is
a full-sentence **claim**, and its body is the **visual evidence** for that claim, such as
a chart, diagram, screenshot or short list. Read in order, the titles should tell the
whole story.

## Archetypes (pick before writing)

| Archetype | Spine |
|---|---|
| **Pitch** | Problem → Solution → Why now → Market → Product → Traction → Business model → Competition → Team → Financials → Ask |
| **Product demo** | Context → The job → Demo flow → Outcome → Next steps |
| **Report / update** | Bottom line first → Key metrics vs. target → What changed and why → Risks → Decisions needed |
| **Talk / keynote** | Hook → Thesis → 3 supporting points → What to do Monday |
| **Design review** | Goal → Constraints → Options → Recommendation + trade-offs → Decision asked |

For a report, put the conclusion first. For a pitch, put the ask last and make it
specific: the amount, the use of funds and the milestones it buys.

## Slide rules

- **Title = claim.** "Churn fell 31% after onboarding v2", not "Churn".
- **One claim per slide.** If a slide carries two claims, split it.
- **Evidence over text.** Use one chart, diagram or image, or at most ~5 short bullets.
  No paragraphs. On charts, label the axes, cite the data source, and mark the point
  the claim is about.
- **Readable.** Keep body text at 24 pt or larger in presenter-mode terms, with high
  contrast. Never put information in colour alone.
- **Speaker notes** carry the detail the speaker says aloud: 2–5 sentences, not a
  script.
- **Numbers are real.** Use sourced figures only, and mark unknowns `[TODO: data]`.
  Never invent traction, market size or quotes.

## Format

Default to **Marp Markdown** (version-controllable and exports to HTML, PDF and PPTX)
unless the repo or user already uses Slidev or reveal.js.

```markdown
---
marp: true
theme: default
paginate: true
footer: "Deck title · Month YYYY"
---

# Churn fell 31% after onboarding v2

![w:900](charts/churn.png)

<!-- Speaker notes: HTML comments on a Marp slide become presenter notes. -->

---
```

Separate slides with `---`. Export with `npx --no -- marp deck.md -o deck.html` when
`@marp-team/marp-cli` is already a dependency of the repo; use `--pdf -o deck.pdf` or
`--pptx -o deck.pptx` for other formats. PDF, PPTX and image export need a local
Chrome, Chromium or Edge (set `CHROME_PATH` if it is not found); HTML export does not.
Never fetch the CLI (`@latest` downloads it, which is an install). If it is not
installed, say in your evidence that the deck was not rendered.

## Steps

1. **Pin down the audience, the goal and the time.** Answer three questions: what
   should the audience believe or do afterwards; who are they; how many minutes do
   you have? Plan roughly one slide per 1–2 minutes. When unattended, take these from
   the ticket and say which assumptions you made.
2. **Choose the archetype** and write the **title-only outline**, one claim per line.
   Read the titles in sequence: if they don't make the argument, fix the outline
   before building any slide.
3. **Add the evidence** for each claim: the chart, diagram or screenshot, with its
   source. Cut any slide whose removal would not weaken the argument.
4. **Write the speaker notes** for every substantive slide.
5. **Build and render.** Run the Marp CLI (or the chosen tool's build). Check the
   output for overflowing text, unreadable charts and broken images. Marp's
   `--images png` produces one PNG per slide for inspection.
6. **Final pass.** Read the titles alone and confirm they form a coherent argument.
   Confirm the last slide states the ask or next step.

## Done when

- The deck renders without errors and no slide overflows, or the evidence says the
  renderer is not installed and the render was not checked.
- Every title is a claim, and the titles alone tell the story.
- Every number has a source or a `[TODO]`, and nothing is invented.
- Every substantive slide has speaker notes, and the final slide carries an explicit ask
  or next step.

## Anti-patterns

- Topic titles ("Market", "Q3") with a bullet dump underneath.
- Slides written as documents to be read rather than presented. If the deck must also
  work as a read-alone document, make an appendix.
- Decorative charts that don't show the claimed point.
- A deck of 40 slides for 20 minutes.
