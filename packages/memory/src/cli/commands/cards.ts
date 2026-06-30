/**
 * File-card CLI commands: card get, card search, cards-for-scope.
 *
 * These commands expose the file-card retrieval surface to human operators
 * and to scripts that need machine-readable JSON output. All three accept
 * --canonical (the repo identity key) and --repo (the display name); the
 * canonical is used to compute the stable repoKey internally.
 *
 * FRAMING: file cards are RETRIEVAL AIDS. They help agents and operators
 * choose what to read — they are never authoritative source. This is
 * surfaced in the output of every command.
 *
 * ISOLATION: no imports from dispatch or crew.
 */
import { getFileCard, repoKey, searchFileCards } from "../../core/fileCards.js";
import { cardsForScope } from "../../core/scopePacket.js";
import { openDb } from "../../db/index.js";
import { getBool, getString, getStringArray } from "../args.js";
import type { parseArgs } from "../args.js";

// ── Helpers ───────────────────────────────────────────────────────────

/** Resolve --canonical and --repo from parsed flags with clear error messages. */
function resolveRepoArgs(
  args: ReturnType<typeof parseArgs>,
  cmd: string,
): { canonical: string; repo: string } | null {
  const canonical = getString(args.flags, "canonical");
  const repo = getString(args.flags, "repo");
  if (!canonical) {
    process.stderr.write(
      `memory: ${cmd} requires --canonical <url-or-path> (the repo's remote origin URL or absolute realpath)\n`,
    );
    return null;
  }
  if (!repo) {
    process.stderr.write(`memory: ${cmd} requires --repo <name> (the human-readable repo name)\n`);
    return null;
  }
  return { canonical, repo };
}

// ── card get ─────────────────────────────────────────────────────────

/**
 * `memory card get --canonical <c> --repo <r> --path <p> [--json]`
 *
 * Fetch a single file card. Returns mechanical fields always; model fields
 * (tldr, role) only when model_status=active (trust-split applied).
 * Prints JSON with --json; human-readable otherwise.
 */
export async function cmdCardGet(args: ReturnType<typeof parseArgs>): Promise<number> {
  const resolved = resolveRepoArgs(args, "card get");
  if (!resolved) return 2;

  const path = getString(args.flags, "path");
  if (!path) {
    process.stderr.write("memory: card get requires --path <file-path>\n");
    return 2;
  }

  const json = getBool(args.flags, "json");
  const db = openDb();
  try {
    const rk = repoKey(resolved.canonical);
    const card = getFileCard(db, rk, path);

    if (json) {
      const out = card
        ? { found: true, card }
        : { found: false, path, message: "No active card for this path." };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return 0;
    }

    if (!card) {
      process.stdout.write(
        `No active card for: ${path}\n` +
          "  The file may exist but have no card yet, or the card may be stale/shadow.\n" +
          "  NOTE: absence of a card does not mean the file is unimportant.\n",
      );
      return 0;
    }

    process.stdout.write(
      `FILE CARD (retrieval aid — not authoritative source)\n` +
        `  repo:    ${card.repo}\n` +
        `  path:    ${card.path}\n` +
        `  loc:     ${card.loc}\n` +
        `  status:  card=${card.cardStatus}  model=${card.modelStatus}\n` +
        (card.tldr
          ? `  tldr:    ${card.tldr}\n`
          : `  tldr:    (not available — model_status=${card.modelStatus})\n`) +
        (card.rolePrimary
          ? `  role:    ${card.rolePrimary}${card.roleTags ? ` [${card.roleTags.join(", ")}]` : ""}\n`
          : "") +
        (card.symbols.length > 0 ? `  symbols: ${card.symbols.join(", ")}\n` : "") +
        `  updated: ${card.updatedAt}\n`,
    );
    return 0;
  } finally {
    db.close();
  }
}

// ── card search ───────────────────────────────────────────────────────

/**
 * `memory card search --canonical <c> --repo <r> --query <q> [--limit N] [--json]`
 *
 * FTS5 search over file cards. Returns cards ordered by bm25 relevance.
 * Model fields (tldr, role) only shown when model_status=active.
 */
export async function cmdCardSearch(args: ReturnType<typeof parseArgs>): Promise<number> {
  const resolved = resolveRepoArgs(args, "card search");
  if (!resolved) return 2;

  const query = getString(args.flags, "query") ?? args.positionals.join(" ").trim();
  if (!query) {
    process.stderr.write("memory: card search requires --query <text> (or positional args)\n");
    return 2;
  }

  const limitRaw = getString(args.flags, "limit");
  const limit = limitRaw !== undefined ? parseInt(limitRaw, 10) : 20;
  if (isNaN(limit) || limit < 1 || limit > 50) {
    process.stderr.write("memory: --limit must be between 1 and 50\n");
    return 2;
  }

  const json = getBool(args.flags, "json");
  const db = openDb();
  try {
    const rk = repoKey(resolved.canonical);
    const cards = searchFileCards(db, rk, query, limit);

    if (json) {
      process.stdout.write(
        JSON.stringify({ query, repo: resolved.repo, count: cards.length, cards }, null, 2) + "\n",
      );
      return 0;
    }

    if (cards.length === 0) {
      process.stdout.write(`No file cards matching '${query}' in ${resolved.repo}\n`);
      return 0;
    }

    process.stdout.write(
      `File cards matching '${query}' in ${resolved.repo}: ${cards.length}\n` +
        "(retrieval aids — not authoritative source)\n\n",
    );
    for (const card of cards) {
      process.stdout.write(
        `  ${card.path}  [${card.cardStatus}/${card.modelStatus}]\n` +
          (card.tldr ? `    ${card.tldr}\n` : "") +
          (card.symbols.length > 0
            ? `    symbols: ${card.symbols.slice(0, 8).join(", ")}${card.symbols.length > 8 ? ` +${card.symbols.length - 8} more` : ""}\n`
            : "") +
          "\n",
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

// ── cards-for-scope ───────────────────────────────────────────────────

/**
 * `memory cards-for-scope --canonical <c> --repo <r> --query <q>
 *   [--paths p1 --paths p2] [--important-paths p3]
 *   [--max-cards N] [--max-tokens N] [--per-card-max-tokens N] [--json]`
 *
 * Assemble a budgeted scope packet: prioritised file cards + repo digest
 * + top lore records. Designed to orient an agent before a task.
 *
 * Always outputs JSON (--json is the default behaviour for machine use;
 * omit it for a human-readable summary).
 */
export async function cmdCardsForScope(args: ReturnType<typeof parseArgs>): Promise<number> {
  const resolved = resolveRepoArgs(args, "cards-for-scope");
  if (!resolved) return 2;

  const query = getString(args.flags, "query") ?? args.positionals.join(" ").trim();
  if (!query) {
    process.stderr.write("memory: cards-for-scope requires --query <text>\n");
    return 2;
  }

  const paths = getStringArray(args.flags, "paths");
  const importantPaths = getStringArray(args.flags, "important-paths");

  const maxCardsRaw = getString(args.flags, "max-cards");
  const maxCards = maxCardsRaw !== undefined ? parseInt(maxCardsRaw, 10) : undefined;
  if (maxCards !== undefined && (isNaN(maxCards) || maxCards < 1)) {
    process.stderr.write("memory: --max-cards must be a positive integer\n");
    return 2;
  }

  const maxTokensRaw = getString(args.flags, "max-tokens");
  const maxTokens = maxTokensRaw !== undefined ? parseInt(maxTokensRaw, 10) : undefined;
  if (maxTokens !== undefined && (isNaN(maxTokens) || maxTokens < 1)) {
    process.stderr.write("memory: --max-tokens must be a positive integer\n");
    return 2;
  }

  const perCardMaxTokensRaw = getString(args.flags, "per-card-max-tokens");
  const perCardMaxTokens =
    perCardMaxTokensRaw !== undefined ? parseInt(perCardMaxTokensRaw, 10) : undefined;
  if (perCardMaxTokens !== undefined && (isNaN(perCardMaxTokens) || perCardMaxTokens < 1)) {
    process.stderr.write("memory: --per-card-max-tokens must be a positive integer\n");
    return 2;
  }

  const json = getBool(args.flags, "json");
  const db = openDb();
  try {
    const packet = cardsForScope(db, {
      repoCanonical: resolved.canonical,
      repo: resolved.repo,
      query,
      paths: paths.length > 0 ? paths : undefined,
      importantPaths: importantPaths.length > 0 ? importantPaths : undefined,
      maxCards,
      maxTokens,
      perCardMaxTokens,
    });

    if (json) {
      process.stdout.write(JSON.stringify(packet, null, 2) + "\n");
      return 0;
    }

    // Human-readable summary
    process.stdout.write(
      `SCOPE PACKET for '${resolved.repo}'\n` +
        `Query: ${query}\n` +
        `Cards: ${packet.cards.length}  Omitted: ${packet.omitted.length}  Lore: ${packet.lore.length}\n` +
        (packet.truncationReason ? `Truncated: ${packet.truncationReason}\n` : "") +
        `\n${packet.selectionBasis}\n\n`,
    );

    if (packet.digest) {
      process.stdout.write(
        `DIGEST\n  ${packet.digest.overview}\n  (source: ${packet.digest.source})\n\n`,
      );
    }

    if (packet.cards.length > 0) {
      process.stdout.write(`FILE CARDS (retrieval aids — not authoritative source)\n`);
      for (const entry of packet.selectionOrder) {
        const card = packet.cards.find((c) => c.path === entry.path);
        if (!card) continue;
        process.stdout.write(
          `  [${entry.tier}] ${card.path}  [${card.cardStatus}/${card.modelStatus}]\n` +
            (card.tldr ? `    ${card.tldr}\n` : "") +
            (card.symbols.length > 0
              ? `    symbols: ${card.symbols.slice(0, 6).join(", ")}${card.symbols.length > 6 ? ` +${card.symbols.length - 6} more` : ""}\n`
              : "") +
            "\n",
        );
      }
    }

    if (packet.omitted.length > 0) {
      process.stdout.write(`OMITTED (${packet.omitted.length}):\n`);
      for (const o of packet.omitted) {
        process.stdout.write(`  ${o.path}  (${o.reason})\n`);
      }
      process.stdout.write("\n");
    }

    if (packet.coverage.missing.length > 0) {
      process.stdout.write(
        `PATHS WITH NO CARD (${packet.coverage.missing.length}):\n` +
          packet.coverage.missing.map((p) => `  ${p}`).join("\n") +
          "\n  NOTE: read these files directly — no card exists yet.\n\n",
      );
    }

    if (packet.lore.length > 0) {
      process.stdout.write(`RELATED LORE\n`);
      for (const l of packet.lore) {
        process.stdout.write(`  [${l.id}] ${l.title}\n    ${l.summary.slice(0, 120)}\n\n`);
      }
    }

    return 0;
  } finally {
    db.close();
  }
}

// ── card dispatcher ───────────────────────────────────────────────────

/**
 * `memory card <sub>` — dispatch card sub-commands.
 *   get     --canonical <c> --repo <r> --path <p>
 *   search  --canonical <c> --repo <r> --query <q>
 */
export async function cmdCard(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  if (sub === "get") return await cmdCardGet(args);
  if (sub === "search") return await cmdCardSearch(args);
  process.stderr.write(
    "memory: card requires a subcommand — `memory card get` or `memory card search`\n",
  );
  return 2;
}
