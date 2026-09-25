#!/usr/bin/env node
// Config reference generator — one source of truth for every factory knob.
//
// The factory is configured by environment variables. Their defaults live in
// runner/factory.config.sh (`: "${NAME:=default}"` lines), the dashboard's
// UI-editable subset lives in packages/dispatch/src/api/settings.ts
// (SETTING_DEFS), and the code that consumes them is spread over runner/ and
// packages/*. Nothing joined those three views, so the docs drifted from the
// code. This script derives docs/CONFIG.md from the code and fails CI (--check)
// when the committed reference no longer matches.
//
//   node scripts/config-reference.mjs           # write docs/CONFIG.md
//   node scripts/config-reference.mjs --check   # exit 1 if docs/CONFIG.md is stale
//
// Requires packages/dispatch to be built (reads dist/api/settings.js).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_SH = path.join(ROOT, "runner", "factory.config.sh");
const SETTINGS_JS = path.join(ROOT, "packages", "dispatch", "dist", "api", "settings.js");
const OUT = path.join(ROOT, "docs", "CONFIG.md");

// A config default line: `: "${NAME:=default}"   # trailing comment`
const DEFAULT_RE = /^\s*:\s*"\$\{([A-Za-z_][A-Za-z0-9_]*):?=(.*)\}"\s*(?:#\s*(.*))?$/;
// A section banner: `# ── Title ────` or `# --- Title ---` (top-level comments only)
const SECTION_RE = /^#\s*(?:──|---)\s*(.+?)\s*[─-]*\s*$/;
// Internal helpers that are set by the config for its own use, not operator knobs.
const INTERNAL = new Set(["RUNNER_DIR"]);
// Env var reads in TS/JS: process.env.X, process.env["X"], env.X, env["X"].
const ENV_READ_RE = /\b(?:process\.)?env(?:\.([A-Z][A-Z0-9_]+)|\[["']([A-Z][A-Z0-9_]+)["']\])/g;
// Env var reads in bash: ${X:-…}, ${X}, ${X+x} … — only factory-prefixed names.
const SH_READ_RE = /\$\{([A-Z][A-Z0-9_]+)[-:}+]/g;
// A name the code ASSIGNS somewhere is plumbing it sets for itself, not an input.
const ASSIGN_RE =
  /(?:^|[\s;(])(?:export\s+|local\s+|readonly\s+)?([A-Z][A-Z0-9_]+)=|printf -v "?([A-Z][A-Z0-9_]+)|\benv\.([A-Z][A-Z0-9_]+)\s*=[^=]|\[["']([A-Z][A-Z0-9_]+)["']\]\s*=[^=]/gm;
const KNOB_PREFIX_RE =
  /^(GAFFER_|DISPATCH_|MEMORY_|CREW_|STRICT_|SANDBOX_|MERGE_|AUTO_|REVIEW_|MAX_|HYGIENE_|OVERSIZED_|MINIMALISM_)/;

/** Parse factory.config.sh into ordered knob definitions (first definition wins). */
export function parseConfigDefaults(text) {
  const lines = text.split("\n");
  const knobs = new Map();
  let section = "Locations & wiring";
  let commentBlock = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sec = line.match(SECTION_RE);
    if (sec) {
      section = sec[1].replace(/\s*\(.*?\)\s*$/, "").trim();
      commentBlock = [];
      continue;
    }
    if (/^\s*#/.test(line)) {
      commentBlock.push(line.replace(/^\s*#\s?/, ""));
      continue;
    }
    const m = line.match(DEFAULT_RE);
    if (!m) {
      if (line.trim() !== "") commentBlock = [];
      continue;
    }
    const [, name, def, trailing] = m;
    const indented = /^\s/.test(line);
    if (INTERNAL.has(name)) {
      commentBlock = [];
      continue;
    }
    // A top-level `: "${K:=…}"` is THE default. Indented ones sit inside a
    // GAFFER_MODE case branch (mode fills) or an if/else — keep the first of those
    // only while no top-level line has defined the knob, and flag it.
    const prev = knobs.get(name);
    if (prev && (prev.topLevel || indented)) {
      commentBlock = [];
      continue;
    }
    const doc = (trailing ?? "").trim() || firstSentence(commentBlock);
    knobs.set(name, {
      name,
      default: def,
      doc: doc || prev?.doc || "",
      section,
      line: i + 1,
      topLevel: !indented,
      derived: /\$\{|\$\(|\$[A-Za-z_]/.test(def),
    });
    commentBlock = [];
  }
  return [...knobs.values()];
}

function firstSentence(block) {
  const text = block.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const m = text.match(/^(.{0,220}?[.!?])(\s|$)/);
  return (m ? m[1] : text.slice(0, 220)).trim();
}

/** Walk a tree collecting source files (no tests, dist, node_modules). */
function sourceFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir)) {
    if (ent === "node_modules" || ent === "dist" || ent === "test" || ent === "coverage") continue;
    if (ent.endsWith(".test.ts") || ent.endsWith(".test.mjs") || ent.endsWith(".test.sh")) continue;
    const p = path.join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|mjs|js|sh)$/.test(ent) || ent === "gaffer") out.push(p);
  }
  return out;
}

/** Which consumers mention each identifier, plus env reads not defined anywhere. */
export function scanConsumers(root, knobNames) {
  const areas = {
    runner: [path.join(root, "runner")],
    dispatch: [path.join(root, "packages", "dispatch", "src")],
    memory: [path.join(root, "packages", "memory", "src")],
    crew: [path.join(root, "packages", "crew", "src")],
  };
  const consumers = new Map(knobNames.map((n) => [n, new Set()]));
  const reads = new Map();
  const assigned = new Set();
  for (const [area, dirs] of Object.entries(areas)) {
    for (const dir of dirs) {
      for (const file of sourceFiles(dir)) {
        let text = readFileSync(file, "utf8");
        if (file === CONFIG_SH) {
          text = text
            .split("\n")
            .filter((l) => !DEFAULT_RE.test(l))
            .join("\n");
        }
        for (const name of knobNames) {
          if (new RegExp(`\\b${name}\\b`).test(text)) consumers.get(name).add(area);
        }
        for (const m of text.matchAll(ASSIGN_RE)) assigned.add(m[1] ?? m[2] ?? m[3] ?? m[4]);
        const isShell = file.endsWith(".sh") || file.endsWith("/gaffer");
        const matches = isShell ? text.matchAll(SH_READ_RE) : text.matchAll(ENV_READ_RE);
        for (const m of matches) {
          const name = m[1] ?? m[2];
          if (!name || consumers.has(name) || !KNOB_PREFIX_RE.test(name)) continue;
          if (!reads.has(name)) reads.set(name, new Set());
          reads.get(name).add(path.relative(root, file));
        }
      }
    }
  }
  // Read but never assigned anywhere in the codebase ⇒ an input only the operator can set.
  const undocumented = new Map([...reads].filter(([name]) => !assigned.has(name)));
  return { consumers, undocumented };
}

async function loadSettingDefs() {
  if (!existsSync(SETTINGS_JS)) {
    throw new Error(`${path.relative(ROOT, SETTINGS_JS)} missing — run \`pnpm -r build\` first`);
  }
  const mod = await import(pathToFileURL(SETTINGS_JS).href);
  return mod.SETTING_DEFS;
}

function code(s) {
  return s === "" ? "_(empty)_" : `\`${s.replace(/`/g, "\\`")}\``;
}

function cell(s) {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

export function render({ knobs, defs, consumers, undocumented }) {
  const defByKey = new Map(defs.map((d) => [d.key, d]));
  const knobByName = new Map(knobs.map((k) => [k.name, k]));
  const out = [];
  out.push("# Configuration reference");
  out.push("");
  out.push(
    "<!-- GENERATED by scripts/config-reference.mjs from runner/factory.config.sh and",
    "     packages/dispatch/src/api/settings.ts — do not edit by hand. CI runs",
    "     `node scripts/config-reference.mjs --check`; regenerate with the same command",
    "     without the flag. -->",
    "",
  );
  out.push(
    "Every factory knob is an environment variable. Precedence, highest first:",
    "",
    "1. a real environment variable exported before the runner starts;",
    "2. an explicit key in `$GAFFER_DATA/settings.json` (the dashboard Settings panel);",
    "3. the default the selected `GAFFER_MODE` fills in for its autonomy cluster;",
    "4. the built-in default from `runner/factory.config.sh`, listed below.",
    "",
    "**UI** marks a knob the dashboard Settings panel can edit (it persists to",
    "`settings.json`; an exported env var locks it read-only). **Read by** names the",
    "components whose source mentions the identifier. A default shown as _derived_ is",
    "computed from other knobs at runtime.",
    "",
  );

  // Summary counts on their own lines
  const uiKnobs = defs.length;
  const uiOnly = defs.filter((d) => !knobByName.has(d.key));
  out.push("| Metric | Count |", "|---|---|");
  out.push(`| Knobs with a runner default | ${knobs.length} |`);
  out.push(`| Knobs editable in the dashboard | ${uiKnobs} |`);
  out.push(
    `| Dashboard knobs with no runner default (consumed by dispatch/memory/crew) | ${uiOnly.length} |`,
  );
  out.push(`| Env reads in code with no default and no UI entry | ${undocumented.size} |`);
  out.push("");

  // Group by section, in file order
  const sections = [];
  for (const k of knobs) {
    let s = sections.find((x) => x.title === k.section);
    if (!s) sections.push((s = { title: k.section, knobs: [] }));
    s.knobs.push(k);
  }
  out.push("## Runner defaults (`runner/factory.config.sh`)", "");
  for (const s of sections) {
    out.push(`### ${s.title}`, "");
    out.push("| Variable | Default | UI | Read by | Notes |", "|---|---|---|---|---|");
    for (const k of s.knobs) {
      const def = defByKey.get(k.name);
      const ui = def ? `yes (${def.type}${def.choices ? `: ${def.choices.join(" / ")}` : ""})` : "";
      const readBy = [...(consumers.get(k.name) ?? [])].sort().join(", ");
      const note = def?.help ? def.help : k.doc;
      let dflt = k.derived ? `_derived_ (${code(k.default)})` : code(k.default);
      if (!k.topLevel) dflt += " _(set by branch/mode logic)_";
      out.push(`| \`${k.name}\` | ${cell(dflt)} | ${ui} | ${readBy} | ${cell(note)} |`);
    }
    out.push("");
  }

  out.push("## Dashboard-only settings", "");
  out.push(
    "These have a Settings-panel entry but no `factory.config.sh` default: the",
    "consuming component applies its own default when the variable is unset.",
    "",
  );
  out.push("| Variable | Type | Group | Read by | Help |", "|---|---|---|---|---|");
  for (const d of uiOnly) {
    const readBy = [...(consumers.get(d.key) ?? [])].sort().join(", ");
    const type = `${d.type}${d.choices ? `: ${d.choices.join(" / ")}` : ""}`;
    out.push(`| \`${d.key}\` | ${type} | ${d.group} | ${readBy} | ${cell(d.help ?? d.label)} |`);
  }
  out.push("");

  out.push("## Env reads without a default or UI entry", "");
  out.push(
    "Factory-prefixed identifiers the code reads from the environment and never",
    "assigns itself, with neither a `factory.config.sh` default nor a Settings-panel",
    "entry — so only an operator (or a test) can set them. Each is either a",
    "deliberate advanced/test-only override or a knob missing its default line or",
    "`SETTING_DEFS` entry.",
    "",
  );
  out.push("| Variable | Read in |", "|---|---|");
  for (const [name, files] of [...undocumented.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(
      `| \`${name}\` | ${[...files]
        .sort()
        .map((f) => `\`${f}\``)
        .join(", ")} |`,
    );
  }
  out.push("");
  return out.join("\n");
}

export async function generate(root = ROOT) {
  const knobs = parseConfigDefaults(readFileSync(CONFIG_SH, "utf8"));
  const defs = await loadSettingDefs();
  const names = [...new Set([...knobs.map((k) => k.name), ...defs.map((d) => d.key)])];
  const { consumers, undocumented } = scanConsumers(root, names);
  return render({ knobs, defs, consumers, undocumented });
}

async function main(argv) {
  const check = argv.includes("--check");
  const text = await generate();
  if (check) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== text) {
      console.error(`docs/CONFIG.md is stale — regenerate with: node scripts/config-reference.mjs`);
      process.exit(1);
    }
    console.log("docs/CONFIG.md is up to date");
    return;
  }
  writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
