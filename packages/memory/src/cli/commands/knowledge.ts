/**
 * Knowledge-graph commands: impact, boundary, digest, feature, features.
 *
 * These commands manage the cross-repo understanding layer: who provides
 * or consumes contracts (boundaries), repo digests, and feature ledgers.
 */
import {
  addBoundary,
  approveBoundary,
  deprecateBoundary,
  findDependents,
  listBoundaries,
  listBoundaryDrafts,
  rejectBoundary,
  suggestBoundary,
} from "../../core/boundaries.js";
import {
  addFeature,
  advanceFeature,
  AdvanceFeatureError,
  getDigest,
  listFeatures,
  upsertDigest,
} from "../../core/repoUnderstanding.js";
import { openDb } from "../../db/index.js";
import type { Boundary, BoundaryRole, Feature, FeatureStatus } from "../../db/types.js";
import { getBool, getString } from "../args.js";
import type { parseArgs } from "../args.js";
import { prompt } from "../prompt.js";

/** One-line render of a boundary edge for CLI output. */
export function renderBoundary(b: Boundary): string {
  const kind = b.kind ? ` (${b.kind})` : "";
  const detail = b.detail ? `\n    ${b.detail}` : "";
  const src = b.source ? `\n    source: ${b.source}` : "";
  const status = b.status === "active" ? "" : ` [${b.status}]`;
  return `  ${b.repo}  ${b.role}  ${b.contract}${kind}${status}  (${b.id})${detail}${src}`;
}

/** One-line render of a feature for CLI output. */
export function renderFeature(f: Feature): string {
  const node = f.scopeNode ? `  @${f.scopeNode}` : "";
  const area = f.area ? `  (${f.area})` : "";
  const prov = f.provenance ? `\n      provenance: ${f.provenance}` : "";
  return `  [${f.status}] ${f.name}${node}${area}  (${f.id})\n      ${f.summary}${prov}`;
}

const FEATURE_STATUS_ORDER: ReadonlyArray<FeatureStatus> = ["backlog", "building", "shipped"];

/**
 * `memory impact <contract>` — the headline cross-repo query. Shows
 * who provides (owns/produces) a contract and who consumes (depends on)
 * it, so before changing a contract you can see the blast radius. Reads
 * the aggregated map (populated locally and via `memory sync pull`).
 */
export async function cmdImpact(args: ReturnType<typeof parseArgs>): Promise<number> {
  const contract = args.positionals.join(" ").trim();
  if (!contract) {
    process.stderr.write("memory: impact <contract> requires a contract name\n");
    return 2;
  }
  const includeDrafts = getBool(args.flags, "include-drafts");
  const db = openDb();
  try {
    const r = findDependents(db, contract, { includeDrafts });
    process.stdout.write(`Impact map for contract: ${r.contract}\n\n`);
    process.stdout.write(`Providers (own / produce it): ${r.providers.length}\n`);
    if (r.providers.length === 0) {
      process.stdout.write("  (none declared)\n");
    } else {
      for (const b of r.providers) process.stdout.write(renderBoundary(b) + "\n");
    }
    process.stdout.write(`\nConsumers (depend on it — blast radius): ${r.consumers.length}\n`);
    if (r.consumers.length === 0) {
      process.stdout.write("  (none declared)\n");
    } else {
      for (const b of r.consumers) process.stdout.write(renderBoundary(b) + "\n");
    }
    if (r.providers.length === 0 && r.consumers.length === 0) {
      process.stdout.write(
        "\nNo declared edges. The map is only as complete as what teams have\n" +
          "declared — this is NOT proof a change is safe. Add edges with\n" +
          `  memory boundary add <repo> ${r.contract} provides|consumes\n` +
          "or aggregate other repos' maps with `memory sync pull <parent>`.\n",
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `memory boundary <sub>` — manage cross-repo interaction edges.
 *
 *   add <repo> <contract> <role>      human edge (active)
 *   suggest <repo> <contract> <role>  draft edge (as an agent would)
 *   list [--repo X] [--contract C] [--role provides|consumes]
 *   review [--list]                   triage draft edges
 *   approve <id> | reject <id> | deprecate <id>
 *
 * role is `provides` or `consumes`. Optional flags: --kind, --detail,
 * --source.
 */
export async function cmdBoundary(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  const db = openDb();
  try {
    if (sub === "add" || sub === "suggest") {
      const repo = args.positionals[1];
      const contract = args.positionals[2];
      const roleRaw = args.positionals[3];
      if (!repo || !contract || !roleRaw) {
        process.stderr.write(
          `memory: boundary ${sub} <repo> <contract> <provides|consumes> [--kind K --detail "..." --source URL]\n`,
        );
        return 2;
      }
      if (roleRaw !== "provides" && roleRaw !== "consumes") {
        process.stderr.write(`memory: role must be 'provides' or 'consumes' (got '${roleRaw}')\n`);
        return 2;
      }
      const role = roleRaw as BoundaryRole;
      const input = {
        repo,
        contract,
        role,
        kind: getString(args.flags, "kind"),
        detail: getString(args.flags, "detail"),
        source: getString(args.flags, "source"),
        author: process.env["USER"],
      };
      const edge = sub === "add" ? addBoundary(db, input) : suggestBoundary(db, input);
      process.stdout.write(
        `memory: ${sub === "add" ? "declared" : "suggested"} boundary ${edge.id} (${edge.status})\n` +
          renderBoundary(edge) +
          "\n",
      );
      return 0;
    }
    if (sub === "list") {
      const role = getString(args.flags, "role");
      if (role !== undefined && role !== "provides" && role !== "consumes") {
        process.stderr.write("memory: --role must be 'provides' or 'consumes'\n");
        return 2;
      }
      const edges = listBoundaries(db, {
        repo: getString(args.flags, "repo"),
        contract: getString(args.flags, "contract"),
        role: role as BoundaryRole | undefined,
        includeDrafts: getBool(args.flags, "include-drafts"),
        includeDeprecated: getBool(args.flags, "include-deprecated"),
      });
      if (edges.length === 0) {
        process.stdout.write("memory: no boundary edges\n");
        return 0;
      }
      for (const b of edges) process.stdout.write(renderBoundary(b) + "\n");
      return 0;
    }
    if (sub === "review") {
      const drafts = listBoundaryDrafts(db);
      if (drafts.length === 0) {
        process.stdout.write("memory: no pending boundary drafts.\n");
        return 0;
      }
      const listOnly = getBool(args.flags, "list") || !process.stdin.isTTY;
      if (listOnly) {
        process.stdout.write(`${drafts.length} boundary draft(s) awaiting review:\n\n`);
        for (const b of drafts) process.stdout.write(renderBoundary(b) + "\n");
        process.stdout.write(
          "\nUse `memory boundary approve <id>` / `memory boundary reject <id>`.\n",
        );
        return 0;
      }
      let approved = 0;
      let rejected = 0;
      let skipped = 0;
      for (let i = 0; i < drafts.length; i++) {
        const b = drafts[i]!;
        process.stdout.write(`── Edge ${i + 1} of ${drafts.length} ──\n${renderBoundary(b)}\n`);
        const answer = (await prompt("[a]pprove  [r]eject  [s]kip  [q]uit  > "))
          .trim()
          .toLowerCase();
        if (answer === "q" || answer === "quit") {
          process.stdout.write("\nmemory: stopped.\n");
          break;
        }
        if (answer === "a" || answer === "approve" || answer === "y") {
          if (approveBoundary(db, b.id)) approved++;
          process.stdout.write(`✓ approved ${b.id}\n\n`);
          continue;
        }
        if (answer === "r" || answer === "reject" || answer === "n") {
          if (rejectBoundary(db, b.id)) rejected++;
          process.stdout.write(`✗ rejected ${b.id}\n\n`);
          continue;
        }
        skipped++;
        process.stdout.write(`… skipped ${b.id}\n\n`);
      }
      process.stdout.write(
        `\nReview complete. approved: ${approved}  rejected: ${rejected}  skipped: ${skipped}\n`,
      );
      return 0;
    }
    if (sub === "approve") {
      const id = args.positionals[1];
      if (!id) {
        process.stderr.write("memory: boundary approve <id> requires an id\n");
        return 2;
      }
      const edge = approveBoundary(db, id);
      if (!edge) {
        process.stderr.write(
          `memory: ${id} is not a pending boundary draft (already active, deprecated, or unknown)\n`,
        );
        return 1;
      }
      process.stdout.write(`memory: approved boundary ${edge.id}\n`);
      return 0;
    }
    if (sub === "reject") {
      const id = args.positionals[1];
      if (!id) {
        process.stderr.write("memory: boundary reject <id> requires an id\n");
        return 2;
      }
      if (!rejectBoundary(db, id)) {
        process.stderr.write(
          `memory: cannot reject ${id} (unknown id or not a draft; use \`memory boundary deprecate\`)\n`,
        );
        return 1;
      }
      process.stdout.write(`memory: rejected boundary ${id}\n`);
      return 0;
    }
    if (sub === "deprecate") {
      const id = args.positionals[1];
      if (!id) {
        process.stderr.write("memory: boundary deprecate <id> requires an id\n");
        return 2;
      }
      const edge = deprecateBoundary(db, id);
      if (!edge) {
        process.stderr.write(`memory: no boundary edge with id ${id}\n`);
        return 1;
      }
      process.stdout.write(`memory: deprecated boundary ${edge.id}\n`);
      return 0;
    }
    process.stderr.write(
      "memory: boundary requires a subcommand — add | suggest | list | review | approve | reject | deprecate\n",
    );
    return 2;
  } finally {
    db.close();
  }
}

/**
 * `memory digest <repo>` — show the repo's current understanding
 * digest: the TLDR overview, key structure, and conventions, plus a
 * freshness line (updated_at / source) and an honesty caveat that the
 * digest is a SUMMARY to verify against code for high-stakes work.
 *
 * Two WRITE sub-verbs share this entrypoint (reads stay the default):
 *   digest set <repo>   — upsert / partial-merge the digest sections
 *   digest touch <repo> — freshness stamp only (source/updated_at)
 */
export async function cmdDigest(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  if (sub === "set") return await cmdDigestSet(args);
  if (sub === "touch") return await cmdDigestTouch(args);
  const repo = args.positionals.join(" ").trim();
  if (!repo) {
    process.stderr.write("memory: digest <repo> requires a repo name\n");
    return 2;
  }
  const db = openDb();
  try {
    const digest = getDigest(db, repo);
    if (!digest) {
      process.stdout.write(
        `memory: no digest for '${repo}' yet.\n` +
          "  Run the onboarding step (or `update_repo_digest` via MCP) to create one.\n",
      );
      return 0;
    }
    process.stdout.write(
      `Repo digest: ${digest.repo}\n\n` +
        `OVERVIEW\n  ${digest.overview}\n\n` +
        `STRUCTURE\n  ${digest.structure}\n\n` +
        `CONVENTIONS\n  ${digest.conventions}\n\n` +
        `STACK\n  ${digest.stack}\n\n` +
        `updated_at: ${digest.updatedAt}  ·  source: ${digest.source}\n` +
        "NOTE: this digest is a summary — verify it against the code for high-stakes work.\n",
    );
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `memory features <repo> [--status backlog|building|shipped] [--node <scope_node>]`
 * — list the repo's feature ledger, optionally filtered by status and/or
 * scope-node. Grouped by status for a stable, scannable view; the
 * `--node` filter narrows to a single scope-node (a sub-area of the repo).
 */
export async function cmdFeatures(args: ReturnType<typeof parseArgs>): Promise<number> {
  const repo = args.positionals.join(" ").trim();
  if (!repo) {
    process.stderr.write("memory: features <repo> requires a repo name\n");
    return 2;
  }
  const statusRaw = getString(args.flags, "status");
  if (
    statusRaw !== undefined &&
    statusRaw !== "backlog" &&
    statusRaw !== "building" &&
    statusRaw !== "shipped"
  ) {
    process.stderr.write(
      `memory: --status must be backlog | building | shipped (got '${statusRaw}')\n`,
    );
    return 2;
  }
  const node = getString(args.flags, "node");
  const db = openDb();
  try {
    const features = listFeatures(db, repo, {
      status: statusRaw as FeatureStatus | undefined,
      scopeNode: node,
    });
    const nodeLabel = node ? ` @${node}` : "";
    if (features.length === 0) {
      process.stdout.write(
        `memory: no features for '${repo}'${nodeLabel}` +
          (statusRaw ? ` with status '${statusRaw}'` : "") +
          "\n",
      );
      return 0;
    }
    process.stdout.write(`Features for ${repo}${nodeLabel}: ${features.length}\n\n`);
    // Group by status in lifecycle order so the ledger reads top-down.
    for (const status of FEATURE_STATUS_ORDER) {
      const group = features.filter((f) => f.status === status);
      if (group.length === 0) continue;
      process.stdout.write(`${status.toUpperCase()} (${group.length})\n`);
      for (const f of group) process.stdout.write(renderFeature(f) + "\n");
      process.stdout.write("\n");
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `memory digest set <repo> [--overview …] [--structure …] [--conventions …]
 *  [--stack …] --source <s>` — upsert the repo's digest. A PARTIAL set MERGES
 * into the existing digest: any section NOT passed keeps its prior value, so
 * the merge producer (and a human) can refresh just the sections a change
 * touched without re-stating the whole digest. `--source` is required (it's the
 * provenance stamp the underlying `upsertDigest` enforces). Setting the very
 * first digest for a repo requires every section (there's nothing to merge from)
 * — `upsertDigest` would otherwise store empty strings silently, so we refuse.
 *
 * Writes DIRECTLY (no draft gate) — see core/repoUnderstanding.ts: a digest is a
 * factual post-merge reflection, not an opinion to ratify.
 */
async function cmdDigestSet(args: ReturnType<typeof parseArgs>): Promise<number> {
  const repo = (args.positionals[1] ?? "").trim();
  if (!repo) {
    process.stderr.write("memory: digest set <repo> requires a repo name\n");
    return 2;
  }
  const source = getString(args.flags, "source");
  if (!source || !source.trim()) {
    process.stderr.write(
      "memory: digest set requires --source <s> (provenance: 'onboard' | 'merge:#<n>' | 'manual')\n",
    );
    return 2;
  }
  const overview = getString(args.flags, "overview");
  const structure = getString(args.flags, "structure");
  const conventions = getString(args.flags, "conventions");
  const stack = getString(args.flags, "stack");
  if (
    overview === undefined &&
    structure === undefined &&
    conventions === undefined &&
    stack === undefined
  ) {
    process.stderr.write(
      "memory: digest set needs at least one section (--overview, --structure, --conventions, --stack)\n",
    );
    return 2;
  }

  const db = openDb();
  try {
    // Partial-merge: read the current digest and fill any section the caller
    // didn't pass with its prior value. On a first-ever set there's nothing to
    // merge from, so an omitted section would persist as "" — refuse instead so
    // a half-formed digest can't be created by accident.
    const existing = getDigest(db, repo);
    if (!existing) {
      const missing: string[] = [];
      if (overview === undefined) missing.push("--overview");
      if (structure === undefined) missing.push("--structure");
      if (conventions === undefined) missing.push("--conventions");
      if (stack === undefined) missing.push("--stack");
      if (missing.length > 0) {
        process.stderr.write(
          `memory: no digest for '${repo}' yet — the first set must include every section (missing: ${missing.join(", ")}). Partial set only merges into an existing digest.\n`,
        );
        return 2;
      }
    }
    const digest = upsertDigest(db, {
      repo,
      overview: overview ?? existing!.overview,
      structure: structure ?? existing!.structure,
      conventions: conventions ?? existing!.conventions,
      stack: stack ?? existing!.stack,
      source,
    });
    const changed = [
      overview !== undefined ? "overview" : null,
      structure !== undefined ? "structure" : null,
      conventions !== undefined ? "conventions" : null,
      stack !== undefined ? "stack" : null,
    ].filter(Boolean);
    process.stdout.write(
      `memory: ${existing ? "updated" : "created"} digest for ${digest.repo}` +
        ` (${changed.join(", ")}; source: ${digest.source})\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `memory digest touch <repo> --source <s>` — a FRESHNESS stamp only. Leaves
 * every section's content untouched and just re-stamps `source` / `updated_at`,
 * so a merge with no prepared section deltas can still record that the repo
 * moved on this merge. Refuses if no digest exists yet (there's no content to
 * keep fresh — create one with `digest set` first).
 */
async function cmdDigestTouch(args: ReturnType<typeof parseArgs>): Promise<number> {
  const repo = (args.positionals[1] ?? "").trim();
  if (!repo) {
    process.stderr.write("memory: digest touch <repo> requires a repo name\n");
    return 2;
  }
  const source = getString(args.flags, "source");
  if (!source || !source.trim()) {
    process.stderr.write("memory: digest touch requires --source <s> (e.g. merge:#<n>)\n");
    return 2;
  }
  const db = openDb();
  try {
    const existing = getDigest(db, repo);
    if (!existing) {
      process.stderr.write(
        `memory: no digest for '${repo}' to touch — create one with \`memory digest set\` first\n`,
      );
      return 1;
    }
    // Re-upsert the same content with the new source — upsertDigest refreshes
    // updated_at and appends the digest_updated audit event.
    const digest = upsertDigest(db, {
      repo,
      overview: existing.overview,
      structure: existing.structure,
      conventions: existing.conventions,
      stack: existing.stack,
      source,
    });
    process.stdout.write(`memory: touched digest for ${digest.repo} (source: ${digest.source})\n`);
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `memory feature add <repo> --name <s> --summary <s> [--status backlog|building|shipped]
 *  [--scope-node <s>] [--provenance <s>]` — add a feature to the repo's ledger.
 * Defaults to `backlog`. Writes DIRECTLY as a proposal (no draft gate) — see
 * core/repoUnderstanding.ts.
 */
async function cmdFeatureAdd(args: ReturnType<typeof parseArgs>): Promise<number> {
  const repo = (args.positionals[1] ?? "").trim();
  if (!repo) {
    process.stderr.write("memory: feature add <repo> requires a repo name\n");
    return 2;
  }
  const name = getString(args.flags, "name");
  if (!name || !name.trim()) {
    process.stderr.write("memory: feature add requires --name <s>\n");
    return 2;
  }
  const summary = getString(args.flags, "summary");
  if (summary === undefined) {
    process.stderr.write("memory: feature add requires --summary <s>\n");
    return 2;
  }
  const statusRaw = getString(args.flags, "status");
  if (
    statusRaw !== undefined &&
    statusRaw !== "backlog" &&
    statusRaw !== "building" &&
    statusRaw !== "shipped"
  ) {
    process.stderr.write(
      `memory: --status must be backlog | building | shipped (got '${statusRaw}')\n`,
    );
    return 2;
  }
  const scopeNode = getString(args.flags, "scope-node");
  const provenance = getString(args.flags, "provenance");
  const db = openDb();
  try {
    const feature = addFeature(db, {
      repo,
      name,
      summary,
      status: statusRaw as FeatureStatus | undefined,
      scopeNode,
      provenance,
    });
    const node = feature.scopeNode ? ` @${feature.scopeNode}` : "";
    process.stdout.write(
      `memory: added feature ${feature.id} [${feature.status}] ${feature.name}${node} (${feature.repo})\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `memory feature advance <id> --to backlog|building|shipped` — move a
 * feature to a new lifecycle status, enforcing the legal forward transitions
 * (backlog → building → shipped, plus backlog → shipped). An illegal /
 * backward / same-state move is rejected via AdvanceFeatureError; an unknown
 * id is reported distinctly. The advance INTO `shipped` is a factual post-merge
 * reflection and writes directly.
 */
async function cmdFeatureAdvance(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = (args.positionals[1] ?? "").trim();
  if (!id) {
    process.stderr.write("memory: feature advance <id> requires a feature id\n");
    return 2;
  }
  const to = getString(args.flags, "to");
  if (to !== "backlog" && to !== "building" && to !== "shipped") {
    process.stderr.write(
      `memory: feature advance requires --to backlog | building | shipped (got ${JSON.stringify(to)})\n`,
    );
    return 2;
  }
  const db = openDb();
  try {
    const feature = advanceFeature(db, id, to);
    process.stdout.write(
      `memory: advanced feature ${feature.id} → ${feature.status} (${feature.name})\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof AdvanceFeatureError) {
      // Distinguish the two refusal modes so the caller gets a precise message
      // and a precise exit code (unknown id → 1, illegal transition → 2).
      process.stderr.write(`memory: ${err.message}\n`);
      return err.reason === "unknown_id" ? 1 : 2;
    }
    throw err;
  } finally {
    db.close();
  }
}

/**
 * `memory feature <sub>` — write verbs on the feature ledger:
 *   add <repo> --name <s> --summary <s> [--status …] [--scope-node …] [--provenance …]
 *   advance <id> --to backlog|building|shipped
 * (Reads stay on the plural `memory features <repo>`.)
 */
export async function cmdFeature(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  if (sub === "add") return await cmdFeatureAdd(args);
  if (sub === "advance") return await cmdFeatureAdvance(args);
  process.stderr.write(
    "memory: feature requires a subcommand — `memory feature add <repo> --name … --summary …` or `memory feature advance <id> --to …`\n",
  );
  return 2;
}
