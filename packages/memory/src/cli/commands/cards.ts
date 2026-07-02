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

import {
  deleteFileCard,
  diagnoseRepoKeyMismatch,
  getFileCard,
  getWatermark,
  markCardReviewFailed,
  movableLegacyKeys,
  rekeyRepo,
  repoKey,
  searchFileCards,
  setWatermark,
  upsertFileCard,
} from "../../core/fileCards.js";
import { canonicalizeRepo } from "../../core/repoIdentity.js";
import {
  countLines,
  extractFileSymbols,
  sha256,
  validateMechanical,
  validateModel,
} from "../../core/cardValidation.js";
import { cardsForScope } from "../../core/scopePacket.js";
import { logRecall } from "../../core/recallFeedback.js";
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

    // FAIL LOUD: an empty result when cards exist under a different key is a
    // canonical/key mismatch, not "no cards" — surface it on stderr.
    const diagnostic =
      cards.length === 0
        ? diagnoseRepoKeyMismatch(db, rk, resolved.repo, resolved.canonical)
        : null;
    if (diagnostic) process.stderr.write(`memory: WARN ${diagnostic}\n`);

    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            query,
            repo: resolved.repo,
            count: cards.length,
            cards,
            ...(diagnostic ? { diagnostics: [diagnostic] } : {}),
          },
          null,
          2,
        ) + "\n",
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

    // FAIL LOUD: surface any repo_key-mismatch diagnostics on stderr so the
    // runner log / operator sees them — never let an empty packet pass silently
    // when cards demonstrably exist under a different key.
    for (const d of packet.diagnostics ?? []) {
      process.stderr.write(`memory: WARN ${d}\n`);
    }

    // MEMORY FEEDBACK LOOP — when a ticket id is supplied, record the read-event
    // edge: which items memory SERVED into this ticket's context. The later
    // `recall-feedback` verb reads this log to adjust confidence by outcome.
    // FAIL-SOFT: logging must NEVER break the packet the caller depends on.
    const ticket = getString(args.flags, "ticket");
    if (ticket && ticket.trim()) {
      try {
        logRecall(db, {
          repo: resolved.repo,
          ticket: ticket.trim(),
          loreIds: packet.lore.map((l) => l.id),
          cardIds: packet.cards.map((c) => c.id),
        });
      } catch (err) {
        process.stderr.write(
          `memory: WARN recall-log failed for ticket ${ticket} — ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

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
        JSON.stringify({
          path,
          written: false,
          cardStatus: "shadow",
          reason: "file not readable",
        }) + "\n",
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
      canonical: resolved.canonical,
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
    const sync = setWatermark(
      db,
      repoKey(resolved.canonical),
      resolved.repo,
      commit,
      resolved.canonical,
    );
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

// ── delete-file-card ────────────────────────────────────────────────────

/**
 * `memory delete-file-card --canonical <c> --repo <r> --path <p> [--json]`
 *
 * Hard-delete one file card (row + FTS entry) so a DELETED or RENAMED-away
 * file no longer leaves a stale card behind. The Runner calls this via the
 * memory CLI during incremental card refresh — it must NEVER reach into
 * Memory's DB directly (boundary rule).
 *
 * A no-op delete (no card for the path) is reported as ok=true, deleted=false
 * and still exits 0: the caller's intent (no card should exist) is satisfied.
 */
export async function cmdDeleteFileCard(args: ReturnType<typeof parseArgs>): Promise<number> {
  const resolved = resolveRepoArgs(args, "delete-file-card");
  if (!resolved) return 2;

  const path = getString(args.flags, "path");
  if (!path) {
    process.stderr.write("memory: delete-file-card requires --path <file-path>\n");
    return 2;
  }

  const json = getBool(args.flags, "json");
  const db = openDb();
  try {
    const rk = repoKey(resolved.canonical);
    const deleted = deleteFileCard(db, rk, path);

    if (json) {
      process.stdout.write(JSON.stringify({ ok: true, path, deleted }) + "\n");
    } else if (deleted) {
      process.stdout.write(`delete-file-card: ${path} removed (card + FTS)\n`);
    } else {
      process.stdout.write(`delete-file-card: ${path} had no card — nothing to remove\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}

// ── get-card-watermark ──────────────────────────────────────────────────

/**
 * `memory get-card-watermark --canonical <c> --repo <r> [--json]`
 *
 * Read-only fetch of the repo's card-set watermark (repo_sync.synced_commit)
 * via getWatermark. This is the CLI seam the Runner uses INSTEAD of reading
 * Memory's SQLite directly — Memory owns its DB; callers go through the CLI.
 *
 * With --json prints `{ syncedCommit: <sha|null> }`; human-readable otherwise.
 * Exits 0 even when no watermark exists yet (syncedCommit=null) — absence is a
 * valid answer, not an error.
 */
export async function cmdGetCardWatermark(args: ReturnType<typeof parseArgs>): Promise<number> {
  const resolved = resolveRepoArgs(args, "get-card-watermark");
  if (!resolved) return 2;

  const json = getBool(args.flags, "json");
  const db = openDb();
  try {
    const rk = repoKey(resolved.canonical);
    const sync = getWatermark(db, rk);
    const syncedCommit = sync?.syncedCommit ?? null;

    if (json) {
      process.stdout.write(JSON.stringify({ syncedCommit }) + "\n");
    } else if (syncedCommit) {
      process.stdout.write(`${syncedCommit}\n`);
    } else {
      process.stdout.write("(no card watermark recorded for this repo)\n");
    }
    return 0;
  } finally {
    db.close();
  }
}

// ── card mark-failed ───────────────────────────────────────────────────

/**
 * `memory card mark-failed --canonical <c> --repo <r> --path <p> --reason <r> [--json]`
 *
 * Downgrade a card's model_status from 'active' to 'failed_validation'
 * after a semantic review pass. Only touches model trust fields; mechanical
 * fields (path, content_hash, loc, symbols) are not modified.
 *
 * Used by onboard-analyze.mjs's review gate. Not intended for interactive use.
 */
export async function cmdCardMarkFailed(args: ReturnType<typeof parseArgs>): Promise<number> {
  const resolved = resolveRepoArgs(args, "card mark-failed");
  if (!resolved) return 2;

  const path = getString(args.flags, "path");
  if (!path) {
    process.stderr.write("memory: card mark-failed requires --path <file-path>\n");
    return 2;
  }
  const reason = getString(args.flags, "reason");
  if (!reason) {
    process.stderr.write("memory: card mark-failed requires --reason <text>\n");
    return 2;
  }

  const json = getBool(args.flags, "json");
  const db = openDb();
  try {
    const rk = repoKey(resolved.canonical);
    const changed = markCardReviewFailed(db, rk, path, reason);

    if (json) {
      process.stdout.write(JSON.stringify({ path, changed, reason }) + "\n");
    } else {
      if (changed) {
        process.stdout.write(`card mark-failed: ${path} downgraded to failed_validation\n`);
      } else {
        process.stdout.write(
          `card mark-failed: ${path} not updated (not found or not model_status=active)\n`,
        );
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
 *   get          --canonical <c> --repo <r> --path <p>
 *   search       --canonical <c> --repo <r> --query <q>
 *   upsert       --canonical <c> --repo <r> --repo-root <abs> --path <rel> [model fields]
 *   sync         --canonical <c> --repo <r> --commit <sha>
 *   mark-failed  --canonical <c> --repo <r> --path <p> --reason <r>
 */
export async function cmdCard(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  if (sub === "get") return await cmdCardGet(args);
  if (sub === "search") return await cmdCardSearch(args);
  if (sub === "upsert") return await cmdCardUpsert(args);
  if (sub === "sync") return await cmdCardSync(args);
  if (sub === "mark-failed") return await cmdCardMarkFailed(args);
  process.stderr.write(
    "memory: card requires a subcommand — `memory card get|search|upsert|sync|mark-failed`\n",
  );
  return 2;
}

// ── repo-canonical ─────────────────────────────────────────────────────

/**
 * `memory repo-canonical --repo-root <abs> [--json]`
 * `memory repo-canonical --canonical <url-or-path> [--json]`
 *
 * Print the NORMALISED canonical for a repo. This is the seam
 * context-primer.sh (and any bash caller) uses so read-time and write-time
 * identity derivation can never drift — the normalisation lives in ONE place
 * (the memory package), not hand-rolled in shell.
 *
 * With --repo-root, derives remote.origin.url (else the realpath) then
 * normalises. With --canonical, just normalises the given string.
 */
export async function cmdRepoCanonical(args: ReturnType<typeof parseArgs>): Promise<number> {
  const explicit = getString(args.flags, "canonical");
  const repoRoot = getString(args.flags, "repo-root");
  const json = getBool(args.flags, "json");

  let raw: string | undefined = explicit;
  if (!raw && repoRoot) {
    // Derive remote.origin.url, else the realpath fallback — the same contract
    // onboard uses. Normalisation then collapses every form to one key.
    const { execFileSync } = await import("node:child_process");
    try {
      raw = execFileSync("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      raw = undefined; // not a git repo / no remote → fall through to path
    }
    if (!raw) {
      // No remote → the realpath fallback. MUST resolve symlinks (realpathSync
      // ≡ the onboard side's repoCanonical and the primer's old `pwd -P`), or
      // the read-time key won't match the write-time key on symlinked paths
      // (e.g. macOS /var → /private/var).
      const { realpathSync } = await import("node:fs");
      try {
        raw = realpathSync(repoRoot);
      } catch {
        raw = resolve(repoRoot);
      }
    }
  }

  if (!raw) {
    process.stderr.write(
      "memory: repo-canonical requires --repo-root <abs> or --canonical <url-or-path>\n",
    );
    return 2;
  }

  const canonical = canonicalizeRepo(raw);
  if (json) {
    process.stdout.write(JSON.stringify({ canonical, key: repoKey(raw) }) + "\n");
  } else {
    process.stdout.write(canonical + "\n");
  }
  return 0;
}

// ── cards rekey ─────────────────────────────────────────────────────────

/**
 * `memory cards rekey --canonical <url-or-path> --repo <name> [--dry-run] [--json]`
 *
 * Re-key every card + watermark for the display name <name> onto the
 * NORMALISED repoKey(canonical). This is the migration for cards onboarded
 * before canonicalisation: their repo_key is an sha256 of an un-normalised
 * URL/path that can't be reversed from the hash — so we re-key from the
 * available signal (the `repo` display name) in ONE transaction, keeping FTS
 * intact. --dry-run reports what WOULD move without writing.
 */
export async function cmdCardsRekey(args: ReturnType<typeof parseArgs>): Promise<number> {
  const resolved = resolveRepoArgs(args, "cards rekey");
  if (!resolved) return 2;

  const dryRun = getBool(args.flags, "dry-run");
  const json = getBool(args.flags, "json");
  const db = openDb();
  try {
    const newKey = repoKey(resolved.canonical);
    const canonical = canonicalizeRepo(resolved.canonical);
    // Scoped by PROVABLE legacy identity (not display name) so the dry-run
    // report matches exactly what a real run would migrate. See rekeyRepo.
    const fromKeys = movableLegacyKeys(db, resolved.repo, resolved.canonical);

    if (dryRun) {
      const wouldMove = fromKeys.reduce((a, b) => a + b.count, 0);
      const out = {
        dryRun: true,
        repo: resolved.repo,
        canonical,
        newKey,
        fromKeys,
        wouldMove,
      };
      if (json) {
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      } else if (fromKeys.length === 0) {
        process.stdout.write(
          `cards rekey (dry-run): '${resolved.repo}' already on key ${newKey.slice(0, 12)}… — nothing to move\n`,
        );
      } else {
        process.stdout.write(
          `cards rekey (dry-run): would move ${wouldMove} card(s) for '${resolved.repo}' to ${newKey.slice(0, 12)}… (canonical '${canonical}')\n` +
            fromKeys.map((k) => `  from ${k.repoKey.slice(0, 12)}… (${k.count})`).join("\n") +
            "\n",
        );
      }
      return 0;
    }

    const result = rekeyRepo(db, resolved.repo, resolved.canonical);
    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else if (result.noop) {
      process.stdout.write(
        `cards rekey: '${result.repo}' already on key ${result.newKey.slice(0, 12)}… — no change\n`,
      );
    } else {
      process.stdout.write(
        `cards rekey: '${result.repo}' → key ${result.newKey.slice(0, 12)}… (canonical '${result.canonical}')\n` +
          `  re-keyed ${result.cardsRekeyed} card(s)` +
          (result.collisionsDropped > 0
            ? `, dropped ${result.collisionsDropped} stale duplicate(s)`
            : "") +
          (result.syncRekeyed ? ", moved watermark" : "") +
          "\n",
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `memory cards <sub>` dispatcher.
 *   rekey  --canonical <c> --repo <r> [--dry-run] [--json]
 */
export async function cmdCards(args: ReturnType<typeof parseArgs>): Promise<number> {
  const sub = args.positionals[0];
  if (sub === "rekey") return await cmdCardsRekey(args);
  process.stderr.write("memory: cards requires a subcommand — `memory cards rekey`\n");
  return 2;
}
