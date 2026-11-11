// The idle maintenance scans read a registered repository's files on the host and put what
// they find (file paths, import names, source snippets, README commands) into draft tickets
// and lore suggestions. A committed symlink to a file or directory OUTSIDE the repository
// must not carry the operator's other files into those drafts (external review 17,
// read side): walkFiles never follows a link, and the documentation and dependency scans
// read their README / package.json only when it resolves inside the repository (a README
// linked within the repo still counts).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { scanDocs } from "../src/loops/idleDocs.js";
import { scanDependencies } from "../src/loops/idleDependencies.js";
import { walkFiles } from "../src/loops/idleScans.js";
import type { RepoConfig } from "../src/config/schema.js";

const dirs: string[] = [];
function tmp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "idle-scan-links-")));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("idle scans never read through a link out of the repository", () => {
  it("walkFiles lists only regular files reached through real directories", () => {
    const base = tmp();
    const repo = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(outside, "secret.ts"), "export const OPERATOR = 1;\n");
    symlinkSync(join(outside, "secret.ts"), join(repo, "src", "leak.ts"));
    symlinkSync(outside, join(repo, "vendor"));
    const files = walkFiles(repo, (n) => n.endsWith(".ts")).map((p) => relative(repo, p));
    expect(files).toEqual(["src/a.ts"]);
  });

  it("scanDocs does not read a README linked to a file outside the repository", () => {
    const base = tmp();
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(base, "notes.md"), "# Notes\n\n```\nyarn add OUTSIDE-SECRET-TOKEN\n```\n");
    symlinkSync(join(base, "notes.md"), join(repo, "README.md"));
    const repoCfg = { name: "r", path: repo, package_manager: "npm" } as unknown as RepoConfig;
    const findings = scanDocs(repoCfg, repo);
    expect(JSON.stringify(findings)).not.toContain("OUTSIDE-SECRET-TOKEN");
  });

  it("scanDocs still reads a README linked inside the repository", () => {
    const repo = tmp();
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(
      join(repo, "docs", "README.md"),
      "# App\n\n## Install\n\n```\nnpm install\n```\n",
    );
    symlinkSync("docs/README.md", join(repo, "README.md"));
    const repoCfg = { name: "r", path: repo, package_manager: "npm" } as unknown as RepoConfig;
    expect(scanDocs(repoCfg, repo)).toEqual([]);
  });

  it("scanDependencies does not quote a package.json linked outside the repository", () => {
    const base = tmp();
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(
      join(base, "other.json"),
      JSON.stringify({ dependencies: { "outside-secret-pkg": "*" } }),
    );
    symlinkSync(join(base, "other.json"), join(repo, "package.json"));
    const deps = {
      config: { loops: { idle_dependencies: { audit_command: "" } } },
    } as unknown as Parameters<typeof scanDependencies>[0];
    const repoCfg = { name: "r", path: repo } as unknown as RepoConfig;
    expect(JSON.stringify(scanDependencies(deps, repoCfg, repo))).not.toContain(
      "outside-secret-pkg",
    );
  });
});
