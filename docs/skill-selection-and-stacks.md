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
| **Off-domain** | `marketing`, `product`, `planning`, `devops`, `infra`, `meta`, `security-ops` | Opt-in — mounted only if the skill is stack-tagged and the ticket's stack intersects (an empty or unknown stack is **not** a match here: no fail-open onto Terraform / Docker / the Kubernetes Operator pack), an explicit `--area` names it, or the ticket text plainly calls for it. |

Two refinements apply across buckets:

- A **stack tag on an always-on skill** is its author's applicability statement
  and is honoured once the stack is known: `frontend-testing` (tagged
  `react, web, …`) and the `accessibility-review` lens (web/mobile) stay off a
  Node or Python backend; `contract-test` and `e2e-browser-test` (tagged `node`)
  ride a Node service. Unknown stack → fail-open, as above.
- A **`node` tag means the JS/TS server runtime**, so it is satisfied by a
  `typescript` or `javascript` stack token too (`TAG_ALIASES`). The onboarding
  scanner labels most Node services `typescript` / `typescript-react`, never
  `node`; an exact-token compare kept ~25 backend / data / security packs
  (`add-api-endpoint`, `add-db-migration`, `error-handling`, `auth-session-and-oauth`,
  `data-privacy`…, all tagged `[node, python, go, …]`) off every TypeScript backend.
- A skill with **no `area:`** and no stack tag is fully cross-cutting and always
  eligible. `gaffer skills add` refuses one (see the lint gate below).
- **Text relevance** (`--text`, the ticket title + description head): an off-domain
  pack is pulled in when the text names it (every part of its name, or its name as
  a phrase), shares two distinctive words with its description, or — for packs whose
  names do not match how a ticket asks for them — contains one of its trigger words
  (`TEXT_TRIGGERS`): `runbook-generator` (runbook, playbook, on-call),
  `incident-response` (postmortem, outage, incident), `docker-development`
  (Docker, Dockerfile, docker-compose), `terraform-patterns` (terraform, OpenTofu),
  `kubernetes-operator` (CRD, kubebuilder, operator-sdk) and `seo-audit` (SEO, meta
  tags). A pack with a trigger list does not use the two-description-words rule
  (`seo-audit` used to ride "health check endpoint" through "SEO health check").
  There is no generic Kubernetes-manifests pack: the Operator pack says it is not
  one, so plain "kubernetes" / "helm" pull nothing.
- **Role-only, builder-only and user-only skills.** A role's own procedure
  (`review-ticket`, `adversarial-reviewer`, `black-box-test`, `clarify`, `plan-build`,
  `spec-author`, `product-owner`, `resolve-merge-conflict`) is mounted only by its
  role profile. The builder's skills (`self-review`, `submit-review` — "fix and
  re-test", "commit on the ticket branch") ride every delivery but are never another
  role's review lens. `caveman` (a chat mode a user switches on) and `create-branch`
  (the runner creates every factory branch; the delivery brief carries the branch and
  clean-tree check) are **user-only**: shipped for `gaffer skills install` into a
  human's own Claude Code, never mounted on a factory agent.

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
| `delivery` | the universal mechanics (`run-tests`, `run-lint`, `run-coverage`, `minimalism`, `self-review`, `record-evidence`, `prepare-digest-delta`, `plan-change` — exactly `GAFFER_UNIVERSAL_SKILLS` in `runner/lib/skills-mount.sh`, the set mounted even when the selector fails; a test pins the two equal) | — (the plain stack/area/text selection, which includes `submit-review`) | language + surface | yes |
| `review` | `review-ticket`, `adversarial-reviewer`, `record-evidence`, `engineering-craft`, `minimalism` | `review` (the lenses: `security-review`, `performance-review`, `accessibility-review`, `test-quality-review`, `migration-review`, `concurrency-review`, `api-design-reviewer`; not the builder's `self-review` / `submit-review`), `security` | language + surface | no |
| `clarify` | `clarify`, `record-evidence`, `user-story`, `prd` | `security` | language | no |
| `test` | `black-box-test`, `run-tests`, `add-integration-test`, `e2e-browser-test`, `contract-test`, `test-fixtures-and-factories`, `record-evidence` | `testing` | language | no |
| `plan` | `plan-build`, `spec-author`, `user-story`, `rice`, `prd`, `product-discovery`, `database-schema-designer`, `api-design-reviewer`, `design-system`, `write-adr` | `planning` | language + surface | yes |
| `spec` | `spec-author`, `prd`, `user-story`, `product-discovery`, `write-adr` | `planning` | — | no |
| `product` | `product-owner`, `prd`, `rice`, `user-story`, `product-discovery`, `brand`, `page-cro` | `product`, `marketing` (the PO proposes growth work too, and its run has no ticket text to pull `copywriting` / `seo-audit` / `aeo` with) | — | no |
| `merge` | `resolve-merge-conflict`, `run-tests`, `run-lint`, `record-evidence`, `minimalism` | — | language | no |
| `bootstrap` | `record-evidence`, `minimalism`, `run-tests`, `run-lint`, `ci-cd-pipeline`, `docker-development`, `shell-scripting`, plus the delivery selection | `quality` | language + surface | yes |

"Language packs" are the `area: language` skills whose `stack` tags intersect the
repo's stack (`typescript-conventions` for a TS repo, `java-conventions` for Java…).
"Surface packs" are the `frontend` / `mobile` packs, added when the stack is a web or
mobile one. Both fail open — every pack — when the stack is unknown (§1), and a lens
whose own stack tag rules the stack out (`accessibility-review` on a backend) is skipped.
Who mounts which profile (every live spawn site):

| Agent | Site | Profile | Stack / text it selects with |
| --- | --- | --- | --- |
| delivery | `tick.sh` | plain selection + `GAFFER_UNIVERSAL_SKILLS` | repo stack (narrowed by the paths the ticket names), title + description |
| greenfield bootstrap | `tick.sh` | `--role bootstrap` | the ticket's stack, title + description |
| reviewer, security reviewer | `lib/review.sh` | `--role review` | repo stack narrowed to the diff's paths |
| clarify | `lib/clarify.sh` | `--role clarify` | repo stack |
| tester | `bin/tester-run.mjs` | `test` | repo stack |
| decompose | `bin/decompose.mjs` | `plan` | the brownfield target repo's registered stack, the brief head (greenfield: no stack) |
| spec author | `bin/spec-author.mjs` | `spec` | — |
| product owner | `bin/product-owner-run.mjs` | `product` | — |
| merge-conflict resolver | `bin/merge-ticket.mjs` | `merge` | repo stack |

The `.mjs` runners mount through `runner/lib/agent-home.mjs` (`mountRoleSkills`).
Before this decompose passed no stack and no text (so a Python API's plan got
`swift-conventions`, `mobile-ui` and the React state pack through the empty-stack
fail-open) and the merge resolver symlinked the whole library. Names a profile lists
that are not in the library are dropped silently, so a trimmed library is safe.
`review.sh` and `clarify.sh` mount their role's set (without the delivery mechanics)
and the reviewer's prompt names the lenses mounted for it. When the delivery selector
prints nothing, the prompt recommends `GAFFER_UNIVERSAL_SKILLS` (the crew registry's
`fg skills` used to be the fallback; it lists role-only skills and names the library
does not carry).

crew.yaml's `context.max_skills` caps only the crew context packet (the mock `crew run`
loop and the crew MCP); `crew doctor` names it as mock-only. The live mounts above are
uncapped by design — an unused mounted skill costs one description line.

### Skill telemetry

Every spawn site above appends one row to `$GAFFER_DATA/skills-telemetry.jsonl`
(`GAFFER_SKILL_TELEMETRY` overrides) through `bin/record-skill-usage.mjs`: the role,
the stack, the skills actually MOUNTED (the mount dir, so the universal set counts),
and, best-effort, which were APPLIED — named in the agent's final output, or OPENED
(a Read or Bash target under `.claude/skills/<name>/` in the safety hook's tool ledger,
`$GAFFER_DATA/tool-metrics.jsonl`, scoped to the run's ticket or worktree and start
time; the opened list is recorded separately). The Health page's skill hit-rate reads
these rows. A Skill-tool invocation itself is visible to neither signal (the hook does
not see the Skill tool, and the json envelope carries no tool calls), so `applied` is a
lower bound.

### The lint gate

`runner/test/skills-lint.test.mjs` is the quality gate every `SKILL.md` must pass, and
`gaffer skills add` (`bin/skill-add.mjs`) runs the same per-skill checks
(`runner/lib/skill-lint.mjs`) on an outside skill before installing it, plus a
duplicate-description check against the installed library; a failing skill is refused
and nothing is written. The checks:
frontmatter (`name` = directory, trigger-phrased one-line `description`, `stack` list,
`area` in the buckets above — a skill with no area would be always-eligible on every delivery), body shape (H1, ≥ 2 sections, a procedure, ≥ 220 words),
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

### Per-path routing: what a job touches narrows the stack

A mixed repo's compound label mounts every ecosystem's packs. When the files a job
touches are known, `select-skills.mjs` **narrows** the stack to their ecosystems
(`narrowStacks`, `stacksFromPaths`; CLI `--path` / `--paths-file`):

- the **reviewer** passes the diff's file list (`git diff --name-only base...branch`),
  so a `.cs`-only change on a `csharp-typescript-react` repo is reviewed with the C#
  pack and no React design bar, and a `.tsx`-only change the other way round;
- the **delivery** agent passes the file paths the ticket *names* in its title or
  description ("… in `api/Shop.Api/Controllers/TasksController.cs`"); a ticket that
  names no file gets the full compound stack;
- the **tester** keeps the repo stack (its context is contract-only by design).

Tokens group into ecosystems (JS/TS incl. React and Node, .NET, Python, Go, Rust,
JVM, Swift, Ruby, shell): a repo token survives narrowing when its ecosystem is
touched, so `node`-tagged packs still ride a `.ts` change; paths that imply nothing
(docs, config) leave the stack unchanged; a repo whose label names none of the
touched ecosystems gains the path tokens rather than losing any. A surface area
derived from the full label (`--area frontend` for a web stack) is dropped when the
narrowed stack no longer carries that surface.
`runner/test/e2e-per-path-stack-routing.test.sh` proves it on a live .NET + React
repo for the builder and the reviewer.

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
pack via `expandStacks`, and per-path narrowing already gives the reviewer and a
path-naming ticket a single-ecosystem mount. What a structured `stack[]` or
scope-node paths would add is narrowing for tickets that name no file, from the
paths their scope node owns. Worth doing; not load-bearing for correctness.
