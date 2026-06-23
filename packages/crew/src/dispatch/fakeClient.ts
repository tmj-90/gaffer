import { randomUUID } from "node:crypto";

import { CrewError, notFound } from "../util/errors.js";
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

/** Statuses after which a finding's ticket no longer suppresses a re-draft. */
const TERMINAL_TICKET_STATUSES: ReadonlySet<string> = new Set(["done", "closed", "cancelled"]);

function toScopeNode(seed: FakeSeedScopeNode): WorkScopeNode {
  return {
    id: seed.id ?? randomUUID(),
    name: seed.name,
    type: seed.type ?? "product_area",
    loreTags: seed.loreTags ?? [],
  };
}

function toRepoRef(seed: FakeSeedRepoRef): RepoRef {
  return {
    id: seed.id ?? randomUUID(),
    name: seed.name,
    path: seed.path ?? null,
    reason: seed.reason ?? null,
  };
}

interface FakeTicket {
  id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  policyPack: string;
  riskLevel: string;
  branchName: string | null;
  acceptanceCriteria: Array<{ id: string; text: string; status: string }>;
  repositories: Array<{
    id: string;
    name: string;
    localPath: string | null;
    defaultBranch: string;
    role: string;
    testCommand?: string | null;
  }>;
}

export interface RecordedEvidence {
  evidenceId: string;
  ticketId: string;
  acId: string | null;
  evidenceType: string;
  summary: string;
  uri: string | null;
  payload: unknown;
}

/** A seedable scope node for the Fake's work packet. `loreTags` defaults to []. */
export interface FakeSeedScopeNode {
  id?: string;
  name: string;
  type?: string;
  loreTags?: string[];
}

/** A seedable repo reference for the Fake's work packet. */
export interface FakeSeedRepoRef {
  id?: string;
  name: string;
  path?: string | null;
  reason?: string | null;
}

/**
 * A seedable scope-aware work packet (FG-006). Anything omitted is empty, so a
 * test can assert mono-fallback behaviour by seeding only `writeRepos` (or by
 * seeding nothing and letting {@link FakeDispatchClient.getWorkPacket} derive a
 * single-repo packet from the ticket's repositories).
 */
export interface FakeSeedWorkPacket {
  primaryScope?: FakeSeedScopeNode;
  secondaryScopes?: FakeSeedScopeNode[];
  writeRepos?: FakeSeedRepoRef[];
  readOnlyRepos?: FakeSeedRepoRef[];
  testRepos?: FakeSeedRepoRef[];
}

export interface FakeSeedTicket {
  title: string;
  description?: string;
  status?: string;
  policyPack?: string;
  riskLevel?: string;
  acceptanceCriteria?: Array<{ text: string; status?: string }>;
  repositories?: Array<{
    name: string;
    localPath?: string | null;
    defaultBranch?: string;
    role?: string;
    testCommand?: string | null;
  }>;
}

/**
 * In-memory Dispatch implementation used by every Crew test. It enforces
 * just enough invariants (single active claim, token validity, draft creation)
 * to make the loops observable without a real database.
 */
export class FakeDispatchClient implements DispatchClient {
  private readonly tickets = new Map<string, FakeTicket>();
  private readonly claims = new Map<string, string>(); // claimToken -> ticketId
  private readonly workPackets = new Map<string, FakeSeedWorkPacket>(); // ticketId -> packet
  private nextNumber = 1;

  readonly evidence: RecordedEvidence[] = [];
  readonly heartbeats: string[] = [];
  readonly deliveryArtifacts: Array<{
    ticketId: string;
    branchName: string | null;
    prUrl: string | null;
  }> = [];
  readonly repoDeliveries: Array<{
    ticketId: string;
    repoId: string;
    branchName: string | null;
    prUrl: string | null;
    status: RepoDeliveryStatus;
  }> = [];
  readonly events: Array<{ type: string; ticketId?: string; payload?: unknown }> = [];
  readonly registeredAgents: Array<{ agentId: string; capabilities: string[]; maxRisk?: string }> =
    [];
  /** Repos registered via {@link registerRepo} (FG-003 onboarding). */
  readonly registeredRepos: Array<{
    repoId: string;
    name: string;
    localPath: string;
    remoteUrl: string | null;
    defaultBranch: string | null;
    stack: string | null;
    testCommand: string | null;
    scopeNodeIds: string[];
    relation: string | null;
    defaultAccess: string | null;
  }> = [];
  private readonly scopeNodes: ScopeNodeSummary[] = [];
  /** Decisions raised via {@link requestDecision} (Ticket #9 clarifying questions). */
  readonly decisions: Array<{
    decisionId: string;
    title: string;
    question: string;
    severity: string;
    status: string;
    answer: string | null;
    ticketId: string | null;
  }> = [];

  /** Seed scope nodes so onboarding can attach a repo to them (test helper). */
  seedScopeNode(node: ScopeNodeSummary): ScopeNodeSummary {
    this.scopeNodes.push(node);
    return node;
  }

  listScopeNodes(): ScopeNodeSummary[] {
    return this.scopeNodes.map((n) => ({ ...n, loreTags: [...n.loreTags] }));
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
  }): RepoRegistrationResult {
    const scopeNodeIds = p.scopeNodeIds ?? [];
    // Idempotent on repoId — re-registering updates the existing row.
    const existing = this.registeredRepos.find((r) => r.repoId === p.repoId);
    const row = {
      repoId: p.repoId,
      name: p.name,
      localPath: p.localPath,
      remoteUrl: p.remoteUrl ?? null,
      defaultBranch: p.defaultBranch ?? null,
      stack: p.stack ?? null,
      testCommand: p.testCommand ?? null,
      scopeNodeIds,
      relation: p.relation ?? null,
      defaultAccess: p.defaultAccess ?? null,
    };
    if (existing) Object.assign(existing, row);
    else this.registeredRepos.push(row);
    this.events.push({ type: "repo.registered", payload: { repoId: p.repoId, scopeNodeIds } });
    return { repoId: p.repoId, attachedScopeIds: scopeNodeIds };
  }

  seedTicket(seed: FakeSeedTicket): FakeTicket {
    const id = randomUUID();
    const ticket: FakeTicket = {
      id,
      number: this.nextNumber++,
      title: seed.title,
      description: seed.description ?? "",
      status: seed.status ?? "ready",
      policyPack: seed.policyPack ?? "solo_loose",
      riskLevel: seed.riskLevel ?? "medium",
      branchName: null,
      acceptanceCriteria: (seed.acceptanceCriteria ?? []).map((ac) => ({
        id: randomUUID(),
        text: ac.text,
        status: ac.status ?? "pending",
      })),
      repositories: (seed.repositories ?? []).map((r) => ({
        id: randomUUID(),
        name: r.name,
        localPath: r.localPath ?? null,
        defaultBranch: r.defaultBranch ?? "main",
        role: r.role ?? "primary",
        testCommand: r.testCommand ?? null,
      })),
    };
    this.tickets.set(id, ticket);
    return ticket;
  }

  listReady(): ReadyTicket[] {
    return [...this.tickets.values()]
      .filter((t) => t.status === "ready")
      .map((t) => ({
        ticketId: t.id,
        number: t.number,
        title: t.title,
        policyPack: t.policyPack,
        riskLevel: t.riskLevel,
      }));
  }

  countDeliveredTickets(repoName: string): number {
    return [...this.tickets.values()].filter(
      (t) => t.status === "done" && t.repositories.some((r) => r.name === repoName),
    ).length;
  }

  claimNextTicket(p: {
    agentId: string;
    ttlSeconds: number;
    capabilities?: string[];
  }): ClaimResult | null {
    const ready = [...this.tickets.values()].find((t) => t.status === "ready");
    if (!ready) return null;
    ready.status = "claimed";
    const claimToken = randomUUID();
    this.claims.set(claimToken, ready.id);
    this.events.push({
      type: "ticket.claimed",
      ticketId: ready.id,
      payload: { agentId: p.agentId },
    });
    return { ticketId: ready.id, number: ready.number, claimToken };
  }

  claimTicket(p: {
    ticketId: string;
    agentId: string;
    ttlSeconds: number;
    capabilities?: string[];
  }): ClaimResult | null {
    const ticket = this.tickets.get(p.ticketId);
    // Mirror Dispatch: only a SPECIFIC ready ticket is claimable; anything else
    // (unknown id, already claimed, terminal) yields null so the loop can react.
    if (!ticket || ticket.status !== "ready") return null;
    ticket.status = "claimed";
    const claimToken = randomUUID();
    this.claims.set(claimToken, ticket.id);
    this.events.push({
      type: "ticket.claimed",
      ticketId: ticket.id,
      payload: { agentId: p.agentId },
    });
    return { ticketId: ticket.id, number: ticket.number, claimToken };
  }

  requestDecision(p: {
    title: string;
    question: string;
    severity?: string;
    ticketId?: string;
  }): DecisionRequestResult {
    const decisionId = randomUUID();
    const severity = p.severity ?? "human_required";
    // Mirror Dispatch: a human_required decision opens in the blocking state.
    const status = severity === "human_required" ? "human_required" : "requested";
    this.decisions.push({
      decisionId,
      title: p.title,
      question: p.question,
      severity,
      status,
      answer: null,
      ticketId: p.ticketId ?? null,
    });
    this.events.push({ type: "decision.created", payload: { decisionId, severity } });
    return { decisionId, title: p.title, question: p.question, severity, status };
  }

  /** Test helper: model a human answering a raised decision in the UI/CLI. */
  answerDecision(decisionId: string, answer: string): void {
    const decision = this.decisions.find((d) => d.decisionId === decisionId);
    if (!decision) throw notFound("decision", decisionId);
    decision.answer = answer;
    decision.status = "accepted";
    this.events.push({ type: "decision.resolved", payload: { decisionId } });
  }

  heartbeat(claimToken: string): void {
    if (!this.claims.has(claimToken)) {
      throw new CrewError("INVALID_CLAIM", "Unknown claim token.", { claimToken });
    }
    this.heartbeats.push(claimToken);
  }

  getTicket(ref: string): TicketBundle {
    const ticket = this.resolve(ref);
    return {
      ticket: {
        id: ticket.id,
        number: ticket.number,
        title: ticket.title,
        description: ticket.description,
        status: ticket.status,
        policyPack: ticket.policyPack,
        riskLevel: ticket.riskLevel,
        branchName: ticket.branchName,
      },
      acceptanceCriteria: ticket.acceptanceCriteria.map((ac) => ({ ...ac })),
      repositories: ticket.repositories.map((r) => ({ ...r })),
    };
  }

  setBranchName(ticketId: string, branchName: string): void {
    const ticket = this.resolve(ticketId);
    ticket.branchName = branchName;
  }

  /**
   * Seed an explicit scope-aware work packet for a ticket (FG-006). Tests use
   * this to model a mapped multi-repo ticket (primary/secondary scopes,
   * write/read-only/test repos with reasons). Tickets with no seeded packet fall
   * back to a single-repo packet derived from the ticket's repositories.
   */
  seedWorkPacket(ticketId: string, packet: FakeSeedWorkPacket): void {
    // Resolve to canonical id so a number/#ref seed still keys the same ticket.
    this.workPackets.set(this.resolve(ticketId).id, packet);
  }

  getWorkPacket(ticketId: string): WorkPacket {
    const ticket = this.resolve(ticketId);
    const seeded = this.workPackets.get(ticket.id);
    if (seeded) {
      return {
        scopes: {
          ...(seeded.primaryScope ? { primary: toScopeNode(seeded.primaryScope) } : {}),
          secondary: (seeded.secondaryScopes ?? []).map(toScopeNode),
        },
        writeRepos: (seeded.writeRepos ?? []).map(toRepoRef),
        readOnlyRepos: (seeded.readOnlyRepos ?? []).map(toRepoRef),
        testRepos: (seeded.testRepos ?? []).map(toRepoRef),
      };
    }
    // Mono-fallback: no scope graph. Every repo on the ticket is writable so a
    // single unmapped repo still produces a working single-repo packet.
    return {
      scopes: { secondary: [] },
      writeRepos: ticket.repositories.map((r) => ({
        id: r.id,
        name: r.name,
        path: r.localPath,
        reason: "Ticket's repository (no scope-graph mapping; single-repo fallback).",
      })),
      readOnlyRepos: [],
      testRepos: [],
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
    this.assertClaim(p.claimToken, p.ticketId);
    const evidenceId = randomUUID();
    const eventId = randomUUID();
    this.evidence.push({
      evidenceId,
      ticketId: p.ticketId,
      acId: p.acId ?? null,
      evidenceType: p.evidenceType,
      summary: p.summary,
      uri: p.uri ?? null,
      payload: p.payload ?? null,
    });
    this.events.push({ type: "evidence.recorded", ticketId: p.ticketId, payload: { evidenceId } });
    return { evidenceId, eventId };
  }

  recordDeliveryArtifact(p: {
    claimToken?: string;
    ticketId: string;
    branchName?: string | null;
    prUrl?: string | null;
    commit?: string;
    diffSummary?: string;
  }): DeliveryArtifactResult {
    const ticket = this.resolve(p.ticketId);
    // Persist branch/PR onto the in-memory ticket so done-gates that read the
    // ticket's branch (factory_strict/regulated) observe the delivery.
    if (p.branchName !== undefined) ticket.branchName = p.branchName;
    const branchName = ticket.branchName;
    const prUrl = p.prUrl ?? null;
    const eventId = randomUUID();
    this.deliveryArtifacts.push({ ticketId: ticket.id, branchName, prUrl });
    this.events.push({
      type: "ticket.delivery_recorded",
      ticketId: ticket.id,
      payload: { branchName, prUrl, commit: p.commit ?? null, diffSummary: p.diffSummary ?? null },
    });
    return { ticketId: ticket.id, branchName, prUrl, eventId };
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
    const ticket = this.resolve(p.ticketId);
    const branchName = p.branchName ?? null;
    const prUrl = p.prUrl ?? null;
    const status: RepoDeliveryStatus = p.status ?? "branch_created";
    this.repoDeliveries.push({ ticketId: ticket.id, repoId: p.repoId, branchName, prUrl, status });
    const eventId = randomUUID();
    this.events.push({
      type: "ticket.repo_delivery_recorded",
      ticketId: ticket.id,
      payload: { repoId: p.repoId, branchName, prUrl, status },
    });
    return { ticketId: ticket.id, repoId: p.repoId, branchName, prUrl, status, eventId };
  }

  submitForReview(p: { claimToken: string; ticketId: string; reason?: string }): {
    status: string;
    eventId: string;
  } {
    this.assertClaim(p.claimToken, p.ticketId);
    const ticket = this.resolve(p.ticketId);
    ticket.status = "in_review";
    const eventId = randomUUID();
    this.events.push({ type: "ticket.submitted_for_review", ticketId: ticket.id });
    return { status: ticket.status, eventId };
  }

  markBlocked(p: { claimToken: string; ticketId: string; reason: string }): { eventId: string } {
    this.assertClaim(p.claimToken, p.ticketId);
    const ticket = this.resolve(p.ticketId);
    ticket.status = "blocked";
    const eventId = randomUUID();
    this.events.push({
      type: "ticket.blocked",
      ticketId: ticket.id,
      payload: { reason: p.reason },
    });
    return { eventId };
  }

  createDraftTicket(p: {
    title: string;
    description?: string;
    repoName?: string;
    evidenceSummary?: string;
    findingKey?: string;
    policyPack?: string;
  }): { ticketId: string; number: number } {
    const description = p.findingKey
      ? `${p.description ?? ""}\n\nFinding-Key: ${p.findingKey}`
      : (p.description ?? "");
    const ticket = this.seedTicket({
      title: p.title,
      description,
      status: "draft",
      ...(p.policyPack ? { policyPack: p.policyPack } : {}),
      repositories: p.repoName ? [{ name: p.repoName }] : [],
    });
    this.events.push({
      type: "draft_ticket.created",
      ticketId: ticket.id,
      payload: {
        repoName: p.repoName,
        evidenceSummary: p.evidenceSummary,
        findingKey: p.findingKey,
        policyPack: ticket.policyPack,
      },
    });
    return { ticketId: ticket.id, number: ticket.number };
  }

  findTicketBySource(sourceUrl: string): { ticketId: string } | undefined {
    const needle = `Source: ${sourceUrl}`;
    const match = [...this.tickets.values()].find((t) => t.description.includes(needle));
    return match ? { ticketId: match.id } : undefined;
  }

  findOpenTicketByFindingKey(findingKey: string): { ticketId: string } | undefined {
    const needle = `Finding-Key: ${findingKey}`;
    const match = [...this.tickets.values()].find(
      (t) => !TERMINAL_TICKET_STATUSES.has(t.status) && t.description.includes(needle),
    );
    return match ? { ticketId: match.id } : undefined;
  }

  markTicketReady(ticketId: string): void {
    const ticket = this.resolve(ticketId);
    ticket.status = "ready";
    this.events.push({ type: "ticket.marked_ready", ticketId: ticket.id });
  }

  /** Epics created via {@link createEpic}, for test assertions. */
  readonly epics: Array<{
    epicId: string;
    name: string;
    findingKey: string | null;
    ticketIds: string[];
    ready: boolean;
  }> = [];

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
    const epicId = randomUUID();
    const findingKey = p.findingKey ?? null;
    const ticketIds: string[] = [];
    p.tickets.forEach((t, index) => {
      // Stamp the stable de-dup marker on the FIRST ticket so a later tick maps
      // the same backlog feature to this open epic via findOpenTicketByFindingKey.
      const description =
        index === 0 && findingKey
          ? `${t.description ?? ""}\n\nFinding-Key: ${findingKey}`
          : (t.description ?? "");
      const ticket = this.seedTicket({
        title: t.title,
        description,
        status: p.ready ? "ready" : "draft",
        ...(p.policyPack ? { policyPack: p.policyPack } : {}),
        acceptanceCriteria: (t.acceptanceCriteria ?? []).map((text) => ({ text })),
        repositories: t.repoName ? [{ name: t.repoName }] : [],
      });
      ticketIds.push(ticket.id);
    });
    this.epics.push({ epicId, name: p.name, findingKey, ticketIds, ready: p.ready });
    this.events.push({
      type: "epic.created",
      payload: { epicId, name: p.name, ticketCount: ticketIds.length, ready: p.ready, findingKey },
    });
    return { epicId, ticketIds, ready: p.ready };
  }

  registerAgent(p: { displayName?: string; capabilities?: string[]; maxRisk?: string }): {
    agentId: string;
  } {
    const agentId = randomUUID();
    this.registeredAgents.push({
      agentId,
      capabilities: p.capabilities ?? [],
      ...(p.maxRisk !== undefined ? { maxRisk: p.maxRisk } : {}),
    });
    return { agentId };
  }

  private resolve(ref: string): FakeTicket {
    const byId = this.tickets.get(ref);
    if (byId) return byId;
    const asNumber = Number(ref.replace(/^#/, ""));
    if (Number.isInteger(asNumber)) {
      const byNumber = [...this.tickets.values()].find((t) => t.number === asNumber);
      if (byNumber) return byNumber;
    }
    throw notFound("ticket", ref);
  }

  private assertClaim(claimToken: string, ticketId: string): void {
    const claimed = this.claims.get(claimToken);
    if (!claimed) {
      throw new CrewError("INVALID_CLAIM", "Unknown claim token.", { claimToken });
    }
    if (claimed !== ticketId) {
      throw new CrewError("CLAIM_MISMATCH", "Claim token does not match ticket.", {
        claimToken,
        ticketId,
      });
    }
  }
}
