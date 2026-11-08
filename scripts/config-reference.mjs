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
/**
 * factory.config.sh sources its parts (runner/config/NN-area.sh) from one "parts block"
 * in a fixed order. The config's text is that file with the block replaced by the
 * parts' bodies (each part's header comment and its last, marker line dropped), in the
 * block's order: the text the file had before it was split, so sections, comment
 * blocks and knob order read exactly as they did. A part the block names but cannot be
 * read, or one without its marker line, is an error (the runner would refuse it too).
 * Returns the text and the part files, in order.
 */
export function configSources(root = ROOT) {
  const configSh = path.join(root, "runner", "factory.config.sh");
  const lines = readFileSync(configSh, "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("# CONFIG PARTS."));
  if (start < 0) return { text: lines.join("\n"), parts: [] };
  const end = lines.indexOf("unset _GAFFER_CONFIG_DIR _GAFFER_CONFIG_PART", start);
  if (end < 0 || lines[end + 1] !== "")
    throw new Error("factory.config.sh: the parts block has no end");
  const parts = [];
  const bodies = [];
  for (const l of lines.slice(start, end)) {
    const m = l.match(/; _gaffer_config_loaded ([0-9]{2}-[a-z-]+)$/);
    if (!m) continue;
    const file = path.join(root, "runner", "config", `${m[1]}.sh`);
    const own = readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
    if (own.at(-1) !== `_GAFFER_CONFIG_PART=${m[1]}`) {
      throw new Error(`runner/config/${m[1]}.sh: the last line is not its marker`);
    }
    parts.push(file);
    bodies.push(...own.slice(own.indexOf("") + 1, -1));
  }
  return { text: [...lines.slice(0, start), ...bodies, ...lines.slice(end + 2)].join("\n"), parts };
}
/** The runner libs (runner/lib/*.sh), sorted. */
function libFiles(root = ROOT) {
  const libDir = path.join(root, "runner", "lib");
  return existsSync(libDir)
    ? readdirSync(libDir)
        .filter((f) => f.endsWith(".sh"))
        .sort()
        .map((f) => path.join(libDir, f))
    : [];
}
/** Every file whose `: "${NAME:=default}"` lines define a knob: the config (and its parts) plus the runner libs. */
function defaultFiles(root = ROOT) {
  return [
    path.join(root, "runner", "factory.config.sh"),
    ...configSources(root).parts,
    ...libFiles(root),
  ];
}
const SETTINGS_JS = path.join(ROOT, "packages", "dispatch", "dist", "api", "settings.js");
const OUT = path.join(ROOT, "docs", "CONFIG.md");

// A config default line: `: "${NAME:=default}"   # trailing comment`
const DEFAULT_RE = /^\s*:\s*"\$\{([A-Za-z_][A-Za-z0-9_]*):?=(.*)\}"\s*(?:#\s*(.*))?$/;
// A section banner: `# ── Title ────` or `# --- Title ---` (top-level comments only)
const SECTION_RE = /^#\s*(?:──|---)\s*(.+?)\s*[─-]*\s*$/;
// Internal helpers that are set by the config for its own use, not operator knobs.
// GAFFER_MINIMALISM_REASON: the minimalism gate's own `set -u` belt in the attempt loop
// (runner/lib/tick-gates.sh, moved there from tick.sh, which this scan does not read).
const INTERNAL = new Set(["RUNNER_DIR", "GAFFER_MINIMALISM_REASON"]);
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
    default: "1",
    file: "runner/lib/sandbox.sh",
    doc: "1 (the default, in every mode) = every agent launch runs inside the OS sandbox or is refused (fail closed): `gaffer run`, the loop, a tick and the dashboard's Poll for work refuse before claiming anything, with the fix. 0 (or false/no/off) in the ENVIRONMENT is the opt-out, for a runner you contain yourself (a VM or container): agents then run unwrapped, and it is said once per process. settings.json cannot set 0.",
  },
  {
    group: "Safety and containment",
    name: "GAFFER_SANDBOX_IMAGE",
    default: "gaffer-sandbox:latest",
    file: "runner/lib/sandbox-docker.sh",
    doc: "The image the docker sandbox provider runs each delivery in (`docker compose --profile sandbox build` builds it).",
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
    file: "runner/lib/tick-gates.sh",
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
    name: "GAFFER_MEMORY_AUTO_PROMOTE",
    default: "MEMORY_AUTO_APPROVE",
    verify: false,
    file: "runner/lib/tick-close.sh",
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

/**
 * Names the code reads that are NOT operator knobs, grouped by why. They keep working
 * (a test or another component still sets them), but docs/CONFIG.md names them in one
 * short "Internal names" section instead of a table row each, so the tables hold only
 * what an operator would set. A name here must still occur in the source
 * (verifyInternalNames); a group's title says why its names are not knobs.
 */
export const INTERNAL_NAMES = [
  {
    group: "paths",
    title:
      "Paths derived from GAFFER_HOME, GAFFER_DATA or the runner directory; set GAFFER_HOME / GAFFER_DATA instead (a test may point one elsewhere)",
    names: [
      "DISPATCH_DIR",
      "CREW_DIR",
      "MEMORY_DIR",
      "DISPATCH_DB",
      "MEMORY_DB",
      "CREW_CONFIG",
      "MEMORY_AUDIT_LOG",
      "MCP_CONFIG",
      "CLAUDE_SETTINGS",
      "SKILLS_DIR",
      "GAFFER_MODEL_REGISTRY",
      "GAFFER_AGENT_ID_FILE",
      "GAFFER_REVIEWER_ID_FILE",
      "GAFFER_LOG",
      "DAILY_COUNTER_FILE",
      "GAFFER_USAGE_LEDGER",
      "MEMORY_CLI_BIN",
      "MEMORY_MCP_BIN",
      "DISPATCH_MCP_BIN",
      "GAFFER_GH_BIN",
      "DISPATCH_CLI",
      "DISPATCH_CLI_BIN",
      "MEMORY_CLI",
      "GAFFER_BLOCK_LEDGER",
      "GAFFER_BP_FILE",
      "GAFFER_EVAL_LEDGER",
      "GAFFER_SKILL_TELEMETRY",
      "GAFFER_USAGE_PAUSE_FILE",
      "GAFFER_EGRESS_ALLOW_FILE",
      "GAFFER_SAFETY_HOOK",
    ],
  },
  {
    group: "derived",
    title: "Computed from other knobs each time the config loads; set the knob they come from",
    names: [
      "GAFFER_CLAIM_TTL",
      "GAFFER_TICK_OUTER_TIMEOUT",
      "GAFFER_POLL_WAIT_TIMEOUT",
      "GAFFER_DOD_INSTALL_TIMEOUT",
      "GAFFER_DOD_FEEDBACK_LINES",
    ],
  },
  {
    group: "plumbing",
    title:
      "Set by the runner for a child process, the dashboard, an MCP server or the safety hook, never by you",
    names: [
      "DISPATCH_PRODUCT_OWNER_CMD",
      "DISPATCH_ONBOARD_CMD",
      "DISPATCH_EPIC_FEATURE_CMD",
      "DISPATCH_ONBOARD_NAME",
      "DISPATCH_CORRELATION_ID",
      "GAFFER_CLAIM_TOKEN",
      "GAFFER_REVIEW_TICKET",
      "GAFFER_DEFAULT_TICKET_REPO",
      "GAFFER_TICKET",
      "GAFFER_KEEP_DELIVERY_BRANCH",
      "GAFFER_PAUSE_KEEP_WORKTREE",
      "GAFFER_SANDBOX_PROFILE",
      "GAFFER_UNIVERSAL_SKILLS",
      "GAFFER_CLAUDE_VERSION",
    ],
  },
  {
    group: "packages",
    title:
      "Read inside the dispatch, memory and crew packages on their own (packages/*/README.md); the runner never needs them",
    names: [
      "DISPATCH_AGENT_ID",
      "DISPATCH_AUDIT",
      "DISPATCH_AUDIT_OFF",
      "DISPATCH_PID_FILE",
      "DISPATCH_SENSITIVE_PATH_RE",
      "DISPATCH_LARGE_DELETION_LINES",
      "DISPATCH_OBSERVED_RISK_CEILING",
      "GAFFER_ACCEPTANCE_PROFILE_SEED",
      "GAFFER_TEST_PATH_RE",
      "MEMORY_AUDIT_OFF",
      "MEMORY_NO_COLOR",
      "MEMORY_REVIEW_NUDGE_EVERY_TIME",
    ],
  },
  {
    group: "sandbox",
    title:
      "Inside-the-image details of the docker sandbox provider (runner/lib/sandbox-docker.sh, docs/sandbox.md)",
    names: [
      "GAFFER_SANDBOX_CLAUDE_BIN",
      "GAFFER_SANDBOX_CLAUDE_CREDENTIALS",
      "GAFFER_SANDBOX_HOME",
      "GAFFER_SANDBOX_PATH",
      "GAFFER_SANDBOX_NET_INT",
      "GAFFER_SANDBOX_NET_UP",
      "GAFFER_SANDBOX_PROXY",
      "GAFFER_SANDBOX_PROXY_IMAGE",
    ],
  },
];

/**
 * Test seams: names the code reads only so a test can shorten a wait, point a command
 * at a stub, skip slow bookkeeping or fix the clock. Nothing in the runner sets one and
 * no operator needs to: the built-in value is the one to run with. Listed by name in
 * one line, never as rows (verifyInternalNames fails when one is no longer read). The
 * ones the config used to default assign themselves plainly, like the internal names.
 */
export const TEST_SEAMS = [
  "GAFFER_DOD_OUTPUT_TAIL",
  "GAFFER_DOD_RERUN_WAIT",
  "GAFFER_DAEMON_MAX_CYCLES",
  "GAFFER_DAEMON_SETUP_BACKOFF_MAX",
  "GAFFER_TICK_DEADLINE_MARGIN",
  "GAFFER_REAP_GRACE",
  "GAFFER_LOCK_TIMEOUT",
  "GAFFER_LOCK_STALE",
  "GAFFER_REGISTRY_PROBE_TIMEOUT",
  "GAFFER_DIGEST_DISABLE",
  "GAFFER_USAGE_PAUSE_POLL_SECS",
  "GAFFER_TODAY_OVERRIDE",
  "GAFFER_CONTEXT_DUMP_DIR",
  "GAFFER_WG_LIST_CMD",
  "GAFFER_WG_SHOW_CMD",
  "GAFFER_WG_DELIVERIES_CMD",
  "GAFFER_TRUST_LOCK_TRIES",
  "GAFFER_TRUST_LOCK_SLEEP_MS",
  "GAFFER_TRUST_WORKTREE_ROOT",
  "GAFFER_CARD_BATCH",
  "GAFFER_CARD_SNIPPET_CHARS",
  "GAFFER_MERGE_TIMEOUT_MS",
  "GAFFER_REAPPROVAL_BACKOFF_MS",
  "GAFFER_DECOMPOSE_TIMEOUT_MS",
  "GAFFER_PLAN_BUILD_TIMEOUT_MS",
  "GAFFER_TESTER_TIMEOUT_MS",
  "GAFFER_ACCEPTANCE_PORT_BASE",
  "GAFFER_REDACTION_MODULE",
  "DISPATCH_TESTER_VERDICT_CMD",
  "DISPATCH_LANE_VERDICT_CMD",
  "DISPATCH_ACCEPTANCE_EVIDENCE_CMD",
];

/**
 * Deprecated names: old knobs a family collapse replaced. Each still works for one
 * release (the config or the reader maps it onto its replacement and says so once on
 * stderr), so docs/CONFIG.md lists it in a short Deprecated table, never in the main
 * tables. verifyInternalNames fails when one no longer occurs in the source.
 */
export const DEPRECATED = [
  ...[
    ["GAFFER_REVIEW_MAX_TURNS", "review"],
    ["GAFFER_SECURITY_REVIEW_MAX_TURNS", "security_review"],
    ["GAFFER_CLARIFY_MAX_TURNS", "clarify"],
    ["GAFFER_JUDGE_MAX_TURNS", "judge"],
    ["GAFFER_TESTER_MAX_TURNS", "tester"],
    ["GAFFER_MERGE_MAX_TURNS", "merge"],
    ["GAFFER_RESOLVER_MAX_TURNS", "merge"],
    ["GAFFER_PO_MAX_TURNS", "po"],
    ["GAFFER_SCOUT_MAX_TURNS", "scout"],
    ["GAFFER_DECOMPOSE_AGENT_MAX_TURNS", "decompose"],
    ["GAFFER_SPEC_AUTHOR_AGENT_MAX_TURNS", "spec_author"],
    ["GAFFER_ONBOARD_MAX_TURNS", "onboard"],
  ].map(([name, role]) => ({ name, use: `GAFFER_ROLE_MAX_TURNS="${role}=N"` })),
  {
    name: "GAFFER_CAP_DETECT_TURNS",
    use: "`GAFFER_MAX_TURNS` (a call is cap-hit when it uses every turn)",
  },
];

/** Every internal or seam name, for the scans that decide what is a knob. */
export function notKnobNames() {
  return new Set([
    ...INTERNAL_NAMES.flatMap((g) => g.names),
    ...TEST_SEAMS,
    ...DEPRECATED.map((d) => d.name),
  ]);
}

/** Fail when an INTERNAL_NAMES / TEST_SEAMS entry no longer occurs in the source. */
export function verifyInternalNames(root = ROOT) {
  const dirs = ["runner", "packages/dispatch/src", "packages/memory/src", "packages/crew/src"];
  const texts = dirs
    .flatMap((d) => sourceFiles(path.join(root, d)))
    .map((f) => readFileSync(f, "utf8"));
  const problems = [];
  const seen = new Set();
  for (const name of [
    ...INTERNAL_NAMES.flatMap((g) => g.names),
    ...TEST_SEAMS,
    ...DEPRECATED.map((d) => d.name),
  ]) {
    if (seen.has(name)) problems.push(`${name}: listed twice`);
    seen.add(name);
    if (!texts.some((t) => new RegExp(`\\b${name}\\b`).test(t)))
      problems.push(`${name}: no longer occurs in the source (drop it from the list)`);
  }
  if (problems.length > 0) {
    throw new Error(
      `INTERNAL_NAMES / TEST_SEAMS / DEPRECATED in scripts/config-reference.mjs drifted from the code:\n  ${problems.join("\n  ")}`,
    );
  }
}

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
  const defaultFileSet = new Set(defaultFiles(root));
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
  internal = [],
  seams = [],
  deprecated = [],
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

  if (deprecated.length > 0) {
    out.push("## Deprecated", "");
    out.push(
      "These still work for one release: each is mapped onto its replacement and says so",
      "once on stderr. Set the replacement instead.",
      "",
    );
    out.push("| Old name | Use instead |", "|---|---|");
    for (const d of deprecated) out.push(`| \`${d.name}\` | ${cell(d.use)} |`);
    out.push("");
  }

  if (internal.length > 0 || seams.length > 0) {
    out.push("## Internal names (not knobs)", "");
    out.push(
      "The code reads these too, but they are not settings: another component or a test",
      "sets them, or they follow from a knob above. They are listed so a name you meet in",
      "the code is not a mystery; you never need to set one.",
      "",
    );
    for (const g of internal) {
      out.push(`- **${g.group}**: ${g.title}. ${g.names.map((n) => `\`${n}\``).join(", ")}.`);
    }
    if (seams.length > 0) {
      out.push(
        `- **test seams**: read only so a test can shorten a wait, stub a command, skip slow bookkeeping or fix the clock; keep the built-in value. ${seams.map((n) => `\`${n}\``).join(", ")}.`,
      );
    }
    out.push("");
  }
  return out.join("\n");
}

export async function generate(root = ROOT) {
  const seen = new Set();
  const knobs = [];
  for (const file of [CONFIG_SH, ...libFiles(root)]) {
    const opts = file === CONFIG_SH ? {} : { fixedSection: `lib/${path.basename(file)}` };
    const text = file === CONFIG_SH ? configSources(root).text : readFileSync(file, "utf8");
    for (const k of parseConfigDefaults(text, opts)) {
      if (seen.has(k.name)) continue; // factory.config.sh wins over a lib re-default
      seen.add(k.name);
      knobs.push(k);
    }
  }
  const defs = await loadSettingDefs();
  verifyExtraKnobs(root);
  verifyInternalNames(root);
  const notKnobs = notKnobNames();
  const stillDefaulted = knobs.filter((k) => notKnobs.has(k.name)).map((k) => k.name);
  if (stillDefaulted.length > 0) {
    // A `: "${X:=v}"` line is how the config says "this is a knob"; an internal name
    // assigns itself plainly (X="${X:-v}") so code and reference agree.
    throw new Error(
      `listed as internal but still defaulted with \`: "\${X:=...}"\`: ${stillDefaulted.join(", ")}`,
    );
  }
  const extras = EXTRA_KNOBS.filter(
    (k) => !seen.has(k.name) && !defs.some((d) => d.key === k.name),
  );
  const names = [
    ...new Set([
      ...knobs.map((k) => k.name),
      ...defs.map((d) => d.key),
      ...extras.map((k) => k.name),
      ...notKnobs,
    ]),
  ];
  const { consumers, undocumented, defaults } = scanConsumers(root, names);
  return render({
    knobs,
    defs,
    consumers,
    undocumented,
    defaults,
    extras,
    internal: INTERNAL_NAMES,
    seams: TEST_SEAMS,
  });
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
