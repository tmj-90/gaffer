#!/usr/bin/env node
// Startup benchmark for the dispatch CLI (`wg`) and the runner's node helpers.
//
//   node packages/dispatch/scripts/bench-cli.mjs [--runs 7] [--cli <dist/cli/index.js>]
//                                                [--only <label substring>]
//
// It seeds a small database in a temp dir (5 tickets), then runs each command
// one process at a time: one discarded warm-up run, then --runs measured runs.
// It prints the median wall clock and the median CPU time (user + sys of the
// child, read from bash's `times`) per command. CPU time is the steadier number
// on a loaded box; wall clock is what a test or a tick waits for.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const runs = Number(flag("--runs", "7"));
const cli = path.resolve(flag("--cli", path.join(root, "packages/dispatch/dist/cli/index.js")));
const only = flag("--only", "");

const work = mkdtempSync(path.join(tmpdir(), "bench-cli-"));
const db = path.join(work, "bench.sqlite");
const node = process.execPath;
const wg = (...a) => [node, cli, "--db", db, ...a];

function must(cmd) {
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`setup failed: ${cmd.join(" ")}\n${r.stderr}`);
}
must(wg("init"));
for (let i = 1; i <= 5; i++) must(wg("ticket", "create", "-t", `Ticket ${i}`, "-d", `desc ${i}`));
const envelope = path.join(work, "envelope.json");
writeFileSync(envelope, JSON.stringify({ type: "result", result: "done", num_turns: 3 }));
const stdinJson = path.join(work, "in.json");
writeFileSync(stdinJson, JSON.stringify({ a: { b: 1 } }));

const cases = [
  ["node -e 0", [node, "-e", "0"]],
  ["wg --version", wg("--version")],
  ["wg --help", wg("--help")],
  ["wg ticket list", wg("ticket", "list")],
  ["wg ticket show 1", wg("ticket", "show", "1")],
  [
    "worker.mjs parse-result result-text",
    [
      node,
      path.join(root, "runner/lib/worker.mjs"),
      "parse-result",
      "result-text",
      "--json-file",
      envelope,
    ],
  ],
  [
    "json-tool.mjs expr",
    [node, path.join(root, "runner/lib/json-tool.mjs"), "expr", "d.a.b"],
    stdinJson,
  ],
];

// One run: bash runs the command, then `times` prints the children's user/sys.
function once(cmd, stdinFile) {
  const quoted = cmd.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  const script = `${quoted} <${stdinFile ? `'${stdinFile}'` : "/dev/null"} >/dev/null 2>&1; times`;
  const t0 = process.hrtime.bigint();
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  const line = r.stdout.trim().split("\n")[1] ?? "";
  const secs = [...line.matchAll(/(\d+)m([\d.]+)s/g)].map((m) => Number(m[1]) * 60 + Number(m[2]));
  return { wall, cpu: (secs[0] + secs[1]) * 1000 };
}
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

console.log(`cli: ${cli}`);
console.log(
  `node ${process.version}, runs ${runs}, loadavg ${(await import("node:os"))
    .loadavg()
    .map((l) => l.toFixed(2))
    .join(" ")}`,
);
console.log(
  ["command".padEnd(38), "wall ms".padStart(8), "cpu ms".padStart(8), "  walls"].join(""),
);
for (const [label, cmd, stdinFile] of cases) {
  if (only && !label.includes(only)) continue;
  once(cmd, stdinFile); // warm-up (fills the compile cache and the page cache)
  const samples = Array.from({ length: runs }, () => once(cmd, stdinFile));
  const walls = samples.map((s) => s.wall);
  const cpus = samples.map((s) => s.cpu);
  console.log(
    [
      label.padEnd(38),
      median(walls).toFixed(0).padStart(8),
      median(cpus).toFixed(0).padStart(8),
      `  ${walls.map((w) => w.toFixed(0)).join(" ")}`,
    ].join(""),
  );
}
rmSync(work, { recursive: true, force: true });
