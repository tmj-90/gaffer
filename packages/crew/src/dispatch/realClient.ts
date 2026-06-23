import { CrewError } from "../util/errors.js";
import type {
  ClaimResult,
  CreateEpicResult,
  DecisionRequestResult,
  DeliveryArtifactResult,
  ReadyTicket,
  RecordEvidenceResult,
  RepoDeliveryResult,
  RepoDeliveryStatus,
  RepoRef,
  RepoRegistrationResult,
  ScopeNodeSummary,
  TicketBundle,
  WorkPacket,
  WorkScopeNode,
  DispatchClient,
} from "./client.js";

/**
 * Structural shape of the Dispatch facade we depend on. We deliberately do NOT
 * import the `dispatch` package types — Dispatch is being built in parallel and
 * its facade may not yet expose every method below. Typing the facade
 * structurally (and loading it lazily) keeps Crew's typecheck and its
 * Fake-backed tests green regardless of Dispatch's in-flight state.
 */
// Exported so tests (and other callers) can name the structural shape when
// passing a concrete `Dispatch`. A real Dispatch returns interface types like
// `Ticket[]` which are structurally compatible at runtime but don't satisfy the
// `Record<string, unknown>` return shapes under strict variance — callers cast
// at the boundary.
export interface DispatchFacade {
  list?(status?: string): Array<Record<string, unknown>>;
  view?(ref: string): {
    ticket: Record<string, unknown>;
    acceptanceCriteria: Array<Record<string, unknown>>;
    repositories: Array<Record<string, unknown>>;
    /** WG-001 ticket↔scope links joined to the scope node (FG-006). */
    scopes?: Array<Record<string, unknown>>;
  };
  /** WG-002 partitioned execution boundary (FG-006). */
  workPacketRepos?(ref: string): {
    writeRepos?: Array<Record<string, unknown>>;
    readOnlyRepos?: Array<Record<string, unknown>>;
    testRepos?: Array<Record<string, unknown>>;
  };
  /** WG-001 compact scope summary (FG-006); primary + counts only. */
  ticketScopeSummary?(ref: string): {
    primary?: { id?: string; name?: string; type?: string } | null;
  };
  registerAgent?(input: unknown, actor?: unknown): { agentId?: string; id?: string };
  /** FG-001 scope graph: list nodes a repo can be attached to during onboarding. */
  listScopeNodes?(actor?: unknown): Array<Record<string, unknown>>;
  /**
   * FG-003 repo onboarding: register/upsert a repo into Dispatch's repository
   * registry. Mirrors `Dispatch.registerRepository(registerRepoInput, actor)`
   * (dispatch core.ts) — the input has NO scope fields, so scope attachment is a
   * SEPARATE step via {@link linkScopeRepo}. Returns the `Repository` row.
   */
  registerRepository?(
    input: unknown,
    actor?: unknown,
  ): {
    id?: string;
    [key: string]: unknown;
  };
  /**
   * FG-002 scope↔repo link: attach a registered repo to a scope node. Mirrors
   * `Dispatch.linkScopeRepo(linkScopeRepoInput, actor)` — input is
   * `{ scope_node_id, repo_id, relation, default_access }`. Returns the link row.
   */
  linkScopeRepo?(
    input: unknown,
    actor?: unknown,
  ): {
    id?: string;
    [key: string]: unknown;
  };
  claimNextTicket?(
    input: unknown,
    actor?: unknown,
  ): {
    ticketId?: string;
    ticket?: { id?: string; number?: number };
    number?: number;
    claimToken?: string;
  } | null;
  claimTicket?(
    input: unknown,
    actor?: unknown,
  ): {
    ticketId?: string;
    ticket?: { id?: string; number?: number };
    number?: number;
    claimToken?: string;
  } | null;
  /**
   * Ticket #9: raise a decision for a human to answer. Mirrors Dispatch's
   * `createDecision({ title, question, severity, ticketId }, actor)` → decision row.
   */
  createDecision?(
    input: unknown,
    actor?: unknown,
  ): {
    id?: string;
    title?: string;
    question?: string;
    severity?: string;
    status?: string;
  };
  heartbeat?(claimToken: string): void;
  recordEvidence?(input: unknown, actor?: unknown): { evidenceId?: string; eventId?: string };
  recordDeliveryArtifact?(
    input: unknown,
    actor?: unknown,
  ): {
    ticketId?: string;
    branchName?: string | null;
    prUrl?: string | null;
    eventId?: string;
  };
  /** WG-005 per-repo delivery (FG-009). Returns the delivery row + event id. */
  recordRepoDelivery?(
    input: unknown,
    actor?: unknown,
  ): {
    delivery?: {
      ticket_id?: string;
      repo_id?: string;
      branch_name?: string | null;
      pr_url?: string | null;
      status?: string;
    };
    eventId?: string;
  };
  submitForReview?(input: unknown, actor?: unknown): { status?: string; eventId?: string };
  markBlocked?(input: unknown, actor?: unknown): { eventId?: string };
  createDraftTicket?(input: unknown, actor?: unknown): { ticketId?: string; number?: number };
  createTicket?(input: unknown, actor?: unknown): { id?: string; number?: number };
  /** WG epic creation: file an epic + its tickets from a decomposed plan. */
  createEpic?(
    input: unknown,
    actor?: unknown,
  ): {
    epicId?: string;
    id?: string;
    epic?: { id?: string };
    ticketIds?: string[];
    tickets?: Array<{ id?: string; ticketId?: string }>;
  };
  markReady?(ref: string, actor?: unknown): unknown;
  db?: { close(): void };
}

type Actor = { type: string; id: string };

const GAFFER_ACTOR: Actor = { type: "system", id: "crew" };

/** Statuses after which a finding's ticket no longer suppresses a re-draft. */
const TERMINAL_TICKET_STATUSES: ReadonlySet<string> = new Set(["done", "closed", "cancelled"]);

/**
 * Map Crew's looser evidence vocabulary onto Dispatch's strict
 * `evidence_type` enum. Crew runtimes shouldn't have to know Dispatch's
 * exact terms; the boundary adapter translates. Unknown values pass through and
 * are validated (and rejected) by Dispatch.
 */
const EVIDENCE_TYPE_ALIASES: Readonly<Record<string, string>> = {
  note: "manual_note",
  manual: "manual_note",
  test: "test_output",
  tests: "test_output",
  coverage: "coverage_report",
  pr: "pull_request",
  diff: "diff_summary",
};

function normalizeEvidenceType(type: string): string {
  return EVIDENCE_TYPE_ALIASES[type] ?? type;
}

/** Parse a JSON-string array of strings (lore_tags_json / tags_json) defensively. */
function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Render the first human-readable reason from a ticket↔repo / ticket↔scope link's
 * `reasons_json` (a JSON array of {reason}|string) into a one-line string, or null.
 */
function firstReason(value: unknown): string | null {
  const reasons = (() => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || value.trim() === "") return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  for (const r of reasons) {
    if (typeof r === "string" && r.trim()) return r.trim();
    if (r && typeof r === "object" && typeof (r as { reason?: unknown }).reason === "string") {
      return (r as { reason: string }).reason;
    }
  }
  return null;
}

/**
 * Does a ticket list-row reference the named repo? Dispatch's list shape is
 * not contractually fixed here, so probe the common carriers defensively:
 * a `repositories`/`repos` array of `{name}` (or bare strings), or a flat
 * `repo_name`/`repoName` field.
 */
function rowReferencesRepo(row: Record<string, unknown>, repoName: string): boolean {
  const flat = row.repo_name ?? row.repoName;
  if (typeof flat === "string" && flat === repoName) return true;
  for (const key of ["repositories", "repos"]) {
    const value = row[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry === repoName) return true;
      if (entry && typeof entry === "object" && (entry as { name?: unknown }).name === repoName) {
        return true;
      }
    }
  }
  return false;
}

/** Map a Dispatch TicketScopeWithNode row onto a Crew WorkScopeNode. */
function toScopeNode(row: Record<string, unknown>): WorkScopeNode {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    type: String(row.type ?? ""),
    loreTags: parseStringArray(row.lore_tags_json ?? row.loreTags),
  };
}

/** Map a Dispatch TicketRepoLink row onto a Crew RepoRef (with reason). */
function toRepoRef(row: Record<string, unknown>): RepoRef {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    path: (row.local_path as string | null) ?? (row.path as string | null) ?? null,
    reason: firstReason(row.reasons_json ?? row.reasons),
  };
}

function required<T>(value: T | undefined | null, method: string): T {
  if (value === undefined || value === null) {
    throw new CrewError(
      "DISPATCH_METHOD_UNAVAILABLE",
      `Dispatch facade does not expose '${method}' yet. Crew is wired against the DispatchClient interface; use FakeDispatchClient until the real facade catches up.`,
      { method },
    );
  }
  return value;
}

/**
 * Thin adapter mapping the Crew `DispatchClient` interface onto the
 * `dispatch` package facade. Construct via `RealDispatchClient.open` which
 * lazily imports the package — if Dispatch's dist is missing or a method is not
 * yet implemented, the failure is surfaced as a structured CrewError at
 * the call site rather than crashing module load.
 */
export class RealDispatchClient implements DispatchClient {
  private constructor(private readonly facade: DispatchFacade) {}

  /**
   * Lazily import the `dispatch` package and open a facade against `dbPath`.
   * Kept async + dynamic so a mid-change Dispatch never breaks Crew's
   * module graph or typecheck.
   */
  static async open(dbPath: string): Promise<RealDispatchClient> {
    let mod: { Dispatch?: { open(path: string): DispatchFacade } };
    try {
      // Dynamic import so a missing/half-built `dispatch` dist fails here,
      // lazily and with context, instead of at Crew module load. The
      // specifier is computed (not a string literal) so bundlers/test runners do
      // not try to statically resolve a package that has no dist yet, and
      // `@vite-ignore` keeps Vite from analysing it.
      const specifier = ["dis", "patch"].join("");
      mod = (await import(/* @vite-ignore */ specifier)) as typeof mod;
    } catch (cause) {
      throw new CrewError(
        "DISPATCH_UNAVAILABLE",
        "Could not load the 'dispatch' package. It may be mid-build (no dist). Use FakeDispatchClient for tests.",
        { cause: cause instanceof Error ? cause.message : String(cause) },
      );
    }
    const Dispatch = required(mod.Dispatch, "Dispatch");
    return new RealDispatchClient(Dispatch.open(dbPath));
  }

  /** Wrap an already-constructed facade (e.g. a shared Dispatch instance). */
  static fromFacade(facade: DispatchFacade): RealDispatchClient {
    return new RealDispatchClient(facade);
  }

  listReady(): ReadyTicket[] {
    const list = required(this.facade.list, "list");
    const rows = list.call(this.facade, "ready");
    return rows.map((row) => ({
      ticketId: String(row.id),
      number: Number(row.number),
      title: String(row.title ?? ""),
      policyPack: String(row.policy_pack ?? row.policyPack ?? ""),
      riskLevel: String(row.risk_level ?? row.riskLevel ?? ""),
    }));
  }

  countDeliveredTickets(repoName: string): number {
    // Prefer a scoped `list("done")`; fall back to the full backlog filtered by
    // status. Repo association is matched defensively across the row shapes
    // Dispatch may use (`repositories: [{name}]`, `repos: [...]`, `repo_name`).
    const list = required(this.facade.list, "list");
    const rows = list.call(this.facade, "done");
    return rows.filter(
      (row) => String(row.status ?? "done") === "done" && rowReferencesRepo(row, repoName),
    ).length;
  }

  claimNextTicket(p: {
    agentId: string;
    ttlSeconds: number;
    capabilities?: string[];
  }): ClaimResult | null {
    const claim = required(this.facade.claimNextTicket, "claimNextTicket");
    const res = claim.call(
      this.facade,
      { agentId: p.agentId, ttlSeconds: p.ttlSeconds, capabilities: p.capabilities },
      GAFFER_ACTOR,
    );
    if (!res) return null;
    const ticketId = res.ticketId ?? res.ticket?.id;
    const number = res.number ?? res.ticket?.number;
    return {
      ticketId: String(required(ticketId, "claimNextTicket.ticketId")),
      number: Number(required(number, "claimNextTicket.number")),
      claimToken: String(required(res.claimToken, "claimNextTicket.claimToken")),
    };
  }

  claimTicket(p: {
    ticketId: string;
    agentId: string;
    ttlSeconds: number;
    capabilities?: string[];
  }): ClaimResult | null {
    const claim = required(this.facade.claimTicket, "claimTicket");
    // Dispatch's facade throws a structured TICKET_NOT_CLAIMABLE/NOT_FOUND when
    // the chosen ticket can't be claimed; the DispatchClient contract reports
    // that as `null` (mirroring claimNextTicket), so translate the throw.
    let res;
    try {
      res = claim.call(
        this.facade,
        {
          ticket_id: p.ticketId,
          agent_id: p.agentId,
          ttl_seconds: p.ttlSeconds,
          ...(p.capabilities ? { capabilities: p.capabilities } : {}),
        },
        GAFFER_ACTOR,
      );
    } catch {
      return null;
    }
    if (!res) return null;
    const ticketId = res.ticketId ?? res.ticket?.id;
    const number = res.number ?? res.ticket?.number;
    return {
      ticketId: String(required(ticketId, "claimTicket.ticketId")),
      number: Number(required(number, "claimTicket.number")),
      claimToken: String(required(res.claimToken, "claimTicket.claimToken")),
    };
  }

  requestDecision(p: {
    title: string;
    question: string;
    severity?: string;
    ticketId?: string;
  }): DecisionRequestResult {
    const create = required(this.facade.createDecision, "createDecision");
    const severity = p.severity ?? "human_required";
    const res = create.call(
      this.facade,
      {
        title: p.title,
        question: p.question,
        severity,
        ...(p.ticketId ? { ticketId: p.ticketId } : {}),
      },
      GAFFER_ACTOR,
    );
    return {
      decisionId: String(required(res.id, "createDecision.id")),
      title: String(res.title ?? p.title),
      question: String(res.question ?? p.question),
      severity: String(res.severity ?? severity),
      status: String(res.status ?? ""),
    };
  }

  heartbeat(claimToken: string): void {
    const heartbeat = required(this.facade.heartbeat, "heartbeat");
    heartbeat.call(this.facade, claimToken);
  }

  getTicket(ref: string): TicketBundle {
    const view = required(this.facade.view, "view");
    const v = view.call(this.facade, ref);
    const t = v.ticket;
    return {
      ticket: {
        id: String(t.id),
        number: Number(t.number),
        title: String(t.title ?? ""),
        description: String(t.description ?? ""),
        status: String(t.status ?? ""),
        policyPack: String(t.policy_pack ?? ""),
        riskLevel: String(t.risk_level ?? ""),
        branchName: (t.branch_name as string | null) ?? null,
      },
      acceptanceCriteria: v.acceptanceCriteria.map((ac) => ({
        id: String(ac.id),
        text: String(ac.text ?? ""),
        status: String(ac.status ?? ""),
      })),
      repositories: v.repositories.map((r) => ({
        id: String(r.id),
        name: String(r.name ?? ""),
        localPath: (r.local_path as string | null) ?? null,
        defaultBranch: String(r.default_branch ?? "main"),
        role: String(r.role ?? "primary"),
        testCommand: (r.test_command as string | null) ?? null,
      })),
    };
  }

  getWorkPacket(ticketId: string): WorkPacket {
    // Scope nodes come from the ticket view's `scopes` (primary/secondary links
    // joined to the node, carrying lore_tags). The compact `scope_summary` only
    // exposes the primary, so the view is the richer source for secondaries.
    const view = required(this.facade.view, "view");
    const v = view.call(this.facade, ticketId);
    const scopeRows = v.scopes ?? [];
    let primary: WorkScopeNode | undefined;
    const secondary: WorkScopeNode[] = [];
    for (const row of scopeRows) {
      const relation = String(row.relation ?? "");
      // `implicit_repo` is the mono-fallback scope; treat it as primary when no
      // explicit primary exists so single-repo tickets still surface a scope.
      if (relation === "primary" || (relation === "implicit_repo" && !primary)) {
        primary = toScopeNode(row);
      } else if (relation === "secondary") {
        secondary.push(toScopeNode(row));
      }
    }

    // Repo buckets come from the WG-002 partitioned boundary.
    const packetRepos = this.facade.workPacketRepos;
    const repos = packetRepos ? packetRepos.call(this.facade, ticketId) : undefined;
    const writeRepos = (repos?.writeRepos ?? []).map(toRepoRef);
    const readOnlyRepos = (repos?.readOnlyRepos ?? []).map(toRepoRef);
    const testRepos = (repos?.testRepos ?? []).map(toRepoRef);

    // Mono-fallback: no scope graph AND no partitioned boundary → fall back to
    // the ticket's plain repositories as write targets so single-repo execution
    // still works (parity with the Fake).
    if (writeRepos.length === 0 && readOnlyRepos.length === 0 && testRepos.length === 0) {
      for (const r of v.repositories) {
        writeRepos.push({
          id: String(r.id),
          name: String(r.name ?? ""),
          path: (r.local_path as string | null) ?? null,
          reason: "Ticket's repository (no scope-graph mapping; single-repo fallback).",
        });
      }
    }

    return {
      scopes: { ...(primary ? { primary } : {}), secondary },
      writeRepos,
      readOnlyRepos,
      testRepos,
    };
  }

  recordEvidence(p: {
    claimToken: string;
    ticketId: string;
    acId?: string;
    evidenceType: string;
    summary: string;
    uri?: string;
    payload?: unknown;
  }): RecordEvidenceResult {
    const record = required(this.facade.recordEvidence, "recordEvidence");
    const res = record.call(
      this.facade,
      {
        claimToken: p.claimToken,
        ticket_id: p.ticketId,
        ac_id: p.acId,
        evidence_type: normalizeEvidenceType(p.evidenceType),
        summary: p.summary,
        uri: p.uri,
        payload: p.payload,
      },
      GAFFER_ACTOR,
    );
    return {
      evidenceId: String(required(res.evidenceId, "recordEvidence.evidenceId")),
      eventId: String(required(res.eventId, "recordEvidence.eventId")),
    };
  }

  recordDeliveryArtifact(p: {
    claimToken?: string;
    ticketId: string;
    branchName?: string | null;
    prUrl?: string | null;
    commit?: string;
    diffSummary?: string;
  }): DeliveryArtifactResult {
    const record = required(this.facade.recordDeliveryArtifact, "recordDeliveryArtifact");
    const res = record.call(
      this.facade,
      {
        claim_token: p.claimToken,
        ticket_id: p.ticketId,
        branch_name: p.branchName,
        pr_url: p.prUrl,
        commit: p.commit,
        diff_summary: p.diffSummary,
      },
      GAFFER_ACTOR,
    );
    return {
      ticketId: String(required(res.ticketId, "recordDeliveryArtifact.ticketId")),
      branchName: (res.branchName as string | null) ?? null,
      prUrl: (res.prUrl as string | null) ?? null,
      eventId: String(required(res.eventId, "recordDeliveryArtifact.eventId")),
    };
  }

  recordRepoDelivery(p: {
    ticketId: string;
    repoId: string;
    branchName?: string | null;
    commitSha?: string | null;
    prUrl?: string | null;
    status?: RepoDeliveryStatus;
    evidenceRef?: string;
  }): RepoDeliveryResult {
    const record = required(this.facade.recordRepoDelivery, "recordRepoDelivery");
    const res = record.call(
      this.facade,
      {
        ticket_id: p.ticketId,
        repo_id: p.repoId,
        ...(p.branchName != null ? { branch_name: p.branchName } : {}),
        ...(p.commitSha != null ? { commit_sha: p.commitSha } : {}),
        ...(p.prUrl != null ? { pr_url: p.prUrl } : {}),
        ...(p.status ? { status: p.status } : {}),
        ...(p.evidenceRef ? { evidence_ref: p.evidenceRef } : {}),
      },
      GAFFER_ACTOR,
    );
    const delivery = res.delivery ?? {};
    return {
      ticketId: String(required(delivery.ticket_id ?? p.ticketId, "recordRepoDelivery.ticketId")),
      repoId: String(required(delivery.repo_id ?? p.repoId, "recordRepoDelivery.repoId")),
      branchName: (delivery.branch_name as string | null) ?? null,
      prUrl: (delivery.pr_url as string | null) ?? null,
      status: (delivery.status as RepoDeliveryStatus) ?? p.status ?? "branch_created",
      eventId: String(required(res.eventId, "recordRepoDelivery.eventId")),
    };
  }

  submitForReview(p: { claimToken: string; ticketId: string; reason?: string }): {
    status: string;
    eventId: string;
  } {
    const submit = required(this.facade.submitForReview, "submitForReview");
    const res = submit.call(
      this.facade,
      { claimToken: p.claimToken, ticket_id: p.ticketId, reason: p.reason },
      GAFFER_ACTOR,
    );
    return {
      status: String(res.status ?? "in_review"),
      eventId: String(required(res.eventId, "submitForReview.eventId")),
    };
  }

  markBlocked(p: { claimToken: string; ticketId: string; reason: string }): { eventId: string } {
    const block = required(this.facade.markBlocked, "markBlocked");
    const res = block.call(
      this.facade,
      { claimToken: p.claimToken, ticket_id: p.ticketId, reason: p.reason },
      GAFFER_ACTOR,
    );
    return { eventId: String(required(res.eventId, "markBlocked.eventId")) };
  }

  createDraftTicket(p: {
    title: string;
    description?: string;
    repoName?: string;
    evidenceSummary?: string;
    findingKey?: string;
    policyPack?: string;
  }): { ticketId: string; number: number } {
    // Stamp the stable de-dup marker into the description so later ticks find
    // the existing open ticket via findOpenTicketByFindingKey.
    const description = p.findingKey
      ? `${p.description ?? ""}\n\nFinding-Key: ${p.findingKey}`
      : (p.description ?? "");
    // Operator's configured policy pack threads through; default to solo_loose
    // when unset so behaviour matches the schema default.
    const policyPack = p.policyPack ?? "solo_loose";
    // Prefer a dedicated facade method; fall back to createTicket if present.
    if (this.facade.createDraftTicket) {
      const res = this.facade.createDraftTicket.call(
        this.facade,
        { ...p, description, policy_pack: policyPack },
        GAFFER_ACTOR,
      );
      return {
        ticketId: String(required(res.ticketId, "createDraftTicket.ticketId")),
        number: Number(required(res.number, "createDraftTicket.number")),
      };
    }
    const create = required(this.facade.createTicket, "createDraftTicket");
    const res = create.call(
      this.facade,
      { title: p.title, description, policy_pack: policyPack },
      GAFFER_ACTOR,
    );
    return {
      ticketId: String(required(res.id, "createTicket.id")),
      number: Number(required(res.number, "createTicket.number")),
    };
  }

  findTicketBySource(sourceUrl: string): { ticketId: string } | undefined {
    // Query existing tickets and match the `Source: <url>` marker ingest writes
    // into the description. `list()` with no status returns the full backlog;
    // matching here keeps dedup independent of any external relabel side effect.
    const list = required(this.facade.list, "list");
    const needle = `Source: ${sourceUrl}`;
    const rows = list.call(this.facade);
    const match = rows.find((row) => String(row.description ?? "").includes(needle));
    return match ? { ticketId: String(match.id) } : undefined;
  }

  findOpenTicketByFindingKey(findingKey: string): { ticketId: string } | undefined {
    // Match the `Finding-Key: <key>` marker an idle loop stamps into the draft,
    // ignoring tickets that have reached a terminal state so a resurfacing
    // finding whose prior ticket was resolved can be re-drafted.
    const list = required(this.facade.list, "list");
    const needle = `Finding-Key: ${findingKey}`;
    const rows = list.call(this.facade);
    const match = rows.find(
      (row) =>
        !TERMINAL_TICKET_STATUSES.has(String(row.status ?? "")) &&
        String(row.description ?? "").includes(needle),
    );
    return match ? { ticketId: String(match.id) } : undefined;
  }

  markTicketReady(ticketId: string): void {
    const markReady = required(this.facade.markReady, "markReady");
    markReady.call(this.facade, ticketId, GAFFER_ACTOR);
  }

  createEpic(p: {
    name: string;
    description?: string;
    tickets: Array<{
      title: string;
      description?: string;
      acceptanceCriteria?: string[];
      priority?: number;
      repoName?: string;
      dependsOn?: number[];
    }>;
    ready: boolean;
    findingKey?: string;
    policyPack?: string;
  }): CreateEpicResult {
    const create = required(this.facade.createEpic, "createEpic");
    const tickets = p.tickets.map((t, index) => ({
      title: t.title,
      // Stamp the de-dup marker on the first ticket so a re-run maps to this epic.
      description:
        index === 0 && p.findingKey
          ? `${t.description ?? ""}\n\nFinding-Key: ${p.findingKey}`
          : (t.description ?? ""),
      acceptance_criteria: t.acceptanceCriteria ?? [],
      ...(t.priority !== undefined ? { priority: t.priority } : {}),
      ...(t.repoName ? { repo: t.repoName } : {}),
      depends_on: t.dependsOn ?? [],
    }));
    const res = create.call(
      this.facade,
      {
        epic: { name: p.name, description: p.description ?? "" },
        tickets,
        ready: p.ready,
        policy_pack: p.policyPack ?? "solo_loose",
      },
      GAFFER_ACTOR,
    );
    const epicId = res.epicId ?? res.id ?? res.epic?.id;
    const ticketIds =
      res.ticketIds ?? (res.tickets ?? []).map((t) => String(t.id ?? t.ticketId ?? ""));
    return {
      epicId: String(required(epicId, "createEpic.epicId")),
      ticketIds: ticketIds.filter((id) => id !== ""),
      ready: p.ready,
    };
  }

  listScopeNodes(): ScopeNodeSummary[] {
    // Degrade to no nodes when the facade has no scope graph yet — onboarding
    // then offers only "unmapped"/"standalone" (parity with a graph-less factory).
    if (!this.facade.listScopeNodes) return [];
    const rows = this.facade.listScopeNodes.call(this.facade, GAFFER_ACTOR);
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ""),
      type: String(row.type ?? ""),
      loreTags: parseStringArray(row.lore_tags_json ?? row.loreTags),
    }));
  }

  registerRepo(p: {
    repoId: string;
    name: string;
    localPath: string;
    remoteUrl?: string | null;
    defaultBranch?: string | null;
    stack?: string | null;
    testCommand?: string | null;
    scopeNodeIds?: string[];
    relation?: string;
    defaultAccess?: string;
  }): RepoRegistrationResult | null {
    // Null (not a throw) when the facade can't register repos yet, so onboarding
    // proceeds with the local context store + Crew registry alone.
    if (!this.facade.registerRepository) return null;

    // Step 1 — register the repo. Dispatch's `registerRepoInput` has NO scope
    // fields, so map only the repo attributes; the result is a `Repository`
    // whose `id` is the canonical repoId for the subsequent scope links.
    const repo = this.facade.registerRepository.call(
      this.facade,
      {
        name: p.name,
        local_path: p.localPath,
        ...(p.remoteUrl != null ? { remote_url: p.remoteUrl } : {}),
        default_branch: p.defaultBranch ?? "main",
        ...(p.stack != null ? { stack: p.stack } : {}),
        ...(p.testCommand != null ? { test_command: p.testCommand } : {}),
      },
      GAFFER_ACTOR,
    );
    const repoId = String(required(repo.id, "registerRepository.id"));

    // Step 2 — scope attachment is a SEPARATE call per scope node id (FG-002).
    // Only mapped onboarding supplies ids; unmapped/standalone attach nothing.
    const scopeNodeIds = p.scopeNodeIds ?? [];
    const attachedScopeIds: string[] = [];
    if (scopeNodeIds.length > 0 && this.facade.linkScopeRepo) {
      for (const scopeNodeId of scopeNodeIds) {
        this.facade.linkScopeRepo.call(
          this.facade,
          {
            scope_node_id: scopeNodeId,
            repo_id: repoId,
            ...(p.relation ? { relation: p.relation } : {}),
            ...(p.defaultAccess ? { default_access: p.defaultAccess } : {}),
          },
          GAFFER_ACTOR,
        );
        attachedScopeIds.push(scopeNodeId);
      }
    }

    return { repoId, attachedScopeIds };
  }

  registerAgent(p: { displayName?: string; capabilities?: string[]; maxRisk?: string }): {
    agentId: string;
  } {
    const register = required(this.facade.registerAgent, "registerAgent");
    const res = register.call(
      this.facade,
      { display_name: p.displayName, max_risk: p.maxRisk, capabilities: p.capabilities },
      GAFFER_ACTOR,
    );
    return { agentId: String(required(res.agentId ?? res.id, "registerAgent.agentId")) };
  }
}
