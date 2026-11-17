/**
 * LESSONS (Gaffer backlog 59): a person's post-merge finding, approved by a person, served
 * to a later change on the same paths.
 *
 * A lesson is ordinary lore (kind `gotcha`, "a trap likely to bite again") tagged
 * {@link LESSON_TAG}, scoped to its repo (lore_repos) AND to the paths it concerns
 * (lore_paths, migration 017). It is a draft until a person approves it (suggestLore never
 * auto-approves this tag), and only an `active`, unrestricted record is ever served.
 *
 * Serving is by path, never by text search: {@link lessonsForPaths} returns the active
 * lessons of a repo whose paths overlap the paths a change names or touches (prefix on
 * whole path segments either way, or a glob). The scope packet's text-searched lore leaves
 * lessons out, so a lesson never reaches a change on other paths.
 *
 * ISOLATION: no imports from dispatch or crew.
 */
import type { Database } from "better-sqlite3";

/** The tag every lesson carries (a post-merge finding turned into lore). */
export const LESSON_TAG = "post-merge-finding";

/**
 * The tag that names the change a lesson came from: `from-ticket-<number>` (lore's own
 * `source` column takes an http URL only). Read back as {@link LessonHit.fromTicket}.
 */
export const LESSON_FROM_PREFIX = "from-ticket-";

/** Most lessons one call serves. */
export const LESSONS_LIMIT_DEFAULT = 5;
const LESSONS_LIMIT_MAX = 20;
const PATH_MAX = 500;

/**
 * One repo-relative path or glob, normalised: `\` to `/`, repeated slashes collapsed,
 * `./` and leading `/` dropped. Null for an empty path, one with a `..` segment or a
 * control character, or one over 500 characters (never stored, never matched).
 */
export function normaliseLorePath(p: unknown): string | null {
  if (typeof p !== "string") return null;
  let s = p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  s = s.replace(/^\/+/, "");
  // eslint-disable-next-line no-control-regex -- control bytes never belong in a path
  if (!s || s === "." || s.length > PATH_MAX || /[\x00-\x1f]/.test(s)) return null;
  if (s.split("/").includes("..")) return null;
  return s;
}

const isGlob = (p: string): boolean => /[*?[]/.test(p);

function globRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches any number of directories (including none); `**` anything.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Does a lesson's path overlap a path a change names or touches? A glob matches the
 * touched path (or, for a touched directory, a path under it could match: its literal
 * stem before the first wildcard is compared as a prefix). A plain path overlaps when one
 * is the other or a directory containing it (whole segments: `src/a` never matches
 * `src/ab.ts`). A trailing slash marks a directory.
 */
export function pathsOverlap(lessonPath: string, touched: string): boolean {
  const l = normaliseLorePath(lessonPath);
  const t = normaliseLorePath(touched);
  if (!l || !t) return false;
  if (isGlob(l)) {
    if (globRegex(l).test(t.replace(/\/$/, ""))) return true;
    const stem = l.slice(0, l.search(/[*?[]/)).replace(/[^/]*$/, "");
    const dir = t.endsWith("/") ? t : `${t}/`;
    return stem !== "" && stem.startsWith(dir);
  }
  const lp = l.replace(/\/$/, "");
  const tp = t.replace(/\/$/, "");
  return lp === tp || tp.startsWith(`${lp}/`) || lp.startsWith(`${tp}/`);
}

/** One lesson as the primer and the dashboard read it. */
export interface LessonHit {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly kind: string;
  readonly repo: string;
  readonly paths: readonly string[];
  /** The lesson paths that overlapped the given paths. */
  readonly matched: readonly string[];
  /** The number of the change the lesson came from (its from-ticket-<n> tag), or null. */
  readonly fromTicket: number | null;
  readonly updatedAt: string;
}

/** The change a lesson came from, read from its tags (null when none or not a number). */
export function lessonFromTicket(db: Database, loreId: string): number | null {
  const row = db
    .prepare(
      "SELECT tag FROM lore_tags WHERE lore_id = ? AND tag LIKE ? ORDER BY tag LIMIT 1",
    )
    .get(loreId, `${LESSON_FROM_PREFIX}%`) as { tag: string } | undefined;
  const m = row ? /^from-ticket-(\d{1,9})$/.exec(row.tag) : null;
  return m ? Number(m[1]) : null;
}

/** Every stored path of a lore record (sorted). */
export function lorePaths(db: Database, loreId: string): string[] {
  return (
    db.prepare("SELECT path FROM lore_paths WHERE lore_id = ? ORDER BY path").all(loreId) as Array<{
      path: string;
    }>
  ).map((r) => r.path);
}

/**
 * The ACTIVE, unrestricted lessons of `repo` whose paths overlap `paths`, newest first,
 * at most `limit` (default 5, max 20). No paths given: none (a lesson is never served
 * without a path match).
 */
export function lessonsForPaths(
  db: Database,
  opts: { repo: string; paths: readonly string[]; limit?: number },
): LessonHit[] {
  const repo = (opts.repo ?? "").trim();
  const touched = (opts.paths ?? []).map(normaliseLorePath).filter((p): p is string => !!p);
  if (!repo || touched.length === 0) return [];
  const limit = Math.min(
    LESSONS_LIMIT_MAX,
    Math.max(1, Math.trunc(opts.limit ?? LESSONS_LIMIT_DEFAULT) || LESSONS_LIMIT_DEFAULT),
  );
  const rows = db
    .prepare(
      `SELECT l.id, l.title, l.summary, l.kind, l.updated_at
         FROM lore l
         JOIN lore_repos r ON r.lore_id = l.id AND r.repo = ?
         JOIN lore_tags t ON t.lore_id = l.id AND t.tag = ?
        WHERE l.status = 'active' AND l.restricted = 0
        ORDER BY l.updated_at DESC, l.id`,
    )
    .all(repo, LESSON_TAG) as Array<{
    id: string;
    title: string;
    summary: string;
    kind: string | null;
    updated_at: string;
  }>;
  const out: LessonHit[] = [];
  for (const r of rows) {
    const paths = lorePaths(db, r.id);
    const matched = paths.filter((lp) => touched.some((t) => pathsOverlap(lp, t)));
    if (matched.length === 0) continue;
    out.push({
      id: r.id,
      title: r.title,
      summary: r.summary,
      kind: r.kind ?? "other",
      repo,
      paths,
      matched,
      fromTicket: lessonFromTicket(db, r.id),
      updatedAt: r.updated_at,
    });
    if (out.length >= limit) break;
  }
  return out;
}
