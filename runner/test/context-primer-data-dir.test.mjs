// =====================================================================
// lib/context-primer.mjs resolves the memory DB the way factory.config.sh does:
// MEMORY_DB, else $GAFFER_DATA/memory.sqlite, else the checkout's .gaffer. It used to
// skip GAFFER_DATA, so a caller with its own data dir and no MEMORY_DB (bin/
// product-owner-run.mjs under the dashboard; product-owner-repo-clean.test.sh) read —
// and the memory CLI CREATED — <checkout>/.gaffer/memory.sqlite: the operator's live DB.
// Run: node runner/test/context-primer-data-dir.test.mjs
// =====================================================================
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { primeContextBlock } = await import(resolve(HERE, "..", "lib", "context-primer.mjs"));

let passed = 0;
const failures = [];
function check(cond, label) {
  if (cond) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}

const work = mkdtempSync(join(tmpdir(), "primer-data-dir-"));
const repo = join(work, "repo");
mkdirSync(repo);
const seen = join(work, "seen-db");
// A stand-in memory CLI: records the MEMORY_DB it was handed, returns no cards.
const cli = join(work, "memory-stub.mjs");
writeFileSync(
  cli,
  `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, process.env.MEMORY_DB ?? "<unset>");\nprocess.stdout.write(JSON.stringify({ cards: [] }));\n`,
);
const prime = (env) => {
  rmSync(seen, { force: true });
  primeContextBlock({
    realRepoPath: repo,
    repo: "r",
    query: "q",
    env: { PATH: process.env.PATH, MEMORY_CLI_BIN: cli, ...env },
  });
  try {
    return readFileSync(seen, "utf8");
  } catch {
    return "<not spawned>";
  }
};

const data = join(work, "data");
const got = prime({ GAFFER_DATA: data });
check(
  got === join(data, "memory.sqlite"),
  `GAFFER_DATA set, MEMORY_DB unset → $GAFFER_DATA/memory.sqlite (got ${got})`,
);
const explicit = join(work, "explicit.sqlite");
const got2 = prime({ GAFFER_DATA: data, MEMORY_DB: explicit });
check(got2 === explicit, `an explicit MEMORY_DB still wins (got ${got2})`);
const got3 = prime({ MEMORY_DB: "" });
check(got3 === "<not spawned>", `an EMPTY MEMORY_DB still disables the primer (got ${got3})`);

rmSync(work, { recursive: true, force: true });
console.log("");
if (failures.length === 0) {
  console.log(`context-primer-data-dir: all ${passed} checks passed`);
  process.exit(0);
}
console.log(`context-primer-data-dir: ${failures.length} FAILED of ${passed + failures.length}`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
