#!/usr/bin/env node
// Golden corpus for the safety hook's decision: every tool call the hook suites feed
// to the hook (the nine safety-hook*.test.mjs files and skills-hook-claims, which
// parses the Bash commands in runner/skills/*/SKILL.md), deduplicated, with the
// verdict decide() gave for it, recorded in test/fixtures/safety-hook-corpus.json.
// This test decides every entry again and fails on any difference: allow/deny, exit
// code, the reason (its prefix up to the first colon and the whole text) and the
// stdout an allowed Grep writes. It pins the hook's behaviour, not its intent: the
// suites say what each rule must do, the corpus says nothing else moved.
//
// The environment is fixed (the fixture's "environment" block documents it): a fresh
// scratch base holding a git repo (the write root and cwd), a read root, GAFFER_DATA
// and HOME, decided under three profiles (configured roots, no roots, bootstrap
// installs). The test re-runs itself with HOME set to the fixture home, because the
// core fixes its factory-code paths from os.homedir() when it loads.
//
// Refreshing it is always deliberate, never part of a normal run:
//   node runner/test/safety-hook-golden-corpus.test.mjs --update
//     re-records every verdict from the live core (after an intended rule change;
//     review the diff of the fixture, it is one entry per line).
//   node runner/test/lib/hook-corpus-harvest.mjs
//     re-runs the hook suites through a recording shim, adds the tool calls the
//     corpus does not hold yet and records their verdicts (`--add`: an existing
//     verdict that differs still fails).
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDir } from "./lib/hook-harness.mjs";
import {
  buildFixture,
  CORPUS_FILE,
  entryRaw,
  compactVerdicts,
  placeholderMap,
  profiles,
  recordedVerdict,
  serialiseCorpus,
  verdictOf,
} from "./lib/hook-corpus.mjs";

const args = process.argv.slice(2);
const UPDATE = args.includes("--update");
const ADD = args.includes("--add");

if (!process.env.GAFFER_CORPUS_BASE) {
  const base = scratchDir("gaffer-corpus-");
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    stdio: "inherit",
    env: {
      PATH: process.env.PATH,
      HOME: resolve(base, "home"),
      LC_ALL: "C",
      GAFFER_CORPUS_BASE: base,
    },
  });
  rmSync(base, { recursive: true, force: true });
  process.exit(r.status ?? 1);
}

const base = process.env.GAFFER_CORPUS_BASE;
buildFixture(base);
const map = placeholderMap(base);
const envs = profiles(map);
const cwd = map["{{WORK}}"];
const { decideRaw } = await import("../safety-hook-core.mjs");

const corpus = JSON.parse(readFileSync(CORPUS_FILE, "utf8"));
const failures = [];
let checked = 0;
let recorded = 0;

for (const [i, entry] of corpus.entries.entries()) {
  const raw = entryRaw(entry, map);
  const got = {};
  for (const [name, env] of Object.entries(envs)) {
    let v;
    try {
      v = verdictOf(decideRaw(raw, { env, cwd }), map, base);
    } catch (err) {
      v = { throws: String(err && err.message ? err.message : err) };
    }
    got[name] = v;
  }
  if (UPDATE || (ADD && !entry.verdicts)) {
    entry.verdicts = compactVerdicts(got);
    recorded += 1;
    continue;
  }
  if (!entry.verdicts) {
    failures.push(`entry ${i}: no recorded verdicts (run with --add to record new entries)`);
    continue;
  }
  for (const name of Object.keys(envs)) {
    checked += 1;
    const want = JSON.stringify(recordedVerdict(entry.verdicts, name));
    const have = JSON.stringify(got[name]);
    if (want !== have) {
      const shown = raw.length > 300 ? `${raw.slice(0, 300)}… (${raw.length} bytes)` : raw;
      failures.push(`entry ${i} [${name}] ${shown}\n      want ${want}\n      got  ${have}`);
    }
  }
}

if (UPDATE || ADD) writeFileSync(CORPUS_FILE, serialiseCorpus(corpus));

if (failures.length) {
  console.error(
    `FAIL safety-hook-golden-corpus: ${failures.length} differences, ${checked - failures.length} verdicts unchanged`,
  );
  for (const f of failures.slice(0, 40)) console.error("  ✗ " + f);
  if (failures.length > 40) console.error(`  … and ${failures.length - 40} more`);
  process.exit(1);
}
console.log(
  `PASS safety-hook-golden-corpus: ${corpus.entries.length} entries, ${checked} verdicts unchanged` +
    (recorded ? `, ${recorded} entries recorded` : ""),
);
