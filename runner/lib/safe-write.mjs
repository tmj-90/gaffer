#!/usr/bin/env node
// =====================================================================
// safe-write.mjs: the ONE way the runner writes into a directory an agent or a
// repository controls (a delivery worktree, a reviewer or clarify worktree, the tester's
// checkout, a bootstrap repo, an agent home).
// ---------------------------------------------------------------------
// These writes happen on the HOST, before the worker is sandboxed, so the OS sandbox
// does not protect them. A repository can commit a symlink at any path the runner
// writes (`.claude/settings.json`, `CLAUDE.factory.md`, `.claude` itself,
// `.claude/skills`, a parent of a `node_modules` link); writing through it would
// overwrite or create a file anywhere the operator can write. So every write here:
//   * resolves the ROOT once (realpath: the runner chose it), then walks each parent
//     component below it with lstat. A component that is a symlink, or is not a
//     directory, is a REFUSAL; a missing one is created with a plain mkdir (never
//     recursive, so no link is followed);
//   * refuses a destination that is a symlink (dangling or not) or exists and is not a
//     regular file;
//   * writes a fresh temp file in the CHECKED real directory (O_CREAT|O_EXCL, which
//     never follows a link) and renames it over the destination (rename replaces a
//     directory entry, it never writes through one). The same on Linux and macOS.
// A refusal throws UnsafePathError (code `unsafe_worktree_path`): its message names the
// path and says what to do. Callers fail closed: no agent is launched.
//
// CLI (used by the shell libs, so shell and Node apply the same rule):
//   node safe-write.mjs write   <root> <rel> <src-file>   copy <src-file> to <root>/<rel>
//   node safe-write.mjs mkdir   <root> <rel>              make <root>/<rel> (and parents)
//   node safe-write.mjs check   <root> <rel> [file|dir]   refuse when <root>/<rel> or a
//                                                         parent is unsafe (writes nothing)
//   node safe-write.mjs remove  <root> <rel>              remove a regular file only
//   node safe-write.mjs symlink <root> <rel> <target>     create a link where nothing is
//                                                         (exit 0 and no change when
//                                                         something is already there)
// Exit codes: 0 done; 4 refused (unsafe path; the reason on stderr starts with
// `unsafe_worktree_path:`); 2 usage; 1 any other failure.
// =====================================================================
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The reason code a refusal carries (the runner parks the ticket with it). */
export const UNSAFE_PATH_CODE = "unsafe_worktree_path";

/** Exit code of the CLI for a refusal. */
export const EXIT_UNSAFE = 4;

/** A write the runner refused because a path below the root is a link or not what it expects. */
export class UnsafePathError extends Error {
  constructor(root, rel, why, { read = false } = {}) {
    super(
      `${UNSAFE_PATH_CODE}: ${rel} in ${root} ${why}; ` +
        (read
          ? `the runner copies repository files from there into a checkout an agent or a ` +
            `ticket can read and never reads through a symbolic link or outside the directory. `
          : `the runner writes its own agent files ` +
            `(.claude/settings.json, .claude/skills, CLAUDE.factory.md, node_modules links) there ` +
            `before an agent runs and never writes through a symbolic link or outside the ` +
            `directory. `) +
        `Replace the link with a regular file or directory in the repository, or ` +
        `remove it from the branch`,
    );
    this.name = "UnsafePathError";
    this.code = UNSAFE_PATH_CODE;
    this.root = root;
    this.rel = rel;
  }
}

/** The lstat of `p`, or null when nothing is there. */
function lstatOrNull(p) {
  try {
    return lstatSync(p);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return null;
    throw err;
  }
}

/** A short description of the symlink at `p` for a refusal ("a symbolic link to X"). */
function linkWhy(p) {
  let to = "";
  try {
    to = readlinkSync(p);
  } catch {
    /* unreadable */
  }
  return `is a symbolic link${to ? ` (to ${to})` : ""}`;
}

/**
 * Split `rel` into plain components. Refuses an absolute path, an empty one, and any
 * `.` / `..` component (a runner path is always a plain relative path).
 */
function components(root, rel, read = false) {
  if (typeof rel !== "string" || rel === "" || isAbsolute(rel)) {
    throw new UnsafePathError(root, String(rel), "is not a plain relative path", { read });
  }
  const parts = rel.split("/").filter((c) => c !== "");
  if (parts.length === 0 || parts.some((c) => c === "." || c === "..")) {
    throw new UnsafePathError(root, rel, "is not a plain relative path", { read });
  }
  return parts;
}

/** The real path of the root, which must be an existing directory. */
function realRoot(root) {
  const real = realpathSync(resolve(root));
  if (!lstatSync(real).isDirectory()) throw new Error(`${root} is not a directory`);
  return real;
}

/**
 * Walk the parent components of `rel` under `root` (each lstat'd: a symlink or a
 * non-directory is a refusal). With `create`, missing components are made with a plain
 * mkdir. Returns `{ real, dir, base, missing }`: the real root, the checked real parent
 * directory, the last component, and whether a parent was missing (without `create`).
 */
function walkParents(root, rel, { create = false, read = false } = {}) {
  const real = realRoot(root);
  const parts = components(root, rel, read);
  const base = parts.pop();
  let dir = real;
  let sofar = "";
  for (const c of parts) {
    sofar = sofar ? `${sofar}/${c}` : c;
    const p = join(dir, c);
    let st = lstatOrNull(p);
    if (st === null) {
      if (!create) return { real, dir: null, base, missing: true };
      try {
        mkdirSync(p);
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw err;
      }
      st = lstatSync(p);
    }
    if (st.isSymbolicLink()) throw new UnsafePathError(root, sofar, linkWhy(p), { read });
    if (!st.isDirectory()) throw new UnsafePathError(root, sofar, "is not a directory", { read });
    dir = p;
  }
  // Belt and braces: every component was a real directory, so the parent's real path
  // is itself, inside the root.
  const back = realpathSync(dir);
  if (back !== dir || !(dir === real || dir.startsWith(real + "/"))) {
    throw new UnsafePathError(root, parts.join("/") || ".", "resolves outside the directory", {
      read,
    });
  }
  return { real, dir, base, missing: false };
}

/**
 * Refuse (throw UnsafePathError) when `<root>/<rel>` or any parent below the root is a
 * symlink or not a directory, or when the destination exists and is not of `kind`
 * ("file": a regular file; "dir": a directory). A missing path is fine. Writes nothing.
 */
export function checkPath(root, rel, kind = "file") {
  const { dir, base, missing } = walkParents(root, rel);
  if (missing) return;
  const p = join(dir, base);
  const st = lstatOrNull(p);
  if (st === null) return;
  if (st.isSymbolicLink()) throw new UnsafePathError(root, rel, linkWhy(p));
  if (kind === "dir" ? !st.isDirectory() : !st.isFile()) {
    throw new UnsafePathError(
      root,
      rel,
      kind === "dir" ? "exists and is not a directory" : "exists and is not a regular file",
    );
  }
}

/**
 * Write `data` to `<root>/<rel>` without following a link: parents are checked (and
 * made), the destination must be absent or a regular file, and the content lands by a
 * rename of a fresh temp file in the checked directory. Returns the real path written.
 */
export function safeWriteFile(root, rel, data, { mode = 0o644 } = {}) {
  const { dir, base } = walkParents(root, rel, { create: true });
  const dest = join(dir, base);
  const st = lstatOrNull(dest);
  if (st?.isSymbolicLink()) throw new UnsafePathError(root, rel, linkWhy(dest));
  if (st && !st.isFile()) throw new UnsafePathError(root, rel, "exists and is not a regular file");
  const tmp = join(dir, `.${base}.gaffer-tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  let fd = -1;
  try {
    fd = openSync(tmp, "wx", mode);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = -1;
    renameSync(tmp, dest);
  } catch (err) {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* not created */
    }
    throw err;
  }
  return dest;
}

/**
 * Read `<root>/<rel>` without following a link: every parent below the root must be a real
 * directory (lstat), and the file itself a regular file, not a symlink (dangling or not);
 * it is opened with O_NOFOLLOW where the platform has it and checked again on the open
 * descriptor. Returns the content (a Buffer), or null when nothing is there; throws
 * UnsafePathError (a read refusal) otherwise. For files a repository or an agent names
 * that the runner copies into a place an agent or a ticket can read.
 */
export function safeReadFile(root, rel) {
  const refuse = (why) => new UnsafePathError(root, rel, why, { read: true });
  const { dir, base, missing } = walkParents(root, rel, { read: true });
  if (missing) return null;
  const p = join(dir, base);
  const st = lstatOrNull(p);
  if (st === null) return null;
  if (st.isSymbolicLink()) throw refuse(linkWhy(p));
  if (!st.isFile()) throw refuse("exists and is not a regular file");
  const fd = openSync(p, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    if (!fstatSync(fd).isFile()) throw refuse("exists and is not a regular file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Copy the file `src` to `<root>/<rel>` (see safeWriteFile). */
export function safeCopyFile(root, rel, src) {
  return safeWriteFile(root, rel, readFileSync(src));
}

/** Make the directory `<root>/<rel>` and its parents, refusing a link anywhere on the way. */
export function safeMkdir(root, rel) {
  const { dir, base } = walkParents(root, rel, { create: true });
  const p = join(dir, base);
  let st = lstatOrNull(p);
  if (st === null) {
    try {
      mkdirSync(p);
    } catch (err) {
      if (!err || err.code !== "EEXIST") throw err;
    }
    st = lstatSync(p);
  }
  if (st.isSymbolicLink()) throw new UnsafePathError(root, rel, linkWhy(p));
  if (!st.isDirectory()) throw new UnsafePathError(root, rel, "exists and is not a directory");
  return p;
}

/**
 * Remove `<root>/<rel>` when it is a regular file reached through real directories.
 * Nothing there (or a missing parent) is a no-op; a parent link is a refusal; a link or
 * a directory AT the path is left alone (it is the repository's, never the runner's).
 * Returns true when a file was removed.
 */
export function safeRemoveFile(root, rel) {
  const { dir, base, missing } = walkParents(root, rel);
  if (missing) return false;
  const p = join(dir, base);
  const st = lstatOrNull(p);
  if (st === null || !st.isFile()) return false;
  unlinkSync(p);
  return true;
}

/**
 * Create the symlink `<root>/<rel>` -> `target` when nothing is at that path (parents are
 * checked and made). Returns false, changing nothing, when something (a dangling link
 * included) is already there: an existing path is never clobbered.
 */
export function safeSymlink(root, rel, target) {
  const { dir, base } = walkParents(root, rel, { create: true });
  const p = join(dir, base);
  if (lstatOrNull(p) !== null) return false;
  try {
    symlinkSync(target, p);
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    throw err;
  }
  return true;
}

// ── CLI ────────────────────────────────────────────────────────────────────
function main(argv) {
  const [verb, root, rel, arg] = argv;
  if (!verb || !root || !rel) {
    process.stderr.write(
      "usage: safe-write.mjs write|mkdir|check|remove|symlink <root> <rel> [arg]\n",
    );
    return 2;
  }
  try {
    switch (verb) {
      case "write":
        if (!arg) return 2;
        safeCopyFile(root, rel, arg);
        return 0;
      case "mkdir":
        safeMkdir(root, rel);
        return 0;
      case "check":
        checkPath(root, rel, arg === "dir" ? "dir" : "file");
        return 0;
      case "remove":
        safeRemoveFile(root, rel);
        return 0;
      case "symlink":
        if (!arg) return 2;
        safeSymlink(root, rel, arg);
        return 0;
      default:
        process.stderr.write(`safe-write: unknown verb ${verb}\n`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`${err && err.message ? err.message : err}\n`);
    return err instanceof UnsafePathError ? EXIT_UNSAFE : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
