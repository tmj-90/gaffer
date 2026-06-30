---
name: card-generation
description: |
  Internal skill for onboard's file-card emission pass. Defines how to write
  one excellent file card from a mechanical structure summary (imports, top-level
  symbols) plus a bounded head snippet — NEVER the whole file. Used by
  onboard-analyze.mjs to drive the per-file model turn via a skill-derived
  prompt with a versioned prompt_version hash. Not intended for selection by
  the ticket delivery flow.
stack: []
area: memory
---

# Write one file card — the retrieval-aid discipline

A file card is a **retrieval aid**. Its job is to help an agent choose WHAT
TO READ — not to replace reading the actual file before editing. State this
clearly in every context a card appears.

You will be given the MECHANICAL STRUCTURE of a file (imports, top-level symbol
names) and a BOUNDED HEAD SNIPPET. You must produce a TLDR, a primary role
label, and up to four secondary role tags. You have no other information about
the file — you are not given the full file, a language server, or runtime logs.

**A card is never authoritative source. The reader must open the file before
editing.** This is non-negotiable and must be repeated in every agent-facing
surface that references cards.

## TLDR discipline

The TLDR is the most important field. It must answer: **what is this file's
job and why does it exist?**

Rules:
- 1–2 sentences only.
- Be concrete: name what the file OWNS and what its KEY RESPONSIBILITY is.
- Stay under 400 characters (the hard cap is 500; stay clear of it).
- Do NOT restate the filename or path.
- Do NOT use vague verbs: "handles", "manages", "deals with", "processes" — say
  specifically what it handles/manages/deals with/processes.
- If the file's purpose is not clear from the structure + snippet, say what it
  STRUCTURALLY IS (e.g. "TypeScript type definitions for the card schema") rather
  than guessing intent.

Examples of GOOD TLDRs:
- "Arithmetic helpers: exports `add`, `sub`, `mul`, `div` pure functions and the
  `PI` constant. Read when you need simple numeric operations without deps."
- "Express router for `/api/cards` CRUD endpoints. Owns the HTTP layer for card
  creation, retrieval, search, and deletion. Read to trace request handling."
- "Migration 0042: adds `file_card` and `file_card_fts` tables and the `repo_sync`
  watermark table to the SQLite schema."

Examples of BAD TLDRs:
- "Handles authentication" — vague; does it issue tokens, verify them, revoke them?
- "Utility functions" — what kind? For what domain?
- "src/math.ts implementation" — restates the path; adds no value.
- "This file exports various helpers for working with the API" — 'various' and
  'working with' are content-free filler.

## Role taxonomy

Use exactly ONE `role_primary` label from this list (pick the dominant role):

| Label | When to use |
|-------|-------------|
| `entrypoint` | The main entry point / CLI bootstrap / process start |
| `route` | HTTP route handlers / Express/Fastify/Hono routers |
| `service` | Domain service / business-logic orchestration layer |
| `data-model` | TypeScript interfaces, Zod schemas, type-only files |
| `migration` | Database schema migration files |
| `config` | Configuration files, env loaders, feature-flag definitions |
| `test` | Test files (unit, integration, e2e) |
| `util` | Pure helper functions with no external side effects |
| `client` | HTTP clients, SDK wrappers, external service connectors |
| `middleware` | Express/framework middleware, request interceptors |
| `store` | State management, caches, in-memory registries |
| `view` | UI components, templates, page renderers |
| `script` | One-shot scripts, data-import utilities, CLI tools |
| `types` | TypeScript type/interface-only modules |

`role_tags` (0–4 tags) should name secondary concerns, e.g. `["auth", "jwt"]`
or `["fts", "sqlite"]`. Keep tags short, lowercase, specific.

## Symbols discipline

**NEVER invent a symbol or behaviour you did not see in the structure block.**

The deterministic validator will compare your symbol list against what the file
actually exports — invented symbols FAIL the card and set `model_status =
'failed_validation'`. The cost of over-claiming is high: it poisons retrieval.

If you are unsure whether a symbol is present, omit it. Omission is safe;
invention is not.

Only list symbols that appear in the **Imports** or **Top-level symbols** block
provided to you. Do not infer names from the snippet unless the snippet shows
an explicit declaration.

## Anti-patterns that must NOT appear in a card

1. **Over-claiming scope** — "Provides comprehensive auth management including
   JWT issuance, revocation, session tracking, and audit logging" when the file
   only has `verifyToken`.
2. **Guessing from the filename** — writing a TLDR for `auth.ts` that talks
   about authentication when the structure shows only generic utilities.
3. **Vague capability statements** — "handles various aspects of the data layer".
4. **Restating imports as capabilities** — listing every dependency as a feature.
5. **Fabricating symbols** — naming symbols not visible in the provided structure.
6. **False precision** — claiming specific behaviour (e.g. "retries 3 times")
   when the snippet doesn't show it.

## Hard rules

1. **Ground every claim** in the structure + snippet shown. If you can't point
   to it in the data you were given, don't say it.
2. **TLDR ≤ 400 characters** (enforced; the validator caps at 500).
3. **Never include secrets, tokens, credentials, or PII** in any field.
4. **role_primary must be one of the taxonomy labels** above.
5. **role_tags: max 4, all lowercase, no invented jargon**.
6. **A card is a retrieval aid, never authoritative source.** Repeat this every
   time a card is surfaced to an agent.
