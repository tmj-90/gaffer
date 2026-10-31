// Which world each scenario suite runs in, for run-suites.sh (no browser, no server:
// it only imports the suite modules, which import nothing but node built-ins).
//
// A suite runs on the SHARED server (the default world, one dashboard for every such
// suite in the run) unless it exports a `server` declaration:
//
//   export const server = {
//     env: { KEY: "value" },     // exported before ITS dashboard starts (operator env);
//                                // ${OUT} ${R} ${HERE} in a value expand in run-suites.sh
//     fixtures: ["fake-gh"],     // named setup steps own-env.sh provides
//   };
//
// Such a suite gets its OWN dashboard + data dir + sample repo, built by setup.sh
// with that env, so what it changes (a fake `gh` on PATH, a GitHub remote, ingest on,
// a greenfield root, merge conflicts on main) never reaches another suite.
//
//   node suite-plan.mjs [names…]       → one line per suite: "shared <name>" | "own <name>"
//   node suite-plan.mjs --env <name>   → KEY=VALUE lines (the suite's server.env)
//   node suite-plan.mjs --fixtures <name> → one fixture name per line
//   node suite-plan.mjs --summary <results.json…> → the combined "UI scenarios:" line
// Names come from argv, else UI_SUITES (space/comma list), else ORDER.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(new URL(import.meta.url).pathname);

// The order suites run in when none are named (also the order inside a shard). The
// own-server suites run after the shared world, each in its own.
export const ORDER = [
  "s1-rework",
  "s2-wont-do",
  "s3-blocked",
  "s10-pause",
  "s5-tester",
  "s6-decisions",
  "s12-settings",
  "s13-principals",
  "s9-memory",
  "s14-map",
  "s15-squad-floor",
  "s8-specs",
  "s7-plan",
  "s11-health",
  "s4-autonomy",
  "s16-review-hold",
  "sweep",
  "s4b-pr-mode",
  "s12b-idle-lanes",
  "s7b-greenfield",
  "s17-conflict",
];

export const available = () =>
  readdirSync(path.join(HERE, "suites"))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => f.replace(/\.mjs$/, ""));

/** The suite names a run asked for (argv, else UI_SUITES), else every suite in ORDER. */
export function requested(argv) {
  const have = available();
  const asked = (argv.length ? argv : (process.env.UI_SUITES || "").split(/[\s,]+/)).filter(
    Boolean,
  );
  return asked.length ? asked : ORDER.filter((n) => have.includes(n));
}

const serverOf = async (name) =>
  (await import(pathToFileURL(path.join(HERE, "suites", `${name}.mjs`)).href)).server || null;

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(HERE, "suite-plan.mjs")) {
  const [flag, ...rest] = process.argv.slice(2);
  if (flag === "--env") {
    const s = await serverOf(rest[0]);
    for (const [k, v] of Object.entries((s && s.env) || {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /[\n\r]/.test(String(v)))
        throw new Error(`suite ${rest[0]}: bad server.env entry ${k}`);
      console.log(`${k}=${v}`);
    }
  } else if (flag === "--fixtures") {
    const s = await serverOf(rest[0]);
    for (const f of (s && s.fixtures) || []) console.log(f);
  } else if (flag === "--summary") {
    const all = [];
    let suites = 0;
    for (const f of rest) {
      if (!existsSync(f)) continue;
      const r = JSON.parse(readFileSync(f, "utf8"));
      suites += (r.suites || []).length;
      all.push(...(r.results || []));
    }
    const n = (k) => all.filter((x) => x[1] === k).length;
    console.log(
      `UI scenarios (every world): ${n("ok")} ok, ${n("FAIL")} FAIL, ${n("note")} notes, ${n("skip")} skipped (${suites} suites, ${rest.length} world${rest.length === 1 ? "" : "s"})`,
    );
  } else {
    const names = requested(process.argv.slice(2));
    const have = available();
    const unknown = names.filter((n) => !have.includes(n));
    if (unknown.length) {
      console.error(`unknown suite(s): ${unknown.join(", ")} (have: ${have.join(", ")})`);
      process.exit(2);
    }
    for (const n of names) console.log(`${(await serverOf(n)) ? "own" : "shared"} ${n}`);
  }
}
