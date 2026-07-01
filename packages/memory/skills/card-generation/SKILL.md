---
name: card-generation
description: |
  Internal skill for onboard's file-card emission pass. Defines how to write one
  file card from a mechanical structure summary (imports, top-level symbols) plus
  an optional bounded head snippet — NEVER the whole file. Drives the per-file (or
  batched) model turn in onboard-analyze.mjs with a versioned prompt_version hash.
  Not for the ticket delivery flow.
stack: []
area: memory
---

# Write one file card

A card is a RETRIEVAL AID: it helps an agent pick WHAT TO READ. It is NEVER
authoritative source — the reader MUST open the file before editing. Say this
wherever a card is surfaced.

You get: a file's MECHANICAL STRUCTURE (imports, top-level symbol names) and
maybe a small HEAD SNIPPET. Nothing else — no full file, no language server, no
runtime. Produce: `tldr`, one `role_primary`, up to 4 `role_tags`.

## tldr (the key field)

Answers: what is this file's JOB and why does it EXIST?
- 1–2 sentences, ≤400 chars (hard cap 500 — stay clear).
- Concrete: name what it OWNS + its KEY responsibility.
- No filename/path restating. No vague verbs ("handles/manages/processes/deals
  with") without saying specifically what.
- Purpose unclear from the data? State what it STRUCTURALLY IS (e.g. "Zod schemas
  for the card record") instead of guessing intent.

GOOD: "Express router for `/api/cards` CRUD — owns the HTTP layer for card create/
read/search/delete. Read to trace request handling."
BAD: "Handles authentication" · "Utility functions" · "src/math.ts implementation"
· "Exports various helpers for working with the API".

## role_primary — pick exactly ONE (dominant role)

`entrypoint` (main/CLI/process start) · `route` (HTTP handlers/routers) ·
`service` (domain/business-logic orchestration) · `data-model` (interfaces/Zod/
type-only) · `migration` (DB schema migrations) · `config` (config/env loaders/
flags) · `test` · `util` (pure side-effect-free helpers) · `client` (HTTP clients/
SDK wrappers/connectors) · `middleware` (framework middleware/interceptors) ·
`store` (state/caches/registries) · `view` (UI components/templates/renderers) ·
`script` (one-shot scripts/CLI tools) · `types` (type/interface-only modules).

## role_tags — 0–4 secondary concerns

Short, lowercase, specific. e.g. `["auth","jwt"]`, `["fts","sqlite"]`.

## Never invent (hard rule)

NEVER name a symbol or behaviour not shown in that file's structure block. A
deterministic validator checks symbols against the real exports — invented ones
FAIL the card and poison retrieval. Unsure → omit; omission is safe, invention is
not. In batched prompts, use ONLY the file's own block (never another file's).

## Also

- Ground every claim in the shown structure + snippet.
- No secrets/tokens/credentials/PII in any field.
- No over-claiming scope, no guessing from filename, no false precision
  ("retries 3×" unless shown), no listing imports as capabilities.
- A card is a retrieval aid, never authoritative source.
