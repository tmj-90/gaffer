import { basename } from "node:path";

import type { LoreSuggestionInput } from "../memory/client.js";
import type { GitAdapter } from "../adapters/gitAdapter.js";
import { systemGitAdapter } from "../adapters/gitAdapter.js";
import type { ScopeNodeSummary, DispatchClient } from "../dispatch/client.js";
import {
  RepoContextStore,
  type RepoContext,
  type RepoMapping,
  type RepoProfile,
} from "./contextStore.js";
import { scanRepoForOnboarding, type OnboardingScanResult } from "./onboardScan.js";
import { deriveRepoUnderstanding, type RepoUnderstanding } from "./repoDigest.js";

/**
 * Repo onboarding orchestrator (FG-003 + FG-004).
 *
 * Scans a repo (path/branch/remote/stack/commands — never secret files),
 * applies the chosen mapping (unmapped, standalone single-repo, or attached to
 * one or more scope nodes), registers it in Dispatch's repository registry
 * where appropriate so it surfaces in the Factory Map, and persists derived
 * context to the non-committed context store. The repo is NEVER modified unless
 * `modifyRepo` is explicitly set (reserved for future opt-in writes; the MVP
 * never writes regardless).
 */

/** How the operator chose to map the repo. */
export type OnboardMappingChoice =
  | { mode: "unmapped" }
  | { mode: "standalone" }
  | { mode: "mapped"; scopeNodeIds: string[] };

export interface OnboardOptions {
  /** Repo id; defaults to the directory basename. */
  repoId?: string;
  /** Display name; defaults to the directory basename. */
  name?: string;
  mapping: OnboardMappingChoice;
  /** Extra lore tags to record on the repo context. */
  tags?: string[];
  /** Relation + default access for scope attachments (mapped mode). */
  relation?: string;
  defaultAccess?: string;
  /** Explicit opt-in to modify the repo. The MVP never writes; reserved. */
  modifyRepo?: boolean;
}

export interface OnboardResult {
  repoId: string;
  name: string;
  scan: OnboardingScanResult;
  profile: RepoProfile;
  context: RepoContext;
  /** Dispatch registration result, or null when the facade can't register yet. */
  registration: { repoId: string; attachedScopeIds: string[] } | null;
  /** Where the context was stored (the per-repo dir). */
  storedAt: string;
  /** True when secret-looking paths were seen during the scan and skipped. */
  secretPathsSkipped: boolean;
  /**
   * Repo Digest + feature inventory DERIVED FROM THE SAME SCAN (no second pass).
   * Returned for the caller to persist via the async Memory bridge
   * (`flushRepoUnderstanding` → `update_repo_digest` / `add_feature`). The digest
   * upserts by repo; features de-dupe by repo+name on re-onboard.
   */
  understanding: RepoUnderstanding;
}

export interface OnboardDeps {
  store: RepoContextStore;
  dispatch: DispatchClient;
  git?: GitAdapter;
}

function toMapping(choice: OnboardMappingChoice): RepoMapping {
  if (choice.mode === "mapped") return { mode: "mapped", scopeNodeIds: choice.scopeNodeIds };
  return { mode: choice.mode, scopeNodeIds: [] };
}

/**
 * Derive sensible default context tags from the onboarding scan so Memory
 * search is primed even when the operator passed no explicit `--tag`s. Combines
 * the detected stack with notable risk signals the scan surfaced (e.g. an
 * in-flight migration, a Dockerfile, a monorepo marker). Tags are de-duplicated,
 * lower-cased, and slugified so they read as stable lore tags rather than prose.
 */
export function deriveContextTags(scan: OnboardingScanResult): string[] {
  const slug = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  const tags = new Set<string>();
  if (scan.stack) tags.add(slug(scan.stack));
  for (const signal of scan.riskSignals ?? []) {
    const tag = slug(signal);
    if (tag) tags.add(tag);
  }
  return [...tags].filter((t) => t.length > 0);
}

/** List scope nodes the repo could attach to (empty when the graph is empty). */
export function availableScopeNodes(dispatch: DispatchClient): ScopeNodeSummary[] {
  return dispatch.listScopeNodes ? dispatch.listScopeNodes() : [];
}

/**
 * Onboard a repo at `dir`. Pure-ish: the only side effects are the context-store
 * write and the (optional) Dispatch registration; the repo itself is untouched.
 */
export function onboardRepo(dir: string, opts: OnboardOptions, deps: OnboardDeps): OnboardResult {
  const git = deps.git ?? systemGitAdapter;
  const repoId = opts.repoId ?? basename(dir);
  const name = opts.name ?? basename(dir);

  const scan = scanRepoForOnboarding(dir, git);
  const mapping = toMapping(opts.mapping);

  // Register in Dispatch so the repo surfaces in the Factory Map. Unmapped and
  // standalone repos are still registered (with no scope attachment) so they
  // appear as "unmapped repos"; only `mapped` attaches scope ids.
  const scopeNodeIds = mapping.mode === "mapped" ? mapping.scopeNodeIds : [];
  // Re-onboarding an already-registered repo is expected — the point is to refresh
  // its digest + feature ledger — so tolerate a DUPLICATE instead of failing the
  // whole onboard before the digest is ever built.
  let registration: { repoId: string; attachedScopeIds: string[] } | null = null;
  try {
    registration =
      deps.dispatch.registerRepo?.({
        repoId,
        name,
        localPath: scan.path,
        remoteUrl: scan.remoteUrl,
        defaultBranch: scan.defaultBranch,
        stack: scan.stack,
        testCommand: scan.testCommand,
        scopeNodeIds,
        ...(opts.relation ? { relation: opts.relation } : {}),
        ...(opts.defaultAccess ? { defaultAccess: opts.defaultAccess } : {}),
      }) ?? null;
  } catch (err) {
    if ((err as { code?: string } | null)?.code !== "DUPLICATE") throw err;
    // Already registered — keep going so the digest + features still refresh.
  }

  // Seed context tags: honour explicit `--tag`s; otherwise derive sensible
  // context tags from the scan (stack + risk signals) so Memory search is
  // primed for this repo from day one.
  const tags = opts.tags && opts.tags.length > 0 ? opts.tags : deriveContextTags(scan);

  // Re-onboarding is IDEMPOTENT: the point of clicking "Onboard" on an already
  // onboarded repo is to REFRESH its digest + feature ledger. The context store's
  // `onboard` throws on an already-onboarded repo (first-time-only guard), so when
  // the repo is already present we route to `rescan` (overwrite the stored profile +
  // context from a fresh scan) and read the refreshed profile back to return the
  // SAME `{ profile, context }` shape. Either way the downstream digest production +
  // flush below still runs, so a re-onboard always re-asserts memory.
  const { profile, context } = deps.store.has(repoId)
    ? (() => {
        const { context: refreshed } = deps.store.rescan({
          repoId,
          scan,
          ...(tags.length > 0 ? { tags } : {}),
        });
        const refreshedProfile = deps.store.readProfile(repoId);
        if (refreshedProfile === null) {
          // `has()` was true, so the profile must be readable; if it vanished
          // between the check and the read, fall back to onboarding cleanly.
          return deps.store.onboard({
            repoId,
            name,
            scan,
            mapping,
            ...(tags.length > 0 ? { tags } : {}),
          });
        }
        return { profile: refreshedProfile, context: refreshed };
      })()
    : deps.store.onboard({
        repoId,
        name,
        scan,
        mapping,
        ...(tags.length > 0 ? { tags } : {}),
      });

  // Derive the Repo Digest + feature inventory FROM THE SAME SCAN — no second
  // repo pass. Scope nodes (for soft `scope_node` name references) come from the
  // Dispatch facade the onboard already opened.
  const understanding = deriveRepoUnderstanding({
    repoId,
    name,
    scan,
    mapping,
    scopeNodes: availableScopeNodes(deps.dispatch),
  });

  return {
    repoId,
    name,
    scan,
    profile,
    context,
    registration,
    storedAt: deps.store.repoDir(repoId),
    secretPathsSkipped: scan.secretPathsSkipped,
    understanding,
  };
}

export interface RescanResult {
  repoId: string;
  scan: OnboardingScanResult;
  context: RepoContext;
  /** True when the content fingerprint changed since the previous scan. */
  changed: boolean;
  /**
   * Memory suggestions derived from the change (suggest-only, FG-004). These
   * are returned for the caller to FLUSH — they are NEVER auto-promoted to
   * Memory. Empty when nothing changed.
   */
  loreSuggestions: LoreSuggestionInput[];
}

/**
 * Rescan an onboarded repo and refresh its stored context. When the content
 * fingerprint changed, derives suggest-only Memory suggestions describing the
 * change (e.g. a new/changed test command or stack) — but does NOT promote them.
 * The caller decides whether to flush them via the async Memory bridge.
 */
export function rescanRepo(
  dir: string,
  deps: OnboardDeps & { repoId: string; tags?: string[] },
): RescanResult {
  const git = deps.git ?? systemGitAdapter;
  const previous = deps.store.readContext(deps.repoId);
  const scan = scanRepoForOnboarding(dir, git);
  const { context, changed } = deps.store.rescan({
    repoId: deps.repoId,
    scan,
    ...(deps.tags ? { tags: deps.tags } : {}),
  });

  const loreSuggestions = changed ? buildChangeSuggestions(deps.repoId, previous, context) : [];

  return { repoId: deps.repoId, scan, context, changed, loreSuggestions };
}

/**
 * Build suggest-only Memory suggestions from a context change. Deliberately
 * conservative: it surfaces command/stack drift as a DRAFT suggestion for a human
 * to ratify; it never asserts durable architecture and never auto-approves.
 */
function buildChangeSuggestions(
  repoId: string,
  previous: RepoContext | null,
  current: RepoContext,
): LoreSuggestionInput[] {
  const suggestions: LoreSuggestionInput[] = [];
  const changes: string[] = [];

  if (previous?.stack !== current.stack) {
    changes.push(`stack: ${previous?.stack ?? "unknown"} → ${current.stack ?? "unknown"}`);
  }
  for (const key of ["test", "lint", "build", "coverage"] as const) {
    const before = previous?.commands[key] ?? null;
    const after = current.commands[key];
    if (before !== after) changes.push(`${key} command: ${before ?? "none"} → ${after ?? "none"}`);
  }

  if (changes.length === 0) return suggestions;

  suggestions.push({
    title: `Repo '${repoId}' context changed`,
    summary:
      `A rescan of '${repoId}' detected changes that may warrant a lore update (suggest-only; ` +
      `not auto-promoted):\n- ${changes.join("\n- ")}`,
    tags: ["repo-context", "onboarding"],
  });
  return suggestions;
}
