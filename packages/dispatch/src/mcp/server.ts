import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { Dispatch } from "../core.js";
import { DatabaseOpenError, DatabaseTooNewError } from "../db/connection.js";
import type { Actor } from "../domain/types.js";
import { systemClock } from "../util/clock.js";
import { resolveDbPath } from "../util/paths.js";
import { VERSION } from "../version.js";
import { makeHandlers, toolSchemas, type ToolResult } from "./tools.js";

/**
 * Agent-coaching tool descriptions. Each one tells a coding agent operating
 * the backlog WHEN to call, what to provide, the cost asymmetry, and the
 * failure modes to avoid — not just what the tool mechanically does. The
 * backlog's integrity depends on agents following these, so the prose is
 * deliberately imperative and concrete.
 */
const TOOL_DESCRIPTIONS: Record<keyof typeof toolSchemas, string> = {
  create_ticket:
    "**Create a unit of work as a DRAFT.** Use this to capture a discrete, " +
    "independently-shippable task — not a vague epic and not a sub-step of a " +
    "ticket you're already working. A good ticket has a verifiable outcome; " +
    "if you can't write at least one acceptance criterion for it, it's too " +
    "vague — sharpen the title or split it first.\n\n" +
    "Lands in 'draft'. It is NOT claimable yet: add acceptance criteria with " +
    "`add_acceptance_criterion`, then `mark_ticket_ready` to evaluate it " +
    "against its policy pack. Pick `policy_pack` honestly — stricter packs " +
    "(`factory_strict`, `regulated`) require evidence-backed ACs before a " +
    "ticket can pass review; choosing `solo_loose` to dodge that gate defeats " +
    "the point. Set `risk_level` to the real blast radius, not the convenient " +
    "one — it gates which agents may claim the work.",
  add_acceptance_criterion:
    "**Add ONE concrete, checkable acceptance criterion to a draft ticket.** " +
    "An AC is the contract the work is judged against, so make it falsifiable: " +
    "'GET /health returns 200 with {status:\"ok\"}', not 'health endpoint " +
    "works'. Add `verification_method` (how it's checked: test, manual, CI) " +
    "and set `evidence_required: true` when a reviewer should see proof — " +
    "doing so means `record_ac_evidence` MUST be called before the AC counts " +
    "as satisfied. Add ACs while the ticket is still draft/refining; padding " +
    "a ticket with ACs after claiming it to look productive is an anti-pattern.",
  mark_ticket_ready:
    "**Promote a fully-specified ticket from draft to 'ready' (claimable).** " +
    "Call this only once the title, ACs and repo links actually describe the " +
    "work — readiness is evaluated against the ticket's policy pack and will " +
    "be REFUSED if the pack's preconditions aren't met (e.g. a stricter pack " +
    "requiring at least one AC). Don't mark ready to 'unblock the queue' if " +
    "the spec is thin: a half-specified ready ticket wastes the claiming " +
    "agent's whole session. If it bounces, read the error — it names the " +
    "missing precondition — fix that, then retry.",
  claim_next_ticket:
    "**Claim exactly ONE ticket, then work it to completion before claiming " +
    "again. Do NOT hoard.** This atomically leases the highest-priority " +
    "ready, unblocked ticket your agent is eligible for and returns a " +
    "`claim_token` — your bearer credential for every subsequent write " +
    "(evidence, submit, block, heartbeat). Guard it; treat it like a " +
    "password.\n\n" +
    "`claimed: false` means nothing matched (queue empty, everything blocked, " +
    "or none within your risk/capability ceiling) — back off and retry later, " +
    "don't loosen your own constraints to force a claim. The lease expires at " +
    "`ttl_seconds`; for long work, call `heartbeat_claim` BEFORE expiry rather " +
    "than picking a huge TTL. If you let it lapse, the ticket returns to the " +
    "pool and another agent may take it — you'll lose the work.",
  claim_ticket:
    "**Claim a SPECIFIC, chosen ticket — use this when you've already selected " +
    "the ticket you intend to work, not just 'whatever's next'.** Pass the " +
    "`ticket_id` (id or #number), your `agent_id` and a `ttl_seconds` lease. " +
    "This applies the SAME eligibility rules as `claim_next_ticket` (active " +
    "agent, risk ceiling, required capabilities, no blocking decision, ready or " +
    "reclaimable-expired) and the atomic claim, then returns a `claim_token`. " +
    "Unlike `claim_next_ticket` it NEVER falls back to a different ticket: if " +
    "the chosen one isn't claimable you get a structured `TICKET_NOT_CLAIMABLE` " +
    "(or `NOT_FOUND`) error, so a runner that preselected a ticket never " +
    "silently ends up holding another. Prefer `claim_next_ticket` when you just " +
    "want the highest-priority eligible work.",
  record_delivery_artifact:
    "**Record WHERE you delivered the work — the branch and/or PR — so reviewers " +
    "read it from Dispatch instead of grepping.** Pass your `claim_token`, the " +
    "`ticket_id`, and at least one of `branch_name`/`pr_url`; optionally a " +
    "`commit` and a `diff_summary`. The branch/PR persist onto the ticket (and " +
    "the PR satisfies the done-gate's PR/diff requirement); commit and " +
    "diff_summary ride on the event trail. Call this once your branch exists / " +
    "PR is open, before submitting for review — it's the pointer a human needs " +
    "to verify your evidence quickly. This is claim-scoped: the token must match " +
    "your active claim on the ticket.",
  get_ticket:
    "**Read the full picture of one ticket before acting on it** — its status, " +
    "acceptance criteria (and which are satisfied), linked repositories, any " +
    "blocking decisions, and the recent event log. Call this right after a " +
    "claim to load the ACs you must satisfy, and again before submitting to " +
    "confirm every required AC has evidence. A non-empty `blocking_decisions` " +
    "list means the ticket is gated on a human/product call — do not try to " +
    "work around it; resolve or wait on the decision. Read-only and cheap; " +
    "prefer it over guessing the ticket's current state.",
  heartbeat_claim:
    "**Extend your claim's lease during long work — call it BEFORE the lease " +
    "expires, not after.** Pass your `claim_token`. A claim that lapses is " +
    "reclaimable by another agent and any later write with the stale token is " +
    "refused, so on multi-step tasks heartbeat at a comfortable margin (well " +
    "inside the TTL) rather than gambling on finishing first. This does not " +
    "advance the ticket; it only keeps your lease alive. If a heartbeat is " +
    "refused, your lease is already gone — stop, re-`claim_next_ticket`, and " +
    "expect the work may have moved on.",
  record_ac_evidence:
    "**Record REAL, verifiable evidence for the work you actually did — one " +
    "call per acceptance criterion you're satisfying.** Pass your " +
    "`claim_token`, the `ticket_id`, the `ac_id` it proves, an " +
    "`evidence_type` (test_output, coverage_report, commit, pull_request, " +
    "ci_run, …) and a truthful `summary`; attach a `uri` or `payload` " +
    "pointing at the proof whenever one exists. When `ac_id` is given and the " +
    "evidence is accepted, the AC flips to satisfied — so this is the gate " +
    "between 'I claim it works' and 'it's demonstrably done'.\n\n" +
    "NEVER fabricate evidence. Do not summarise a test run you didn't run, " +
    "cite a commit that doesn't exist, or mark an AC satisfied by recording a " +
    "vague note. If an AC genuinely can't be met, use `mark_ticket_blocked` " +
    "or `request_decision` — don't paper over it. Fabricated evidence is the " +
    "single most damaging thing an agent can do to this backlog's trust model.",
  mark_ticket_blocked:
    "**Block the ticket when you're genuinely stuck on something you cannot " +
    "and should not decide yourself** — a missing dependency, an external " +
    "outage, an ambiguous requirement, or a product/architecture call that " +
    "isn't yours to make. Pass your `claim_token`, the `ticket_id` and a " +
    "specific `reason` a human can act on ('needs prod DB credentials', not " +
    "'stuck').\n\n" +
    "Block instead of guessing: pushing ahead on a wrong assumption produces " +
    "work that fails review and wastes more time than blocking would. But " +
    "don't block on things you can resolve by reading the code, the ACs, or " +
    "existing evidence — exhaust those first. If the blocker is a decision " +
    "someone must MAKE (not just an obstacle), prefer `request_decision`, " +
    "which both records the question and gates the ticket.",
  submit_ticket_for_review:
    "**Submit your claimed ticket for human review once every acceptance " +
    "criterion is satisfied with real evidence.** Pass your `claim_token` and " +
    "the `ticket_id`; this moves the ticket to 'in_review'. You CANNOT approve " +
    "your own work — only a human reviewer can move a ticket to 'done'. That " +
    "separation is intentional and not a bug to route around.\n\n" +
    "Before submitting, `get_ticket` and confirm no required AC is still " +
    "pending — submitting prematurely just bounces back to you and burns a " +
    "review cycle. Use the optional `reason` to summarise what you changed and " +
    "where the evidence lives, so the reviewer can verify quickly. If review " +
    "is rejected the ticket returns to you; read the feedback rather than " +
    "resubmitting unchanged.\n\n" +
    "An EXPLICIT `claim_token` is required: unlike evidence recording, submit " +
    "never resolves the server-injected token. In the Gaffer factory the " +
    "RUNNER owns submission — if your instructions say the runner submits " +
    "after its gates pass, do NOT call this tool; a tokenless call is refused.",
  record_repo_delivery:
    "**Record WHERE one repo's slice of a multi-repo ticket was delivered — its " +
    "branch, commit, PR and a delivery `status`.** Pass the `ticket_id`, the " +
    "`repo_id` (id or name), and whatever you have so far: `branch_name`, " +
    "`commit_sha`, `pr_url`, `status` (not_started → branch_created → " +
    "changes_made → tests_passed → pr_opened → review_ready → done), and an " +
    "optional `evidence_ref`. Idempotent per (ticket, repo): call it again to " +
    "enrich the same row as work progresses. The repo MUST be linked to the " +
    "ticket (it's part of the ticket's repo boundary) or the call is rejected. " +
    "Under `factory_strict`/`regulated`, EVERY write repo needs delivery evidence " +
    "(a branch/PR, or review_ready/done) before the ticket can reach `done` — " +
    "this is how you supply it per repo. For a single-repo ticket, one call " +
    "covers it; `record_delivery_artifact` still records the ticket-level summary.",
  list_pending_decisions:
    "**List the decisions awaiting a human/product answer.** Call this when a " +
    "ticket is blocked on a decision, or before raising a new one, to check " +
    "whether the question you're about to ask has already been asked (don't " +
    "duplicate it). Read-only. An empty list means nothing is pending — it is " +
    "NOT a licence to make a human-required call yourself; if you need a " +
    "decision that isn't here, raise it with `request_decision`.",
  request_decision:
    "**Escalate a real decision to a human — a product, architectural, or " +
    "security question that is not yours to answer.** Provide a clear `title` " +
    "and a specific `question` framed so a human can answer it without " +
    "re-deriving the context ('Use Stripe or Adyen for EU card payments?', " +
    "not 'payment provider?'). Set `severity` to how much it must gate work: " +
    "`human_required` HARD-blocks until answered. Pass `ticket_id` to block " +
    "that ticket on the outcome.\n\n" +
    "Raise a decision instead of quietly choosing when the choice carries " +
    "product/legal/security weight or is expensive to reverse. Check " +
    "`list_pending_decisions` first so you don't duplicate an open question. " +
    "Don't escalate trivial, reversible, in-scope choices you're equipped to " +
    "make — that just adds human latency to work you could have finished.",
  release_claim:
    "**Voluntarily give a claim back when you can't continue and blocking " +
    "isn't right** — e.g. you realise the ticket isn't a fit for your " +
    "capabilities, or you're shutting down cleanly mid-task. Pass the claim " +
    "token; the ticket returns to 'ready' for another agent. Prefer this over " +
    "letting the lease silently expire: releasing frees the work immediately " +
    "and leaves a clean event trail. Do NOT release a ticket you've finished — " +
    "`submit_ticket_for_review` is the completion path; releasing a completed " +
    "ticket throws the work away.",
  add_dependency:
    "**Declare that one ticket must wait for another to be `done` before it can " +
    "be claimed.** Pass `ticket` (the dependent) and `depends_on` (the " +
    "prerequisite), each an id or #number. Until every `depends_on` ticket is " +
    "`done`, the dependent is NOT claimable — `claim_next_ticket` skips it and " +
    "`claim_ticket` refuses it with `DEPENDENCY_BLOCKED`. Use this to hard-gate " +
    "phases (data model before features, bootstrap before everything). A " +
    "self-dependency, a duplicate edge, or one that would form a cycle is " +
    "rejected — the dependency graph stays a DAG.",
  set_ticket_testable:
    "**Mark a ticket eligible (or not) for the independent black-box testing lane.** " +
    "Pass `ticket_id` and `can_be_tested`. Set it when an OBSERVABLE BOUNDARY may " +
    "have changed — an API, endpoint, CLI verb or page — including for a refactor or " +
    "internal-util change that can shift a surface's underlying behaviour (so it is " +
    "NOT 'is this an API ticket'). When on AND the GAFFER_TESTING toggle is enabled, " +
    "review approval routes the ticket through an INDEPENDENT tester before merge. " +
    "Marking it testable only ADDS scrutiny — it never bypasses a gate.",
  set_test_contract:
    "**Record the testing HANDOVER the independent tester reads to stand the system " +
    "up and probe the changed surfaces — never the implementation diff.** Pass " +
    "`ticket_id` plus `changed_surfaces[]` (the boundary contracts whose behaviour " +
    "may have moved), `runtime_deps[]` (infra to stand up, e.g. 'Postgres 16 (was " +
    "MySQL)'), `env_vars[]`, `run_command` (how to bring the system up / invoke the " +
    "surface), and `harness_ready` (whether a black-box harness already exists). The " +
    "tester gets THIS operational contract + the acceptance criteria — and probes " +
    "from the outside; it must never be handed the diff.",
  create_epic:
    "**Create a whole dependency-ordered plan in one atomic call: an `epic` scope " +
    "node that groups N draft tickets, with their acceptance criteria, per-ticket " +
    "priority/risk/repo, an optional `bootstrap` (greenfield) marker, and the " +
    "dependency edges between them.** Provide `epic:{name,description}` and a " +
    "`tickets[]` array; each ticket's `dependsOn` lists the ZERO-BASED INDEXES of " +
    "other tickets in the SAME array it must wait for (resolved to ids for you). " +
    "Tickets land as `draft` (nothing auto-delivers); ready them explicitly when " +
    "the plan is confirmed. The call is all-or-nothing: an out-of-range index, a " +
    "self-dependency or a cyclic plan rejects the entire epic. Returns the epic " +
    "node id and the created ticket numbers in plan order.",
  list_scopes:
    "**Read the Factory Map: the product/system scope nodes and which repos sit " +
    "in each, with the default access (write/read/test/none) that scope grants.** " +
    "Read-only. Call this to understand where work lives before creating or " +
    "claiming a ticket — e.g. to find the scope that owns a repo, or to see which " +
    "repos a product spans. Repos listed under `unmapped_repos` have no scope " +
    "mapping and behave as standalone single-repo scopes (mono fallback); that's " +
    "valid, not an error. This returns a compact summary, not the full graph — it " +
    "deliberately omits edges and internal reasons to stay cheap.",
};

/**
 * Build an MCP server exposing the Dispatch tools over the supplied facade.
 * The server is transport-agnostic; call {@link runStdioServer} to serve it over
 * stdio, or register the returned handlers directly in tests.
 */
export function createDispatchServer(wg: Dispatch, actor: Actor): McpServer {
  const server = new McpServer({ name: "dispatch", version: VERSION });
  const handlers = makeHandlers(wg, actor);

  for (const name of Object.keys(toolSchemas) as Array<keyof typeof toolSchemas>) {
    const handler = handlers[name];
    server.registerTool(
      name,
      {
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: toolSchemas[name],
      },
      // The SDK passes parsed args; our handlers re-validate defensively.
      (args: Record<string, unknown>): ToolResult => handler(args ?? {}),
    );
  }

  return server;
}

/** Open the configured DB and serve the MCP tools over stdio. */
export async function runStdioServer(): Promise<void> {
  const dbPath = resolveDbPath();
  // Open the DB before wiring tools. On failure the client would otherwise see
  // a bare "server failed to start"; emit an actionable diagnostic to stderr
  // (which MCP clients surface on launch failure) and exit cleanly instead.
  let wg: Dispatch;
  try {
    wg = Dispatch.open(dbPath, systemClock);
  } catch (err) {
    if (err instanceof DatabaseTooNewError || err instanceof DatabaseOpenError) {
      process.stderr.write(`dispatch-mcp: ${err.message}\n`);
    } else {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(`dispatch-mcp: failed to start: ${reason}\n`);
    }
    process.exitCode = 1;
    return;
  }
  // The MCP server runs on behalf of an agent client by default.
  const actor: Actor = { type: "agent", id: process.env.DISPATCH_AGENT_ID ?? "mcp-agent" };
  const server = createDispatchServer(wg, actor);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
