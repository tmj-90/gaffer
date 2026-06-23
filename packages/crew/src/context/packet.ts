import { checkBranchPolicy } from "../safety/branchPolicy.js";
import { forbiddenActions } from "../safety/forbiddenActions.js";
import { matchesAnyGlob } from "../safety/glob.js";
import { redact } from "../safety/redaction.js";
import { measurePacket, packetFingerprint, type PacketTokenReport } from "./tokens.js";
import type { SafetyPolicy } from "../safety/policySchema.js";
import type { CrewConfig, RepoConfig } from "../config/schema.js";
import type { MemoryClient, LoreRecord } from "../memory/client.js";
import { selectScopedLore, type LorePriority, type ScopeGraphView } from "../memory/scopeLore.js";
import type { RepoRegistry } from "../registry/repoRegistry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type {
  RepoRef,
  TicketBundle,
  WorkPacket,
  WorkScopeNode,
  DispatchClient,
} from "../dispatch/client.js";

export interface PacketRepo {
  id: string;
  name: string;
  path: string | null;
  defaultBranch: string;
  role: string;
  /** Resolved tech stack for the repo (e.g. "typescript-react"), or null. */
  stack: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  coverageCommand: string | null;
  mutationMode: string;
  branchPolicy: {
    requiredPrefix: string;
    protectedBranches: string[];
    suggestedBranch: string;
    suggestedBranchAllowed: boolean;
  };
}

/** Lean projection of a selected skill — which procedure applies, not its full text. */
export interface PacketSkill {
  id: string;
  name: string;
  version: number;
  stacks: string[];
  capabilities: string[];
}

/** A repo in the work packet, separated by access, with a one-line inclusion reason. */
export interface PacketWorkRepo {
  id: string;
  name: string;
  path: string | null;
  /** Why this repo is in scope for the ticket (write target or read-only context). */
  reason: string;
}

/** A scope node the ticket is mapped to, projected for the packet (name/type only). */
export interface PacketScopeNode {
  id: string;
  name: string;
  type: string;
}

/**
 * The scope-aware work boundary for a ticket (FG-006). Carries the primary +
 * secondary scope nodes and the WRITE vs READ-ONLY repo split. For a
 * mono-fallback / single unmapped ticket, `primary`/`secondary` are absent and
 * the ticket's lone repo appears in `writeRepos`.
 */
export interface PacketWorkScope {
  primary: PacketScopeNode | null;
  secondary: PacketScopeNode[];
  /** True when the ticket had no scope-graph mapping (single-repo fallback). */
  monoFallback: boolean;
  writeRepos: PacketWorkRepo[];
  readOnlyRepos: PacketWorkRepo[];
  testRepos: PacketWorkRepo[];
  /** Plain-language guidance telling the agent where it may write vs read. */
  guidance: string[];
}

/** A lore record selected for the packet, annotated with why it was included. */
export interface PacketLore extends LoreRecord {
  /** Why this record was pulled in (which repo, scope, parent or edge matched). */
  reason: string;
  /** Selection priority band (LG-001): lower = higher priority. */
  priority: LorePriority;
}

export interface ContextPacket {
  factory: { name: string; mode: string };
  /** Tech stacks derived from the ticket's repos, used to pre-filter skills + lore. */
  stacks: string[];
  ticket: TicketBundle["ticket"];
  acceptanceCriteria: TicketBundle["acceptanceCriteria"];
  repositories: PacketRepo[];
  /** Scope-aware work boundary: scopes + write/read repo split + guidance (FG-006). */
  workScope: PacketWorkScope;
  verification: { testCommands: string[]; lintCommands: string[]; coverageCommands: string[] };
  relevantLore: LoreRecord[];
  /** Lore selected by repo AND scope AND tags, each annotated with its reason (FG-006). */
  scopedLore: PacketLore[];
  /** Skills pre-filtered to the ticket's stack(s), capped by config. */
  skills: PacketSkill[];
  forbiddenActions: string[];
  constraints: string[];
  evidenceExpectations: string[];
  /** Token measurement of the packet's content sections (AC: tokens measured + reported). */
  tokens: PacketTokenReport;
  /** Stable content hash so an unchanged packet need not be re-sent to an agent. */
  fingerprint: string;
}

export interface BuildPacketDeps {
  config: CrewConfig;
  policy: SafetyPolicy;
  repoRegistry: RepoRegistry;
  dispatch: DispatchClient;
  memory: MemoryClient;
  /** Optional skill registry; when absent, the packet carries no pre-filtered skills. */
  skillRegistry?: SkillRegistry;
  /**
   * Optional external scope graph (LG-001). When supplied, scoped-lore selection
   * additionally pulls parent-scope lore (lower priority) and edge lore (lowest)
   * for the ticket's scope nodes. Built and owned by Crew — never Memory.
   */
  scopeGraph?: ScopeGraphView;
}

/** A branch slug for the ticket, used to suggest the working branch name. */
function ticketSlug(ticket: TicketBundle["ticket"]): string {
  // Redact first so secret-shaped substrings never leak into a branch name.
  return `ticket-${ticket.number}-${redact(ticket.title)}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * True if a string looks like a secret-bearing line that must never appear in a
 * packet. Used as a final hygiene check on free-text fields.
 */
function stripSecrets(text: string): string {
  return redact(text);
}

function buildPacketRepo(
  packetRepoBase: TicketBundle["repositories"][number],
  config: CrewConfig,
  policy: SafetyPolicy,
  repoRegistry: RepoRegistry,
  suggestedSlug: string,
): PacketRepo {
  const configured: RepoConfig | undefined = repoRegistry.find(packetRepoBase.name);
  const requiredPrefix = policy.git.require_branch_prefix;
  const suggestedBranch = requiredPrefix ? `${requiredPrefix}${suggestedSlug}` : suggestedSlug;
  const branchDecision = checkBranchPolicy(suggestedBranch, policy.git);

  return {
    id: packetRepoBase.id,
    name: packetRepoBase.name,
    path: configured ? repoRegistry.absolutePath(configured) : packetRepoBase.localPath,
    defaultBranch: configured?.default_branch ?? packetRepoBase.defaultBranch,
    role: packetRepoBase.role,
    stack: configured?.stack ?? null,
    testCommand: configured?.test_command ?? packetRepoBase.testCommand ?? null,
    lintCommand: configured?.lint_command ?? null,
    coverageCommand: configured?.coverage_command ?? null,
    mutationMode: configured?.mutation_mode ?? "branch_only",
    branchPolicy: {
      requiredPrefix,
      protectedBranches: configured?.protected_branches ?? policy.git.protected_branches,
      suggestedBranch,
      suggestedBranchAllowed: branchDecision.allowed,
    },
  };
}

function relevantLoreTags(bundle: TicketBundle, repoRegistry: RepoRegistry): string[] {
  const tags = new Set<string>();
  for (const repo of bundle.repositories) {
    const configured = repoRegistry.find(repo.name);
    for (const tag of configured?.lore_tags ?? []) tags.add(tag);
  }
  return [...tags];
}

/**
 * Derive the stack tokens for a ticket from its repos' configured stacks. A
 * compound stack like "typescript-react" expands to its parts plus the whole
 * ("typescript-react", "typescript", "react") so a skill or lore record tagged
 * with either the broad or the specific stack still matches. Empty when no repo
 * declares a stack — pre-filtering then imposes no stack constraint.
 */
function ticketStacks(bundle: TicketBundle, repoRegistry: RepoRegistry): string[] {
  const stacks = new Set<string>();
  for (const repo of bundle.repositories) {
    const stack = repoRegistry.find(repo.name)?.stack;
    if (!stack) continue;
    const normalised = stack.toLowerCase().trim();
    stacks.add(normalised);
    for (const part of normalised.split(/[-/]+/).filter(Boolean)) stacks.add(part);
  }
  return [...stacks];
}

/**
 * Select the skills relevant to the ticket's stacks, capped to `maxSkills`. When
 * no skill registry is wired the packet carries no skills. The selection is
 * stable (sorted by id) so the packet — and its fingerprint — are deterministic.
 */
function selectPacketSkills(
  registry: SkillRegistry | undefined,
  stacks: string[],
  maxSkills: number,
): PacketSkill[] {
  if (!registry) return [];
  return registry
    .select(stacks.length ? { stacks } : {})
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, maxSkills)
    .map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: skill.version,
      stacks: skill.applies_to.stacks,
      capabilities: skill.applies_to.capabilities,
    }));
}

/** Project a Dispatch scope node to the packet's name/type-only shape. */
function toPacketScopeNode(node: WorkScopeNode): PacketScopeNode {
  return { id: node.id, name: node.name, type: stripSecrets(node.type) };
}

/**
 * Resolve a Dispatch {@link RepoRef} to a {@link PacketWorkRepo}, preferring the
 * repo's configured local path (so roots resolve from Crew config) and
 * carrying a one-line, secret-free inclusion reason. `defaultReason` is used when
 * Dispatch supplied none.
 */
function toPacketWorkRepo(
  ref: RepoRef,
  repoRegistry: RepoRegistry,
  defaultReason: string,
): PacketWorkRepo {
  const configured = repoRegistry.find(ref.name);
  return {
    id: ref.id,
    name: ref.name,
    path: configured ? repoRegistry.absolutePath(configured) : ref.path,
    reason: stripSecrets(ref.reason ?? defaultReason),
  };
}

/**
 * Build the scope-aware work boundary (FG-006) from Dispatch's work packet:
 * primary/secondary scope nodes, the WRITE vs READ-ONLY vs TEST repo split (each
 * with a reason), and plain-language guidance. When the ticket has no scope-graph
 * mapping (no scopes AND no write/read/test repos from the boundary), it falls
 * back to a single-repo packet built from the ticket's own repositories so
 * single-repo execution is preserved.
 */
function buildWorkScope(
  work: WorkPacket,
  bundle: TicketBundle,
  repoRegistry: RepoRegistry,
): PacketWorkScope {
  const writeRepos = work.writeRepos.map((r) =>
    toPacketWorkRepo(r, repoRegistry, "Mapped as a write target for this ticket."),
  );
  const readOnlyRepos = work.readOnlyRepos.map((r) =>
    toPacketWorkRepo(r, repoRegistry, "Provided as read-only context for this ticket."),
  );
  const testRepos = work.testRepos.map((r) =>
    toPacketWorkRepo(r, repoRegistry, "Hosts tests/verification for this ticket."),
  );

  // Mono-fallback is defined by the ABSENCE of a scope-graph mapping (no primary
  // and no secondary scope nodes) — the ticket is unmapped single-repo work. A
  // mapped multi-repo ticket always has at least a primary scope.
  const monoFallback = work.scopes.primary === undefined && work.scopes.secondary.length === 0;

  // When nothing partitioned came back from Dispatch's boundary either, derive
  // write targets from the ticket's own repositories so a single unmapped repo
  // still produces a working single-repo packet (preserves pre-FG-006 behaviour).
  const hasBoundaryRepos =
    writeRepos.length > 0 || readOnlyRepos.length > 0 || testRepos.length > 0;
  if (monoFallback && !hasBoundaryRepos) {
    const fallbackWrite = bundle.repositories.map((repo) => {
      const configured = repoRegistry.find(repo.name);
      return {
        id: repo.id,
        name: repo.name,
        path: configured ? repoRegistry.absolutePath(configured) : repo.localPath,
        reason: "Ticket's repository (no scope-graph mapping; single-repo fallback).",
      };
    });
    return {
      primary: null,
      secondary: [],
      monoFallback: true,
      writeRepos: fallbackWrite,
      readOnlyRepos: [],
      testRepos: [],
      guidance: writeGuidance(fallbackWrite, [], true),
    };
  }

  return {
    primary: work.scopes.primary ? toPacketScopeNode(work.scopes.primary) : null,
    secondary: work.scopes.secondary.map(toPacketScopeNode),
    monoFallback,
    writeRepos,
    readOnlyRepos,
    testRepos,
    guidance: writeGuidance(writeRepos, readOnlyRepos, monoFallback),
  };
}

/** Render the explicit "you may WRITE to … ; READ-ONLY context …" guidance. */
function writeGuidance(
  writeRepos: PacketWorkRepo[],
  readOnlyRepos: PacketWorkRepo[],
  monoFallback: boolean,
): string[] {
  const writeNames = writeRepos.map((r) => r.name);
  const readNames = readOnlyRepos.map((r) => r.name);
  const lines: string[] = [];
  lines.push(
    writeNames.length
      ? `You may WRITE to: ${writeNames.join(", ")}.`
      : "You may WRITE to: (no write repos in scope).",
  );
  lines.push(
    readNames.length
      ? `These are READ-ONLY context: ${readNames.join(", ")}. Do not modify them.`
      : "These are READ-ONLY context: (none).",
  );
  if (monoFallback) {
    lines.push("No scope-graph mapping exists for this ticket; treating it as single-repo work.");
  }
  return lines;
}

/**
 * Select lore for the packet by repo AND scope AND tags (FG-006), extended by
 * LG-001 with parent-scope lore (lower priority) and edge lore (lowest), each
 * annotated with why it was included and de-duplicated by id (highest-priority
 * reason wins). Delegates to {@link selectScopedLore}; returns `[]` when Memory
 * is disabled.
 */
function buildScopedLore(work: WorkPacket, deps: BuildPacketDeps): PacketLore[] {
  if (!deps.config.memory.enabled) return [];
  return selectScopedLore(work, {
    memory: deps.memory,
    repoRegistry: deps.repoRegistry,
    ...(deps.scopeGraph ? { scopeGraph: deps.scopeGraph } : {}),
    limit: deps.config.context.lore_limit,
    redactSummary: stripSecrets,
  });
}

/**
 * Assemble the context packet for a claimed ticket. Combines ticket + AC,
 * resolved repo paths/commands, branch policy, forbidden actions and relevant
 * Memory records — and runs every free-text field through secret redaction so
 * the packet can never leak a secret into model context.
 */
export function buildContextPacket(ticketRef: string, deps: BuildPacketDeps): ContextPacket {
  const bundle = deps.dispatch.getTicket(ticketRef);
  const slug = ticketSlug(bundle.ticket);

  const repositories = bundle.repositories.map((repo) =>
    buildPacketRepo(repo, deps.config, deps.policy, deps.repoRegistry, slug),
  );

  const stacks = ticketStacks(bundle, deps.repoRegistry);
  const skills = selectPacketSkills(deps.skillRegistry, stacks, deps.config.context.max_skills);

  // FG-006: the scope-aware work boundary (scopes + write/read repo split). A
  // mono-fallback ticket yields a single-repo packet derived from its repos.
  const work = deps.dispatch.getWorkPacket(bundle.ticket.id);
  const workScope = buildWorkScope(work, bundle, deps.repoRegistry);

  // Pre-filter lore to the ticket's area: repo lore_tags broadened with the
  // derived stack tokens, capped by config so the packet stays lean.
  const tags = [...new Set([...relevantLoreTags(bundle, deps.repoRegistry), ...stacks])];
  const relevantLore = deps.config.memory.enabled
    ? deps.memory.searchLore({
        tags,
        text: bundle.ticket.title,
        limit: deps.config.context.lore_limit,
      })
    : [];

  // FG-006: lore selected by repo AND scope AND tags, each annotated with why.
  const scopedLore = buildScopedLore(work, deps);

  const verification = {
    testCommands: dedupe(repositories.map((r) => r.testCommand)),
    lintCommands: dedupe(repositories.map((r) => r.lintCommand)),
    coverageCommands: dedupe(repositories.map((r) => r.coverageCommand)),
  };

  const constraints = [
    `Work only on branches prefixed '${deps.policy.git.require_branch_prefix}'.`,
    "Do not write secret files; they are denied by the filesystem guard.",
    "Dependency, infra, CI and migration changes require human approval.",
    "Record AC evidence in Dispatch; do not self-approve review.",
  ];

  const evidenceExpectations = bundle.acceptanceCriteria.map(
    (ac) => `Provide evidence for AC '${stripSecrets(ac.text)}' (status: ${ac.status}).`,
  );

  // Assemble content first, then attach token + fingerprint metadata measured
  // over that content (the metadata fields are excluded from both measurements).
  const content: Omit<ContextPacket, "tokens" | "fingerprint"> = {
    factory: { name: deps.config.factory.name, mode: deps.config.factory.mode },
    stacks,
    ticket: {
      ...bundle.ticket,
      title: stripSecrets(bundle.ticket.title),
      description: stripSecrets(bundle.ticket.description),
    },
    acceptanceCriteria: bundle.acceptanceCriteria.map((ac) => ({
      ...ac,
      text: stripSecrets(ac.text),
    })),
    repositories,
    workScope,
    verification,
    relevantLore: relevantLore.map((rec) => ({ ...rec, summary: stripSecrets(rec.summary) })),
    scopedLore,
    skills,
    forbiddenActions: forbiddenActions(deps.policy),
    constraints,
    evidenceExpectations,
  };

  const packet: ContextPacket = {
    ...content,
    tokens: { total: 0, bySection: {} as PacketTokenReport["bySection"] },
    fingerprint: "",
  };
  packet.tokens = measurePacket(packet);
  packet.fingerprint = packetFingerprint(packet);
  return packet;
}

function dedupe(values: ReadonlyArray<string | null>): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (v) out.add(v);
  }
  return [...out];
}

/** Guard: assert a packet contains no obvious secret material. Throws if it does. */
export function assertPacketSecretFree(packet: ContextPacket): void {
  const denyPaths = ["\n-----BEGIN", "AKIA", "ghp_"];
  const json = JSON.stringify(packet);
  for (const marker of denyPaths) {
    if (json.includes(marker)) {
      throw new Error(`Context packet contains a secret-like marker: ${marker}`);
    }
  }
}

/** True when a path would be excluded from any packet-referenced file set. */
export function isSecretPath(relPath: string, policy: SafetyPolicy): boolean {
  return matchesAnyGlob(relPath, policy.filesystem.deny_write_paths);
}
