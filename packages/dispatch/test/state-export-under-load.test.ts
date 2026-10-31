import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import { openDatabase } from "../src/db/connection.js";
import {
  exportState,
  importState,
  verifyBundleRestores,
  type StateBundle,
} from "../src/io/stateExport.js";
import { DispatchError } from "../src/util/errors.js";

// ---------------------------------------------------------------------------
// Restore under load (third external review, HIGH recovery).
//
// `dispatch export` read each table in its own implicit transaction. While another
// process created epics, the export picked up dependency rows for tickets it had
// read before they existed, reported success, and its own importer rejected the
// untouched file with dangling references. The export now reads every table from ONE
// read transaction and proves the bundle restores before it reports success.
//
// The writer here is a separate PROCESS on the same SQLite file (as the runner, API
// and MCP server are in production), creating three-ticket epics with dependencies
// and acceptance criteria in a tight loop for the whole test.
// ---------------------------------------------------------------------------

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const EPIC_INPUT = (i: number | string): unknown => ({
  epic: { name: `E${i}`, description: "d" },
  tickets: [
    { title: `a${i}`, description: "a", acceptanceCriteria: ["x"] },
    { title: `b${i}`, description: "b", acceptanceCriteria: ["y"], dependsOn: [0] },
    { title: `c${i}`, description: "c", acceptanceCriteria: ["z"], dependsOn: [0, 1] },
  ],
});

/** Rows ONE epic adds to each table, measured by creating one on a quiet database. */
function rowsPerEpic(): Record<"tickets" | "acceptance_criteria" | "ticket_dependencies", number> {
  const wg = Dispatch.open(":memory:");
  try {
    wg.createEpic(EPIC_INPUT(0), { type: "human", id: "probe" });
    const count = (t: string): number =>
      (wg.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(count("scope_nodes")).toBe(1);
    return {
      tickets: count("tickets"),
      acceptance_criteria: count("acceptance_criteria"),
      ticket_dependencies: count("ticket_dependencies"),
    };
  } finally {
    wg.db.close();
  }
}

/** Start a writer process creating epics in `file` until `stopFile` exists. */
async function startWriter(file: string, stopFile: string): Promise<ChildProcess> {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-export-writer-"));
  dirs.push(dir);
  const child = join(dir, "writer.mts");
  const core = resolve(__dirname, "../src/core.ts");
  writeFileSync(
    child,
    `import { existsSync } from "node:fs";
import { Dispatch } from ${JSON.stringify(core)};
const [file, stop] = process.argv.slice(2);
const template = ${JSON.stringify(JSON.stringify(EPIC_INPUT("@")))};
const epicInput = (i) => JSON.parse(template.replaceAll("@", String(i)));
const wg = Dispatch.open(file);
const human = { type: "human", id: "writer" };
const deadline = Date.now() + 60_000;
const maxEpics = 1500;
const pause = new Int32Array(new SharedArrayBuffer(4));
let i = 0;
while (!existsSync(stop) && Date.now() < deadline && i < maxEpics) {
  wg.createEpic(epicInput(i), human);
  if (i === 2) console.log("writing");
  i++;
  // A short breath (and the cap above) keeps the board small enough to export and
  // restore-check dozens of times quickly, while still committing epics during exports.
  Atomics.wait(pause, 0, 0, 3);
}
wg.db.close();
`,
  );
  const p = spawn(process.execPath, ["--import", "tsx", child, file, stopFile], {
    cwd: resolve(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(p);
  let err = "";
  p.stderr?.on("data", (d: Buffer) => (err += d.toString()));
  let out = "";
  await new Promise<void>((ready, fail) => {
    p.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("writing")) ready();
    });
    p.on("exit", (code) => fail(new Error(`writer exited early (${code}): ${err}`)));
  });
  return p;
}

/** Every reference the bundle carries resolves inside the bundle itself. */
function danglingReferences(bundle: StateBundle): number {
  const ticketIds = new Set(bundle.tables["tickets"]!.map((t) => t["id"]));
  const nodeIds = new Set(bundle.tables["scope_nodes"]!.map((n) => n["id"]));
  let dangling = 0;
  for (const d of bundle.tables["ticket_dependencies"]!) {
    if (!ticketIds.has(d["ticket_id"]) || !ticketIds.has(d["depends_on_ticket_id"])) dangling++;
  }
  for (const ac of bundle.tables["acceptance_criteria"]!) {
    if (!ticketIds.has(ac["ticket_id"])) dangling++;
  }
  for (const link of bundle.tables["ticket_scope_nodes"]!) {
    if (!ticketIds.has(link["ticket_id"]) || !nodeIds.has(link["scope_node_id"])) dangling++;
  }
  return dangling;
}

describe("dispatch export under a concurrent writer", () => {
  it("every export is one consistent snapshot that restores cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dispatch-export-load-"));
    dirs.push(dir);
    const file = join(dir, "src.sqlite");
    const stopFile = join(dir, "stop");
    openDatabase(file).close();
    const per = rowsPerEpic();
    const writer = await startWriter(file, stopFile);

    const reader = openDatabase(file);
    const epicsSeen: number[] = [];
    let last: StateBundle | undefined;
    try {
      for (let n = 0; n < 40; n++) {
        if (writer.exitCode !== null) break;
        const bundle = exportState(reader);
        const epics = bundle.tables["scope_nodes"]!.length;
        epicsSeen.push(epics);
        // A consistent snapshot holds whole epics only: each createEpic commits its
        // scope node, tickets, ACs and dependencies in one transaction.
        expect(danglingReferences(bundle)).toBe(0);
        expect(bundle.tables["tickets"]!.length).toBe(epics * per.tickets);
        expect(bundle.tables["acceptance_criteria"]!.length).toBe(epics * per.acceptance_criteria);
        expect(bundle.tables["ticket_dependencies"]!.length).toBe(epics * per.ticket_dependencies);
        // The exporter's own restore check (the importer, into a scratch DB) passes.
        const verified = verifyBundleRestores(bundle);
        expect(verified.byTable["tickets"]).toBe(epics * per.tickets);
        last = bundle;
        // Let the writer land more epics between exports.
        await new Promise((r) => setTimeout(r, 15));
      }
    } finally {
      reader.close();
      writeFileSync(stopFile, "");
      await new Promise<void>((done) => {
        if (writer.exitCode !== null) done();
        else writer.on("exit", () => done());
      });
    }
    // The writer really was writing during the exports (not a quiet database).
    expect(epicsSeen.length).toBeGreaterThanOrEqual(10);
    expect(epicsSeen[epicsSeen.length - 1]!).toBeGreaterThan(epicsSeen[0]!);
    expect(existsSync(stopFile)).toBe(true);

    // A real restore of the last snapshot into a fresh database: no dangling
    // references, and every table holds exactly what the snapshot held.
    const dst = openDatabase(":memory:");
    try {
      const restored = importState(dst, last!);
      expect(dst.pragma("foreign_key_check")).toEqual([]);
      for (const [table, rows] of Object.entries(last!.tables)) {
        expect(restored.byTable[table]).toBe(rows.length);
        const n = (dst.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
        expect(n).toBe(rows.length);
      }
    } finally {
      dst.close();
    }
  }, 90_000);

  it("refuses to vouch for a bundle the importer would reject", () => {
    const src = openDatabase(":memory:");
    try {
      const bundle = exportState(src);
      const torn: StateBundle = {
        ...bundle,
        tables: {
          ...bundle.tables,
          ticket_dependencies: [
            { ticket_id: "missing-a", depends_on_ticket_id: "missing-b", created_at: "x" },
          ],
        },
      };
      let caught: unknown;
      try {
        verifyBundleRestores(torn);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DispatchError);
      expect((caught as DispatchError).code).toBe("INCONSISTENT_BUNDLE");
      expect((caught as DispatchError).message).toMatch(/restore check.*not written/);
      expect((caught as DispatchError).message).toMatch(/dangling/);
    } finally {
      src.close();
    }
  });
});
