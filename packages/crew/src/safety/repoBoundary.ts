import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Repository boundary for onboarding and scan reads (external review #9, finding 3).
 *
 * Onboarding reads a repository's own files (README, manifests, a Makefile) into a
 * scan, a digest and a model prompt. A path inside the checkout can be a symlink to
 * anything the operator's user can read (`README.md -> ~/notes/passwords.txt`), and the
 * plain `readFileSync(join(repo, name))` followed it. Every such read now resolves the
 * real path of the file and of the repository root and refuses a file whose real path
 * is outside the root, with a reason a caller can report.
 */
export class OutsideRepositoryError extends Error {
  constructor(
    readonly rel: string,
    readonly why: string,
  ) {
    super(why);
    this.name = "OutsideRepositoryError";
  }
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * The reason `rel` (relative to `root`) may not be read, or null when its real path is
 * inside the repository. A missing file is not a boundary question (returns null).
 */
export function outsideRepoReason(root: string, rel: string): string | null {
  const abs = isAbsolute(rel) ? rel : join(root, rel);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }
  const rootReal = realOrResolved(root);
  const r = relative(rootReal, real);
  if (r === "" || (!r.startsWith("..") && !isAbsolute(r))) return null;
  let link = false;
  try {
    link = lstatSync(abs).isSymbolicLink();
  } catch {
    /* keep false */
  }
  const name = isAbsolute(rel) ? relative(root, rel) || rel : rel;
  return link
    ? `${name} is a symlink to a file outside the repository; onboarding reads only files inside it`
    : `${name} resolves outside the repository; onboarding reads only files inside it`;
}

/** Read a text file inside the repository; throws OutsideRepositoryError when it is not. */
export function readRepoText(root: string, rel: string): string {
  const why = outsideRepoReason(root, rel);
  if (why) throw new OutsideRepositoryError(rel, why);
  return readFileSync(isAbsolute(rel) ? rel : join(root, rel), "utf8");
}

/** statSync for a path inside the repository, or undefined (missing or outside). */
export function statInRepo(root: string, rel: string): ReturnType<typeof statSync> | undefined {
  if (outsideRepoReason(root, rel)) return undefined;
  try {
    return statSync(isAbsolute(rel) ? rel : join(root, rel));
  } catch {
    return undefined;
  }
}

/**
 * A remote URL with any userinfo removed: `https://user:token@host/x` becomes
 * `https://host/x`. scp-like and ssh forms (`git@host:owner/repo`, `ssh://git@host/…`)
 * name a login, not a secret, and are returned unchanged, as is anything that is not a
 * URL. Applied wherever a remote URL can reach a prompt, a digest, lore, an event or a
 * log line.
 */
export function redactRemoteUrl(url: string): string;
export function redactRemoteUrl(url: string | null): string | null;
export function redactRemoteUrl(url: string | null | undefined): string | null | undefined;
export function redactRemoteUrl(url: string | null | undefined): string | null | undefined {
  if (url == null) return url;
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)(.*)$/is.exec(url);
  if (!m) return url;
  const scheme = m[1]!.toLowerCase();
  if (scheme === "ssh://" || scheme === "git+ssh://" || scheme === "ssh+git://") return url;
  return `${m[1]}${m[3]}`;
}
