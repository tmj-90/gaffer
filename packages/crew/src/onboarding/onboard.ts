import { realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

import { CrewError } from "../util/errors.js";

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
  { mode: "unmapped" } | { mode: "standalone" } | { mode: "mapped"; scopeNodeIds: string[] };

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
 * Resolve an operator-supplied repo path to an absolute directory. Every caller
 * gets this, not just the CLI: a relative `.` used to register a Dispatch repo
 * named "." with local_path "." (resolved later against whatever cwd read it, and
 * colliding with every other repo onboarded as "."), and a missing directory was
 * registered without error.
 */
function resolveRepoDir(dir: string): string {
  const abs = resolve(dir);
  if (statSync(abs, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new CrewError("NOT_FOUND", `repo directory not found: ${abs}`, { path: abs });
  }
  return abs;
}

/** A path's canonical form (symlinks resolved); the resolved path when it is gone. */
function canonicalPath(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

/** A remote URL reduced to what identifies the repository (scheme, `.git`, case, slash). */
export function normalizeRemote(url: string | null | undefined): string {
  return String(url ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/:(?!\d)/, "/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

/** One stored record a repo NAME can collide with (dispatch's registry, crew's store). */
export interface RepoIdentityRecord {
  source: "dispatch" | "context store";
  localPath: string | null;
  remoteUrl: string | null;
}

/**
 * ONBOARDING IDENTITY: is the checkout at `scan` the repository an existing record of
 * the same name describes? A name match used to be treated as a refresh whatever it
 * named: two unrelated repos both called "api" both "onboarded", the second's ticket
 * setup selected the first checkout, and the stored profile combined the first's local
 * path with the second's remote. The same repository is the same CANONICAL LOCAL PATH
 * and nothing else (exported for tests).
 *
 * A refresh never relocates a record. A record whose checkout is gone (a moved or
 * deleted clone) used to match on an identical remote; the refresh then could not move
 * it (dispatch's registration is duplicate-tolerant and kept the old local_path, the
 * context store's rescan kept the old localPath and took the new remote), so one record
 * held the deleted checkout's path and the new checkout's remote and deliveries targeted
 * a directory that no longer existed. A record with no local path is never adopted
 * either: dispatch would keep its empty path while the store recorded this one. Both are
 * refused with the --name guidance; a human decides which record is the repository.
 */
export function sameRepository(
  record: RepoIdentityRecord,
  scan: { path: string; remoteUrl: string | null },
): boolean {
  return !!record.localPath && canonicalPath(record.localPath) === canonicalPath(scan.path);
}

/** Why `record` is not the checkout being onboarded, in words for the refusal. */
function identityConflict(
  record: RepoIdentityRecord,
  scan: { path: string; remoteUrl: string | null },
  name: string,
): string {
  const remote = record.remoteUrl ? `, remote ${record.remoteUrl}` : "";
  const r = normalizeRemote(record.remoteUrl);
  const sameRemote = r !== "" && r === normalizeRemote(scan.remoteUrl);
  if (!record.localPath)
    return `${record.source}: registered with no local path${remote || ", no remote"}; onboarding does not adopt a path-less record`;
  if (statSync(record.localPath, { throwIfNoEntry: false }) === undefined)
    return (
      `${record.source}: ${record.localPath}, which no longer exists${remote}; a refresh is only the ` +
      `same checkout path and never moves a record` +
      (sameRemote
        ? `. It has the same remote, so this may be the same repository moved: onboard it under an ` +
          `alias and hide the old record (wg repo hide ${name})`
        : "")
    );
  return `${record.source}: ${record.localPath}${remote}`;
}

function assertSameRepository(
  name: string,
  repoId: string,
  scan: { path: string; remoteUrl: string | null },
  deps: OnboardDeps,
): void {
  const records: RepoIdentityRecord[] = [];
  for (const r of deps.dispatch.listRepositories(true)) {
    if (r.name === name || r.id === repoId || r.name === repoId)
      records.push({ source: "dispatch", localPath: r.localPath, remoteUrl: r.remoteUrl ?? null });
  }
  const profile = deps.store.has(repoId) ? deps.store.readProfile(repoId) : null;
  if (profile)
    records.push({
      source: "context store",
      localPath: profile.localPath ?? null,
      remoteUrl: profile.remoteUrl ?? null,
    });
  for (const rec of records) {
    if (sameRepository(rec, scan)) continue;
    throw new CrewError(
      "NAME_TAKEN",
      `a different repository is already onboarded as "${name}" (${identityConflict(rec, scan, name)}); ` +
        `${scan.path} was NOT onboarded and neither record was changed. Onboard it under a ` +
        `distinct alias (gaffer onboard ${scan.path} --name <alias>).`,
      {
        name,
        repoId,
        existing: rec.localPath ?? rec.remoteUrl,
        source: rec.source,
        path: scan.path,
      },
    );
  }
}

/**
 * Onboard a repo at `dir`. Pure-ish: the only side effects are the context-store
 * write and the (optional) Dispatch registration; the repo itself is untouched.
 * `dir` may be relative; it is resolved against the cwd and must be a directory.
 */
export function onboardRepo(
  rawDir: string,
  opts: OnboardOptions,
  deps: OnboardDeps,
): OnboardResult {
  const dir = resolveRepoDir(rawDir);
  const git = deps.git ?? systemGitAdapter;
  const repoId = opts.repoId ?? basename(dir);
  const name = opts.name ?? basename(dir);

  const scan = scanRepoForOnboarding(dir, git);
  const mapping = toMapping(opts.mapping);
  // IDENTITY before any write: a name match is a REFRESH only for the same repository.
  assertSameRepository(name, repoId, scan, deps);

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
  rawDir: string,
  deps: OnboardDeps & { repoId: string; tags?: string[] },
): RescanResult {
  const dir = resolveRepoDir(rawDir);
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
    // Always classified: an unkinded draft lands as `other` and is excluded from
    // every `kind` filter Memory's readers apply. A stack/command change is a
    // how-we-do-it-here fact, so it is a convention.
    kind: "convention",
  });
  return suggestions;
}
