import type { ZodTypeAny } from "zod";

import { VERSION } from "../../version.js";
import * as S from "../schemas.js";
import { type JsonSchema, zodToJsonSchema } from "./zodJsonSchema.js";

/**
 * The REST surface as data: one {@link EndpointSpec} per method + path the
 * hand-rolled router in `server.ts` / `routes/*.ts` serves. {@link buildOpenApiDocument}
 * turns it into an OpenAPI 3.1 document (served at `GET /api/openapi.json`, committed
 * as `docs/openapi.json`, checked in CI).
 *
 * Request bodies and query schemas are the SAME zod objects the routes parse with, so
 * the contract cannot drift from validation. Paths are pinned to the router by
 * `test/api-openapi.test.ts`: every literal path segment here must appear in the
 * route source, and every route sub-path constant must appear here.
 *
 * Response bodies are described, not schema'd, in this first version: the read
 * models are composed views whose shapes live in TypeScript types, not zod. Each
 * operation names the type it returns in its description so a reader can find it.
 */

/** Who may call an operation (see api/auth.ts). */
export type Capability = "public" | "read" | "full";

export interface ResponseSpec {
  status: number;
  description: string;
  /** Media type of the body; omitted = no body. */
  content?: "json" | "text" | "markdown" | "sse" | "html";
}

export interface EndpointSpec {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Router path with `:param` placeholders. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  capability: Capability;
  /** Request body: the exported schema name in `api/schemas.ts` (kept as a component). */
  body?: keyof typeof S;
  /** Query parameters: an exported schema name (object) or ad-hoc parameters. */
  query?:
    | keyof typeof S
    | Record<string, { description: string; schema?: JsonSchema; required?: boolean }>;
  responses: ResponseSpec[];
  /** Operation id override (default derived from method + path). */
  operationId?: string;
}

const ok = (description: string): ResponseSpec => ({ status: 200, description, content: "json" });
const created = (description: string): ResponseSpec => ({
  status: 201,
  description: `${description} The Location header names the created resource.`,
  content: "json",
});
const accepted = (description: string): ResponseSpec => ({
  status: 202,
  description,
  content: "json",
});
const notFound: ResponseSpec = {
  status: 404,
  description: "No such resource (`NOT_FOUND`).",
  content: "json",
};
const conflict: ResponseSpec = {
  status: 409,
  description:
    "The state machine or a claim refused the change (`ILLEGAL_TRANSITION`, `STATE_CONFLICT`, `CLAIM_REQUIRED`, …).",
  content: "json",
};
const invalid: ResponseSpec = {
  status: 422,
  description: "The body or query failed validation (`VALIDATION_ERROR`).",
  content: "json",
};

const T = {
  tickets: "Tickets",
  review: "Review & delivery",
  scopes: "Ticket scopes & repos",
  decisions: "Decisions",
  claims: "Claims",
  scope: "Factory Map (scope graph)",
  plan: "Plan sessions",
  epics: "Epics & specs",
  repos: "Repositories & agents",
  work: "Runner actions",
  config: "Configuration",
  read: "Read models",
  memory: "Memory",
  events: "Events",
  meta: "Meta",
} as const;

/** Every endpoint the router serves, in router order. */
export const ENDPOINTS: readonly EndpointSpec[] = [
  // --- Meta / public bootstrap --------------------------------------------
  {
    method: "GET",
    path: "/healthz",
    tag: T.meta,
    summary: "Liveness probe",
    description:
      "Token-free and exempt from the Host/Origin check; carries no control-plane state.",
    capability: "public",
    responses: [ok('`{ status: "ok" }`.')],
  },
  {
    method: "GET",
    path: "/api/openapi.json",
    tag: T.meta,
    summary: "This document",
    description:
      "The OpenAPI 3.1 description of the REST surface, generated from the same schemas the routes validate with.",
    capability: "read",
    responses: [ok("The OpenAPI document.")],
  },

  // --- /api identity & credentials ----------------------------------------------
  {
    method: "GET",
    path: "/api/whoami",
    tag: T.meta,
    summary: "How this request authenticated",
    description:
      "The capability tier, the actor this credential's writes are attributed to, and the principal (`null` for the shared token).",
    capability: "read",
    responses: [ok("`{ capability, actor: { type, id }, principal: { id, name } | null }`.")],
  },
  {
    method: "GET",
    path: "/api/principals",
    tag: T.config,
    summary: "List API principals",
    description:
      "Every named credential, newest first, revoked ones included. Never carries token material.",
    capability: "read",
    responses: [ok("`{ principals: PrincipalView[] }`.")],
  },
  {
    method: "POST",
    path: "/api/principals",
    tag: T.config,
    summary: "Mint a named API credential",
    description:
      "Creates a principal bound to an actor identity (`actor_type`, `actor_id`) and a capability (`full` or `read`). The response carries the bearer token **once**; only its SHA-256 is stored.",
    capability: "full",
    body: "createPrincipalBody",
    responses: [
      created("`{ principal, token }` — the only time the token is shown."),
      invalid,
      {
        status: 409,
        description: "A principal with that name exists (`DUPLICATE`).",
        content: "json",
      },
    ],
  },
  {
    method: "DELETE",
    path: "/api/principals/:id",
    tag: T.config,
    summary: "Revoke an API credential",
    description:
      "Stamps `revoked_at`; the row stays for the audit trail. `:id` accepts the id or the name.",
    capability: "full",
    responses: [
      ok("`{ principal }`."),
      notFound,
      { status: 409, description: "Already revoked (`NO_OP`).", content: "json" },
    ],
  },

  // --- /api configuration ----------------------------------------------------
  {
    method: "GET",
    path: "/api/settings",
    tag: T.config,
    summary: "List factory settings",
    description:
      "Every known setting with its file value, whether the environment locks it, and its group (`SettingView[]`).",
    capability: "read",
    responses: [ok("`{ settings: SettingView[] }`.")],
  },
  {
    method: "POST",
    path: "/api/settings",
    tag: T.config,
    summary: "Write factory settings",
    description:
      "Merges the given keys into settings.json atomically. Env-locked keys are rejected (the environment always wins); unknown keys are ignored; invalid values are reported.",
    capability: "full",
    body: "settingsBody",
    responses: [ok("`{ settings, written, rejected, ignored, invalid }`."), invalid],
  },
  {
    method: "GET",
    path: "/api/idle-loops",
    tag: T.config,
    summary: "Read the crew idle-loop configuration",
    capability: "read",
    responses: [
      ok(
        "The `loops.idle_*` rows (each flagged `maintenanceLane`), the `maintenance` switch and the `selfImprove` gate from crew.yaml; a missing file is a clean not-configured shape.",
      ),
    ],
  },
  {
    method: "PUT",
    path: "/api/idle-loops",
    tag: T.config,
    summary: "Write the crew idle-loop configuration",
    description:
      "Loop rows plus the optional `maintenance` switch and `self_improve` gate (opt-in repos, risk ceiling, per-tick cap). Repo names are cross-checked against the registered repositories. The crew runner re-reads crew.yaml on its next tick.",
    capability: "full",
    body: "idleLoopsBody",
    responses: [ok("The written slice."), invalid],
  },
  {
    method: "GET",
    path: "/api/autonomy/policies",
    tag: T.config,
    summary: "List active graduated-autonomy policies",
    capability: "read",
    responses: [ok("`{ policies: AutonomyPolicy[] }`.")],
  },
  {
    method: "POST",
    path: "/api/autonomy/policy",
    tag: T.config,
    summary: "Enable or disable an autonomy policy",
    description:
      "Security-critical. Enabling (`mode` other than `off`) requires `confirm: true`, the operator's explicit acknowledgement; disabling is always permitted.",
    capability: "full",
    body: "autonomyPolicyBody",
    responses: [ok("The resulting policy."), invalid],
  },
  {
    method: "GET",
    path: "/api/autonomy/recommendations",
    tag: T.read,
    summary: "Advisory autonomy recommendations",
    capability: "read",
    responses: [ok("`{ recommendations: AutonomyRecommendation[] }`.")],
  },

  // --- /api events -------------------------------------------------------------
  {
    method: "GET",
    path: "/api/events/stream",
    tag: T.events,
    summary: "Live event stream (Server-Sent Events)",
    description:
      "Tails the append-only `work_events` log as `event: work_event` messages (metadata only, the same safe shape as `/api/activity`), `id` = event seq, a `ping` every 15 s. Resume with `?since=<seq>`. At most 16 concurrent clients; a 17th gets 503 `STREAM_BUSY`.",
    capability: "read",
    query: {
      since: {
        description: "Replay events with seq greater than this before tailing.",
        schema: { type: "integer", minimum: 0 },
      },
    },
    responses: [
      { status: 200, description: "`text/event-stream`.", content: "sse" },
      { status: 503, description: "Too many stream clients (`STREAM_BUSY`).", content: "json" },
    ],
  },

  // --- /api memory ------------------------------------------------------------
  {
    method: "GET",
    path: "/api/memory/digest/:repo",
    tag: T.memory,
    summary: "Repo digest from the memory store",
    description:
      "Read server-side through the configured memory CLI. Degrades to `{ available: false, reason }` with 200 when the memory product is unavailable.",
    capability: "read",
    responses: [ok("The digest, or `{ available: false }`."), invalid],
  },
  {
    method: "GET",
    path: "/api/memory/features/:repo",
    tag: T.memory,
    summary: "Shipped-features inventory from the memory store",
    capability: "read",
    query: {
      status: { description: "Filter by feature status." },
      node: { description: "Filter by scope node." },
    },
    responses: [ok("The features, or `{ available: false }`."), invalid],
  },
  {
    method: "GET",
    path: "/api/memory/lore",
    tag: T.memory,
    summary: "Lore list from the memory store",
    capability: "read",
    responses: [ok("The lore records, or `{ available: false }`.")],
  },

  // --- /api read models ---------------------------------------------------------
  {
    method: "GET",
    path: "/api/board",
    tag: T.read,
    summary: "Kanban board",
    capability: "read",
    query: { repo: { description: "Limit to one repository (name or id)." } },
    responses: [ok("`BoardView`: the columns plus the closed area.")],
  },
  {
    method: "GET",
    path: "/api/dashboard",
    tag: T.read,
    summary: "Dashboard summary tiles",
    capability: "read",
    responses: [ok("`DashboardView`.")],
  },
  {
    method: "GET",
    path: "/api/human-queue",
    tag: T.read,
    summary: "What a human owns right now",
    description:
      "Pending decisions, sign-offs, parked tickets and dependents of cancelled or failed tickets.",
    capability: "read",
    responses: [ok("`HumanQueueView`.")],
  },
  {
    method: "GET",
    path: "/api/activity",
    tag: T.read,
    summary: "Cross-ticket event feed",
    capability: "read",
    query: "activityQuery",
    responses: [ok("Newest-first `ActivityItem[]` (metadata only).")],
  },
  {
    method: "GET",
    path: "/api/rework/bouncing",
    tag: T.read,
    summary: "Tickets ranked by repeated rework",
    capability: "read",
    query: {
      min: {
        description: "Minimum rework count to include.",
        schema: { type: "integer", minimum: 1 },
      },
      limit: { description: "Maximum rows.", schema: { type: "integer", minimum: 1 } },
    },
    responses: [ok("`BouncingTicket[]`.")],
  },
  {
    method: "GET",
    path: "/api/audit",
    tag: T.read,
    summary: "Redacted tool-audit tail",
    capability: "read",
    query: { limit: { description: "Maximum rows.", schema: { type: "integer", minimum: 1 } } },
    responses: [ok("`{ entries: AuditEntry[] }`.")],
  },
  {
    method: "GET",
    path: "/api/runs",
    tag: T.read,
    summary: "Active and recent runs",
    capability: "read",
    query: "runsQuery",
    responses: [ok("`{ active: RunView[], recent: RunView[] }`.")],
  },
  {
    method: "GET",
    path: "/api/runs/:id",
    tag: T.read,
    summary: "Run detail",
    capability: "read",
    responses: [ok("`RunDetail` (phase, model, turns, cost, log tail, outcome)."), notFound],
  },
  {
    method: "GET",
    path: "/api/runs/:id/log",
    tag: T.read,
    summary: "Run log tail",
    capability: "read",
    responses: [
      {
        status: 200,
        description: "The last 64 KB of the run log (`text/plain`).",
        content: "text",
      },
      notFound,
    ],
  },
  {
    method: "GET",
    path: "/api/cost",
    tag: T.read,
    summary: "Spend summary from the usage ledger",
    capability: "read",
    responses: [ok("`CostView`: totals, today, by repo, top tickets.")],
  },
  {
    method: "GET",
    path: "/api/health",
    tag: T.read,
    summary: "Factory health and ROI",
    description:
      "Event-log hash-chain integrity, spend, event-derived cycle time and throughput, flow efficiency, governance, skills and recall.",
    capability: "read",
    query: {
      window_days: {
        description: "Window for the flow metrics.",
        schema: { type: "integer", minimum: 1 },
      },
    },
    responses: [ok("`HealthView`.")],
  },

  // --- /tickets ------------------------------------------------------------------
  {
    method: "GET",
    path: "/tickets",
    tag: T.tickets,
    summary: "List tickets",
    capability: "read",
    query: "ticketListQuery",
    responses: [ok("`Ticket[]`."), invalid],
  },
  {
    method: "POST",
    path: "/tickets",
    tag: T.tickets,
    summary: "Create a ticket",
    description:
      "Optionally links a repository, scope nodes and per-repo access. When `repoIds` is given at least one must be a write repo.",
    capability: "full",
    body: "createTicketBody",
    responses: [created("The new `Ticket`."), invalid],
  },
  {
    method: "GET",
    path: "/tickets/:id",
    tag: T.tickets,
    summary: "Ticket detail",
    description:
      "The full `TicketView`: acceptance criteria, repos, scopes, decisions, dependencies, evidence, events and the rework trail. `:id` accepts the ticket id or number.",
    capability: "read",
    responses: [ok("`TicketView`."), notFound],
  },
  {
    method: "POST",
    path: "/tickets/:id/acceptance-criteria",
    tag: T.tickets,
    summary: "Add an acceptance criterion",
    description:
      "An AC may carry a `check_command` the runner executes in the delivery worktree; the done gate refuses a checked AC the runner has not passed.",
    capability: "full",
    body: "addAcBody",
    responses: [created("The new `AcceptanceCriterion`."), notFound, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/ready",
    tag: T.tickets,
    summary: "Mark ready for delivery",
    capability: "full",
    responses: [ok("The updated `Ticket`."), notFound, conflict],
  },
  {
    method: "POST",
    path: "/tickets/:id/move",
    tag: T.tickets,
    summary: "Move on the board",
    description: "A human board move through the state machine; illegal edges are refused.",
    capability: "full",
    body: "moveTicketBody",
    responses: [ok("The updated `Ticket`."), notFound, conflict, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/human-claim",
    tag: T.tickets,
    summary: "Claim a ready ticket by hand",
    capability: "full",
    body: "humanClaimBody",
    responses: [ok("The updated `Ticket` (in_progress)."), notFound, conflict],
  },
  {
    method: "POST",
    path: "/tickets/:id/human-release",
    tag: T.tickets,
    summary: "Hand a by-hand ticket back to the queue",
    capability: "full",
    body: "humanClaimBody",
    responses: [ok("The updated `Ticket` (ready)."), notFound, conflict],
  },
  {
    method: "POST",
    path: "/tickets/:id/ready-approval",
    tag: T.tickets,
    summary: "Grant the regulated-pack ready approval",
    capability: "full",
    responses: [ok("The updated `Ticket`."), notFound, conflict],
  },
  {
    method: "GET",
    path: "/tickets/:id/events",
    tag: T.events,
    summary: "Ticket event timeline",
    capability: "read",
    responses: [ok("`WorkEvent[]` (with `correlation_id` per tick and the hash chain)."), notFound],
  },
  {
    method: "GET",
    path: "/tickets/:id/rework-trail",
    tag: T.review,
    summary: "Ordered rework history",
    description: "Why the ticket bounced, oldest first.",
    capability: "read",
    responses: [ok("`ReworkTrailEntry[]`."), notFound],
  },
  {
    method: "POST",
    path: "/tickets/:id/review/approve",
    tag: T.review,
    summary: "Approve the review",
    description:
      "Moves the ticket to ready_for_merge and triggers the merge runner. The reviewer may not be the delivering agent.",
    capability: "full",
    responses: [ok("`{ ticket, merge }`."), notFound, conflict],
  },
  {
    method: "POST",
    path: "/tickets/:id/review/reject",
    tag: T.review,
    summary: "Reject the review",
    description:
      "Sends the ticket back to rework with the reason as feedback; `captureLore` files a lore draft in the memory store.",
    capability: "full",
    body: "rejectReviewBody",
    responses: [ok("The updated `Ticket`."), notFound, conflict, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/merge",
    tag: T.review,
    summary: "Merge an approved ticket that has not landed",
    description:
      "Fires the merge runner for a ticket in `ready_for_merge` (the runner's approve-only path, lite mode, or a merge that hit a conflict left it there). 409 unless the ticket is in ready_for_merge.",
    capability: "full",
    responses: [ok("`{ ticket, merge }` — the merge run was started (202)."), notFound, conflict],
  },
  {
    method: "POST",
    path: "/tickets/:id/mark-merged",
    tag: T.review,
    summary: "Merge-complete callback",
    description: "ready_for_merge → done. Acts as the system actor.",
    capability: "full",
    responses: [ok("The updated `Ticket`."), notFound, conflict],
  },
  {
    method: "POST",
    path: "/tickets/:id/reopen-for-review",
    tag: T.review,
    summary: "Reopen a done ticket for re-review",
    description:
      "The auto-merge re-approval callback (done → in_review). Acts as the system actor.",
    capability: "full",
    body: "reopenForReviewBody",
    responses: [ok("The updated `Ticket`."), notFound, conflict, invalid],
  },
  {
    method: "GET",
    path: "/tickets/:id/diff",
    tag: T.review,
    summary: "Delivery diff",
    description: "`git diff <default branch>...<delivery branch>` per write repository.",
    capability: "read",
    responses: [ok("`{ repos: RepoDiff[] }`."), notFound],
  },
  {
    method: "GET",
    path: "/tickets/:id/dossier",
    tag: T.review,
    summary: "Delivery dossier",
    description:
      "The tamper-evident evidence artifact. JSON by default; markdown with `?format=markdown` or `Accept: text/markdown`.",
    capability: "read",
    query: {
      format: {
        description: "`markdown` for the rendered document.",
        schema: { type: "string", enum: ["json", "markdown"] },
      },
    },
    responses: [
      ok("`Dossier`."),
      { status: 200, description: "The rendered dossier (`text/markdown`).", content: "markdown" },
      notFound,
    ],
  },
  {
    method: "POST",
    path: "/tickets/:id/testable",
    tag: T.review,
    summary: "Set black-box testability",
    capability: "full",
    body: "setTestableBody",
    responses: [ok("The updated `Ticket`."), notFound, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/test-contract",
    tag: T.review,
    summary: "Record the testing handover contract",
    capability: "full",
    body: "setTestContractBody",
    responses: [ok("The updated `Ticket`."), notFound, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/tester",
    tag: T.review,
    summary: "Record the independent tester's verdict",
    description: "pass → ready_for_merge, fail → refining. Acts as the system actor.",
    capability: "full",
    body: "testerVerdictBody",
    responses: [ok("The updated `Ticket`."), notFound, conflict, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/wont-do",
    tag: T.tickets,
    summary: "Mark won't-do",
    capability: "full",
    body: "wontDoBody",
    responses: [ok("The updated `Ticket` (cancelled)."), notFound, conflict, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/reopen",
    tag: T.tickets,
    summary: "Reopen a won't-do ticket",
    capability: "full",
    body: "reopenWontDoBody",
    responses: [ok("The updated `Ticket`."), notFound, conflict, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/continue",
    tag: T.review,
    summary: "Continue a paused delivery",
    description: "For a delivery paused on a spend cap.",
    capability: "full",
    body: "continuePausedBody",
    responses: [ok("The updated `Ticket`."), notFound, conflict],
  },
  {
    method: "POST",
    path: "/tickets/:id/stop",
    tag: T.review,
    summary: "Stop a paused delivery",
    capability: "full",
    body: "stopPausedBody",
    responses: [ok("The updated `Ticket` (cancelled)."), notFound, conflict, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/delivery-artifact",
    tag: T.review,
    summary: "Record the delivery artifact",
    description: "Branch, PR URL, commit and diff summary.",
    capability: "full",
    body: "recordDeliveryArtifactBody",
    responses: [ok("The updated `Ticket`."), notFound, invalid],
  },
  {
    method: "PUT",
    path: "/tickets/:id/reviewer",
    tag: T.review,
    summary: "Assign the reviewer",
    capability: "full",
    body: "assignReviewerBody",
    responses: [ok("The updated `Ticket`."), notFound, invalid],
  },
  {
    method: "GET",
    path: "/tickets/:id/required-capabilities",
    tag: T.tickets,
    summary: "List required capabilities",
    capability: "read",
    responses: [ok("`{ capabilities: string[] }`."), notFound],
  },
  {
    method: "PUT",
    path: "/tickets/:id/required-capabilities",
    tag: T.tickets,
    summary: "Replace required capabilities",
    capability: "full",
    body: "setRequiredCapabilitiesBody",
    responses: [ok("`{ capabilities: string[] }`."), notFound, invalid],
  },
  {
    method: "GET",
    path: "/tickets/:id/scopes",
    tag: T.scopes,
    summary: "List scope links",
    capability: "read",
    responses: [ok("`TicketScopeLink[]`."), notFound],
  },
  {
    method: "POST",
    path: "/tickets/:id/scopes",
    tag: T.scopes,
    summary: "Link a scope node",
    capability: "full",
    body: "linkTicketScopeBody",
    responses: [created("The new link."), notFound, invalid],
  },
  {
    method: "DELETE",
    path: "/tickets/:id/scopes/:nodeId",
    tag: T.scopes,
    summary: "Unlink a scope node",
    capability: "full",
    responses: [ok("`{ ok: true }`."), notFound],
  },
  {
    method: "PUT",
    path: "/tickets/:id/primary-scope",
    tag: T.scopes,
    summary: "Set the primary scope node",
    capability: "full",
    body: "setPrimaryScopeBody",
    responses: [ok("The updated links."), notFound, invalid],
  },
  {
    method: "PUT",
    path: "/tickets/:id/repo-access",
    tag: T.scopes,
    summary: "Set a repository access boundary",
    description: "write, read or test access for one repository on this ticket.",
    capability: "full",
    body: "setTicketRepoAccessBody",
    responses: [ok("The updated access rows."), notFound, invalid],
  },
  {
    method: "GET",
    path: "/tickets/:id/work-repos",
    tag: T.scopes,
    summary: "Execution-boundary repositories",
    description: "The repos partitioned by access, as the runner sees them.",
    capability: "read",
    responses: [ok("`{ write: [], read: [], test: [] }`."), notFound],
  },
  {
    method: "POST",
    path: "/tickets/:id/mono-fallback",
    tag: T.scopes,
    summary: "Promote a single unmapped repository to write access",
    capability: "full",
    responses: [ok("The updated access rows."), notFound, conflict],
  },
  {
    method: "GET",
    path: "/tickets/:id/repo-suggestions",
    tag: T.scopes,
    summary: "Advisory scope-to-repository suggestions",
    capability: "read",
    responses: [ok("`RepoSuggestion[]`."), notFound],
  },
  {
    method: "GET",
    path: "/tickets/:id/claimability",
    tag: T.tickets,
    summary: "Readiness preview",
    capability: "read",
    responses: [ok("`{ ready, blockers, warnings }`."), notFound],
  },
  {
    method: "GET",
    path: "/tickets/:id/dependencies",
    tag: T.tickets,
    summary: "List dependencies",
    capability: "read",
    responses: [ok("`TicketDependency[]`."), notFound],
  },
  {
    method: "POST",
    path: "/tickets/:id/dependencies",
    tag: T.tickets,
    summary: "Add a dependency edge",
    capability: "full",
    body: "addTicketDependencyBody",
    responses: [created("The new edge."), notFound, conflict, invalid],
  },
  {
    method: "DELETE",
    path: "/tickets/:id/dependencies/:dependsOn",
    tag: T.tickets,
    summary: "Remove a dependency edge",
    capability: "full",
    responses: [ok("`{ ok: true }`."), notFound],
  },
  {
    method: "GET",
    path: "/tickets/:id/repo-deliveries",
    tag: T.review,
    summary: "List per-repository deliveries",
    capability: "read",
    responses: [ok("`RepoDelivery[]`."), notFound],
  },
  {
    method: "POST",
    path: "/tickets/:id/repo-deliveries",
    tag: T.review,
    summary: "Record a per-repository delivery",
    capability: "full",
    body: "recordRepoDeliveryBody",
    responses: [created("The new `RepoDelivery`."), notFound, invalid],
  },

  // --- /decisions ------------------------------------------------------------------
  {
    method: "GET",
    path: "/decisions",
    tag: T.decisions,
    summary: "List pending decisions",
    capability: "read",
    responses: [ok("`Decision[]`.")],
  },
  {
    method: "POST",
    path: "/decisions",
    tag: T.decisions,
    summary: "Create a decision",
    capability: "full",
    body: "createDecisionBody",
    responses: [created("The new `Decision`."), invalid],
  },
  {
    method: "POST",
    path: "/decisions/:id/resolve",
    tag: T.decisions,
    summary: "Resolve a decision",
    capability: "full",
    body: "resolveDecisionBody",
    responses: [ok("The resolved `Decision`."), notFound, conflict, invalid],
  },

  // --- /claims ------------------------------------------------------------------------
  {
    method: "GET",
    path: "/claims",
    tag: T.claims,
    summary: "List active claims",
    capability: "read",
    responses: [ok("`Claim[]`.")],
  },
  {
    method: "POST",
    path: "/claims/:id/revoke",
    tag: T.claims,
    summary: "Revoke a claim",
    capability: "full",
    responses: [ok("The revoked `Claim`."), notFound, conflict],
  },

  // --- /scope (Factory Map) ------------------------------------------------------------
  {
    method: "POST",
    path: "/scope/repo-suggestions",
    tag: T.scope,
    summary: "Suggest repositories for a ticket that does not exist yet",
    description:
      "Read-only despite the verb: takes the title, description and scopes and returns suggestions.",
    capability: "full",
    body: "suggestReposBody",
    responses: [ok("`RepoSuggestion[]`."), invalid],
  },
  {
    method: "GET",
    path: "/scope/unmapped-repos",
    tag: T.scope,
    summary: "Repositories mapped to no scope node",
    capability: "read",
    responses: [ok("`Repository[]`.")],
  },
  {
    method: "GET",
    path: "/scope/nodes",
    tag: T.scope,
    summary: "List scope nodes",
    capability: "read",
    responses: [ok("`ScopeNode[]`.")],
  },
  {
    method: "POST",
    path: "/scope/nodes",
    tag: T.scope,
    summary: "Create a scope node",
    capability: "full",
    body: "createScopeNodeBody",
    responses: [created("The new `ScopeNode`."), invalid],
  },
  {
    method: "GET",
    path: "/scope/nodes/:id",
    tag: T.scope,
    summary: "Scope node detail",
    capability: "read",
    responses: [ok("`ScopeNode` plus linked repositories."), notFound],
  },
  {
    method: "PATCH",
    path: "/scope/nodes/:id",
    tag: T.scope,
    summary: "Update a scope node",
    capability: "full",
    body: "updateScopeNodeBody",
    responses: [ok("The updated `ScopeNode`."), notFound, invalid],
  },
  {
    method: "DELETE",
    path: "/scope/nodes/:id",
    tag: T.scope,
    summary: "Delete a scope node",
    capability: "full",
    responses: [
      ok("`{ ok: true }`."),
      notFound,
      {
        status: 409,
        description: "The node is still in use (`SCOPE_NODE_IN_USE`).",
        content: "json",
      },
    ],
  },
  {
    method: "GET",
    path: "/scope/edges",
    tag: T.scope,
    summary: "List scope edges",
    capability: "read",
    query: { node: { description: "Only edges touching this node." } },
    responses: [ok("`ScopeEdge[]`.")],
  },
  {
    method: "POST",
    path: "/scope/edges",
    tag: T.scope,
    summary: "Create a scope edge",
    capability: "full",
    body: "createScopeEdgeBody",
    responses: [created("The new `ScopeEdge`."), invalid],
  },
  {
    method: "DELETE",
    path: "/scope/edges/:id",
    tag: T.scope,
    summary: "Delete a scope edge",
    capability: "full",
    responses: [ok("`{ ok: true }`."), notFound],
  },
  {
    method: "GET",
    path: "/scope/repos",
    tag: T.scope,
    summary: "Repositories of a node, or scopes of a repository",
    description: "Exactly one of `node` or `repo` is required.",
    capability: "read",
    query: {
      node: { description: "Scope node id: list its repositories." },
      repo: { description: "Repository id: list its scope nodes." },
    },
    responses: [ok("`ScopeRepo[]`."), invalid],
  },
  {
    method: "POST",
    path: "/scope/repos",
    tag: T.scope,
    summary: "Link a repository to a scope node",
    capability: "full",
    body: "createScopeRepoBody",
    responses: [created("The new `ScopeRepo`."), invalid],
  },
  {
    method: "PATCH",
    path: "/scope/repos/:id",
    tag: T.scope,
    summary: "Update a scope-repository link",
    capability: "full",
    body: "updateScopeRepoBody",
    responses: [ok("The updated `ScopeRepo`."), notFound, invalid],
  },
  {
    method: "DELETE",
    path: "/scope/repos/:id",
    tag: T.scope,
    summary: "Unlink a repository from a scope node",
    capability: "full",
    responses: [ok("`{ ok: true }`."), notFound],
  },

  // --- /plan-sessions ----------------------------------------------------------------------
  {
    method: "POST",
    path: "/plan-sessions",
    tag: T.plan,
    summary: "Start a plan session",
    description: "Archives the currently active session. No body.",
    capability: "full",
    responses: [created("The new `PlanSession`.")],
  },
  {
    method: "GET",
    path: "/plan-sessions",
    tag: T.plan,
    summary: "List plan sessions",
    capability: "read",
    query: "planSessionListQuery",
    responses: [ok("`PlanSession[]`."), invalid],
  },
  {
    method: "GET",
    path: "/plan-sessions/active",
    tag: T.plan,
    summary: "The active plan session",
    capability: "read",
    responses: [ok("`PlanSession | null`.")],
  },
  {
    method: "GET",
    path: "/plan-sessions/:id",
    tag: T.plan,
    summary: "Plan session detail",
    capability: "read",
    responses: [ok("`PlanSession`."), notFound],
  },
  {
    method: "POST",
    path: "/plan-sessions/:id/turns",
    tag: T.plan,
    summary: "Append a turn",
    description: "Optionally updates the brief and the plan.",
    capability: "full",
    body: "planSessionTurnBody",
    responses: [ok("The updated `PlanSession`."), notFound, invalid],
  },
  {
    method: "POST",
    path: "/plan-sessions/:id/archive",
    tag: T.plan,
    summary: "Archive a plan session",
    capability: "full",
    body: "planSessionArchiveBody",
    responses: [ok("The archived `PlanSession`."), notFound, invalid],
  },

  // --- /epics, /specs -----------------------------------------------------------------------------
  {
    method: "POST",
    path: "/epics",
    tag: T.epics,
    summary: "Create an epic",
    description: "Atomically creates the epic scope node and its dependency-ordered draft tickets.",
    capability: "full",
    body: "createEpicBody",
    responses: [created("`{ node, tickets }`; Location is the scope node."), invalid],
  },
  {
    method: "POST",
    path: "/specs",
    tag: T.epics,
    summary: "Create a draft spec",
    capability: "full",
    body: "createSpecBody",
    responses: [created("The new `Spec`."), invalid],
  },
  {
    method: "GET",
    path: "/specs",
    tag: T.epics,
    summary: "List specs",
    capability: "read",
    query: "specListQuery",
    responses: [ok("`Spec[]`, newest first."), invalid],
  },
  {
    method: "GET",
    path: "/specs/:id",
    tag: T.epics,
    summary: "Spec detail",
    capability: "read",
    responses: [ok("`Spec`."), notFound],
  },
  {
    method: "PATCH",
    path: "/specs/:id",
    tag: T.epics,
    summary: "Replace a draft spec's clauses",
    capability: "full",
    body: "updateSpecClausesBody",
    responses: [ok("The updated `Spec`."), notFound, conflict, invalid],
  },
  {
    method: "POST",
    path: "/specs/:id/freeze",
    tag: T.epics,
    summary: "Freeze a spec",
    description: "draft → frozen; frozen clauses seed the memory store.",
    capability: "full",
    responses: [ok("The frozen `Spec`."), notFound, conflict],
  },
  {
    method: "GET",
    path: "/specs/:id/coverage",
    tag: T.epics,
    summary: "Clause-to-AC traceability",
    capability: "read",
    responses: [ok("`SpecCoverage`."), notFound],
  },

  // --- agents / repositories / repos ----------------------------------------------------------------
  {
    method: "GET",
    path: "/agents",
    tag: T.repos,
    summary: "List agents",
    capability: "read",
    responses: [ok("`Agent[]`.")],
  },
  {
    method: "GET",
    path: "/repositories",
    tag: T.repos,
    summary: "List repositories",
    capability: "read",
    query: {
      hidden: {
        description: "`1`/`true` includes hidden repositories; `only` lists just them.",
        schema: { type: "string", enum: ["1", "true", "only"] },
      },
    },
    responses: [ok("`Repository[]` (hidden excluded by default).")],
  },
  {
    method: "POST",
    path: "/repos/onboard",
    tag: T.repos,
    summary: "Onboard a repository",
    description: "Spawns the configured onboarding command for the path.",
    capability: "full",
    body: "onboardRepoBody",
    responses: [
      accepted("`{ run }`: the tracked onboarding run."),
      invalid,
      {
        status: 503,
        description: "No onboarding command configured (`NOT_CONFIGURED`).",
        content: "json",
      },
    ],
  },
  {
    method: "GET",
    path: "/repos/:id/scopes",
    tag: T.repos,
    summary: "Scope nodes a repository belongs to",
    capability: "read",
    responses: [ok("`ScopeNode[]`."), notFound],
  },
  {
    method: "POST",
    path: "/repos/:id/hidden",
    tag: T.repos,
    summary: "Hide or unhide a repository",
    capability: "full",
    body: "setRepoHiddenBody",
    responses: [ok("The updated `Repository`."), notFound, invalid],
  },
  {
    method: "POST",
    path: "/repos/:id/default-branch",
    tag: T.repos,
    summary: "Set the default branch",
    capability: "full",
    body: "setRepoDefaultBranchBody",
    responses: [ok("The updated `Repository`."), notFound, invalid],
  },
  {
    method: "POST",
    path: "/repos/:id/commands",
    tag: T.repos,
    summary: "Set the Definition-of-Done gate commands",
    description: "Test, lint and coverage commands the runner executes in the delivery worktree.",
    capability: "full",
    body: "setRepoCommandsBody",
    responses: [ok("The updated `Repository`."), notFound, invalid],
  },

  // --- runner actions ------------------------------------------------------------------------------------
  {
    method: "POST",
    path: "/product-owner/runs",
    tag: T.work,
    summary: "Run the product owner",
    description:
      "Spawns a headless product-owner run for a repository or a scope node (fans out to at most 10 repositories).",
    capability: "full",
    body: "runProductOwnerBody",
    responses: [
      accepted("`{ runs }`."),
      invalid,
      {
        status: 503,
        description: "No product-owner command configured (`NOT_CONFIGURED`).",
        content: "json",
      },
    ],
  },
  {
    method: "POST",
    path: "/plan-build",
    tag: T.work,
    summary: "One decompose turn",
    description: "Returns `{ phase: clarify | plan | error }`. Proposes only; creates nothing.",
    capability: "full",
    body: "planBuildBody",
    responses: [ok("`PlanBuildResult`."), invalid],
  },
  {
    method: "POST",
    path: "/spec-build",
    tag: T.work,
    summary: "One spec-author turn",
    description: "Returns `{ phase: clarify | spec | error }`.",
    capability: "full",
    body: "specBuildBody",
    responses: [ok("`SpecBuildResult`."), invalid],
  },
  {
    method: "POST",
    path: "/poll-work",
    tag: T.work,
    summary: "Fire one factory tick",
    description: "Runs the configured tick command only when ready tickets exist.",
    capability: "full",
    responses: [
      accepted("`{ polled: true, run }`."),
      { status: 200, description: "`{ polled: false }` — nothing ready.", content: "json" },
      {
        status: 503,
        description: "No tick command configured (`NOT_CONFIGURED`).",
        content: "json",
      },
    ],
  },
];

const MEDIA: Record<NonNullable<ResponseSpec["content"]>, string> = {
  json: "application/json",
  text: "text/plain",
  markdown: "text/markdown",
  sse: "text/event-stream",
  html: "text/html",
};

const ERROR_SCHEMA_NAME = "ErrorBody";

function isZod(v: unknown): v is ZodTypeAny {
  return typeof v === "object" && v !== null && "_def" in (v as object);
}

/** `/tickets/:id/scopes/:nodeId` → `/tickets/{id}/scopes/{nodeId}` + the param names. */
export function toOpenApiPath(path: string): { path: string; params: string[] } {
  const params: string[] = [];
  const converted = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path: converted, params };
}

export function operationIdFor(e: EndpointSpec): string {
  if (e.operationId) return e.operationId;
  const words = e.path
    .replace(/^\//, "")
    .split("/")
    .map((seg) => (seg.startsWith(":") ? `by${seg.charAt(1).toUpperCase()}${seg.slice(2)}` : seg))
    .join("-")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return [e.method.toLowerCase(), ...words.map((w) => w.charAt(0).toUpperCase() + w.slice(1))].join(
    "",
  );
}

const PARAM_DESCRIPTIONS: Record<string, string> = {
  id: "Resource id. Ticket routes also accept the ticket number; principal routes also accept the name.",
  nodeId: "Scope node id.",
  dependsOn: "Id or number of the ticket depended on.",
  repo: "Repository name or id.",
};

/** Build the OpenAPI 3.1 document. Deterministic: same code → byte-identical JSON. */
export function buildOpenApiDocument(): Record<string, unknown> {
  const schemas: Record<string, JsonSchema> = {};
  const useSchema = (name: keyof typeof S): string => {
    const z = (S as Record<string, unknown>)[name as string];
    if (!isZod(z))
      throw new Error(`openapi: ${String(name)} is not a zod schema export of api/schemas.ts`);
    if (!schemas[name as string]) schemas[name as string] = zodToJsonSchema(z, String(name));
    return name as string;
  };
  schemas[ERROR_SCHEMA_NAME] = {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            description:
              "Stable machine code, e.g. `NOT_FOUND`, `VALIDATION_ERROR`, `ILLEGAL_TRANSITION`, `READ_ONLY_TOKEN`.",
          },
          message: { type: "string" },
          details: { type: "object", additionalProperties: true },
        },
      },
    },
  };

  const paths: Record<string, Record<string, unknown>> = {};
  const tagSet = new Set<string>();
  for (const e of ENDPOINTS) {
    const { path, params } = toOpenApiPath(e.path);
    tagSet.add(e.tag);
    const parameters: unknown[] = params.map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
      description: PARAM_DESCRIPTIONS[name] ?? `${name}.`,
    }));
    if (typeof e.query === "string") {
      const qs = zodToJsonSchema((S as Record<string, unknown>)[e.query] as ZodTypeAny, e.query);
      const props = (qs.properties ?? {}) as Record<string, JsonSchema>;
      const required = new Set((qs.required as string[] | undefined) ?? []);
      for (const [name, schema] of Object.entries(props)) {
        const { description, ...rest } = schema;
        parameters.push({
          name,
          in: "query",
          required: required.has(name),
          schema: rest,
          ...(description ? { description } : {}),
        });
      }
    } else if (e.query) {
      for (const [name, q] of Object.entries(e.query)) {
        parameters.push({
          name,
          in: "query",
          required: q.required ?? false,
          schema: q.schema ?? { type: "string" },
          description: q.description,
        });
      }
    }
    const responses: Record<string, unknown> = {};
    for (const r of e.responses) {
      const key = String(r.status);
      const entry: Record<string, unknown> = { description: r.description };
      if (r.content) {
        const media = MEDIA[r.content];
        const schema: JsonSchema =
          r.status >= 400
            ? { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` }
            : r.content === "json"
              ? { type: "object" }
              : { type: "string" };
        entry.content = { [media]: { schema } };
      }
      if (responses[key]) {
        // Two media types on one status (e.g. the dossier's JSON + markdown): merge content.
        const prev = responses[key] as { description: string; content?: Record<string, unknown> };
        prev.description = `${prev.description} ${r.description}`.trim();
        prev.content = {
          ...(prev.content ?? {}),
          ...((entry.content as Record<string, unknown>) ?? {}),
        };
        continue;
      }
      responses[key] = entry;
    }
    if (e.capability !== "public") {
      responses["401"] = {
        description: "Missing or unknown bearer token (`UNAUTHORIZED`).",
        content: {
          "application/json": { schema: { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` } },
        },
      };
      responses["403"] = {
        description:
          e.capability === "full"
            ? "The read-scoped token was used on a mutating route (`READ_ONLY_TOKEN`), or the Host/Origin is not permitted (`FORBIDDEN_HOST`)."
            : "The Host/Origin is not permitted for a token-less request (`FORBIDDEN_HOST`).",
        content: {
          "application/json": { schema: { $ref: `#/components/schemas/${ERROR_SCHEMA_NAME}` } },
        },
      };
    }
    const op: Record<string, unknown> = {
      operationId: operationIdFor(e),
      tags: [e.tag],
      summary: e.summary,
      ...(e.description ? { description: e.description } : {}),
      ...(parameters.length ? { parameters } : {}),
      ...(e.body
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${useSchema(e.body)}` },
                },
              },
            },
          }
        : {}),
      responses: Object.fromEntries(
        Object.entries(responses).sort(([a], [b]) => Number(a) - Number(b)),
      ),
      security: e.capability === "public" ? [] : [{ bearerAuth: [] }],
      "x-capability": e.capability,
    };
    paths[path] ??= {};
    paths[path][e.method.toLowerCase()] = op;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Gaffer dispatch API",
      version: VERSION,
      description:
        "The control plane's REST surface: tickets and their gates, the Factory Map scope graph, plan sessions, epics and specs, repositories, runner actions, configuration, read models and the live event stream.\n\n" +
        "**Authentication.** Every data route requires `Authorization: Bearer <token>`. Two credentials exist: the **full** token (`DISPATCH_API_TOKEN`, or `$GAFFER_DATA/dashboard-token`) and a **read-scoped** token derived from it one-way (`dispatch-api print-read-token`) that may call GET routes only; a mutating call with the read token is refused with 403 `READ_ONLY_TOKEN`. Each operation's `x-capability` says which it needs (`public`, `read`, `full`). Token-less requests are also subject to a Host/Origin check (403 `FORBIDDEN_HOST`).\n\n" +
        "**Errors** are `{ error: { code, message, details? } }` with a stable `code`; 422 is validation, 409 a state-machine or claim conflict, 404 an unknown resource.\n\n" +
        "**Actors.** The API acts as one operator identity; there is no per-user RBAC. Response bodies are described by the TypeScript view type they serialise (named in each description) rather than schema'd.",
    },
    servers: [{ url: "http://127.0.0.1:8787", description: "Default local dashboard bind." }],
    tags: [...tagSet].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "The full token, or the derived read-scoped token for GET routes.",
        },
      },
      schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}
