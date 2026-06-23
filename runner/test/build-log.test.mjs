#!/usr/bin/env node
// =====================================================================
// PROVENANCE BUILD-LOG generator (bin/build-log.mjs + lib/build-log.mjs).
// ---------------------------------------------------------------------
// Proves, with Dispatch access STUBBED (BUILDLOG_LIST_CMD / BUILDLOG_SHOW_CMD,
// mirroring run-summary.sh's SUMMARY_* seam) and a SYNTHETIC usage ledger +
// safety-blocks file, that the generator renders the factory's own delivery
// history honestly:
//   AC1  every delivered (done) ticket appears — number + title
//   AC2  the review outcome + a one-line evidence summary are shown per ticket
//   AC3  a ticket WITH a measured usage row shows its tokens, relayed verbatim
//   AC4  a ticket WITHOUT a usage row shows `usage: unknown` (NEVER 0, never blank)
//   AC5  NO fabricated cost — the only $ figure is the ledger's own total_cost_usd…
//   AC6  …and any cost shown carries the "API-equivalent (Claude Code's own figure)" label
//   AC7  a ticket with ONLY an unknown (measured:false) ledger row still reads `unknown`
//   AC8  safety-hook blocks during a ticket are noted (optional section)
//   AC9  the real CLI (`node bin/build-log.mjs`) runs end-to-end over the stubs
//        and honours `--out <path>` (Markdown to a file)
//   AC10 `node --check` passes on both new files (syntax gate)
//
// Zero deps. No live `wg`, no live `claude`. Run: node test/build-log.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const CLI = resolve(RUNNER_DIR, "bin", "build-log.mjs");
const LIB = resolve(RUNNER_DIR, "lib", "build-log.mjs");

const {
  parseTicketList,
  indexUsageByTicket,
  indexBlocksByTicket,
  extractReviewOutcome,
  extractEvidenceSummary,
  COST_LABEL,
  UNKNOWN,
} = await import(LIB);
const { generateBuildLog } = await import(CLI);

let passed = 0;
const failures = [];
function ok(label) {
  passed += 1;
  console.log(`  ok   ${label}`);
}
function fail(label) {
  failures.push(label);
  console.log(`  FAIL ${label}`);
}
function assert(label, cond) {
  cond ? ok(label) : fail(label);
}

const WORK = mkdtempSync(resolve(tmpdir(), "build-log-test-"));

// --- Stub `ticket list -s <status>` and `ticket show <ref>` ----------------------
// Two DONE tickets:
//   #101  has a measured usage row → tokens shown
//   #102  has NO usage row at all  → usage: unknown (NEVER 0)
// (Plus #103 used by the unit-level "only-unknown row" assertion below.)
const listScript = `#!/usr/bin/env bash
case "$1" in
  done) echo '[{"number":101,"title":"Add provenance build-log"},{"number":102,"title":"Wire safety hook"}]' ;;
  *) echo '[]' ;;
esac
`;
const showScript = `#!/usr/bin/env bash
case "$1" in
  101) echo '{"ticket":{"number":101,"title":"Add provenance build-log","state":"done"},"evidence":[{"type":"diff_summary","summary":"bin/build-log.mjs +210 / test +180 — smallest-change: new files only"}],"events":[{"summary":"review approve 101 — approved by human"}]}' ;;
  102) echo '{"ticket":{"number":102,"title":"Wire safety hook","state":"done"},"evidence":[{"type":"manual_note","summary":"merged: gaffer_auto_merge clean into main"}],"events":[]}' ;;
  *) echo '{"ticket":{"title":"x"},"evidence":[],"events":[]}' ;;
esac
`;
const listPath = resolve(WORK, "list.sh");
const showPath = resolve(WORK, "show.sh");
writeFileSync(listPath, listScript);
writeFileSync(showPath, showScript);
chmodSync(listPath, 0o755);
chmodSync(showPath, 0o755);

// --- Synthetic usage ledger (keyed by ticket) ------------------------------------
// #101: a MEASURED row with real tokens + a relayed total_cost_usd.
// #102: NO row (delivered, but unmeasured → must read "unknown").
// #103: ONLY an unknown (measured:false) row → must also read "unknown".
const usageLedger = [
  JSON.stringify({
    ts: "2026-06-20T10:00:00.000Z",
    ticket: 101,
    kind: "delivery",
    measured: true,
    models: {
      "claude-opus-4": {
        input: 1200,
        output: 3400,
        cache_read: 500,
        cache_create: 90,
        cost_usd: 0.123,
      },
      "claude-sonnet-4": {
        input: 800,
        output: 1600,
        cache_read: 0,
        cache_create: 0,
        cost_usd: 0.045,
      },
    },
    total_cost_usd: 0.168,
    num_turns: 9,
    duration_ms: 42000,
  }),
  JSON.stringify({
    ts: "2026-06-20T11:00:00.000Z",
    ticket: 103,
    kind: "delivery",
    measured: false,
    unknown_reason: "claude call timed out (rc=124)",
    models: UNKNOWN,
    total_cost_usd: UNKNOWN,
  }),
].join("\n");
const usagePath = resolve(WORK, "usage-ledger.jsonl");
writeFileSync(usagePath, usageLedger + "\n");

// --- Synthetic safety-blocks file (keyed by ticket) ------------------------------
const blocksLedger = [
  JSON.stringify({ ts: "2026-06-20T10:05:00.000Z", ticket: 101, category: "secret-read" }),
  JSON.stringify({ ts: "2026-06-20T10:06:00.000Z", ticket: 101, category: "network-egress" }),
].join("\n");
const blocksPath = resolve(WORK, "safety-blocks.jsonl");
writeFileSync(blocksPath, blocksLedger + "\n");

// =====================================================================
// Library-level unit assertions
// =====================================================================
console.log("== unit: parse + index helpers ==");
const tickets = parseTicketList(
  JSON.parse(spawnSync("bash", [listPath, "done"], { encoding: "utf8" }).stdout),
);
assert("AC1 done list parses 2 delivered tickets", tickets.length === 2);
assert(
  "AC1 ticket numbers + titles preserved",
  tickets[0].number === 101 &&
    tickets[0].title === "Add provenance build-log" &&
    tickets[1].number === 102,
);

const usageByTicket = indexUsageByTicket(usageLedger);
assert("AC3 ticket #101 indexed as measured", usageByTicket.get("101")?.measured === true);
assert(
  "AC3 #101 tokens summed verbatim (in=2000 out=5000)",
  usageByTicket.get("101").tokens.in === 2000 && usageByTicket.get("101").tokens.out === 5000,
);
assert(
  "AC5 #101 cost relayed verbatim (0.168), not computed",
  usageByTicket.get("101").cost_usd === 0.168,
);
assert(
  "AC7 #103 only-unknown row indexes as NOT measured",
  usageByTicket.get("103")?.measured === false,
);
assert("AC4 #102 absent from usage index (no row at all)", usageByTicket.get("102") === undefined);

const blocksByTicket = indexBlocksByTicket(blocksLedger);
assert("AC8 #101 has 2 safety-hook blocks indexed", (blocksByTicket.get("101") || []).length === 2);

console.log("== unit: review outcome + evidence extraction ==");
const show101 = JSON.parse(spawnSync("bash", [showPath, "101"], { encoding: "utf8" }).stdout);
assert(
  "AC2 #101 review outcome detected as approved",
  extractReviewOutcome(show101) === "approved",
);
assert(
  "AC2 #101 evidence summary is the diff_summary, one line",
  extractEvidenceSummary(show101).includes("bin/build-log.mjs") &&
    !extractEvidenceSummary(show101).includes("\n"),
);
const show102 = JSON.parse(spawnSync("bash", [showPath, "102"], { encoding: "utf8" }).stdout);
assert("AC2 #102 review outcome detected as merged", extractReviewOutcome(show102) === "merged");

// =====================================================================
// Render-level assertions (generateBuildLog over the stubs)
// =====================================================================
console.log("== render: full build-log over stubs ==");
const md = generateBuildLog({
  env: {
    BUILDLOG_LIST_CMD: `bash ${listPath}`,
    BUILDLOG_SHOW_CMD: `bash ${showPath}`,
    GAFFER_USAGE_LEDGER: usagePath,
    GAFFER_BLOCK_LEDGER: blocksPath,
  },
  generatedAt: "2026-06-20T12:00:00.000Z",
});

assert(
  "AC1 build-log lists ticket #101",
  md.includes("#101") && md.includes("Add provenance build-log"),
);
assert("AC1 build-log lists ticket #102", md.includes("#102") && md.includes("Wire safety hook"));
assert("AC2 review outcome 'approved' shown for #101", /#101[^\n]*approved/.test(md));
assert("AC2 evidence summary shown for #101", md.includes("bin/build-log.mjs"));

// AC3: #101 shows its measured tokens, verbatim.
assert("AC3 #101 shows measured tokens (in=2000 out=5000)", /#101[^\n]*in=2000 out=5000/.test(md));

// AC4: #102 (no usage row) shows usage: unknown — NEVER 0, never blank.
const row102 = md.split("\n").find((l) => l.includes("#102"));
assert("AC4 #102 row exists despite no usage row (delivered)", !!row102);
assert("AC4 #102 usage cell is 'unknown'", !!row102 && row102.includes(UNKNOWN));
assert(
  "AC4 #102 usage cell is NOT '0' and not blank",
  !!row102 && !/in=0 out=0/.test(row102) && !/\|\s*\|\s*$/.test(row102),
);

// AC5/AC6: cost honesty — only the relayed figure, with the API-equivalent label.
assert("AC6 cost shown carries the API-equivalent label", md.includes(COST_LABEL));
assert("AC5 relayed cost figure $0.1680 present (from total_cost_usd)", md.includes("$0.1680"));
// No fabricated cost: the ONLY dollar amounts in the doc must be the relayed 0.1680.
const dollarFigures = (md.match(/\$[0-9]+\.[0-9]+/g) || []).filter((s) => s !== "$0.1680");
assert(
  "AC5 no fabricated/computed cost figures beyond the relayed one",
  dollarFigures.length === 0,
);
// And specifically never a "$0.00"-style free-implying figure.
assert("AC5 no $0 cost anywhere (would imply 'free')", !/\$0\.0+\b/.test(md));

// AC8: safety-hook blocks during #101 are noted.
assert("AC8 safety-hook block section present", md.includes("Safety-hook blocks during delivery"));
assert(
  "AC8 #101 secret-read block noted",
  /#101[\s\S]*secret-read/.test(md.split("Safety-hook")[1] || ""),
);

// =====================================================================
// CLI end-to-end (real subprocess) — AC9
// =====================================================================
console.log("== cli: end-to-end with --out ==");
const outFile = resolve(WORK, "BUILD-LOG.md");
const cli = spawnSync("node", [CLI, "--out", outFile], {
  encoding: "utf8",
  env: {
    ...process.env,
    BUILDLOG_LIST_CMD: `bash ${listPath}`,
    BUILDLOG_SHOW_CMD: `bash ${showPath}`,
    GAFFER_USAGE_LEDGER: usagePath,
    GAFFER_BLOCK_LEDGER: blocksPath,
  },
});
assert("AC9 CLI exits 0", cli.status === 0);
assert("AC9 --out wrote the file", existsSync(outFile));
const fileMd = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
assert("AC9 file contains #101 + #102", fileMd.includes("#101") && fileMd.includes("#102"));
assert("AC9 file is honest about cost label", fileMd.includes(COST_LABEL));
assert(
  "AC9 file shows 'unknown' for #102",
  (fileMd.split("\n").find((l) => l.includes("#102")) || "").includes(UNKNOWN),
);

// CLI to stdout (no --out) also works.
const cliStdout = spawnSync("node", [CLI], {
  encoding: "utf8",
  env: {
    ...process.env,
    BUILDLOG_LIST_CMD: `bash ${listPath}`,
    BUILDLOG_SHOW_CMD: `bash ${showPath}`,
    GAFFER_USAGE_LEDGER: usagePath,
    GAFFER_BLOCK_LEDGER: blocksPath,
  },
});
assert(
  "AC9 CLI to stdout exits 0 and emits Markdown",
  cliStdout.status === 0 && cliStdout.stdout.includes("# Gaffer factory — provenance build-log"),
);

// Empty-history case: no done tickets → graceful, honest message (no crash).
const emptyList = resolve(WORK, "empty-list.sh");
writeFileSync(emptyList, "#!/usr/bin/env bash\necho '[]'\n");
chmodSync(emptyList, 0o755);
const mdEmpty = generateBuildLog({
  env: { BUILDLOG_LIST_CMD: `bash ${emptyList}`, BUILDLOG_SHOW_CMD: `bash ${showPath}` },
  generatedAt: "2026-06-20T12:00:00.000Z",
});
assert(
  "empty history renders 'No delivered tickets' (no crash)",
  mdEmpty.includes("No delivered tickets"),
);

// =====================================================================
// AC10: node --check syntax gate on both new files.
// =====================================================================
console.log("== syntax: node --check ==");
for (const f of [CLI, LIB]) {
  const chk = spawnSync("node", ["--check", f], { encoding: "utf8" });
  assert(`AC10 node --check ${f.split("/").slice(-2).join("/")}`, chk.status === 0);
}

// =====================================================================
console.log("");
if (failures.length) {
  console.log(`FAILED ${failures.length} / ${passed + failures.length}`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`PASSED ${passed} assertion(s)`);
