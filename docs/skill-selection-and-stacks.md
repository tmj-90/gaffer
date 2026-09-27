# Skill selection & stacks

How the factory decides which SKILL.md packs to mount into a delivery prompt,
why that policy is deliberately *broad*, and where the `repositories.stack`
model is heading next.

Implementation: `runner/bin/select-skills.mjs` (CLI used by `tick.sh`).
Tests: `runner/test/select-skills.test.mjs`.

---

## 1. The model: broad-inclusion for task packs, stack-aware for stack packs

A skill's `area:` frontmatter tag sorts it into one of four buckets
(`skillMatches`, `UNIVERSAL_AREAS`, `DELIVERY_AREAS`, `STACK_PACK_AREAS` in
`select-skills.mjs`):

| Bucket | Areas | Rule |
| --- | --- | --- |
| **Universal** | `quality`, `testing`, `review`, `workflow`, `security` | Always eligible — the delivery mechanics fire on every ticket. |
| **Delivery** | `backend`, `data`, `refactor`, `docs` | Always eligible — every task-shaped pack fires regardless of stack (broad inclusion). |
| **Stack packs** | `language`, `frontend`, `mobile` | Follow the repo's **stack**: the stack's own conventions pack; the web design bar when the stack has a web token (`react`, `web`, `next`, `vue`, `svelte`, `angular`…); the mobile pack when it has a mobile token (`react-native`, `expo`, `ios`, `android`, `swift`, `kotlin`). **Fail-open**: an empty stack, or one made only of tokens the library does not recognise, mounts every stack pack. The ticket text pulls a pack in by name ("port the Kotlin client" → `kotlin-conventions`). |
| **Off-domain** | `marketing`, `product`, `planning`, `devops`, `infra`, `meta`, `security-ops` | Opt-in — mounted only if the skill is stack-tagged and the ticket's stack intersects, an explicit `--area` names it, or the ticket text plainly calls for it. |

Two refinements apply across buckets:

- A **stack tag on an always-on skill** is its author's applicability statement
  and is honoured once the stack is known: `frontend-testing` (tagged
  `react, web, …`) and the `accessibility-review` lens (web/mobile) stay off a
  Node or Python backend; `contract-test` and `e2e-browser-test` (tagged `node`)
  ride a Node service. Unknown stack → fail-open, as above.
- A skill with **no `area:`** and no stack tag is fully cross-cutting and always
  eligible.

### Why broad inclusion for the task packs

The earlier allowlist gated packs on the repo's `stack` string, and when that
string was mis-registered or incomplete it *silently excluded* the pack the
files in front of the agent needed (`java-conventions` never mounted on a Java
ticket whose repo `stack` didn't list `java`). An excluded skill is invisible:
the agent cannot ask for what it cannot see. Claude Code's progressive
disclosure loads only a mounted skill's name + description until it is invoked,
so an unused task pack costs one cached description line, while a missing one
costs the delivery its guidance. For the task-shaped packs (API endpoint,
migration, caching, webhooks…) the agent, not the selector, makes the final
call on what to open.

### Why the stack packs are stack-aware anyway

A wrong-language conventions pack is not a harmless extra line: it *contradicts*
the files in front of the agent (casing, layout, tooling, test runner), and with
nine language packs plus thirteen web and mobile packs on every ticket the one
that fits is one of 92 near-identical "conventions" lines. A live audit found
every Node delivery being handed `csharp-conventions`, `swift-conventions`,
`mobile-ui` and the React state-management pack. The mis-registration concern
that motivated broad inclusion is kept in a narrower form: the stack packs fail
**open** only when the stack is genuinely unknown, and the ticket text can still
pull a foreign pack in by naming its language.

### Why off-domain packs still stay opt-in

The denylist keeps marketing / product / planning / devops / infra / meta /
security-ops packs off a normal feature delivery. A backend feature ticket
should not be handed a slide-deck, an SEO audit, or a Terraform pattern pack —
those belong to different kinds of work and are pulled in explicitly via
`--area`, a stack tag like `terraform` / `kubernetes`, or ticket text that names
them.

---

## 1b. Role profiles — what each AGENT is handed

Selection used to be delivery-shaped only. The delivery agent got the stack/area/text
selection plus the universal mechanics; every other agent got a hard-coded list (the
reviewer: five skills, never the stack's conventions pack or a security lens, even
though `review-ticket` tells it to "review Java like Java") or the whole library.

`select-skills.mjs --role <role>` now selects per role (`ROLE_PROFILES`):

| Role | Core (always) | Lens areas | Stack packs | Text packs |
| --- | --- | --- | --- | --- |
| `delivery` | the universal mechanics (`run-tests`, `run-lint`, `run-coverage`, `minimalism`, `self-review`, `submit-review`, `record-evidence`, `create-branch`, `prepare-digest-delta`, `plan-change`) | — (the legacy stack/area selection, byte-identical) | language + surface | yes |
| `review` | `review-ticket`, `adversarial-reviewer`, `submit-review`, `record-evidence`, `engineering-craft`, `minimalism` | `review` (the lenses: `security-review`, `performance-review`, `accessibility-review`, `test-quality-review`, `migration-review`, `api-design-reviewer`), `security` | language + surface | no |
| `clarify` | `clarify`, `record-evidence`, `user-story`, `prd` | `security` | language | no |
| `test` | `black-box-test`, `run-tests`, `add-integration-test`, `e2e-browser-test`, `contract-test`, `test-fixtures-and-factories`, `record-evidence` | `testing` | language | no |
| `plan` | `plan-build`, `spec-author`, `user-story`, `rice`, `prd`, `product-discovery`, `database-schema-designer`, `api-design-reviewer`, `design-system`, `write-adr` | `planning` | language + surface | yes |
| `spec` | `spec-author`, `prd`, `user-story`, `product-discovery`, `write-adr` | `planning` | — | no |
| `product` | `product-owner`, `prd`, `rice`, `user-story`, `product-discovery`, `brand`, `page-cro` | `product` | — | yes |
| `merge` | `resolve-merge-conflict`, `run-tests`, `run-lint`, `record-evidence`, `minimalism` | — | language | no |
| `bootstrap` | `create-branch`, `record-evidence`, `minimalism`, `run-tests`, `run-lint`, `ci-cd-pipeline`, `docker-development`, `shell-scripting` | `quality` | language + surface | yes |

"Language packs" are the `area: language` skills whose `stack` tags intersect the
repo's stack (`typescript-conventions` for a TS repo, `java-conventions` for Java…).
"Surface packs" are the `frontend` / `mobile` packs, added when the stack is a web or
mobile one. Both fail open — every pack — when the stack is unknown (§1), and a lens
whose own stack tag rules the stack out (`accessibility-review` on a backend) is skipped.
The headless runners mount their role's set through `runner/lib/agent-home.mjs`
(`mountRoleSkills`): decompose → `plan`, spec-author → `spec`, product-owner-run →
`product`, tester-run → `test`; before this they symlinked the whole library. Names a profile lists that are not in the library are dropped silently, so
a trimmed library is safe. `review.sh` and `clarify.sh` mount their role's set (without
the delivery mechanics) and the reviewer's prompt names the lenses mounted for it.

### The lint gate

`runner/test/skills-lint.test.mjs` is the quality gate every `SKILL.md` must pass:
frontmatter (`name` = directory, trigger-phrased one-line `description`, `stack` list,
`area` in the buckets above), body shape (H1, ≥ 2 sections, a procedure, ≥ 220 words),
every backticked MCP-tool-shaped token names a real dispatch/memory tool, every
"`x` skill" cross-reference exists, no duplicate names or descriptions, and every role
profile's core skills exist. It exists because a skill once named a tool that does not
exist (`attach_delivery_evidence`) and every delivery that followed it silently failed.

## 2. Future direction: `stack` should become structured

### What the onboarding scanner writes

`packages/crew/src/scan/repoScan.ts` detects **every** ecosystem in the repo —
the manifests at the root plus those up to two directories down (`api/*.csproj`
beside `web/package.json`, or the `apps/*` / `services/*` / `packages/*`
layout; `node_modules`, `dist`, `.git` and secret dirs are never entered) — and
composes one compound label from them, root ecosystem first: a .NET solution
with a React SPA beside it is `csharp-typescript-react`, a Node root with a Go
service is `node-go`. The root ecosystem's commands become the repo's test /
lint / build commands. Detectors: Node (React / React Native / Expo variants),
Python, Rust, Java / Kotlin (Gradle with the Kotlin plugin), Go, .NET
(`*.sln` / `*.csproj` / `global.json`), Ruby (`Gemfile`), Swift
(`Package.swift`). Before this the scanner returned the FIRST manifest it found
in an if/else chain and had no .NET detector at all, so a .NET + TypeScript repo
was labelled `typescript-react` and, being a *known* stack, never received the
C# pack.

### Today's hack

`repositories.stack` is a single nullable **compound string**
(`packages/crew/src/config/schema.ts` — `stack: z.string().nullable()`), e.g.
`"typescript-react-native-expo-java"`. `expandStacks` / `ticketStacks` split it
on `-` / `/` into tokens so a skill tagged with either the broad or a specific
stack still matches. It works, but it is a lexical hack:

- No way to say a repo is *both* a TypeScript RN app *and* a Java service
  without smashing everything into one dash-joined blob.
- Token collisions (`native`, `expo`) leak across unrelated concerns.
- A monorepo with a web front end, a mobile app, and a Java backend has one
  flat string that describes none of its paths accurately.

### Where it should go

1. **`stack[]` (array) as the minimum step** — replace the compound string with
   an explicit list of stack tags, dropping the split-on-dash guesswork.
2. **Per-path stacks tied to the scope graph (better)** — the codebase already
   models sub-repo structure via `scope_nodes` / `ticket_scope_nodes` (see
   `docs/spec-driven-development.md` and `packages/memory/src/core/repoUnderstanding.ts`).
   Attaching a stack to a scope node lets a ticket resolve stacks from the
   *paths it actually touches* — real monorepo routing, not a repo-wide blob.

### The key insight: it's a refinement, not a prerequisite

Broad inclusion of the task packs and fail-open stack packs mean a wrong or
coarse `stack` value cannot *exclude* a pack: an unrecognised label mounts every
stack pack, a partially right compound label still reaches its own conventions
pack via `expandStacks`. What stack precision buys is a *tighter* mount — the
one conventions pack instead of nine, no design bar on a backend service — and
that is exactly what a structured `stack[]` or per-path scope routing would
sharpen further. Worth doing; not load-bearing for correctness.
