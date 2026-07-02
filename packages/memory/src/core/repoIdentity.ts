/**
 * Repo identity normalisation — the single source of truth for collapsing
 * every equivalent form of a repo's identity to ONE stable canonical string.
 *
 * WHY THIS EXISTS (the bug it fixes):
 *   repo_key = sha256(canonical). If the canonical is NOT normalised, the
 *   SAME repository hashes to DIFFERENT keys depending on how it was named:
 *     - ssh remote:   git@github.com:owner/repo.git
 *     - https remote:  https://github.com/owner/repo.git
 *     - the pwd -P / realpath fallback when there is no remote
 *   `card search` / `cards_for_scope` then SILENTLY return 0 cards whenever
 *   the query-time canonical does not byte-match the onboard-time key.
 *
 *   `canonicalizeRepo` is applied at BOTH write (onboard) and read
 *   (search / cards-for-scope) time — via `repoKey` — so read and write can
 *   never drift. It is idempotent: canonicalizeRepo(canonicalizeRepo(x)) === x.
 *
 * THE RULE (git remote URLs) — reduce to  host/owner/repo , lowercased:
 *   - strip the scheme:            git@ · https:// · http:// · ssh:// · git://
 *   - strip any userinfo:          user@  or  user:pass@
 *   - strip a :port:               ssh://git@host:22/owner/repo
 *   - strip a trailing ".git"
 *   - strip any leading/trailing slash
 *   - lowercase the whole thing
 *
 *   Worked examples (all three collapse to the SAME string):
 *     git@github.com:acme/widget.git      → github.com/acme/widget
 *     https://github.com/acme/widget.git   → github.com/acme/widget
 *     ssh://git@github.com:22/acme/widget  → github.com/acme/widget
 *
 * THE FALLBACK (no remote — a filesystem path):
 *   When the input is the pwd -P / realpath fallback (a local path), it
 *   cannot be collapsed to host/owner/repo. We strip any trailing slash and
 *   otherwise return it UNCHANGED — in particular we do NOT lowercase it,
 *   because paths are case-sensitive on Linux. Two clones at different paths
 *   therefore keep distinct keys (correct: they could genuinely diverge).
 */

/** Strip a single trailing slash (but never reduce "/" to ""). */
function stripTrailingSlash(s: string): string {
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

/**
 * Is this input a local filesystem path rather than a git remote URL?
 * Absolute (`/…`), relative (`./` `../`), home (`~`), a Windows drive
 * (`C:\` / `C:/`), or an explicit `file://` URL are all local.
 */
function isLocalPath(input: string): boolean {
  if (/^file:\/\//i.test(input)) return true;
  if (input.startsWith("/") || input.startsWith("~")) return true;
  if (input.startsWith("./") || input.startsWith("../") || input === "." || input === "..") {
    return true;
  }
  // Windows drive letter: C:\repos  or  C:/repos
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true;
  return false;
}

/** Assemble host + path into the normalised `host/owner/repo` (lowercased). */
function buildHostPath(host: string, path: string): string {
  const cleanHost = host.split(":")[0]!.replace(/\/+$/, ""); // drop :port, trailing slash
  const cleanPath = path
    .replace(/^\/+/, "") // leading slashes
    .replace(/\/+$/, "") // trailing slashes
    .replace(/\.git$/i, ""); // trailing .git
  const full = cleanPath ? `${cleanHost}/${cleanPath}` : cleanHost;
  return full.toLowerCase();
}

/**
 * Parse a git remote URL (scheme:// or scp-like) into `host/owner/repo`.
 * Returns null when the input is not a recognisable remote URL (caller then
 * treats it as an opaque path).
 */
function parseGitUrl(input: string): string | null {
  // scheme://[user[:pass]@]host[:port]/path
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(input);
  if (scheme) {
    if (scheme[1]!.toLowerCase() === "file") return null; // local path
    let rest = scheme[2]!;
    rest = rest.replace(/^[^/@]+@/, ""); // strip userinfo
    const slash = rest.indexOf("/");
    const hostPort = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? "" : rest.slice(slash + 1);
    return buildHostPath(hostPort, path);
  }

  // scp-like: [user@]host:path  (no scheme, exactly one host, ':' separator).
  // The path segment must be present; a bare "host:" is not a repo.
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(input);
  if (scp) {
    return buildHostPath(scp[1]!, scp[2]!);
  }

  return null;
}

/**
 * Normalise a repo canonical string. See the file header for the full rule.
 *
 * @param raw the remote origin URL (any form) or a local path fallback.
 * @returns the stable canonical: `host/owner/repo` (lowercased) for remotes,
 *          or the trailing-slash-stripped path for the no-remote fallback.
 */
export function canonicalizeRepo(raw: string): string {
  const input = (raw ?? "").trim();
  if (!input) return "";

  // file:// → treat the remainder as a local path.
  const fileUrl = /^file:\/\/(.*)$/i.exec(input);
  if (fileUrl) return stripTrailingSlash(fileUrl[1] || "/");

  // Local filesystem path → trailing slash only, case preserved.
  if (isLocalPath(input)) return stripTrailingSlash(input);

  // Git remote URL → host/owner/repo, lowercased.
  const url = parseGitUrl(input);
  if (url) return url;

  // Unknown form (e.g. an already-normalised bare "host/owner/repo", which is
  // our own idempotent output): strip a trailing ".git" + slash. Do not
  // lowercase — an unrecognised opaque string might be a case-sensitive path.
  return stripTrailingSlash(input.replace(/\.git$/i, ""));
}

/**
 * The set of PRE-CANONICALISATION identity strings that could have produced a
 * LEGACY repo_key for the SAME repository as `canonicalRaw`.
 *
 * WHY: cards onboarded before canonicalisation were keyed as `sha256(rawForm)`,
 * where `rawForm` was whatever spelling of the repo identity was passed at the
 * time (an ssh remote, an https remote, a pwd/realpath path, …). Their key can
 * NOT be reversed from the hash. The rekey migration therefore proves a legacy
 * row belongs to THIS repo by checking its stored repo_key against
 * `sha256(form)` for every `form` returned here. This replaces the unsafe
 * "match by display name" heuristic, which re-keyed rows of a DIFFERENT repo
 * that merely shared a display name (e.g. `orgA/api` vs `orgB/api`).
 *
 * We only emit forms that are DERIVABLE from the canonical:
 *   - remotes: the ssh / https / http / ssh:// / git:// spellings (± ".git"),
 *     the bare `host/owner/repo`, and the raw input as given.
 *   - local paths: the path as given / canonicalised (± a trailing slash).
 * Forms we cannot recover (e.g. a symlinked pwd that differs from its realpath)
 * are intentionally NOT guessed: leaving a legacy row un-migrated (and loudly
 * diagnosable) is safe; claiming another repo's rows is data corruption.
 */
export function legacyRepoIdentityForms(canonicalRaw: string): string[] {
  const raw = (canonicalRaw ?? "").trim();
  if (!raw) return [];
  const canonical = canonicalizeRepo(raw);
  const forms = new Set<string>();
  const add = (s: string): void => {
    const t = (s ?? "").trim();
    if (t) forms.add(t);
  };

  add(raw);
  add(canonical);

  if (isLocalPath(raw)) {
    add(stripTrailingSlash(raw));
    add(`${stripTrailingSlash(canonical)}/`);
    return [...forms];
  }

  // Remote: canonical === host/owner/repo… → split host from the owner/repo.
  const slash = canonical.indexOf("/");
  if (slash <= 0) return [...forms]; // no owner/repo path to reconstruct

  const host = canonical.slice(0, slash);
  const path = canonical.slice(slash + 1);
  for (const body of [path, `${path}.git`]) {
    add(`git@${host}:${body}`);
    add(`https://${host}/${body}`);
    add(`http://${host}/${body}`);
    add(`ssh://git@${host}/${body}`);
    add(`ssh://${host}/${body}`);
    add(`git://${host}/${body}`);
    add(`${host}/${body}`);
  }
  return [...forms];
}
