/**
 * Crew's own boundary onto Dispatch.
 *
 * Crew never imports Dispatch internals — it speaks only through this
 * interface. Two implementations are provided:
 *
 *  - `RealDispatchClient` (src/dispatch/realClient.ts) wraps the published
 *    `dispatch` package facade. It is imported lazily so that a mid-flight
 *    Dispatch build (missing dist, missing facade methods) cannot break
 *    Crew's typecheck or its Fake-backed test suite.
 *  - `FakeDispatchClient` (src/dispatch/fakeClient.ts) is an in-memory
 *    implementation used by every test in this project.
 */

export interface ReadyTicket {
  ticketId: string;
  number: number;
  title: string;
  policyPack: string;
  riskLevel: string;
}

/** Result of creating an epic from a decomposed plan via `create_epic`. */
export interface CreateEpicResult {
  epicId: string;
  /** The created ticket ids, in plan order. */
  ticketIds: string[];
  /** Whether the tickets were filed READY (true) or as DRAFTS (false). */
  ready: boolean;
}

export interface ClaimResult {
  ticketId: string;
  number: number;
  claimToken: string;
}

export interface DeliveryArtifactResult {
  ticketId: string;
  branchName: string | null;
  prUrl: string | null;
  eventId: string;
}

/** A per-repo delivery row's status (mirrors Dispatch's `TicketRepoDeliveryStatus`). */
export type RepoDeliveryStatus =
  | "not_started"
  | "branch_created"
  | "changes_made"
  | "tests_failed"
  | "tests_passed"
  | "pr_opened"
  | "review_ready"
  | "done";

/**
 * Result of recording a single repo's delivery for a ticket (WG-005 / FG-009).
 * A multi-repo ticket records one of these per WRITE repo so each repo carries
 * its own branch/PR/status, rather than a single ticket-level artifact.
 */
export interface RepoDeliveryResult {
  ticketId: string;
  repoId: string;
  branchName: string | null;
  prUrl: string | null;
  status: RepoDeliveryStatus;
  eventId: string;
}

export interface TicketAcceptanceCriterion {
  id: string;
  text: string;
  status: string;
}

export interface TicketRepository {
  id: string;
  name: string;
  localPath: string | null;
  defaultBranch: string;
  role: string;
  testCommand?: string | null;
}

export interface TicketDetail {
  id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  policyPack: string;
  riskLevel: string;
  branchName: string | null;
}

export interface TicketBundle {
  ticket: TicketDetail;
  acceptanceCriteria: TicketAcceptanceCriterion[];
  repositories: TicketRepository[];
}

export interface RecordEvidenceResult {
  evidenceId: string;
  eventId: string;
}

/**
 * A repo reference inside a ticket's work packet (FG-006). Carries enough to
 * resolve the repo root (`id`/`name`/`path`) plus a one-line `reason` explaining
 * why the repo is in scope for this ticket, so the agent — and the context
 * packet — can tell the operator *why* a repo was included.
 */
export interface RepoRef {
  id: string;
  name: string;
  /** Absolute/local checkout path, when Dispatch knows it. */
  path: string | null;
  /** One-line justification for inclusion (from the ticket↔repo link reasons). */
  reason: string | null;
}

/**
 * A scope node a ticket is mapped to (FG-006). `loreTags` are the node's
 * curated Memory tags, used to fetch scope-relevant lore for the packet.
 */
export interface WorkScopeNode {
  id: string;
  name: string;
  type: string;
  loreTags: string[];
}

/**
 * The scope-aware execution boundary for a ticket (FG-006). Mirrors Dispatch's
 * `scope_summary` (primary + secondary scope nodes) and the partitioned
 * `work_repos` block (write vs read-only vs test). A mono-fallback / single
 * unmapped ticket has no `primary` scope and an empty `secondary` list; the
 * packet builder still produces a working single-repo packet from `writeRepos`.
 */
export interface WorkPacket {
  scopes: {
    primary?: WorkScopeNode;
    secondary: WorkScopeNode[];
  };
  /** Repos the agent may WRITE to. */
  writeRepos: RepoRef[];
  /** Repos provided as READ-ONLY context only. */
  readOnlyRepos: RepoRef[];
  /** Repos hosting tests/verification for the ticket. */
  testRepos: RepoRef[];
}

/** A scope node in Dispatch's scope graph (FG-001), for onboarding attachment. */
export interface ScopeNodeSummary {
  id: string;
  name: string;
  type: string;
  loreTags: string[];
}

/** Result of registering / upserting a repo into Dispatch's repository registry. */
export interface RepoRegistrationResult {
  repoId: string;
  /** Scope node ids the repo was attached to (empty for unmapped/standalone). */
  attachedScopeIds: string[];
}

/** Result of raising a decision for a human to answer (Ticket #9). */
export interface DecisionRequestResult {
  decisionId: string;
  title: string;
  question: string;
  severity: string;
  status: string;
}

export interface DispatchClient {
  listReady(): ReadyTicket[];
  /**
   * Count tickets DELIVERED for a repo: tickets in the terminal `done` state
   * that reference the named repo. Used by the idle scan loops' per-repo
   * delivered-ticket gate so a young repo isn't scanned until it has shipped
   * `min_delivered_tickets` worth of real work.
   */
  countDeliveredTickets(repoName: string): number;
  /**
   * List the scope nodes a repo could be attached to during onboarding (FG-003).
   * Returns `[]` when the scope graph is empty or the facade does not expose it
   * yet, so onboarding still works against a graph-less Dispatch.
   */
  listScopeNodes?(): ScopeNodeSummary[];
  /**
   * Register (or upsert) an onboarded repo into Dispatch's repository registry
   * and optionally attach it to scope nodes (FG-003). `scopeNodeIds` empty means
   * unmapped/standalone — the repo is registered but attached to nothing. Idempotent
   * on `repoId`. Returns null when the facade does not support registration yet,
   * so onboarding degrades to the local context store + Crew registry only.
   */
  registerRepo?(p: {
    repoId: string;
    name: string;
    localPath: string;
    remoteUrl?: string | null;
    defaultBranch?: string | null;
    /** Detected stack (e.g. `typescript-react`), persisted onto the Dispatch repo row. */
    stack?: string | null;
    /** Detected test command, persisted onto the Dispatch repo row. */
    testCommand?: string | null;
    scopeNodeIds?: string[];
    relation?: string;
    defaultAccess?: string;
  }): RepoRegistrationResult | null;
  /**
   * Raise a decision for a human to answer (Ticket #9 onboarding clarifying
   * questions). `severity` defaults to `human_required`, which HARD-blocks until
   * the human answers in the UI/CLI — the agent never answers. Maps to
   * Dispatch's `createDecision`.
   */
  requestDecision(p: {
    title: string;
    question: string;
    severity?: string;
    ticketId?: string;
  }): DecisionRequestResult;
  claimNextTicket(p: {
    agentId: string;
    ttlSeconds: number;
    capabilities?: string[];
  }): ClaimResult | null;
  /**
   * Claim a SPECIFIC, pre-selected ticket (by id) rather than whatever
   * `claimNextTicket` happens to surface. Mirrors Dispatch's `claimTicket` and
   * the bash runner's preselect-then-claim flow: the ticket the loop ran its
   * `before_claim` hook against is the exact ticket that gets claimed, so the
   * hook can never evaluate a different ticket than the one worked on. Returns
   * `null` when the chosen ticket is not claimable (already claimed, ineligible).
   */
  claimTicket(p: {
    ticketId: string;
    agentId: string;
    ttlSeconds: number;
    capabilities?: string[];
  }): ClaimResult | null;
  heartbeat(claimToken: string): void;
  getTicket(ref: string): TicketBundle;
  /**
   * Fetch the ticket's scope-aware work packet (FG-006): its primary/secondary
   * scope nodes and its repos partitioned into write / read-only / test. Maps
   * from Dispatch's `scope_summary` + `work_repos` block. A mono-fallback or
   * single unmapped ticket returns no scope nodes and surfaces its repo(s) as
   * `writeRepos`, so single-repo execution still works.
   */
  getWorkPacket(ticketId: string): WorkPacket;
  recordEvidence(p: {
    claimToken: string;
    ticketId: string;
    acId?: string;
    evidenceType: string;
    summary: string;
    uri?: string;
    payload?: unknown;
  }): RecordEvidenceResult;
  /**
   * Record where a ticket was delivered: persist `branchName`/`prUrl` onto the
   * ticket and emit a delivery event. Mirrors Dispatch's `recordDeliveryArtifact`
   * so factory_strict/regulated done-gates that require a branch on the ticket are
   * satisfied, and reviewers can read the branch/PR from Dispatch rather than
   * grepping (parity with the bash runner).
   */
  recordDeliveryArtifact(p: {
    claimToken?: string;
    ticketId: string;
    branchName?: string | null;
    prUrl?: string | null;
    commit?: string;
    diffSummary?: string;
  }): DeliveryArtifactResult;
  /**
   * Record a delivery artifact for ONE write repo of a ticket (WG-005 / FG-009).
   * A mapped multi-repo ticket calls this once per write repo so every repo
   * carries its own branch/PR/status; a single unmapped repo records exactly one.
   * Maps to Dispatch's `recordRepoDelivery` / `record_repo_delivery` facade.
   */
  recordRepoDelivery(p: {
    ticketId: string;
    repoId: string;
    branchName?: string | null;
    commitSha?: string | null;
    prUrl?: string | null;
    status?: RepoDeliveryStatus;
    evidenceRef?: string;
  }): RepoDeliveryResult;
  submitForReview(p: { claimToken: string; ticketId: string; reason?: string }): {
    status: string;
    eventId: string;
  };
  markBlocked(p: { claimToken: string; ticketId: string; reason: string }): { eventId: string };
  createDraftTicket(p: {
    title: string;
    description?: string;
    repoName?: string;
    evidenceSummary?: string;
    /**
     * Stable de-dup marker written into the draft description as
     * `Finding-Key: <key>`. Idle loops pass a loop+repo+finding-signature key so
     * a finding re-discovered on a later tick maps to the SAME open ticket
     * (looked up via {@link findOpenTicketByFindingKey}) instead of spawning a
     * duplicate draft. Must be stable across ticks — never a date stamp.
     */
    findingKey?: string;
    /**
     * Dispatch policy pack to create the draft under (e.g. `solo_loose`,
     * `factory_strict`). Threaded from `config.default_policy_pack`. Omitted →
     * Dispatch's own default (`solo_loose`) applies.
     */
    policyPack?: string;
  }): { ticketId: string; number: number };
  /**
   * Find an existing ticket whose description records the given source URL
   * (written by ingest as `Source: <url>`). This is the source of truth for
   * ingest dedup: it lets creation be idempotent independent of any external
   * relabelling side effect. Returns the matching ticket id, or undefined.
   */
  findTicketBySource(sourceUrl: string): { ticketId: string } | undefined;
  /**
   * Find an OPEN ticket carrying the given stable finding key (written as
   * `Finding-Key: <key>` by {@link createDraftTicket}). Tickets in a terminal
   * state (`done`/`closed`/`cancelled`) are ignored so a re-surfacing finding
   * whose prior ticket was resolved can be re-drafted. This is the source of
   * truth for idle-loop dedup. Returns the matching ticket id, or undefined.
   */
  findOpenTicketByFindingKey(findingKey: string): { ticketId: string } | undefined;
  /** Transition a draft ticket to the `ready` state. */
  markTicketReady(ticketId: string): void;
  /**
   * Create an epic and its tickets from a decomposed plan (Dispatch's
   * `create_epic`). `ready` decides whether the tickets are filed READY (claimable
   * past the human gate) or as DRAFTS awaiting approval — the idle loop maps its
   * configured mode onto this so it NEVER auto-delivers unless explicitly allowed.
   * `findingKey` stamps a stable de-dup marker so a re-run maps to the same epic.
   */
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
    /** File the tickets READY (true) or as DRAFTS awaiting approval (false). */
    ready: boolean;
    findingKey?: string;
    policyPack?: string;
  }): CreateEpicResult;
  registerAgent(p: { displayName?: string; capabilities?: string[]; maxRisk?: string }): {
    agentId: string;
  };
}
