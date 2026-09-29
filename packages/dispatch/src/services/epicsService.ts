import { type Db, inTransaction } from "../db/connection.js";
import { createEpicInput } from "../domain/schemas.js";
import { type Actor } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { TicketScopeNodeRepository } from "../repositories/ticketScopeNodeRepository.js";
import type { Clock } from "../util/clock.js";
import { DispatchError } from "../util/errors.js";
import type { ScopeService } from "./scopeService.js";
import type { TicketService } from "./ticketService.js";
import type { RepoService } from "./repoService.js";

/** Result of createEpic (EP-001). */
export interface CreateEpicResult {
  epicNodeId: string;
  /** Tickets whose named repo does not exist yet (greenfield): link deferred to bootstrap. */
  deferredRepoLinks: number;
  /** Every created ticket in plan order; the acceptance ticket (when created) is LAST. */
  ticketNumbers: number[];
  /** ACCEPTANCE GATE: the number of the epic's build-level acceptance ticket, or null when opted out. */
  acceptanceTicketNumber: number | null;
}

/**
 * ACCEPTANCE GATE — the build-level acceptance ticket the factory appends to every epic.
 *
 * Why it is created HERE, deterministically, and not asked of the planner: a live run
 * delivered 13/13 tickets, every one reviewed and judged 4+/5, and the finished
 * application still failed a brief-level check (20 concurrent writes → 8 × HTTP 500).
 * No ticket criterion covered concurrent writers because the planner decomposed
 * "never corrupted by a failed write" into "atomic temp-file + rename". Asking the
 * same planner to also remember an acceptance ticket leaves the same omission
 * possible. So the application creates it: dependent on every implementation ticket
 * (it runs last, against the integrated default branch), marked testable with a
 * contract, and — via Ticket.acceptance — always routed through the independent
 * tester on approval. "Implementation tickets merged" and "build accepted" become
 * different states (`stats.acceptance`).
 *
 * The criteria are cross-cutting behaviours a ticket decomposition tends to drop.
 * Each is phrased for the build as a whole and conditioned ("where the build …") so
 * it is verifiable — or plainly not applicable — for any kind of build.
 */
export const ACCEPTANCE_CRITERIA: readonly string[] = [
  "Brief coverage: the integrated build (the default branch after every implementation ticket of this epic has merged) satisfies every capability the brief names, exercised end to end through its real entry points (CLI, HTTP, files, UI) by automated acceptance tests that run under the repository's normal test command",
  "Persistence: where the build stores data, every acknowledged write is durable across a process restart, and a failed or interrupted write leaves the previously committed data intact",
  "Concurrent writers: where the build stores data, concurrent mutations through every entry point — and across processes where more than one can write — never fail because of each other and never lose an acknowledged update",
  "Failure behaviour: invalid input and error paths return the documented errors without crashing or corrupting state",
  "Runtime support: the declared runtime version is pinned and exercised by the tests, and the build declares no runtime dependency it does not use",
];

export function acceptanceTicketTitle(epicName: string): string {
  return `Acceptance: ${epicName}`.slice(0, 300);
}

export function acceptanceTicketDescription(epicName: string, brief: string | undefined): string {
  const contract = (brief ?? "").trim();
  return [
    "BUILD-LEVEL ACCEPTANCE (created by the factory for every epic; the only way this build is reported as accepted).",
    "",
    `This ticket depends on every implementation ticket of the epic "${epicName}" and runs last, against the integrated default branch.`,
    "",
    "Deliver: a brief-level acceptance test suite in the repository, under its normal test command, that exercises the build end to end through its real entry points — including the cross-cutting behaviours in the acceptance criteria (persistence, concurrent writers, failure behaviour, runtime support) — and fix any defect the suite finds with the smallest change that makes it pass. Never weaken or delete an existing test. The independent tester then verifies the build from this ticket's contract and criteria only, never from the diff; the build is accepted when that verdict is recorded.",
    "",
    contract
      ? `Brief (the contract):
${contract}`
      : "Brief: (none recorded — the epic description is the contract)",
  ].join("\n");
}

export interface EpicsServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ticketScopes: TicketScopeNodeRepository;
  readonly scope: ScopeService;
  readonly tickets: TicketService;
  readonly repos: RepoService;
}

export class EpicsService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ticketScopes: TicketScopeNodeRepository;
  private readonly scope: ScopeService;
  private readonly tickets: TicketService;
  private readonly repos: RepoService;

  constructor(deps: EpicsServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.ticketScopes = deps.ticketScopes;
    this.scope = deps.scope;
    this.tickets = deps.tickets;
    this.repos = deps.repos;
  }

  createEpic(raw: unknown, actor: Actor): CreateEpicResult {
    const input = createEpicInput.parse(raw);

    // Pre-flight the dependency indexes BEFORE any write so a bad plan fails
    // cleanly (and cheaply) rather than part-way through the transaction.
    const n = input.tickets.length;
    for (let i = 0; i < n; i++) {
      for (const dep of input.tickets[i]!.dependsOn) {
        if (dep === i) {
          throw new DispatchError("INVALID_DEPENDENCY", `Ticket #${i} cannot depend on itself.`, {
            index: i,
          });
        }
        if (dep < 0 || dep >= n) {
          throw new DispatchError(
            "INVALID_DEPENDENCY",
            `Ticket #${i} depends on out-of-range index ${dep} (plan has ${n} tickets).`,
            { index: i, depends_on_index: dep },
          );
        }
      }
    }
    // Reject a cyclic plan up front via a DFS over the declared index edges.
    this.assertEpicPlanIsAcyclic(input.tickets.map((t) => t.dependsOn));

    return inTransaction(this.db, () => {
      const node = this.scope.createScopeNode(
        {
          name: input.epic.name,
          type: "epic",
          ...(input.epic.description !== undefined ? { description: input.epic.description } : {}),
        },
        actor,
      );

      // Create every ticket first so the index→id map is complete before edges
      // are wired. Each ticket is created via the normal createTicket path (draft,
      // policy/scope validation), then ACs, repo link + access, and contained by
      // the epic node.
      const createdIds: string[] = [];
      const createdNumbers: number[] = [];
      let deferredRepoLinks = 0;
      for (const spec of input.tickets) {
        // Does the named repo exist yet? (Greenfield plans name the repo their bootstrap
        // ticket will create.) Matched by name or id, like every other repo reference.
        const repoKnown = !spec.repo || this.repos.findRepository(spec.repo) !== undefined;
        const sourceName = spec.source ?? (spec.repo && !repoKnown ? spec.repo : undefined);
        const ticket = this.tickets.createTicket(
          {
            title: spec.title,
            description: spec.description,
            ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
            // A BOOTSTRAP declares HIGH risk unless the plan says otherwise: a fresh
            // scaffold is a large diff that adds a lockfile, so the server-observed risk
            // is high by construction — left at the default "medium" the observed-risk
            // gate escalated EVERY autonomous bootstrap to a human hold (seen live), and
            // its dependents starved. Declaring what will be observed lets the autonomy
            // policy decide, as it does for every other ticket.
            ...(spec.risk_level !== undefined
              ? { risk_level: spec.risk_level }
              : spec.bootstrap
                ? { risk_level: "high" as const }
                : {}),
            ...(spec.policy_pack !== undefined ? { policy_pack: spec.policy_pack } : {}),
            ...(spec.bootstrap !== undefined ? { bootstrap: spec.bootstrap } : {}),
            // Greenfield: the intended new-repo name rides on `source` so the runner
            // bootstraps a cleanly-named repo (not a slug of the ticket title) when
            // the target repo does not exist yet and `repo` was stripped upstream.
            ...(sourceName !== undefined ? { source: sourceName } : {}),
            // TRACK-3a: per-ticket budget wins; else inherit the epic-level budget.
            ...(spec.delivery_budget_usd !== undefined
              ? { delivery_budget_usd: spec.delivery_budget_usd }
              : input.epic.delivery_budget_usd !== undefined
                ? { delivery_budget_usd: input.epic.delivery_budget_usd }
                : {}),
          },
          actor,
        );
        createdIds.push(ticket.id);
        createdNumbers.push(ticket.number ?? 0);

        for (const ac of spec.acceptanceCriteria) {
          // Spec-Driven Development (Phase 2a): an AC is either a bare string
          // (unchanged) or `{ text, clauseRef? }`. When a clauseRef is present it
          // threads down as `spec_clause_id` provenance on the created AC.
          const text = typeof ac === "string" ? ac : ac.text;
          const clauseRef = typeof ac === "string" ? undefined : ac.clauseRef;
          this.tickets.addAcceptanceCriterion(
            {
              ticket_id: ticket.id,
              text,
              ...(clauseRef !== undefined ? { spec_clause_id: clauseRef } : {}),
            },
            actor,
          );
        }

        if (spec.repo && !repoKnown) {
          // GREENFIELD (server-side, mirroring the dashboard's confirmPlanBuild): the plan
          // names a repo the bootstrap ticket will CREATE, so there is nothing to link yet.
          // The name already rode onto `source` above; the link is established when the
          // runner registers the repo at bootstrap and inherits it onto the siblings.
          // Before this the CLI/API path failed the whole epic with NOT_FOUND while the
          // dashboard quietly deferred the link — two behaviours for one plan.
          deferredRepoLinks += 1;
        } else if (spec.repo) {
          // Internal seed of the epic ticket's repo link — uses the unguarded core
          // so an agent-driven epic-create (the factory flow) still links its repo.
          // The PUBLIC setTicketRepoAccess stays human/admin-only (P0 authz).
          this.repos.applyTicketRepoAccess(
            {
              ticket_id: ticket.id,
              repo_id: spec.repo,
              ...(spec.access !== undefined ? { access: spec.access } : {}),
            },
            actor,
          );
        }

        // The epic node `contains` the ticket — a ticket↔scope link, so the epic
        // groups its tickets the same way a product scope groups its work.
        this.ticketScopes.upsert({
          ticket_id: ticket.id,
          scope_node_id: node.id,
          relation: "secondary",
          confidence: null,
          reasons_json: JSON.stringify([`contained by epic '${input.epic.name}'`]),
          created_at: this.clock.now(),
          updated_at: this.clock.now(),
        });
      }

      // ACCEPTANCE GATE: append the build-level acceptance ticket (see the module doc
      // above). Created through the same createTicket path (draft, policy validated),
      // linked to the plan's repo exactly like its siblings (a greenfield repo's link
      // is inherited at bootstrap, the same deferred path), contained by the epic,
      // testable with a contract, and wired behind EVERY implementation ticket below.
      let acceptanceTicketNumber: number | null = null;
      if (input.epic.acceptance !== false) {
        const repoSpec = input.tickets.find((t) => t.repo);
        const repoKnown = !repoSpec?.repo || this.repos.findRepository(repoSpec.repo) !== undefined;
        const acceptance = this.tickets.createTicket(
          {
            title: acceptanceTicketTitle(input.epic.name),
            description: acceptanceTicketDescription(
              input.epic.name,
              input.epic.brief ?? input.epic.description,
            ),
            risk_level: "medium",
            acceptance: true,
            ...(repoSpec?.repo && !repoKnown ? { source: repoSpec.repo } : {}),
            ...(input.epic.delivery_budget_usd !== undefined
              ? { delivery_budget_usd: input.epic.delivery_budget_usd }
              : {}),
          },
          actor,
        );
        for (const text of ACCEPTANCE_CRITERIA) {
          this.tickets.addAcceptanceCriterion({ ticket_id: acceptance.id, text }, actor);
        }
        if (repoSpec?.repo && repoKnown) {
          this.repos.applyTicketRepoAccess(
            {
              ticket_id: acceptance.id,
              repo_id: repoSpec.repo,
              ...(repoSpec.access !== undefined ? { access: repoSpec.access } : {}),
            },
            actor,
          );
        } else if (repoSpec?.repo) {
          deferredRepoLinks += 1;
        }
        this.tickets.setTestable(acceptance.id, true, actor);
        this.tickets.setTestContract(
          acceptance.id,
          {
            changed_surfaces: [
              `the whole build of epic "${input.epic.name}": every user-facing entry point`,
            ],
            runtime_deps: [],
            env_vars: [],
            run_command: "",
            harness_ready: false,
          },
          actor,
        );
        this.ticketScopes.upsert({
          ticket_id: acceptance.id,
          scope_node_id: node.id,
          relation: "secondary",
          confidence: null,
          reasons_json: JSON.stringify([`acceptance ticket of epic '${input.epic.name}'`]),
          created_at: this.clock.now(),
          updated_at: this.clock.now(),
        });
        createdIds.push(acceptance.id);
        createdNumbers.push(acceptance.number ?? 0);
        acceptanceTicketNumber = acceptance.number ?? null;
      }

      // Now wire the dependency edges by resolving each plan index to its id.
      for (let i = 0; i < n; i++) {
        for (const depIndex of input.tickets[i]!.dependsOn) {
          this.tickets.addDependency(
            { ticket: createdIds[i]!, depends_on: createdIds[depIndex]! },
            actor,
          );
        }
      }
      // The acceptance ticket depends on every implementation ticket: it can only be
      // claimed once the whole plan has merged, so it tests the integrated build.
      if (acceptanceTicketNumber !== null) {
        const acceptanceId = createdIds[createdIds.length - 1]!;
        for (let i = 0; i < n; i++) {
          this.tickets.addDependency({ ticket: acceptanceId, depends_on: createdIds[i]! }, actor);
        }
      }

      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: node.id,
        actor,
        event_type: "epic.created",
        payload: {
          name: input.epic.name,
          ticket_count: n,
          ticket_numbers: createdNumbers,
          ...(acceptanceTicketNumber !== null ? { acceptance_ticket: acceptanceTicketNumber } : {}),
        },
      });

      return {
        epicNodeId: node.id,
        ticketNumbers: createdNumbers,
        deferredRepoLinks,
        acceptanceTicketNumber,
      };
    });
  }

  /**
   * Reject a cyclic epic plan: a DFS over the index→dependsOn adjacency. Throws
   * INVALID_DEPENDENCY on the first back-edge.
   */
  private assertEpicPlanIsAcyclic(adjacency: ReadonlyArray<readonly number[]>): void {
    const WHITE = 0;
    const GREY = 1;
    const BLACK = 2;
    const color = new Array<number>(adjacency.length).fill(WHITE);
    const visit = (node: number): void => {
      color[node] = GREY;
      for (const next of adjacency[node]!) {
        if (color[next] === GREY) {
          throw new DispatchError(
            "INVALID_DEPENDENCY",
            "The epic plan's dependencies form a cycle.",
            { from_index: node, to_index: next },
          );
        }
        if (color[next] === WHITE) visit(next);
      }
      color[node] = BLACK;
    };
    for (let i = 0; i < adjacency.length; i++) {
      if (color[i] === WHITE) visit(i);
    }
  }
}
