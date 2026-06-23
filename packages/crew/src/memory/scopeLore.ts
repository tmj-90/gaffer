import type { MemoryClient, LoreRecord } from "./client.js";
import type { RepoRegistry } from "../registry/repoRegistry.js";
import type { RepoRef, WorkPacket, WorkScopeNode } from "../dispatch/client.js";

/**
 * Lore-by-scope bridge (LG-001), built on FG-006's lore-by-scope prefetch.
 *
 * Crew queries Memory by the ticket's confirmed repos AND its selected
 * scope nodes' `lore_tags`. LG-001 adds, on top of FG-006:
 *   - PARENT-SCOPE lore: a node's ancestor scopes' lore, included at LOWER
 *     priority (a parent product's policy still applies to a child capability).
 *   - EDGE lore: when work touches a related node via a `scope_edge`
 *     (`depends_on`/`contains`/…), that neighbour's lore, at the lowest priority.
 *   - A clear "why included" reason on every record.
 *
 * This is implemented ENTIRELY in Crew as an external mapping over scope
 * `lore_tags` + the existing Memory client — Memory itself is never
 * modified, and agents can never ratify lore from this flow (the records are
 * read-only context; suggestions remain suggest-only elsewhere).
 */

/**
 * An external scope graph projection Crew maintains for lore resolution.
 * Maps a scope node id to its curated `lore_tags`, its parent chain (nearest
 * first), and its outbound edges to related nodes. Built outside Memory.
 */
export interface ScopeGraphView {
  /** lore_tags for any scope id (including parents/neighbours not on the ticket). */
  loreTagsFor(scopeId: string): string[];
  /** Human name for a scope id (for reasons), falling back to the id. */
  nameFor(scopeId: string): string;
  /** Ancestor scope ids of `scopeId`, nearest parent first. */
  parentsOf(scopeId: string): string[];
  /** Related scope ids reachable via a scope_edge, with the relation label. */
  edgesOf(scopeId: string): Array<{ scopeId: string; relation: string }>;
}

/** Priority bands — lower number = higher priority. Stable sort key for the packet. */
export const LORE_PRIORITY = {
  writeRepo: 0,
  primaryScope: 1,
  secondaryScope: 2,
  readRepo: 3,
  parentScope: 4,
  edgeScope: 5,
} as const;

export type LorePriority = (typeof LORE_PRIORITY)[keyof typeof LORE_PRIORITY];

/** A lore record selected for a ticket, with its inclusion reason + priority. */
export interface ScopedLoreRecord extends LoreRecord {
  /** Plain-language explanation of why this record was included. */
  reason: string;
  /** Selection priority band (lower = higher priority). */
  priority: LorePriority;
}

export interface ScopeLoreDeps {
  memory: MemoryClient;
  repoRegistry: RepoRegistry;
  /** Optional external scope graph; when absent, parent + edge lore is skipped. */
  scopeGraph?: ScopeGraphView;
  /** Max records to return (the packet's lore limit). */
  limit: number;
  /** Apply secret redaction to summaries. */
  redactSummary: (text: string) => string;
}

/** Query Memory by tags, returning [] for an empty tag set (keeps unrelated lore out). */
function queryFor(
  memory: MemoryClient,
  tags: string[],
  limit: number,
  repoName?: string,
): LoreRecord[] {
  if (tags.length === 0) return [];
  return memory.searchLore({ tags, ...(repoName ? { repoName } : {}), limit });
}

/**
 * Select lore for a ticket by repo, scope, parent-scope (lower priority) and
 * edge (lowest priority), each annotated with a reason. De-duplicated by id
 * (the FIRST, highest-priority reason wins), then capped to `limit`. The result
 * is ordered by priority then by discovery so the highest-priority lore leads.
 */
export function selectScopedLore(work: WorkPacket, deps: ScopeLoreDeps): ScopedLoreRecord[] {
  const { memory, repoRegistry, scopeGraph, limit, redactSummary } = deps;
  const byId = new Map<string, ScopedLoreRecord>();

  const ingest = (records: LoreRecord[], reason: string, priority: LorePriority): void => {
    for (const rec of records) {
      if (byId.has(rec.id)) continue;
      byId.set(rec.id, { ...rec, summary: redactSummary(rec.summary), reason, priority });
      if (byId.size >= limit) break;
    }
  };

  // 1. Confirmed repos (write first, then read-only) — FG-006 base.
  const repoSources: Array<{ ref: RepoRef; kind: string; priority: LorePriority }> = [
    ...work.writeRepos.map((ref) => ({
      ref,
      kind: "write repo",
      priority: LORE_PRIORITY.writeRepo,
    })),
    ...work.readOnlyRepos.map((ref) => ({
      ref,
      kind: "read-only repo",
      priority: LORE_PRIORITY.readRepo,
    })),
  ];
  for (const { ref, kind, priority } of repoSources) {
    if (byId.size >= limit) break;
    const tags = repoRegistry.find(ref.name)?.lore_tags ?? [];
    ingest(queryFor(memory, tags, limit, ref.name), `Relevant to ${kind} '${ref.name}'.`, priority);
  }

  // 2. Selected scope nodes (primary then secondary) — FG-006 base.
  const scopeSources: Array<{ node: WorkScopeNode; kind: string; priority: LorePriority }> = [
    ...(work.scopes.primary
      ? [{ node: work.scopes.primary, kind: "primary scope", priority: LORE_PRIORITY.primaryScope }]
      : []),
    ...work.scopes.secondary.map((node) => ({
      node,
      kind: "secondary scope",
      priority: LORE_PRIORITY.secondaryScope,
    })),
  ];
  for (const { node, kind, priority } of scopeSources) {
    if (byId.size >= limit) break;
    ingest(queryFor(memory, node.loreTags, limit), `Relevant to ${kind} '${node.name}'.`, priority);
  }

  // 3. LG-001 additions: parent-scope lore (lower priority) and edge lore (lowest).
  if (scopeGraph) {
    const selectedScopes = scopeSources.map((s) => s.node);

    // Parent lore — ancestors of every selected scope, nearest parent first.
    for (const node of selectedScopes) {
      if (byId.size >= limit) break;
      for (const parentId of scopeGraph.parentsOf(node.id)) {
        if (byId.size >= limit) break;
        const tags = scopeGraph.loreTagsFor(parentId);
        const parentName = scopeGraph.nameFor(parentId);
        ingest(
          queryFor(memory, tags, limit),
          `Inherited from parent scope '${parentName}' of '${node.name}' (lower priority).`,
          LORE_PRIORITY.parentScope,
        );
      }
    }

    // Edge lore — neighbours reachable via a scope_edge (depends_on/contains/…).
    for (const node of selectedScopes) {
      if (byId.size >= limit) break;
      for (const edge of scopeGraph.edgesOf(node.id)) {
        if (byId.size >= limit) break;
        const tags = scopeGraph.loreTagsFor(edge.scopeId);
        const edgeName = scopeGraph.nameFor(edge.scopeId);
        ingest(
          queryFor(memory, tags, limit),
          `From related scope '${edgeName}' (${edge.relation} edge from '${node.name}'; lowest priority).`,
          LORE_PRIORITY.edgeScope,
        );
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.priority - b.priority).slice(0, limit);
}

/**
 * An in-memory {@link ScopeGraphView} built from a flat node + edge list. Crew
 * (not Memory) owns this mapping — it derives `lore_tags`, parent chains and
 * edges from the scope graph it already tracks. `contains` edges define parentage
 * (the container is the parent); other relations are surfaced as edge lore.
 */
export interface ScopeGraphNodeInput {
  id: string;
  name?: string;
  loreTags?: string[];
}

export interface ScopeGraphEdgeInput {
  from: string;
  to: string;
  /** e.g. "contains", "depends_on". `contains` also establishes parentage. */
  relation: string;
}

export function buildScopeGraphView(
  nodes: readonly ScopeGraphNodeInput[],
  edges: readonly ScopeGraphEdgeInput[],
): ScopeGraphView {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  // parent map: child -> [parents] (from `contains` edges, container = parent).
  const parents = new Map<string, string[]>();
  const outEdges = new Map<string, Array<{ scopeId: string; relation: string }>>();

  for (const edge of edges) {
    if (edge.relation === "contains") {
      const list = parents.get(edge.to) ?? [];
      list.push(edge.from);
      parents.set(edge.to, list);
    } else {
      const list = outEdges.get(edge.from) ?? [];
      list.push({ scopeId: edge.to, relation: edge.relation });
      outEdges.set(edge.from, list);
    }
  }

  const ancestorsOf = (scopeId: string): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>([scopeId]);
    let frontier = parents.get(scopeId) ?? [];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const parent of frontier) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        chain.push(parent);
        next.push(...(parents.get(parent) ?? []));
      }
      frontier = next;
    }
    return chain;
  };

  return {
    loreTagsFor: (scopeId) => nodeById.get(scopeId)?.loreTags ?? [],
    nameFor: (scopeId) => nodeById.get(scopeId)?.name ?? scopeId,
    parentsOf: ancestorsOf,
    edgesOf: (scopeId) => outEdges.get(scopeId) ?? [],
  };
}
