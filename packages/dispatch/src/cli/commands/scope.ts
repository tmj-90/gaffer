import type { Command } from "commander";

import { cliActor, open, printJson } from "../shared.js";

export function registerScope(program: Command): void {
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
        {
          from_node_id: fromId,
          to_node_id: toId,
          relation: opts.relation,
          advanced: opts.advanced,
        },
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
}
