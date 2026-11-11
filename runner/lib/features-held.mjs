#!/usr/bin/env node
// runner/lib/features-held.mjs: the "features held" lines of `gaffer status` (status.sh).
//
// A feature of the memory ledger ships only when every ticket of it has landed (external
// review 17). One whose remaining work is a failed or blocked ticket, a stray ticket
// carrying its Feature-Id outside its epic, or whose epic names two features, stays in
// `building`; this prints one line per such feature (who holds it and why, from
// Dispatch's `hold`), at most MAX lines and then a count.
//
// Cost: one memory CLI read of the building features and ONE Dispatch call for all of
// them (`wg epic feature-status --batch`). Prints nothing when there is no memory
// database (and never creates one) or nothing is building. Never fails status: when
// memory or Dispatch cannot be read it prints one "unknown" line, and it always exits 0.
// Inputs (env, as factory.config.sh sets them): MEMORY_DB, DISPATCH_DB, MEMORY_CLI_BIN,
// DISPATCH_DIR.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const MAX = 5;
const TIMEOUT_MS = 15000;

function run(script, args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env,
    timeout: TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function main() {
  const memoryDb = process.env.MEMORY_DB || "";
  const dispatchDb = process.env.DISPATCH_DB || "";
  if (!memoryDb || !existsSync(memoryDb)) return [];
  const memoryCli = process.env.MEMORY_CLI_BIN || "";
  const dispatchCli = resolve(process.env.DISPATCH_DIR || "", "dist", "cli", "index.js");

  const mem = run(memoryCli, ["features", "--all", "--status", "building", "--json"], {
    ...process.env,
    MEMORY_DB: memoryDb,
  });
  let rows;
  try {
    rows = mem.status === 0 ? JSON.parse(mem.stdout) : null;
  } catch {
    rows = null;
  }
  if (!Array.isArray(rows)) return ["unknown: the memory ledger could not be read"];
  rows = rows.filter((r) => r && typeof r.id === "string" && r.id.trim());
  if (rows.length === 0) return [];
  // The default reads the factory db; never let a `--db` on a missing file create one.
  if (!dispatchDb || !existsSync(dispatchDb)) return ["unknown: no Dispatch database to ask"];

  const res = run(dispatchCli, [
    "--db",
    dispatchDb,
    "epic",
    "feature-status",
    "--batch",
    ...rows.map((r) => r.id),
  ]);
  let answers;
  try {
    answers = res.status === 0 ? JSON.parse(res.stdout) : null;
  } catch {
    answers = null;
  }
  if (!Array.isArray(answers) || answers.length !== rows.length) {
    return [`unknown: Dispatch could not be read for ${rows.length} building feature(s)`];
  }
  const held = [];
  rows.forEach((r, i) => {
    const a = answers[i];
    const hold = a && a.feature_id === r.id && a.hold && typeof a.hold === "object" ? a.hold : null;
    if (hold) held.push({ row: r, reason: String(hold.reason ?? "").replace(/\s+/g, " ") });
  });
  const lines = held
    .slice(0, MAX)
    .map(
      ({ row, reason }) =>
        `${String(row.name ?? "").slice(0, 48)} (${row.repo ?? "?"}, ${row.id}): ${reason}`,
    );
  if (held.length > MAX) {
    lines.push(
      `and ${held.length - MAX} more (gaffer wg epic feature-status <id> shows one feature's tickets)`,
    );
  }
  return lines;
}

function safeMain() {
  try {
    return main();
  } catch {
    return ["unknown: the feature check failed"];
  }
}

const out = safeMain();
if (out.length > 0) process.stdout.write(out.join("\n") + "\n");
process.exit(0);
