/**
 * Read-only query commands: search, show, list, tags, repos, export.
 * These are the most frequently used commands and share no mutable state.
 */
import { chmodSync, writeFileSync } from "node:fs";

import {
  exportLore,
  getLore,
  listRecent,
  listRepos,
  listTags,
  searchLore,
  searchLoreCount,
} from "../../core/lore.js";
import { openDb } from "../../db/index.js";
import { LORE_KINDS } from "../../db/types.js";
import type { LoreKind } from "../../db/types.js";
import { getBool, getString, getStringArray } from "../args.js";
import type { parseArgs } from "../args.js";
import { renderFull, renderSummary } from "../format.js";

function parseLimit(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new Error(`invalid --limit: ${v} (must be an integer between 1 and 50)`);
  }
  return n;
}

const LORE_KIND_SET = new Set<string>(LORE_KINDS);

/**
 * Parse a repeatable/comma-separated `--kind` filter into a validated
 * {@link LoreKind} list. `--kind decision,requirement` and `--kind decision
 * --kind requirement` are equivalent. An unknown kind fails fast with a typed
 * message rather than silently matching nothing. Returns undefined when the
 * flag is absent (no kind constraint).
 */
function parseKinds(args: ReturnType<typeof parseArgs>): LoreKind[] | undefined {
  const raw = getStringArray(args.flags, "kind").flatMap((v) => v.split(","));
  const kinds = Array.from(new Set(raw.map((k) => k.trim()).filter(Boolean)));
  if (kinds.length === 0) return undefined;
  for (const k of kinds) {
    if (!LORE_KIND_SET.has(k)) {
      throw new Error(`invalid --kind: ${k} (must be one of ${LORE_KINDS.join(", ")})`);
    }
  }
  return kinds as LoreKind[];
}

export async function cmdSearch(args: ReturnType<typeof parseArgs>): Promise<number> {
  const query = args.positionals.join(" ").trim() || undefined;
  const repo = getString(args.flags, "repo");
  // --tag is repeatable: multiple --tag values become an ANY-of filter.
  const tagList = getStringArray(args.flags, "tag");
  const tag: string | string[] | undefined =
    tagList.length === 0 ? undefined : tagList.length === 1 ? tagList[0] : tagList;
  // Accept either spelling; `--updated-after` is canonical, `--since` is kept
  // as a friendly alias.
  const updatedAfter = getString(args.flags, "updated-after") ?? getString(args.flags, "since");
  const limit = parseLimit(getString(args.flags, "limit")) ?? 10;
  const includeDrafts = getBool(args.flags, "include-drafts");
  const includeDeprecated = getBool(args.flags, "include-deprecated");
  const includeSuperseded = getBool(args.flags, "include-superseded");
  const includeRestricted = getBool(args.flags, "include-restricted");
  const prefix = getBool(args.flags, "prefix");
  const kind = parseKinds(args);
  const json = getBool(args.flags, "json");
  const db = openDb();
  try {
    const searchOpts = {
      query,
      repo,
      tag,
      ...(kind ? { kind } : {}),
      prefix,
      updatedAfter,
      limit,
      includeDrafts,
      includeDeprecated,
      includeSuperseded,
      includeRestricted,
    };
    const hits = searchLore(db, searchOpts);
    // --json: emit a compact, machine-readable array (id/title/summary/kind +
    // trust metadata). Always valid JSON — an empty result is `[]`, never a
    // human-facing "no matches" string — so programmatic callers (e.g. the
    // runner's product-context primer) can parse fail-soft.
    if (json) {
      process.stdout.write(
        JSON.stringify(
          hits.map((h) => ({
            id: h.id,
            title: h.title,
            summary: h.summary,
            kind: h.kind,
            confidence: h.confidence,
            stale: h.stale,
          })),
        ) + "\n",
      );
      return 0;
    }
    if (hits.length === 0) {
      process.stdout.write("memory: no matches\n");
      return 0;
    }
    for (const h of hits) {
      process.stdout.write(renderSummary(h) + "\n\n");
    }
    // Tell the human when the list was capped so they can narrow or
    // raise --limit rather than assume they've seen everything. Only
    // query the count when we actually hit the cap.
    if (hits.length >= limit) {
      const total = searchLoreCount(db, searchOpts);
      if (total > hits.length) {
        process.stdout.write(
          `memory: showing ${hits.length} of ${total} matches — narrow the query, add --repo/--tag, or raise --limit (max 50).\n`,
        );
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdShow(args: ReturnType<typeof parseArgs>): Promise<number> {
  const id = args.positionals[0];
  if (!id) {
    process.stderr.write("memory: show <id> requires an id\n");
    return 2;
  }
  const db = openDb();
  try {
    const lore = getLore(db, id);
    if (!lore) {
      process.stderr.write(`memory: no record with id ${id}\n`);
      return 1;
    }
    process.stdout.write(renderFull(lore) + "\n");
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdList(): Promise<number> {
  const db = openDb();
  try {
    const hits = listRecent(db, 50);
    if (hits.length === 0) {
      process.stdout.write("memory: nothing here yet — try `memory add`.\n");
      return 0;
    }
    for (const h of hits) process.stdout.write(renderSummary(h) + "\n\n");
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdTags(): Promise<number> {
  const db = openDb();
  try {
    const ts = listTags(db);
    if (ts.length === 0) {
      process.stdout.write("memory: no tags yet\n");
      return 0;
    }
    process.stdout.write(ts.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdRepos(): Promise<number> {
  const db = openDb();
  try {
    const rs = listRepos(db);
    if (rs.length === 0) {
      process.stdout.write("memory: no repos yet\n");
      return 0;
    }
    process.stdout.write(rs.join("\n") + "\n");
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdExport(args: ReturnType<typeof parseArgs>): Promise<number> {
  const out = getString(args.flags, "out");
  const includeDrafts = getBool(args.flags, "include-drafts");
  const includeDeprecated = getBool(args.flags, "include-deprecated");
  const includeSuperseded = getBool(args.flags, "include-superseded");
  const includeRestricted = getBool(args.flags, "include-restricted");
  const db = openDb();
  try {
    const records = exportLore(db, {
      includeDrafts,
      includeDeprecated,
      includeSuperseded,
      includeRestricted,
    });
    const envelope = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      records,
    };
    const json = JSON.stringify(envelope, null, 2) + "\n";
    if (out) {
      writeFileSync(out, json, { encoding: "utf8" });
      try {
        chmodSync(out, 0o600);
      } catch {
        // best-effort: some filesystems (e.g. Windows under WSL) can't chmod
      }
      process.stdout.write(`memory: exported ${records.length} record(s) to ${out}\n`);
    } else {
      process.stdout.write(json);
    }
    return 0;
  } finally {
    db.close();
  }
}
