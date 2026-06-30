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
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { getFileCard, repoKey, searchFileCards, setWatermark, upsertFileCard } from "../../core/fileCards.js";
import {
  countLines,
  extractFileSymbols,
  sha256,
  validateMechanical,
  validateModel,
} from "../../core/cardValidation.js";
import { cardsForScope } from "../../core/scopePacket.js";
import { openDb } from "../../db/index.js";
import type { ModelStatus } from "../../db/types.js";
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

// ── card upsert ───────────────────────────────────────────────────────

/**
 * `memory card upsert --canonical <c> --repo <r> --repo-root <abs> --path <rel>
 *   [--tldr <t>] [--role-primary <r>] [--role-tag <x> ...] [--model <m>]
 *   [--prompt-version <v>] [--synced-commit <sha>] [--source <s>] [--json]`
 *
 * The WRITE seam for onboard's structure-first card pass. The caller supplies
 * only the MODEL-derived intent (tldr / role); this command owns the mechanical
 * truth: it reads the file off disk (repo-root + path), computes content_hash +
 * loc, extracts the symbol set, then runs BOTH deterministic gates
 * (validateMechanical → card_status, validateModel → model_status) before the
 * transactional upsert. Symbols are extracted HERE (not trusted from the
 * caller) so the stored set and the verification set are identical — the model
 * gate can never spuriously fail on a symbol mismatch.
 *
 * A file we cannot read is reported as a shadow skip and NOT written (a card
 * with no mechanical content has no retrieval value). Best-effort by design:
 * the onboard caller treats any non-zero exit as "skip this file, keep going".
 */
export async function cmdCardUpsert(args: ReturnType<typeof parseArgs>): Promise<number> {
  const resolved = resolveRepoArgs(args, "card upsert");
  if (!resolved) return 2;

  const path = getString(args.flags, "path");
  if (!path) {
    process.stderr.write("memory: card upsert requires --path <repo-relative-file-path>\n");
    return 2;
  }
  const repoRoot = getString(args.flags, "repo-root");
  if (!repoRoot || !isAbsolute(repoRoot)) {
    process.stderr.write("memory: card upsert requires --repo-root <absolute-repo-path>\n");
    return 2;
  }

  const tldr = getString(args.flags, "tldr");
  const rolePrimary = getString(args.flags, "role-primary");
  const roleTags = getStringArray(args.flags, "role-tag");
  const model = getString(args.flags, "model");
  const promptVersion = getString(args.flags, "prompt-version");
  const syncedCommit = getString(args.flags, "synced-commit");
  const source = getString(args.flags, "source") ?? "onboard";
  const json = getBool(args.flags, "json");

  // Read the file off disk — the mechanical source of truth. A path that
  // escapes the repo root, or is unreadable, yields a shadow skip. Both sides
  // are normalised via resolve() first so a trailing/double slash in repo-root
  // (e.g. ".../T//repo") can't defeat the containment check.
  const root = resolve(repoRoot);
  const abs = resolve(root, path);
  let fileContent: string | null = null;
  if (abs === root || abs.startsWith(root + "/")) {
    try {
      fileContent = readFileSync(abs, "utf8");
    } catch {
      fileContent = null;
    }
  }

  if (fileContent === null) {
    if (json) {
      process.stdout.write(
        JSON.stringify({ path, written: false, cardStatus: "shadow", reason: "file not readable" }) +
          "\n",
      );
    } else {
      process.stderr.write(`memory: card upsert skipped '${path}' — file not readable\n`);
    }
    return 1;
  }

  const db = openDb();
  try {
    const rk = repoKey(resolved.canonical);
    const contentHash = sha256(fileContent);
    const loc = countLines(fileContent);
    const symbols = extractFileSymbols(path, fileContent);

    // Mechanical gate → card_status. (No readRoots: onboard files are inside the
    // repo by construction; the source label is "onboard", not a path.)
    const mech = validateMechanical({ path, contentHash, loc, source, fileContent });

    // Model gate → model_status. With no model summary supplied the card is a
    // mechanical-only card (model_status='absent') — still useful for retrieval.
    let modelStatus: ModelStatus = "absent";
    let validationError: string | null = null;
    const hasModel = Boolean(tldr || rolePrimary || roleTags.length > 0);
    if (hasModel) {
      const mv = validateModel({ path, tldr, rolePrimary, roleTags, symbols, fileContent });
      modelStatus = mv.modelStatus;
      validationError = mv.validationError;
    }

    const card = upsertFileCard(db, {
      repoKey: rk,
      repo: resolved.repo,
      path,
      contentHash,
      loc,
      symbols,
      ...(syncedCommit ? { syncedCommit } : {}),
      source,
      ...(tldr ? { tldr } : {}),
      ...(rolePrimary ? { rolePrimary } : {}),
      ...(roleTags.length > 0 ? { roleTags } : {}),
      cardStatus: mech.cardStatus,
      modelStatus,
      validatedAt: new Date().toISOString(),
      ...(validationError
        ? { validationError }
        : mech.reasons.length > 0
          ? { validationError: mech.reasons.join("; ") }
          : {}),
      ...(model ? { model } : {}),
      ...(promptVersion ? { promptVersion } : {}),
    });

    if (json) {
      process.stdout.write(
        JSON.stringify({
          path: card.path,
          written: true,
          cardStatus: card.cardStatus,
          modelStatus: card.modelStatus,
          symbols: symbols.length,
          ...(validationError ? { validationError } : {}),
        }) + "\n",
      );
    } else {
      process.stdout.write(
        `card upsert ${card.path} [card=${card.cardStatus} model=${card.modelStatus}] (${symbols.length} symbols)\n`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

// ── card sync (watermark) ─────────────────────────────────────────────

/**
 * `memory card sync --canonical <c> --repo <r> --commit <sha> [--json]`
 *
 * Record the repo's card-set watermark (the commit the cards were built from)
 * via setWatermark. Called once at the end of an onboard card pass.
 */
export async function cmdCardSync(args: ReturnType<typeof parseArgs>): Promise<number> {
  const resolved = resolveRepoArgs(args, "card sync");
  if (!resolved) return 2;

  const commit = getString(args.flags, "commit");
  if (!commit) {
    process.stderr.write("memory: card sync requires --commit <sha>\n");
    return 2;
  }

  const db = openDb();
  try {
    const sync = setWatermark(db, repoKey(resolved.canonical), resolved.repo, commit);
    if (getBool(args.flags, "json")) {
      process.stdout.write(JSON.stringify({ ok: true, sync }) + "\n");
    } else {
      process.stdout.write(`card watermark for ${sync.repo} set to ${sync.syncedCommit}\n`);
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
 *   upsert  --canonical <c> --repo <r> --repo-root <abs> --path <rel> [model fields]
 *   sync    --canonical <c> --repo <r> --commit <sha>
 */
export async function cmdCard(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  if (sub === "get") return await cmdCardGet(args);
  if (sub === "search") return await cmdCardSearch(args);
  if (sub === "upsert") return await cmdCardUpsert(args);
  if (sub === "sync") return await cmdCardSync(args);
  process.stderr.write(
    "memory: card requires a subcommand — `memory card get|search|upsert|sync`\n",
  );
  return 2;
}
