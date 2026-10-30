#!/usr/bin/env node
// Every dashboard setting must be READ by something. A key in SETTING_DEFS that only
// settings.ts (the allow-list) and factory.config.sh (the default + export) mention is
// a dead knob: the Settings panel offers it, CONFIG.md documents it, and changing it
// does nothing. GAFFER_MAX_RESUMES_PER_TICK was exactly that (a tick re-enters at most
// one Continue'd ticket whatever it said). This scans the live sources — the runner,
// and dispatch/crew/memory src — for each key outside those two declaring files.
// Run: node test/settings-consumers.test.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SETTINGS_TS = join(ROOT, "packages/dispatch/src/api/settings.ts");
const CONFIG_SH = join(ROOT, "runner/factory.config.sh");

const keys = [...readFileSync(SETTINGS_TS, "utf8").matchAll(/^\s*key: "([A-Z0-9_]+)",$/gm)].map(
  (m) => m[1],
);

const SRC_DIRS = ["runner", "packages/dispatch/src", "packages/crew/src", "packages/memory/src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "test", ".git", "eval"]);
const EXT = /\.(sh|mjs|js|ts|cjs)$/;
const files = [];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p);
    } else if ((EXT.test(name) || name === "gaffer") && p !== SETTINGS_TS && p !== CONFIG_SH) {
      files.push(p);
    }
  }
};
for (const d of SRC_DIRS) walk(join(ROOT, d));
const corpus = files.map((f) => readFileSync(f, "utf8"));

let passed = 0;
const failures = [];
if (keys.length < 20)
  failures.push(`parsed only ${keys.length} keys from settings.ts — the key regex is stale`);
for (const k of keys) {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${k}([^A-Za-z0-9_]|$)`);
  // factory.config.sh may itself be the consumer (GAFFER_MODE, the autonomy cluster):
  // count it only where the key is READ, i.e. expanded, not just assigned/exported.
  const configReads = new RegExp(`\\$\\{?${k}\\b(?![:=]?=)`).test(
    readFileSync(CONFIG_SH, "utf8").replace(new RegExp(`: "\\$\\{${k}:=[^}]*\\}"`, "g"), ""),
  );
  const users = files.filter((_, i) => re.test(corpus[i]));
  if (users.length > 0 || configReads) passed += 1;
  else
    failures.push(
      `${k}: offered in the Settings panel but nothing reads it (only settings.ts / factory.config.sh name it)`,
    );
}
const gone = files
  .filter((_, i) => /GAFFER_MAX_RESUMES_PER_TICK/.test(corpus[i]))
  .map((f) => relative(ROOT, f));
if (keys.includes("GAFFER_MAX_RESUMES_PER_TICK") || gone.length)
  failures.push(`GAFFER_MAX_RESUMES_PER_TICK is back: ${gone.join(", ")}`);
else passed += 1;

if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`settings-consumers: ${failures.length} FAILURE(S)`);
  process.exit(1);
}
console.log(
  `settings-consumers: ALL ${passed} checks passed (${keys.length} settings, each with a reader)`,
);
