// The release scripts (scripts/sbom.mjs, version.mjs, release-notes.mjs,
// provenance.mjs) — what .github/workflows/release.yml runs. Pins:
//   1 sbom: CycloneDX 1.5, the three workspace packages as components, every
//     component has a purl + license, dependency graph roots at the app;
//   2 version --check accepts the matching tag and refuses another;
//   3 version <x.y.z> bumps root + packages and cuts [Unreleased] (on a temp copy);
//   4 release-notes returns exactly one version's section, null for unknown;
//   5 provenance: in-toto v1 statement with sha256 subjects + SLSA v1 predicate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const rootVersion = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const node = (script, args = [], opts = {}) =>
  execFileSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    ...opts,
  });

test("sbom.mjs emits a CycloneDX 1.5 BOM of the runtime graph", () => {
  const bom = JSON.parse(node("sbom.mjs"));
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.5");
  assert.equal(bom.metadata.component.name, "gaffer");
  assert.equal(bom.metadata.component.version, rootVersion);
  assert.equal(bom.metadata.timestamp, undefined, "deterministic without --timestamp");
  const names = new Set(bom.components.map((c) => c.name));
  for (const n of ["dispatch", "crew", "memory-mcp"])
    assert.ok(names.has(n), `workspace package ${n} present`);
  assert.ok(bom.components.length > 50, `runtime deps present (${bom.components.length})`);
  for (const c of bom.components) {
    assert.match(c.purl, /^pkg:npm\/(%40[^/]+\/)?[^@]+@.+$/, `purl for ${c.name}`);
    assert.ok(Array.isArray(c.licenses) && c.licenses.length > 0, `license for ${c.name}`);
    assert.equal(c["bom-ref"], c.purl);
  }
  const scoped = bom.components.find((c) => c.name.startsWith("@"));
  assert.ok(scoped && scoped.purl.startsWith("pkg:npm/%40"), "scoped names percent-encode the @");
  const root = bom.dependencies.find((d) => d.ref === bom.metadata.component["bom-ref"]);
  assert.equal(root.dependsOn.length, 3, "the app depends on the three workspace packages");
  const refs = new Set(bom.components.map((c) => c["bom-ref"]));
  for (const d of bom.dependencies)
    for (const on of d.dependsOn)
      assert.ok(refs.has(on), `graph edge to a known component (${on})`);
  // Sorted output → byte-identical across runs.
  assert.equal(node("sbom.mjs"), node("sbom.mjs"));
});

test("version.mjs --check accepts the matching tag and refuses another", () => {
  node("version.mjs", ["--check", `v${rootVersion}`]);
  node("version.mjs", ["--check", `refs/tags/v${rootVersion}`]);
  assert.throws(
    () => node("version.mjs", ["--check", "v99.0.0"], { stdio: "pipe" }),
    /status 1|does not match/,
  );
});

test("version.mjs <x.y.z> moves every package and cuts the changelog (temp copy)", async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "gaffer-version-"));
  try {
    mkdirSync(path.join(tmp, "packages", "a"), { recursive: true });
    mkdirSync(path.join(tmp, "packages", "b"), { recursive: true });
    writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "x", version: "0.1.0", private: true }, null, 2),
    );
    writeFileSync(
      path.join(tmp, "packages", "a", "package.json"),
      JSON.stringify({ name: "a", version: "0.1.0" }, null, 2),
    );
    writeFileSync(
      path.join(tmp, "packages", "b", "package.json"),
      JSON.stringify({ name: "b", version: "0.2.0" }, null, 2),
    );
    writeFileSync(
      path.join(tmp, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n\n### Added\n\n- thing\n\n## [0.1.0] - 2026-01-01\n\n- first\n",
    );
    const { setVersion } = await import(
      `${path.join(ROOT, "scripts", "version.mjs")}?t=${randomUUID()}`
    );
    const touched = setVersion("0.3.0", { today: "2026-09-27", root: tmp });
    assert.equal(touched.length, 4);
    for (const f of ["package.json", "packages/a/package.json", "packages/b/package.json"]) {
      assert.equal(JSON.parse(readFileSync(path.join(tmp, f), "utf8")).version, "0.3.0", f);
    }
    const cl = readFileSync(path.join(tmp, "CHANGELOG.md"), "utf8");
    assert.match(cl, /## \[Unreleased\]\n\n## \[0\.3\.0\] - 2026-09-27\n\n### Added\n\n- thing/);
    assert.throws(() => setVersion("nope", { root: tmp }), /not a semver/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("release-notes.mjs returns one version's section", async () => {
  const { releaseNotes } = await import(path.join(ROOT, "scripts", "release-notes.mjs"));
  const cl =
    "# C\n\n## [Unreleased]\n\n- soon\n\n## [1.2.0] - 2026-02-02\n\n### Fixed\n\n- a bug\n\n## [1.1.0] - 2026-01-01\n\n- old\n";
  assert.equal(releaseNotes("1.2.0", cl), "### Fixed\n\n- a bug\n");
  assert.equal(releaseNotes("v1.1.0", cl), "- old\n");
  assert.equal(releaseNotes("9.9.9", cl), null);
  // The real changelog has a 0.1.0 section.
  assert.match(node("release-notes.mjs", ["0.1.0"]), /Initial public release/);
  assert.throws(
    () => node("release-notes.mjs", ["99.99.99"], { stdio: "pipe" }),
    /status 1|no CHANGELOG section/,
  );
});

test("provenance.mjs writes an in-toto v1 statement with SLSA v1 predicate over the artifacts", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "gaffer-prov-"));
  try {
    const a = path.join(tmp, "a.tgz");
    writeFileSync(a, "artifact-a");
    const out = path.join(tmp, "prov.json");
    node("provenance.mjs", ["--out", out, a], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "tmj-90/gaffer",
        GITHUB_SHA: "abc123",
        GITHUB_REF: "refs/tags/v0.1.0",
        GITHUB_RUN_ID: "42",
        GITHUB_RUN_ATTEMPT: "1",
      },
      stdio: "pipe",
    });
    const s = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(s._type, "https://in-toto.io/Statement/v1");
    assert.equal(s.predicateType, "https://slsa.dev/provenance/v1");
    assert.equal(s.subject.length, 1);
    assert.equal(s.subject[0].name, "a.tgz");
    assert.equal(
      s.subject[0].digest.sha256,
      createHash("sha256").update("artifact-a").digest("hex"),
    );
    assert.equal(s.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit, "abc123");
    assert.match(s.predicate.runDetails.metadata.invocationId, /actions\/runs\/42\/attempts\/1$/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
