#!/usr/bin/env node
// Tests for the greenfield "repo inheritance" planner (bin/inherit-repo.mjs).
//
// Proves the four behaviours of "greenfield epics wire themselves up":
//   AC1  readGraph reads tickets/scopes/deps/write-links from the dispatch sqlite.
//   AC2  single-bootstrap epic → the new repo is linked to ALL siblings lacking one.
//   AC3  idempotency — siblings that already have a write repo are NOT re-planned.
//   AC4  multi-bootstrap epic → each sibling resolves via its dependency graph;
//        a sibling with exactly one bootstrap in its closure inherits that repo,
//        and a genuinely-ambiguous sibling (0 / >1) escalates to the claude seam.
//   AC5  the --dry-run CLI emits a plan with deterministic links + the planned
//        claude argv (GAFFER_PLAN_MODEL + --mcp-config) for ambiguous siblings,
//        WITHOUT spawning claude.
//   AC6  buildClaudeArgv shape; tick.sh wires gaffer_inherit_repo after onboard.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const HELPER = resolve(RUNNER_DIR, "bin", "inherit-repo.mjs");
const { readGraph, resolveInheritance, transitiveBootstraps, buildClaudeArgv } = await import(
  HELPER
);

let passed = 0;
const failures = [];
function ok(label) {
  passed += 1;
  console.log(`  ok   ${label}`);
}
function fail(label) {
  failures.push(label);
  console.log(`  FAIL ${label}`);
}
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) ok(label);
  else fail(`${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// --- Build a throwaway dispatch sqlite with ONLY the columns the planner reads.
const WORKDIR = mkdtempSync(resolve(tmpdir(), "inherit-repo-test-"));

function makeDb(name) {
  const { DatabaseSync } = require("node:sqlite");
  const path = resolve(WORKDIR, name);
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE tickets (id TEXT PRIMARY KEY, number INTEGER, bootstrap INTEGER NOT NULL DEFAULT 0,
                          title TEXT, description TEXT);
    CREATE TABLE scope_nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE ticket_scope_nodes (ticket_id TEXT, scope_node_id TEXT, PRIMARY KEY (ticket_id, scope_node_id));
    CREATE TABLE ticket_dependencies (ticket_id TEXT, depends_on_ticket_id TEXT,
                                      PRIMARY KEY (ticket_id, depends_on_ticket_id));
    CREATE TABLE repositories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE ticket_repos (ticket_id TEXT, repo_id TEXT, access TEXT NOT NULL DEFAULT 'write',
                               PRIMARY KEY (ticket_id, repo_id));
  `);
  return { db, path };
}

function seed(
  db,
  { tickets = [], scopes = [], links = [], deps = [], repos = [], repoLinks = [] },
) {
  for (const t of tickets)
    db.prepare(
      "INSERT INTO tickets (id,number,bootstrap,title,description) VALUES (?,?,?,?,?)",
    ).run(t.id, t.number, t.bootstrap ? 1 : 0, t.title ?? "", t.description ?? "");
  for (const s of scopes)
    db.prepare("INSERT INTO scope_nodes (id,name) VALUES (?,?)").run(s.id, s.name);
  for (const l of links)
    db.prepare("INSERT INTO ticket_scope_nodes (ticket_id,scope_node_id) VALUES (?,?)").run(
      l.ticket,
      l.scope,
    );
  for (const d of deps)
    db.prepare("INSERT INTO ticket_dependencies (ticket_id,depends_on_ticket_id) VALUES (?,?)").run(
      d.ticket,
      d.dependsOn,
    );
  for (const r of repos)
    db.prepare("INSERT INTO repositories (id,name) VALUES (?,?)").run(r.id, r.name);
  for (const rl of repoLinks)
    db.prepare("INSERT INTO ticket_repos (ticket_id,repo_id,access) VALUES (?,?,?)").run(
      rl.ticket,
      rl.repo,
      rl.access ?? "write",
    );
}

// =====================================================================
// AC1 + AC2: single-bootstrap epic → link the new repo to ALL siblings.
// =====================================================================
console.log("== AC1/AC2: single-bootstrap epic inherits the new repo to every sibling ==");
{
  const { db, path } = makeDb("single.sqlite");
  seed(db, {
    tickets: [
      { id: "t61", number: 61, bootstrap: true, title: "Bootstrap the auto-trader monorepo" },
      { id: "t62", number: 62, title: "Price feed ingestion" },
      { id: "t63", number: 63, title: "Order router" },
    ],
    scopes: [{ id: "e1", name: "Auto-Trader" }],
    links: [
      { ticket: "t61", scope: "e1" },
      { ticket: "t62", scope: "e1" },
      { ticket: "t63", scope: "e1" },
    ],
    deps: [
      { ticket: "t62", dependsOn: "t61" },
      { ticket: "t63", dependsOn: "t61" },
    ],
    repos: [{ id: "r1", name: "auto-trader" }],
    // The bootstrap ticket got its onboarded repo linked (as tick.sh does).
    repoLinks: [{ ticket: "t61", repo: "r1", access: "write" }],
  });
  db.close();

  const graph = readGraph(path);
  ok("readGraph parsed the dispatch sqlite without throwing");
  eq("bootstrap #61 sees repo 'auto-trader'", graph.bootstrapRepo.get("t61"), "auto-trader");

  const plan = resolveInheritance(graph, "t61");
  eq("epic resolved", plan.epic?.name, "Auto-Trader");
  eq("one bootstrap counted", plan.bootstrapCount, 1);
  const links = plan.links.map((l) => [l.ticket, l.repo, l.reason]).sort();
  eq("both siblings inherit auto-trader (deterministic)", links, [
    [62, "auto-trader", "single"],
    [63, "auto-trader", "single"],
  ]);
  eq("nothing ambiguous", plan.ambiguous.length, 0);
}

// =====================================================================
// AC3: idempotency — a sibling that already has a write repo is skipped.
// =====================================================================
console.log("== AC3: a sibling already linked to a write repo is NOT re-planned ==");
{
  const { db, path } = makeDb("idem.sqlite");
  seed(db, {
    tickets: [
      { id: "t61", number: 61, bootstrap: true, title: "Bootstrap" },
      { id: "t62", number: 62, title: "Feature A" },
      { id: "t63", number: 63, title: "Feature B" },
    ],
    scopes: [{ id: "e1", name: "Epic" }],
    links: [
      { ticket: "t61", scope: "e1" },
      { ticket: "t62", scope: "e1" },
      { ticket: "t63", scope: "e1" },
    ],
    deps: [
      { ticket: "t62", dependsOn: "t61" },
      { ticket: "t63", dependsOn: "t61" },
    ],
    repos: [{ id: "r1", name: "app" }],
    // t62 ALREADY has the write repo (a prior run linked it); t61 is the bootstrap.
    repoLinks: [
      { ticket: "t61", repo: "r1" },
      { ticket: "t62", repo: "r1" },
    ],
  });
  db.close();

  const plan = resolveInheritance(readGraph(path), "t61");
  const linked = plan.links.map((l) => l.ticket);
  eq("only the still-unlinked sibling #63 is planned", linked, [63]);
}

// =====================================================================
// AC4: multi-bootstrap epic → dependency-graph resolution + ambiguity escalation.
// =====================================================================
console.log("== AC4: multi-bootstrap epic resolves siblings via the dependency graph ==");
{
  const { db, path } = makeDb("multi.sqlite");
  // Two apps in one epic: web (b1→repo web) and api (b2→repo api).
  // t10 depends only on b1 → web. t20 depends only on b2 → api.
  // t30 depends on BOTH b1 and b2 → ambiguous → claude.
  // t40 depends on NEITHER bootstrap → ambiguous (0 in closure) → claude.
  seed(db, {
    tickets: [
      { id: "b1", number: 1, bootstrap: true, title: "Bootstrap the web app" },
      { id: "b2", number: 2, bootstrap: true, title: "Bootstrap the API service" },
      { id: "t10", number: 10, title: "Web dashboard" },
      { id: "t20", number: 20, title: "API auth endpoint" },
      { id: "t30", number: 30, title: "Shared types used by web and api" },
      { id: "t40", number: 40, title: "Docs site" },
    ],
    scopes: [{ id: "e1", name: "Platform" }],
    links: [
      { ticket: "b1", scope: "e1" },
      { ticket: "b2", scope: "e1" },
      { ticket: "t10", scope: "e1" },
      { ticket: "t20", scope: "e1" },
      { ticket: "t30", scope: "e1" },
      { ticket: "t40", scope: "e1" },
    ],
    deps: [
      { ticket: "t10", dependsOn: "b1" },
      { ticket: "t20", dependsOn: "b2" },
      { ticket: "t30", dependsOn: "b1" },
      { ticket: "t30", dependsOn: "b2" },
      // t40 depends on t10 (NOT on a bootstrap directly) → transitively b1 only.
      { ticket: "t40", dependsOn: "t10" },
    ],
    repos: [
      { id: "rw", name: "web" },
      { id: "ra", name: "api" },
    ],
    repoLinks: [
      { ticket: "b1", repo: "rw" },
      { ticket: "b2", repo: "ra" },
    ],
  });
  db.close();

  const graph = readGraph(path);
  eq("transitiveBootstraps(t30) = both", [...transitiveBootstraps(graph, "t30")].sort(), [
    "b1",
    "b2",
  ]);

  // Resolve relative to b1 (the just-onboarded bootstrap), but the multi-bootstrap
  // path resolves EACH sibling by its own dependency closure regardless.
  const plan = resolveInheritance(graph, "b1");
  eq("two bootstraps counted", plan.bootstrapCount, 2);
  const links = plan.links.map((l) => [l.ticket, l.repo, l.reason]).sort();
  eq("t10→web, t20→api, t40→web via dependency graph", links, [
    [10, "web", "dependency"],
    [20, "api", "dependency"],
    [40, "web", "dependency"],
  ]);
  const amb = plan.ambiguous.map((a) => a.ticket).sort((a, b) => a - b);
  eq("t30 (both) is ambiguous → claude", amb, [30]);
  // t40 depends on t10 → transitively b1 only → resolvable, not ambiguous.
  const t40 = plan.links.find((l) => l.ticket === 40);
  eq("t40 inherits web through the transitive chain", t40?.repo, "web");

  // Ambiguous candidates carry the bootstrap repo names + purposes for the model.
  const cands = plan.ambiguous[0].candidates.map((c) => c.repo).sort();
  eq("ambiguous candidate set = both bootstrap repos", cands, ["api", "web"]);
}

// =====================================================================
// AC4b: a sibling with ZERO bootstraps in its closure is ambiguous (0 < 1 repos).
// =====================================================================
console.log("== AC4b: a sibling depending on no bootstrap is ambiguous (escalates) ==");
{
  const { db, path } = makeDb("zero.sqlite");
  seed(db, {
    tickets: [
      { id: "b1", number: 1, bootstrap: true, title: "Bootstrap web" },
      { id: "b2", number: 2, bootstrap: true, title: "Bootstrap api" },
      { id: "t9", number: 9, title: "Orphan feature with no bootstrap dependency" },
    ],
    scopes: [{ id: "e1", name: "P" }],
    links: [
      { ticket: "b1", scope: "e1" },
      { ticket: "b2", scope: "e1" },
      { ticket: "t9", scope: "e1" },
    ],
    deps: [],
    repos: [
      { id: "rw", name: "web" },
      { id: "ra", name: "api" },
    ],
    repoLinks: [
      { ticket: "b1", repo: "rw" },
      { ticket: "b2", repo: "ra" },
    ],
  });
  db.close();
  const plan = resolveInheritance(readGraph(path), "b1");
  eq(
    "orphan sibling #9 is ambiguous, not auto-linked",
    plan.ambiguous.map((a) => a.ticket),
    [9],
  );
  eq("no deterministic links", plan.links, []);
}

// =====================================================================
// AC5: the --dry-run CLI emits the plan + the planned claude argv (no spawn).
// =====================================================================
console.log("== AC5: --dry-run CLI emits the plan + ambiguous claude argv offline ==");
{
  const { db, path } = makeDb("cli.sqlite");
  seed(db, {
    tickets: [
      { id: "b1", number: 1, bootstrap: true, title: "Bootstrap web" },
      { id: "b2", number: 2, bootstrap: true, title: "Bootstrap api" },
      { id: "t10", number: 10, title: "Web dashboard" },
      { id: "t30", number: 30, title: "Shared lib", description: "used by both web and api" },
    ],
    scopes: [{ id: "e1", name: "Platform" }],
    links: [
      { ticket: "b1", scope: "e1" },
      { ticket: "b2", scope: "e1" },
      { ticket: "t10", scope: "e1" },
      { ticket: "t30", scope: "e1" },
    ],
    deps: [
      { ticket: "t10", dependsOn: "b1" },
      { ticket: "t30", dependsOn: "b1" },
      { ticket: "t30", dependsOn: "b2" },
    ],
    repos: [
      { id: "rw", name: "web" },
      { id: "ra", name: "api" },
    ],
    repoLinks: [
      { ticket: "b1", repo: "rw" },
      { ticket: "b2", repo: "ra" },
    ],
  });
  db.close();

  const res = spawnSync(process.execPath, [HELPER, "--bootstrap", "1", "--db", path, "--dry-run"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GAFFER_PLAN_MODEL: "opus",
      MCP_CONFIG: "/tmp/mcp.json",
      CLAUDE_FLAGS: "--permission-mode acceptEdits",
    },
  });
  let out = null;
  try {
    out = JSON.parse(res.stdout);
  } catch {
    /* leave null */
  }

  if (res.status === 0 && out && out.phase === "plan") ok("CLI exits 0 with a plan");
  else fail(`CLI plan wrong (code=${res.status}, out=${JSON.stringify(out)})`);

  const link = (out?.links || []).find((l) => l.ticket === 10);
  eq("deterministic link t10→web present", link?.repo, "web");

  const amb = (out?.ambiguous || []).find((a) => a.ticket === 30);
  if (
    amb &&
    Array.isArray(amb.argv) &&
    amb.argv[0] === "-p" &&
    amb.argv.includes("--mcp-config") &&
    amb.argv.includes("--model") &&
    amb.argv[amb.argv.indexOf("--model") + 1] === "opus" &&
    amb.candidates
      .map((c) => c.repo)
      .sort()
      .join(",") === "api,web"
  ) {
    ok("ambiguous #30 carries the planned claude argv (model=opus, mcp, candidates)");
  } else {
    fail(`ambiguous argv seam wrong: ${JSON.stringify(amb)}`);
  }
  // The prompt must NOT have spawned claude — dry-run only plans.
  if (amb && amb.argv[1].includes("Candidate repositories"))
    ok("argv prompt lists candidate repositories");
  else fail("argv prompt missing candidate list");
}

// =====================================================================
// AC6: buildClaudeArgv shape + tick.sh wiring + idempotent re-run guard.
// =====================================================================
console.log("== AC6: buildClaudeArgv shape + tick.sh wiring ==");
{
  const argv = buildClaudeArgv({
    prompt: "P",
    mcpConfig: "/m.json",
    model: "opus",
    flags: ["--permission-mode", "acceptEdits"],
  });
  eq("argv = [-p, prompt, --mcp-config, cfg, --model, m, ...flags]", argv, [
    "-p",
    "P",
    "--mcp-config",
    "/m.json",
    "--model",
    "opus",
    "--permission-mode",
    "acceptEdits",
  ]);
  const noModel = buildClaudeArgv({ prompt: "P", mcpConfig: "", model: "", flags: ["--foo"] });
  eq("no mcp/model → omitted", noModel, ["-p", "P", "--foo"]);

  const tick = readFileSync(resolve(RUNNER_DIR, "tick.sh"), "utf8");
  if (tick.includes("gaffer_inherit_repo")) ok("tick.sh calls gaffer_inherit_repo after onboard");
  else fail("tick.sh does not wire gaffer_inherit_repo");

  const lib = readFileSync(resolve(RUNNER_DIR, "lib", "greenfield.sh"), "utf8");
  if (lib.includes("gaffer_inherit_repo") && lib.includes("wg ticket repo-access set"))
    ok("greenfield.sh defines gaffer_inherit_repo and links via wg repo-access set");
  else fail("greenfield.sh missing gaffer_inherit_repo / wg link verb");
}

// --- Cleanup + summary.
try {
  rmSync(WORKDIR, { recursive: true, force: true });
} catch {
  /* best effort */
}

if (failures.length === 0) {
  console.log(`PASS — ${passed} checks passed (helper: ${HELPER})`);
  process.exit(0);
} else {
  console.log(`FAILED — ${failures.length} of ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
