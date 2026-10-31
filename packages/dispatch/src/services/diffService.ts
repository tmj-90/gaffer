import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { isActiveTicketRepoRelation, type Ticket } from "../domain/types.js";
import {
  computeRiskAnnotations,
  testModifiedAnnotation,
  type RiskAnnotation,
} from "./riskAnnotations.js";
import {
  collectTestIntegrity,
  extraTestPathRe,
  gateScriptNamesOf,
  type TestIntegrityFindings,
} from "./testIntegrity.js";
import type { RepoRepository } from "../repositories/repoRepository.js";
import type { TicketRepoDeliveryRepository } from "../repositories/ticketRepoDeliveryRepository.js";
import type { TicketRepository } from "../repositories/ticketRepository.js";

/**
 * Computes the real `git diff <default-branch>...<delivery-branch>` for the WRITE
 * repos on a ticket so a human can read the change inline in the Review surface
 * BEFORE approving — and re-read the RESOLVED diff after a conflict resolver has
 * pushed a fix and the ticket has been reopened for review.
 *
 * The branch resolution mirrors the runner merge helper: prefer the per-repo
 * delivery branch (`ticket_repos.branch_name`, or the WG-005 `ticket_repo_delivery`
 * row the factory actually records via recordRepoDelivery), falling back to the
 * ticket's top-level `tickets.branch_name`. The diff runs in the repo's
 * `local_path`. Every failure
 * mode is reported, never thrown: a repo with no branch yet, a repo not on disk,
 * an empty diff and an oversized diff all come back as a well-formed per-repo
 * entry the UI can render.
 */

/** Cap the raw diff text captured per repo (defence against a huge change). */
export const MAX_DIFF_BYTES = 200_000;

/**
 * Git's well-known empty-tree object id. Diffing against it shows every tracked file
 * as an addition — used to review a greenfield BOOTSTRAP ticket's initial commit,
 * which has no base branch to diff against (the repo didn't exist before it).
 */
export const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Why a repo carries no diff text (the UI renders a hint instead of a patch). */
export type DiffUnavailableReason =
  "no_branch" | "repo_not_on_disk" | "no_local_path" | "empty" | "git_error";

/** The diff for a single WRITE repo on the ticket. */
export interface RepoDiff {
  /** Repo name. */
  repo: string;
  /** Resolved delivery branch (per-repo branch || ticket branch), or null. */
  branch: string | null;
  /** The default branch the delivery branch is diffed against. */
  baseBranch: string;
  /** Raw unified diff text (possibly truncated). Empty when unavailable. */
  diff: string;
  /** Files changed in the range (from --numstat), best-effort. */
  files: number;
  /** Total added lines across the range (from --numstat), best-effort. */
  additions: number;
  /** Total deleted lines across the range (from --numstat), best-effort. */
  deletions: number;
  /** True when the diff text was capped at {@link MAX_DIFF_BYTES}. */
  truncated: boolean;
  /** Present when no diff text is available — tells the UI why. */
  unavailable?: DiffUnavailableReason;
  /** Human-readable detail for an unavailable/errored repo. */
  message?: string;
  /** ADVISORY risk flags derived from the changed paths + line counts (never gating). */
  riskAnnotations: RiskAnnotation[];
}

/** The full diff-in-review payload: one entry per WRITE repo on the ticket. */
export interface TicketDiff {
  ticketId: string;
  repos: RepoDiff[];
}

/** Dependencies the diff computation needs — repositories + git runner (seamable). */
export interface DiffServiceDeps {
  repos: RepoRepository;
  tickets: TicketRepository;
  /** Per-repo delivery rows (WG-005) — the branch the factory records lives here. */
  repoDeliveries: TicketRepoDeliveryRepository;
  /** Run git in `cwd` with `args`; returns stdout + exit code. Injectable for tests. */
  runGit?: GitRunner;
}

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /**
   * True when stdout hit the runner's output cap and git was stopped early. `status`
   * is then 0 and `stdout` holds the partial output — an oversized diff is still a
   * real diff, so callers cap/annotate it rather than treating it as a git failure.
   */
  truncated?: boolean;
}

/** Per-call knobs a caller may pass to the runner (fakes are free to ignore them). */
export interface GitRunOptions {
  /** Stop git once stdout exceeds this many bytes (reported as `truncated`). */
  maxBuffer?: number;
}

export type GitRunner = (cwd: string, args: readonly string[], opts?: GitRunOptions) => GitResult;

/**
 * Wall-clock cap on one git spawn. The done gate runs git on the approve path, and a
 * hung git (slow filesystem, a huge repo) must fail closed as a `git_error` rather
 * than stall the caller for ever.
 */
export const GIT_TIMEOUT_MS = 15_000;

/** Default stdout cap for one git spawn: the patch is cut to MAX_DIFF_BYTES anyway. */
const DEFAULT_GIT_MAX_BUFFER = MAX_DIFF_BYTES * 4;

/**
 * `--numstat` output must be read in full for honest stats, and is small per file;
 * 16 MB covers hundreds of thousands of changed paths (same cap the spec readers use).
 */
const NUMSTAT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Flags every diff spawn carries: never run a repo-configured external diff driver or
 * textconv filter. Those are arbitrary commands from the repo's git config/attributes;
 * the review diff must be the raw delivered bytes and must not execute anything.
 */
const SAFE_DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"] as const;

/**
 * Default git runner: no shell, fixed `git` binary, args array — request/branch
 * values are passed as argv elements, never interpolated into a command line, so
 * there is no command-injection surface from a recorded branch name.
 */
export const defaultGitRunner: GitRunner = (cwd, args, opts) => {
  const res = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: opts?.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const error = res.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ENOBUFS") {
    // Output overflowed the cap: git was stopped, but what it printed is real.
    return { status: 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "", truncated: true };
  }
  if (error) {
    // Timeout (ETIMEDOUT) or spawn failure: no status, and say why instead of failing silently.
    const why =
      error.code === "ETIMEDOUT" ? `git timed out after ${GIT_TIMEOUT_MS} ms` : error.message;
    return { status: null, stdout: res.stdout ?? "", stderr: why };
  }
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
};

/** Parse `git diff --numstat` output into {files, additions, deletions, paths}. */
function parseNumstat(out: string): {
  files: number;
  additions: number;
  deletions: number;
  paths: string[];
} {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    files += 1;
    // The path is the last tab-field (a rename shows "old => new"; keep it as-is —
    // the risk classifier segment-matches either side well enough for an advisory flag).
    paths.push(parts[parts.length - 1]!);
    // Binary files are reported as "-\t-\tpath"; treat them as 0/0.
    const add = Number.parseInt(parts[0]!, 10);
    const del = Number.parseInt(parts[1]!, 10);
    if (Number.isInteger(add)) additions += add;
    if (Number.isInteger(del)) deletions += del;
  }
  return { files, additions, deletions, paths };
}

/** Build an empty-diff entry (repo present + on disk, but range yields nothing). */
function unavailableRepo(
  repo: string,
  branch: string | null,
  baseBranch: string,
  reason: DiffUnavailableReason,
  message: string,
): RepoDiff {
  return {
    repo,
    branch,
    baseBranch,
    diff: "",
    files: 0,
    additions: 0,
    deletions: 0,
    truncated: false,
    unavailable: reason,
    message,
    riskAnnotations: [],
  };
}

/**
 * A write repo whose diff can be run: branch resolved, repo on disk. The git-free
 * half of the diff computation, shared by {@link computeTicketDiff} (the review
 * payload) and {@link deliveryDiffProof} (the done gate).
 */
interface DiffTarget {
  repoId: string;
  repo: string;
  localPath: string;
  baseBranch: string;
  /** Delivery branch, or null for a bootstrap. */
  branch: string | null;
  isBootstrap: boolean;
  /** The range argv: `base...branch`, or the empty tree → HEAD for a bootstrap. */
  diffArgs: string[];
  /** What the review surfaces in place of a branch name. */
  label: string;
  /** The range for error text. */
  rangeDesc: string;
  /** The repo's registered gate commands (the integrity scan's named scripts). */
  gateCommands: string[];
}

/**
 * Resolve every ACTIVE write repo on the ticket to either a runnable {@link DiffTarget}
 * or an already-final unavailable entry (no branch, no local_path, not on disk).
 * Pure DB + filesystem reads; never spawns git.
 */
function resolveDiffTargets(
  deps: DiffServiceDeps,
  ticket: Ticket,
): Array<{ target: DiffTarget } | { unavailable: RepoDiff }> {
  const links = deps.repos.accessLinksForTicket(ticket.id);
  const writeRepos = links.filter(
    (l) => isActiveTicketRepoRelation(l.relation) && l.access === "write",
  );

  return writeRepos.map((repo) => {
    const baseBranch = repo.default_branch || "main";
    const legacyBranch = deps.repos.ticketRepoBranch(ticket.id, repo.id);
    const deliveryBranch = deps.repoDeliveries.find(ticket.id, repo.id)?.branch_name ?? null;
    const branch =
      nonEmpty(legacyBranch) ?? nonEmpty(deliveryBranch) ?? nonEmpty(ticket.branch_name);

    // Greenfield BOOTSTRAP: no delivery branch because the repo was git-init'd and the
    // scaffold committed straight to the default branch — there's no base to diff
    // against, so review the INITIAL COMMIT itself (git's empty tree → the branch).
    const isBootstrap = !branch && Boolean(ticket.bootstrap);

    if (!branch && !isBootstrap) {
      return {
        unavailable: unavailableRepo(
          repo.name,
          null,
          baseBranch,
          "no_branch",
          "No delivery branch recorded for this repo yet.",
        ),
      };
    }
    if (!repo.local_path || repo.local_path.trim() === "") {
      return {
        unavailable: unavailableRepo(
          repo.name,
          branch,
          baseBranch,
          "no_local_path",
          "Repo has no local_path on disk to diff against.",
        ),
      };
    }
    if (!existsSync(repo.local_path)) {
      return {
        unavailable: unavailableRepo(
          repo.name,
          branch,
          baseBranch,
          "repo_not_on_disk",
          `Repo path "${repo.local_path}" is not on disk.`,
        ),
      };
    }

    // Diff range: a normal ticket is base...branch; a bootstrap is the empty tree →
    // the default branch (every scaffolded file shown as an addition).
    // Bootstrap diffs the empty tree against HEAD — always valid, and independent of
    // the recorded default_branch (which can be unreliable on a fresh onboard).
    return {
      target: {
        repoId: repo.id,
        repo: repo.name,
        localPath: repo.local_path,
        baseBranch,
        branch,
        isBootstrap,
        diffArgs: isBootstrap ? [GIT_EMPTY_TREE, "HEAD"] : [`${baseBranch}...${branch}`],
        label: isBootstrap ? "initial commit" : branch!,
        rangeDesc: isBootstrap ? "the initial commit" : `${baseBranch}...${branch}`,
        gateCommands: [repo.test_command, repo.lint_command].filter(
          (c): c is string => typeof c === "string" && c.trim() !== "",
        ),
      },
    };
  });
}

/** Run `git diff --numstat` for a target; a truncated read drops its partial last line. */
function runNumstat(runGit: GitRunner, t: DiffTarget): GitResult {
  const res = runGit(t.localPath, ["diff", "--numstat", ...SAFE_DIFF_FLAGS, ...t.diffArgs], {
    maxBuffer: NUMSTAT_MAX_BUFFER,
  });
  if (res.truncated) {
    const cut = res.stdout.lastIndexOf("\n");
    return { ...res, stdout: cut === -1 ? "" : res.stdout.slice(0, cut + 1) };
  }
  return res;
}

/**
 * GATE INTEGRITY for one diff target: the base..head integrity findings, read from the
 * real repo (merge-base of the default branch and the delivery branch, so the default
 * branch moving on does not count as the delivery deleting anything). A git failure is
 * an `incomplete` finding — it flags, never passes silently.
 */
function testIntegrityFor(runGit: GitRunner, t: DiffTarget): TestIntegrityFindings {
  const git = (args: readonly string[], opts?: { maxBuffer?: number }): GitResult =>
    runGit(t.localPath, args, opts);
  const opts = {
    gateScriptNames: gateScriptNamesOf(t.gateCommands),
    extraTestPathRe: extraTestPathRe(process.env.GAFFER_TEST_PATH_RE),
  };
  if (t.isBootstrap) return collectTestIntegrity(git, GIT_EMPTY_TREE, "HEAD", opts);
  const mb = runGit(t.localPath, ["merge-base", t.baseBranch, t.branch!]);
  const base = mb.status === 0 ? mb.stdout.trim() : "";
  if (!/^[0-9a-f]{40,64}$/.test(base)) {
    return {
      deleted: [],
      renamed: [],
      markers: [],
      scripts: [],
      configs: [],
      incomplete: [`could not find where ${t.branch} branched from ${t.baseBranch}`],
    };
  }
  return collectTestIntegrity(git, base, t.branch!, opts);
}

/**
 * Compute the diff-in-review payload for a ticket. Resolves the ticket, walks its
 * ACTIVE write repos, and for each computes the real git diff of its delivery
 * branch against the repo's default branch. Pure read — never mutates state.
 */
export function computeTicketDiff(deps: DiffServiceDeps, ticketRef: string): TicketDiff {
  const runGit = deps.runGit ?? defaultGitRunner;
  const ticket = deps.tickets.findById(ticketRef) ?? resolveByNumber(deps.tickets, ticketRef);
  if (!ticket) {
    // Resolution is the caller's responsibility; an unresolved ref yields nothing.
    return { ticketId: ticketRef, repos: [] };
  }

  const repos: RepoDiff[] = resolveDiffTargets(deps, ticket).map((entry) => {
    if ("unavailable" in entry) return entry.unavailable;
    const t = entry.target;

    // Stats first (cheap, bounded). A non-zero exit means the range can't be resolved
    // (unknown branch, not a git repo) — surface it as a git_error.
    const stat = runNumstat(runGit, t);
    if (stat.status !== 0) {
      return unavailableRepo(
        t.repo,
        t.label,
        t.baseBranch,
        "git_error",
        firstLine(stat.stderr) || `git could not diff ${t.rangeDesc}.`,
      );
    }
    const { files, additions, deletions, paths } = parseNumstat(stat.stdout);
    // ADVISORY risk flags for the reviewer — computed from the real changed paths +
    // deletion count. Never gates; the authoritative diff below is unchanged.
    // GATE INTEGRITY adds `test-modified` (deleted/renamed tests, new skip markers, a
    // rewritten gate script): advisory here too, but observedRisk.ts makes an unallowed
    // one a hard hold on the auto-ship path.
    const testAnn = testModifiedAnnotation(
      testIntegrityFor(runGit, t),
      ticket.allow_test_changes === 1,
    );
    const riskAnnotations = [
      ...computeRiskAnnotations(paths, deletions),
      ...(testAnn ? [testAnn] : []),
    ];

    // The runner stops git once the patch passes its cap and flags `truncated`: a
    // lockfile regeneration or fixture drop is still a real diff, shown capped.
    const patch = runGit(t.localPath, ["diff", ...SAFE_DIFF_FLAGS, ...t.diffArgs]);
    if (patch.status !== 0) {
      return unavailableRepo(
        t.repo,
        t.label,
        t.baseBranch,
        "git_error",
        firstLine(patch.stderr) || `git could not diff ${t.rangeDesc}.`,
      );
    }
    const rawDiff = patch.stdout;
    if (rawDiff.trim() === "") {
      return unavailableRepo(
        t.repo,
        t.label,
        t.baseBranch,
        "empty",
        t.isBootstrap
          ? "The bootstrap produced no committed files."
          : `No changes between ${t.baseBranch} and ${t.branch}.`,
      );
    }

    const truncated =
      patch.truncated === true || Buffer.byteLength(rawDiff, "utf8") > MAX_DIFF_BYTES;
    const diff = capUtf8(rawDiff, MAX_DIFF_BYTES);

    return {
      repo: t.repo,
      branch: t.label,
      baseBranch: t.baseBranch,
      diff,
      files,
      additions,
      deletions,
      truncated,
      riskAnnotations,
    };
  });

  return { ticketId: ticket.id, repos };
}

/**
 * The done gate's view of the delivery: whether at least one write repo has a real,
 * non-empty git diff on its recorded branch, plus a fingerprint of the inputs that
 * answer depends on (which repos, which paths, which ranges).
 *
 * Callers compute this BEFORE they open a write transaction, so git never runs while
 * the database write lock is held; inside the transaction the gate re-derives only
 * the fingerprint (no git) and trusts `hasDiff` when it still matches.
 */
export interface DeliveryDiffProof {
  hasDiff: boolean;
  fingerprint: string;
}

/**
 * The git-free fingerprint of what {@link deliveryDiffProof} diffs for a ticket. Two
 * calls that return the same string ran (or would run) the same git commands.
 */
export function deliveryDiffFingerprint(deps: DiffServiceDeps, ticket: Ticket): string {
  return JSON.stringify(
    resolveDiffTargets(deps, ticket).map((entry) =>
      "unavailable" in entry
        ? ["unavailable", entry.unavailable.repo, entry.unavailable.unavailable]
        : [entry.target.repoId, entry.target.localPath, ...entry.target.diffArgs],
    ),
  );
}

/**
 * Compute the done gate's {@link DeliveryDiffProof}. One `--numstat` spawn per write
 * repo — the gate only needs "is the diff non-empty", never the patch text — and a
 * repo qualifies only when git succeeded and reported at least one changed path.
 */
export function deliveryDiffProof(deps: DiffServiceDeps, ticket: Ticket): DeliveryDiffProof {
  const runGit = deps.runGit ?? defaultGitRunner;
  const entries = resolveDiffTargets(deps, ticket);
  const hasDiff = entries.some((entry) => {
    if ("unavailable" in entry) return false;
    const stat = runNumstat(runGit, entry.target);
    return stat.status === 0 && parseNumstat(stat.stdout).files > 0;
  });
  return { hasDiff, fingerprint: deliveryDiffFingerprint(deps, ticket) };
}

/** Trimmed value when non-empty, else null — for branch precedence coalescing. */
function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Resolve a `#123`/`123` ticket reference by number (id lookup happens first). */
function resolveByNumber(tickets: TicketRepository, ref: string) {
  const asNumber = Number(ref.replace(/^#/, ""));
  if (!Number.isInteger(asNumber)) return undefined;
  return tickets.findByNumber(asNumber);
}

/** First non-empty line of a (possibly multi-line) stderr blob. */
function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t !== "") return t;
  }
  return "";
}

/** Cap a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function capUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off to a UTF-8 boundary: continuation bytes are 0b10xxxxxx.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}
