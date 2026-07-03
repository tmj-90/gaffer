/**
 * Lifecycle-mutation commands: add, suggest (including from-commit), review,
 * approve, reject, deprecate, supersede, verify, update, delete.
 *
 * These commands mutate lore records and represent the core trust-gate
 * workflow: agents suggest, humans review and approve/reject.
 */
import { basename } from "node:path";
import { execFileSync, execSync } from "node:child_process";

import {
  addLore,
  approveLore,
  deleteLore,
  deprecateLore,
  findPossibleDuplicates,
  getLore,
  listDrafts,
  rejectLore,
  supersedeLore,
  suggestLore,
  updateLore,
  verifyLore,
} from "../../core/lore.js";
import { openDb } from "../../db/index.js";
import type { LoreConfidence } from "../../db/types.js";
import { LORE_KINDS } from "../../db/types.js";
import type { LoreKind } from "../../db/types.js";
import { getBool, getString, getStringArray } from "../args.js";
import type { parseArgs } from "../args.js";
import { renderFull, renderSummary } from "../format.js";
import { prompt, promptMulti } from "../prompt.js";
import { shortRepoNameFromRemote } from "../setup.js";

function parseConfidence(v: string | undefined): LoreConfidence | undefined {
  if (v === undefined) return undefined;
  if (v === "low" || v === "medium" || v === "high") return v;
  throw new Error(`invalid --confidence: ${v} (must be low | medium | high)`);
}

const LORE_KIND_SET = new Set<string>(LORE_KINDS);

/**
 * Validate a caller-supplied `--kind` for a lore draft. Returns undefined when
 * absent (core defaults it to 'other'); throws a typed error on an unknown
 * kind so a distiller passing a bad classifier fails fast.
 */
function parseKind(v: string | undefined): LoreKind | undefined {
  if (v === undefined) return undefined;
  const k = v.trim();
  if (!LORE_KIND_SET.has(k)) {
    throw new Error(`invalid --kind: ${v} (must be one of ${LORE_KINDS.join(", ")})`);
  }
  return k as LoreKind;
}

/**
 * Best-effort autodetect of a repo name for the current directory.
 *
 * Order of preference:
 *   1. `git config --get remote.origin.url` parsed to a short name —
 *      this is the most canonical when present (a clone of
 *      `github.com/foo/payments-svc` should tag drafts as
 *      `payments-svc` even if the local folder is `payments-clone`).
 *   2. `basename(process.cwd())` — what the user almost always wants
 *      when run inside a folder they care about with no remote
 *      configured (local-only repo, just-init'd project, monorepo
 *      subdir, etc.).
 *
 * Returns `{ name, source }` so the caller can phrase the
 * confirmation prompt honestly ("Detected repo 'foo' from git remote"
 * vs "from current directory"). Returns null only when both fall
 * through (cwd basename is empty / "/" — exceedingly rare).
 */
export function detectRepoName(): { name: string; source: "git" | "cwd" } | null {
  try {
    const out = execSync("git config --get remote.origin.url", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const fromRemote = shortRepoNameFromRemote(out);
    if (fromRemote) return { name: fromRemote, source: "git" };
  } catch {
    // No git repo, no remote, or weird URL — fall through to cwd.
  }
  const fromCwd = basename(process.cwd());
  if (fromCwd && fromCwd !== "/" && fromCwd !== ".") {
    return { name: fromCwd, source: "cwd" };
  }
  return null;
}

export async function cmdAdd(
  args: ReturnType<typeof parseArgs>,
  asDraft: boolean,
): Promise<number> {
  let title = getString(args.flags, "title");
  let summary = getString(args.flags, "summary");
  let body = getString(args.flags, "body");

  if (!title) title = (await prompt("Title: ")).trim();
  if (!title) {
    process.stderr.write("memory: title is required\n");
    return 1;
  }
  if (!summary) summary = (await prompt("Summary (one line): ")).trim();
  if (!body) body = (await promptMulti("Body:")).trim();
  if (!body) body = summary; // body falls back to summary if user skipped

  const repos = getStringArray(args.flags, "repo");
  const tags = getStringArray(args.flags, "tag");
  const team = getString(args.flags, "team");
  const author = getString(args.flags, "author") ?? process.env["USER"];
  const source = getString(args.flags, "source");
  const reviewAfter = getString(args.flags, "review-after");
  const confidence = parseConfidence(getString(args.flags, "confidence"));
  const restricted = getBool(args.flags, "restricted");
  const kind = parseKind(getString(args.flags, "kind"));
  // Structured provenance (Spec-Driven Development, Phase 2b): when Dispatch
  // seeds a frozen spec clause it stamps the (spec, clause) linkage so a later
  // phase can JOIN the record back to the exact clause it came from.
  const specId = getString(args.flags, "spec-id");
  const clauseId = getString(args.flags, "clause-id");

  const db = openDb();
  try {
    const loreInput = {
      title,
      summary,
      body,
      repos,
      tags,
      team,
      author,
      source,
      reviewAfter,
      confidence,
      restricted,
      ...(kind ? { kind } : {}),
      ...(specId ? { specId } : {}),
      ...(clauseId ? { clauseId } : {}),
    };
    // AUTO-APPROVE: the CLI suggest path now honours MEMORY_AUTO_APPROVE=1 too — the SAME
    // env the MCP suggest_lore already respects (mcp/server.ts). When set, a suggested
    // draft lands `active` immediately (an operator opting into unattended lore, e.g. the
    // runner's close-time product-intent distiller). `add` is already active.
    const lore = asDraft
      ? suggestLore(
          db,
          loreInput,
          process.env["MEMORY_AUTO_APPROVE"] === "1" ? { autoApprove: true } : undefined,
        )
      : addLore(db, loreInput);
    process.stdout.write(
      `memory: ${asDraft ? "suggested" : "added"} ${lore.id} (${lore.status})\n`,
    );
    // For drafts (lore suggest), surface near-duplicates so the human
    // reviewing the queue isn't surprised later. Quiet for `memory add` —
    // humans entering their own records have already decided.
    //
    // CLI runs locally as the trust principal (the human at the terminal),
    // so restricted records ARE included in the hint list here. The
    // MCP path is different — that's env-gated.
    if (asDraft) {
      const { duplicates } = findPossibleDuplicates(
        db,
        { id: lore.id, title, repos, tags },
        { allowRestricted: true },
      );
      if (duplicates.length > 0) {
        process.stdout.write(`Possible duplicates (review with \`memory show <id>\`):\n`);
        for (const d of duplicates) {
          const restrictedTag = d.restricted ? " [restricted]" : "";
          process.stdout.write(
            `  ${d.id}  [${d.status}]${restrictedTag}  ${d.title}\n    reason: ${d.reason}\n`,
          );
        }
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `memory suggest --from-commit <sha>` — draft a record straight from a
 * commit message. Closes the "I wrote the rationale in the commit, why
 * retype it" gap (PRINCIPLES.md §6). Lands as a DRAFT like every other
 * agent-shaped capture; the reviewer promotes via `memory review`.
 *
 * Source URL is auto-derived from the commit + `remote.origin.url` so the
 * draft carries provenance (and clears `medium` confidence) without the
 * user pasting a permalink. `--repo`/`--tag` layer on as usual; `--source`
 * overrides the auto-derived URL.
 */
export async function cmdSuggestFromCommit(
  args: ReturnType<typeof parseArgs>,
  sha: string,
): Promise<number> {
  const { commitToDraftFields, commitUrlFromRemote, FIELD_SEP, parseCommitShow } =
    await import("../commit.js");
  let raw: string;
  try {
    // execFileSync (no shell) so the sha can't be shell-injected and the
    // field separator survives intact as a literal arg.
    raw = execFileSync("git", ["show", "-s", `--format=%H${FIELD_SEP}%s${FIELD_SEP}%b`, sha], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    process.stderr.write(
      `memory: couldn't read commit '${sha}' — is this a git repo and a valid ref?\n`,
    );
    return 1;
  }
  const commit = parseCommitShow(raw);
  if (!commit) {
    process.stderr.write(`memory: commit '${sha}' produced no usable message\n`);
    return 1;
  }
  // Source precedence: explicit --source wins; else derive a commit
  // permalink from the remote (best-effort, may be null for local repos).
  const explicitSource = getString(args.flags, "source");
  let source: string | null = explicitSource ?? null;
  if (!source) {
    try {
      const remote = execSync("git config --get remote.origin.url", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      source = commitUrlFromRemote(remote, commit.sha);
    } catch {
      source = null;
    }
  }
  const fields = commitToDraftFields(commit, source);
  const repos = getStringArray(args.flags, "repo");
  const tags = getStringArray(args.flags, "tag");
  // Auto-detect repo when none given (git remote → cwd basename).
  const finalRepos =
    repos.length > 0
      ? repos
      : (() => {
          const det = detectRepoName();
          return det ? [det.name] : [];
        })();

  const db = openDb();
  try {
    const lore = suggestLore(db, {
      title: fields.title,
      summary: fields.summary,
      body: fields.body,
      repos: finalRepos.length > 0 ? finalRepos : undefined,
      tags,
      source: fields.source,
      confidence: fields.confidence,
      author: "from-commit",
    });
    process.stdout.write(
      `memory: suggested ${lore.id} (draft) from commit ${commit.sha.slice(0, 12)}\n` +
        `  ${lore.title}\n` +
        (fields.source ? `  source: ${fields.source}\n` : "") +
        `Review with \`memory review\` (or \`memory show ${lore.id}\`).\n`,
    );
    const { duplicates } = findPossibleDuplicates(
      db,
      { id: lore.id, title: fields.title, repos: finalRepos, tags },
      { allowRestricted: true },
    );
    if (duplicates.length > 0) {
      process.stdout.write(`Possible duplicates (review with \`memory show <id>\`):\n`);
      for (const d of duplicates) {
        const restrictedTag = d.restricted ? " [restricted]" : "";
        process.stdout.write(
          `  ${d.id}  [${d.status}]${restrictedTag}  ${d.title}\n    reason: ${d.reason}\n`,
        );
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdReview(args: ReturnType<typeof parseArgs>): Promise<number> {
  const db = openDb();
  try {
    const drafts = listDrafts(db);
    if (drafts.length === 0) {
      process.stdout.write("memory: no pending drafts.\n");
      return 0;
    }

    // Two modes: default is interactive (per-draft a/r/e/s/q triage).
    // `--list` or non-TTY stdin falls back to the old "print them all" view
    // so `memory review | grep` doesn't hang.
    const listOnly = getBool(args.flags, "list") || !process.stdin.isTTY;

    if (listOnly) {
      process.stdout.write(`${drafts.length} draft(s) awaiting review:\n\n`);
      for (const d of drafts) process.stdout.write(renderSummary(d) + "\n\n");
      process.stdout.write(
        "Use `memory approve <id>` to promote, or `memory reject <id>` to drop.\n",
      );
      return 0;
    }

    // Interactive triage queue. Iterate drafts oldest-first (createdAt asc
    // happens to also be the natural triage order — first in, first reviewed).
    process.stdout.write(
      `${drafts.length} draft(s) awaiting review. Press q to quit at any time.\n\n`,
    );
    let approved = 0;
    let rejected = 0;
    let skipped = 0;
    for (let i = 0; i < drafts.length; i++) {
      const d = drafts[i]!;
      const full = getLore(db, d.id);
      if (!full) continue; // raced / deleted

      process.stdout.write(`── Draft ${i + 1} of ${drafts.length} ──\n`);
      process.stdout.write(renderFull(full) + "\n\n");
      const answer = (await prompt("[a]pprove  [r]eject  [e]dit  [s]kip  [q]uit  > "))
        .trim()
        .toLowerCase();

      if (answer === "q" || answer === "quit" || answer === "exit") {
        process.stdout.write("\nmemory: stopped.\n");
        break;
      }
      if (answer === "a" || answer === "approve" || answer === "y") {
        const promoted = approveLore(db, d.id);
        process.stdout.write(
          promoted ? `✓ approved ${d.id}\n\n` : `✗ could not approve ${d.id}\n\n`,
        );
        if (promoted) approved++;
        continue;
      }
      if (answer === "r" || answer === "reject" || answer === "n") {
        // Capture an optional reason so the agent (or future-me) can see
        // *why* a draft was dropped — keeps the feedback loop closed.
        // Blank/whitespace is normalised to "no reason" inside rejectLore.
        const reasonInput = (await prompt("  reason (optional, blank to skip): ")).trim();
        const ok = rejectLore(db, d.id, reasonInput || undefined);
        process.stdout.write(ok ? `✗ rejected ${d.id}\n\n` : `! could not reject ${d.id}\n\n`);
        if (ok) rejected++;
        continue;
      }
      if (answer === "e" || answer === "edit") {
        // Don't reach for $EDITOR yet — print the update command the user
        // can paste with their preferred shell tooling. Keeps the prompt
        // loop simple; user can come back to `memory review` next.
        process.stdout.write(
          `\nTo edit this draft, run:\n` +
            `  memory update ${d.id} --summary "..." --body "..."\n` +
            `Then re-run \`memory review\` to triage it again.\n\n`,
        );
        skipped++;
        continue;
      }
      // Anything else (including bare Enter) is treated as skip.
      process.stdout.write(`… skipped ${d.id}\n\n`);
      skipped++;
    }

    const tally = `approved: ${approved}  rejected: ${rejected}  skipped: ${skipped}`;
    process.stdout.write(`\nReview complete. ${tally}\n`);
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdReject(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("memory: reject <id> requires an id\n");
    return 2;
  }
  // getString returns undefined for a bare `--reason` (no value) too,
  // so a missing value can't be silently coerced to the literal "true".
  const reason = getString(args.flags, "reason");
  const db = openDb();
  try {
    const ok = rejectLore(db, id, reason);
    if (!ok) {
      process.stderr.write(
        `memory: cannot reject ${id} (unknown id or not a draft; use \`memory deprecate\` for active records)\n`,
      );
      return 1;
    }
    process.stdout.write(`memory: rejected ${id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdApprove(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("memory: approve <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const lore = approveLore(db, id);
    if (!lore) {
      process.stderr.write(
        `memory: ${id} is not a pending draft (already active, deprecated, or unknown)\n`,
      );
      return 1;
    }
    process.stdout.write(`memory: approved ${lore.id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdDeprecate(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("memory: deprecate <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const lore = deprecateLore(db, id);
    if (!lore) {
      process.stderr.write(`memory: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(`memory: deprecated ${lore.id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdSupersede(args: ReturnType<typeof parseArgs>): Promise<number> {
  const oldId = args.positionals[0];
  const newId = getString(args.flags, "with");
  if (!oldId || !newId) {
    process.stderr.write("memory: supersede <old-id> --with <new-id>\n");
    return 2;
  }
  const db = openDb();
  try {
    const lore = supersedeLore(db, oldId, newId);
    if (!lore) {
      process.stderr.write(
        `memory: couldn't supersede ${oldId} with ${newId} (check both ids exist and are not the same)\n`,
      );
      return 1;
    }
    process.stdout.write(`memory: ${oldId} superseded by ${newId}\n`);
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdVerify(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("memory: verify <id> requires an id\n");
    return 2;
  }
  const reviewAfter = getString(args.flags, "review-after");
  const db = openDb();
  try {
    const lore = verifyLore(db, id, reviewAfter);
    if (!lore) {
      process.stderr.write(`memory: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(
      `memory: verified ${lore.id}` +
        ` (at ${lore.lastVerifiedAt}` +
        (lore.reviewAfter ? `; next review ${lore.reviewAfter}` : "") +
        `)\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdUpdate(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("memory: update <id> requires an id\n");
    return 2;
  }
  const title = getString(args.flags, "title");
  const summary = getString(args.flags, "summary");
  const body = getString(args.flags, "body");
  const source = getString(args.flags, "source");
  const reviewAfter = getString(args.flags, "review-after");
  const confidence = parseConfidence(getString(args.flags, "confidence"));
  const team = getString(args.flags, "team");
  const author = getString(args.flags, "author");
  const reposFlag = getStringArray(args.flags, "repo");
  const tagsFlag = getStringArray(args.flags, "tag");
  const clearSource = getBool(args.flags, "clear-source");
  const clearRepos = getBool(args.flags, "clear-repos");
  const clearTags = getBool(args.flags, "clear-tags");
  const restricted =
    args.flags["restricted"] === true
      ? true
      : args.flags["unrestricted"] === true
        ? false
        : undefined;

  // R5 — refuse contradictory combinations rather than silently picking one.
  if (clearSource && source !== undefined) {
    process.stderr.write("memory: --clear-source conflicts with --source <url>; pick one\n");
    return 2;
  }
  if (clearRepos && reposFlag.length > 0) {
    process.stderr.write("memory: --clear-repos conflicts with --repo; pick one\n");
    return 2;
  }
  if (clearTags && tagsFlag.length > 0) {
    process.stderr.write("memory: --clear-tags conflicts with --tag; pick one\n");
    return 2;
  }

  // Build a tight partial-input — only include keys the user actually passed.
  const patch: Record<string, unknown> = {};
  if (title !== undefined) patch["title"] = title;
  if (summary !== undefined) patch["summary"] = summary;
  if (body !== undefined) patch["body"] = body;
  if (clearSource) patch["source"] = "";
  else if (source !== undefined) patch["source"] = source;
  if (reviewAfter !== undefined) patch["reviewAfter"] = reviewAfter;
  if (confidence !== undefined) patch["confidence"] = confidence;
  if (team !== undefined) patch["team"] = team;
  if (author !== undefined) patch["author"] = author;
  if (clearRepos) patch["repos"] = [];
  else if (reposFlag.length > 0) patch["repos"] = reposFlag;
  if (clearTags) patch["tags"] = [];
  else if (tagsFlag.length > 0) patch["tags"] = tagsFlag;
  if (restricted !== undefined) patch["restricted"] = restricted;

  if (Object.keys(patch).length === 0) {
    process.stderr.write(
      "memory: update needs at least one field flag (--title, --summary, --body, --source, --clear-source, --review-after, --confidence, --team, --repo, --clear-repos, --tag, --clear-tags, --restricted/--unrestricted)\n",
    );
    return 2;
  }

  const db = openDb();
  try {
    const lore = updateLore(db, id, patch as Parameters<typeof updateLore>[2]);
    if (!lore) {
      process.stderr.write(`memory: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(`memory: updated ${lore.id}\n`);
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdDelete(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("memory: delete <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const ok = deleteLore(db, id);
    if (!ok) {
      process.stderr.write(`memory: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(`memory: deleted ${id}\n`);
    return 0;
  } finally {
    db.close();
  }
}
