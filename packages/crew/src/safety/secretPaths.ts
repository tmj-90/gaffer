import { basename } from "node:path";

import { matchesAnyGlob, normaliseRelative } from "./glob.js";

/**
 * Canonical secret-path discipline (FG-003 / FG-004).
 *
 * The repo onboarding scanner and the non-committed context store must NEVER
 * read, fingerprint or persist secret material. This module is the single
 * source of truth for "which paths look like secrets", reusing the same glob
 * vocabulary the filesystem safety guard denies writes to
 * (`policySchema.filesystemPolicySchema.deny_write_paths`) plus the read/exfil
 * fragment the command guard blocks (`commandGuard.SECRET_PATH_FRAGMENT`).
 *
 * Keeping this list here — rather than re-deriving it per call site — means a
 * new secret shape is excluded everywhere at once, and the scanner can never
 * drift from the runtime guards.
 */

/**
 * Secret-looking path globs, matched on a repo-relative POSIX path. Mirrors the
 * default `deny_write_paths` so the scanner excludes exactly what the write
 * guard protects, broadened to the read-side shapes (`.npmrc`, `.git-credentials`,
 * `.netrc`, `*.p12`, `id_*` private keys) the command guard blocks reads of.
 */
export const SECRET_PATH_GLOBS: readonly string[] = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/secrets/**",
  "secrets/**",
  "**/credentials/**",
  "credentials/**",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa",
  "**/id_ed25519",
  "**/id_dsa",
  "**/id_ecdsa",
  "**/.aws/**",
  ".aws/**",
  "**/.ssh/**",
  ".ssh/**",
  "**/.npmrc",
  ".npmrc",
  "**/.git-credentials",
  ".git-credentials",
  "**/.netrc",
  ".netrc",
];

/**
 * Directory names that, when encountered during a walk, are skipped wholesale —
 * never descended into. Covers secret stores plus heavy/derived dirs that carry
 * no architectural signal (and may contain copied-in secrets).
 */
export const SECRET_DIR_NAMES: ReadonlySet<string> = new Set([
  ".ssh",
  ".aws",
  ".gnupg",
  "secrets",
  "secret",
  "credentials",
  ".secrets",
]);

/** Non-secret directories skipped during a content walk (noise, not secrets). */
export const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
]);

/** Basename fragments (case-insensitive) that mark a single file as secret-bearing. */
const SECRET_NAME_FRAGMENT =
  /(^|[._-])(secret|secrets|credential|credentials|password|passwd|token|apikey|api[_-]?key|private[_-]?key)([._-]|$)/i;

/**
 * True when a repo-relative path is secret-looking and must be excluded from any
 * scan, fingerprint or context store. Matches the secret globs, or any segment
 * being a secret directory, or a secret-fragment basename.
 */
export function isSecretPath(relPath: string): boolean {
  const path = normaliseRelative(relPath);
  if (matchesAnyGlob(path, SECRET_PATH_GLOBS)) return true;
  const segments = path.split("/");
  for (const segment of segments) {
    if (SECRET_DIR_NAMES.has(segment.toLowerCase())) return true;
  }
  return SECRET_NAME_FRAGMENT.test(basename(path));
}

/**
 * True when a directory (by its basename) must not be descended into during a
 * walk — either a secret store or skipped noise. Skipping secret dirs here is
 * the primary guarantee the scanner never even opens secret files.
 */
export function isExcludedDir(dirName: string): boolean {
  const name = dirName.toLowerCase();
  return SECRET_DIR_NAMES.has(name) || SKIP_DIR_NAMES.has(name);
}
