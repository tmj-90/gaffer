#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

import { Command } from "commander";
import { ZodError } from "zod";

import { Dispatch } from "../core.js";
import { DatabaseOpenError, DatabaseTooNewError } from "../db/connection.js";
import type { Actor } from "../domain/types.js";
import { exportState, importStateFromJson, serializeBundle } from "../io/stateExport.js";
import { buildNotifierFromEnv } from "../notify/config.js";
import { isNotifyKind } from "../notify/types.js";
import { DispatchError } from "../util/errors.js";
import { resolveDbPath } from "../util/paths.js";
import { VERSION } from "../version.js";
import { computeStats, renderDoctor, renderStats, runDoctor } from "./ops.js";

/** The human running the CLI is the actor for events. */
function cliActor(): Actor {
  return { type: "human", id: process.env.USER ?? "cli" };
}

/** Resolve a `--as <type>` flag to an Actor (BBT-001 tester verdict commands). */
function testerActor(as: string): Actor {
  switch (as) {
    case "human":
      return { type: "human", id: process.env.USER ?? "cli" };
    case "admin":
      return { type: "admin", id: process.env.USER ?? "cli" };
    case "system":
      return { type: "system" };
    default:
      return { type: "agent", id: "tester" };
  }
}

function open(opts: { db?: string }): Dispatch {
  return Dispatch.open(resolveDbPath(opts.db));
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Read the whole of stdin as a UTF-8 string (used when no file path is given). */
function readStdin(): string {
  // fd 0 is stdin; a synchronous full read keeps the command's control flow
  // simple and matches the rest of the CLI (no streaming needed for a plan).
  return readFileSync(0, "utf8");
}

/**
 * Parse a JSON document for `epic create` from either a file path or stdin.
 * `path` is undefined or "-" ⇒ read stdin. Malformed JSON throws a DispatchError
 * so it surfaces on the standard VALIDATION_ERROR path in main().
 */
function readJsonInput(path: string | undefined): unknown {
  const raw = path === undefined || path === "-" ? readStdin() : readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new DispatchError("VALIDATION_ERROR", `Invalid JSON input: ${reason}`);
  }
}

const program = new Command();
program
  .name("dispatch")
  .description("Agent-ready backlog control plane")
  .version(VERSION, "-v, --version", "print the Dispatch version")
  .option("--db <path>", "SQLite database path")
  .showHelpAfterError();

program
  .command("init")
  .description("Create (or open) the Dispatch database")
  .action((_opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson({ ok: true, db: resolveDbPath(cmd.optsWithGlobals().db), schema: "applied" });
    wg.db.close();
  });

const ticket = program.command("ticket").description("Ticket commands");

ticket
  .command("create")
  .description("Create a draft ticket")
  .requiredOption("-t, --title <title>", "ticket title")
  .option("-d, --description <text>", "description", "")
  .option("-p, --policy <pack>", "policy pack", "solo_loose")
  .option("--risk <level>", "risk level", "medium")
  .option("--priority <n>", "priority", (v) => Number(v), 0)
  .option("--bootstrap", "mark as a greenfield (create-a-repo) bootstrap ticket", false)
  .action((opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const t = wg.createTicket(
      {
        title: opts.title,
        description: opts.description,
        policy_pack: opts.policy,
        risk_level: opts.risk,
        priority: opts.priority,
        bootstrap: opts.bootstrap,
      },
      cliActor(),
    );
    printJson({
      ok: true,
      ticket: { number: t.number, id: t.id, status: t.status, bootstrap: t.bootstrap === 1 },
    });
    wg.db.close();
  });

ticket
  .command("ready <ref>")
  .description("Mark a ticket ready (evaluates policy)")
  .action((ref, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const t = wg.resolveTicket(ref);
    const res = wg.markReady(t.id, cliActor());
    printJson({ ok: true, status: res.ticket.status, event: res.eventId, policy: res.policy });
    wg.db.close();
  });

ticket
  .command("move <ref> <to>")
  .description("Board move: send a ticket to another status (e.g. un-ready: ready -> draft)")
  .option("--admin", "act as an admin actor", false)
  .action((ref, to, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const actor: Actor = opts.admin ? { type: "admin", id: process.env.USER ?? "cli" } : cliActor();
    const res = wg.moveTicket(ref, to, actor);
    printJson({ ok: true, status: res.ticket.status, event: res.eventId });
    wg.db.close();
  });

ticket
  .command("show <ref>")
  .description("Show a ticket with AC, repos and events")
  .action((ref, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson(wg.view(ref));
    wg.db.close();
  });

ticket
  .command("list")
  .description("List tickets")
  .option("-s, --status <status>", "filter by status")
  .action((opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const rows = wg.list(opts.status);
    printJson(rows.map((t) => ({ number: t.number, status: t.status, title: t.title, id: t.id })));
    wg.db.close();
  });

ticket
  .command("approve-ready <ref>")
  .description("Grant the human ready-approval a regulated ticket needs before going ready")
  .option("--admin", "act as an admin actor", false)
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const actor: Actor = opts.admin ? { type: "admin", id: process.env.USER ?? "cli" } : cliActor();
    const res = wg.grantReadyApproval(ref, actor);
    printJson({ ok: true, ...res });
    wg.db.close();
  });

ticket
  .command("set-reviewer <ref>")
  .description("Assign the reviewer a factory_strict/regulated ticket needs before going ready")
  .requiredOption("--reviewer <id>", "reviewer id")
  .option("--admin", "act as an admin actor", false)
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const actor: Actor = opts.admin ? { type: "admin", id: process.env.USER ?? "cli" } : cliActor();
    const res = wg.assignReviewer(ref, opts.reviewer, actor);
    printJson({ ok: true, ...res });
    wg.db.close();
  });

ticket
  .command("reopen-for-review <ref>")
  .description(
    "Re-open a done ticket for review (done -> in_review) after the auto-merge " +
      "resolver fixed a conflict on the branch — records the resolution for re-review",
  )
  .requiredOption("--reason <reason>", "short why the ticket is being reopened")
  .requiredOption("--resolution <summary>", "resolver's summary of what was reconciled")
  .option("--as <actor>", "actor type: system|admin", "system")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const actor: Actor =
      opts.as === "admin" ? { type: "admin", id: process.env.USER ?? "cli" } : { type: "system" };
    const res = wg.reopenForReview(
      ref,
      { reason: opts.reason, resolution: opts.resolution },
      actor,
    );
    printJson({ ok: true, ...res });
    wg.db.close();
  });

ticket
  .command("mark-merged <ref>")
  .description(
    "Mark an approved-and-merging ticket actually merged (ready_for_merge -> done). " +
      "The merge runner's callback once the git merge of the delivery branch lands, " +
      "so 'done' means actually merged. System/admin only.",
  )
  .option("--as <actor>", "actor type: system|admin", "system")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const actor: Actor =
      opts.as === "admin" ? { type: "admin", id: process.env.USER ?? "cli" } : { type: "system" };
    const res = wg.markMerged(ref, actor);
    printJson({ ok: true, ticket: res.ticket, eventId: res.eventId });
    wg.db.close();
  });

ticket
  .command("set-testable <ref>")
  .description(
    "BBT-001: mark a ticket eligible for the independent black-box testing lane " +
      "(--off to clear). Gates entry to in_testing on review approval when GAFFER_TESTING is on.",
  )
  .option("--off", "clear the flag (mark NOT testable)", false)
  .option("--admin", "act as an admin actor", false)
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const actor: Actor = opts.admin ? { type: "admin", id: process.env.USER ?? "cli" } : cliActor();
    const res = wg.setTestable(ref, !opts.off, actor);
    printJson({ ok: true, ...res });
    wg.db.close();
  });

ticket
  .command("test-contract <ref>")
  .description(
    "BBT-001: record (replace) a ticket's test_contract — the testing handover the " +
      "independent tester reads to stand the system up (never the diff).",
  )
  .option("--surface <surface...>", "changed boundary surface(s): API/endpoint/CLI/page", [])
  .option("--dep <dep...>", "runtime dependency to stand up (e.g. 'Postgres 16')", [])
  .option("--env <var...>", "environment variable the tester sets", [])
  .option("--run <command>", "how to bring the system up / invoke the surface", "")
  .option("--harness-ready", "a black-box harness already exists for this surface", false)
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const contract = wg.setTestContract(
      ref,
      {
        changed_surfaces: opts.surface,
        runtime_deps: opts.dep,
        env_vars: opts.env,
        run_command: opts.run,
        harness_ready: opts.harnessReady,
      },
      cliActor(),
    );
    printJson({ ok: true, test_contract: contract });
    wg.db.close();
  });

ticket
  .command("tester-pass <ref>")
  .description("BBT-001: record an independent tester PASS (in_testing -> ready_for_merge)")
  .requiredOption("--summary <text>", "passing test-result summary (recorded as evidence)")
  .option("--uri <uri>", "evidence uri")
  .option("--as <actor>", "actor type: agent|human|admin|system", "agent")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const actor = testerActor(opts.as);
    const res = wg.testerPass(ref, { summary: opts.summary, uri: opts.uri }, actor);
    printJson({ ok: true, status: res.ticket.status, event: res.eventId });
    wg.db.close();
  });

ticket
  .command("tester-fail <ref>")
  .description("BBT-001: record an independent tester FAIL (in_testing -> refining, with evidence)")
  .requiredOption("--summary <text>", "failing-test summary (recorded as evidence + reject reason)")
  .option("--uri <uri>", "evidence uri")
  .option("--as <actor>", "actor type: agent|human|admin|system", "agent")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const actor = testerActor(opts.as);
    const res = wg.testerFail(ref, { summary: opts.summary, uri: opts.uri }, actor);
    printJson({ ok: true, status: res.ticket.status, event: res.eventId });
    wg.db.close();
  });

ticket
  .command("require-cap <ref>")
  .description("Set (replace) the capabilities a ticket requires of a claiming agent")
  .option("--cap <capability...>", "required capabilities (omit to clear)", [])
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.setRequiredCapabilities({ ticket_id: ref, capabilities: opts.cap }, cliActor());
    printJson({ ok: true, ...res });
    wg.db.close();
  });

const ac = program.command("ac").description("Acceptance-criteria commands");
ac.command("add <ref>")
  .description("Add an acceptance criterion to a ticket")
  .requiredOption("-t, --text <text>", "AC text")
  .option("--verify <method>", "verification method")
  .option("--evidence", "evidence required", false)
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const t = wg.resolveTicket(ref);
    const { ac: created, eventId } = wg.addAcceptanceCriterion(
      {
        ticket_id: t.id,
        text: opts.text,
        verification_method: opts.verify,
        evidence_required: opts.evidence,
      },
      cliActor(),
    );
    printJson({ ok: true, ac_id: created.id, event: eventId });
    wg.db.close();
  });

const repo = program.command("repo").description("Repository commands");
repo
  .command("add")
  .description("Register a repository")
  .requiredOption("-n, --name <name>", "repo name")
  .option("--path <path>", "local path")
  .option("--remote <url>", "remote url")
  .option("--branch <branch>", "default branch", "main")
  .option("--stack <stack>", "stack")
  .option("--test <cmd>", "test command")
  .action((opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const r = wg.registerRepository(
      {
        name: opts.name,
        local_path: opts.path,
        remote_url: opts.remote,
        default_branch: opts.branch,
        stack: opts.stack,
        test_command: opts.test,
      },
      cliActor(),
    );
    printJson({ ok: true, repo: { id: r.id, name: r.name } });
    wg.db.close();
  });

repo
  .command("link <ref> <repoName>")
  .description("Link a repository to a ticket")
  .option("--role <role>", "role", "primary")
  .action((ref, repoName, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const t = wg.resolveTicket(ref);
    wg.linkRepository(t.id, repoName, opts.role, cliActor());
    printJson({ ok: true });
    wg.db.close();
  });

repo
  .command("hide <name>")
  .description("Hide a repo from the dashboard (stays registered; reversible)")
  .action((name, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const r = wg.setRepoHidden(name, true, cliActor());
    printJson({ ok: true, repo: { id: r.id, name: r.name, hidden: r.hidden } });
    wg.db.close();
  });

repo
  .command("unhide <name>")
  .description("Un-hide a previously hidden repo (returns it to its normal place)")
  .action((name, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const r = wg.setRepoHidden(name, false, cliActor());
    printJson({ ok: true, repo: { id: r.id, name: r.name, hidden: r.hidden } });
    wg.db.close();
  });

repo
  .command("hidden")
  .description("List hidden repositories")
  .action((_opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson(wg.listHiddenRepos().map((r) => ({ id: r.id, name: r.name, stack: r.stack })));
    wg.db.close();
  });

// --- Epics (EP-001) --------------------------------------------------------

const epic = program.command("epic").description("Epic commands (dependency-ordered ticket plans)");
epic
  .command("create [file]")
  .description(
    "Create an epic from a JSON plan (a file path, or stdin when omitted or '-'). " +
      "The plan is { epic:{name,description}, tickets:[{title,description,acceptanceCriteria[]," +
      "priority?,risk_level?,policy_pack?,repo?,access?,bootstrap?,dependsOn:[<indexes>]}] }. " +
      "Tickets are created as draft.",
  )
  .action((file: string | undefined, _opts, cmd) => {
    const plan = readJsonInput(file);
    const wg = open(cmd.optsWithGlobals());
    const res = wg.createEpic(plan, cliActor());
    printJson({ ok: true, epic_node_id: res.epicNodeId, ticket_numbers: res.ticketNumbers });
    wg.db.close();
  });

// --- Factory Map scope graph (FG-001 + FG-002) -----------------------------

const scope = program.command("scope").description("Factory Map scope graph commands");

const scopeNode = scope.command("node").description("Scope node commands");
scopeNode
  .command("create")
  .description("Create a scope node (product/system area)")
  .requiredOption("-n, --name <name>", "node name")
  .requiredOption(
    "-t, --type <type>",
    "node type (factory|domain|product|capability|system|service|library|external_dependency)",
  )
  .option("-d, --description <text>", "description")
  .option("--risk <level>", "risk level", "medium")
  .option("--owner <owner>", "owner")
  .option("--tag <tag...>", "tags", [])
  .option("--lore-tag <tag...>", "lore tags", [])
  .action((opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const node = wg.createScopeNode(
      {
        name: opts.name,
        type: opts.type,
        description: opts.description,
        risk_level: opts.risk,
        owner: opts.owner,
        ...(opts.tag.length > 0 ? { tags: opts.tag } : {}),
        ...(opts.loreTag.length > 0 ? { lore_tags: opts.loreTag } : {}),
      },
      cliActor(),
    );
    printJson({ ok: true, node: { id: node.id, name: node.name, type: node.type } });
    wg.db.close();
  });

scopeNode
  .command("list")
  .description("List scope nodes")
  .action((_opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson(
      wg.listScopeNodes().map((n) => ({ id: n.id, name: n.name, type: n.type, owner: n.owner })),
    );
    wg.db.close();
  });

scopeNode
  .command("show <id>")
  .description("Show a scope node with its linked repos")
  .action((id, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson(wg.getScopeNode(id));
    wg.db.close();
  });

scopeNode
  .command("rename <id> <name>")
  .description("Rename a scope node")
  .action((id, name, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const node = wg.updateScopeNode(id, { name }, cliActor());
    printJson({ ok: true, node: { id: node.id, name: node.name } });
    wg.db.close();
  });

scopeNode
  .command("delete <id>")
  .description("Delete a scope node (blocked while repos/tickets are linked)")
  .action((id, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.deleteScopeNode(id, cliActor());
    printJson({ ok: true, ...res });
    wg.db.close();
  });

const scopeEdge = scope.command("edge").description("Scope edge commands");
scopeEdge
  .command("add <fromId> <toId>")
  .description("Add a graph edge between two scope nodes")
  .option(
    "--relation <relation>",
    "relation (contains|depends_on; others need --advanced)",
    "contains",
  )
  .option("--advanced", "allow advanced relations beyond contains/depends_on", false)
  .action((fromId, toId, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const edge = wg.createScopeEdge(
      { from_node_id: fromId, to_node_id: toId, relation: opts.relation, advanced: opts.advanced },
      cliActor(),
    );
    printJson({ ok: true, edge: { id: edge.id, relation: edge.relation } });
    wg.db.close();
  });

scopeEdge
  .command("list")
  .description("List graph edges (optionally for one node)")
  .option("--node <id>", "filter to edges touching this node")
  .action((opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson(wg.listScopeEdges(opts.node));
    wg.db.close();
  });

scopeEdge
  .command("rm <id>")
  .description("Remove a graph edge")
  .action((id, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.deleteScopeEdge(id, cliActor());
    printJson({ ok: true, ...res });
    wg.db.close();
  });

const scopeRepo = scope.command("repo").description("Scope↔repo association commands");
scopeRepo
  .command("link <nodeId> <repoRef>")
  .description("Link a repo into a scope node with relation + default access")
  .option("--relation <relation>", "relation", "uses")
  .option("--access <access>", "default access (write|read|test|none)", "read")
  .option("--role <text>", "role description")
  .action((nodeId, repoRef, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const link = wg.linkScopeRepo(
      {
        scope_node_id: nodeId,
        repo_id: repoRef,
        relation: opts.relation,
        default_access: opts.access,
        role_description: opts.role,
      },
      cliActor(),
    );
    printJson({
      ok: true,
      association: { id: link.id, relation: link.relation, default_access: link.default_access },
    });
    wg.db.close();
  });

scopeRepo
  .command("list <nodeId>")
  .description("List repos linked to a scope node")
  .action((nodeId, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson(wg.reposForScope(nodeId));
    wg.db.close();
  });

scopeRepo
  .command("unlink <associationId>")
  .description("Remove a scope↔repo association by its id")
  .action((associationId, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.unlinkScopeRepo(associationId, cliActor());
    printJson({ ok: true, ...res });
    wg.db.close();
  });

scope
  .command("unmapped")
  .description("List repositories with no scope association (implicit single-repo scopes)")
  .action((_opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson(wg.listUnmappedRepos().map((r) => ({ id: r.id, name: r.name, stack: r.stack })));
    wg.db.close();
  });

// --- Ticket scope links + repo access boundaries (WG-001 + WG-002) ---------

const ticketScope = ticket.command("scope").description("Ticket↔scope-node links (WG-001)");
ticketScope
  .command("link <ref> <nodeId>")
  .description("Link a ticket to a scope node")
  .option("--relation <relation>", "relation (primary|secondary|suggested|rejected)", "secondary")
  .option("--confidence <n>", "confidence 0..1 (for suggested)")
  .action((ref, nodeId, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const link = wg.linkTicketScope(
      {
        ticket_id: ref,
        scope_node_id: nodeId,
        relation: opts.relation,
        ...(opts.confidence !== undefined ? { confidence: Number(opts.confidence) } : {}),
      },
      cliActor(),
    );
    printJson({ ok: true, scope: { scope_node_id: link.scope_node_id, relation: link.relation } });
    wg.db.close();
  });

ticketScope
  .command("primary <ref> <nodeId>")
  .description("Mark a scope node as the ticket's primary scope")
  .action((ref, nodeId, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const link = wg.setPrimaryScope(ref, nodeId, cliActor());
    printJson({ ok: true, scope: { scope_node_id: link.scope_node_id, relation: link.relation } });
    wg.db.close();
  });

ticketScope
  .command("list <ref>")
  .description("List a ticket's scope links (primary first)")
  .action((ref, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson(
      wg
        .listTicketScopes(ref)
        .map((s) => ({ id: s.id, name: s.name, type: s.type, relation: s.relation })),
    );
    wg.db.close();
  });

ticketScope
  .command("rm <ref> <nodeId>")
  .description("Remove a ticket↔scope link")
  .action((ref, nodeId, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.removeTicketScope(ref, nodeId, cliActor());
    printJson({ ok: true, ...res });
    wg.db.close();
  });

const ticketDep = ticket.command("dep").description("Ticket dependencies (EP-001)");
ticketDep
  .command("add <ref> <dependsOnRef>")
  .description("Declare that <ref> must wait for <dependsOnRef> to be done")
  .action((ref, dependsOnRef, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.addDependency({ ticket: ref, depends_on: dependsOnRef }, cliActor());
    printJson({ ok: true, ...res });
    wg.db.close();
  });

ticketDep
  .command("list <ref>")
  .description("List a ticket's dependencies (depended-on number/status + satisfied)")
  .action((ref, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson(wg.listDependencies(ref));
    wg.db.close();
  });

ticketDep
  .command("rm <ref> <dependsOnRef>")
  .description("Remove a ticket dependency")
  .action((ref, dependsOnRef, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.removeDependency(ref, dependsOnRef, cliActor());
    printJson({ ok: true, ...res });
    wg.db.close();
  });

const ticketRepo = ticket
  .command("repo-access")
  .description("Ticket↔repo access boundaries (WG-002)");
ticketRepo
  .command("set <ref> <repoRef>")
  .description("Set a repo's access boundary on a ticket")
  .option("--access <access>", "access (write|read|test|none)", "write")
  .option(
    "--relation <relation>",
    "relation (confirmed|suggested|rejected|context_only)",
    "confirmed",
  )
  .option("--source <source>", "source", "manual")
  .action((ref, repoRef, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.setTicketRepoAccess(
      {
        ticket_id: ref,
        repo_id: repoRef,
        access: opts.access,
        relation: opts.relation,
        source: opts.source,
      },
      cliActor(),
    );
    printJson({ ok: true, access: res.access, relation: res.relation });
    wg.db.close();
  });

ticketRepo
  .command("packet <ref>")
  .description("Show the partitioned work-packet repo boundary (write/read/test/denied)")
  .action((ref, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const p = wg.workPacketRepos(ref);
    const names = (rs: Array<{ name: string }>) => rs.map((r) => r.name);
    printJson({
      writeRepos: names(p.writeRepos),
      readOnlyRepos: names(p.readOnlyRepos),
      testRepos: names(p.testRepos),
      deniedRepos: names(p.deniedRepos),
      suggestedRepos: names(p.suggestedRepos),
      rejectedRepos: names(p.rejectedRepos),
    });
    wg.db.close();
  });

ticketRepo
  .command("mono-fallback <ref>")
  .description("Promote a single unmapped repo to a confirmed write boundary")
  .action((ref, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson(wg.applyMonoFallback(ref, cliActor()));
    wg.db.close();
  });

const ticketDelivery = ticket
  .command("repo-delivery")
  .description("Per-repo delivery artifacts (WG-005)");
ticketDelivery
  .command("record <ref> <repoRef>")
  .description("Record (upsert) a repo's delivery artifact on a ticket")
  .option("--branch <branch>", "branch name")
  .option("--commit <sha>", "commit sha")
  .option("--pr <url>", "pull-request url")
  .option("--status <status>", "delivery status")
  .option("--evidence <ref>", "evidence reference")
  .action((ref, repoRef, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.recordRepoDelivery(
      {
        ticket_id: ref,
        repo_id: repoRef,
        branch_name: opts.branch,
        commit_sha: opts.commit,
        pr_url: opts.pr,
        status: opts.status,
        evidence_ref: opts.evidence,
      },
      cliActor(),
    );
    printJson({ ok: true, delivery: res.delivery });
    wg.db.close();
  });
ticketDelivery
  .command("list <ref>")
  .description("List a ticket's per-repo delivery artifacts")
  .action((ref, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson(wg.listRepoDeliveries(ref));
    wg.db.close();
  });

const decisions = program.command("decisions").description("Decision commands");
decisions
  .command("list")
  .description("List pending decisions")
  .action((_opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson(wg.listPendingDecisions());
    wg.db.close();
  });

program
  .command("decision")
  .description("Create a decision/blocker")
  .requiredOption("--title <title>", "title")
  .requiredOption("--question <q>", "question")
  .option("--severity <sev>", "severity", "human_preferred")
  .option("--ticket <ref>", "block this ticket")
  .action((opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const ticketId = opts.ticket ? wg.resolveTicket(opts.ticket).id : undefined;
    const d = wg.createDecision(
      {
        title: opts.title,
        question: opts.question,
        severity: opts.severity,
        ...(ticketId ? { ticketId } : {}),
      },
      cliActor(),
    );
    printJson({ ok: true, decision: { id: d.id, status: d.status } });
    wg.db.close();
  });

// --- Agent / claim / evidence flow (mirrors the MCP tools) -----------------

const agent = program.command("agent").description("Agent commands");
agent
  .command("register")
  .description("Register an agent")
  .option("-n, --name <name>", "display name")
  .option("--max-risk <level>", "max risk", "medium")
  .option("--cap <capability...>", "capabilities", [])
  .action((opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const a = wg.registerAgent(
      { display_name: opts.name, max_risk: opts.maxRisk, capabilities: opts.cap },
      cliActor(),
    );
    printJson({ ok: true, agent: { id: a.id, display_name: a.display_name } });
    wg.db.close();
  });

program
  .command("claim")
  .description("Claim the next ready ticket for an agent")
  .requiredOption("-a, --agent <id>", "agent id")
  .option("--ttl <seconds>", "claim TTL seconds", (v) => Number(v), 900)
  .action((opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.claimNextTicket(
      { agentId: opts.agent, ttlSeconds: opts.ttl },
      { type: "agent", id: opts.agent },
    );
    printJson(res ? { ok: true, ...res } : { ok: true, claimed: null });
    wg.db.close();
  });

program
  .command("claim-ticket <ref>")
  .description("Claim a CHOSEN ready ticket for an agent (same eligibility as claim)")
  .requiredOption("-a, --agent <id>", "agent id")
  .option("--ttl <seconds>", "claim TTL seconds", (v) => Number(v), 900)
  .option("--cap <capability...>", "agent capabilities to apply", [])
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.claimTicket(
      { ticket_id: ref, agent_id: opts.agent, ttl_seconds: opts.ttl, capabilities: opts.cap },
      { type: "agent", id: opts.agent },
    );
    printJson({ ok: true, ...res });
    wg.db.close();
  });

program
  .command("heartbeat <token>")
  .description("Extend an active claim lease")
  .action((token, _opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson({ ok: true, ...wg.heartbeat(token) });
    wg.db.close();
  });

program
  .command("evidence <ref>")
  .description("Record evidence against a claimed ticket")
  .requiredOption("--token <token>", "claim token")
  .requiredOption("--type <type>", "evidence type (e.g. test_output, manual_note)")
  .requiredOption("--summary <text>", "evidence summary")
  .option("--ac <acId>", "acceptance criterion id")
  .option("--uri <uri>", "evidence uri")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const t = wg.resolveTicket(ref);
    const res = wg.recordEvidence(
      {
        claimToken: opts.token,
        ticket_id: t.id,
        ac_id: opts.ac,
        evidence_type: opts.type,
        summary: opts.summary,
        uri: opts.uri,
      },
      { type: "agent" },
    );
    printJson({ ok: true, ...res });
    wg.db.close();
  });

program
  .command("submit <ref>")
  .description("Submit a claimed ticket for review")
  .requiredOption("--token <token>", "claim token")
  .option("--reason <text>", "reason")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const t = wg.resolveTicket(ref);
    const res = wg.submitForReview(
      { claimToken: opts.token, ticket_id: t.id, reason: opts.reason },
      { type: "agent" },
    );
    printJson({ ok: true, ...res });
    wg.db.close();
  });

program
  .command("delivery-artifact <ref>")
  .description("Record where a ticket was delivered (branch/PR). Persists onto the ticket.")
  .option("--token <token>", "claim token (required for agent actors)")
  .option("--branch <name>", "branch name")
  .option("--pr <url>", "pull request url")
  .option("--commit <sha>", "commit sha")
  .option("--diff <text>", "diff summary")
  .option("--as <actor>", "actor type: human|admin|system|agent", "human")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const actor: Actor =
      opts.as === "agent"
        ? { type: "agent" }
        : opts.as === "system"
          ? { type: "system" }
          : opts.as === "admin"
            ? { type: "admin", id: process.env.USER ?? "cli" }
            : cliActor();
    const res = wg.recordDeliveryArtifact(
      {
        ticket_id: ref,
        claim_token: opts.token,
        branch_name: opts.branch,
        pr_url: opts.pr,
        commit: opts.commit,
        diff_summary: opts.diff,
      },
      actor,
    );
    printJson({ ok: true, ...res });
    wg.db.close();
  });

program
  .command("block <ref>")
  .description("Mark a ticket blocked")
  .requiredOption("--reason <text>", "reason")
  .option("--token <token>", "claim token")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const t = wg.resolveTicket(ref);
    const res = wg.markBlocked(
      { claimToken: opts.token, ticket_id: t.id, reason: opts.reason },
      { type: "agent" },
    );
    printJson({ ok: true, ...res });
    wg.db.close();
  });

// --- Review (close a ticket from in_review) --------------------------------

const review = program.command("review").description("Review commands (close in_review tickets)");

review
  .command("approve <ref>")
  .description("Approve a ticket in review (in_review -> ready_for_merge); evaluates policy")
  .option("--reviewer <id>", "reviewer id")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const actor: Actor = { type: "human", id: opts.reviewer ?? "reviewer" };
    const res = wg.approveReview(ref, actor);
    printJson({ ok: true, status: res.ticket.status, event: res.eventId, policy: res.policy });
    wg.db.close();
  });

review
  .command("reject <ref>")
  .description(
    "Reject a ticket in review: rework (--to refining, default) or abandon (--to cancelled). " +
      "Resets the ticket's acceptance criteria to not-satisfied.",
  )
  .requiredOption("--reason <text>", "rejection reason (recorded on the event)")
  .option("--to <status>", "return status: refining (default), ready, or cancelled", "refining")
  .option("--reviewer <id>", "reviewer id")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const to = opts.to as "ready" | "refining" | "cancelled";
    if (to !== "ready" && to !== "refining" && to !== "cancelled") {
      throw new DispatchError(
        "VALIDATION_ERROR",
        "--to must be 'refining', 'ready', or 'cancelled'.",
        { to },
      );
    }
    const actor: Actor = { type: "human", id: opts.reviewer ?? "reviewer" };
    const res = wg.rejectReview(ref, to, actor, opts.reason);
    printJson({ ok: true, status: res.ticket.status, event: res.eventId, policy: res.policy });
    wg.db.close();
  });

// --- Won't do (terminal abandon) + reopen ----------------------------------

program
  .command("wont-do <ref>")
  .description(
    "Mark a ticket terminal 'won't do' (-> cancelled bucket); resets its ACs. Guarded: rejected for claimed/in-flight tickets.",
  )
  .requiredOption("--reason <text>", "why the ticket is being abandoned (recorded on the event)")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.wontDo(ref, cliActor(), opts.reason);
    printJson({ ok: true, status: res.ticket.status, event: res.eventId });
    wg.db.close();
  });

program
  .command("reopen <ref>")
  .description(
    "Reopen a won't-do (cancelled) ticket into the pipeline (-> refining default, or draft)",
  )
  .option("--to <status>", "target: refining (default) or draft", "refining")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const to = opts.to as "refining" | "draft";
    if (to !== "refining" && to !== "draft") {
      throw new DispatchError("VALIDATION_ERROR", "--to must be 'refining' or 'draft'.", { to });
    }
    const res = wg.reopenFromWontDo(ref, to, cliActor());
    printJson({ ok: true, status: res.ticket.status, event: res.eventId });
    wg.db.close();
  });

// --- System delivery evidence (no claim token; system actor only) ----------

program
  .command("attach-evidence <ref>")
  .description("Attach delivery evidence as the system/factory actor (no claim token)")
  .requiredOption("--type <type>", "evidence type (e.g. diff_summary, pull_request)")
  .requiredOption("--summary <text>", "evidence summary")
  .option("--uri <uri>", "evidence uri")
  .action((ref, opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    const res = wg.attachDeliveryEvidence(
      ref,
      { evidenceType: opts.type, summary: opts.summary, uri: opts.uri },
      { type: "system" },
    );
    printJson({ ok: true, ...res });
    wg.db.close();
  });

program
  .command("expire-claims")
  .description("Expire stale claims (system recovery)")
  .action((_opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    printJson({ ok: true, ...wg.expireStaleClaims({ type: "system" }) });
    wg.db.close();
  });

// --- Operational commands --------------------------------------------------

program
  .command("doctor")
  .description("Diagnose the database: schema, counts, stale claims, integrity")
  .option("--json", "emit machine-readable JSON", false)
  .action((opts, cmd) => {
    const dbPath = resolveDbPath(cmd.optsWithGlobals().db);
    let wg: Dispatch;
    try {
      wg = Dispatch.open(dbPath);
    } catch (err) {
      if (err instanceof DatabaseTooNewError || err instanceof DatabaseOpenError) {
        process.stderr.write(`dispatch doctor: ${err.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
    try {
      const report = runDoctor(wg.db, dbPath);
      if (opts.json) printJson(report);
      else process.stdout.write(`${renderDoctor(report)}\n`);
      process.exitCode = report.exitCode;
    } finally {
      wg.db.close();
    }
  });

program
  .command("stats")
  .description("Summary: tickets by status, open decisions, active/stale claims")
  .option("--json", "emit machine-readable JSON", false)
  .action((opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    try {
      const stats = computeStats(wg.db);
      if (opts.json) printJson(stats);
      else process.stdout.write(`${renderStats(stats)}\n`);
    } finally {
      wg.db.close();
    }
  });

// --- Portability: export / import the whole board (H5) ----------------------

program
  .command("export")
  .description(
    "Export the whole Dispatch board to a portable JSON bundle (tickets, epics, " +
      "scope graph, ACs, repos, decisions, reviews/evidence, work_events, claims). " +
      "Writes to stdout by default, or to a file with --out.",
  )
  .option("-o, --out <file>", "write the bundle to this file ('-' for stdout)")
  .action((opts, cmd) => {
    const wg = open(cmd.optsWithGlobals());
    try {
      const bundle = exportState(wg.db);
      const json = serializeBundle(bundle);
      const out = opts.out as string | undefined;
      if (out === undefined || out === "-") {
        process.stdout.write(json);
      } else {
        writeFileSync(out, json, { encoding: "utf8" });
        printJson({ ok: true, out, tables: Object.keys(bundle.tables).length });
      }
    } finally {
      wg.db.close();
    }
  });

program
  .command("import <file>")
  .description(
    "Import a board bundle (from 'dispatch export') into THIS database. Refuses a " +
      "non-empty DB unless --force is given (which replaces its contents). Reads " +
      "stdin when <file> is '-'.",
  )
  .option("--force", "replace the contents of a non-empty database", false)
  .action((file: string, opts, cmd) => {
    const json = file === "-" ? readStdin() : readFileSync(file, "utf8");
    const wg = open(cmd.optsWithGlobals());
    try {
      const res = importStateFromJson(wg.db, json, { force: opts.force });
      printJson({ ok: true, ...res });
    } finally {
      wg.db.close();
    }
  });

// --- H2 notifications: a setup-helper to test the configured sinks ----------
const notify = program.command("notify").description("Human-gate notification commands");
notify
  .command("test")
  .description(
    "Fire a synthetic human-gate event through the sinks configured via the " +
      "GAFFER_NOTIFY_* env vars (webhook · slack · desktop). With nothing " +
      "configured the notifier is a no-op and this reports 'disabled'.",
  )
  .option(
    "--kind <kind>",
    "gate kind: review_needed · ticket_blocked · ticket_parked · decision_pending",
    "review_needed",
  )
  .action((opts: { kind?: string }) => {
    const kind = opts.kind ?? "review_needed";
    if (!isNotifyKind(kind)) {
      throw new DispatchError("VALIDATION_ERROR", `Unknown notify kind: ${kind}`, {
        allowed: ["review_needed", "ticket_blocked", "ticket_parked", "decision_pending"],
      });
    }
    const notifier = buildNotifierFromEnv();
    if (!notifier.enabled) {
      printJson({ ok: true, enabled: false, message: "no notify sinks configured" });
      return;
    }
    notifier.notify({
      kind,
      title: "Synthetic test event",
      status: "in_review",
      at: new Date().toISOString(),
      detail: "dispatch notify test",
    });
    printJson({ ok: true, enabled: true, fired: kind });
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof DatabaseTooNewError || err instanceof DatabaseOpenError) {
      process.stderr.write(
        `${JSON.stringify({ ok: false, code: err.code, message: err.message })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (err instanceof DispatchError) {
      process.stderr.write(
        `${JSON.stringify({ ok: false, code: err.code, message: err.message, details: err.details })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (err instanceof ZodError) {
      process.stderr.write(
        `${JSON.stringify({ ok: false, code: "VALIDATION_ERROR", issues: err.issues.map((i) => ({ path: i.path, message: i.message })) })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

void main();
