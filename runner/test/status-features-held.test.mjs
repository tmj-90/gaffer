#!/usr/bin/env node
// =====================================================================
// `gaffer status` names the features that cannot ship (review of R3, external review 17).
// ---------------------------------------------------------------------
// A feature ships only when every ticket of it has landed. One whose remaining work is a
// FAILED ticket, a stray ticket carrying its marker outside its epic, or whose epic also
// names another feature, used to sit in `building` with only a merge-digest.log line to
// say so. status.sh now lists those under "features held", with the ticket numbers and
// the reason, from real Dispatch and Memory databases and CLIs:
//   S1  a feature held by a failed ticket          -> listed, with the ticket number
//   S2  a feature whose epic names two features    -> listed, with the ticket numbers
//   S3  a building feature with work in progress   -> not listed
//   S4  no memory database                         -> nothing printed, no database created
//   S5  memory unreadable                          -> "unknown", status still exits 0
// Run: node runner/test/status-features-held.test.mjs
// =====================================================================
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gafferMkdtemp } from "./lib/tmpdir.mjs";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const ROOT = resolve(RUNNER_DIR, "..");
const DISPATCH_JS = resolve(ROOT, "packages", "dispatch", "dist", "cli", "index.js");
const MEMORY_JS = resolve(ROOT, "packages", "memory", "dist", "bin", "memory.js");

if (!existsSync(DISPATCH_JS) || !existsSync(MEMORY_JS)) {
  console.log("SKIP: build the workspace first (dispatch / memory CLI not built)");
  process.exit(77);
}

let passed = 0;
const failures = [];
const assert = (l, c) => {
  if (c) {
    passed += 1;
    console.log(`  ok   ${l}`);
  } else {
    failures.push(l);
    console.log(`  FAIL ${l}`);
  }
};

const WORK = gafferMkdtemp(resolve(tmpdir(), "status-features-held-"));
// Doctor / stats stubs: status.sh's seams, so only the feature section is real.
const stub = (name, text) => {
  const p = resolve(WORK, name);
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s\\n' '${text}'\n`);
  chmodSync(p, 0o755);
  return p;
};
const SEAMS = {
  WG_DOCTOR_CMD: stub("wg-doctor.sh", "Healthy."),
  FG_DOCTOR_CMD: stub("fg-doctor.sh", "Ready."),
  LG_DOCTOR_CMD: stub("lg-doctor.sh", "Ready."),
  STATS_CMD: stub("stats.sh", '{"ticketsByStatus":{}}'),
  HUMAN_QUEUE_CMD: stub("hq.sh", "[]"),
  NO_COLOR: "1",
};

function world(name) {
  const dir = resolve(WORK, name);
  const data = resolve(dir, ".gaffer");
  mkdirSync(data, { recursive: true });
  mkdirSync(resolve(dir, "repo"), { recursive: true });
  const env = {
    ...process.env,
    ...SEAMS,
    HOME: dir,
    GAFFER_DATA: data,
    DISPATCH_DB: resolve(data, "dispatch.sqlite"),
    MEMORY_DB: resolve(data, "memory.sqlite"),
    DISPATCH_AUDIT: resolve(data, "audit.jsonl"),
    GAFFER_LOG: resolve(data, "factory.log"),
    DISPATCH_AUDIT_OFF: "1",
    MEMORY_AUDIT_OFF: "1",
  };
  delete env.GAFFER_PRINCIPAL_TOKEN;
  const w = { dir, env };
  w.wg = (...args) => {
    const r = spawnSync(process.execPath, [DISPATCH_JS, "--db", env.DISPATCH_DB, ...args], {
      encoding: "utf8",
      env,
    });
    if (r.status !== 0) throw new Error(`wg ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  w.lg = (...args) => {
    const r = spawnSync(process.execPath, [MEMORY_JS, ...args], { encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`memory ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  spawnSync("git", ["init", "-q", "-b", "main", resolve(dir, "repo")], { encoding: "utf8" });
  w.wg("init");
  w.wg("repo", "add", "-n", "demo", "--path", resolve(dir, "repo"), "--branch", "main");
  w.feature = (fname) =>
    /added feature (\S+)/.exec(
      w.lg("feature", "add", "demo", "--name", fname, "--summary", "s", "--status", "building"),
    )[1];
  w.epic = (ename, descs) => {
    const plan = {
      epic: { name: ename, description: "planned" },
      tickets: descs.map((d, i) => ({
        title: `${ename} part ${i + 1}`,
        description: d,
        acceptanceCriteria: ["works"],
        repo: "demo",
        dependsOn: [],
      })),
    };
    const f = resolve(dir, `plan-${ename}.json`);
    writeFileSync(f, JSON.stringify(plan));
    const r = JSON.parse(w.wg("epic", "create", f));
    return { tickets: r.ticket_numbers, acceptance: r.acceptance_ticket_number };
  };
  w.setStatus = (status, ...numbers) => {
    const db = new DatabaseSync(env.DISPATCH_DB);
    try {
      for (const n of numbers)
        db.prepare("UPDATE tickets SET status = ? WHERE number = ?").run(status, n);
    } finally {
      db.close();
    }
  };
  w.status = (extra = {}) =>
    spawnSync("bash", [resolve(RUNNER_DIR, "status.sh")], {
      encoding: "utf8",
      env: { ...env, ...extra },
    });
  return w;
}

/** The "features held" section of a status run (empty when absent). */
function heldSection(out) {
  const lines = out.split("\n");
  const at = lines.findIndex((l) => /^\s*features held/.test(l));
  if (at < 0) return "";
  const body = [];
  for (const l of lines.slice(at + 1)) {
    if (!/^ {4}\S/.test(l)) break;
    body.push(l);
  }
  return [lines[at], ...body].join("\n");
}

try {
  console.log("== S1-S3: held features are listed, a feature in progress is not ==");
  {
    const w = world("s123");
    const failedF = w.feature("Refunds");
    const fe = w.epic("Refunds", [`a\n\nFeature-Id: ${failedF}`, `b\n\nFeature-Id: ${failedF}`]);
    w.setStatus("done", fe.tickets[0], fe.acceptance);
    w.setStatus("failed", fe.tickets[1]);

    const [alpha, beta] = [w.feature("Alpha"), w.feature("Beta")];
    const two = w.epic("Two", [`a\n\nFeature-Id: ${alpha}`, `b\n\nFeature-Id: ${beta}`]);
    w.setStatus("done", ...two.tickets, two.acceptance);

    const busy = w.feature("Exports");
    const be = w.epic("Exports", [`a\n\nFeature-Id: ${busy}`, `b\n\nFeature-Id: ${busy}`]);
    w.setStatus("done", be.tickets[0]);
    w.setStatus("in_progress", be.tickets[1]);

    const r = w.status();
    const held = heldSection(r.stdout);
    assert(`status exits 0 (rc ${r.status})`, r.status === 0);
    assert(`a "features held" section is printed:\n${held}`, held !== "");
    const line = (id) => held.split("\n").find((l) => l.includes(`, ${id}):`)) ?? "";
    assert(
      `S1: the feature held by a failed ticket names #${fe.tickets[1]} (${line(failedF).trim()})`,
      line(failedF).includes(`#${fe.tickets[1]}`) && /failed/.test(line(failedF)),
    );
    for (const id of [alpha, beta]) {
      assert(
        `S2: ${id} (epic names two features) names the tickets (${line(id).trim()})`,
        line(id).includes(`#${two.tickets[0]}`) &&
          line(id).includes(`#${two.tickets[1]}`) &&
          /more than one feature/.test(line(id)),
      );
    }
    assert(`S3: a feature still in progress is not listed`, !held.includes(busy));
  }

  console.log("== S4: no memory database -> nothing ==");
  {
    const w = world("s4");
    rmSync(w.env.MEMORY_DB, { force: true });
    const r = w.status();
    assert(`S4: status exits 0 (rc ${r.status})`, r.status === 0);
    assert("S4: no features section", heldSection(r.stdout) === "");
    assert("S4: no memory database was created", !existsSync(w.env.MEMORY_DB));
  }

  console.log("== S5: memory unreadable -> unknown, never a failed status ==");
  {
    const w = world("s5");
    w.feature("Something");
    const broken = resolve(w.dir, "memory-down.mjs");
    writeFileSync(broken, "process.stderr.write('database is locked\\n'); process.exit(1);\n");
    const r = w.status({ MEMORY_CLI_BIN: broken });
    const held = heldSection(r.stdout);
    assert(`S5: status exits 0 (rc ${r.status})`, r.status === 0);
    assert(`S5: the section says unknown (${held.replace(/\n/g, " | ")})`, /unknown/.test(held));
  }
} finally {
  if (process.env.KEEP !== "1") rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
