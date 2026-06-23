import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkFileWrite } from "../src/safety/fsGuard.js";
import {
  classifyRootAccess,
  parseRoots,
  rootSetFromEnv,
  rootsConfigured,
  type RootSet,
} from "../src/safety/rootAccess.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";

/**
 * Parity tests for the repo-access boundary (FG-007). These mirror the cases in
 * `runner/test/safety-hook.test.mjs` so the TS guard's `classifyRootAccess`
 * agrees with the runtime hook's identically-named function: write inside a
 * write-root, write into a read-root, write outside all roots, read inside a
 * read-root, read outside, and branch-target classification.
 */

const WRITE_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "fg-write-")));
const READ_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "fg-read-")));
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), "fg-outside-")));

const roots: RootSet = { writeRoots: [WRITE_ROOT], readRoots: [READ_ROOT] };

describe("classifyRootAccess (parity with safety-hook.mjs)", () => {
  it("classifies a path inside a write-root as 'write'", () => {
    expect(classifyRootAccess(join(WRITE_ROOT, "src/app.ts"), roots)).toBe("write");
  });

  it("classifies the write-root itself as 'write'", () => {
    expect(classifyRootAccess(WRITE_ROOT, roots)).toBe("write");
  });

  it("classifies a path inside a read-root as 'read'", () => {
    expect(classifyRootAccess(join(READ_ROOT, "ctx.ts"), roots)).toBe("read");
  });

  it("classifies a path outside all roots as 'outside'", () => {
    expect(classifyRootAccess(join(OUTSIDE, "x.ts"), roots)).toBe("outside");
  });

  it("treats a write-root as readable too (write ∪ read)", () => {
    // A write-root classifies as 'write', which is a superset of read access.
    expect(classifyRootAccess(join(WRITE_ROOT, "x.ts"), roots)).not.toBe("outside");
  });

  it("denies a '..' escape out of the write-root (classified outside)", () => {
    expect(classifyRootAccess(join(WRITE_ROOT, "..", "escape.ts"), roots)).toBe("outside");
  });

  it("supports multiple write-roots", () => {
    const multi: RootSet = { writeRoots: [WRITE_ROOT, OUTSIDE], readRoots: [] };
    expect(classifyRootAccess(join(OUTSIDE, "app.ts"), multi)).toBe("write");
  });
});

describe("parseRoots", () => {
  it("splits a colon-separated list", () => {
    expect(parseRoots(`${WRITE_ROOT}:${OUTSIDE}`)).toEqual([WRITE_ROOT, OUTSIDE]);
  });

  it("splits a newline-separated list", () => {
    expect(parseRoots(`${WRITE_ROOT}\n${OUTSIDE}`)).toEqual([WRITE_ROOT, OUTSIDE]);
  });

  it("returns [] for empty/undefined", () => {
    expect(parseRoots(undefined)).toEqual([]);
    expect(parseRoots("")).toEqual([]);
  });

  it("reads roots from the GAFFER_*_ROOTS env contract", () => {
    const set = rootSetFromEnv({
      GAFFER_WRITE_ROOTS: WRITE_ROOT,
      GAFFER_READ_ROOTS: READ_ROOT,
    } as NodeJS.ProcessEnv);
    expect(set.writeRoots).toEqual([WRITE_ROOT]);
    expect(set.readRoots).toEqual([READ_ROOT]);
    expect(rootsConfigured(set)).toBe(true);
  });

  it("rootsConfigured is false when nothing is set (single-repo fallback)", () => {
    expect(rootsConfigured({ writeRoots: [], readRoots: [] })).toBe(false);
  });
});

describe("checkFileWrite wired to the root boundary", () => {
  const policy = defaultSafetyPolicy();

  it("allows a write inside a write-root", () => {
    const d = checkFileWrite(join(WRITE_ROOT, "src/app.ts"), {
      repoRoot: WRITE_ROOT,
      policy: policy.filesystem,
      roots,
    });
    expect(d.outcome).toBe("allowed");
  });

  it("denies a write into a read-only root", () => {
    const d = checkFileWrite(join(READ_ROOT, "src/app.ts"), {
      repoRoot: WRITE_ROOT,
      policy: policy.filesystem,
      roots,
    });
    expect(d.outcome).toBe("denied");
    expect(d.rule).toBe("fs.outside_write_roots");
  });

  it("denies a write outside all roots", () => {
    const d = checkFileWrite(join(OUTSIDE, "app.ts"), {
      repoRoot: WRITE_ROOT,
      policy: policy.filesystem,
      roots,
    });
    expect(d.outcome).toBe("denied");
    expect(d.rule).toBe("fs.outside_write_roots");
  });

  it("falls back to single repoRoot when roots are unset (today's behaviour)", () => {
    // No roots → today's single-repo check: in-root allowed, out-of-root denied.
    const inRoot = checkFileWrite("src/index.ts", {
      repoRoot: WRITE_ROOT,
      policy: policy.filesystem,
    });
    expect(inRoot.outcome).toBe("allowed");
    const outRoot = checkFileWrite("../../etc/passwd", {
      repoRoot: WRITE_ROOT,
      policy: policy.filesystem,
    });
    expect(outRoot.outcome).toBe("denied");
    expect(outRoot.rule).toBe("fs.outside_root");
  });
});
