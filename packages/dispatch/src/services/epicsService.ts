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
  ticketNumbers: number[];
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
      for (const spec of input.tickets) {
        const ticket = this.tickets.createTicket(
          {
            title: spec.title,
            description: spec.description,
            ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
            ...(spec.risk_level !== undefined ? { risk_level: spec.risk_level } : {}),
            ...(spec.policy_pack !== undefined ? { policy_pack: spec.policy_pack } : {}),
            ...(spec.bootstrap !== undefined ? { bootstrap: spec.bootstrap } : {}),
          },
          actor,
        );
        createdIds.push(ticket.id);
        createdNumbers.push(ticket.number ?? 0);

        for (const text of spec.acceptanceCriteria) {
          this.tickets.addAcceptanceCriterion({ ticket_id: ticket.id, text }, actor);
        }

        if (spec.repo) {
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

      // Now wire the dependency edges by resolving each plan index to its id.
      for (let i = 0; i < n; i++) {
        for (const depIndex of input.tickets[i]!.dependsOn) {
          this.tickets.addDependency(
            { ticket: createdIds[i]!, depends_on: createdIds[depIndex]! },
            actor,
          );
        }
      }

      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: node.id,
        actor,
        event_type: "epic.created",
        payload: { name: input.epic.name, ticket_count: n, ticket_numbers: createdNumbers },
      });

      return { epicNodeId: node.id, ticketNumbers: createdNumbers };
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
