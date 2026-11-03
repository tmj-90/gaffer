// Shared by safety-hook-golden-corpus.test.mjs and hook-corpus-harvest.mjs: the
// corpus file's placeholders, its compact encoding of long strings, the fixture tree
// the corpus is decided in, and the fixed environment profiles. See the test's header.
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gafferMkdtemp } from "./tmpdir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNNER_DIR = resolve(HERE, "..", "..");
export const FACTORY_DIR = dirname(RUNNER_DIR);
const FACTORY_REAL = realpathSync(FACTORY_DIR);
export const CORPUS_FILE = resolve(RUNNER_DIR, "test", "fixtures", "safety-hook-corpus.json");

// The fixture tree, relative to a fresh realpath'd scratch base. {{FACTORY}} is the
// live checkout (so the factory front-door cases name the real runner directory).
export const LAYOUT = {
  "{{WORK}}": "work",
  "{{READ}}": "read",
  "{{DATA}}": "data",
  "{{HOME}}": "home",
  "{{TMP}}": "tmp",
};

// A recorded reason echoes the command it refused cut at a fixed length (the deny
// rules quote cmd.slice(0, 120), some 100 or 40), and most corpus commands name a
// fixture path or the checkout; some climb out of the base ({{WORK}}/../..). So the
// length and depth of those two paths are part of the recorded text: a longer TMPDIR
// (macOS: /private/var/folders/...) or a checkout somewhere else moves where an echo
// is cut, and the test fails with no verdict changed. Every run therefore decides with
// the shape the corpus was recorded in: the base is a direct child of /tmp, named so
// that its canonical path is BASE_LENGTH characters (on Linux that is
// /tmp/gaffer-corpus-XXXXXX), and the checkout is reached through a symlink whose
// path is FACTORY_LENGTH characters. The test re-runs itself through that link with
// --preserve-symlinks, so {{FACTORY}} is the link; the core resolves it to the real
// runner directory (as for a symlinked install) and also knows the link's spelling.
export const BASE_LENGTH = 25;
export const FACTORY_LENGTH = 27;

/** { base, linkDir, factory }: a fresh base and a fresh dir holding the checkout link. */
export function corpusTree() {
  const tmp = realpathSync("/tmp");
  const named = (prefix) => realpathSync(gafferMkdtemp(resolve(tmp, prefix)));
  const room = BASE_LENGTH - tmp.length - 1 - 6;
  if (room < 2 || FACTORY_LENGTH - (tmp.length + 1 + 2 + 6) < 2) {
    throw new Error(`/tmp resolves to ${tmp}, too long for the corpus tree`);
  }
  const base = named("gaffer-corpus-".slice(0, room));
  const linkDir = named("gf");
  const factory = resolve(linkDir, "f".repeat(FACTORY_LENGTH - linkDir.length - 1));
  symlinkSync(FACTORY_DIR, factory);
  return { base, linkDir, factory };
}

/** Placeholder -> absolute path for one fixture base. */
export function placeholderMap(base) {
  const map = { "{{FACTORY}}": FACTORY_DIR };
  for (const [k, rel] of Object.entries(LAYOUT)) map[k] = resolve(base, rel);
  return map;
}

/** Fill the placeholders in every string of `value`. */
export function fill(value, map) {
  if (typeof value === "string") {
    let s = value;
    for (const [k, v] of Object.entries(map)) s = s.split(k).join(v);
    return s;
  }
  if (Array.isArray(value)) return value.map((x) => fill(x, map));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, map)]));
  }
  return value;
}

// Top-level directories some platforms alias (macOS: /tmp, /etc and /var live under
// /private). The core reports canonical paths; the corpus records the portable form.
const ALIASES = ["/tmp", "/etc", "/var"].flatMap((d) => {
  try {
    const real = realpathSync(d);
    return real === d ? [] : [[real, d]];
  } catch {
    return [];
  }
});

/** Put the placeholders back into a decided string (longest path first). */
export function unfill(text, map, base) {
  if (typeof text !== "string") return text;
  let s = text;
  // Through the checkout link the core still reports the canonical runner path.
  const extra = FACTORY_REAL === map["{{FACTORY}}"] ? [] : [["{{FACTORY}}", FACTORY_REAL]];
  const pairs = [...Object.entries(map), ...extra].sort((a, b) => b[1].length - a[1].length);
  for (const [k, v] of pairs) s = s.split(v).join(k);
  s = s.split(base).join("{{BASE}}");
  for (const [real, d] of ALIASES) s = s.replace(new RegExp(`${real}(?=/|\\b|$)`, "g"), d);
  return s;
}

// Long strings (the size-cap and ReDoS cases run to 2 MiB) are stored as pieces:
// plain strings and { $repeat: unit, times: n } runs, decoded back byte for byte.
const LONG = 4096;

export function encodeLong(value) {
  if (typeof value === "string") {
    if (value.length <= LONG) return value;
    const pieces = [];
    let last = 0;
    for (const m of value.matchAll(/([\s\S]{1,64}?)\1{19,}/g)) {
      if (m.index > last) pieces.push(value.slice(last, m.index));
      pieces.push({ $repeat: m[1], times: m[0].length / m[1].length });
      last = m.index + m[0].length;
    }
    if (last < value.length) pieces.push(value.slice(last));
    const out = { $pieces: pieces };
    if (decodeLong(out) !== value) throw new Error("long-string encoding does not round-trip");
    return out;
  }
  if (Array.isArray(value)) return value.map(encodeLong);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeLong(v)]));
  }
  return value;
}

export function decodeLong(value) {
  if (Array.isArray(value)) return value.map(decodeLong);
  if (value && typeof value === "object") {
    if (Array.isArray(value.$pieces)) {
      return value.$pieces
        .map((p) => (typeof p === "string" ? p : p.$repeat.repeat(p.times)))
        .join("");
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeLong(v)]));
  }
  return value;
}

/** The raw stdin text an entry stands for, with the placeholders filled. */
export function entryRaw(entry, map) {
  if ("raw" in entry) return fill(decodeLong(entry.raw), map);
  return JSON.stringify(fill(decodeLong(entry.payload), map));
}

/** Build the fixture tree under `base` (HOME is `base`/home, already the process HOME). */
export function buildFixture(base) {
  const p = (rel) => resolve(base, rel);
  for (const d of ["work/src", "read/docs", "data", "home/.ssh", "tmp"]) {
    mkdirSync(p(d), { recursive: true });
  }
  writeFileSync(p("work/src/a.js"), "export const a = 1;\n");
  writeFileSync(p("work/README.md"), "# fixture\n");
  writeFileSync(p("work/.gitattributes"), "*.png binary\n");
  writeFileSync(p("work/.env"), "FIXTURE=1\n");
  writeFileSync(p("read/docs/notes.md"), "notes\n");
  writeFileSync(p("home/.ssh/id_rsa"), "fixture, not a key\n");
  const git = (...args) => {
    const r = spawnSync("git", ["-C", p("work"), ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`fixture git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", "main");
  git("add", "src/a.js", "README.md", ".gitattributes");
  git("-c", "user.email=corpus@example.invalid", "-c", "user.name=corpus", "commit", "-qm", "seed");
}

/** The fixed environment profiles every entry is decided under (cwd is always {{WORK}}). */
export function profiles(map) {
  const common = {
    PATH: process.env.PATH,
    HOME: map["{{HOME}}"],
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GAFFER_DATA: map["{{DATA}}"],
    GAFFER_TICKET: "corpus",
    MCP_CONFIG: `${map["{{DATA}}"]}/mcp-runtime.json`,
  };
  const roots = {
    GAFFER_WRITE_ROOTS: map["{{WORK}}"],
    GAFFER_READ_ROOTS: map["{{READ}}"],
  };
  return {
    roots: { ...common, ...roots },
    open: { ...common },
    bootstrap: {
      ...common,
      ...roots,
      GAFFER_BOOTSTRAP_INSTALL: "1",
      GAFFER_BOOTSTRAP_DIR: map["{{WORK}}"],
    },
  };
}

/** The recorded form of one decideRaw() result. */
export function verdictOf(result, map, base) {
  const v = { verdict: result.allow ? "allow" : "deny", exit: result.exitCode };
  if (!result.allow) {
    const reason = unfill(result.reason ?? "", map, base);
    const colon = reason.indexOf(":");
    v.prefix = colon >= 0 ? reason.slice(0, colon) : reason;
    v.reason = reason;
  }
  if (result.stdout) v.stdout = encodeLong(unfill(result.stdout, map, base));
  return v;
}

/** Record a profile whose verdict equals an earlier profile's as "=<that profile>". */
export function compactVerdicts(verdicts) {
  const out = {};
  const seen = [];
  for (const [name, v] of Object.entries(verdicts)) {
    const json = JSON.stringify(v);
    const same = seen.find(([, j]) => j === json);
    out[name] = same ? `=${same[0]}` : v;
    if (!same) seen.push([name, json]);
  }
  return out;
}

/** The verdict recorded for `name`, following "=<profile>" references. */
export function recordedVerdict(verdicts, name) {
  let v = verdicts[name];
  while (typeof v === "string" && v.startsWith("=")) v = verdicts[v.slice(1)];
  return v;
}

/** Write the corpus in its stable on-disk form: one entry per line. */
export function serialiseCorpus(corpus) {
  const head = JSON.stringify({ about: corpus.about, environment: corpus.environment }, null, 2);
  const lines = corpus.entries.map((e) => "    " + JSON.stringify(e));
  return `${head.slice(0, -2)},\n  "entries": [\n${lines.join(",\n")}\n  ]\n}\n`;
}
