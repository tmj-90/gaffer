#!/usr/bin/env node
// =====================================================================
// `mcp-trust` helper (lib/mcp-trust.mjs) — idempotent pre-approval of the
// dispatch+memory MCP servers in `~/.claude.json` -> projects[repo].
// ---------------------------------------------------------------------
// Proves, against the REAL helper over a throwaway claude.json:
//   AC1  seeds enabledMcpjsonServers=[dispatch,memory] for a fresh project entry
//   AC2  creates the file + projects map when ~/.claude.json is absent
//   AC3  is IDEMPOTENT — a second call adds nothing (changed=false)
//   AC4  is ADDITIVE — preserves an operator's existing server + other projects
//   AC5  canonicalises the repo path (relative → absolute key)
//   AC6  REFUSES to clobber an unparseable claude.json (throws, file untouched)
//   AC7  blank repoPath throws
//   AC8  the CLI seeds the given path and exits 0
//
// Zero deps. Run: node test/mcp-trust.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = resolve(HERE, "..", "lib", "mcp-trust.mjs");
const { seedMcpTrust, FACTORY_MCP_SERVERS } = await import(HELPER);

let passed = 0;
const failures = [];
const ok = (l) => {
  passed += 1;
  console.log(`  ok   ${l}`);
};
const fail = (l) => {
  failures.push(l);
  console.log(`  FAIL ${l}`);
};
const assert = (l, c) => (c ? ok(l) : fail(l));
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const WORK = mkdtempSync(resolve(tmpdir(), "mcp-trust-test-"));
const REPO = resolve(WORK, "repo");

console.log("== AC1: seeds [dispatch,memory] for a fresh project entry ==");
{
  const cj = resolve(WORK, "ac1.json");
  writeFileSync(cj, JSON.stringify({ projects: {} }));
  const r = seedMcpTrust(REPO, { claudeJsonPath: cj });
  const j = read(cj);
  assert("changed=true", r.changed === true);
  assert("added both servers", JSON.stringify(r.added) === JSON.stringify(["dispatch", "memory"]));
  assert(
    "entry has enabledMcpjsonServers=[dispatch,memory]",
    JSON.stringify(j.projects[REPO].enabledMcpjsonServers) ===
      JSON.stringify(["dispatch", "memory"]),
  );
}

console.log("== AC2: creates the file + projects map when absent ==");
{
  const cj = resolve(WORK, "ac2-absent.json");
  const r = seedMcpTrust(REPO, { claudeJsonPath: cj });
  const j = read(cj);
  assert("changed=true", r.changed === true);
  assert("projects map created", !!j.projects && typeof j.projects === "object");
  assert(
    "servers present",
    JSON.stringify(j.projects[REPO].enabledMcpjsonServers) === JSON.stringify(FACTORY_MCP_SERVERS),
  );
}

console.log("== AC3: idempotent — second call changes nothing ==");
{
  const cj = resolve(WORK, "ac3.json");
  seedMcpTrust(REPO, { claudeJsonPath: cj });
  const r2 = seedMcpTrust(REPO, { claudeJsonPath: cj });
  const j = read(cj);
  assert("second call changed=false", r2.changed === false);
  assert("second call added nothing", r2.added.length === 0);
  assert(
    "no duplicate servers",
    JSON.stringify(j.projects[REPO].enabledMcpjsonServers) === JSON.stringify(FACTORY_MCP_SERVERS),
  );
}

console.log("== AC4: additive — preserves existing server + other projects ==");
{
  const cj = resolve(WORK, "ac4.json");
  const other = resolve(WORK, "other-repo");
  writeFileSync(
    cj,
    JSON.stringify({
      projects: {
        [REPO]: { enabledMcpjsonServers: ["operatorThing"], someOtherKey: 1 },
        [other]: { enabledMcpjsonServers: ["x"] },
      },
    }),
  );
  const r = seedMcpTrust(REPO, { claudeJsonPath: cj });
  const j = read(cj);
  assert(
    "added only the two missing servers",
    JSON.stringify(r.added) === JSON.stringify(["dispatch", "memory"]),
  );
  assert(
    "keeps the operator's server first",
    JSON.stringify(j.projects[REPO].enabledMcpjsonServers) ===
      JSON.stringify(["operatorThing", "dispatch", "memory"]),
  );
  assert("preserves sibling keys on the entry", j.projects[REPO].someOtherKey === 1);
  assert(
    "leaves OTHER projects untouched",
    JSON.stringify(j.projects[other].enabledMcpjsonServers) === JSON.stringify(["x"]),
  );
}

console.log("== AC5: canonicalises a relative repo path to an absolute key ==");
{
  const cj = resolve(WORK, "ac5.json");
  writeFileSync(cj, "{}");
  seedMcpTrust("./some/rel/path", { claudeJsonPath: cj });
  const j = read(cj);
  const keys = Object.keys(j.projects);
  assert("single project key", keys.length === 1);
  assert("key is absolute", keys[0].startsWith("/"));
}

console.log("== AC6: refuses to clobber an unparseable claude.json ==");
{
  const cj = resolve(WORK, "ac6-bad.json");
  writeFileSync(cj, "{ this is not json ");
  let threw = false;
  try {
    seedMcpTrust(REPO, { claudeJsonPath: cj });
  } catch {
    threw = true;
  }
  assert("threw on invalid JSON", threw);
  assert("left the bad file untouched", readFileSync(cj, "utf8") === "{ this is not json ");
}

console.log("== AC7: blank repoPath throws ==");
{
  let threw = false;
  try {
    seedMcpTrust("   ", { claudeJsonPath: resolve(WORK, "ac7.json") });
  } catch {
    threw = true;
  }
  assert("threw on blank repoPath", threw);
}

console.log("== AC8: CLI seeds the given path and exits 0 ==");
{
  const cj = resolve(WORK, "ac8.json");
  writeFileSync(cj, "{}");
  const res = spawnSync(process.execPath, [HELPER, REPO], {
    encoding: "utf8",
    env: { ...process.env, HOME: WORK }, // default path = $HOME/.claude.json, but we pass explicit repo
  });
  // The CLI uses the default ~/.claude.json (HOME override); assert it wrote there.
  const home = read(resolve(WORK, ".claude.json"));
  assert("CLI exit 0", res.status === 0);
  assert(
    "CLI seeded $HOME/.claude.json",
    !!home.projects[REPO] &&
      JSON.stringify(home.projects[REPO].enabledMcpjsonServers) ===
        JSON.stringify(FACTORY_MCP_SERVERS),
  );
}

rmSync(WORK, { recursive: true, force: true });

console.log();
if (failures.length === 0) {
  console.log(`PASS — ${passed} checks passed (helper: ${HELPER})`);
  process.exit(0);
} else {
  console.log(`FAILED — ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
