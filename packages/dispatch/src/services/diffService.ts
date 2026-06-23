import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { isActiveTicketRepoRelation } from "../domain/types.js";
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
  | "no_branch"
  | "repo_not_on_disk"
  | "no_local_path"
  | "empty"
  | "git_error";

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
}

export type GitRunner = (cwd: string, args: readonly string[]) => GitResult;

/**
 * Default git runner: no shell, fixed `git` binary, args array — request/branch
 * values are passed as argv elements, never interpolated into a command line, so
 * there is no command-injection surface from a recorded branch name.
 */
export const defaultGitRunner: GitRunner = (cwd, args) => {
  const res = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_DIFF_BYTES * 4,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
};

/** Parse `git diff --numstat` output into {files, additions, deletions}. */
function parseNumstat(out: string): { files: number; additions: number; deletions: number } {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    files += 1;
    // Binary files are reported as "-\t-\tpath"; treat them as 0/0.
    const add = Number.parseInt(parts[0]!, 10);
    const del = Number.parseInt(parts[1]!, 10);
    if (Number.isInteger(add)) additions += add;
    if (Number.isInteger(del)) deletions += del;
  }
  return { files, additions, deletions };
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
  };
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

  const links = deps.repos.accessLinksForTicket(ticket.id);
  const writeRepos = links.filter(
    (l) => isActiveTicketRepoRelation(l.relation) && l.access === "write",
  );

  const repos: RepoDiff[] = writeRepos.map((repo) => {
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
      return unavailableRepo(
        repo.name,
        null,
        baseBranch,
        "no_branch",
        "No delivery branch recorded for this repo yet.",
      );
    }
    if (!repo.local_path || repo.local_path.trim() === "") {
      return unavailableRepo(
        repo.name,
        branch,
        baseBranch,
        "no_local_path",
        "Repo has no local_path on disk to diff against.",
      );
    }
    if (!existsSync(repo.local_path)) {
      return unavailableRepo(
        repo.name,
        branch,
        baseBranch,
        "repo_not_on_disk",
        `Repo path "${repo.local_path}" is not on disk.`,
      );
    }

    // Diff range: a normal ticket is base...branch; a bootstrap is the empty tree →
    // the default branch (every scaffolded file shown as an addition). `label` is what
    // the review surfaces in place of a branch name; `rangeDesc` is for error text.
    // Bootstrap diffs the empty tree against HEAD — always valid, and independent of
    // the recorded default_branch (which can be unreliable on a fresh onboard).
    const diffArgs = isBootstrap ? [GIT_EMPTY_TREE, "HEAD"] : [`${baseBranch}...${branch}`];
    const label = isBootstrap ? "initial commit" : branch;
    const rangeDesc = isBootstrap ? "the initial commit" : `${baseBranch}...${branch}`;

    // Stats first (cheap, bounded). A non-zero exit means the range can't be resolved
    // (unknown branch, not a git repo) — surface it as a git_error.
    const stat = runGit(repo.local_path, ["diff", "--numstat", ...diffArgs]);
    if (stat.status !== 0) {
      return unavailableRepo(
        repo.name,
        label,
        baseBranch,
        "git_error",
        firstLine(stat.stderr) || `git could not diff ${rangeDesc}.`,
      );
    }
    const { files, additions, deletions } = parseNumstat(stat.stdout);

    const patch = runGit(repo.local_path, ["diff", ...diffArgs]);
    if (patch.status !== 0) {
      return unavailableRepo(
        repo.name,
        label,
        baseBranch,
        "git_error",
        firstLine(patch.stderr) || `git could not diff ${rangeDesc}.`,
      );
    }
    const rawDiff = patch.stdout;
    if (rawDiff.trim() === "") {
      return unavailableRepo(
        repo.name,
        label,
        baseBranch,
        "empty",
        isBootstrap
          ? "The bootstrap produced no committed files."
          : `No changes between ${baseBranch} and ${branch}.`,
      );
    }

    const truncated = Buffer.byteLength(rawDiff, "utf8") > MAX_DIFF_BYTES;
    const diff = truncated ? capUtf8(rawDiff, MAX_DIFF_BYTES) : rawDiff;

    return {
      repo: repo.name,
      branch: label,
      baseBranch,
      diff,
      files,
      additions,
      deletions,
      truncated,
    };
  });

  return { ticketId: ticket.id, repos };
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
