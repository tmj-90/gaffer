#!/usr/bin/env node
// Read operands after shell expansion (F1 of the 2026-11 hook audit). The read checks
// used to SKIP any operand with a wildcard, a brace or a variable, so in the production
// profile `cat $GAFFER_DATA/dashboard-*` printed the operator's REST token and
// `cp $GAFFER_DATA/mcp-r* src/x` copied the MCP claim token into the worktree. Every read
// operand is now expanded the way the shell would (lib/hook/expand.mjs) and judged like a
// literal one (lib/hook/read-operands.mjs); what the hook cannot expand is refused.
// Also the regression over the auditor's whole payload set: nothing denied on main
// 2fe3589 may become allowed (fixtures/hook-audit-2026-11.mjs).
// Run: node test/safety-hook-globs.test.mjs
import { spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { decide } from "../safety-hook-core.mjs";
import { DENIED_BEFORE, PAYLOADS } from "./fixtures/hook-audit-2026-11.mjs";
import { RUNNER_DIR, bash, scratchDir, suite, tool } from "./lib/hook-harness.mjs";

const t = suite("safety-hook-globs");
const git = (dir, ...args) => {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
};
const put = (path, text = "x\n") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

// ---- the fixture: the delivery worktree lives under GAFFER_DATA, as in production ----
const BASE = scratchDir("gaffer-globs-");
t.cleanup(BASE);
const DATA = `${BASE}/data`;
const WORK = `${DATA}/worktrees/ticket-1/repo`;
const READ = `${BASE}/read`;
put(`${DATA}/dashboard-token`, "operator-rest-token\n");
put(`${DATA}/mcp-runtime.json`, '{"GAFFER_CLAIM_TOKEN":"claim"}\n');
put(`${DATA}/tool-metrics.jsonl`, "{}\n");
put(`${READ}/docs/notes.md`);
for (const f of [
  "src/a.ts",
  "src/b.ts",
  "test/x.test.js",
  "README.md",
  "package.json",
  "list.txt",
]) {
  put(`${WORK}/${f}`);
}
put(`${WORK}/.env`, "SECRET=1\n");
git(WORK, "init", "-q", "-b", "main");
git(WORK, "add", "src", "test", "README.md", "package.json");
git(WORK, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "seed");
// A symlink planted in the worktree that points at the token.
mkdirSync(`${WORK}/lnk`);
symlinkSync(`${DATA}/dashboard-token`, `${WORK}/lnk/tok`);
// Links planted by an earlier call whose `..` the kernel takes physically: wt/.. and
// p/q/s/../../.. are the data directory, not the worktree a lexical join gives.
mkdirSync(`${WORK}/dd/p/q`, { recursive: true });
symlinkSync(`${DATA}/worktrees`, `${WORK}/dd/wt`);
symlinkSync("../../..", `${WORK}/dd/p/q/s`);
// More matches than a glob may produce.
mkdirSync(`${WORK}/many`);
for (let i = 0; i < 2100; i += 1) writeFileSync(`${WORK}/many/f${i}`, "");
// A symlink loop.
mkdirSync(`${WORK}/loopdir`);
symlinkSync(".", `${WORK}/loopdir/self`);

const common = { GAFFER_DATA: DATA, MCP_CONFIG: `${DATA}/mcp-runtime.json` };
const PROFILES = {
  roots: { ...common, GAFFER_WRITE_ROOTS: WORK, GAFFER_READ_ROOTS: READ },
  bootstrap: {
    ...common,
    GAFFER_WRITE_ROOTS: WORK,
    GAFFER_READ_ROOTS: READ,
    GAFFER_BOOTSTRAP_INSTALL: "1",
    GAFFER_BOOTSTRAP_DIR: WORK,
  },
  open: { ...common, GAFFER_WRITE_ROOTS: "", GAFFER_READ_ROOTS: "" },
};
const each = (kind, label, payload, profiles = Object.keys(PROFILES)) => {
  for (const p of profiles) t[kind](`[${p}] ${label}`, payload, { env: PROFILES[p], cwd: WORK });
};

// ---- F1: the audit's payloads, denied in every profile --------------------------------
for (const cmd of [
  "cat $GAFFER_DATA/dashboard-*",
  "cat $GAFFER_DATA/*",
  "head $GAFFER_DATA/d*",
  "head -c 99 $GAFFER_DATA/d*",
  "cat $GAFFER_DATA/mcp-r*",
  "cat $GAFFER_DATA/m*",
  "cat $GAFFER_DATA/dashboard-toke{n,}",
  'cat "$GAFFER_DATA"/dash*',
  "cp $GAFFER_DATA/dashboard-* src/leak.txt",
  "cat $MCP_CONFIG",
  "cat $GAFFER_DATA/dashboard-toke''n",
  "cat ${GAFFER_DATA}/dashboard-to?en",
  "cat $GAFFER_DATA/[d]ashb*",
  "cat ../../../d*",
  "cat ../../../{dashboard-token,x}",
  // every reader, not only cat
  "xxd $GAFFER_DATA/d*",
  "od -c $GAFFER_DATA/d*",
  "base64 $GAFFER_DATA/d*",
  "sort $GAFFER_DATA/d*",
  "awk 1 $GAFFER_DATA/d*",
  "sed -n p $GAFFER_DATA/d*",
  "strings $GAFFER_DATA/d*",
  "less $GAFFER_DATA/d*",
  "tail -n 5 $GAFFER_DATA/d*",
  "grep -h . $GAFFER_DATA/d*",
  "rev $GAFFER_DATA/d*",
  "python3 $GAFFER_DATA/d*",
  "dd if=$GAFFER_DATA/dashboard-toke? of=src/x",
  // copy / move / link a secret into the worktree
  "mv $GAFFER_DATA/dash* src/",
  "ln -s $GAFFER_DATA/dash* src/t",
  'ln -s "$GAFFER_DATA" src/d',
  "install $GAFFER_DATA/dash* src/t",
  "rsync -a $GAFFER_DATA/ src/x/",
  "cp -r $GAFFER_DATA src/x",
  // directories that hold the secrets
  "tar c $GAFFER_DATA",
  'tar cf - -C "$GAFFER_DATA" .',
  "grep -r . $GAFFER_DATA",
  "find $GAFFER_DATA -type f -exec cat {} +",
  "find $GAFFER_DATA -type f | xargs cat",
  "ls $GAFFER_DATA | xargs -I{} cat $GAFFER_DATA/{}",
  "cat $GAFFER_DATA/nomatch*",
  // redirects, substitutions, nested shells, variables
  "while read l; do echo $l; done < $GAFFER_DATA/d*",
  'echo "$(< $GAFFER_DATA/d*)"',
  "source $GAFFER_DATA/d*",
  'sh -c "cat $GAFFER_DATA/d*"',
  'eval "cat $GAFFER_DATA/d*"',
  "d=$GAFFER_DATA; cat $d/d*",
  "export D=$GAFFER_DATA && head $D/m*",
  "cd $GAFFER_DATA && cat d*",
  'for f in $GAFFER_DATA/*; do cat "$f"; done',
  // a symlink in the worktree that points at the token, reached through a glob
  "cat lnk/*",
  "cat lnk/t*",
  "grep -R operator lnk",
  "cp -rL lnk src/copy",
]) {
  each("deny", cmd, bash(cmd));
}

// What the hook cannot expand is refused, with a message that says to name the file.
for (const cmd of [
  'while read f; do cat "$f"; done < list.txt',
  'cat "$1"',
  "cat src/$(echo a).ts",
  "cat src/$((1+1)).ts",
  "find . -name '*.ts' | xargs -I{} cat {}",
  "cat many/*",
]) {
  each("deny", `unexpandable or over the cap: ${cmd}`, bash(cmd));
}
// A variable set by `read` holds anything; an unset one is empty (bash), so `cat src/$X`
// with X unset reads the directory src/ and stays allowed.
each("deny", "read X < list.txt; cat src/$X", bash("read X < list.txt; cat src/$X"));
each("allow", "cat src/$UNSET_IN_ENV", bash("cat src/$UNSET_IN_ENV"));
// `$_` is the last argument of the previous command after expansion, not an unset
// variable: listing a secret is allowed, so `$_` would carry its path to a reader.
for (const cmd of [
  "ls $GAFFER_DATA/dashboard-token; cat $_",
  "ls $GAFFER_DATA/d*; cat $_",
  'ls $GAFFER_DATA/d* >/dev/null; cat "$_"',
  "stat $GAFFER_DATA/dashboard-to?en >/dev/null && cat $_",
  "ls $GAFFER_DATA >/dev/null; cat $_/d*",
  "ls $MCP_CONFIG; base64 ${_}",
  "ls $GAFFER_DATA/m* && cp $_ src/leak.txt",
]) {
  each("deny", `last-argument $_: ${cmd}`, bash(cmd));
}
// `..` after a symlinked directory is taken physically (the kernel's way); a `..` after
// a path this command may still create is refused; CDPATH makes a relative cd unknown;
// an extglob group with no `*`, `?` or `[` is still a glob.
for (const cmd of [
  "cat dd/wt/../d*",
  "cat dd/wt/../m*",
  "head -c 99 dd/wt/../dash*",
  "cp dd/wt/../d* src/x",
  "cat dd/p/q/s/../../../d*",
  "cat dd/p/q/s/../../../dashboard-tok?n",
  "cd -P dd/wt/.. && cat d*",
  "cd dd/wt/..; cat ./m*",
  "tar cf - -C dd/wt/.. .",
  "grep -r . dd/wt/..",
  "mkdir -p n/m && cat n/m/../../../../d*",
  "CDPATH=$GAFFER_DATA/..; cd data && cat d*",
  "export CDPATH=$GAFFER_DATA; cd worktrees/..; cat m*",
  "shopt -s extglob\ncat +(.)env",
  "shopt -s extglob\ncat @(.)env",
  "shopt -s extglob\ngrep x ?(.)env",
]) {
  each("deny", `physical ..: ${cmd.replace("\n", "; ")}`, bash(cmd));
}
for (const cmd of [
  "cat ./src/../README.md",
  "cd src && cat ../README.md",
  "cd .. && cd repo && cat README.md",
  "cat src/@types.ts",
]) {
  each("allow", `physical ..: ${cmd}`, bash(cmd));
}
// The file tools and a bash redirect judge the physical place too: `dd/wt/..` is the
// data directory, whatever a lexical resolve says.
{
  const via = `${WORK}/dd/wt/..`;
  each(
    "deny",
    "Write through wt/..",
    tool("Write", { file_path: `${via}/settings.json`, content: "{}" }),
  );
  each(
    "deny",
    "Edit through wt/..",
    tool("Edit", { file_path: `${via}/tool-metrics.jsonl`, old_string: "{}", new_string: "x" }),
    ["roots", "bootstrap"],
  );
  each(
    "deny",
    "NotebookEdit through wt/..",
    tool("NotebookEdit", { notebook_path: `${via}/x.ipynb`, new_source: "x" }),
  );
  each("deny", "Read through wt/..", tool("Read", { file_path: `${via}/tool-metrics.jsonl` }), [
    "roots",
    "bootstrap",
  ]);
  each(
    "deny",
    "Grep content through wt/..",
    tool("Grep", { pattern: ".", path: via, output_mode: "content" }),
  );
  each(
    "deny",
    "Grep relative wt/..",
    tool("Grep", { pattern: ".", path: "dd/wt/..", output_mode: "content" }),
  );
  each("deny", "redirect through wt/..", bash("echo x > dd/wt/../settings.json"));
  each("deny", "append through wt/..", bash("printf x >> dd/wt/../usage-pause.json"));
  each(
    "allow",
    "Write with a plain ..",
    tool("Write", { file_path: `${WORK}/src/../notes.md`, content: "x" }),
  );
  each("allow", "Grep with a plain ..", tool("Grep", { pattern: "x", path: `${WORK}/src/..` }));
}
// File names from a listing of a directory that holds secrets reach whatever program a
// loop or xargs runs, recognised reader or not.
for (const cmd of [
  'find $GAFFER_DATA -type f | while read f; do gzip -c "$f"; done',
  'find $GAFFER_DATA -type f | while read f; do zstd -c "$f"; done',
  'ls $GAFFER_DATA | while read f; do xz -c "$GAFFER_DATA/$f"; done',
  'for f in $(ls $GAFFER_DATA); do gzip -c "$GAFFER_DATA/$f"; done',
  'while read f; do iconv -f utf8 "$f"; done <<< "$(find $GAFFER_DATA -type f)"',
  'find $GAFFER_DATA -type f > list.txt; while read f; do lz4 -c "$f"; done < list.txt',
  'find $GAFFER_DATA -type f -print0 | while IFS= read -r -d "" f; do cut -c1- "$f"; done',
  'cd $GAFFER_DATA; find . -type f | while read f; do gzip -c "$f"; done',
  `find ${DATA} -type f | while read f; do bzip2 -c "$f"; done`,
  "cd $GAFFER_DATA && find -type f | xargs gzip -c",
  "find $GAFFER_DATA -type f | xargs -n1 zstd -c",
]) {
  each("deny", `names from a secret listing: ${cmd}`, bash(cmd));
}
for (const cmd of [
  'git ls-files | while read f; do wc -l "$f"; done',
  'for f in $(git ls-files); do wc -l "$f"; done',
  'git diff --name-only | while read f; do npx prettier --check "$f"; done',
  'cd src && ls | while read f; do echo "$f"; done',
  "git ls-files | xargs gzip -k",
  'find src -name "*.ts" | xargs wc -l',
]) {
  each("allow", `names from the worktree: ${cmd}`, bash(cmd));
}
// Archivers and git readers beyond tar / zip.
for (const cmd of [
  "7z a /dev/stdout $GAFFER_DATA",
  "7za a -so x $GAFFER_DATA",
  "pax -w $GAFFER_DATA",
  "find $GAFFER_DATA | pax -w",
  "bsdtar cf - $GAFFER_DATA",
  "bsdtar -C $GAFFER_DATA -cf - .",
  "gtar cf - dd/wt/..",
  "find $GAFFER_DATA | cpio -o",
  "git grep --no-index . $GAFFER_DATA",
  "git grep --no-index -e x -- $GAFFER_DATA",
  "git diff --no-index $GAFFER_DATA/tool-metrics.jsonl src/a.ts",
]) {
  each("deny", `archiver / git reader: ${cmd}`, bash(cmd), ["roots", "bootstrap"]);
}
for (const cmd of [
  "7z a x.7z src",
  "pax -w src > x.pax",
  "find src | cpio -o > x.cpio",
  "git grep --no-index foo src",
  "git diff --no-index src/a.ts src/b.ts",
]) {
  each("allow", `archiver / git reader: ${cmd}`, bash(cmd));
}
{
  const r = decide(bash('while read f; do cat "$f"; done < list.txt'), {
    env: { ...process.env, ...PROFILES.roots },
    cwd: WORK,
  });
  t.assert(
    `the refusal tells the agent to name the file (${r.reason})`,
    /name the file/.test(String(r.reason)),
  );
}

// Outside the roots (production profile): the same as the literal form.
for (const cmd of [
  "cat /etc/host*",
  "cat /etc/{hosts,passwd}",
  "cat ~/.bash*",
  "cat < /etc/host*",
]) {
  each("deny", cmd, bash(cmd), ["roots", "bootstrap"]);
}

// ---- ordinary work stays allowed ------------------------------------------------------
for (const cmd of [
  "cat src/*.ts",
  "ls *.md",
  "grep -rn foo src",
  'cat "$PWD"/package.json',
  'for f in test/*.test.js; do node "$f"; done',
  'for f in src/*.ts; do echo "== $f"; head -5 "$f"; done',
  "head -n $N src/a.ts",
  'sed -n "s/$X/y/p" src/a.ts',
  "awk '{print $1/2}' src/a.ts",
  "cat src/{a,b}.ts",
  "cat ~+/README.md",
  "wc -l src/*.ts",
  "cat many/f1",
  "ls many/*",
  "grep -rn foo .",
  "find . -name '*.ts' -exec grep -l foo {} +",
  "(cd src && cat a.ts)",
  "cd src && cat *.ts",
  'git commit -m "fix typo"',
  "cat <<'EOF' > notes.md\ncat \"$1\" $GAFFER_DATA/x*\nEOF",
  'echo "$GAFFER_DATA"',
  "cat src/nothing*",
]) {
  each("allow", cmd, bash(cmd));
}

// A glob never follows a symlink loop and stays bounded in time.
{
  const start = Date.now();
  for (const p of Object.keys(PROFILES)) {
    decide(bash("cat loopdir/**/x.txt; grep -R foo loopdir"), {
      env: { ...process.env, ...PROFILES[p] },
      cwd: WORK,
    });
  }
  t.assert(`a symlink loop is not walked (${Date.now() - start} ms)`, Date.now() - start < 5000);
}

// ---- the search and file tools over the secret directory ------------------------------
each("deny", "Glob * in GAFFER_DATA", tool("Glob", { pattern: "*", path: DATA }));
each("deny", "Glob GAFFER_DATA/*", tool("Glob", { pattern: `${DATA}/*` }));
each(
  "deny",
  "Grep content over GAFFER_DATA",
  tool("Grep", { pattern: "x", path: DATA, output_mode: "content" }),
);
each(
  "deny",
  "Grep climbing to GAFFER_DATA",
  tool("Grep", { pattern: "x", path: `${WORK}/../../..` }),
);
each("deny", "Read the token", tool("Read", { file_path: `${DATA}/dashboard-token` }));
each("allow", "Glob in the worktree", tool("Glob", { pattern: "src/*.ts", path: WORK }));

// ---- regression: the auditor's whole payload set, nothing denied may become allowed ----
{
  const A = scratchDir("gaffer-globs-audit-");
  t.cleanup(A);
  const map = {
    "{{H}}": `${A}/home`,
    "{{W}}": `${A}/work`,
    "{{R}}": `${A}/read`,
    "{{D}}": `${A}/data`,
    "{{O}}": `${A}/outside`,
    "{{F}}": resolve(RUNNER_DIR, ".."),
  };
  put(`${A}/data/dashboard-token`, "TOK\n");
  put(`${A}/data/dispatch.sqlite`, "");
  put(`${A}/data/mcp-runtime.json`, '{"GAFFER_CLAIM_TOKEN":"x"}\n');
  put(`${A}/home/.ssh/id_rsa`, "key\n");
  put(`${A}/home/.config/gaffer/keys/ed25519`, "key\n");
  put(`${A}/home/.config/gh/hosts.yml`, "token\n");
  put(`${A}/read/docs/notes.md`);
  mkdirSync(`${A}/outside`);
  mkdirSync(`${A}/tmp`);
  put(`${A}/work/README.md`, "# r\n");
  put(`${A}/work/.gitattributes`, "*.png binary\n");
  put(`${A}/work/src/a.js`, "export const a=1;\n");
  put(`${A}/work/.env`, "SECRET=1\n");
  put(`${A}/work/.env.example`, "FOO=\n");
  git(`${A}/work`, "init", "-q", "-b", "main");
  git(`${A}/work`, "add", "README.md", ".gitattributes", "src/a.js", ".env.example");
  git(
    `${A}/work`,
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "seed",
  );
  symlinkSync("/etc/passwd", `${A}/work/plink`);
  symlinkSync("/etc", `${A}/work/sdir`);
  const fill = (s) =>
    typeof s === "string" ? Object.entries(map).reduce((x, [k, v]) => x.split(k).join(v), s) : s;
  const base = {
    PATH: process.env.PATH,
    HOME: map["{{H}}"],
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GAFFER_DATA: map["{{D}}"],
    GAFFER_TICKET: "t",
    MCP_CONFIG: `${map["{{D}}"]}/mcp-runtime.json`,
    DISPATCH_DB: `${map["{{D}}"]}/dispatch.sqlite`,
    MEMORY_DB: `${map["{{D}}"]}/memory.sqlite`,
  };
  const roots = { GAFFER_WRITE_ROOTS: map["{{W}}"], GAFFER_READ_ROOTS: map["{{R}}"] };
  const envs = {
    roots: { ...base, ...roots },
    open: base,
    bootstrap: {
      ...base,
      ...roots,
      GAFFER_BOOTSTRAP_INSTALL: "1",
      GAFFER_BOOTSTRAP_DIR: map["{{W}}"],
    },
  };
  // The one denial the work set out to lift (F2): a note that only names a CLI, the
  // same shape as `echo "fg then approve" > notes.txt`, the auditor's own "allow".
  const LIFTED = new Set(["lg35"]);
  let checked = 0;
  for (const [id, , , payload] of PAYLOADS) {
    if (LIFTED.has(id)) continue;
    const input = Object.fromEntries(Object.entries(payload.input).map(([k, v]) => [k, fill(v)]));
    for (const p of DENIED_BEFORE[id] ?? []) {
      const r = decide(
        { tool_name: payload.tool, tool_input: input },
        { env: envs[p], cwd: map["{{W}}"] },
      );
      checked += 1;
      if (r.allow)
        t.assert(`audit payload ${id} [${p}] was denied on main and is now allowed`, false);
    }
  }
  t.assert(`audit regression covered ${checked} denied verdicts`, checked > 400);
}

t.done();
