/**
 * BUG B regression — the CLI must not be SILENT at the PROCESS BOUNDARY.
 *
 * cli.test.ts drives `main(argv)` in-process, so it never exercised how the
 * module is ENTERED — which is exactly where the reported failure lived:
 *
 *   node packages/memory/dist/cli/index.js stats --roi   →  printed NOTHING
 *
 * `dist/cli/index.js` is the command router: it exports `main` for the packaged
 * bin (`dist/bin/memory.js`) to import, but when the module file is invoked
 * DIRECTLY it must also RUN `main` — otherwise it defines `main`, never calls it,
 * and exits 0 having printed nothing (true for every command, `stats` /
 * `stats --roi` included). This spawns the built entrypoints for real and asserts
 * non-empty stdout on both an EMPTY db (header, sample 0) and a SEEDED db (rows).
 *
 * Skipped when `dist/` is absent (bare `vitest` with no prior build); it runs in
 * the standard build-then-test flow where the reported command actually lives.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { newLoreId } from "../src/core/ids.js";
import { logRetrieval } from "../src/core/retrievalRoi.js";
import { openDb } from "../src/db/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, "..", "dist");
const ROUTER = join(DIST, "cli", "index.js"); // the reported command's target
const BIN = join(DIST, "bin", "memory.js"); // the packaged entrypoint
const distBuilt = existsSync(ROUTER) && existsSync(BIN);

function runCli(entry: string, db: string, args: string[]): string {
  return execFileSync("node", [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, MEMORY_DB: db, MEMORY_AUDIT_OFF: "1", MEMORY_NO_TELEMETRY: "1" },
  });
}

/** Seed one active lore + one retrieval_event so the ROI report has a row. */
function seed(db: string): string {
  const d = openDb(db);
  try {
    const id = newLoreId();
    const ts = new Date().toISOString();
    d.prepare(
      `INSERT INTO lore (id, title, summary, body, status, confidence, restricted, created_at, updated_at)
       VALUES (?, 'Consulted rule', 's', 'b', 'active', 'medium', 0, ?, ?)`,
    ).run(id, ts, ts);
    logRetrieval(d, {
      repo: "app",
      ticket: "1",
      tool: "search_lore",
      items: [{ type: "lore", id }],
    });
    return id;
  } finally {
    d.close();
  }
}

describe.skipIf(!distBuilt)("CLI entrypoint — never silent at the process boundary (BUG B)", () => {
  const entries: ReadonlyArray<readonly [string, string]> = [
    ["router (node dist/cli/index.js)", ROUTER],
    ["bin (node dist/bin/memory.js)", BIN],
  ];

  for (const [name, entry] of entries) {
    it(`${name}: stats --roi on an EMPTY db prints a header (sample 0), not nothing`, () => {
      const dir = mkdtempSync(join(tmpdir(), "memory-entry-"));
      try {
        const out = runCli(entry, join(dir, "lore.db"), ["stats", "--roi"]);
        expect(out.length).toBeGreaterThan(0);
        expect(out).toMatch(/MEMORY RETRIEVAL ROI/);
        expect(out).toMatch(/sample: 0 tickets/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`${name}: stats --roi on a SEEDED db prints the consulted row`, () => {
      const dir = mkdtempSync(join(tmpdir(), "memory-entry-"));
      try {
        const db = join(dir, "lore.db");
        const id = seed(db);
        const out = runCli(entry, db, ["stats", "--roi"]);
        expect(out.length).toBeGreaterThan(0);
        expect(out).toMatch(/MEMORY RETRIEVAL ROI/);
        expect(out).toContain(id);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(`${name}: plain stats on an EMPTY db still prints its header`, () => {
      const dir = mkdtempSync(join(tmpdir(), "memory-entry-"));
      try {
        const out = runCli(entry, join(dir, "lore.db"), ["stats"]);
        expect(out.length).toBeGreaterThan(0);
        expect(out).toMatch(/Top-cited records/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
