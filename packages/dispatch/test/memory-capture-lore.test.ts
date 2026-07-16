/**
 * memoryReader.captureLoreDraft — dispatch files a lore DRAFT via the memory CLI's
 * `suggest` verb (human-gated; never a memory-DB write). Best-effort + boundary-safe.
 * Driven against a FAKE memory CLI bin so the test is hermetic (no real Memory install).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryReader } from "../src/api/memoryReader.js";

describe("memoryReader.captureLoreDraft", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gaffer-lore-capture-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const env = (bin?: string): NodeJS.ProcessEnv =>
    ({
      ...(bin ? { MEMORY_CLI_BIN: bin } : {}),
      MEMORY_DB: join(dir, "m.sqlite"),
    }) as unknown as NodeJS.ProcessEnv;

  it("is unavailable (fail-soft) when the memory CLI is not configured", () => {
    const r = createMemoryReader(env()).captureLoreDraft({ title: "t", summary: "s" });
    expect(r.available).toBe(false);
  });

  it("refuses an empty title or summary before spawning anything", () => {
    const bin = join(dir, "should-not-run.cjs");
    writeFileSync(bin, "process.exit(3);"); // would fail if invoked
    expect(
      createMemoryReader(env(bin)).captureLoreDraft({ title: "", summary: "s" }).available,
    ).toBe(false);
    expect(
      createMemoryReader(env(bin)).captureLoreDraft({ title: "t", summary: "  " }).available,
    ).toBe(false);
  });

  it("files a draft via `suggest` with the right argv and returns the parsed id", () => {
    const argsFile = join(dir, "args.json");
    const bin = join(dir, "fake-memory.cjs");
    // Fake CLI: record its argv, assert the suggest verb + flags, print the real output shape.
    writeFileSync(
      bin,
      `const fs=require("fs");
       const a=process.argv.slice(2);
       fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(a));
       if(a[0]!=="suggest"){process.stderr.write("bad verb");process.exit(1);}
       if(!a.includes("--title")||!a.includes("--summary")){process.exit(1);}
       process.stdout.write("memory: suggested j22gx25n (draft)\\n");`,
    );
    const r = createMemoryReader(env(bin)).captureLoreDraft({
      title: "Review feedback: #7 add reset flow",
      summary: "Rejected: token expiry not tested",
      tags: ["review-rejection", "ticket-7"],
    });
    expect(r.available).toBe(true);
    if (r.available) expect(r.id).toBe("j22gx25n");
    const argv = JSON.parse(require("node:fs").readFileSync(argsFile, "utf8")) as string[];
    expect(argv[0]).toBe("suggest");
    expect(argv).toContain("--tag");
    expect(argv).toContain("ticket-7");
    // The reason text is a discrete argv element (no shell) — injection-safe.
    expect(argv).toContain("Rejected: token expiry not tested");
  });

  it("is unavailable (fail-soft, not thrown) when the CLI exits non-zero", () => {
    const bin = join(dir, "boom.cjs");
    writeFileSync(bin, "process.exit(1);");
    const r = createMemoryReader(env(bin)).captureLoreDraft({ title: "t", summary: "s" });
    expect(r.available).toBe(false);
  });
});
