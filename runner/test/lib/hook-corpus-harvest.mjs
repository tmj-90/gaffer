#!/usr/bin/env node
// Harvest the safety hook's golden corpus (see safety-hook-golden-corpus.test.mjs).
//
//   node runner/test/lib/hook-corpus-harvest.mjs
//
// runs the hook suites with this file preloaded (`node --import`): its resolve and
// load hooks swap safety-hook-core.mjs for a shim that records every decideRaw()
// call (in-process, and in each spawned `node safety-hook.mjs`, which inherits
// NODE_OPTIONS) before passing it on unchanged. Each recorded tool call is
// normalised (the suite's scratch roots, data dir, HOME and the checkout become the
// corpus placeholders), deduplicated, and the ones the corpus does not hold yet are
// appended; the corpus test then records their verdicts with --add. Existing
// entries are never dropped or re-recorded here.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const CORE_URL = pathToFileURL(resolve(dirname(SELF), "..", "..", "safety-hook-core.mjs")).href;
const SHIM_URL = "gaffer-corpus-shim:core";

// ---- loader side (preloaded into each suite process) -------------------------
export async function resolve_(specifier, context, next) {
  if (specifier === SHIM_URL) return { url: SHIM_URL, shortCircuit: true };
  const r = await next(specifier, context);
  if (r.url === CORE_URL && context.parentURL !== SHIM_URL) {
    return { url: SHIM_URL, shortCircuit: true };
  }
  return r;
}
export { resolve_ as resolve };

export async function load(url, context, next) {
  if (url !== SHIM_URL) return next(url, context);
  const real = JSON.stringify(`${CORE_URL}?corpus-real`);
  const source = `
    import { appendFileSync } from "node:fs";
    import * as real from ${real};
    export * from ${real};
    const OUT = process.env.GAFFER_CORPUS_HARVEST_OUT;
    export function decideRaw(raw, options = {}) {
      const env = options.env ?? process.env;
      const cwd = options.cwd ?? process.cwd();
      const result = real.decideRaw(raw, options);
      if (OUT) {
        const keep = {};
        for (const k of Object.keys(env)) {
          if (k.startsWith("GAFFER_") || k === "HOME" || k === "MCP_CONFIG") keep[k] = env[k];
        }
        appendFileSync(OUT, JSON.stringify({ suite: process.env.GAFFER_CORPUS_SUITE, raw, env: keep, cwd }) + "\\n");
      }
      return result;
    }
    export function decide(payload, options) {
      return decideRaw(JSON.stringify(payload) ?? "", options);
    }`;
  return { format: "module", source, shortCircuit: true };
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SELF);
if (!isMain && !import.meta.url.endsWith("?hooks")) {
  register(`${import.meta.url}?hooks`);
}

const ABOUT = [
  "Golden corpus for runner/safety-hook-core.mjs: every tool call the hook suites feed to the hook,",
  "deduplicated, with the verdict the core gave. Asserted by runner/test/safety-hook-golden-corpus.test.mjs;",
  "inputs harvested by runner/test/lib/hook-corpus-harvest.mjs. Machine-written: refresh it only on purpose",
  "(--update after an intended rule change), never by hand.",
  "Entry: from = the suites that feed it; payload (the JSON the hook receives) or raw (exact stdin text when",
  "it is not a JSON.stringify round trip); strings over 4096 chars are { $pieces: [text | { $repeat, times }] }.",
  "verdicts.<profile> = { verdict: allow|deny, exit: 0|2, prefix: reason up to its first colon, reason, stdout? },",
  'or "=<profile>" when it is the same as that earlier profile\'s.',
];
const ENVIRONMENT = {
  base: "a fresh realpath'd scratch dir per run; {{BASE}} in a recorded reason",
  placeholders: {
    "{{FACTORY}}":
      "the live checkout (dirname of runner/), so front-door cases name the real runner",
    "{{WORK}}":
      "<base>/work: a git repo on main (src/a.js, README.md, .gitattributes committed; .env untracked); the write root and the cwd",
    "{{READ}}": "<base>/read (docs/notes.md): the read root",
    "{{DATA}}": "<base>/data: GAFFER_DATA; MCP_CONFIG is <base>/data/mcp-runtime.json",
    "{{HOME}}":
      "<base>/home (.ssh/id_rsa): HOME, at core load time too (the test re-runs itself with it)",
    "{{TMP}}": "<base>/tmp: a suite scratch dir that is none of the above, by its prefix",
  },
  common:
    "PATH inherited; HOME={{HOME}}; LC_ALL=C; GIT_CONFIG_NOSYSTEM=1; GAFFER_DATA={{DATA}}; GAFFER_TICKET=corpus; MCP_CONFIG; cwd={{WORK}}",
  profiles: {
    roots: "GAFFER_WRITE_ROOTS={{WORK}} GAFFER_READ_ROOTS={{READ}}",
    open: "no GAFFER_WRITE_ROOTS / GAFFER_READ_ROOTS (the unconfigured fallback)",
    bootstrap: "roots + GAFFER_BOOTSTRAP_INSTALL=1 GAFFER_BOOTSTRAP_DIR={{WORK}}",
  },
  normalised:
    "a suite's write roots, bootstrap dir and non-runner cwd -> {{WORK}}; read roots -> {{READ}}; GAFFER_DATA -> {{DATA}}; HOME -> {{HOME}}; other mkdtemp dirs -> {{TMP}}/<prefix>",
};

// ---- harvest side --------------------------------------------------------------
if (isMain) {
  const { scratchDir } = await import("./hook-harness.mjs");
  const { CORPUS_FILE, FACTORY_DIR, RUNNER_DIR, encodeLong, serialiseCorpus } =
    await import("./hook-corpus.mjs");
  const { readdirSync, writeFileSync } = await import("node:fs");
  const TEST = resolve(RUNNER_DIR, "test");
  const suites = readdirSync(TEST)
    .filter(
      (f) =>
        (/^safety-hook.*\.test\.mjs$/.test(f) && f !== "safety-hook-golden-corpus.test.mjs") ||
        f === "skills-hook-claims.test.mjs",
    )
    .sort();
  const work = scratchDir("gaffer-corpus-harvest-");
  const out = resolve(work, "records.jsonl");
  for (const s of suites) {
    const r = spawnSync(process.execPath, [resolve(TEST, s)], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --import ${pathToFileURL(SELF).href}`.trim(),
        GAFFER_CORPUS_HARVEST_OUT: out,
        GAFFER_CORPUS_SUITE: s,
      },
    });
    if (r.status !== 0) {
      console.error(`harvest: ${s} failed (exit ${r.status}); fix the suite first\n${r.stderr}`);
      process.exit(1);
    }
    console.log(`harvest: ran ${s}`);
  }
  const records = readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  rmSync(work, { recursive: true, force: true });

  const tmpRoots = [...new Set([tmpdir(), "/tmp"].filter(existsSync).map((d) => realpathSync(d)))];
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scratchRe = new RegExp(
    `(?:${tmpRoots.map(esc).join("|")})/([\\w.-]*-)[A-Za-z0-9]{6}(?![\\w.-])`,
    "g",
  );
  const split = (v) => (v ? String(v).split(/[\n:]/).filter(Boolean) : []);
  const normaliser = (rec) => {
    const pairs = [[FACTORY_DIR, "{{FACTORY}}"]];
    for (const r of split(rec.env.GAFFER_WRITE_ROOTS)) pairs.push([r, "{{WORK}}"]);
    for (const r of split(rec.env.GAFFER_READ_ROOTS)) pairs.push([r, "{{READ}}"]);
    if (rec.env.GAFFER_BOOTSTRAP_DIR) pairs.push([rec.env.GAFFER_BOOTSTRAP_DIR, "{{WORK}}"]);
    if (rec.env.GAFFER_DATA) pairs.push([rec.env.GAFFER_DATA, "{{DATA}}"]);
    if (rec.env.HOME && rec.env.HOME !== "/") pairs.push([rec.env.HOME, "{{HOME}}"]);
    if (rec.cwd !== RUNNER_DIR) pairs.push([rec.cwd, "{{WORK}}"]);
    const ordered = pairs
      .filter(([p]) => p.startsWith("/") && p.length > 1)
      .sort((a, b) => b[0].length - a[0].length);
    const norm = (s) => {
      let t = s;
      for (const [p, k] of ordered) t = t.split(p).join(k);
      return t.replace(scratchRe, "{{TMP}}/$1");
    };
    const walk = (v) =>
      typeof v === "string"
        ? norm(v)
        : Array.isArray(v)
          ? v.map(walk)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
            : v;
    return walk;
  };

  const corpus = existsSync(CORPUS_FILE)
    ? JSON.parse(readFileSync(CORPUS_FILE, "utf8"))
    : { about: ABOUT, environment: ENVIRONMENT, entries: [] };
  const keyOf = (e) => JSON.stringify("raw" in e ? { raw: e.raw } : { payload: e.payload });
  const known = new Map(corpus.entries.map((e) => [keyOf(e), e]));
  let added = 0;
  for (const rec of records) {
    const walk = normaliser(rec);
    let parsed;
    try {
      parsed = JSON.parse(rec.raw);
    } catch {
      parsed = undefined;
    }
    const exact = parsed !== undefined && JSON.stringify(parsed) === rec.raw;
    const entry = exact
      ? { payload: encodeLong(walk(parsed)) }
      : { raw: encodeLong(walk(rec.raw)) };
    const key = keyOf(entry);
    const have = known.get(key);
    if (have) {
      if (!have.from.includes(rec.suite)) have.from = [...have.from, rec.suite].sort();
      continue;
    }
    const fresh = { from: [rec.suite], ...entry };
    known.set(key, fresh);
    corpus.entries.push(fresh);
    added += 1;
  }
  writeFileSync(CORPUS_FILE, serialiseCorpus(corpus));
  console.log(
    `harvest: ${records.length} decisions recorded, ${added} new entries (${corpus.entries.length} in all)`,
  );
  const r = spawnSync(
    process.execPath,
    [resolve(TEST, "safety-hook-golden-corpus.test.mjs"), "--add"],
    { stdio: "inherit" },
  );
  process.exit(r.status ?? 1);
}
