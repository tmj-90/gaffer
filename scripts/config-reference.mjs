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
/** Every file whose `: "${NAME:=default}"` lines define a knob: the config plus the runner libs. */
function defaultFiles() {
  const libDir = path.join(ROOT, "runner", "lib");
  const libs = existsSync(libDir)
    ? readdirSync(libDir)
        .filter((f) => f.endsWith(".sh"))
        .sort()
        .map((f) => path.join(libDir, f))
    : [];
  return [CONFIG_SH, ...libs];
}
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
// `: "${X:=v}"` / `: "${X=v}"` in ANY shell file also assigns X (a default line).
const COLON_ASSIGN_RE = /\$\{([A-Z][A-Z0-9_]+):?=/g;
const ASSIGN_RE =
  /(?:^|[\s;(])(?:export\s+|local\s+|readonly\s+)?([A-Z][A-Z0-9_]+)=|printf -v "?([A-Z][A-Z0-9_]+)|\benv\.([A-Z][A-Z0-9_]+)\s*=[^=]|\[["']([A-Z][A-Z0-9_]+)["']\]\s*=[^=]/gm;
const KNOB_PREFIX_RE =
  /^(GAFFER_|DISPATCH_|MEMORY_|CREW_|STRICT_|SANDBOX_|MERGE_|AUTO_|REVIEW_|MAX_|HYGIENE_|OVERSIZED_|MINIMALISM_)/;

/**
 * Parse one shell file's `: "${NAME:=default}"` lines into ordered knob definitions
 * (first definition wins). `fixedSection` pins every knob to one section title (used
 * for runner/lib/*.sh, whose banners are not config sections).
 */
export function parseConfigDefaults(text, { fixedSection = null } = {}) {
  const lines = text.split("\n");
  const knobs = new Map();
  let section = fixedSection ?? "Locations & wiring";
  let commentBlock = [];
  // Inside a `case` arm: is it the DEFAULT arm (`*)`)? Its fill is what a knob is when
  // nothing selects another arm (the GAFFER_MODE presets: `*)` is supervised), so it is
  // the default to report — not whichever arm happens to come first in the file.
  let defaultArm = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const arm = line.match(/^\s+([^\s#()][^#()]*)\)\s*(?:#.*)?$/);
    if (arm) {
      defaultArm = arm[1].trim() === "*";
      continue;
    }
    if (/^\s*(?:;;|esac\b)/.test(line)) defaultArm = false;
    const sec = fixedSection ? null : line.match(SECTION_RE);
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
    // ...except that a default-arm fill replaces an earlier non-default arm's.
    const takeDefaultArm = prev && !prev.topLevel && !prev.defaultArm && indented && defaultArm;
    if (prev && (prev.topLevel || indented) && !takeDefaultArm) {
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
      defaultArm: indented && defaultArm,
      derived: /\$\{|\$\(|\$[A-Za-z_]/.test(def),
    });
    commentBlock = [];
  }
  return [...knobs.values()];
}

/** A description longer than this is cut, at a word, and marked with an ellipsis. */
const DOC_LIMIT = 220;
/**
 * The first sentence of a comment block, for the Notes column. A first sentence
 * longer than DOC_LIMIT is cut at the last word that fits and marked "…" (it used
 * to be sliced at character 220, so six descriptions stopped mid-word).
 */
export function firstSentence(block) {
  const text = block.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const m = text.match(new RegExp(`^(.{0,${DOC_LIMIT}}?[.!?])(\\s|$)`));
  if (m) return m[1].trim();
  if (text.length <= DOC_LIMIT) return text;
  const head = text.slice(0, DOC_LIMIT + 1);
  const space = head.lastIndexOf(" ");
  const cut = space > 0 ? head.slice(0, space) : text.slice(0, DOC_LIMIT);
  return `${cut.replace(/[\s,;:(—-]+$/, "")}…`;
}

/**
 * Knobs the code reads where it uses them, with no `: "${X:=…}"` default line and
 * no Settings entry, so the scan above cannot find them: either the runner assigns
 * them itself as well (an internal seam an operator can still export), or they are
 * not factory-prefixed (credentials, the demo path). Each names the file whose read
 * site holds the default; generate() fails if the name is no longer read there or
 * if that file's inline default (`${X:-v}` / `?? v`) no longer matches.
 * `verify: false` marks a default that is another variable, not a literal.
 */
export const EXTRA_KNOBS = [
  {
    group: "Safety and containment",
    name: "GAFFER_STRICT_REQUIRE",
    default: "0",
    file: "runner/lib/sandbox.sh",
    doc: "1 = refuse to launch an agent without an OS sandbox (fail closed). Unset, factory.config.sh turns it on whenever an autonomy flag, an autonomous/strict/lite mode or an `auto` policy row is on; set 0 explicitly only if you contain the whole runner yourself (a VM or container).",
  },
  {
    group: "Safety and containment",
    name: "GAFFER_SANDBOX_IMAGE",
    default: "gaffer-sandbox:latest",
    file: "runner/lib/sandbox-docker.sh",
    doc: "The image the docker sandbox provider runs each delivery in (`docker compose --profile sandbox build` builds it).",
  },
  {
    group: "Safety and containment",
    name: "GAFFER_SANDBOX_PROFILE",
    default: "",
    file: "runner/lib/sandbox-docker.sh",
    doc: "Set by the runner, not by you: `validation` runs the DoD gates and criterion checks in the docker sandbox with no data plane. Empty is the agent profile.",
  },
  {
    group: "Definition of Done",
    name: "GAFFER_DOD",
    default: "1",
    file: "runner/lib/dod.sh",
    doc: "0 turns every Definition-of-Done gate off, the only way to land a delivery ungated (the merge gate is off too).",
  },
  {
    group: "Definition of Done",
    name: "GAFFER_DOD_INSTALL",
    default: "1",
    file: "runner/lib/dod.sh",
    doc: "1 = install the delivery worktree's dependencies (from its lockfile) before the test gate; a no-op when node_modules exists. 0 to manage dependencies yourself.",
  },
  {
    group: "Definition of Done",
    name: "GAFFER_GREENFIELD_INSTALL",
    default: "1",
    file: "runner/lib/greenfield.sh",
    doc: "0 = skip the dependency install in a new greenfield repo; also turns GAFFER_DOD_INSTALL off.",
  },
  {
    group: "Definition of Done",
    name: "GAFFER_ALLOW_NO_DOD",
    default: "0",
    file: "runner/tick.sh",
    doc: "1 = let a delivery pass when no gate ran at all (a repo with no test or lint command). Otherwise that is a failure and the ticket parks.",
  },
  {
    group: "Definition of Done",
    name: "GAFFER_CI_TIMEOUT_POLICY",
    default: "block",
    file: "runner/lib/ci-gate.sh",
    doc: "With GAFFER_REQUIRE_CI=1: what happens when the checks time out, there is no PR or no checks exist. block rejects the delivery; proceed lets it through with a note.",
  },
  {
    group: "Delivery and landing",
    name: "GAFFER_KEEP_DELIVERY_BRANCH",
    default: "0",
    file: "runner/tick.sh",
    doc: "Raised by the tick once a delivery's branch is review-visible, so cleanup removes the worktree but never the branch. Exporting 1 keeps every delivery branch (debugging only).",
  },
  {
    group: "Delivery and landing",
    name: "GAFFER_PAUSE_KEEP_WORKTREE",
    default: "0",
    file: "runner/tick.sh",
    doc: "Raised by the tick when a delivery pauses on a cap, so its worktree and branch survive for Continue. Exporting 1 keeps every worktree (debugging only).",
  },
  {
    group: "Delivery and landing",
    name: "GAFFER_DIGEST_DISABLE",
    default: "0",
    file: "runner/lib/land.sh",
    doc: "1 = skip the repo digest and feature-ledger refresh after a merge lands.",
  },
  {
    group: "Delivery and landing",
    name: "GAFFER_MEMORY_AUTO_PROMOTE",
    default: "MEMORY_AUTO_APPROVE",
    verify: false,
    file: "runner/tick.sh",
    doc: "1 = a requirement distilled from a delivered ticket goes live at once; 0 = it lands as a draft for `memory review`. Unset, it follows MEMORY_AUTO_APPROVE.",
  },
  {
    group: "Onboarding and demo",
    name: "GAFFER_VERBOSE",
    default: "",
    file: "runner/bin/onboard-run.mjs",
    doc: "1 = `gaffer onboard` prints its full log instead of the summary (the log is always in $GAFFER_DATA/onboard.log).",
  },
  {
    group: "Onboarding and demo",
    name: "DEMO_DIR",
    default: "",
    file: "runner/demo.sh",
    doc: "Where `gaffer demo` builds its throwaway showcase factory. Empty = a fresh temp dir per run. A named dir must be empty or a previous demo's (it is cleared); anything else is refused.",
  },
  {
    group: "Credentials",
    name: "ANTHROPIC_API_KEY",
    default: "",
    file: "runner/preflight.sh",
    doc: "An API key for the worker CLI (`claude`). One of this, CLAUDE_CODE_OAUTH_TOKEN or a logged-in CLAUDE_CONFIG_DIR is needed for a live run; the container reads only these two variables.",
  },
  {
    group: "Credentials",
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    default: "",
    file: "runner/preflight.sh",
    doc: "The subscription token `claude setup-token` prints, used instead of an API key.",
  },
  {
    group: "Credentials",
    name: "CLAUDE_CONFIG_DIR",
    default: "$HOME/.claude",
    file: "runner/lib/claude-auth.sh",
    doc: "Where the worker CLI keeps its login (`.credentials.json`); preflight looks there for a credential.",
  },
];

/** Fail when an EXTRA_KNOBS entry no longer matches the code it names. */
export function verifyExtraKnobs(root = ROOT, extras = EXTRA_KNOBS) {
  const problems = [];
  for (const k of extras) {
    const file = path.join(root, k.file);
    if (!existsSync(file)) {
      problems.push(`${k.name}: ${k.file} does not exist`);
      continue;
    }
    const text = readFileSync(file, "utf8");
    if (!new RegExp(`\\b${k.name}\\b`).test(text)) {
      problems.push(`${k.name}: no longer read in ${k.file}`);
      continue;
    }
    if (k.verify === false) continue;
    const isShell = !/\.(mjs|js|ts)$/.test(k.file);
    const re = isShell
      ? new RegExp(`\\$\\{${k.name}:-`, "g")
      : new RegExp(`(?:process\\.)?env(?:\\.${k.name}\\b|\\[["']${k.name}["']\\])`, "g");
    const seen = new Set();
    for (const m of text.matchAll(re)) {
      const d = readSiteDefault(text, m.index, k.name, isShell);
      if (d !== null) seen.add(d);
    }
    if (seen.size > 0 && !seen.has(k.default)) {
      problems.push(
        `${k.name}: documented default ${JSON.stringify(k.default)} but ${k.file} falls back to ${[...seen].map((v) => JSON.stringify(v)).join(" / ")}`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `EXTRA_KNOBS in scripts/config-reference.mjs drifted from the code:\n  ${problems.join("\n  ")}`,
    );
  }
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
  const defaultFileSet = new Set(defaultFiles());
  const areas = {
    runner: [path.join(root, "runner")],
    dispatch: [path.join(root, "packages", "dispatch", "src")],
    memory: [path.join(root, "packages", "memory", "src")],
    crew: [path.join(root, "packages", "crew", "src")],
  };
  const consumers = new Map(knobNames.map((n) => [n, new Set()]));
  const reads = new Map();
  const defaults = new Map(); // name → Set of in-code fallback literals seen at read sites
  const assigned = new Set();
  for (const [area, dirs] of Object.entries(areas)) {
    for (const dir of dirs) {
      for (const file of sourceFiles(dir)) {
        let text = readFileSync(file, "utf8");
        if (defaultFileSet.has(file)) {
          // A knob's own default line is its definition, not a consumer read.
          text = text
            .split("\n")
            .filter((l) => !DEFAULT_RE.test(l))
            .join("\n");
        }
        for (const name of knobNames) {
          if (new RegExp(`\\b${name}\\b`).test(text)) consumers.get(name).add(area);
        }
        for (const m of text.matchAll(ASSIGN_RE)) assigned.add(m[1] ?? m[2] ?? m[3] ?? m[4]);
        for (const m of text.matchAll(COLON_ASSIGN_RE)) assigned.add(m[1]);
        const isShell = file.endsWith(".sh") || file.endsWith("/gaffer");
        const matches = isShell ? text.matchAll(SH_READ_RE) : text.matchAll(ENV_READ_RE);
        for (const m of matches) {
          const name = m[1] ?? m[2];
          if (!name || consumers.has(name) || !KNOB_PREFIX_RE.test(name)) continue;
          if (!reads.has(name)) reads.set(name, new Set());
          reads.get(name).add(path.relative(root, file));
          const dflt = readSiteDefault(text, m.index, name, isShell);
          if (dflt !== null) {
            if (!defaults.has(name)) defaults.set(name, new Set());
            defaults.get(name).add(dflt);
          }
        }
      }
    }
  }
  // Read but never assigned anywhere in the codebase ⇒ an input only the operator can set.
  const undocumented = new Map([...reads].filter(([name]) => !assigned.has(name)));
  return { consumers, undocumented, defaults };
}

/**
 * The fallback literal at one read site, or null when the read has no inline
 * default. Shell: `${NAME:-value}`. TS/JS: `process.env.NAME ?? <literal>` or
 * `|| <literal>` (string / number / boolean literal only; computed values skip).
 */
export function readSiteDefault(text, index, name, isShell) {
  if (isShell) {
    const m = text.slice(index, index + name.length + 300).match(/^\$\{[A-Z0-9_]+:-([^}]*)\}/);
    return m ? m[1] : null;
  }
  const after = text.slice(index, index + name.length + 120);
  const m = after.match(
    /^(?:process\.)?env(?:\.[A-Z0-9_]+|\[["'][A-Z0-9_]+["']\])\s*(?:\?\?|\|\|)\s*("[^"]*"|'[^']*'|-?\d+(?:\.\d+)?|true|false)/,
  );
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, "");
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

export function render({
  knobs,
  defs,
  consumers,
  undocumented,
  defaults = new Map(),
  extras = [],
}) {
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
  out.push("## Runner defaults (`runner/factory.config.sh` and `runner/lib/*.sh`)", "");
  for (const s of sections) {
    out.push(`### ${s.title}`, "");
    out.push("| Variable | Default | UI | Read by | Notes |", "|---|---|---|---|---|");
    for (const k of s.knobs) {
      const def = defByKey.get(k.name);
      const ui = def ? `yes (${def.type}${def.choices ? `: ${def.choices.join(" / ")}` : ""})` : "";
      const readBy = [...(consumers.get(k.name) ?? [])].sort().join(", ");
      const note = def?.help ? def.help : k.doc;
      let dflt = k.derived ? `_derived_ (${code(k.default)})` : code(k.default);
      if (k.defaultArm) dflt += " _(the default; other modes/branches can set it)_";
      else if (!k.topLevel) dflt += " _(set by branch/mode logic)_";
      out.push(`| \`${k.name}\` | ${cell(dflt)} | ${ui} | ${readBy} | ${cell(note)} |`);
    }
    out.push("");
  }

  if (extras.length > 0) {
    out.push("## Read where they are used", "");
    out.push(
      "These have no `factory.config.sh` default line: the code that uses each one",
      "applies the default below at its read site (the file named under **Read in**).",
      "Some are seams the runner also sets for itself; the notes say which.",
      "",
    );
    const groups = [];
    for (const k of extras) {
      let g = groups.find((x) => x.title === k.group);
      if (!g) groups.push((g = { title: k.group, knobs: [] }));
      g.knobs.push(k);
    }
    for (const g of groups) {
      out.push(`### ${g.title}`, "");
      out.push("| Variable | Default | Read in | Notes |", "|---|---|---|---|");
      for (const k of g.knobs) {
        const dflt = k.verify === false ? `_follows_ \`${k.default}\`` : code(k.default);
        out.push(`| \`${k.name}\` | ${cell(dflt)} | \`${k.file}\` | ${cell(k.doc)} |`);
      }
      out.push("");
    }
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
    "`SETTING_DEFS` entry. **Default in code** is the fallback literal at the read",
    "site (`${X:-…}` / `?? …`); two values means the read sites disagree.",
    "",
  );
  out.push("| Variable | Default in code | Read in |", "|---|---|---|");
  for (const [name, files] of [...undocumented.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const d = [...(defaults.get(name) ?? [])].sort();
    const dflt = d.length ? d.map((v) => code(v)).join(" / ") : "";
    out.push(
      `| \`${name}\` | ${cell(dflt)} | ${[...files]
        .sort()
        .map((f) => `\`${f}\``)
        .join(", ")} |`,
    );
  }
  out.push("");
  return out.join("\n");
}

export async function generate(root = ROOT) {
  const seen = new Set();
  const knobs = [];
  for (const file of defaultFiles()) {
    const opts = file === CONFIG_SH ? {} : { fixedSection: `lib/${path.basename(file)}` };
    for (const k of parseConfigDefaults(readFileSync(file, "utf8"), opts)) {
      if (seen.has(k.name)) continue; // factory.config.sh wins over a lib re-default
      seen.add(k.name);
      knobs.push(k);
    }
  }
  const defs = await loadSettingDefs();
  verifyExtraKnobs(root);
  const extras = EXTRA_KNOBS.filter(
    (k) => !seen.has(k.name) && !defs.some((d) => d.key === k.name),
  );
  const names = [
    ...new Set([
      ...knobs.map((k) => k.name),
      ...defs.map((d) => d.key),
      ...extras.map((k) => k.name),
    ]),
  ];
  const { consumers, undocumented, defaults } = scanConsumers(root, names);
  return render({ knobs, defs, consumers, undocumented, defaults, extras });
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
