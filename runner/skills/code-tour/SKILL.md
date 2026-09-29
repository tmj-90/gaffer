---
name: code-tour
description: Use when asked to create a code walkthrough, onboarding tour, architecture tour, PR review tour, or any structured explanation of how a codebase works. Triggers on "create a code tour", "onboarding tour", "how does X work", "explain the codebase", "architecture walkthrough", "PR tour", or "contributor guide". Outputs a CodeTour `.tour` JSON file for the VS Code CodeTour extension, with a plain-markdown fallback for environments without it.
stack: []
area: docs
---

# Create persona-targeted, file-anchored code tours

A tour is a guided explanation (Diátaxis "explanation", anchored in code): a story for one
reader about what matters, why, and where to go next. Every anchor must resolve against the
current tree, and the tour must stay correct as the code moves.

## Persona and depth

| Request mentions | Persona | Depth |
|---|---|---|
| a PR / diff | pr-reviewer | standard, only files the diff touches plus their callers |
| "why did X break", RCA | rca-investigator | standard, along the failing path |
| onboarding, new joiner, contributor guide, or nothing | new-joiner | standard |
| quick tour | vibecoder | quick |
| architecture | architect | deep |
| security, auth | security-reviewer | standard, trust boundaries and input handling |

Quick: 5–8 steps, 1–2 sentences each. Standard: 10–20 steps, 3–5 sentences. Deep:
20–40 steps including invariants, failure modes and design rationale. A repo with fewer
than 5 source files gets a quick tour regardless.

## Tour file format (CodeTour schema)

```json
{
  "$schema": "https://aka.ms/codetour-schema",
  "title": "Request lifecycle — new joiner",
  "description": "How an HTTP request becomes a database write, for someone new to the repo.",
  "ref": "<commit sha the tour was verified against>",
  "steps": [
    { "directory": "src", "description": "Everything that ships lives under src/ ..." },
    { "file": "src/server.ts", "pattern": "^export function main\\(", "title": "Entry point",
      "description": "Execution starts here. `main()` wires config, the router and the DB pool. Next: the router." }
  ]
}
```

Required: top-level `title` and `steps`; each step needs `description`. Anchor a step with
`file` + `line` (1-based) or, preferably for code that will change, `file` + `pattern` (a
regex matched against line content — survives line shifts). `directory` steps introduce a
folder; a step with only `description` is a narrative interlude. Tours live in
`.tours/<kebab-name>.tour`.

## Procedure

1. **Map the repo.** Read the README and manifest(s); find entry points (server start,
   CLI main, handler registration, job scheduler); list folders two levels deep. For a PR
   tour, `git diff --name-only <base>...HEAD`.
2. **Pick persona and depth** from the table; default new-joiner/standard.
3. **Outline the arc in five lines**: where it starts, the path it follows (a real call
   chain or data flow), the one or two things most likely to bite (shared state,
   concurrency, persistence, auth checks), where it ends.
4. **Write steps along the call graph.** Each step says what this code is for, why it is
   shaped this way, and where the tour goes next. Don't narrate what the line literally
   says. Flag hazards explicitly ("two requests can reach this read-modify-write at once;
   the lock is taken in X").
5. **End with a summary step:** the 3–5 key files and where to start for the most common
   change types.
6. **Emit the markdown fallback** next to it (`.tours/<name>.md` or the requested doc):
   numbered `path/to/file.ts:42 — one line` entries in the same order, readable on GitHub
   without VS Code.
7. **Verify** (below), evidence with the `record-evidence` skill, then stop. Never modify
   source code to suit a tour.

## Verification (headless)

```bash
node -e '
const fs=require("fs");const t=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if(!t.title||!Array.isArray(t.steps))throw "missing title/steps";
t.steps.forEach((s,i)=>{ if(!s.description)throw `step ${i}: no description`;
 if(s.directory&&!fs.existsSync(s.directory))throw `step ${i}: no dir ${s.directory}`;
 if(!s.file)return; if(!fs.existsSync(s.file))throw `step ${i}: no file ${s.file}`;
 const L=fs.readFileSync(s.file,"utf8").split("\n");
 if(s.line&&(s.line<1||s.line>L.length||!L[s.line-1].trim()))throw `step ${i}: bad line ${s.line}`;
 if(s.pattern&&L.filter(l=>new RegExp(s.pattern).test(l)).length!==1)throw `step ${i}: pattern not unique`;});
console.log("ok",t.steps.length,"steps")' .tours/<name>.tour
```

Then read each anchored line and confirm it is the thing the step describes (a signature,
key conditional, type), not a blank line or comment. Record `ref` as `git rev-parse HEAD`.

## Review checklist (concrete defects only)

- A `file`, `directory`, `line` or `pattern` that does not resolve, or a pattern matching
  several lines.
- A step's description contradicts the code it points at.
- The tour skips the path the request asked about (e.g. a PR tour that ignores changed
  files).
- Invalid JSON or missing required fields; no summary step; no markdown fallback.
- Source files changed as part of the tour.
