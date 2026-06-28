import { type Db, inTransaction } from "../db/connection.js";
import {
  registerRepoInput,
  setTicketRepoAccessInput,
  suggestReposInput,
} from "../domain/schemas.js";
import { isActiveTicketRepoRelation, type Actor, type Repository } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import { RepoRepository, type TicketRepoLink } from "../repositories/repoRepository.js";
import { ScopeRepoRepository } from "../repositories/scopeRepoRepository.js";
import { TicketRepository } from "../repositories/ticketRepository.js";
import { TicketScopeNodeRepository } from "../repositories/ticketScopeNodeRepository.js";
import {
  SuggestionService,
  type RepoSuggestion,
  type SuggestByFields,
} from "./suggestionService.js";
import type { ScopeService } from "./scopeService.js";
import type { Clock } from "../util/clock.js";
import { DispatchError, notFound } from "../util/errors.js";
import { newId } from "../util/id.js";

/** Result of setting a ticket↔repo access boundary. */
export interface TicketRepoAccessResult {
  ticketId: string;
  repoId: string;
  access: string;
  relation: string;
  eventId: string;
}

/**
 * The execution boundary for a ticket, partitioned by access (WG-002).
 */
export interface WorkPacketRepos {
  writeRepos: TicketRepoLink[];
  readOnlyRepos: TicketRepoLink[];
  testRepos: TicketRepoLink[];
  deniedRepos: TicketRepoLink[];
  /** Active links pending human confirmation (relation='suggested'). */
  suggestedRepos: TicketRepoLink[];
  /** Retained-for-audit rejected links (relation='rejected'). */
  rejectedRepos: TicketRepoLink[];
}

export interface RepoServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly repos: RepoRepository;
  readonly tickets: TicketRepository;
  readonly scopeRepos: ScopeRepoRepository;
  readonly ticketScopes: TicketScopeNodeRepository;
  readonly suggestions: SuggestionService;
  readonly scope: ScopeService;
}

export class RepoService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly repos: RepoRepository;
  private readonly tickets: TicketRepository;
  private readonly scopeRepos: ScopeRepoRepository;
  private readonly ticketScopes: TicketScopeNodeRepository;
  private readonly suggestions: SuggestionService;
  private readonly scope: ScopeService;

  constructor(deps: RepoServiceDeps) {
    this.db = deps.db;
    this.clock = deps.clock;
    this.repos = deps.repos;
    this.tickets = deps.tickets;
    this.scopeRepos = deps.scopeRepos;
    this.ticketScopes = deps.ticketScopes;
    this.suggestions = deps.suggestions;
    this.scope = deps.scope;
  }

  // --- Repositories --------------------------------------------------------

  registerRepository(raw: unknown, actor: Actor): Repository {
    const input = registerRepoInput.parse(raw);
    const now = this.clock.now();
    if (this.repos.findByName(input.name)) {
      throw new DispatchError("DUPLICATE", `Repository '${input.name}' already exists.`);
    }
    const repo: Repository = {
      id: newId(),
      name: input.name,
      local_path: input.local_path ?? null,
      remote_url: input.remote_url ?? null,
      default_branch: input.default_branch,
      stack: input.stack ?? null,
      risk_level: input.risk_level,
      test_command: input.test_command ?? null,
      lint_command: input.lint_command ?? null,
      coverage_command: input.coverage_command ?? null,
      hidden: 0,
      created_at: now,
      updated_at: now,
    };
    this.repos.insert(repo);
    writeEvent(this.db, {
      entity_type: "repository",
      entity_id: repo.id,
      actor,
      event_type: "repository.registered",
      payload: { name: repo.name },
    });
    return repo;
  }

  /**
   * WG-006: hide or un-hide a repo (by id or name).
   */
  setRepoHidden(repoRef: string, hidden: boolean, actor: Actor): Repository {
    return inTransaction(this.db, () => {
      const repo = this.repos.findById(repoRef) ?? this.repos.findByName(repoRef);
      if (!repo) throw notFound("repository", repoRef);
      const already = repo.hidden === 1;
      if (already === hidden) {
        return repo;
      }
      const now = this.clock.now();
      this.repos.setHidden(repo.id, hidden, now);
      writeEvent(this.db, {
        entity_type: "repository",
        entity_id: repo.id,
        actor,
        event_type: hidden ? "repository.hidden" : "repository.unhidden",
        payload: { name: repo.name },
      });
      return { ...repo, hidden: hidden ? 1 : 0, updated_at: now };
    });
  }

  linkRepository(ticketId: string, repoName: string, role: string, actor: Actor): void {
    return inTransaction(this.db, () => {
      const ticket = this.tickets.findById(ticketId);
      if (!ticket) throw notFound("ticket", ticketId);
      const repo = this.repos.findByName(repoName) ?? this.repos.findById(repoName);
      if (!repo) throw notFound("repository", repoName);
      this.repos.linkTicket(ticket.id, repo.id, role, this.clock.now());
      writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.repo_linked",
        payload: { repo_id: repo.id, role },
      });
      // WG-001: if the repo is unmapped (no scope_repos rows), record an
      // implicit_repo scope so the ticket's product/system scope is never empty.
      this.scope.recordImplicitRepoScopes(ticket.id, repo.id, actor);
    });
  }

  /**
   * The ticket's execution boundary, partitioned by access (WG-002).
   */
  workPacketRepos(ticketRef: string): WorkPacketRepos {
    const ticket = this.resolveTicket(ticketRef);
    const links = this.repos.accessLinksForTicket(ticket.id);
    const out: WorkPacketRepos = {
      writeRepos: [],
      readOnlyRepos: [],
      testRepos: [],
      deniedRepos: [],
      suggestedRepos: [],
      rejectedRepos: [],
    };
    for (const link of links) {
      if (link.relation === "rejected") {
        out.rejectedRepos.push(link);
        continue;
      }
      if (link.relation === "suggested") {
        out.suggestedRepos.push(link);
        continue;
      }
      if (!isActiveTicketRepoRelation(link.relation)) {
        out.readOnlyRepos.push(link);
        continue;
      }
      switch (link.access) {
        case "write":
          out.writeRepos.push(link);
          break;
        case "read":
          out.readOnlyRepos.push(link);
          break;
        case "test":
          out.testRepos.push(link);
          break;
        case "none":
          out.deniedRepos.push(link);
          break;
      }
    }
    return out;
  }

  /**
   * Set (upsert) the explicit access boundary for a ticket↔repo link. P0 authz:
   * only human/admin may call this on the public surface.
   */
  setTicketRepoAccess(raw: unknown, actor: Actor): TicketRepoAccessResult {
    if (actor.type !== "human" && actor.type !== "admin") {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        "Only a human or admin may set a ticket's repo access boundary.",
        { actor_type: actor.type },
      );
    }
    return this.applyTicketRepoAccess(raw, actor);
  }

  /**
   * Unguarded core of setTicketRepoAccess. Trusted internal callers (epic
   * creation) use this to seed a repo link.
   */
  applyTicketRepoAccess(raw: unknown, actor: Actor): TicketRepoAccessResult {
    const input = setTicketRepoAccessInput.parse(raw);
    if (input.relation === "implicit_single_repo") {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "The 'implicit_single_repo' relation is set via mono_fallback, not manually.",
        { relation: input.relation },
      );
    }
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(input.ticket_id);
      const repo = this.repos.findById(input.repo_id) ?? this.repos.findByName(input.repo_id);
      if (!repo) throw notFound("repository", input.repo_id);
      const now = this.clock.now();
      this.repos.upsertAccess(
        {
          ticketId: ticket.id,
          repoId: repo.id,
          access: input.access,
          relation: input.relation,
          source: input.source,
          confidence: input.confidence ?? null,
          reasons: input.reasons ? JSON.stringify(input.reasons) : null,
        },
        now,
      );
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.repo_access_set",
        payload: {
          repo_id: repo.id,
          access: input.access,
          relation: input.relation,
          source: input.source,
        },
      });
      return {
        ticketId: ticket.id,
        repoId: repo.id,
        access: input.access,
        relation: input.relation,
        eventId,
      };
    });
  }

  /**
   * Mono-fallback (WG-002): when a ticket's ONLY repo is unmapped, promote that
   * single repo to a confirmed write boundary with source='mono_fallback'.
   */
  applyMonoFallback(
    ticketRef: string,
    actor: Actor,
  ): { applied: boolean; ticketId: string; repoId?: string; reason?: string } {
    return inTransaction(this.db, () => {
      const ticket = this.resolveTicket(ticketRef);
      const links = this.repos.accessLinksForTicket(ticket.id);
      if (links.length !== 1) {
        return {
          applied: false,
          ticketId: ticket.id,
          reason: `mono_fallback requires exactly one repo (found ${links.length}).`,
        };
      }
      const only = links[0]!;
      if (this.scopeRepos.scopesForRepo(only.id).length > 0) {
        return {
          applied: false,
          ticketId: ticket.id,
          reason: "the single repo is mapped into the scope graph; mono_fallback does not apply.",
        };
      }
      const now = this.clock.now();
      this.repos.upsertAccess(
        {
          ticketId: ticket.id,
          repoId: only.id,
          access: "write",
          relation: "implicit_single_repo",
          source: "mono_fallback",
          confidence: null,
          reasons: JSON.stringify(["single unmapped repo promoted to write via mono_fallback"]),
        },
        now,
      );
      const eventId = writeEvent(this.db, {
        entity_type: "ticket",
        entity_id: ticket.id,
        actor,
        event_type: "ticket.repo_access_set",
        payload: {
          repo_id: only.id,
          access: "write",
          relation: "implicit_single_repo",
          source: "mono_fallback",
        },
      });
      return { applied: true, ticketId: ticket.id, repoId: only.id, eventId } as {
        applied: boolean;
        ticketId: string;
        repoId?: string;
      };
    });
  }

  // --- Scope→repo suggestions (FG-005) -------------------------------------

  suggestReposForTicket(raw: unknown, _actor: Actor): RepoSuggestion[] {
    const input = suggestReposInput.parse(raw);

    const ticketRef =
      (raw as { ticketId?: unknown; ticket_id?: unknown })?.ticketId ??
      (raw as { ticket_id?: unknown })?.ticket_id;
    if (typeof ticketRef === "string" && ticketRef.length > 0) {
      return this.suggestForExistingTicket(ticketRef);
    }

    const fields: SuggestByFields = {
      title: input.title,
      description: input.description,
      scopeNodeIds: input.scopeNodeIds,
    };
    return this.suggestions.suggest(fields, input.repoIds ?? []);
  }

  private suggestForExistingTicket(ticketRef: string): RepoSuggestion[] {
    const ticket = this.resolveTicket(ticketRef);
    const scopeNodeIds = this.ticketScopes
      .listForTicket(ticket.id)
      .filter((s) => s.relation !== "rejected" && s.relation !== "implicit_repo")
      .map((s) => s.id);
    const selectedRepoIds = this.repos.listForTicket(ticket.id).map((r) => r.id);
    return this.suggestions.suggest(
      {
        title: ticket.title,
        description: ticket.description,
        scopeNodeIds,
      },
      selectedRepoIds,
    );
  }

  // --- Internal helpers ----------------------------------------------------

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
