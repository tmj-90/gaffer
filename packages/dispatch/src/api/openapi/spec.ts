import type { ZodType } from "zod";

import { VERSION } from "../../version.js";
import * as S from "../schemas.js";
import * as R from "./responses.js";
import { type JsonSchema, zodToJsonSchema, zodToJsonSchemaWithRefs } from "./zodJsonSchema.js";

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
 * Response bodies: the main ticket, gate, decision and principal operations name a
 * response schema from `./responses.ts` (`schema`), pinned to the row types at compile
 * time and to the live routes by `test/api-openapi-responses.test.ts`. The read models
 * are composed views whose shapes live in TypeScript types; those operations name the
 * type they return in their description.
 */

/** Who may call an operation (see api/auth.ts). */
export type Capability = "public" | "read" | "full";

export interface ResponseSpec {
  status: number;
  description: string;
  /** Media type of the body; omitted = no body. */
  content?: "json" | "text" | "markdown" | "sse" | "html";
  /** A JSON body's schema: an export of `./responses.ts` (else a bare object). */
  schema?: keyof typeof R;
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

const ok = (description: string, schema?: keyof typeof R): ResponseSpec => ({
  status: 200,
  description,
  content: "json",
  ...(schema ? { schema } : {}),
});
const created = (description: string, schema?: keyof typeof R): ResponseSpec => ({
  status: 201,
  description: `${description} The Location header names the created resource.`,
  content: "json",
  ...(schema ? { schema } : {}),
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
const principalAdminRequired: ResponseSpec = {
  status: 403,
  description:
    "The caller authenticated with a principal token; only the shared operator token may manage principals (`PRINCIPAL_ADMIN_REQUIRED`).",
  content: "json",
};
const forbidden: ResponseSpec = {
  status: 403,
  description: "The calling principal may not do this (`ACTOR_NOT_PERMITTED`).",
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
    responses: [
      ok("`{ capability, actor: { type, id }, principal: { id, name } | null }`.", "Whoami"),
    ],
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
      "Creates a principal bound to an actor identity (`actor_type`, `actor_id`) and a capability (`full` or `read`). The response carries the bearer token **once**; only its SHA-256 is stored. Shared operator token only: a principal token is refused.",
    capability: "full",
    body: "createPrincipalBody",
    responses: [
      created("`{ principal, token }` — the only time the token is shown.", "PrincipalCreated"),
      invalid,
      principalAdminRequired,
      {
        status: 409,
        description:
          "A principal with that name exists, or its `actor_id` is a registered agent's id (`DUPLICATE`, `details.reason: actor_id_is_agent`).",
        content: "json",
      },
    ],
  },
  {
    method: "GET",
    path: "/api/principals/:id",
    tag: T.config,
    summary: "Get an API principal",
    description:
      "One principal by id or name, revoked ones included — the `Location` that POST /api/principals returns. Never carries token material.",
    capability: "read",
    responses: [ok("`{ principal }`.", "PrincipalEnvelope"), notFound],
  },
  {
    method: "DELETE",
    path: "/api/principals/:id",
    tag: T.config,
    summary: "Revoke an API credential",
    description:
      "Stamps `revoked_at`; the row stays for the audit trail. `:id` accepts the id or the name. Shared operator token only: a principal token is refused.",
    capability: "full",
    responses: [
      ok("`{ principal }`.", "PrincipalEnvelope"),
      notFound,
      principalAdminRequired,
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
      "Every known setting with its file value, whether the environment locks it, and its group (`SettingView[]`). A secret-bearing key (`secret: true`, e.g. a webhook URL) never carries its value to any principal: `value` and `effective` are empty, `configured` says whether one is set and `host` names the URL's host.",
    capability: "read",
    responses: [ok("`{ settings: SettingView[] }`.")],
  },
  {
    method: "GET",
    path: "/api/settings/secret/:key",
    tag: T.config,
    summary: "Read a secret setting back (admin)",
    description:
      "The in-force value of one secret-bearing setting, for an ADMIN principal only (the operator token, or an admin principal with full capability); 403 for a read token or a human principal.",
    capability: "full",
    responses: [ok("`{ key, value, source }`."), notFound],
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
    path: "/api/club",
    tag: T.config,
    summary: "Read the club identity",
    description:
      'The operator\'s team for the Match Day dashboard (`ClubView`): `name`, `short_name`, `kit_primary`, `kit_secondary` (null when unset) plus `name_effective` ("Gaffer" when unset) and `short_name_effective`.',
    capability: "read",
    responses: [ok("`{ club: ClubView }`.")],
  },
  {
    method: "PATCH",
    path: "/api/club",
    tag: T.config,
    summary: "Update the club identity",
    description:
      'Partial: an omitted field is unchanged, `null` or "" clears it. Name ≤ 60 chars; short name 1–4 letters/digits; kit colours `#rgb`/`#rrggbb` (stored lowercase `#rrggbb`). A change is recorded as a `club.updated` event.',
    capability: "full",
    body: "updateClubBody",
    responses: [ok("`{ club: ClubView, changed: string[] }`."), invalid],
  },
  {
    method: "GET",
    path: "/api/squad",
    tag: T.config,
    summary: "The squad: club + agents with display names",
    description:
      'The club plus every registered agent in registration order (`SquadAgentView`): `agent_id`, `display_name` (operator-set or null), `display_name_effective`, `default_display_name` (derived from role + index, e.g. "Delivery 1", "Reviewer"), `shirt_number`, `role`, `registered_name` and registration facts. Presentation only.',
    capability: "read",
    responses: [ok("`{ club: ClubView, agents: SquadAgentView[] }`.")],
  },
  {
    method: "PATCH",
    path: "/api/squad/agents/:id",
    tag: T.config,
    summary: "Set an agent's display name / shirt number",
    description:
      'Partial: omitted ⇒ unchanged, `null` (or "" for the name) clears. Display name ≤ 40 chars (trimmed); shirt number 1–99, unique among agents. `:id` is the agent id (or its unique registered name). The agent id itself never changes. Recorded as an `agent.display_updated` event.',
    capability: "full",
    body: "updateSquadAgentBody",
    responses: [
      ok("`{ agent: SquadAgentView, changed: string[] }`."),
      notFound,
      {
        status: 409,
        description: "The shirt number is worn by another agent (`DUPLICATE`).",
        content: "json",
      },
      invalid,
    ],
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
      "Tails the append-only `work_events` log as `event: work_event` messages (metadata only, the same safe shape as `/api/activity`), `id` = event seq, a `ping` every 15 s. Resume with `?since=<seq>`. At most 16 concurrent clients; a 17th gets 503 `STREAM_BUSY`. The credential is re-checked before every write: once it is revoked the stream sends `event: auth_revoked` and closes. A stream lives at most one hour; reconnect with `?since=<last id>`.",
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
    summary: "Lore list from the memory store (filter by repo / status / kind, paged)",
    description:
      "Read server-side through `memory list --json`. With no query the 50 freshest records across every lifecycle state; `status=draft` is the ratification queue. `status` and `kind` take comma-separated lists. Answers `{ available, lore, total, limit, offset }`, or `{ available: false, reason }` with 200 when the memory product is unavailable.",
    capability: "read",
    query: "memoryLoreQuery",
    responses: [ok("One page of lore records, or `{ available: false }`."), invalid],
  },
  {
    method: "GET",
    path: "/api/memory/lore/:id/history",
    tag: T.memory,
    summary: "A lore record's version history",
    description:
      "Read server-side through `memory history <id> --json`: the current head and every earlier version (each update snapshots the previous row), newest first. Answers `{ available, id, current, versions }`, or `{ available: false, reason }` with 200 when the record is unknown or the memory product is unavailable.",
    capability: "read",
    responses: [ok("The history, or `{ available: false }`."), invalid],
  },
  {
    method: "POST",
    path: "/api/memory/lore/:id/approve",
    tag: T.memory,
    summary: "Approve a draft lore record",
    description:
      "Ratifies a draft through `memory approve <id>` (the memory CLI is the write boundary; dispatch never opens the memory DB). The record becomes `active` and is served to delivery agents from the next tick.",
    capability: "full",
    responses: [
      ok('`{ id, status: "active" }`.'),
      invalid,
      { status: 409, description: "Unknown id or not a draft (`CONFLICT`).", content: "json" },
      { status: 503, description: "Memory unreachable (`MEMORY_UNAVAILABLE`).", content: "json" },
    ],
  },
  {
    method: "POST",
    path: "/api/memory/lore/:id/reject",
    tag: T.memory,
    summary: "Reject a draft lore record",
    description:
      "Drops a draft through `memory reject <id> [--reason]`; the optional reason is kept so the suggesting agent can see why.",
    capability: "full",
    body: "rejectLoreBody",
    responses: [
      ok('`{ id, status: "rejected" }`.'),
      invalid,
      { status: 409, description: "Unknown id or not a draft (`CONFLICT`).", content: "json" },
      { status: 503, description: "Memory unreachable (`MEMORY_UNAVAILABLE`).", content: "json" },
    ],
  },

  // --- /api read models ---------------------------------------------------------
  {
    method: "GET",
    path: "/api/board",
    tag: T.read,
    summary: "Kanban board",
    capability: "read",
    query: {
      repo: { description: "Limit to one repository (name or id)." },
      limit: {
        description:
          "A visible window: at most this many cards per area (1..1000). Without it every card is returned.",
      },
      offset: { description: "With `limit`: skip this many cards in each area (default 0)." },
      area: {
        description:
          "With `limit`: return only this area's window (a column, `closed` or `wontDo`); the other areas come back empty.",
      },
    },
    responses: [
      ok(
        "`BoardView`: the columns plus the closed area, `counts` (every area's total, whatever the window) and `window` (the window applied, or null). With a window, Done, closed and won't-do are newest first. A card's `claim` carries `agent_display`.",
      ),
      invalid,
    ],
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
    responses: [
      ok(
        "Newest-first `ActivityItem[]` (metadata only); an event whose actor is a registered agent carries `agent_display`, else `null`.",
      ),
    ],
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
      "Event-log hash-chain integrity, spend, event-derived cycle time and throughput, flow efficiency, governance, skills and recall. `usage_pause` reports the runner's pause after a usage-limit or rate-limit refusal (`{ active, paused_until, kind, basis, message, ticket, lane? }`; `{ active: false }` when not paused).",
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
    description:
      "Paging is opt-in: with no `limit` every matching ticket is returned. `limit` (clamped to 1–1000) and `offset` page the list; `total` always counts the whole filtered set. `fields=summary` leaves out `description`, `test_contract` and `last_review_feedback`. Unknown query parameters are ignored.",
    capability: "read",
    query: "ticketListQuery",
    responses: [
      ok(
        "`{ tickets, total, limit?, offset? }` (`limit`/`offset` echoed when paging).",
        "TicketList",
      ),
      invalid,
    ],
  },
  {
    method: "POST",
    path: "/tickets",
    tag: T.tickets,
    summary: "Create a ticket",
    description:
      "Optionally links a repository, scope nodes and per-repo access. When `repoIds` is given at least one must be a write repo. The create and its links are one transaction: an unknown repo or scope node is a 404 and leaves no ticket behind.",
    capability: "full",
    body: "createTicketBody",
    responses: [created("`{ ticket }` — the new ticket.", "TicketEnvelope"), notFound, invalid],
  },
  {
    method: "GET",
    path: "/tickets/:id",
    tag: T.tickets,
    summary: "Ticket detail",
    description:
      "The full `TicketView`: acceptance criteria, repos, scopes, decisions, dependencies, evidence, events and the rework trail, plus `agent_display` — the presentation of every registered agent the ticket names, keyed by agent id. An approved (`ready_for_merge`) or held ticket carries `ticket.landing_state` (`{ kind, label, detail, hold, paused_until? }` — `paused_until` while the runner's usage-window pause delays lands_next_tick: waiting_for_merge, lands_next_tick, landing, partly_landed — some approved revisions have a landing record, not all — or held), the same field the board cards, GET /tickets and the human queue carry. `:id` accepts the ticket id or number.",
    capability: "read",
    responses: [
      ok(
        "`TicketView` as `{ ticket, acceptance_criteria, repositories, scopes, blocking_decisions, dependencies, evidence, events, rework_trail }`.",
        "TicketDetail",
      ),
      notFound,
    ],
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
    responses: [created("`{ acceptance_criterion, event_id }`.", "AcCreated"), notFound, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/ready",
    tag: T.tickets,
    summary: "Mark ready for delivery",
    capability: "full",
    responses: [ok("`{ ticket, event_id }`.", "TicketTransition"), notFound, conflict],
  },
  {
    method: "POST",
    path: "/tickets/:id/move",
    tag: T.tickets,
    summary: "Move on the board",
    description:
      "A human board move through the state machine; illegal edges are refused. Moving a reviewed ticket back to `ready`/`refining` is a rejection (ACs reset, attempt counted, feedback recorded, parked at the retry cap); agent-leased in-flight work cannot be moved into review.",
    capability: "full",
    body: "moveTicketBody",
    responses: [ok("`{ ticket, event_id }`.", "TicketTransition"), notFound, conflict, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/human-claim",
    tag: T.tickets,
    summary: "Claim a ready ticket by hand",
    capability: "full",
    body: "humanClaimBody",
    responses: [ok("`{ ticket_id, number, human_owned: true }`."), notFound, conflict],
  },
  {
    method: "POST",
    path: "/tickets/:id/human-release",
    tag: T.tickets,
    summary: "Hand a by-hand ticket back to the queue",
    description:
      "A named principal hands back only a ticket it took by hand itself (403 `ACTOR_NOT_PERMITTED` for anyone else's); the shared operator token acts as admin and may hand back any.",
    capability: "full",
    body: "humanClaimBody",
    responses: [ok("`{ ticket_id, status, event_id }`."), notFound, conflict],
  },
  {
    method: "POST",
    path: "/tickets/:id/ready-approval",
    tag: T.tickets,
    summary: "Grant the regulated-pack ready approval",
    capability: "full",
    responses: [ok("`{ ticket_id, event_id }`."), notFound, conflict],
  },
  {
    method: "GET",
    path: "/tickets/:id/events",
    tag: T.events,
    summary: "Ticket event timeline",
    capability: "read",
    responses: [
      ok("`{ events: WorkEvent[] }` (with `correlation_id` per tick and the hash chain)."),
      notFound,
    ],
  },
  {
    method: "GET",
    path: "/tickets/:id/rework-trail",
    tag: T.review,
    summary: "Ordered rework history",
    description: "Why the ticket bounced, oldest first.",
    capability: "read",
    responses: [ok("`{ rework_trail: ReworkTrailEntry[] }`."), notFound],
  },
  {
    method: "POST",
    path: "/tickets/:id/review/approve",
    tag: T.review,
    summary: "Approve the review",
    description:
      "Moves the ticket to ready_for_merge (or in_testing on the tester lane) and pins, per write repository, the commit the reviewer saw. `commits` names them (the diff endpoint's `repoId` + `headSha`); 409 with `details.reason` `stale_revision` when any branch head moved since it was shown (nothing is approved), `revision_required` when no commit is named, `repo_unavailable` (naming each repo) when any write repository's delivery head cannot be read — an approval covers every write repository, so nothing is approved until each one resolves. Triggers the merge runner only when AUTO_MERGE is on and the approval reached ready_for_merge (an approval routed to in_testing starts no merge and carries no `merge`; one that reached ready_for_merge carries `ticket.landing_state`, as GET /tickets/:id does); otherwise `merge.skipped` is `auto_merge_off` and the ticket waits for POST /tickets/:id/merge. The reviewer may not be the delivering agent.",
    capability: "full",
    body: "approveReviewBody",
    responses: [
      ok("`{ ticket, event_id, merge?, approve_outcome? }`.", "ReviewApproved"),
      notFound,
      conflict,
      invalid,
    ],
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
    responses: [
      ok("`{ ticket, event_id, lore_capture? }`.", "TicketTransition"),
      notFound,
      conflict,
      invalid,
    ],
  },
  {
    method: "POST",
    path: "/tickets/:id/merge",
    tag: T.review,
    summary: "Merge an approved ticket that has not landed",
    description:
      "Fires the merge runner for a ticket in `ready_for_merge` (the runner's approve-only path, lite mode, or a merge that hit a conflict left it there). 409 unless the ticket is in ready_for_merge, and 409 `MERGE_IN_FLIGHT` while a merge this server started for the ticket is still running (nothing new is started).",
    capability: "full",
    responses: [
      ok("`{ ticket, merge }` — the merge run was started (202)."),
      notFound,
      {
        status: 409,
        description:
          "Not in ready_for_merge (`ILLEGAL_TRANSITION`), or a merge of this ticket is already running (`MERGE_IN_FLIGHT`).",
        content: "json",
      },
    ],
  },
  {
    method: "POST",
    path: "/tickets/:id/mark-merged",
    tag: T.review,
    summary: "Merge-complete callback",
    description:
      "ready_for_merge → done. A human principal acts as admin under its own id (the event " +
      "names who marked it merged); a system or admin principal keeps its type.",
    capability: "full",
    responses: [ok("`{ ticket, event_id }`.", "TicketTransition"), notFound, conflict],
  },
  {
    method: "POST",
    path: "/tickets/:id/reopen-for-review",
    tag: T.review,
    summary: "Reopen a done ticket for re-review",
    description:
      "The auto-merge re-approval callback (done → in_review). Attributed like " +
      "mark-merged: a human principal acts as admin under its own id.",
    capability: "full",
    body: "reopenForReviewBody",
    responses: [
      ok("`{ ticket_id, status, event_id }`.", "ReopenedForReview"),
      notFound,
      conflict,
      invalid,
    ],
  },
  {
    method: "GET",
    path: "/tickets/:id/diff",
    tag: T.review,
    summary: "Delivery diff",
    description:
      "`git diff <default branch>...<head>` per write repository, where `headSha` is the delivery branch's commit at read time (`repoId` names the repo). Send them back on approve. An in_review ticket also carries `approve_outcome` (the ApproveOutcome schema): the first step a human Approve would certainly take now — `to_tester`, `land_now`, `land_next_tick`, `waits_for_merge`, `held_ci` or `held_repo_unavailable` (a write repository's delivery head cannot be read, so the server refuses the approval) — computed from the settings and ticket state the approve path acts on; when the tests that gate it changed, `agent_hold` names the `held_test_modified` hold an agent or auto approval would hit (a human approval is not held by it).",
    capability: "read",
    responses: [ok("`{ ticketId, repos: RepoDiff[], approve_outcome? }`.", "TicketDiff"), notFound],
  },
  {
    method: "GET",
    path: "/tickets/:id/dossier",
    tag: T.review,
    summary: "Delivery dossier",
    description:
      "The tamper-evident evidence artifact. JSON by default; markdown with `?format=markdown` or `Accept: text/markdown`. `?include=packet` adds `review_packet` (outside the hashed subject): the runner-verified gates, tester verdict, cost and turns, attempts and rework, risk reasons, the reviewed-commit pin, each criterion's check result or `no machine evidence`, and any test count the agent claimed that disagrees with the runner's.",
    capability: "read",
    query: {
      format: {
        description: "`markdown` for the rendered document.",
        schema: { type: "string", enum: ["json", "markdown"] },
      },
      include: {
        description: "`packet` adds the Review view's `review_packet` to the JSON.",
        schema: { type: "string", enum: ["packet"] },
      },
    },
    responses: [
      ok("`Dossier` (plus `review_packet` with `?include=packet`)."),
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
    responses: [
      ok(
        "`{ ticket_id, can_be_tested, event_id }` (plus deprecated camelCase twins).",
        "TestableSet",
      ),
      notFound,
      invalid,
    ],
  },
  {
    method: "POST",
    path: "/tickets/:id/allow-test-changes",
    tag: T.review,
    summary: "Allow test changes (gate integrity)",
    description:
      "A human allows (or withdraws) this ticket's allowance to change its tests: delete " +
      "or rename a test file, add a skip marker, rewrite a gate script. The runner's " +
      "integrity gate row then reads PASS with a note instead of FLAG, and the " +
      "`test-modified` risk annotation drops to medium so it no longer holds an " +
      "auto-approve. Human or admin principals only (agent and system are refused); " +
      "recorded as a `ticket.test_changes_allowed` event.",
    capability: "full",
    body: "allowTestChangesBody",
    responses: [
      ok("`{ ticket_id, allow_test_changes, event_id }`.", "TestChangesAllowed"),
      notFound,
      invalid,
      forbidden,
    ],
  },
  {
    method: "POST",
    path: "/tickets/:id/test-contract",
    tag: T.review,
    summary: "Record the testing handover contract",
    capability: "full",
    body: "setTestContractBody",
    responses: [ok("`{ test_contract }`.", "TestContractSet"), notFound, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/tester",
    tag: T.review,
    summary: "Record the independent tester's verdict",
    description:
      "pass → ready_for_merge, fail → refining, recorded as the calling principal. On an " +
      "acceptance ticket a human PASS is a waiver; an automated PASS must carry " +
      "`tested_commit`, `contract_hash` and `replay: passed` (422 `BINDING_REQUIRED`), and a " +
      "`contract_hash` that no longer matches the contract on record is a 409 " +
      "`CONTRACT_MISMATCH`.",
    capability: "full",
    body: "testerVerdictBody",
    responses: [ok("`{ ticket, event_id }`.", "TicketTransition"), notFound, conflict, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/wont-do",
    tag: T.tickets,
    summary: "Mark won't-do",
    description:
      "Cancels the ticket. Refused (409 `PARTLY_LANDED`) while any of its repositories has a recorded landing of its approved commit: land the rest, or revert the landed merge first.",
    capability: "full",
    body: "wontDoBody",
    responses: [
      ok("`{ ticket, event_id }` (cancelled).", "TicketTransition"),
      notFound,
      {
        status: 409,
        description:
          "The state machine refused it (`ILLEGAL_TRANSITION`), or the change already landed in a repository (`PARTLY_LANDED`).",
        content: "json",
      },
      invalid,
    ],
  },
  {
    method: "POST",
    path: "/tickets/:id/reopen",
    tag: T.tickets,
    summary: "Reopen a won't-do ticket",
    capability: "full",
    body: "reopenWontDoBody",
    responses: [ok("`{ ticket, event_id }`.", "TicketTransition"), notFound, conflict, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/continue",
    tag: T.review,
    summary: "Continue a paused delivery",
    description: "For a delivery paused on a spend cap.",
    capability: "full",
    body: "continuePausedBody",
    responses: [ok("`{ ticket_id, event_id, resume_requested: true }`."), notFound, conflict],
  },
  {
    method: "POST",
    path: "/tickets/:id/stop",
    tag: T.review,
    summary: "Stop a paused delivery",
    capability: "full",
    body: "stopPausedBody",
    responses: [ok("`{ ticket, event_id }` (cancelled)."), notFound, conflict, invalid],
  },
  {
    method: "POST",
    path: "/tickets/:id/delivery-artifact",
    tag: T.review,
    summary: "Record the delivery artifact",
    description: "Branch, PR URL, commit and diff summary.",
    capability: "full",
    body: "recordDeliveryArtifactBody",
    responses: [ok("`{ ticket_id, branch_name, pr_url, event_id }`."), notFound, invalid],
  },
  {
    method: "PUT",
    path: "/tickets/:id/reviewer",
    tag: T.review,
    summary: "Assign the reviewer",
    capability: "full",
    body: "assignReviewerBody",
    responses: [ok("`{ ticket_id, reviewer, event_id }`."), notFound, invalid],
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
    responses: [
      ok(
        "`{ applied, ticket_id, repo_id?, reason?, event_id? }` (plus deprecated camelCase twins).",
        "MonoFallback",
      ),
      notFound,
      conflict,
    ],
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
    responses: [ok("`{ decisions: Decision[] }`.")],
  },
  {
    method: "POST",
    path: "/decisions",
    tag: T.decisions,
    summary: "Create a decision",
    capability: "full",
    body: "createDecisionBody",
    responses: [created("`{ decision }`.", "DecisionEnvelope"), invalid],
  },
  {
    method: "GET",
    path: "/decisions/:id",
    tag: T.decisions,
    summary: "Get a decision",
    description: "One decision in any status — the `Location` that POST /decisions returns.",
    capability: "read",
    responses: [ok("`{ decision }`.", "DecisionEnvelope"), notFound],
  },
  {
    method: "POST",
    path: "/decisions/:id/resolve",
    tag: T.decisions,
    summary: "Resolve a decision",
    capability: "full",
    body: "resolveDecisionBody",
    responses: [ok("`{ decision }` — resolved.", "DecisionEnvelope"), notFound, conflict, invalid],
  },

  // --- /claims ------------------------------------------------------------------------
  {
    method: "GET",
    path: "/claims",
    tag: T.claims,
    summary: "List active claims",
    capability: "read",
    responses: [
      ok(
        "`{ claims: ActiveClaimView[] }` — each row carries `agent_display` (the claiming agent's display name, shirt number and role).",
      ),
    ],
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
    responses: [ok("`{ edges: ScopeEdge[] }`.")],
  },
  {
    method: "POST",
    path: "/scope/edges",
    tag: T.scope,
    summary: "Create a scope edge",
    capability: "full",
    body: "createScopeEdgeBody",
    responses: [created("`{ edge }`."), invalid],
  },
  {
    method: "GET",
    path: "/scope/edges/:id",
    tag: T.scope,
    summary: "Get a scope edge",
    description: "The `Location` that POST /scope/edges returns.",
    capability: "read",
    responses: [ok("`{ edge }`."), notFound],
  },
  {
    method: "DELETE",
    path: "/scope/edges/:id",
    tag: T.scope,
    summary: "Delete a scope edge",
    capability: "full",
    responses: [ok("`{ edge_id, event_id }`."), notFound],
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
    responses: [created("`{ association }`."), invalid],
  },
  {
    method: "GET",
    path: "/scope/repos/:id",
    tag: T.scope,
    summary: "Get a scope↔repo association",
    description: "The `Location` that POST /scope/repos returns.",
    capability: "read",
    responses: [ok("`{ association }`."), notFound],
  },
  {
    method: "PATCH",
    path: "/scope/repos/:id",
    tag: T.scope,
    summary: "Update a scope-repository link",
    capability: "full",
    body: "updateScopeRepoBody",
    responses: [ok("`{ association }`."), notFound, invalid],
  },
  {
    method: "DELETE",
    path: "/scope/repos/:id",
    tag: T.scope,
    summary: "Unlink a repository from a scope node",
    capability: "full",
    responses: [ok("`{ association_id, event_id }`."), notFound],
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
    responses: [
      ok(
        "`{ agents: Agent[] }`, each with `agent_display`. `display_name` here is the label the agent registered with; the operator-chosen name is `agent_display.display_name`.",
      ),
    ],
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
    description:
      "The test and lint commands the runner executes as Definition-of-Done gates in the delivery worktree, and the coverage command the idle coverage scan runs (coverage is not a Definition-of-Done gate).",
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

function isZod(v: unknown): v is ZodType {
  return typeof v === "object" && v !== null && "_zod" in (v as object);
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
  // Response schemas nested inside others that are components in their own right
  // (rendered as `$ref`s wherever they appear).
  const sharedRefs = new Map<ZodType, string>(
    R.SHARED_RESPONSE_COMPONENTS.map((n) => [R[n] as ZodType, n]),
  );
  const useResponseSchema = (name: keyof typeof R): string => {
    const z = R[name];
    if (!isZod(z))
      throw new Error(`openapi: ${String(name)} is not a zod schema export of responses.ts`);
    if (!schemas[name]) {
      const { schema, used } = zodToJsonSchemaWithRefs(z, String(name), sharedRefs);
      schemas[name] = schema;
      for (const u of used) useResponseSchema(u as keyof typeof R);
    }
    return name;
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
      const qs = zodToJsonSchema((S as Record<string, unknown>)[e.query] as ZodType, e.query);
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
            : r.schema
              ? { $ref: `#/components/schemas/${useResponseSchema(r.schema)}` }
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
      // An operation's own 403 (e.g. PRINCIPAL_ADMIN_REQUIRED) is kept and the
      // auth-gate reasons appended, never overwritten.
      const own403 = (responses["403"] as { description?: string } | undefined)?.description;
      const gate403 =
        e.capability === "full"
          ? "The read-scoped token was used on a mutating route (`READ_ONLY_TOKEN`), or the Host/Origin is not permitted (`FORBIDDEN_HOST`)."
          : "The Host/Origin is not permitted for a token-less request (`FORBIDDEN_HOST`).";
      responses["403"] = {
        description: own403 ? `${own403} ${gate403}` : gate403,
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
        "**Actors.** A request acts as the principal its token names (`GET /api/whoami`), or as the single `dispatch-api` operator for the shared token; there is no per-repository RBAC. The main ticket, gate, decision and principal operations carry response schemas; the read models are described by the TypeScript view type they serialise (named in each description).",
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
