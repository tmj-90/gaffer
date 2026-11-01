#!/usr/bin/env node
// =====================================================================
// REPLAY RECOVERY (external review #8, the unbundled recovery trial).
// ---------------------------------------------------------------------
// Interrupting the merger after git and the landing record succeeded but before the
// tester replay record was written left the epic's acceptance ticket recoverable as done
// while its epic read "unreplayed" for good: a retry skipped the already-landed repo and
// never wrote the record. A retry of an already-landed repo now REGENERATES the missing
// evidence (the tester's files replayed on the revision that landed), or holds with a
// targeted "replay missing: run …" line and leaves the ticket not done.
//   R1 the interrupted merge: landed + landing recorded, no replay record, not done
//   R2 the retry regenerates the replay on the landed revision, marks the ticket done,
//      and the epic reads accepted
//   R3 when the replay cannot be regenerated (the tester's tests are gone), the retry
//      holds: "replay missing: … run `gaffer merge <n>`", exit 4, the ticket not done
//   R4 the merge lane's retry (lib/land.sh, through merge-ticket.mjs --recover-replay)
//      regenerates it the same way, and the ticket is done
//   R5 a tester file that FAILS on the landed revision: the retry holds, not done
// A real repo, the Dispatch core and CLI, the merge runner and the tester runner with a
// local stub model that writes and runs a real node:test file. No network, no model.
// Run: node runner/test/replay-recovery.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { gafferMkdtemp } from "./lib/tmpdir.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const core = join(ROOT, "packages/dispatch/dist/core.js");
const cli = join(ROOT, "packages/dispatch/dist/cli/index.js");
const runner = join(ROOT, "runner/gaffer");
const tester = join(ROOT, "runner/bin/tester-run.mjs");
if (![core, cli].every(existsSync)) {
  console.log("SKIP: build the workspace first");
  process.exit(0);
}
let pass = 0;
const failures = [];
const ok = (cond, msg, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}${detail ? `\n       ${detail}` : ""}`);
  }
};

for (const k of [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
])
  delete process.env[k];

function world(name) {
  const ws = gafferMkdtemp(join(tmpdir(), `replay-recovery-${name}-`));
  const repo = join(ws, "project");
  const data = join(ws, "factory");
  for (const p of [repo, join(repo, "test"), data, join(ws, "home")])
    mkdirSync(p, { recursive: true });
  const stub = join(ws, "tester.sh");
  // A stub model for the tester: writes the acceptance test and runs it for real.
  writeFileSync(
    stub,
    `#!/bin/sh
set -eu
cat >test/acceptance.test.mjs <<'TEST'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { label } from '../label.mjs';
import { existsSync } from 'node:fs';
test('renders the public label', () => {
  assert.equal(existsSync(${JSON.stringify(join(ws, "break-replay"))}), false);
  assert.equal(label(), 'Ada');
});
TEST
node --test >/dev/null
printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"Fixture tests passed\\n{\\"verdict\\":\\"PASS\\"}","total_cost_usd":0,"num_turns":1}'
`,
    { mode: 0o755 },
  );
  const env = {
    PATH: process.env.PATH,
    HOME: join(ws, "home"),
    TMPDIR: ws,
    LC_ALL: "C",
    GAFFER_DATA: data,
    DISPATCH_DB: join(data, "dispatch.sqlite"),
    MEMORY_DB: join(data, "memory.sqlite"),
    DISPATCH_AUDIT_OFF: "1",
    MEMORY_AUDIT_OFF: "1",
    GAFFER_TESTING: "1",
    GAFFER_DOD_SANDBOX: "0",
    GAFFER_DIGEST_DISABLE: "1",
    GAFFER_MEMORY_INDEX: "0",
    GAFFER_CONFLICT_RESOLVER: "0",
    CLAUDE_BIN: stub,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const exec = (cmd, args, extra = {}) =>
    spawnSync(cmd, args.map(String), {
      cwd: ws,
      env: { ...env, ...extra },
      encoding: "utf8",
      timeout: 240000,
    });
  const must = (cmd, args, extra = {}) => {
    const r = exec(cmd, args, extra);
    if (r.error || r.status !== 0)
      throw new Error(`${cmd} ${args.join(" ")} → ${r.status}\n${r.stdout}\n${r.stderr}`);
    return r.stdout.trim();
  };
  const git = (...a) => must("git", ["-C", repo, ...a]);
  const wg = (...a) => JSON.parse(must(process.execPath, [cli, "--db", env.DISPATCH_DB, ...a]));
  return { ws, repo, env, exec, must, git, wg };
}

async function setup(w) {
  const { repo, git, wg, must, env } = w;
  Object.assign(process.env, { DISPATCH_DB: env.DISPATCH_DB });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  writeFileSync(
    join(repo, "package.json"),
    '{"name":"p","private":true,"type":"module","scripts":{"test":"node --test"}}\n',
  );
  writeFileSync(join(repo, "label.mjs"), 'export const label = () => "Ada";\n');
  writeFileSync(
    join(repo, "test/label.test.mjs"),
    "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {label} from '../label.mjs'; test('API', () => assert.equal(typeof label, 'function'));\n",
  );
  git("add", ".");
  git("commit", "-qm", "Initial project");
  const { Dispatch } = await import(pathToFileURL(core));
  const human = { type: "human", id: "rev" };
  const agent = { type: "agent", id: "builder" };
  const system = { type: "system", id: "runner" };
  let d = Dispatch.open(env.DISPATCH_DB);
  const reg = d.registerRepository(
    { name: "profiles", local_path: repo, default_branch: "main", test_command: "node --test" },
    human,
  );
  const plan = d.createEpic(
    {
      epic: { name: "Profile service", brief: "Display the public label Ada." },
      tickets: [
        {
          title: "Document label",
          acceptanceCriteria: ["Document it"],
          repo: "profiles",
          policy_pack: "solo_loose",
        },
      ],
    },
    human,
  );
  const [impl, final] = plan.ticketNumbers;
  const worker = d.registerAgent({ display_name: "builder", max_risk: "high" }, human);
  const deliver = (number, file, text) => {
    const branch = `gaffer/ticket-${number}-x`;
    git("switch", "-qc", branch);
    writeFileSync(join(repo, file), text);
    git("add", file);
    git("commit", "-qm", `ticket ${number}`);
    git("switch", "-q", "main");
    const t = d.view(String(number)).ticket;
    d.setTicketRepoAccess(
      { ticket_id: t.id, repo_id: reg.id, access: "write", relation: "confirmed" },
      human,
    );
    if (t.status !== "ready") d.markReady(t.id, human);
    const { claimToken } = d.claimTicket(
      { ticket_id: t.id, agent_id: worker.id, ttl_seconds: 600 },
      agent,
    );
    for (const ac of d.view(t.id).acceptanceCriteria)
      d.recordEvidence(
        { claimToken, ticket_id: t.id, ac_id: ac.id, evidence_type: "test_output", summary: "ok" },
        agent,
      );
    const sha = git("rev-parse", branch);
    d.recordRepoDelivery(
      { ticket_id: t.id, repo_id: reg.id, branch_name: branch, commit_sha: sha },
      agent,
    );
    d.recordDeliveryArtifact(
      { ticket_id: t.id, branch_name: branch, diff_summary: "change", claim_token: claimToken },
      system,
    );
    d.submitForReview({ ticket_id: t.id, claimToken, reason: "ready" }, agent);
    d.db.close();
    wg("review", "approve", number, "--commit", `profiles=${sha}`, "--reviewer", "rev");
    d = Dispatch.open(env.DISPATCH_DB);
    return sha;
  };
  deliver(impl, "README.md", "Call label().\n");
  d.db.close();
  must("bash", [runner, "merge", impl]);
  d = Dispatch.open(env.DISPATCH_DB);
  deliver(final, "label.mjs", 'export function label() { return "Ada"; }\n');
  d.db.close();
  const verdict = JSON.parse(must(process.execPath, [tester, "--ticket", final, "--live"]));
  if (verdict.replay !== "passed")
    throw new Error(`tester did not pass: ${JSON.stringify(verdict)}`);
  return { final };
}

// The interruption: a Dispatch CLI that dies on the two calls after the landing record.
function interruptingCli(w) {
  const p = join(w.ws, "interrupted-dispatch.mjs");
  writeFileSync(
    p,
    `import { spawnSync } from "node:child_process";
const a = process.argv.slice(2);
if (a.includes("record-tester-replay") || a.includes("mark-merged")) { process.stderr.write("simulated interruption\\n"); process.exit(137); }
const r = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...a], { stdio: "inherit" });
process.exit(r.status ?? 1);
`,
  );
  return p;
}
// The merge lane's landing (lib/land.sh gaffer_land_delivery), as the Poll / AFK path runs it.
function laneRetry(w, n) {
  const log = join(w.ws, `lane-${n}.log`);
  const script = `
log() { printf '%s\\n' "$*" >> "$LANE_LOG"; }
wg() { node "$DISPATCH_JS" --db "$DISPATCH_DB" "$@"; }
jget() { node "$RUNNER_DIR/lib/json-tool.mjs" expr "$1"; }
gaffer_refresh_cards() { :; }
_gaffer_flag_on() { case "\${1:-}" in 1|true|yes|on) return 0 ;; *) return 1 ;; esac; }
export RUNNER_DIR
source "$RUNNER_DIR/lib/automerge.sh"; source "$RUNNER_DIR/lib/land.sh"
cd "$REPO" || exit 2
gaffer_land_delivery "$N" "$REPO" "$(wg ticket show "$N" | jget 'd.ticket.branch_name')" main "$(wg ticket show "$N")" MERGE </dev/null`;
  const r = w.exec("bash", ["-c", script], {
    LANE_LOG: log,
    DISPATCH_JS: cli,
    RUNNER_DIR: join(ROOT, "runner"),
    REPO: w.repo,
    N: n,
  });
  return { status: r.status, log: existsSync(log) ? readFileSync(log, "utf8") : r.stderr };
}
const status = (w, n) => w.wg("ticket", "show", n).ticket.status;
const acceptance = (w) => w.wg("stats", "--json").acceptance;
const replayRows = (w, n) =>
  w
    .wg("ticket", "show", n)
    .evidence.filter((e) => String(e.uri || "").startsWith("gaffer-tester-replayed:"));

async function main() {
  console.log("== R1/R2: an interrupted landing, then a retry ==");
  const w = world("regen");
  try {
    const { final } = await setup(w);
    const main0 = w.git("rev-parse", "main");
    const first = w.exec("bash", [runner, "merge", final], { DISPATCH_CLI: interruptingCli(w) });
    ok(
      w.git("rev-parse", "main") !== main0,
      "R1: git landed the final's merge",
      first.stderr.slice(-400),
    );
    ok(
      w.wg("ticket", "landing", final).repos.every((r) => r.landed),
      "R1: the landing record was written",
    );
    ok(
      replayRows(w, final).length === 0,
      "R1: no tester replay record (the merger was interrupted)",
    );
    ok(status(w, final) === "ready_for_merge", `R1: the final is not done (${status(w, final)})`);
    const retry = w.exec("bash", [runner, "merge", final]);
    ok(
      retry.status === 0,
      `R2: the retry succeeds (exit ${retry.status})`,
      retry.stderr.slice(-600),
    );
    ok(/REPLAY RECOVERY/.test(retry.stderr), "R2: the retry says it is regenerating the replay");
    const rows = replayRows(w, final);
    ok(rows.length === 1, `R2: one replay record was regenerated (${rows.length})`);
    const landedRev = w.git("rev-parse", "main");
    ok(
      rows[0] && rows[0].uri === `gaffer-tester-replayed:${landedRev}`,
      "R2: it names the landed revision",
    );
    ok(status(w, final) === "done", `R2: the final is done (${status(w, final)})`);
    const a = acceptance(w);
    ok(
      a.accepted === 1 && a.epics[0]?.result === "accepted",
      `R2: the epic reads accepted (${a.epics[0]?.result})`,
    );
  } catch (e) {
    ok(false, "R1/R2 fixture completed", e.message);
  } finally {
    rmSync(w.ws, { recursive: true, force: true });
  }

  console.log("== R3: the replay cannot be regenerated: a targeted hold ==");
  const w3 = world("hold");
  try {
    const { final } = await setup(w3);
    w3.exec("bash", [runner, "merge", final], { DISPATCH_CLI: interruptingCli(w3) });
    // The tester's saved tests disappear (its tests branch deleted and pruned): nothing to
    // replay from, so the missing evidence cannot be regenerated.
    for (const ref of w3
      .git("for-each-ref", "--format=%(refname)", "refs/heads/gaffer-tests/")
      .split("\n")
      .filter(Boolean))
      w3.git("update-ref", "-d", ref);
    w3.git("reflog", "expire", "--expire=now", "--all");
    w3.git("gc", "-q", "--prune=now");
    const retry = w3.exec("bash", [runner, "merge", final]);
    ok(retry.status === 4, `R3: the retry holds (exit ${retry.status})`, retry.stderr.slice(-600));
    ok(
      /replay missing: .*gaffer merge \d+/.test(retry.stderr + retry.stdout),
      "R3: it says 'replay missing: … run gaffer merge <n>'",
      retry.stderr.slice(-400),
    );
    ok(status(w3, final) === "ready_for_merge", `R3: the final is not done (${status(w3, final)})`);
    ok(acceptance(w3).accepted === 0, "R3: the epic is not counted as accepted");
  } catch (e) {
    ok(false, "R3 fixture completed", e.message);
  } finally {
    rmSync(w3.ws, { recursive: true, force: true });
  }

  console.log("== R4: the merge lane's retry regenerates the replay ==");
  const w4 = world("lane");
  try {
    const { final } = await setup(w4);
    w4.exec("bash", [runner, "merge", final], { DISPATCH_CLI: interruptingCli(w4) });
    ok(replayRows(w4, final).length === 0, "R4: interrupted, no replay record");
    const lane = laneRetry(w4, final);
    ok(
      lane.status === 0,
      `R4: the lane's landing succeeds (rc ${lane.status})`,
      lane.log.slice(-600),
    );
    const rows = replayRows(w4, final);
    ok(
      rows.length === 1 && rows[0].uri === `gaffer-tester-replayed:${w4.git("rev-parse", "main")}`,
      `R4: one replay record, on the landed revision (${rows.length})`,
    );
    ok(status(w4, final) === "done", `R4: the final is done (${status(w4, final)})`);
  } catch (e) {
    ok(false, "R4 fixture completed", e.message);
  } finally {
    rmSync(w4.ws, { recursive: true, force: true });
  }

  console.log("== R5: a tester file that fails on the landed revision holds ==");
  const w5 = world("red");
  try {
    const { final } = await setup(w5);
    w5.exec("bash", [runner, "merge", final], { DISPATCH_CLI: interruptingCli(w5) });
    writeFileSync(join(w5.ws, "break-replay"), "1\n");
    const retry = w5.exec("bash", [runner, "merge", final]);
    ok(
      retry.status === 4,
      `R5: gaffer merge holds (exit ${retry.status})`,
      retry.stderr.slice(-600),
    );
    ok(
      /replay missing: .*did not pass/.test(retry.stderr + retry.stdout),
      "R5: it says the replay on the landed revision did not pass",
      retry.stderr.slice(-400),
    );
    const lane = laneRetry(w5, final);
    ok(
      lane.status === 4 && /HELD — replay missing/.test(lane.log),
      `R5: the lane holds too (rc ${lane.status})`,
      lane.log.slice(-400),
    );
    ok(replayRows(w5, final).length === 0, "R5: no replay record was written");
    ok(status(w5, final) === "ready_for_merge", `R5: the final is not done (${status(w5, final)})`);
    ok(acceptance(w5).accepted === 0, "R5: the epic is not counted as accepted");
  } catch (e) {
    ok(false, "R5 fixture completed", e.message);
  } finally {
    rmSync(w5.ws, { recursive: true, force: true });
  }

  console.log();
  if (failures.length === 0) {
    console.log(`replay-recovery: ALL ${pass} checks passed`);
    process.exit(0);
  }
  console.log(`replay-recovery: ${failures.length} FAILED (of ${pass + failures.length})`);
  process.exit(1);
}
await main();
