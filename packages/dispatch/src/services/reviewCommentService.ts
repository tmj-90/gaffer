import { createHash } from "node:crypto";

import type { Db } from "../db/connection.js";
import { inTransaction } from "../db/connection.js";
import type { Actor, Ticket } from "../domain/types.js";
import { writeEvent } from "../events/eventWriter.js";
import type { Clock } from "../util/clock.js";
import { DispatchError } from "../util/errors.js";
import { newId } from "../util/id.js";
import type { GitRunner } from "./diffService.js";

/**
 * REVIEW COMMENTS (schema v32): a human reviewer's comments on a delivery, on a diff line,
 * a file or the whole change, with a resolution state that survives across revisions.
 *
 * Facts, never claims:
 *  - the anchor (`anchor_sha`, `anchor_excerpt`, `anchor_hash`) is read from git at the
 *    commit the reviewer saw, so a later revision can be compared with it;
 *  - "anchor changed in this revision" / "anchor untouched" is computed from
 *    `git diff <anchor_sha> <head> -- <path>` ({@link anchorStateOf}), never from what an
 *    agent says it fixed;
 *  - resolving, reopening and withdrawing are human acts: an agent (or the runner) is
 *    refused every write here, so a delivery agent can never resolve its reviewer's ask.
 *
 * The state is mutable, so it lives in its own table and stays OUTSIDE the delivery
 * dossier's hashed subject; each write records a `review.comment_*` work event (ids,
 * severity and the body's sha256, not the body) so the tamper-evident log keeps the audit.
 */

export const REVIEW_COMMENT_SEVERITIES = ["must_fix", "consider"] as const;
export type ReviewCommentSeverity = (typeof REVIEW_COMMENT_SEVERITIES)[number];
export const REVIEW_COMMENT_STATUSES = ["open", "resolved", "withdrawn"] as const;
export type ReviewCommentStatus = (typeof REVIEW_COMMENT_STATUSES)[number];

/** How many lines either side of the anchored line the excerpt keeps. */
export const ANCHOR_CONTEXT_LINES = 3;
/** The longest comment body accepted. */
export const MAX_COMMENT_BODY = 20_000;

/** One stored comment (the table row). */
export interface ReviewComment {
  id: string;
  ticket_id: string;
  repo_id: string | null;
  path: string | null;
  side: "new" | "old" | null;
  line: number | null;
  anchor_sha: string | null;
  anchor_excerpt: string | null;
  anchor_hash: string | null;
  body: string;
  severity: ReviewCommentSeverity;
  status: ReviewCommentStatus;
  author_type: "human" | "admin";
  author_id: string | null;
  round: number;
  sent_round: number | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolved_at_sha: string | null;
}

/**
 * Whether the anchored code moved since the comment was written, from git:
 *  - `current`: the repo head is still the commit the comment was written against;
 *  - `untouched`: the head moved, but no hunk of `anchor_sha..head -- path` touches the
 *    anchored lines (a line comment) or the file (a file comment, an old-side comment);
 *  - `changed`: a hunk touches them, or the file was deleted or renamed away;
 *  - `unknown`: git cannot answer (the anchor commit is gone, the repo is not on disk,
 *    no head resolves);
 *  - null: a comment on the whole change has no anchor.
 */
export type AnchorState = "current" | "untouched" | "changed" | "unknown";

/** A comment as the read surfaces return it: the row, a short id and the derived facts. */
export interface ReviewCommentView extends ReviewComment {
  /** The first 8 characters of the id: what the CLI, the prompt and reasons print. */
  short_id: string;
  /** The repository's name (null for a ticket-level comment or a removed repo). */
  repo: string | null;
  /** Git-derived, see {@link AnchorState}. Only computed when asked (it runs git). */
  anchor_state?: AnchorState | null;
  /** The head the anchor state was computed against. */
  anchor_head?: string | null;
  /**
   * The delivery agent's replies to this comment (agent evidence, payload
   * `{kind:"comment_reply", comment_id}`): a CLAIM about what it did, never a resolution.
   */
  agent_replies?: Array<{ evidence_id: string; summary: string; created_at: string }>;
}

/** A write repository the comments can anchor to, resolved by the caller (Dispatch). */
export interface CommentRepoContext {
  repoId: string;
  repo: string;
  localPath: string;
  baseBranch: string;
  branch: string;
  /** The delivery branch head now, or null when it does not resolve. */
  head: string | null;
}

export interface CreateCommentInput {
  body: string;
  severity?: ReviewCommentSeverity | undefined;
  /** Repository id or name; defaults to the only write repo when `path` is given. */
  repo?: string | null | undefined;
  path?: string | null | undefined;
  line?: number | null | undefined;
  side?: "new" | "old" | null | undefined;
  /** The head commit the reviewer saw (the diff's headSha); defaults to the head now. */
  commit?: string | null | undefined;
}

export interface ReviewCommentCounts {
  open: number;
  open_must_fix: number;
  resolved: number;
  withdrawn: number;
}

export interface ReviewCommentServiceDeps {
  db: Db;
  clock: Clock;
  runGit: GitRunner;
  resolveTicket: (ref: string) => Ticket;
  /** The ticket's ACTIVE write repos with their heads (Dispatch.commentRepoContexts). */
  repoContexts: (ticket: Ticket) => CommentRepoContext[];
}

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
/** Statuses a new comment may be written in: the review, and Refining after a send-back. */
const COMMENTABLE = new Set(["in_review", "refining"]);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Refuse every actor but a person (human) or an admin: resolving is a human act. */
function assertHuman(actor: Actor, what: string): void {
  if (actor.type === "human" || actor.type === "admin") return;
  throw new DispatchError(
    "ACTOR_NOT_PERMITTED",
    `${what} is a reviewer's act: only a human or an admin may do it (this actor is ${actor.type}). A delivery agent answers a comment with a reply (agent evidence), which is a claim, never a resolution.`,
    { actor_type: actor.type, reason: "reviewer_only" },
  );
}

/** Normalise a repo-relative path: no leading "./" or "/", no "..", no NUL. */
function cleanPath(p: string): string {
  const v = p
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
  if (!v || v.includes("\0") || v.split("/").includes("..")) {
    throw new DispatchError("VALIDATION_ERROR", `"${p}" is not a path inside the repository.`, {
      path: p,
    });
  }
  return v;
}

/** The file at `rev:path` as lines, or null when git cannot show it. */
function fileLines(runGit: GitRunner, ctx: CommentRepoContext, rev: string, path: string) {
  const res = runGit(ctx.localPath, ["show", `${rev}:${path}`], { maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) return null;
  const text = res.stdout.endsWith("\n") ? res.stdout.slice(0, -1) : res.stdout;
  return text.split("\n");
}

/** The commit the old side of the review diff is read from: merge-base(base, head). */
function oldSideRev(runGit: GitRunner, ctx: CommentRepoContext, head: string): string | null {
  const mb = runGit(ctx.localPath, ["merge-base", ctx.baseBranch, head]);
  const sha = mb.status === 0 ? mb.stdout.trim().toLowerCase() : "";
  return SHA_RE.test(sha) ? sha : null;
}

/** Hunks of a `-U0` diff as old-side ranges [start, end] (an insertion is [n, n]). */
function oldHunkRanges(diff: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const start = Number(m[1]);
    const len = m[2] === undefined ? 1 : Number(m[2]);
    out.push(len === 0 ? [start, start + 1] : [start, start + len - 1]);
  }
  return out;
}

/**
 * The anchor state of one comment against `head` (see {@link AnchorState}). Pure read of
 * git: `git diff -U0 <anchor_sha> <head> -- <path>`.
 */
export function anchorStateOf(
  runGit: GitRunner,
  c: Pick<ReviewComment, "path" | "line" | "side" | "anchor_sha">,
  ctx: CommentRepoContext | undefined,
): AnchorState | null {
  if (!c.path) return null;
  if (!ctx || !ctx.head || !c.anchor_sha) return "unknown";
  if (c.anchor_sha === ctx.head) return "current";
  if (runGit(ctx.localPath, ["cat-file", "-e", `${c.anchor_sha}^{commit}`]).status !== 0)
    return "unknown";
  const res = runGit(ctx.localPath, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "-U0",
    c.anchor_sha,
    ctx.head,
    "--",
    c.path,
  ]);
  if (res.status !== 0) return "unknown";
  const out = res.stdout;
  if (out.trim() === "") return "untouched";
  if (/^deleted file mode/m.test(out)) return "changed";
  // A file comment, and an old-side line comment (the base the agent's commits do not
  // move), are judged at file level: any change to the file is a change to the anchor.
  if (c.line === null || c.side === "old") return "changed";
  const lo = Math.max(1, c.line - ANCHOR_CONTEXT_LINES);
  const hi = c.line + ANCHOR_CONTEXT_LINES;
  const touched = oldHunkRanges(out).some(([s, e]) => s <= hi && e >= lo);
  return touched ? "changed" : "untouched";
}

export class ReviewCommentService {
  constructor(private readonly deps: ReviewCommentServiceDeps) {}

  private get db(): Db {
    return this.deps.db;
  }

  private row(id: string): ReviewComment | undefined {
    return this.db.prepare("SELECT * FROM review_comments WHERE id = ?").get(id) as
      ReviewComment | undefined;
  }

  /** A comment by its id or a unique id prefix (>= 6 characters). */
  resolveComment(ref: string, ticketId?: string): ReviewComment {
    const v = String(ref || "").trim();
    const exact = this.row(v);
    if (exact && (!ticketId || exact.ticket_id === ticketId)) return exact;
    if (/^[0-9a-f-]{6,}$/i.test(v)) {
      const rows = this.db
        .prepare(
          `SELECT * FROM review_comments WHERE id LIKE ? ${ticketId ? "AND ticket_id = ?" : ""} LIMIT 2`,
        )
        .all(...[`${v.toLowerCase()}%`, ...(ticketId ? [ticketId] : [])]) as ReviewComment[];
      if (rows.length === 1) return rows[0]!;
      if (rows.length > 1)
        throw new DispatchError(
          "AMBIGUOUS_REF",
          `More than one review comment starts with "${v}"; give more of the id.`,
          { ref: v },
        );
    }
    throw new DispatchError("NOT_FOUND", `No review comment "${v}".`, { ref: v });
  }

  private repoNames(): Map<string, string> {
    const rows = this.db.prepare("SELECT id, name FROM repositories").all() as Array<{
      id: string;
      name: string;
    }>;
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private toView(c: ReviewComment, names: Map<string, string>): ReviewCommentView {
    return {
      ...c,
      short_id: c.id.slice(0, 8),
      repo: c.repo_id ? (names.get(c.repo_id) ?? null) : null,
    };
  }

  /** The ticket's comments, oldest first (`open`: only the open ones). Pure DB read. */
  listRows(ticketId: string, opts: { open?: boolean | undefined } = {}): ReviewComment[] {
    return this.db
      .prepare(
        `SELECT * FROM review_comments WHERE ticket_id = ? ${opts.open ? "AND status = 'open'" : ""}
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(ticketId) as ReviewComment[];
  }

  /** The comments as views (no git): what the ticket detail and the MCP carry. */
  listViews(ticketId: string, opts: { open?: boolean | undefined } = {}): ReviewCommentView[] {
    const names = this.repoNames();
    const replies = this.agentReplies(ticketId);
    return this.listRows(ticketId, opts).map((c) => ({
      ...this.toView(c, names),
      agent_replies: replies.get(c.id) ?? [],
    }));
  }

  /**
   * The comments with the git-derived anchor state against each repo's head now (A3:
   * "anchor changed in this revision" / "anchor untouched"). Runs git once per comment.
   */
  listWithAnchors(ref: string, opts: { open?: boolean | undefined } = {}): ReviewCommentView[] {
    const ticket = this.deps.resolveTicket(ref);
    const contexts = this.contextsSafe(ticket);
    return this.listViews(ticket.id, opts).map((v) => {
      const ctx = contexts.find((x) => x.repoId === v.repo_id);
      let state: AnchorState | null;
      try {
        state = anchorStateOf(this.deps.runGit, v, ctx);
      } catch {
        state = v.path ? "unknown" : null;
      }
      return { ...v, anchor_state: state, anchor_head: ctx?.head ?? null };
    });
  }

  private contextsSafe(ticket: Ticket): CommentRepoContext[] {
    try {
      return this.deps.repoContexts(ticket);
    } catch {
      return [];
    }
  }

  /** The delivery agent's per-comment replies (agent evidence, a claim). */
  private agentReplies(
    ticketId: string,
  ): Map<string, Array<{ evidence_id: string; summary: string; created_at: string }>> {
    const out = new Map<
      string,
      Array<{ evidence_id: string; summary: string; created_at: string }>
    >();
    const rows = this.db
      .prepare(
        `SELECT id, summary, created_at, json_extract(payload_json, '$.comment_id') AS cid
           FROM evidence
          WHERE ticket_id = ? AND recorded_by_actor_type = 'agent'
            AND json_valid(payload_json) AND json_extract(payload_json, '$.kind') = 'comment_reply'
          ORDER BY created_at ASC, rowid ASC`,
      )
      .all(ticketId) as Array<{ id: string; summary: string; created_at: string; cid: unknown }>;
    const all = this.listRows(ticketId);
    for (const r of rows) {
      const ref = typeof r.cid === "string" ? r.cid.trim().toLowerCase() : "";
      if (ref.length < 6) continue;
      // The agent names the comment by its id or its short id.
      const hit = all.find((c) => c.id === ref || c.id.startsWith(ref));
      if (!hit) continue;
      const list = out.get(hit.id) ?? [];
      list.push({ evidence_id: r.id, summary: r.summary, created_at: r.created_at });
      out.set(hit.id, list);
    }
    return out;
  }

  counts(ticketId: string): ReviewCommentCounts {
    const rows = this.db
      .prepare(
        `SELECT status, severity, COUNT(*) AS n FROM review_comments WHERE ticket_id = ?
          GROUP BY status, severity`,
      )
      .all(ticketId) as Array<{ status: ReviewCommentStatus; severity: string; n: number }>;
    const c: ReviewCommentCounts = { open: 0, open_must_fix: 0, resolved: 0, withdrawn: 0 };
    for (const r of rows) {
      c[r.status] += r.n;
      if (r.status === "open" && r.severity === "must_fix") c.open_must_fix += r.n;
    }
    return c;
  }

  /**
   * Write a comment. Line and file comments name a write repo (the only one by default)
   * and are anchored, from git, at the commit the reviewer saw (`commit`) or the head now.
   */
  create(ref: string, input: CreateCommentInput, actor: Actor): ReviewCommentView {
    assertHuman(actor, "Writing a review comment");
    const ticket = this.deps.resolveTicket(ref);
    if (!COMMENTABLE.has(ticket.status)) {
      throw new DispatchError(
        "ILLEGAL_TRANSITION",
        `A review comment can be written while a ticket is in review or in Refining (#${ticket.number ?? "?"} is ${ticket.status}).`,
        { status: ticket.status },
      );
    }
    const body = String(input.body ?? "").trim();
    if (!body) throw new DispatchError("VALIDATION_ERROR", "A review comment needs a body.");
    if (body.length > MAX_COMMENT_BODY)
      throw new DispatchError(
        "VALIDATION_ERROR",
        `A review comment is at most ${MAX_COMMENT_BODY} characters.`,
      );
    const severity: ReviewCommentSeverity = input.severity ?? "consider";
    if (!REVIEW_COMMENT_SEVERITIES.includes(severity))
      throw new DispatchError("VALIDATION_ERROR", "severity is must_fix or consider.", {
        severity,
      });

    let repoId: string | null = null;
    let path: string | null = null;
    let line: number | null = null;
    let side: "new" | "old" | null = null;
    let anchorSha: string | null = null;
    let excerpt: string | null = null;
    if (input.line != null && !input.path)
      throw new DispatchError("VALIDATION_ERROR", "A line comment names its file (path).");
    if (input.path) {
      path = cleanPath(input.path);
      const contexts = this.contextsSafe(ticket);
      const want = input.repo ? String(input.repo).trim() : "";
      const ctx = want
        ? contexts.find((c) => c.repoId === want || c.repo === want)
        : contexts.length === 1
          ? contexts[0]
          : undefined;
      if (!ctx) {
        throw new DispatchError(
          "VALIDATION_ERROR",
          want
            ? `"${want}" is not a write repository of #${ticket.number ?? "?"} with a delivery on this machine.`
            : `#${ticket.number ?? "?"} changes ${contexts.length} repositories; name the one the comment is about (repo).`,
          { repos: contexts.map((c) => c.repo) },
        );
      }
      repoId = ctx.repoId;
      const commit = input.commit ? String(input.commit).trim().toLowerCase() : "";
      if (commit && !SHA_RE.test(commit))
        throw new DispatchError("VALIDATION_ERROR", "commit is a full commit id.", { commit });
      const known = (sha: string): boolean =>
        this.deps.runGit(ctx.localPath, ["cat-file", "-e", `${sha}^{commit}`]).status === 0;
      anchorSha = commit && known(commit) ? commit : ctx.head;
      if (input.line != null) {
        const n = Number(input.line);
        if (!Number.isInteger(n) || n < 1)
          throw new DispatchError("VALIDATION_ERROR", "line is a positive whole number.", {
            line: input.line,
          });
        line = n;
        side = input.side === "old" ? "old" : "new";
        const rev =
          anchorSha === null
            ? null
            : side === "new"
              ? anchorSha
              : oldSideRev(this.deps.runGit, ctx, anchorSha);
        const lines = rev ? fileLines(this.deps.runGit, ctx, rev, path) : null;
        if (!lines || n > lines.length) {
          throw new DispatchError(
            "VALIDATION_ERROR",
            `${path} has no line ${n} on the ${side} side of the diff${anchorSha ? ` at ${anchorSha.slice(0, 12)}` : ""}. Comment on the file instead.`,
            { path, line: n, side },
          );
        }
        const lo = Math.max(1, n - ANCHOR_CONTEXT_LINES);
        excerpt = lines.slice(lo - 1, n + ANCHOR_CONTEXT_LINES).join("\n");
      }
    }
    const now = this.deps.clock.now();
    const id = newId();
    const c: ReviewComment = {
      id,
      ticket_id: ticket.id,
      repo_id: repoId,
      path,
      side,
      line,
      anchor_sha: anchorSha,
      anchor_excerpt: excerpt,
      anchor_hash: excerpt === null ? null : sha256(excerpt),
      body,
      severity,
      status: "open",
      author_type: actor.type as "human" | "admin",
      author_id: actor.id ?? null,
      round: ticket.attempt_count,
      sent_round: null,
      created_at: now,
      updated_at: now,
      resolved_at: null,
      resolved_by: null,
      resolved_at_sha: null,
    };
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO review_comments (id, ticket_id, repo_id, path, side, line, anchor_sha,
             anchor_excerpt, anchor_hash, body, severity, status, author_type, author_id, round,
             sent_round, created_at, updated_at, resolved_at, resolved_by, resolved_at_sha)
           VALUES (@id, @ticket_id, @repo_id, @path, @side, @line, @anchor_sha, @anchor_excerpt,
             @anchor_hash, @body, @severity, @status, @author_type, @author_id, @round,
             @sent_round, @created_at, @updated_at, @resolved_at, @resolved_by, @resolved_at_sha)`,
        )
        .run(c);
      this.event(ticket.id, actor, "review.comment_created", c);
    });
    return this.toView(c, this.repoNames());
  }

  private event(
    ticketId: string,
    actor: Actor,
    type: string,
    c: ReviewComment,
    extra: Record<string, unknown> = {},
  ): string {
    return writeEvent(this.db, {
      entity_type: "ticket",
      entity_id: ticketId,
      actor,
      event_type: type,
      payload: {
        comment_id: c.id,
        repo_id: c.repo_id,
        path: c.path,
        side: c.side,
        line: c.line,
        severity: c.severity,
        status: c.status,
        round: c.round,
        anchor_sha: c.anchor_sha,
        body_sha256: sha256(c.body),
        ...extra,
      },
    });
  }

  /** Resolve, reopen or withdraw a comment (a human act). */
  setState(
    commentRef: string,
    action: "resolve" | "reopen" | "withdraw",
    actor: Actor,
    ticketRef?: string,
  ): ReviewCommentView {
    const what =
      action === "resolve"
        ? "Resolving a review comment"
        : action === "reopen"
          ? "Reopening a review comment"
          : "Withdrawing a review comment";
    assertHuman(actor, what);
    const ticketId = ticketRef ? this.deps.resolveTicket(ticketRef).id : undefined;
    const c = this.resolveComment(commentRef, ticketId);
    const want: ReviewCommentStatus =
      action === "resolve" ? "resolved" : action === "reopen" ? "open" : "withdrawn";
    if (c.status === want) {
      throw new DispatchError("NO_OP", `Review comment ${c.id.slice(0, 8)} is already ${want}.`, {
        comment_id: c.id,
        status: c.status,
      });
    }
    if (action === "withdraw" && actor.type !== "admin" && c.author_id !== (actor.id ?? null)) {
      throw new DispatchError(
        "ACTOR_NOT_PERMITTED",
        `Only the comment's author (${c.author_id ?? "unknown"}) or an admin may withdraw it; resolve it instead.`,
        { comment_id: c.id, author_id: c.author_id },
      );
    }
    const ticket = this.deps.resolveTicket(c.ticket_id);
    // The head it was resolved against: its repo's, or the only write repo's for a comment
    // on the whole change (a multi-repo ticket has no one head to name).
    const contexts = this.contextsSafe(ticket);
    const ctx = c.repo_id
      ? contexts.find((x) => x.repoId === c.repo_id)
      : contexts.length === 1
        ? contexts[0]
        : undefined;
    const now = this.deps.clock.now();
    const next: ReviewComment = {
      ...c,
      status: want,
      updated_at: now,
      resolved_at: want === "open" ? null : now,
      resolved_by: want === "open" ? null : (actor.id ?? actor.type),
      resolved_at_sha: want === "resolved" ? (ctx?.head ?? null) : null,
    };
    inTransaction(this.db, () => {
      this.db
        .prepare(
          `UPDATE review_comments SET status = ?, updated_at = ?, resolved_at = ?, resolved_by = ?,
             resolved_at_sha = ? WHERE id = ?`,
        )
        .run(next.status, now, next.resolved_at, next.resolved_by, next.resolved_at_sha, c.id);
      this.event(
        c.ticket_id,
        actor,
        action === "resolve"
          ? "review.comment_resolved"
          : action === "reopen"
            ? "review.comment_reopened"
            : "review.comment_withdrawn",
        next,
        {
          from: c.status,
          ...(next.resolved_at_sha ? { resolved_at_sha: next.resolved_at_sha } : {}),
        },
      );
    });
    return { ...this.toView(next, this.repoNames()), agent_replies: [] };
  }

  /**
   * The open must-fix comments a "Fix these" sends (all of them, or the named subset,
   * each of which must be an open must-fix comment of this ticket).
   */
  fixSet(ticketId: string, ids?: readonly string[]): ReviewComment[] {
    const open = this.listRows(ticketId, { open: true }).filter((c) => c.severity === "must_fix");
    if (!ids || ids.length === 0) return open;
    const out: ReviewComment[] = [];
    for (const ref of ids) {
      const c = this.resolveComment(ref, ticketId);
      if (c.status !== "open" || c.severity !== "must_fix") {
        throw new DispatchError(
          "VALIDATION_ERROR",
          `Review comment ${c.id.slice(0, 8)} is ${c.status === "open" ? "a consider comment" : c.status}; Fix these sends open must-fix comments.`,
          { comment_id: c.id, status: c.status, severity: c.severity },
        );
      }
      if (!out.some((x) => x.id === c.id)) out.push(c);
    }
    return out;
  }

  /** Stamp the round a Fix these send-back carried these comments into. */
  markSent(ids: readonly string[], round: number): void {
    const stmt = this.db.prepare(
      "UPDATE review_comments SET sent_round = ?, updated_at = ? WHERE id = ?",
    );
    const now = this.deps.clock.now();
    for (const id of ids) stmt.run(round, now, id);
  }
}

/** The deterministic transition reason a Fix these records. */
export function fixTheseReason(comments: readonly Pick<ReviewComment, "id">[]): string {
  const n = comments.length;
  return `Fix these: ${n} requirement${n === 1 ? "" : "s"} (${comments.map((c) => c.id.slice(0, 8)).join(", ")})`;
}
