/**
 * ACCESS SCOPES: the one evaluation every scoped credential goes through.
 *
 * Three holders narrow what a caller may touch, and all three ask this module:
 *   - a named principal minted with `--repo` / `--ticket` (REST and the CLI);
 *   - the CLI acting as a principal (`GAFFER_PRINCIPAL_TOKEN` / `--as-principal`);
 *   - the factory MCP mount, whose ticket scope is what the runner bound it to
 *     (GAFFER_CLAIM_TOKEN / GAFFER_SCOPE_TICKET / GAFFER_REVIEW_TICKET, plus the
 *     drafts the same server created).
 *
 * A scope has two axes. `tickets` grants named tickets outright. `repos` grants
 * every ticket whose repositories all sit inside it: a ticket's repositories here
 * are its confirmed WRITE repos (what a delivery would change), or every linked
 * repo when it has no write repo yet. A ticket with no repository at all is
 * reachable only through the ticket axis. An axis left undefined grants nothing on
 * its own; a scope with neither axis is unscoped (today's behaviour).
 *
 * The read rule is the write rule: a scoped holder sees exactly the tickets it may
 * change. That keeps one truth, and it means a scoped dashboard never shows a card
 * whose buttons would all be refused.
 *
 * Everything here is pure (no database, no environment) so every combination is
 * unit-tested in one place (test/access-scope.test.ts).
 */

/** What a scoped holder may reach. Ids, not names: repos and tickets resolve once. */
export interface AccessScope {
  /** Repository ids. Undefined: no repo grant. */
  readonly repos?: readonly string[] | undefined;
  /** Ticket ids. Undefined: no ticket grant. */
  readonly tickets?: readonly string[] | undefined;
}

/** A ticket as the evaluation needs it. */
export interface ScopeTicket {
  readonly id: string;
  readonly number?: number | null | undefined;
  /** The repo ids the scope is judged on (write repos, else every linked repo). */
  readonly repos: readonly string[];
}

/** True when the scope narrows anything (either axis is set). */
export function isScoped(scope: AccessScope | null | undefined): scope is AccessScope {
  return Boolean(scope && (scope.repos !== undefined || scope.tickets !== undefined));
}

export type ScopeDenialReason =
  "outside_ticket_scope" | "outside_repo_scope" | "no_repos" | "factory_wide" | "admin_required";

export type ScopeDecision =
  | { readonly allowed: true; readonly via: "unscoped" | "ticket" | "repo" }
  | {
      readonly allowed: false;
      readonly reason: ScopeDenialReason;
      /** Repo ids outside the repo scope (repo decisions only). */
      readonly outsideRepos: readonly string[];
    };

/**
 * May a scoped holder reach this ticket? THE function: REST, the CLI and the factory
 * MCP scope all decide ticket access here.
 */
export function evaluateTicketScope(
  scope: AccessScope | null | undefined,
  ticket: ScopeTicket,
): ScopeDecision {
  if (!isScoped(scope)) return { allowed: true, via: "unscoped" };
  if (scope.tickets?.includes(ticket.id)) return { allowed: true, via: "ticket" };
  if (scope.repos === undefined) {
    return { allowed: false, reason: "outside_ticket_scope", outsideRepos: [] };
  }
  const repoDecision = evaluateRepoScope(scope, ticket.repos);
  if (repoDecision.allowed) return { allowed: true, via: "repo" };
  return repoDecision;
}

/**
 * Do these repositories all sit inside the repo scope? An empty list never does
 * (there is nothing to anchor the grant on). Unscoped: always.
 */
export function evaluateRepoScope(
  scope: AccessScope | null | undefined,
  repoIds: readonly string[],
): ScopeDecision {
  if (!isScoped(scope)) return { allowed: true, via: "unscoped" };
  const granted = scope.repos ?? [];
  if (repoIds.length === 0) return { allowed: false, reason: "no_repos", outsideRepos: [] };
  const outside = [...new Set(repoIds.filter((r) => !granted.includes(r)))];
  if (outside.length > 0) {
    return { allowed: false, reason: "outside_repo_scope", outsideRepos: outside };
  }
  return { allowed: true, via: "repo" };
}

/** Who is asking: the three properties a credential carries. */
export interface Access {
  /** A read-only credential (the read token, a `--read` principal). */
  readonly readOnly: boolean;
  /** An admin identity (the operator's own token, an `--admin` principal, the CLI without a token). */
  readonly admin: boolean;
  /** Null or an empty scope: unscoped. */
  readonly scope: AccessScope | null;
}

/** The operator's own credential: everything (the shared token, auth disabled, a tokenless CLI). */
export const OPERATOR_ACCESS: Access = { readOnly: false, admin: true, scope: null };

/**
 * What the caller wants to do. Every request (REST) and command (CLI) maps to one.
 *   - read_ticket / write_ticket: anything about one ticket.
 *   - create_ticket: a new ticket delivering to these repos.
 *   - write_repo: a repository-level change (register, link, hide, branch, commands,
 *     onboard, a ticket's repo access, settings). `repos` names the repos it touches;
 *     undefined means factory-wide (settings, onboarding a new repo).
 *   - write_factory / read_factory: anything else, which is not about one ticket
 *     (epics, specs, the map, poll for work, runs, cost, the audit tail...).
 */
export type AccessAction =
  | { readonly kind: "read_ticket"; readonly ticket: ScopeTicket }
  | { readonly kind: "write_ticket"; readonly ticket: ScopeTicket }
  | { readonly kind: "create_ticket"; readonly repos: readonly string[] }
  | { readonly kind: "write_repo"; readonly repos?: readonly string[] | undefined }
  | { readonly kind: "write_factory" }
  | { readonly kind: "read_factory" };

export type AccessDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: "READ_ONLY_TOKEN" | "SCOPE_DENIED";
      readonly reason: ScopeDenialReason | "read_only";
      readonly outsideRepos: readonly string[];
    };

const WRITES = new Set<AccessAction["kind"]>([
  "write_ticket",
  "create_ticket",
  "write_repo",
  "write_factory",
]);

/** Is this action a write (refused outright for a read-only credential)? */
export function isWriteAction(action: AccessAction): boolean {
  return WRITES.has(action.kind);
}

/**
 * The whole decision for one action: read-only first (a write by a read credential is
 * READ_ONLY_TOKEN whatever its scope), then admin for repo-level writes, then the scope.
 * Admin does not widen a scope: a scoped admin is still scoped.
 */
export function authorizeAccess(access: Access, action: AccessAction): AccessDecision {
  const deny = (
    reason: ScopeDenialReason,
    outsideRepos: readonly string[] = [],
  ): AccessDecision => ({ allowed: false, code: "SCOPE_DENIED", reason, outsideRepos });
  if (access.readOnly && isWriteAction(action)) {
    return { allowed: false, code: "READ_ONLY_TOKEN", reason: "read_only", outsideRepos: [] };
  }
  const scoped = isScoped(access.scope);
  switch (action.kind) {
    case "read_ticket":
    case "write_ticket": {
      const d = evaluateTicketScope(access.scope, action.ticket);
      return d.allowed ? { allowed: true } : deny(d.reason, d.outsideRepos);
    }
    case "create_ticket": {
      const d = evaluateRepoScope(access.scope, action.repos);
      return d.allowed ? { allowed: true } : deny(d.reason, d.outsideRepos);
    }
    case "write_repo": {
      if (!access.admin) return deny("admin_required");
      if (!scoped) return { allowed: true };
      if (action.repos === undefined) return deny("factory_wide");
      const d = evaluateRepoScope(access.scope, action.repos);
      return d.allowed ? { allowed: true } : deny(d.reason, d.outsideRepos);
    }
    case "write_factory":
    case "read_factory":
      return scoped ? deny("factory_wide") : { allowed: true };
  }
}

/** A sentence for a refusal, naming the scope (repo/ticket labels supplied by the caller). */
export function describeDenial(
  reason: ScopeDenialReason | "read_only",
  labels: { scope: string; ticket?: string | undefined; outsideRepos?: readonly string[] },
): string {
  const t = labels.ticket ?? "this request";
  switch (reason) {
    case "read_only":
      return "This token is read-scoped; mutating routes are not permitted.";
    case "admin_required":
      return "Repository-level changes (registering, linking or hiding a repo, its branch or commands, onboarding, a ticket's repo access, settings) need an admin principal.";
    case "factory_wide":
      return `This credential is scoped to ${labels.scope}; factory-wide reads and changes are outside it.`;
    case "no_repos":
      return `This credential is scoped to ${labels.scope}; ${t} names no repository, so its repo scope cannot cover it.`;
    case "outside_repo_scope":
      return `This credential is scoped to ${labels.scope}; ${t} also touches ${(labels.outsideRepos ?? []).join(", ") || "another repository"}.`;
    case "outside_ticket_scope":
      return `This credential is scoped to ${labels.scope}; ${t} is not one of them.`;
  }
}

/**
 * A dependency on a ticket outside the scope, as a scoped holder sees it: its number
 * and status (the edge is the operator's, and the in-scope ticket waits on it), but not
 * the other ticket's title. `visible` is the holder's ticket filter; null (unscoped)
 * returns the list unchanged.
 */
export function hideOutOfScopeDependencies<
  T extends { depends_on_ticket_id: string; title: string },
>(
  deps: readonly T[],
  visible: ((ticketId: string) => boolean) | null,
): Array<T | (Omit<T, "title"> & { title: null; outside_scope: true })> {
  if (!visible) return [...deps];
  return deps.map((d) =>
    visible(d.depends_on_ticket_id) ? d : { ...d, title: null, outside_scope: true as const },
  );
}
