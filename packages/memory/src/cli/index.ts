import { defaultDbPath, openDb } from "../db/index.js";
import { getString, parseArgs } from "./args.js";
import {
  cmdAdd,
  cmdApprove,
  cmdDelete,
  cmdDeprecate,
  cmdReject,
  cmdReview,
  cmdSupersede,
  cmdSuggestFromCommit,
  cmdUpdate,
  cmdVerify,
} from "./commands/lifecycle.js";
import { cmdExport, cmdList, cmdRepos, cmdSearch, cmdShow, cmdTags } from "./commands/queries.js";
import {
  cmdBoundary,
  cmdDigest,
  cmdFeature,
  cmdFeatures,
  cmdImpact,
} from "./commands/knowledge.js";
import {
  cmdCard,
  cmdCards,
  cmdCardsForScope,
  cmdDeleteFileCard,
  cmdGetCardWatermark,
  cmdRepoCanonical,
} from "./commands/cards.js";
import {
  cmdAbsent,
  cmdAudit,
  cmdDemo,
  cmdDoctor,
  cmdHooks,
  cmdPrune,
  cmdSetup,
  cmdStats,
} from "./commands/setup.js";
import { cmdFlagged, cmdRecallFeedback } from "./commands/recall.js";
import { cmdSync } from "./commands/sync.js";
import { renderClaudeInstructions } from "./instructions.js";
import { VERSION } from "../version.js";

const HELP = `memory — reviewed project memory for AI coding agents

USAGE
  memory <command> [options]

COMMANDS
  init                      Create / migrate the local DB
  add                       Add a note (human, status=active). Interactive
                            unless --title is given.
  suggest                   Same as add but lands as a draft. Used by agents;
                            also handy when you want to triage later.
  suggest --from-commit <sha>
                            Draft a record straight from a commit message
                            (subject -> title, body -> summary/detail).
                            Auto-derives a commit permalink as the source
                            from remote.origin.url. Lands as a draft;
                            promote via review. --repo/--tag/--source apply.
  search <query...>         Full-text search. Returns brief summaries.
                            Flags: --repo, --tag (repeatable for ANY-of),
                            --prefix (match tokens of 3+ chars as
                            prefixes), --updated-after, --include-drafts,
                            --include-deprecated, --include-superseded,
                            --include-restricted, --limit
  show <id>                 Print the full record (body included).
  list                      Recent records across all lifecycle states.
  review [--list]           Interactive triage queue: show each pending
                            draft and ask [a]pprove / [r]eject / [e]dit /
                            [s]kip / [q]uit. Use --list (or pipe to stdout)
                            for the non-interactive list view.
  approve <id>              Promote draft → active.
  reject <id> [--reason "..."]
                            Drop a draft. Refuses non-drafts (use
                            deprecate instead). Emits a 'rejected' event
                            so the audit chain shows the triage decision.
                            --reason is optional but recommended — gives
                            the agent (or future-you) a record of WHY
                            the draft was dropped.
  deprecate <id>            Mark deprecated.
  supersede <old-id> --with <new-id>
                            Mark <old-id> as superseded by <new-id>.
  verify <id> [--review-after <iso-date>]
                            Bump last_verified_at; if review-after has
                            lapsed, push it 90 days forward (or use the
                            value you pass with --review-after).
  update <id> [--title ... --summary ... --body ... --source ... etc.]
                            Edit fields on an existing record. Useful
                            for fixing an agent's draft before approving.
  delete <id>               Hard-delete the record (events row preserved).
  tags                      Print all distinct tags.
  repos                     Print all distinct repos.
  export [--out <path>]     Export lore as a single JSON document
                            (envelope: { schemaVersion, exportedAt,
                            records }). Default: active + non-restricted
                            only, stable ordering by updated_at desc.
                            Without --out, writes to stdout. With --out,
                            writes the file with mode 0600.
                            Opt-ins: --include-drafts,
                            --include-deprecated, --include-superseded,
                            --include-restricted.
  sync export <dir> [--clean]
                            Write one .md file per record into <dir>
                            (e.g. .memory/) — PR-reviewable team lore.
                            Active + non-restricted by default; same
                            --include-* opt-ins as \`export\`. Pass --clean
                            to remove existing <id>.md files in <dir>
                            before writing (only files matching the
                            8-char id pattern; hand-written .md files
                            are left alone).
  sync import <dir>         Read every *.md file in <dir> and upsert
                            into the local DB. Restricted records are
                            skipped unless --include-restricted is set.
                            Imports respect the file's declared status
                            (the PR is the review gate).
  sync pull <parent>        Recursively discover every .memory/
                            directory under <parent> and import each.
                            One command bootstraps a fresh machine
                            across every repo in your workspace tree.
                            Same flags as \`sync import\`. Skips heavy
                            directories (node_modules, .git, dist,
                            build, target, vendor, etc.).
  audit [--n=N] [--raw]     Print the last N audit log lines (default 20)
                            in a redacted human-readable form. Use --raw
                            to see the full JSON instead.
  doctor                    Health-check the local install: DB exists,
                            permissions, FTS index, audit log, restricted
                            MCP gate, version. Exits non-zero on hard
                            failures, zero on warnings.
  setup [--dry-run] [--force] [--claude-md project|user]
                            One-command bootstrap: register the MCP server
                            with Claude Code, append the retrieval rule to
                            CLAUDE.md, install /memory-onboard into
                            ~/.claude/skills/, and point you at
                            /memory-onboard for cold-start (detects
                            CLAUDE.md, AGENTS.md, ADR dirs, top-level docs
                            to make the nudge concrete).
                            Idempotent. Opt out per step with --skip-mcp,
                            --skip-claude-md, --skip-skill,
                            --skip-corpus-nudge.
  demo [--force | --clean]  Seed five illustrative records (tagged 'demo')
                            so you can try list / search / review without
                            authoring content first. Refuses to seed into
                            a non-empty DB unless --force. Use --clean to
                            remove the demo records later.
  absent record "<query>" --reason "..." [--repo X] [--expires-days 14]
                            Record a verified-absence marker: "we
                            checked, the team has no policy on this".
                            When future search_lore returns zero hits
                            on the same normalised query, the response
                            includes this marker so the agent knows
                            it's an acknowledged gap. Self-expires
                            (default 14 days).
  absent list [--include-expired]
                            List active absence markers (or all of
                            them with --include-expired).
  stats [--top N] [--retire] [--since-days N] [--quiet-for-days N] [--json]
                            Local read-tracking view: top-cited
                            records, retirement candidates (active +
                            zero reads in N days), recent activity.
                            Opt out of read tracking via
                            MEMORY_NO_TELEMETRY=1.
  prune [--read-events-older-than N] [--vacuum] [--dry-run]
                            Local-DB GC. Deletes 'read' audit events
                            older than N days (default 90; lifecycle
                            events are never touched) and expired
                            absence markers. --vacuum reclaims disk
                            after; --dry-run reports counts only.
  impact <contract>         Cross-repo impact map for a contract: who
                            PROVIDES (owns/produces) it and who CONSUMES
                            (depends on) it. The consumers are the blast
                            radius of a shape change. Reads the map
                            aggregated locally + via sync pull.
  boundary <sub> ...        Manage cross-repo interaction edges:
                            add <repo> <contract> <provides|consumes>
                              [--kind K --detail "..." --source URL]
                            suggest ...   (same, lands as a draft)
                            list [--repo X --contract C --role R
                              --include-drafts --include-deprecated]
                            review [--list]   triage draft edges
                            approve <id> | reject <id> | deprecate <id>
                            Agents declare edges as drafts via MCP; a
                            human ratifies them — same trust gate as lore.
  digest <repo>             Show the repo's understanding digest: TLDR
                            overview, key structure, conventions + stack,
                            with a freshness line (updated_at / source)
                            and a caveat that it's a summary to verify
                            against code for high-stakes work.
  digest set <repo> --source <s>
      [--overview <s>] [--structure <s>] [--conventions <s>] [--stack <s>]
                            Upsert the repo digest. A PARTIAL set MERGES
                            into the existing digest — any section you
                            don't pass keeps its prior value. The first
                            set for a repo must include every section.
                            --source stamps provenance ('onboard' |
                            'merge:#<n>' | 'manual').
  digest touch <repo> --source <s>
                            Freshness stamp only — re-stamp source /
                            updated_at, leave every section's content
                            untouched. Refuses if no digest exists yet.
  feature add <repo> --name <s> --summary <s>
      [--status backlog|building|shipped] [--scope-node <s>] [--provenance <s>]
                            Add a feature to the repo's ledger (defaults
                            to backlog). --scope-node narrows it to a
                            sub-area; --provenance records where it came
                            from (e.g. an epic ref or merge source).
  feature advance <id> --to backlog|building|shipped
                            Move a feature to a new lifecycle status,
                            enforcing the legal forward transitions
                            (backlog → building → shipped, plus the direct
                            backlog → shipped jump). A backward / same-
                            state / unknown move is refused.
  features <repo> [--status backlog|building|shipped] [--node N]
                            List the repo's feature ledger, grouped by
                            lifecycle status. --node filters to a single
                            scope-node (a sub-area of the repo); omit it
                            to list every feature in the repo.
  card get --canonical <url-or-path> --repo <name> --path <file-path> [--json]
                            Fetch a single file card. Mechanical fields
                            (path, loc, symbols) always present; model
                            fields (tldr, role) only when model_status=active.
                            Absence of a card ≠ the file is unimportant.
  card search --canonical <c> --repo <r> --query <q> [--limit N] [--json]
                            FTS search over file cards (path, tldr, symbols).
                            Returns cards ordered by bm25 relevance.
  card upsert --canonical <c> --repo <r> --repo-root <abs> --path <rel>
      [--tldr <t>] [--role-primary <r>] [--role-tag <x> ...] [--model <m>]
      [--prompt-version <v>] [--synced-commit <sha>] [--source <s>] [--json]
                            Write/refresh one file card. Reads the file off
                            disk, computes mechanical fields + symbols, runs
                            both validation gates, then upserts. The caller
                            supplies only model-derived intent (tldr/role).
  card sync --canonical <c> --repo <r> --commit <sha> [--json]
                            Record the repo's card-set watermark (the commit
                            the cards were built from). Run once after an
                            onboard card pass.
  delete-file-card --canonical <c> --repo <r> --path <p> [--json]
                            Hard-delete one file card (row + FTS entry) for a
                            deleted / renamed-away file so no stale card is left
                            behind. No-op when the path has no card.
  get-card-watermark --canonical <c> --repo <r> [--json]
                            Read the repo's card-set watermark (synced_commit).
                            The CLI seam the Runner uses to fetch the watermark
                            instead of reading Memory's DB directly.
  repo-canonical (--repo-root <abs> | --canonical <url-or-path>) [--json]
                            Print the NORMALISED canonical (host/owner/repo,
                            lowercased — or the path fallback for no-remote
                            repos). The seam bash callers use so read/write
                            identity derivation can't drift. --json also
                            prints the derived repo_key.
  cards rekey --canonical <c> --repo <r> [--dry-run] [--json]
                            Re-key every card + watermark for display name <r>
                            onto repoKey(normalised canonical), in ONE
                            transaction (FTS stays intact). Migration for cards
                            onboarded before canonicalisation whose repo_key is
                            an sha256 of an un-normalised URL. --dry-run reports
                            what would move without writing.
  cards-for-scope --canonical <c> --repo <r> --query <q>
      [--paths p1 --paths p2] [--important-paths p3]
      [--max-cards N] [--max-tokens N] [--per-card-max-tokens N]
      [--ticket <id>] [--json]
                            Assemble a budgeted scope packet: prioritised
                            file cards (path-first, then FTS) + repo digest
                            + top lore. Use at the start of a task to
                            orient an agent. --json outputs machine-readable
                            JSON; human-readable by default.
                            Cards are retrieval aids — not authoritative.
                            --ticket logs which items were SERVED into that
                            ticket's context (the feedback-loop read-event edge).

  recall-feedback --repo <r> --ticket <id>
      --outcome <clean|reworked|blocked> [--json]
                            MEMORY FEEDBACK LOOP. Adjust the confidence of the
                            items served into a ticket's context by how the
                            ticket turned out: clean → bounded confidence bump
                            + verify; reworked/blocked → bounded demote + flag
                            for review. Bounded (one rung/outcome) and
                            idempotent (per repo+ticket+outcome). The runner
                            calls this at ticket outcome.
  flagged [--repo <r>] [--json]
                            List lore + file cards flagged for review — knowledge
                            that was in context for a reworked/blocked ticket.
  hooks install [--project] [--dry-run]
                            Wire the Claude Code Stop-hook for
                            session-end review nudges. Writes
                            .claude/settings.json so when Claude is
                            about to stop, the hook checks for pending
                            drafts and (once per session) asks the
                            user whether to triage them. Opt-in.
  hooks review-nudge        Internal — invoked by the Stop hook.
                            Reads Claude hook JSON on stdin; emits
                            block-JSON to stdout when drafts are
                            pending and this session hasn't been
                            nudged yet.
  print-claude-instructions
                            Print the retrieval rule to paste into
                            your CLAUDE.md / agent instructions so the
                            agent reliably calls search_lore.
  mcp                       Run the MCP server on stdio (same as memory-mcp).

EXAMPLES
  memory add --title "Argon2id is the default" --summary "..." --body "..."
  memory search "password hashing" --repo payments-svc
  memory review
  memory approve 7vk3qm9b
`;

async function cmdInit(): Promise<number> {
  const path = defaultDbPath();
  const db = openDb(path);
  db.close();
  // openDb runs migrations and creates the file with 0600 perms.
  process.stdout.write(`memory: initialised at ${path}\n`);
  return 0;
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [, , ...rest] = argv;
  if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (rest[0] === "--version" || rest[0] === "-v") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  const [cmd, ...subArgs] = rest;
  const parsed = parseArgs(subArgs);
  try {
    switch (cmd) {
      case "init":
        return await cmdInit();
      case "add":
        return await cmdAdd(parsed, false);
      case "suggest": {
        const fromCommit = getString(parsed.flags, "from-commit");
        if (fromCommit) return await cmdSuggestFromCommit(parsed, fromCommit);
        return await cmdAdd(parsed, true);
      }
      case "search":
        return await cmdSearch(parsed);
      case "show":
        return await cmdShow(parsed);
      case "list":
        return await cmdList();
      case "review":
        return await cmdReview(parsed);
      case "approve":
        return await cmdApprove(parsed);
      case "reject":
        return await cmdReject(parsed);
      case "deprecate":
        return await cmdDeprecate(parsed);
      case "supersede":
        return await cmdSupersede(parsed);
      case "verify":
        return await cmdVerify(parsed);
      case "update":
      case "edit":
        return await cmdUpdate(parsed);
      case "delete":
        return await cmdDelete(parsed);
      case "tags":
        return await cmdTags();
      case "repos":
        return await cmdRepos();
      case "audit":
        return await cmdAudit(parsed);
      case "export":
        return await cmdExport(parsed);
      case "sync":
        return await cmdSync(parsed);
      case "setup":
        return await cmdSetup(parsed);
      case "demo":
        return await cmdDemo(parsed);
      case "absent":
        return await cmdAbsent(parsed);
      case "stats":
        return await cmdStats(parsed);
      case "prune":
        return await cmdPrune(parsed);
      case "impact":
        return await cmdImpact(parsed);
      case "boundary":
        return await cmdBoundary(parsed);
      case "digest":
        return await cmdDigest(parsed);
      case "feature":
        return await cmdFeature(parsed);
      case "features":
        return await cmdFeatures(parsed);
      case "card":
        return await cmdCard(parsed);
      case "cards":
        return await cmdCards(parsed);
      case "repo-canonical":
        return await cmdRepoCanonical(parsed);
      case "delete-file-card":
        return await cmdDeleteFileCard(parsed);
      case "get-card-watermark":
        return await cmdGetCardWatermark(parsed);
      case "cards-for-scope":
        return await cmdCardsForScope(parsed);
      case "recall-feedback":
        return await cmdRecallFeedback(parsed);
      case "flagged":
        return await cmdFlagged(parsed);
      case "hooks":
        return await cmdHooks(parsed);
      case "doctor":
        return await cmdDoctor();
      case "print-claude-instructions":
      case "instructions":
        process.stdout.write(renderClaudeInstructions());
        return 0;
      case "mcp": {
        const { runMcpServer } = await import("../mcp/server.js");
        await runMcpServer();
        return 0;
      }
      default:
        process.stderr.write(`memory: unknown command '${cmd}'\n${HELP}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`memory: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
