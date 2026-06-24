#!/usr/bin/env node
// Gaffer factory — greenfield "repo inheritance" planner.
//
// CONTEXT. A "build me an app" run creates an EPIC scope node with a bootstrap
// ticket (greenfield, bootstrap=1, no repo — it git-inits + scaffolds a NEW repo)
// plus dependent feature tickets that target that new repo. After the bootstrap
// ticket onboards its repo, those feature siblings still have NO write repo
// linked, so they are not deliverable. This planner decides, deterministically
// where it can, which onboarded epic repo each sibling should inherit as its
// WRITE repo — and only escalates the genuinely-ambiguous multi-app case to a
// headless `claude -p` decision.
//
// It is a PLANNER, not an actor: it reads the dispatch sqlite (read-only, zero
// deps — node:sqlite ships with Node 22+) and emits a plan as a single JSON line.
// The bash caller (lib/greenfield.sh → gaffer_inherit_repo) executes the plan via
// `wg ticket repo-access set <sibling> <repo> --access write`, which is idempotent
// (the (ticket,repo) link is upserted), so re-running never double-links.
//
// =====================================================================
// CONTRACT
// ---------------------------------------------------------------------
// ENV / FLAGS:
//   --bootstrap <num>    (required) the just-onboarded bootstrap ticket's NUMBER.
//   --db <path>          dispatch sqlite (default: DISPATCH_DB or factory.config).
//   --dry-run            do NOT spawn claude for ambiguous siblings; instead report
//                        each ambiguous ticket's planned claude argv + candidate set
//                        (used by tests to assert the seam offline).
//
// STDOUT (single JSON line):
//   {
//     "phase": "plan",
//     "epic":  { "id": "<scope-node-id>", "name": "..." } | null,
//     "bootstrapCount": <int>,            // bootstraps in the epic
//     "links":      [ { "ticket": <num>, "ticketId": "...", "repo": "<name>", "reason": "single|dependency" } ],
//     "ambiguous":  [ { "ticket": <num>, "ticketId": "...", "candidates": [ { "repo": "...", "purpose": "..." } ],
//                       "argv": [ ... ] | null, "model": "<plan-model>" } ],
//     "unresolved": [ { "ticket": <num>, "ticketId": "...", "reason": "..." } ]
//   }
// Exit 0 on a computed plan (even an empty one); non-zero only on a hard failure
// (missing --bootstrap, DB unreadable, unknown bootstrap ticket).
// =====================================================================

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const GAFFER_HOME = resolve(RUNNER_DIR, "..");
const GAFFER_DATA = process.env.GAFFER_DATA || resolve(GAFFER_HOME, ".gaffer");

const CONFIG = {
  dispatchDb: process.env.DISPATCH_DB || resolve(GAFFER_DATA, "dispatch.sqlite"),
  mcpConfig: process.env.MCP_CONFIG || resolve(RUNNER_DIR, ".mcp.json"),
  claudeBin: process.env.CLAUDE_BIN || "claude",
  // Repo choice for an ambiguous sibling is a DECISION step → plan model (opus).
  planModel: (process.env.GAFFER_PLAN_MODEL || "").trim(),
  claudeFlags: (process.env.CLAUDE_FLAGS || "--permission-mode acceptEdits")
    .split(/\s+/)
    .filter(Boolean),
};

function log(msg) {
  process.stderr.write(`[inherit-repo] ${msg}\n`);
}
function emit(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(code);
}
function fail(reason, code = 1) {
  log(`ERROR: ${reason}`);
  emit({ phase: "error", error: reason }, code);
}

function parseArgs(argv) {
  const opts = { bootstrap: "", db: CONFIG.dispatchDb, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case "--bootstrap":
        opts.bootstrap = next() ?? "";
        break;
      case "--db":
        opts.db = next() ?? opts.db;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        break;
    }
  }
  return opts;
}

/**
 * Open the dispatch sqlite read-only and read every row this planner needs into
 * plain JS structures. Kept separate from the (pure) resolution so the resolver
 * can be unit-tested against in-memory fixtures with no DB at all.
 *
 * Returns a `Graph`:
 *   tickets:    Map<id, { id, number, bootstrap, title, description }>
 *   scopeOf:    Map<ticketId, scopeNodeId[]>   (ticket → its epic/scope nodes)
 *   members:    Map<scopeNodeId, ticketId[]>   (scope node → member tickets)
 *   deps:       Map<ticketId, dependsOnTicketId[]>
 *   writeRepo:  Map<ticketId, true>            (ticket already has an access='write' repo)
 *   repoOf:     Map<ticketId, repoName[]>      (ticket's access='write' repo names)
 *   nodeName:   Map<scopeNodeId, name>
 *   bootstrapRepo: Map<ticketId, repoName>     (a bootstrap ticket's onboarded write repo)
 */
function pushTo(map, key, value) {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

export function readGraph(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`dispatch db not found: ${dbPath}`);
  let DatabaseSync;
  // node:sqlite (DatabaseSync) is a built-in only from Node 22.5+. On older Node the
  // repo-inheritance auto-wiring is skipped (the caller invokes this best-effort, so a
  // clear message beats a raw ERR_UNKNOWN_BUILTIN_MODULE stack). Siblings merge-ticket /
  // onboard-run / product-owner-run degrade the same way.
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    throw new Error(
      "node:sqlite unavailable (needs Node >= 22.5) — repo inheritance auto-wiring skipped on this runtime",
    );
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tickets = new Map();
    for (const r of db
      .prepare("SELECT id, number, bootstrap, title, description FROM tickets")
      .all()) {
      tickets.set(r.id, {
        id: r.id,
        number: r.number,
        bootstrap: Number(r.bootstrap) === 1,
        title: r.title || "",
        description: r.description || "",
      });
    }
    const scopeOf = new Map();
    const members = new Map();
    for (const r of db.prepare("SELECT ticket_id, scope_node_id FROM ticket_scope_nodes").all()) {
      pushTo(scopeOf, r.ticket_id, r.scope_node_id);
      pushTo(members, r.scope_node_id, r.ticket_id);
    }
    const deps = new Map();
    for (const r of db
      .prepare("SELECT ticket_id, depends_on_ticket_id FROM ticket_dependencies")
      .all()) {
      pushTo(deps, r.ticket_id, r.depends_on_ticket_id);
    }
    // Write-repo links: a ticket "has a write repo" iff a ticket_repos row has access='write'.
    const writeRepo = new Map();
    const repoOf = new Map();
    for (const r of db
      .prepare(
        "SELECT tr.ticket_id AS ticketId, r.name AS repoName FROM ticket_repos tr " +
          "JOIN repositories r ON r.id = tr.repo_id WHERE tr.access = 'write'",
      )
      .all()) {
      writeRepo.set(r.ticketId, true);
      pushTo(repoOf, r.ticketId, r.repoName);
    }
    const nodeName = new Map();
    for (const r of db.prepare("SELECT id, name FROM scope_nodes").all())
      nodeName.set(r.id, r.name);

    // A bootstrap ticket's onboarded repo = its own write repo (the bootstrap path
    // links the new repo to the bootstrap ticket right after onboard).
    const bootstrapRepo = new Map();
    for (const t of tickets.values()) {
      if (t.bootstrap) {
        const repos = repoOf.get(t.id) || [];
        if (repos.length > 0) bootstrapRepo.set(t.id, repos[0]);
      }
    }
    return { tickets, scopeOf, members, deps, writeRepo, repoOf, nodeName, bootstrapRepo };
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

/** The set of bootstrap ticket ids a given ticket transitively depends on. */
export function transitiveBootstraps(graph, ticketId) {
  const found = new Set();
  const seen = new Set();
  const stack = [...(graph.deps.get(ticketId) || [])];
  while (stack.length > 0) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const t = graph.tickets.get(id);
    if (t?.bootstrap) found.add(id);
    for (const d of graph.deps.get(id) || []) stack.push(d);
  }
  return found;
}

/**
 * Pure resolver. Given the read graph + the just-onboarded bootstrap ticket id,
 * decide which onboarded epic repo each sibling that lacks a write repo should
 * inherit. Deterministic for the single-bootstrap epic and for siblings whose
 * dependency graph names exactly one bootstrap; escalates the rest to Claude.
 *
 * Returns { epic, bootstrapCount, links, ambiguous, unresolved } where each
 * entry references stable ticketIds + display numbers, and ambiguous carries the
 * candidate repos (name + one-line purpose) for the model to choose from.
 */
export function resolveInheritance(graph, bootstrapTicketId) {
  const bootstrap = graph.tickets.get(bootstrapTicketId);
  if (!bootstrap) throw new Error(`bootstrap ticket not in graph: ${bootstrapTicketId}`);

  // 1) The bootstrap's epic (its primary/any scope membership). A bootstrap with
  //    no scope membership has no siblings to wire — return an empty plan.
  const epicIds = graph.scopeOf.get(bootstrapTicketId) || [];
  if (epicIds.length === 0) {
    return { epic: null, bootstrapCount: 1, links: [], ambiguous: [], unresolved: [] };
  }
  // Choose the epic that actually contains the most members (the "build me an app"
  // epic). Ties are resolved by first id — deterministic.
  const epicId = epicIds
    .slice()
    .sort((a, b) => (graph.members.get(b)?.length || 0) - (graph.members.get(a)?.length || 0))[0];
  const epic = { id: epicId, name: graph.nodeName.get(epicId) || epicId };

  // 2) Bootstraps + sibling tickets needing a write repo, within this epic.
  const memberIds = [...new Set(graph.members.get(epicId) || [])];
  const bootstrapIds = memberIds.filter((id) => graph.tickets.get(id)?.bootstrap);
  const bootstrapCount = bootstrapIds.length;

  // Candidate repos for the ambiguous case: every onboarded bootstrap repo in the
  // epic, with a one-line purpose (its bootstrap ticket title).
  const candidates = bootstrapIds
    .map((id) => ({
      repo: graph.bootstrapRepo.get(id),
      purpose: graph.tickets.get(id)?.title || "",
    }))
    .filter((c) => c.repo);

  const links = [];
  const ambiguous = [];
  const unresolved = [];

  for (const id of memberIds) {
    const t = graph.tickets.get(id);
    if (!t || t.bootstrap) continue; // never re-target a bootstrap ticket itself
    if (graph.writeRepo.get(id)) continue; // already has a write repo — idempotent skip

    if (bootstrapCount <= 1) {
      // Common case: ONE bootstrap → every sibling inherits the new repo. Deterministic.
      const repo = graph.bootstrapRepo.get(bootstrapTicketId);
      if (repo) links.push({ ticket: t.number, ticketId: id, repo, reason: "single" });
      else
        unresolved.push({
          ticket: t.number,
          ticketId: id,
          reason: "bootstrap repo not onboarded yet",
        });
      continue;
    }

    // Multi-bootstrap epic: resolve via the dependency graph.
    const tb = transitiveBootstraps(graph, id);
    const repos = [...tb].map((bid) => graph.bootstrapRepo.get(bid)).filter(Boolean);
    const uniqueRepos = [...new Set(repos)];
    if (uniqueRepos.length === 1) {
      links.push({ ticket: t.number, ticketId: id, repo: uniqueRepos[0], reason: "dependency" });
    } else {
      // 0 or >1 onboarded bootstraps in the dependency closure → genuinely ambiguous.
      ambiguous.push({
        ticket: t.number,
        ticketId: id,
        title: t.title,
        description: t.description,
        candidates,
      });
    }
  }

  return { epic, bootstrapCount, links, ambiguous, unresolved };
}

/**
 * Build the headless `claude -p` argv that asks the plan model to pick ONE
 * candidate repo for an ambiguous sibling. Same shape as decompose.mjs /
 * product-owner-run.mjs: [-p, prompt, --mcp-config, <cfg>, --model, <plan>, ...flags].
 * The model MUST answer with exactly one candidate repo name; the caller validates
 * the answer is in the candidate set and never links an invented repo.
 */
export function buildPrompt({ title, description, candidates }) {
  const lines = candidates.map((c) => `- ${c.repo}: ${c.purpose || "(no description)"}`);
  return [
    "You are wiring a feature ticket in a multi-app epic to the ONE repository it belongs in.",
    "",
    `Ticket title: ${title}`,
    `Ticket description: ${description || "(none)"}`,
    "",
    "Candidate repositories (the epic's bootstrapped repos):",
    ...lines,
    "",
    "Choose the single repository this ticket should be implemented in. Reply with ONLY the",
    "exact repository name from the list above — no prose, no punctuation, no code fences.",
    "If you genuinely cannot tell, reply with the single word: NONE.",
  ].join("\n");
}

export function buildClaudeArgv({ prompt, mcpConfig, model, flags }) {
  const args = ["-p", prompt];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  if (model) args.push("--model", model);
  return args.concat(flags);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!String(opts.bootstrap).trim()) {
    fail("--bootstrap <ticket-number> is required");
    return;
  }

  let graph;
  try {
    graph = readGraph(opts.db);
  } catch (e) {
    fail(`failed to read dispatch db: ${e?.message ?? e}`);
    return;
  }

  // Resolve the bootstrap NUMBER → ticket id.
  const wantNum = parseInt(String(opts.bootstrap), 10);
  let bootstrapId = null;
  for (const t of graph.tickets.values()) {
    if (t.number === wantNum) {
      bootstrapId = t.id;
      break;
    }
  }
  if (!bootstrapId) {
    fail(`bootstrap ticket #${opts.bootstrap} not found in dispatch db`);
    return;
  }
  if (!graph.tickets.get(bootstrapId)?.bootstrap) {
    fail(`ticket #${opts.bootstrap} is not a bootstrap ticket`);
    return;
  }

  let plan;
  try {
    plan = resolveInheritance(graph, bootstrapId);
  } catch (e) {
    fail(`failed to resolve inheritance: ${e?.message ?? e}`);
    return;
  }

  // Attach the planned claude argv + model to each ambiguous sibling so the caller
  // (or a test, via --dry-run) can act on / assert it. We never spawn claude here —
  // the bash caller owns spawning + answer validation so the link stays a `wg` call.
  const ambiguous = plan.ambiguous.map((a) => {
    const prompt = buildPrompt({
      title: a.title,
      description: a.description,
      candidates: a.candidates,
    });
    const argv = buildClaudeArgv({
      prompt,
      mcpConfig: CONFIG.mcpConfig,
      model: CONFIG.planModel,
      flags: CONFIG.claudeFlags,
    });
    return {
      ticket: a.ticket,
      ticketId: a.ticketId,
      candidates: a.candidates,
      argv,
      model: CONFIG.planModel,
      claudeBin: CONFIG.claudeBin,
    };
  });

  emit(
    {
      phase: "plan",
      epic: plan.epic,
      bootstrapCount: plan.bootstrapCount,
      links: plan.links,
      ambiguous,
      unresolved: plan.unresolved,
    },
    0,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
