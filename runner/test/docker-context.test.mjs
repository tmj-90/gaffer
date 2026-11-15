// =====================================================================
// DOCKER BUILD CONTEXT (external review #9) — the documented `docker build .` must never
// bake ./repos, a .env, a database or factory state into the image.
//   • the REAL .dockerignore, evaluated by scripts/docker-context-check.mjs with Docker's
//     matching rules, excludes every hostile probe path and keeps every build input;
//   • a fixture tree with planted repos/, .env, *.sqlite and .gaffer/ next to real
//     sources: the context holds the sources and none of the plants;
//   • the OLD deny-list (the regression) is caught: repos/ and .env reached the context;
//   • the matcher follows Docker's semantics (`**`, `!` re-includes, last match wins,
//     a parent-directory match covers what is under it).
//   • PINS (F5): every repo Dockerfile names its base image by digest and installs the
//     Claude Code CLI at an exact version (through an ARG default); the gate refuses a
//     FROM by tag, an `npm install -g` with no version, `@latest`, or an ARG with no
//     exact default, and accepts an earlier stage, scratch and `pkg@${ARG}`.
// Run: node --test runner/test/docker-context.test.mjs
// =====================================================================
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import * as ctx from "../../scripts/docker-context-check.mjs";
import {
  checkContext,
  isExcluded,
  parseIgnore,
  PROBE_PATHS,
  REQUIRED_PATHS,
} from "../../scripts/docker-context-check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const IGNORE = readFileSync(join(ROOT, ".dockerignore"), "utf8");

test("the real .dockerignore excludes every hostile path and keeps every build input", () => {
  const rules = parseIgnore(IGNORE);
  for (const p of PROBE_PATHS) assert.ok(isExcluded(rules, p), `${p} would enter the image`);
  for (const p of REQUIRED_PATHS) assert.ok(!isExcluded(rules, p), `${p} would be missing`);
});

function fixture() {
  const dir = gafferMkdtemp(join(tmpdir(), "docker-ctx-"));
  const put = (rel, body = "x") => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  for (const f of REQUIRED_PATHS) put(f);
  put("packages/dispatch/src/api/routes/repos.ts"); // a source file NAMED repos stays
  put("repos/app/src/index.ts");
  put("repos/app/.env", "TOKEN=1");
  put(".env", "ANTHROPIC_API_KEY=sk-test");
  put(".gaffer/dispatch.sqlite");
  put(".gaffer/settings.json", "{}");
  put("packages/memory/memory.sqlite");
  put("runner/.env.local", "X=1");
  put("node_modules/x/index.js");
  put("docs/notes.md");
  return dir;
}

test("a tree with planted repos/, .env, *.sqlite and .gaffer/: only the sources enter", () => {
  const dir = fixture();
  try {
    const { context, violations, missing } = checkContext(dir, { ignoreText: IGNORE });
    assert.deepEqual(violations, []);
    assert.deepEqual(missing, []);
    assert.ok(context.includes("packages/dispatch/src/core.ts"));
    assert.ok(context.includes("packages/dispatch/src/api/routes/repos.ts"));
    for (const bad of ["repos/app/src/index.ts", ".env", ".gaffer/settings.json", "docs/notes.md"])
      assert.ok(!context.includes(bad), `${bad} is in the context`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the old deny-list is caught: repos/ and .env reached the build context", () => {
  const OLD =
    ".git\n.gaffer\n.crew\nnode_modules\n**/node_modules\n**/dist\n**/coverage\n" +
    "**/*.tsbuildinfo\ndocs/img\n.devcontainer\ncompose.yaml\n";
  const dir = fixture();
  try {
    const { violations } = checkContext(dir, { ignoreText: OLD });
    const paths = violations.map((v) => v.path);
    assert.ok(paths.includes("repos/app/src/index.ts"));
    assert.ok(paths.includes(".env"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the matcher follows Docker's rules", () => {
  const r = parseIgnore("*\n!packages\n**/node_modules\n!packages/keep/node_modules/ok.js\n");
  assert.equal(isExcluded(r, "README.md"), true); // `*` matches a top-level entry
  assert.equal(isExcluded(r, "packages/a/src/x.ts"), false); // re-included directory
  assert.equal(isExcluded(r, "packages/a/node_modules/m/i.js"), true); // `**` anywhere
  assert.equal(isExcluded(r, "packages/keep/node_modules/ok.js"), false); // last match wins
  const r2 = parseIgnore("/build/\n./tmp\n");
  assert.equal(isExcluded(r2, "build/out.js"), true); // leading slash + trailing slash cleaned
  assert.equal(isExcluded(r2, "tmp/a"), true);
  assert.equal(isExcluded(r2, "src/build/out.js"), false); // anchored at the root
});

test("every repo Dockerfile is pinned (base image by digest, the CLI at an exact version)", () => {
  assert.equal(typeof ctx.checkPins, "function", "the pin gate exists");
  assert.deepEqual(ctx.checkPins(ROOT), []);
  for (const f of ["Dockerfile", "runner/sandbox/Dockerfile"]) {
    const text = readFileSync(join(ROOT, f), "utf8");
    assert.match(
      text,
      /^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m,
      `${f} pins the CLI through an ARG`,
    );
    assert.match(text, /npm install -g "@anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\}"/, f);
  }
});

test("the pin gate refuses what floats and accepts what is pinned", () => {
  assert.equal(typeof ctx.unpinnedLines, "function", "the pin gate exists");
  const why = (t) => ctx.unpinnedLines(t).map((u) => u.why);
  const D = "sha256:" + "a".repeat(64);
  assert.equal(why("FROM node:22-bookworm-slim").length, 1);
  assert.equal(why("FROM --platform=linux/amd64 node:22").length, 1);
  assert.equal(why("RUN npm install -g @anthropic-ai/claude-code").length, 1);
  assert.equal(why("RUN npm install -g @anthropic-ai/claude-code@latest").length, 1);
  assert.equal(why('ARG V\nRUN npm install -g "x@${V}"').length, 1);
  assert.equal(why("RUN npm i --global x@^1.2.0").length, 1);
  assert.deepEqual(why(`FROM node:22@${D} AS build\nFROM build\nFROM scratch`), []);
  assert.deepEqual(why('ARG V=2.1.0\nRUN npm install -g "x@${V}" y@1.0.0-rc.1'), []);
});
