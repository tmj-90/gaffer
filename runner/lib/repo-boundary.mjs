// runner/lib/repo-boundary.mjs — onboarding reads stay inside the repository, and remote
// URLs lose their credentials (external review #9, finding 3).
//
// Onboarding (lib/onboard-analyze.mjs, bin/onboard-run.mjs) reads a repository's own
// files (README, manifests, ADR names, source for file cards) into a model prompt, a
// digest and lore. A path in the checkout can be a symlink to any file the operator's
// user can read, and `readFileSync(join(repo, "README.md"))` followed it: a README
// linked to a file outside the repository put that file into the prompt. Every read now
// resolves the real path of the file and of the repository root and refuses a file that
// lands outside, with a reason the digest can carry. The same module strips userinfo
// from remote URLs (`https://user:pass@host/x` → `https://host/x`; ssh and scp-like forms
// are a login, not a secret, and stay as they are). packages/crew mirrors both in
// src/safety/repoBoundary.ts.

import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Why `rel` (relative to `root`, or absolute) may not be read, or null when its real path
 * is inside the repository. A missing file is not a boundary question: null.
 */
export function outsideRepoReason(root, rel) {
  const abs = isAbsolute(rel) ? rel : join(root, rel);
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }
  const r = relative(realOrResolved(root), real);
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

/**
 * Read a text file inside the repository. Returns the text, or null when it is missing,
 * unreadable or outside the repository (the reason is pushed onto `skipped`, when given).
 */
export function readRepoText(root, rel, skipped = null) {
  const why = outsideRepoReason(root, rel);
  if (why) {
    if (Array.isArray(skipped) && !skipped.includes(why)) skipped.push(why);
    return null;
  }
  try {
    return readFileSync(isAbsolute(rel) ? rel : join(root, rel), "utf8");
  } catch {
    return null;
  }
}

/** statSync of a path inside the repository, or null (missing or outside, reason pushed). */
export function statRepo(root, rel, skipped = null) {
  const why = outsideRepoReason(root, rel);
  if (why) {
    if (Array.isArray(skipped) && !skipped.includes(why)) skipped.push(why);
    return null;
  }
  try {
    return statSync(isAbsolute(rel) ? rel : join(root, rel));
  } catch {
    return null;
  }
}

/** A remote URL without userinfo; ssh/scp forms and non-URLs are returned unchanged. */
export function redactRemoteUrl(url) {
  if (url == null) return url;
  const s = String(url);
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)(.*)$/is.exec(s);
  if (!m) return s;
  const scheme = m[1].toLowerCase();
  if (scheme === "ssh://" || scheme === "git+ssh://" || scheme === "ssh+git://") return s;
  return `${m[1]}${m[3]}`;
}

/** Every https/http-style URL with userinfo inside `text`, redacted (for log lines). */
export function redactUrlsIn(text) {
  return String(text ?? "").replace(
    /\b((?!ssh:\/\/|git\+ssh:\/\/)[a-z][a-z0-9+.-]*:\/\/)[^/\s?#@]*@/gi,
    "$1",
  );
}
