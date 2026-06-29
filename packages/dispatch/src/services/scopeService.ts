import { type Db, inTransaction } from "../db/connection.js";
import {
  createScopeEdgeInput,
  createScopeNodeInput,
  linkScopeRepoInput,
  linkTicketScopeInput,
  updateScopeNodeInput,
  updateScopeRepoInput,
} from "../domain/schemas.js";
import {
  SCOPE_EDGE_RELATIONS_V1,
  type Actor,
  type ScopeEdge,
  type ScopeNode,
  type ScopeRepo,
  type TicketScopeNode,
} from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { ScopeEdgeRepository } from "../repositories/scopeEdgeRepository.js";
import { ScopeNodeRepository } from "../repositories/scopeNodeRepository.js";
import {
  ScopeRepoRepository,
  type RepoScopeWithNode,
  type ScopeRepoWithRepo,
} from "../repositories/scopeRepoRepository.js";
import { TicketScopeNodeRepository } from "../repositories/ticketScopeNodeRepository.js";
import { TicketRepository } from "../repositories/ticketRepository.js";
import { RepoRepository } from "../repositories/repoRepository.js";
import type { Clock } from "../util/clock.js";
import { DispatchError, notFound } from "../util/errors.js";
import { newId } from "../util/id.js";

/** A scope node enriched with its linked repos (for the node-detail view). */
export interface ScopeNodeView {
  node: ScopeNode;
  repos: ScopeRepoWithRepo[];
}

export interface ScopeServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly scopeNodes: ScopeNodeRepository;
  readonly scopeEdges: ScopeEdgeRepository;
  readonly scopeRepos: ScopeRepoRepository;
  readonly ticketScopes: TicketScopeNodeRepository;
  readonly tickets: TicketRepository;
  readonly repos: RepoRepository;
}

export class ScopeService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly scopeNodes: ScopeNodeRepository;
  private readonly scopeEdges: ScopeEdgeRepository;
  private readonly scopeRepos: ScopeRepoRepository;
  private readonly ticketScopes: TicketScopeNodeRepository;
  private readonly tickets: TicketRepository;
  private readonly repos: RepoRepository;

  constructor(deps: ScopeServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.scopeNodes = deps.scopeNodes;
    this.scopeEdges = deps.scopeEdges;
    this.scopeRepos = deps.scopeRepos;
    this.ticketScopes = deps.ticketScopes;
    this.tickets = deps.tickets;
    this.repos = deps.repos;
  }

  // --- Factory Map: scope nodes (FG-001) -----------------------------------

  /**
   * Create a scope node (product/system area). Name is NOT unique — the same
   * name may exist under different types — so this only enforces the type enum
   * (via the Zod schema) before inserting.
   */
  createScopeNode(raw: unknown, actor: Actor): ScopeNode {
    const input = createScopeNodeInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const node: ScopeNode = {
        id: newId(),
        name: input.name,
        type: input.type,
        description: input.description ?? null,
        risk_level: input.risk_level,
        owner: input.owner ?? null,
        tags_json: input.tags ? JSON.stringify(input.tags) : null,
        lore_tags_json: input.lore_tags ? JSON.stringify(input.lore_tags) : null,
        created_at: now,
        updated_at: now,
      };
      this.scopeNodes.insert(node);
      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: node.id,
        actor,
        event_type: "scope_node.created",
        payload: { name: node.name, type: node.type },
      });
      return node;
    });
  }

  /** Patch a scope node by id. Only the supplied fields are written. */
  updateScopeNode(nodeId: string, raw: unknown, actor: Actor): ScopeNode {
    const input = updateScopeNodeInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const existing = this.scopeNodes.findById(nodeId);
      if (!existing) throw notFound("scope_node", nodeId);
      const fields: Partial<ScopeNode> = {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.type !== undefined ? { type: input.type } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.risk_level !== undefined ? { risk_level: input.risk_level } : {}),
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        ...(input.tags !== undefined ? { tags_json: JSON.stringify(input.tags) } : {}),
        ...(input.lore_tags !== undefined
          ? { lore_tags_json: JSON.stringify(input.lore_tags) }
          : {}),
      };
      this.scopeNodes.update(nodeId, fields, now);
      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: nodeId,
        actor,
        event_type: "scope_node.updated",
        payload: { fields: Object.keys(fields) },
      });
      return this.scopeNodes.findById(nodeId)!;
    });
  }

  /** All scope nodes, ordered by type then name. Empty when none exist. */
  listScopeNodes(): ScopeNode[] {
    return this.scopeNodes.list();
  }

  /** A scope node plus its linked repos (with relation + default access). */
  getScopeNode(nodeId: string): ScopeNodeView {
    const node = this.scopeNodes.findById(nodeId);
    if (!node) throw notFound("scope_node", nodeId);
    return { node, repos: this.scopeRepos.reposForScope(nodeId) };
  }

  /**
   * Delete a scope node. Blocked (SCOPE_NODE_IN_USE) while it has any scope_repos
   * rows — and any ticket_scope_nodes rows, guarded defensively in case that
   * table (WG-001) exists. Edges referencing the node CASCADE away.
   */
  deleteScopeNode(nodeId: string, actor: Actor): { nodeId: string; eventId: string } {
    return inTransaction(this.db, () => {
      const node = this.scopeNodes.findById(nodeId);
      if (!node) throw notFound("scope_node", nodeId);
      const repoLinks = this.scopeRepos.countForNode(nodeId);
      if (repoLinks > 0) {
        throw new DispatchError(
          "SCOPE_NODE_IN_USE",
          `Scope node '${node.name}' has ${repoLinks} linked repo(s); unlink them before deleting.`,
          { node_id: nodeId, repo_links: repoLinks },
        );
      }
      const ticketLinks = this.countTicketScopeLinks(nodeId);
      if (ticketLinks > 0) {
        throw new DispatchError(
          "SCOPE_NODE_IN_USE",
          `Scope node '${node.name}' is linked to ${ticketLinks} ticket(s); unlink them before deleting.`,
          { node_id: nodeId, ticket_links: ticketLinks },
        );
      }
      this.scopeNodes.delete(nodeId);
      const eventId = writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: nodeId,
        actor,
        event_type: "scope_node.deleted",
        payload: { name: node.name },
      });
      return { nodeId, eventId };
    });
  }

  /** Count of ticket↔scope links referencing a node — blocks node deletion. */
  private countTicketScopeLinks(nodeId: string): number {
    return this.ticketScopes.countForNode(nodeId);
  }

  // --- Factory Map: scope edges (FG-001) -----------------------------------

  /**
   * Create a graph edge between two scope nodes. Rejects self-edges and (for the
   * `contains` relation) cycles, so containment stays a DAG. Relations beyond the
   * v1 set (contains / depends_on) require `advanced: true`.
   */
  createScopeEdge(raw: unknown, actor: Actor): ScopeEdge {
    const input = createScopeEdgeInput.parse(raw);
    if (input.from_node_id === input.to_node_id) {
      throw new DispatchError("INVALID_EDGE", "A scope edge cannot point a node at itself.", {
        node_id: input.from_node_id,
      });
    }
    if (
      !input.advanced &&
      !(SCOPE_EDGE_RELATIONS_V1 as readonly string[]).includes(input.relation)
    ) {
      throw new DispatchError(
        "ADVANCED_RELATION_REQUIRED",
        `Relation '${input.relation}' is advanced; pass advanced:true to use it (v1 exposes ${SCOPE_EDGE_RELATIONS_V1.join(", ")}).`,
        { relation: input.relation },
      );
    }
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const from = this.scopeNodes.findById(input.from_node_id);
      if (!from) throw notFound("scope_node", input.from_node_id);
      const to = this.scopeNodes.findById(input.to_node_id);
      if (!to) throw notFound("scope_node", input.to_node_id);
      if (this.scopeEdges.exists(input.from_node_id, input.to_node_id, input.relation)) {
        throw new DispatchError("DUPLICATE", "That scope edge already exists.", {
          from_node_id: input.from_node_id,
          to_node_id: input.to_node_id,
          relation: input.relation,
        });
      }
      if (
        input.relation === "contains" &&
        this.containsCycleWouldForm(input.to_node_id, input.from_node_id)
      ) {
        throw new DispatchError(
          "INVALID_EDGE",
          "This 'contains' edge would create a containment cycle.",
          { from_node_id: input.from_node_id, to_node_id: input.to_node_id },
        );
      }
      const edge: ScopeEdge = {
        id: newId(),
        from_node_id: input.from_node_id,
        to_node_id: input.to_node_id,
        relation: input.relation,
        confidence: input.confidence ?? null,
        reasons_json: input.reasons ? JSON.stringify(input.reasons) : null,
        created_at: now,
      };
      this.scopeEdges.insert(edge);
      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: input.from_node_id,
        actor,
        event_type: "scope_edge.created",
        payload: { edge_id: edge.id, to_node_id: input.to_node_id, relation: input.relation },
      });
      return edge;
    });
  }

  /**
   * Walk `contains` edges from `startNodeId`; true if `targetNodeId` is reachable
   * (so adding target -contains-> start would close a loop). Guards against the
   * graph itself containing a pre-existing cycle via a visited set.
   */
  containsCycleWouldForm(startNodeId: string, targetNodeId: string): boolean {
    const seen = new Set<string>();
    const stack = [startNodeId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === targetNodeId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const children = this.db
        .prepare(
          `SELECT to_node_id FROM scope_edges WHERE relation = 'contains' AND from_node_id = ?`,
        )
        .all(current) as Array<{ to_node_id: string }>;
      for (const child of children) stack.push(child.to_node_id);
    }
    return false;
  }

  /** Graph edges, optionally filtered to those touching `nodeId` (either end). */
  listScopeEdges(nodeId?: string): ScopeEdge[] {
    return this.scopeEdges.list(nodeId);
  }

  deleteScopeEdge(edgeId: string, actor: Actor): { edgeId: string; eventId: string } {
    return inTransaction(this.db, () => {
      const edge = this.scopeEdges.findById(edgeId);
      if (!edge) throw notFound("scope_edge", edgeId);
      this.scopeEdges.delete(edgeId);
      const eventId = writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: edge.from_node_id,
        actor,
        event_type: "scope_edge.deleted",
        payload: { edge_id: edgeId, relation: edge.relation },
      });
      return { edgeId, eventId };
    });
  }

  // --- Factory Map: scope↔repo associations (FG-002) -----------------------

  /**
   * Link a repo into a scope node with a relation + default access. A repo may
   * be linked to many scope nodes; the (scope, repo, relation) triple is unique.
   */
  linkScopeRepo(raw: unknown, actor: Actor): ScopeRepo {
    const input = linkScopeRepoInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const node = this.scopeNodes.findById(input.scope_node_id);
      if (!node) throw notFound("scope_node", input.scope_node_id);
      const repo = this.repos.findById(input.repo_id) ?? this.repos.findByName(input.repo_id);
      if (!repo) throw notFound("repository", input.repo_id);
      if (this.scopeRepos.exists(node.id, repo.id, input.relation)) {
        throw new DispatchError(
          "DUPLICATE",
          "That repo is already linked to this scope node with that relation.",
          { scope_node_id: node.id, repo_id: repo.id, relation: input.relation },
        );
      }
      const link: ScopeRepo = {
        id: newId(),
        scope_node_id: node.id,
        repo_id: repo.id,
        relation: input.relation,
        default_access: input.default_access,
        confidence: input.confidence ?? null,
        role_description: input.role_description ?? null,
        reasons_json: input.reasons ? JSON.stringify(input.reasons) : null,
        created_at: now,
        updated_at: now,
      };
      this.scopeRepos.insert(link);
      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: node.id,
        actor,
        event_type: "scope_repo.linked",
        payload: {
          association_id: link.id,
          repo_id: repo.id,
          relation: link.relation,
          default_access: link.default_access,
        },
      });
      return link;
    });
  }

  /** Patch a scope↔repo association (access / confidence / role / reasons). */
  updateScopeRepo(associationId: string, raw: unknown, actor: Actor): ScopeRepo {
    const input = updateScopeRepoInput.parse(raw);
    const now = this.clock.now();
    return inTransaction(this.db, () => {
      const existing = this.scopeRepos.findById(associationId);
      if (!existing) throw notFound("scope_repo", associationId);
      const fields: Partial<ScopeRepo> = {
        ...(input.default_access !== undefined ? { default_access: input.default_access } : {}),
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.role_description !== undefined
          ? { role_description: input.role_description }
          : {}),
        ...(input.reasons !== undefined ? { reasons_json: JSON.stringify(input.reasons) } : {}),
      };
      this.scopeRepos.update(associationId, fields, now);
      writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: existing.scope_node_id,
        actor,
        event_type: "scope_repo.updated",
        payload: { association_id: associationId, fields: Object.keys(fields) },
      });
      return this.scopeRepos.findById(associationId)!;
    });
  }

  /** Remove a scope↔repo association by its id. */
  unlinkScopeRepo(associationId: string, actor: Actor): { associationId: string; eventId: string } {
    return inTransaction(this.db, () => {
      const existing = this.scopeRepos.findById(associationId);
      if (!existing) throw notFound("scope_repo", associationId);
      this.scopeRepos.delete(associationId);
      const eventId = writeEvent(this.db, {
        entity_type: "scope_node",
        entity_id: existing.scope_node_id,
        actor,
        event_type: "scope_repo.unlinked",
        payload: { association_id: associationId, repo_id: existing.repo_id },
      });
      return { associationId, eventId };
    });
  }

  /** Repos linked to a scope node, with relation + default access. */
  reposForScope(nodeId: string): ScopeRepoWithRepo[] {
    if (!this.scopeNodes.findById(nodeId)) throw notFound("scope_node", nodeId);
    return this.scopeRepos.reposForScope(nodeId);
  }

  /** Scope nodes a repo belongs to, with relation + default access. */
  scopesForRepo(repoRef: string): RepoScopeWithNode[] {
    const repo = this.repos.findById(repoRef) ?? this.repos.findByName(repoRef);
    if (!repo) throw notFound("repository", repoRef);
    return this.scopeRepos.scopesForRepo(repo.id);
  }

  /**
   * Repositories with NO scope association — implicit single-repo scopes. WG-006:
   * hidden repos are excluded by default (so a hidden repo drops off the Factory
   * Map's unmapped list); pass `includeHidden` for the full set.
   */
  listUnmappedRepos(includeHidden = false): import("../domain/types.js").Repository[] {
    return this.scopeRepos.listUnmappedRepos(includeHidden);
  }

  // --- Ticket scope links (WG-001) -----------------------------------------

  /**
   * Link a ticket to a scope node with a relation. Upsert: re-linking the same
   * node updates its relation/confidence/reasons. Marking a link `primary` here
   * delegates to {@link setPrimaryScope} so the "at most one primary" invariant
   * holds. `implicit_repo` is reserved for the auto-link path and rejected here.
   */
  linkTicketScope(raw: unknown, actor: Actor): TicketScopeNode {
    const input = linkTicketScopeInput.parse(raw);
    if (input.relation === "implicit_repo") {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "The 'implicit_repo' relation is recorded automatically and cannot be set manually.",
      );
    }
    if (input.relation === "primary") {
      this.setPrimaryScope(input.ticket_id, input.scope_node_id, actor);
      return this.ticketScopes.find(input.ticket_id, input.scope_node_id)!;
    }
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(input.ticket_id);
      const node = this.scopeNodes.findById(input.scope_node_id);
      if (!node) throw notFound("scope_node", input.scope_node_id);
      const now = this.clock.now();
      const link: TicketScopeNode = {
        ticket_id: ticket.id,
        scope_node_id: node.id,
        relation: input.relation,
        confidence: input.confidence ?? null,
        reasons_json: input.reasons ? JSON.stringify(input.reasons) : null,
        created_at: now,
        updated_at: now,
      };
      this.ticketScopes.upsert(link);
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.scope_linked",
        payload: { scope_node_id: node.id, relation: link.relation },
      });
      return link;
    });
  }

  /**
   * Mark a scope node as the ticket's PRIMARY scope, demoting any existing
   * primary to 'secondary' first so at most one primary exists per ticket.
   * Creates the link if absent. Returns the resulting primary link.
   */
  setPrimaryScope(ticketRef: string, scopeNodeId: string, actor: Actor): TicketScopeNode {
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      const node = this.scopeNodes.findById(scopeNodeId);
      if (!node) throw notFound("scope_node", scopeNodeId);
      const now = this.clock.now();
      this.ticketScopes.demotePrimaries(ticket.id, now);
      const existing = this.ticketScopes.find(ticket.id, node.id);
      const link: TicketScopeNode = {
        ticket_id: ticket.id,
        scope_node_id: node.id,
        relation: "primary",
        confidence: existing?.confidence ?? null,
        reasons_json: existing?.reasons_json ?? null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      this.ticketScopes.upsert(link);
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.scope_primary_set",
        payload: { scope_node_id: node.id },
      });
      return link;
    });
  }

  /** All scope links for a ticket (primary first), joined to the node. */
  listTicketScopes(
    ticketRef: string,
  ): import("../repositories/ticketScopeNodeRepository.js").TicketScopeWithNode[] {
    const ticket = this.resolveTicket(ticketRef);
    return this.ticketScopes.listForTicket(ticket.id);
  }

  /** Remove a ticket↔scope link. */
  removeTicketScope(
    ticketRef: string,
    scopeNodeId: string,
    actor: Actor,
  ): { ticketId: string; scopeNodeId: string; eventId: string } {
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      if (!this.ticketScopes.find(ticket.id, scopeNodeId)) {
        throw notFound("ticket_scope", `${ticket.id}/${scopeNodeId}`);
      }
      this.ticketScopes.delete(ticket.id, scopeNodeId);
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.scope_unlinked",
        payload: { scope_node_id: scopeNodeId },
      });
      return { ticketId: ticket.id, scopeNodeId, eventId };
    });
  }

  /**
   * Compact scope summary for the MCP get_ticket payload: the primary scope (id +
   * name + type only) plus counts by relation. Deliberately omits confidence,
   * reasons and the full graph — the agent gets "what is the primary product area
   * and how many scopes are in play", not the internals. Mirrors the
   * eventProjection redaction discipline.
   */
  ticketScopeSummary(ticketRef: string): {
    primary: { id: string; name: string; type: string } | null;
    counts: Record<string, number>;
    total: number;
  } {
    const links = this.listTicketScopes(ticketRef);
    const counts: Record<string, number> = {};
    let primary: { id: string; name: string; type: string } | null = null;
    for (const l of links) {
      counts[l.relation] = (counts[l.relation] ?? 0) + 1;
      if (l.relation === "primary") primary = { id: l.id, name: l.name, type: l.type };
    }
    return { primary, counts, total: links.length };
  }

  /**
   * For each scope node a repo belongs to, do nothing — those scopes are mapped.
   * If the repo is UNMAPPED, ensure the ticket carries an `implicit_repo` scope
   * synthesised from the repo itself, modelled as a scope node of type
   * `external_dependency` named after the repo. Idempotent: re-linking the same
   * unmapped repo reuses the synthetic node (matched by name + type) rather than
   * creating a duplicate. Never overrides a human-set primary scope.
   */
  recordImplicitRepoScopes(ticketId: string, repoId: string, actor: Actor): void {
    const scopes = this.scopeRepos.scopesForRepo(repoId);
    if (scopes.length > 0) return; // mapped — graph carries the scope.

    const repo = this.repos.findById(repoId);
    if (!repo) return;
    const syntheticName = `repo:${repo.name}`;
    const existing = this.scopeNodes
      .list()
      .find((n) => n.name === syntheticName && n.type === "external_dependency");
    const node =
      existing ??
      this.createScopeNode(
        {
          name: syntheticName,
          type: "external_dependency",
          description: `Implicit single-repo scope for unmapped repo '${repo.name}'.`,
        },
        actor,
      );
    if (this.ticketScopes.find(ticketId, node.id)) return;
    const now = this.clock.now();
    this.ticketScopes.upsert({
      ticket_id: ticketId,
      scope_node_id: node.id,
      relation: "implicit_repo",
      confidence: null,
      reasons_json: JSON.stringify([`unmapped repo '${repo.name}' targeted by ticket`]),
      created_at: now,
      updated_at: now,
    });
    writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: ticketId,
      actor,
      event_type: "ticket.scope_linked",
      payload: { scope_node_id: node.id, relation: "implicit_repo" },
    });
  }

  // --- Internal helpers ---------------------------------------------------

  private resolveTicket(ref: string): import("../domain/types.js").Ticket {
    const byId = this.tickets.findById(ref);
    if (byId) return byId;
    const asNumber = Number(ref.replace(/^#/, ""));
    if (Number.isInteger(asNumber)) {
      const byNumber = this.tickets.findByNumber(asNumber);
      if (byNumber) return byNumber;
    }
    throw notFound("ticket", ref);
  }
}
