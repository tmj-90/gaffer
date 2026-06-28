---
name: code-tour
description: Use when asked to create a code walkthrough, onboarding tour, architecture tour, PR review tour, or any structured explanation of how a codebase works. Triggers on "create a code tour", "onboarding tour", "how does X work", "explain the codebase", "architecture walkthrough", "PR tour", or "contributor guide". Outputs a CodeTour `.tour` JSON file for the VS Code CodeTour extension.
stack: []
area: docs
---

# Create persona-targeted, file-anchored code tours

A great tour is a narrative — a story told to a specific person about what matters, why it matters, and what to do next. Every file path and line number must be real and verified.

## Persona selection

Infer silently from the request:

| User says | Persona | Depth |
|-----------|---------|-------|
| "tour for this PR" | pr-reviewer | standard |
| "why did X break" / "RCA" | rca-investigator | standard |
| "onboarding" / "new joiner" | new-joiner | standard |
| "quick tour" / "vibe check" | vibecoder | quick |
| "architecture" | architect | deep |
| "security" / "auth review" | security-reviewer | standard |
| (no qualifier) | new-joiner | standard |

**Depth guidelines:**
- Quick: 5–8 steps, high-level, 1–2 sentences per step.
- Standard: 10–20 steps, full narrative, 3–5 sentences per step.
- Deep: 20–40 steps, links between steps, covers edge cases and design rationale.

## Tour file format

```json
{
  "$schema": "https://aka.ms/codetour-schema",
  "title": "Tour title — persona",
  "description": "One sentence: what this tour covers and who it's for.",
  "steps": [
    {
      "file": "src/index.ts",
      "line": 1,
      "title": "Entry point",
      "description": "The application starts here. The `main()` function wires together the three primary subsystems..."
    }
  ]
}
```

Tours live in `.tours/<name>.tour` in the repo root.

## Step writing principles

1. **Start with the entry point.** Request handling / server startup / CLI entry / main module — wherever execution begins.
2. **Follow the call graph.** Each step ends by saying where the tour goes next and why. No teleporting.
3. **Name what matters.** Call out non-obvious decisions ("this uses a singleton because…"); don't describe what the code literally says.
4. **Speaker notes for complexity.** For a step covering a subtle invariant, write it as if you're pair-programming — "Watch out for X here because Y."
5. **End with a summary step.** "You've seen the full request lifecycle. The key files are A, B, and C. Start with A when you need to change X."

## Steps

1. **Explore the repo.** List root directory; read README; identify language(s), framework, entry points; map folder structure 1–2 levels deep. Every path in the tour must exist.
2. **Infer persona and depth.** From the request; default to new-joiner + standard.
3. **Plan the narrative.** 5-line outline before writing steps — where do we start, what's the arc, where do we end?
4. **Write steps.** Verify each `file` path and `line` number before including. Line numbers must point to something meaningful (a function signature, a key conditional, a type definition).
5. **Write the summary step.** Recap the key files and where to start for the most common change types.
6. **Output the `.tour` file.** Valid JSON; placed in `.tours/<descriptive-name>.tour`.
7. **Verify.** Open the tour in VS Code with the CodeTour extension; walk every step; confirm file paths and line numbers are correct.

## Review checklist

- **Every file path verified** — no paths to files that don't exist.
- **Line numbers meaningful** — pointing to a function signature or key line, not a blank line.
- **Narrative flows** — each step connects to the next; no teleporting between unrelated files.
- **Persona-appropriate depth** — quick tours don't rabbit-hole; deep tours don't skip the hard parts.
- **Summary step present** — what to read first for the most common change type.
- **Valid JSON** — `.tour` file parses without errors.

## Rules

- A tour with a wrong file path is worse than no tour — verify every path before committing.
- Only create `.tour` files — never modify source code to accommodate a tour.
- If the repo has fewer than 5 source files, create a quick-depth tour regardless of persona.
