#!/usr/bin/env node
// Secret-path PRECISION. The `.env` / `credentials` / `secrets` fragments used to
// match any word, so ordinary Node work (`grep -rn "process.env.PORT" src`, a
// `secrets.test.ts`, `grep -rn credentials src/`) was refused, and a committed
// `.env.example` could never be read, edited, diffed or staged. Now only path-shaped
// mentions are secrets, a search PATTERN is never mistaken for a file, and a TRACKED
// env template is ordinary content — while every real secret stays blocked:
// `.env`, `.env.local`, `.env.test`, keys, credentials files, an UNTRACKED template
// (could be a renamed .env) and a template symlinked to `.env`.
// Run: node test/safety-hook-secret-precision.test.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { bash, read, scratchDir, suite, tool, write } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-secret-precision");
const REPO = scratchDir("gaffer-precision-");
t.cleanup(REPO);
const git = (...a) =>
  spawnSync("git", ["-C", REPO, "-c", "user.email=t@t", "-c", "user.name=t", ...a], {
    encoding: "utf8",
  });
git("init", "-q");
mkdirSync(`${REPO}/src`, { recursive: true });
writeFileSync(`${REPO}/.env.example`, "PORT=\n");
writeFileSync(`${REPO}/src/x.ts`, "export const p = process.env.PORT;\n");
git("add", ".env.example", "src/x.ts");
git("commit", "-qm", "init");
writeFileSync(`${REPO}/.env`, "API_KEY=sk-live\n");
writeFileSync(`${REPO}/.env.sample`, "API_KEY=sk-live\n"); // UNTRACKED template
mkdirSync(`${REPO}/linked`, { recursive: true });
symlinkSync(`${REPO}/.env`, `${REPO}/linked/.env.example`); // template → real .env
const opts = { env: { GAFFER_WRITE_ROOTS: REPO, GAFFER_READ_ROOTS: "" }, cwd: REPO };

// False positives — now ALLOWED.
for (const cmd of [
  'grep -rn "process.env.PORT" src',
  "rg process.env src",
  "sed -i 's/process.env.A/process.env.B/' src/x.ts",
  'node -e "console.log(process.env.PORT)"',
  "pnpm vitest run test/secrets.test.ts",
  "grep -rn credentials src/",
  "grep -rn -e credentials src/",
  "rg -n credentials.json src",
  "grep -rn getSecret src",
  'grep -rn "secret" src',
  "cat src/credentials.ts",
  "cat src/app.env.ts",
  "cat .env.example",
  "git diff .env.example",
  "git add .env.example",
]) {
  t.allow(`false positive fixed: ${cmd}`, bash(cmd), opts);
}
t.allow("Read tracked .env.example", read(".env.example"), opts);
t.allow("Edit tracked .env.example", tool("Edit", { file_path: ".env.example" }), opts);
t.allow("Write a new .env.template (agent supplies the content)", write(".env.template"), opts);

// Real secrets — still DENIED.
for (const cmd of [
  "cat .env",
  "cat ./.env",
  "cat $HOME/.env",
  "cat .env.local",
  "cat .env.test",
  "cp .env /tmp/x",
  "grep -n KEY .env",
  "grep -f .env src/x.ts",
  "cat prod.env",
  "f=prod.env; cat $f",
  "cat secrets.json",
  "cat config/secrets/db.yml",
  "cat credentials",
  "cat .credentials.json",
  "cat ~/.aws/credentials",
  "cat deploy.key",
  "cat src/i18n/en.key",
  "cat server.pem",
  "cat .env.sample",
  "git add .env.sample",
  "git diff .env.sample",
  "cat linked/.env.example",
  "cd /tmp && cat .env.example",
  "git add .",
  // The control-plane DB reach that the `.env` false positive used to block by accident.
  `node -e "require('better-sqlite3')(process.env.DISPATCH_DB)"`,
  `node -e "require('better-sqlite3')(process.env['MEMORY_DB'])"`,
  `python3 -c "import os,sqlite3; sqlite3.connect(os.environ['DISPATCH_DB'])"`,
  `python3 -c "import os,sqlite3; sqlite3.connect(os.getenv('MEMORY_DB'))"`,
]) {
  t.deny(`real secret: ${cmd}`, bash(cmd), opts);
}
for (const f of [
  ".env",
  ".env.local",
  ".env.test",
  ".env.sample",
  "linked/.env.example",
  "prod.env",
]) {
  t.deny(`Read ${f}`, read(f), opts);
}
t.deny(
  "Edit untracked .env.sample (Edit echoes content)",
  tool("Edit", { file_path: ".env.sample" }),
  opts,
);
t.deny("Write .env.local", write(".env.local"), opts);

// `git add .` sweeps the UNTRACKED .env.sample → denied (above). Once only the tracked
// template is modified, a blanket add is fine.
spawnSync("rm", ["-rf", `${REPO}/.env`, `${REPO}/.env.sample`, `${REPO}/linked`]);
writeFileSync(`${REPO}/.env.example`, "PORT=\nNEW_VAR=\n");
t.allow("git add . with only a modified TRACKED template", bash("git add ."), opts);
git("add", ".env.example");
t.allow("git commit with a staged TRACKED template", bash('git commit -m "docs: NEW_VAR"'), opts);

t.done();
