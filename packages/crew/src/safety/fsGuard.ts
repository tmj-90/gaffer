import { isAbsolute, relative, resolve } from "node:path";

import { allow, deny, needsApproval, type SafetyDecision } from "./decision.js";
import { matchesAnyGlob, normaliseRelative } from "./glob.js";
import type { FilesystemPolicy } from "./policySchema.js";
import { classifyRootAccess, rootsConfigured, type RootSet } from "./rootAccess.js";

export interface FsGuardContext {
  /** Absolute path of the repository root the write must stay within. */
  repoRoot: string;
  policy: FilesystemPolicy;
  /**
   * Optional repo-access boundary (FG-007). When provided AND configured (any
   * write/read root present), a write must resolve inside a write-root —
   * mirroring the runtime safety hook. A write into a read-only root, or outside
   * all roots, is denied with `fs.outside_write_roots`. When absent or empty,
   * the single-`repoRoot` check below applies (today's single-repo behaviour).
   */
  roots?: RootSet;
}

/** True when `target` resolves inside `root` (or is `root` itself). */
function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Filesystem write guard. In priority order:
 *  1. DENY writes outside the repo root (path traversal / arbitrary FS access).
 *  2. DENY writes to secret/`.git` paths.
 *  3. NEEDS_APPROVAL for build/deploy/dependency/migration files.
 *  4. ALLOW everything else under the root.
 */
export function checkFileWrite(targetPath: string, ctx: FsGuardContext): SafetyDecision {
  const absolute = isAbsolute(targetPath) ? targetPath : resolve(ctx.repoRoot, targetPath);

  // Repo-access boundary (FG-007): when roots are explicitly configured, the
  // write must land inside a write-root (parity with the runtime hook). This
  // supersedes the single-repoRoot check below for multi-repo runs.
  if (ctx.roots && rootsConfigured(ctx.roots)) {
    const access = classifyRootAccess(absolute, ctx.roots);
    if (access !== "write") {
      return deny(
        `Write to '${targetPath}' is outside the write-roots (target is ${
          access === "read" ? "a read-only root" : "outside all roots"
        }).`,
        "fs.outside_write_roots",
      );
    }
  } else if (!isInsideRoot(ctx.repoRoot, absolute)) {
    return deny(
      `Write to '${targetPath}' is outside the repo root '${ctx.repoRoot}'.`,
      "fs.outside_root",
    );
  }

  const rel = normaliseRelative(relative(resolve(ctx.repoRoot), resolve(absolute)));

  if (matchesAnyGlob(rel, ctx.policy.deny_write_paths)) {
    return deny(`Write to '${rel}' is a denied secret/protected path.`, "fs.denied_path");
  }

  if (matchesAnyGlob(rel, ctx.policy.require_approval_write_paths)) {
    return needsApproval(
      `Write to '${rel}' affects build/deploy/dependencies/data and requires approval.`,
      `path:${rel}`,
      "fs.approval_path",
    );
  }

  return allow(`Write to '${rel}' is within policy.`, "fs.ok");
}
