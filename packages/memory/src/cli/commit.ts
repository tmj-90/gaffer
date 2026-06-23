/**
 * `memory suggest --from-commit <sha>` — turn a commit message into a
 * DRAFT lore record. The "I already wrote the rationale in the commit,
 * why retype it" path (see docs/PRINCIPLES.md §6 — corpus growth).
 *
 * Pure helpers live here so they're testable without a git repo: the CLI
 * wrapper in `cli/index.ts` shells out to `git show` / `git config` and
 * feeds the raw strings in. Everything lands as a DRAFT — the reviewer is
 * the trust gate, same as every other agent-shaped capture path.
 */

const TITLE_CAP = 200;
const SUMMARY_CAP = 800;

/**
 * Field separator used in the `git show` format string. Node's
 * execFileSync rejects NUL bytes in args, so we use an unlikely printable
 * sentinel rather than \0. The two Unit-Separator chars (U+241F glyph)
 * paired with markers make an accidental collision with real commit text
 * vanishingly unlikely. The matching git format is built in the CLI as
 * `--format=%H${FIELD_SEP}%s${FIELD_SEP}%b`.
 */
export const FIELD_SEP = "␟␟";

export interface ParsedCommit {
  /** Full 40-char sha (or whatever `git show` resolved). */
  readonly sha: string;
  /** Commit subject line — becomes the draft title. */
  readonly subject: string;
  /** Commit body (everything after the subject + blank line). May be "". */
  readonly body: string;
}

export interface CommitDraftFields {
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly source?: string;
  /** `medium` when a source URL was derived, else `low`. Drafts can't be high. */
  readonly confidence: "low" | "medium";
}

/**
 * Parse the FIELD_SEP-separated output of `git show -s` with a format of
 * sha / subject / body. Returns null when the shape is unrecognisable
 * (e.g. empty output from a bad sha).
 */
export function parseCommitShow(raw: string): ParsedCommit | null {
  // Trim only the trailing newline git appends; preserve body whitespace.
  const text = raw.replace(/\n$/, "");
  const parts = text.split(FIELD_SEP);
  if (parts.length < 2) return null;
  const sha = parts[0]!.trim();
  const subject = parts[1]!.trim();
  const body = (parts[2] ?? "").trim();
  if (sha.length === 0 || subject.length === 0) return null;
  return { sha, subject, body };
}

/**
 * Build a GitHub/GitLab commit permalink from a remote URL + sha, or null
 * when the remote isn't a recognisable http(s)/ssh host we can turn into
 * a browseable commit URL. Mirrors `shortRepoNameFromRemote`'s tolerance
 * for both SSH (`git@host:owner/repo.git`) and HTTPS forms.
 *
 *   git@github.com:org/repo.git + abc123 -> https://github.com/org/repo/commit/abc123
 *   https://github.com/org/repo  + abc123 -> https://github.com/org/repo/commit/abc123
 */
export function commitUrlFromRemote(remoteUrl: string | undefined, sha: string): string | null {
  if (!remoteUrl || sha.trim().length === 0) return null;
  const noGit = remoteUrl.trim().replace(/\.git\/?$/, "");
  let host: string;
  let path: string;
  const ssh = /^git@([^:]+):(.+)$/.exec(noGit);
  if (ssh) {
    host = ssh[1]!;
    path = ssh[2]!;
  } else {
    try {
      const u = new URL(noGit);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      host = u.host;
      path = u.pathname.replace(/^\//, "");
    } catch {
      return null;
    }
  }
  path = path.replace(/^\/+|\/+$/g, "");
  if (path.length === 0) return null;
  return `https://${host}/${path}/commit/${sha}`;
}

/**
 * Derive the draft fields from a parsed commit + optional source URL.
 *
 *   - title:   subject, capped at 200 (ellipsised)
 *   - summary: first body paragraph if present, else the subject; capped 800
 *   - body:    full message (subject + body) plus a provenance footer
 *   - source:  passed through (the caller derives it from the remote)
 *   - confidence: medium when sourced, low otherwise
 */
export function commitToDraftFields(
  commit: ParsedCommit,
  source: string | null,
): CommitDraftFields {
  const title = cap(commit.subject, TITLE_CAP);
  const firstPara = commit.body ? (commit.body.split(/\n{2,}/)[0] ?? commit.body) : commit.subject;
  const summary = cap(firstPara.trim(), SUMMARY_CAP);
  const fullMessage = commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject;
  const shortSha = commit.sha.slice(0, 12);
  const body =
    `${fullMessage}\n\n---\n` +
    `Source: commit ${shortSha}` +
    (source ? ` (${source})` : "") +
    `\n(captured via \`memory suggest --from-commit\`)\n`;
  return {
    title,
    summary,
    body,
    source: source ?? undefined,
    confidence: source ? "medium" : "low",
  };
}

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
