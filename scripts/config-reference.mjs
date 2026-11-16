#!/usr/bin/env node
// Config reference generator: one source of truth for the fourteen settings and every
// value they derive.
//
// A factory has fourteen settings (runner/config/01-settings.sh, _GAFFER_SETTINGS_SPEC);
// every other knob is derived from them by one table per setting (`_gaffer_derive` in
// the runner/config part of its area), and a real environment variable overrides a
// derived value. This script reads the spec and the tables and writes:
//   docs/CONFIG.md                    the fourteen, short (the only config the README links)
//   docs/CONFIG-ADVANCED.md           every derived value, by the setting that decides it
//   runner/config/settings-schema.json the same, as JSON for the dashboard and
//                                     `gaffer config show`
// and fails (--check) when a committed one no longer matches, or when the tables and the
// code drift apart (a knob no setting decides, a row written twice, an old key whose
// setting does not own it).
//
//   node scripts/config-reference.mjs           # write the three files
//   node scripts/config-reference.mjs --check   # exit 1 if one is stale

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  if (start < 0) return { text: lines.join("\n"), parts: [], ranges: [] };
  const end = lines.indexOf("unset _GAFFER_CONFIG_DIR _GAFFER_CONFIG_PART", start);
  if (end < 0 || lines[end + 1] !== "")
    throw new Error("factory.config.sh: the parts block has no end");
  const parts = [];
  const bodies = [];
  // Which part each line of the joined text came from (1-based line numbers): the
  // prologue and epilogue belong to factory.config.sh itself.
  const ranges = [{ part: "factory.config.sh", from: 1, to: start }];
  for (const l of lines.slice(start, end)) {
    const m = l.match(/; _gaffer_config_loaded ([0-9]{2}-[a-z-]+)$/);
    if (!m) continue;
    const file = path.join(root, "runner", "config", `${m[1]}.sh`);
    const own = readFileSync(file, "utf8").replace(/\n$/, "").split("\n");
    if (own.at(-1) !== `_GAFFER_CONFIG_PART=${m[1]}`) {
      throw new Error(`runner/config/${m[1]}.sh: the last line is not its marker`);
    }
    parts.push(file);
    const body = own.slice(own.indexOf("") + 1, -1);
    const from = start + bodies.length + 1;
    ranges.push({ part: m[1], from, to: from + body.length - 1 });
    bodies.push(...body);
  }
  return {
    text: [...lines.slice(0, start), ...bodies, ...lines.slice(end + 2)].join("\n"),
    parts,
    ranges,
  };
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
    // A banner starts a new section (and never becomes part of a knob's notes); with a
    // fixed section it only ends the comment block above it.
    const sec = line.match(SECTION_RE);
    if (sec) {
      if (!fixedSection) section = sec[1].replace(/\s*\(.*?\)\s*$/, "").trim();
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
    name: "DISPATCH_API_PORT",
    default: "8787",
    file: "runner/gaffer",
    doc: "The dashboard's port: `gaffer dashboard` serves it there, and the default dashboard link (GAFFER_DASHBOARD_URL) points at it.",
  },
  {
    name: "DISPATCH_ALLOWED_HOSTS",
    default: "",
    file: "packages/dispatch/src/api/security.ts",
    doc: "Extra hostnames (comma-separated) the dashboard's Host / Origin check accepts, for a reverse proxy or a DNS name in front of it (SECURITY.md).",
  },
  {
    name: "GAFFER_DASHBOARD_START_TIMEOUT",
    default: "30",
    file: "runner/gaffer",
    doc: "Seconds a new dashboard server gets to come up before it is stopped and its log kept; raise it on a slow machine.",
  },
  {
    name: "GAFFER_EGRESS_ALLOW",
    default: "",
    file: "runner/lib/egress-allowlist.mjs",
    doc: "Extra hosts the docker sandbox's default-deny egress proxy lets through, on top of the model endpoint and the package registries ($GAFFER_DATA/egress-allow.txt adds more; docs/sandbox.md).",
  },
  {
    name: "GAFFER_TESTER_REPLAY",
    default: "1",
    file: "runner/bin/tester-run.mjs",
    doc: "1 = the runner replays the tester's tests in a clean, contained checkout before a PASS counts; 0 turns the replay off and every PASS is held for a person.",
  },
  {
    name: "GAFFER_JUDGE_DENIED_TOOLS",
    default:
      "Bash,Edit,Write,MultiEdit,NotebookEdit,Read,Grep,Glob,LS,WebFetch,WebSearch,Task,TodoWrite",
    file: "runner/lib/eval-judge.sh",
    doc: "The tools the eval judge is denied by name, on top of its empty tool set (it grades text and needs none).",
  },
  {
    name: "GAFFER_STRICT_REQUIRE",
    default: "1",
    file: "runner/lib/sandbox.sh",
    doc: "1 (the default, in every mode) = every agent launch runs inside the OS sandbox or is refused (fail closed): `gaffer run`, the loop, a tick and the dashboard's Poll for work refuse before claiming anything, with the fix. 0 (or false/no/off) in the ENVIRONMENT is the opt-out, for a runner you contain yourself (a VM or container): agents then run unwrapped, and it is said once per process. settings.json cannot set 0.",
  },
  {
    name: "GAFFER_SANDBOX_IMAGE",
    default: "gaffer-sandbox:latest",
    file: "runner/lib/sandbox-docker.sh",
    doc: "The image the docker sandbox provider runs each delivery in (`docker compose --profile sandbox build` builds it).",
  },
  {
    name: "GAFFER_DOD",
    default: "1",
    file: "runner/lib/dod.sh",
    doc: "0 turns every Definition-of-Done gate off, the only way to land a delivery ungated (the merge gate is off too).",
  },
  {
    name: "GAFFER_DOD_INSTALL",
    default: "1",
    file: "runner/lib/dod.sh",
    doc: "1 = install the delivery worktree's dependencies (from its lockfile) before the test gate, and a new greenfield repo's; a no-op when node_modules exists. 0 to manage dependencies yourself.",
  },
  {
    name: "GAFFER_ALLOW_NO_DOD",
    default: "0",
    file: "runner/lib/tick-gates.sh",
    doc: "1 = let a delivery pass when no gate ran at all (a repo with no test or lint command). Otherwise that is a failure and the ticket parks.",
  },
  {
    name: "GAFFER_CI_TIMEOUT_POLICY",
    default: "block",
    file: "runner/lib/ci-gate.sh",
    doc: "With GAFFER_REQUIRE_CI=1: what happens when the checks time out, there is no PR or no checks exist. block rejects the delivery; proceed lets it through with a note.",
  },
  {
    name: "GAFFER_MEMORY_AUTO_PROMOTE",
    default: "MEMORY_AUTO_APPROVE",
    verify: false,
    file: "runner/lib/tick-close.sh",
    doc: "1 = a requirement distilled from a delivered ticket goes live at once; 0 = it lands as a draft for `memory review`. Unset, it follows MEMORY_AUTO_APPROVE.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    default: "",
    file: "runner/preflight.sh",
    doc: "An API key for the worker CLI (`claude`). One of this, CLAUDE_CODE_OAUTH_TOKEN or a logged-in CLAUDE_CONFIG_DIR is needed for a live run; the container reads only these two variables.",
  },
  {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    default: "",
    file: "runner/preflight.sh",
    doc: "The subscription token `claude setup-token` prints, used instead of an API key.",
  },
  {
    name: "CLAUDE_CONFIG_DIR",
    default: "$HOME/.claude",
    file: "runner/lib/claude-auth.sh",
    doc: "Where the worker CLI keeps its login (`.credentials.json`); preflight looks there for a credential.",
  },
  {
    name: "GAFFER_PRINCIPAL_TOKEN",
    default: "",
    file: "runner/factory.config.sh",
    doc: "A person's credential: makes `gaffer wg` act as a human or admin principal (a tester verdict needs one). The runner takes it out of its own environment at start, so no agent or child ever sees it.",
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
      "GAFFER_LOG",
      "GAFFER_USAGE_LEDGER",
      "MEMORY_CLI_BIN",
      "MEMORY_MCP_BIN",
      "DISPATCH_MCP_BIN",
      "GAFFER_GH_BIN",
      "DISPATCH_CLI",
      "DISPATCH_CLI_BIN",
      "MEMORY_CLI",
      "GAFFER_BLOCK_LEDGER",
      "GAFFER_SKILL_TELEMETRY",
      "GAFFER_USAGE_PAUSE_FILE",
      "GAFFER_EGRESS_ALLOW_FILE",
      "GAFFER_SAFETY_HOOK",
    ],
  },
  {
    group: "derived",
    title: "Computed from other knobs each time the config loads; set the knob they come from",
    names: ["GAFFER_TICK_OUTER_TIMEOUT", "GAFFER_POLL_WAIT_TIMEOUT", "GAFFER_DOD_FEEDBACK_LINES"],
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
      "GAFFER_SANDBOX_PROFILE",
    ],
  },
  {
    group: "packages",
    title:
      "Read inside the dispatch, memory and crew packages from their own environment; the runner never sets them. A few tune those packages, each read where it is named (an extra sensitive-path or test-path regex for the reviewer's risk flags and the gate-integrity check, the deletion size that is flagged, a hard observed-risk ceiling, the audit switches): set one in the environment that starts the package",
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
  "GAFFER_WG_SERVE_TIMEOUT",
  "GAFFER_WG_SHOW_CMD",
  "GAFFER_WG_DELIVERIES_CMD",
  "GAFFER_TRUST_LOCK_TRIES",
  "GAFFER_TRUST_LOCK_SLEEP_MS",
  "GAFFER_TRUST_LOCK_STALE_MS",
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
  "GAFFER_KEEP_DELIVERY_BRANCH",
  "GAFFER_PAUSE_KEEP_WORKTREE",
  "GAFFER_UNIVERSAL_SKILLS",
  "GAFFER_CLAUDE_VERSION",
  "GAFFER_BP_FILE",
  "DAILY_COUNTER_FILE",
  "GAFFER_CLAIM_TTL",
  "GAFFER_DOD_INSTALL_TIMEOUT",
  "GAFFER_TEST_MERGE_CRASH_AFTER_LAND",
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
  ].map(([name, role]) => ({ name, use: `\`GAFFER_ROLE_MAX_TURNS="${role}=N"\`` })),
  ...[
    ["GAFFER_REWORK_STRONG_MODEL", "rework"],
    ["GAFFER_SCOUT_MODEL_FLAG", "scout"],
    ["GAFFER_JUDGE_MODEL_FLAG", "judge"],
    ["GAFFER_TEST_MODEL", "tester"],
    ["GAFFER_CARD_MODEL", "card"],
    ["GAFFER_ONBOARD_SYNTH_MODEL", "synth"],
    ["GAFFER_INHERIT_MODEL", "inherit"],
  ].map(([name, role]) => ({ name, use: `\`GAFFER_ROLE_MODELS="${role}=<model>"\`` })),
  {
    name: "GAFFER_SLACK_WEBHOOK",
    use: "`GAFFER_NOTIFY_SLACK_URL` (the Slack field in Settings); status.sh still posts to it",
  },
  ...[
    ["GAFFER_SANDBOX_CPUS", "cpus"],
    ["GAFFER_SANDBOX_MEMORY", "memory"],
    ["GAFFER_SANDBOX_PIDS", "pids"],
  ].map(([name, cap]) => ({ name, use: `\`GAFFER_SANDBOX_LIMITS="${cap}=N"\`` })),
  ...[
    ["GAFFER_EXPERIMENT_MAX_USD", "--max-usd"],
    ["GAFFER_EXPERIMENT_MAX_TICKETS", "--max-tickets"],
    ["GAFFER_EXPERIMENT_MAX_ATTEMPTS", "--max-attempts"],
  ].map(([name, flag]) => ({ name, use: `\`gaffer eval experiment ${flag}\`` })),
  {
    name: "GAFFER_LITE_SENSITIVE_RE",
    use: "`GAFFER_SENSITIVE_PATH_RE` (lite and the security review)",
  },
  {
    name: "GAFFER_SECURITY_REVIEW_RE",
    use: "`GAFFER_SENSITIVE_PATH_RE` (lite and the security review)",
  },
  { name: "GAFFER_LITE_MAX_LINES", use: '`GAFFER_LITE_MAX_DIFF="lines=N"`' },
  { name: "GAFFER_LITE_MAX_FILES", use: '`GAFFER_LITE_MAX_DIFF="files=N"`' },
  { name: "GAFFER_GREENFIELD_INSTALL", use: "`GAFFER_DOD_INSTALL=0` (it skips both installs)" },
  { name: "GAFFER_VERBOSE", use: "`gaffer onboard --verbose`" },
  { name: "GAFFER_PREFLIGHT_LIVE", use: "`runner/preflight.sh --live`" },
  { name: "DEMO_DIR", use: "`gaffer demo --dir <path>`" },
  { name: "GAFFER_DAEMON_INTERVAL", use: "`gaffer run --daemon --interval N`" },
  { name: "GAFFER_SCOUT_PACKET", use: "`GAFFER_SCOUT=none` (no packet, no model scout)" },
  {
    name: "GAFFER_CAP_DETECT_TURNS",
    use: "`GAFFER_MAX_TURNS` (a call is cap-hit when it uses every turn)",
  },
];

/**
 * Removed names: knobs the config diet dropped because nothing set them. Each held its
 * built-in value, which is now fixed in the code; a set one is ignored and the config
 * says so once on stderr (runner/config/01-settings.sh, the _GAFFER_REMOVED_ list).
 * docs/CONFIG.md lists them under Removed in the Deprecated section.
 */
export const REMOVED = [
  [
    "GAFFER_REWORK_HISTORY_BYTES",
    "a rework prompt carries the last 8000 bytes of earlier attempts' feedback",
  ],
  ["GAFFER_JUDGE_DIFF_BYTES", "the eval judge grades the first 120000 bytes of a diff"],
  ["GAFFER_MERGE_GATE_RETRIES", "a landing whose target moved is re-gated up to twice"],
  ["GAFFER_PREFLIGHT_LIVE_TIMEOUT", "the live preflight call gets 60 seconds"],
  ["GAFFER_ACCEPTANCE_TIMEOUT_MS", "one acceptance profile run gets 5 minutes"],
  ["GAFFER_AGENT_NAME", "the factory agent registers as gaffer-factory"],
  [
    "GAFFER_AGENT_EMAIL",
    "a greenfield repo's first commit is by gaffer-factory@users.noreply.invalid",
  ],
  [
    "GAFFER_BUDGET_LOW_FRACTION",
    "the low-budget threshold is 20% of the ceiling (export GAFFER_BUDGET_LOW_THRESHOLD to change it)",
  ],
  ["GAFFER_INHERIT_PLAN_TIMEOUT", "the inherit planner gets 60 seconds"],
  ["GAFFER_INHERIT_AMB_TIMEOUT", "the inherit ambiguity call gets 300 seconds"],
  ["GAFFER_ONBOARD_TIMEOUT", "onboarding calls follow GAFFER_TICK_TIMEOUT"],
  ["GAFFER_REAPPROVAL_ATTEMPTS", "a re-approval is tried 3 times"],
  ["GAFFER_TESTER_REPLAY_TIMEOUT_MS", "the tester's replay gets 10 minutes"],
  ["GAFFER_DECOMPOSE_MOCK", "a dry-run planner takes mockOutput from its request"],
  ["GAFFER_SPEC_AUTHOR_MOCK", "a dry-run spec author takes mockOutput from its request"],
  ["GAFFER_AGENT_ID_FILE", "the factory agent's id is kept in $GAFFER_DATA/agent_id"],
  ["GAFFER_REVIEWER_ID_FILE", "the reviewer's id is kept in $GAFFER_DATA/agent_reviewer_id"],
  [
    "GAFFER_EVAL_LEDGER",
    "the eval judge writes $GAFFER_DATA/eval-ledger.jsonl, the file the dashboard reads",
  ],
].map(([name, now]) => ({ name, now }));

/** Every internal or seam name, for the scans that decide what is a knob. */
export function notKnobNames() {
  return new Set([
    ...INTERNAL_NAMES.flatMap((g) => g.names),
    ...TEST_SEAMS,
    ...DEPRECATED.map((d) => d.name),
    ...REMOVED.map((d) => d.name),
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
    ...REMOVED.map((d) => d.name),
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

// ─── The fourteen settings and their tables ──────────────────────────────────

/**
 * A short paragraph printed under a setting in docs/CONFIG-ADVANCED.md, before its
 * table: a contract a group of derived values keeps together, which no single note can say.
 */
export const SETTING_NOTES = {
  GAFFER_DAILY_BUDGET_USD: [
    "**Budget admission and reservations.** Every paid agent launch asks one admission",
    "check right before it starts (`runner/lib/budget-admission.mjs`). A dollar cap is a",
    "ceiling, so the calls already running hold their worst case against it: under any cap",
    "an admitted launch books a `reservation` row in the usage ledger before the call",
    "starts, for its `GAFFER_MAX_CALL_USD` per-call cap where set, else",
    "`GAFFER_KILL_ESTIMATE_USD`, else $0.05. Reading the spend and booking the reservation",
    "happen under one lock beside the ledger, so two launches never see the same headroom.",
    "Spend plus open reservations must stay below the cap, and while other calls are in",
    "flight a new call starts only if its own worst case fits beside them. When the call",
    "books its real cost (measured or estimated) that row settles the reservation. A",
    "reservation whose call died without booking keeps holding both caps until a crash",
    "path books its kill estimate, the next launch on the same host settles it (with the",
    "same labelled kill estimate, and only once its launcher is provably gone), or you run",
    "`node runner/lib/usage-ledger.mjs --reconcile --usd <amount>` (`--open-reservations`",
    "lists them). A reservation is never a reading: it carries no cost and no view counts",
    "it as spend or as a call. Only the per-call cap bounds a call: without",
    "`GAFFER_MAX_CALL_USD` the reservation is a floor, not a bound.",
  ],
  GAFFER_CONCURRENCY: [
    "**Two helper processes per tick.** A tick runs its dispatch CLI calls (`wg`) through",
    "one long-lived dispatch process and its JSON helper calls through one long-lived JSON",
    "process, over named pipes in `$GAFFER_DATA/wg-serve/`, instead of starting node for",
    "each call. A call a server cannot run identically runs one-shot; a dispatch server",
    "that dies or answers garbage fails that call (a `WG_SERVER_FAILED` line on stderr).",
    "`GAFFER_WG_SERVE=0` runs every call one-shot (troubleshooting).",
  ],
};

/**
 * Names that are never settings and never derived: credentials, the locations of the
 * checkout, and the security boundaries only the operator's real environment may move
 * (settings.json cannot set any of them). docs/CONFIG.md lists them under
 * "Credentials and environment-only names", as before.
 */
export const ENV_ONLY = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "GAFFER_PRINCIPAL_TOKEN",
  "GAFFER_HOME",
  "GAFFER_STRICT_REQUIRE",
  "GAFFER_ALLOW_UNCAPPED",
  "GAFFER_WORKER_PROVIDER",
  "GAFFER_WORKER_COMMAND",
  "GAFFER_WORKER_COMMAND_ENV",
  "GAFFER_WORKER_COMMAND_COST_USD",
  "GAFFER_SANDBOX_WORKER_COMMAND",
  "CLAUDE_BIN",
  "CLAUDE_FLAGS",
];

/** The text between `NAME='` and the closing `'` of a block assignment in a part. */
function quotedBlock(text, name) {
  const m = new RegExp(`^${name}='([^']*)'`, "m").exec(text);
  if (!m) throw new Error(`runner/config/01-settings.sh: no ${name}='...' block`);
  return m[1].split("\n").filter((l) => l.trim() !== "");
}

/** The fourteen settings, from 01-settings.sh's _GAFFER_SETTINGS_SPEC. */
export function parseSettingsSpec(text) {
  return quotedBlock(text, "_GAFFER_SETTINGS_SPEC").map((l) => {
    const [name, kind, values, dflt, ...desc] = l.split("|");
    return {
      name,
      kind,
      values: values ? values.split(" ") : [],
      default: dflt,
      description: desc.join("|"),
    };
  });
}

/** The old settings.json keys and how each meets its derived value (_GAFFER_MIGRATION_MAP). */
export function parseMigrationMap(text) {
  return quotedBlock(text, "_GAFFER_MIGRATION_MAP").map((l) => {
    const [key, setting, compare] = l.split("|");
    return { key, setting, compare };
  });
}

/**
 * Every `_gaffer_derive SETTING <<'_GAFFER_TABLE_'` table in the config text, with its
 * rows: { setting, noExport, line, rows: [{ name, unsetOnly, cells, note }] }. A row is
 * read exactly as _gaffer_derive reads it: everything from the first `#` is the note,
 * the rest is whitespace-separated words.
 */
export function parseTables(text) {
  const lines = text.split("\n");
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(
      /^_gaffer_derive ([A-Z_][A-Z0-9_]*)( --no-export)? <<'_GAFFER_TABLE_'$/,
    );
    if (!m) continue;
    const t = { setting: m[1], noExport: Boolean(m[2]), line: i + 1, rows: [] };
    for (i++; i < lines.length && lines[i] !== "_GAFFER_TABLE_"; i++) {
      const hash = lines[i].indexOf("#");
      const body = hash >= 0 ? lines[i].slice(0, hash) : lines[i];
      const note = hash >= 0 ? lines[i].slice(hash + 1).trim() : "";
      const words = body.trim().split(/\s+/).filter(Boolean);
      if (words.length === 0) continue;
      let name = words[0];
      const unsetOnly = name.startsWith("?");
      if (unsetOnly) name = name.slice(1);
      t.rows.push({ name, unsetOnly, cells: words.slice(1), note });
    }
    if (i >= lines.length) throw new Error(`the ${m[1]} table has no _GAFFER_TABLE_ end`);
    tables.push(t);
  }
  return tables;
}

/** How a cell reads in the docs (`~` is resolved by the caller). */
function cellText(c) {
  if (c === '""') return "_(empty)_";
  if (c === "-") return "_(unset)_";
  if (c.startsWith("@?_") || c.startsWith("@_")) return "_from the setting (see note)_";
  if (c.startsWith("@?")) return `_follows_ \`${c.slice(2)}\` _(unset when empty)_`;
  if (c.startsWith("@")) return `_follows_ \`${c.slice(1)}\``;
  return code(c);
}

/** The JSON form of one cell: what part B's dashboard shows. */
function cellJson(c, constant) {
  if (c === "~") return constant;
  if (c === '""') return { how: "value", value: "" };
  if (c === "-") return { how: "unset" };
  if (c.startsWith("@?_") || c.startsWith("@_")) return { how: "from-setting" };
  if (c.startsWith("@?")) return { how: "follows", name: c.slice(2), unsetWhenEmpty: true };
  if (c.startsWith("@")) return { how: "follows", name: c.slice(1) };
  return { how: "value", value: c };
}

/** A `${NAME:-x}` / `$NAME` default names another knob it follows. */
function followsOf(def) {
  const m = String(def).match(/^\$\{([A-Z_][A-Z0-9_]*)(?::-[^}]*)?\}$|^\$([A-Z_][A-Z0-9_]*)$/);
  return m ? (m[1] ?? m[2]) : null;
}

function code(s) {
  return s === "" ? "_(empty)_" : `\`${String(s).replace(/`/g, "\\`")}\``;
}

function cell(s) {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

/**
 * Read everything the three documents are made from, and check that it holds together:
 * one table per setting, rows that fit their setting, every knob decided by exactly one
 * setting (or environment-only, or not a knob at all), every old key a row of the table
 * of the setting it names.
 */
export function model(root = ROOT) {
  const src = configSources(root);
  const settingsText = readFileSync(path.join(root, "runner", "config", "01-settings.sh"), "utf8");
  const settings = parseSettingsSpec(settingsText);
  const oldKeys = parseMigrationMap(settingsText);
  const tables = parseTables(src.text);
  const partOf = (line) => src.ranges.find((x) => line >= x.from && line <= x.to)?.part ?? "?";
  const problems = [];
  const byName = new Map(settings.map((s) => [s.name, s]));
  // Default lines: the config's (first wins) and the libs' (a fallback when a lib is
  // sourced on its own).
  const defaults = new Map();
  for (const k of parseConfigDefaults(src.text)) defaults.set(k.name, { ...k, file: "config" });
  const libDefaults = new Map();
  for (const f of libFiles(root)) {
    for (const k of parseConfigDefaults(readFileSync(f, "utf8"), { fixedSection: "lib" })) {
      if (!libDefaults.has(k.name)) libDefaults.set(k.name, { ...k, file: path.basename(f) });
    }
  }
  const extras = new Map(EXTRA_KNOBS.map((k) => [k.name, k]));
  const rowOwner = new Map();
  const tableOf = new Map();
  for (const t of tables) {
    const s = byName.get(t.setting);
    if (!s) {
      problems.push(`a table for ${t.setting}, which is not one of the fourteen settings`);
      continue;
    }
    if (tableOf.has(t.setting)) problems.push(`${t.setting} has two tables`);
    tableOf.set(t.setting, t);
    t.part = partOf(t.line);
    const cols = ["choice", "gates", "models"].includes(s.kind) ? s.values : [];
    for (const r of t.rows) {
      if (rowOwner.has(r.name))
        problems.push(`${r.name} is a row of both ${rowOwner.get(r.name)} and ${t.setting}`);
      rowOwner.set(r.name, t.setting);
      if (byName.has(r.name)) problems.push(`${r.name} is a setting and a row of ${t.setting}`);
      if (r.cells.length !== 1 && r.cells.length !== cols.length)
        problems.push(
          `${t.setting} row ${r.name}: ${r.cells.length} values, not 1 or ${cols.length}`,
        );
      if (!r.note) problems.push(`${t.setting} row ${r.name}: no note (a trailing # comment)`);
      const constant = r.cells.length === 1 && r.cells[0] === "~";
      if (constant) {
        if (!defaults.has(r.name) && !libDefaults.has(r.name) && !extras.has(r.name))
          problems.push(
            `${t.setting} row ${r.name} is ~ but has no default line and no EXTRA_KNOBS entry`,
          );
      } else {
        if (r.cells.includes("~"))
          problems.push(`${t.setting} row ${r.name}: ~ must be the row's only value`);
        if (defaults.has(r.name))
          problems.push(
            `${r.name} has a table value in ${t.setting} and a default line too (written twice)`,
          );
        // A lib's own fallback must agree with what the setting's default derives.
        const lib = libDefaults.get(r.name);
        const dcol = cols.length ? cols.indexOf(s.default) : 0;
        const dcell = r.cells.length === 1 ? r.cells[0] : r.cells[dcol];
        if (lib && !lib.derived && /^[^@~"-]/.test(dcell) && lib.default !== dcell)
          problems.push(
            `${r.name}: runner/lib/${lib.file} falls back to ${JSON.stringify(lib.default)} but ${t.setting}=${s.default} derives ${JSON.stringify(dcell)}`,
          );
      }
    }
  }
  for (const s of settings) if (!tableOf.has(s.name)) problems.push(`${s.name} has no table`);
  const envOnly = new Set(ENV_ONLY);
  const notKnobs = notKnobNames();
  const known = (n) => byName.has(n) || rowOwner.has(n) || envOnly.has(n) || notKnobs.has(n);
  for (const n of [...defaults.keys(), ...libDefaults.keys(), ...extras.keys()]) {
    if (!known(n))
      problems.push(
        `${n} has a default but no setting decides it: add it as a row of a setting's table, or to ENV_ONLY / INTERNAL_NAMES / TEST_SEAMS`,
      );
  }
  for (const n of ENV_ONLY) {
    if (rowOwner.has(n) || byName.has(n))
      problems.push(`${n} is environment-only and a setting or row`);
    if (!defaults.has(n) && !libDefaults.has(n) && !extras.has(n))
      problems.push(`${n} is environment-only but has no default line and no EXTRA_KNOBS entry`);
  }
  const stillDefaulted = [...defaults.keys()].filter((n) => notKnobs.has(n));
  if (stillDefaulted.length > 0) {
    // A `: "${X:=v}"` line is how the config says "this is a knob"; an internal name
    // assigns itself plainly (X="${X:-v}") so code and reference agree.
    problems.push(
      `listed as internal but still defaulted with \`: "\${X:=...}"\`: ${stillDefaulted.join(", ")}`,
    );
  }
  for (const o of oldKeys) {
    if (byName.has(o.key)) problems.push(`old key ${o.key} is a setting`);
    if (!byName.has(o.setting)) problems.push(`old key ${o.key} names ${o.setting}, not a setting`);
    if (rowOwner.get(o.key) !== o.setting)
      problems.push(
        `old key ${o.key} says ${o.setting} decides it, but it is a row of ${rowOwner.get(o.key) ?? "no table"}`,
      );
    if (!/^(off|on|less|less0|more|keep|drop|rank( \S+)+)$/.test(o.compare))
      problems.push(`old key ${o.key}: unknown comparison ${JSON.stringify(o.compare)}`);
  }
  if (problems.length > 0)
    throw new Error(
      `the fourteen settings and their tables do not hold together:\n  ${problems.join("\n  ")}`,
    );
  // What a ~ row stands for: its default line, else its lib fallback, else its read site.
  const constantOf = (name) => {
    const d = defaults.get(name) ?? libDefaults.get(name);
    if (d) {
      const f = followsOf(d.default);
      if (f) return { how: "follows", name: f, text: `_follows_ \`${f}\`` };
      if (d.derived)
        return { how: "computed", value: d.default, text: `_computed_ (${code(d.default)})` };
      return { how: "value", value: d.default, text: code(d.default) };
    }
    const x = extras.get(name);
    if (!x) return null;
    if (x.verify === false)
      return { how: "follows", name: x.default, text: `_follows_ \`${x.default}\`` };
    return {
      how: "value",
      value: x.default,
      readIn: x.file,
      text: `${code(x.default)} _(read in ${x.file})_`,
    };
  };
  return {
    settings,
    oldKeys,
    tables,
    tableOf,
    rowOwner,
    constantOf,
    defaults,
    libDefaults,
    extras,
  };
}

/** The setting's preset columns ([] for a setting whose table has one column). */
function columnsOf(s) {
  return ["choice", "gates", "models"].includes(s.kind) ? s.values : [];
}

/** docs/CONFIG.md: the fourteen, short. */
export function renderConfig(m) {
  const out = [];
  out.push("# Configuration", "");
  out.push(
    "<!-- GENERATED by scripts/config-reference.mjs from runner/config/01-settings.sh and the",
    "     derivation tables in runner/config/*.sh. Do not edit by hand. CI runs",
    "     `node scripts/config-reference.mjs --check`; regenerate with the same command",
    "     without the flag. -->",
    "",
  );
  out.push(
    "A factory has fourteen settings, and everything else follows from them. Most people set",
    "three: `GAFFER_MODE`, a budget (`GAFFER_DAILY_BUDGET_USD` or `GAFFER_BUDGET_USD`) and",
    "`GAFFER_MODELS`. Set one in the dashboard (Settings), in `$GAFFER_DATA/settings.json`,",
    "or as an environment variable; the environment wins over the file, and the file over",
    "the default. An unknown value stops the runner with a message naming the accepted ones.",
    "",
  );
  out.push("| Setting | Values | Default | What it decides |", "|---|---|---|---|");
  for (const s of m.settings) {
    const values =
      s.kind === "choice" || s.kind === "testing"
        ? s.values.map((v) => code(v)).join(" · ")
        : {
            usd: "dollars, or empty",
            count: "1 to 64",
            models: `${s.values.map((v) => code(v)).join(" · ")} or \`strong,standard,cheap\``,
            gates: `${s.values.map((v) => code(v)).join(" · ")} (or a list, environment only)`,
            notify: "URLs and/or `desktop`",
            path: "a path (environment only)",
            port: "a port",
          }[s.kind];
    const dflt = s.default.startsWith("(") ? `_${s.default.slice(1, -1)}_` : code(s.default);
    out.push(`| \`${s.name}\` | ${cell(values)} | ${cell(dflt)} | ${cell(s.description)} |`);
  }
  out.push("");
  out.push(
    "`gaffer config show` prints the fourteen with their values and where each came from;",
    "`--all` adds every value they derive and what decided it; `--json` prints both as JSON.",
    "",
  );
  out.push("## Credentials and environment-only names", "");
  out.push(
    "These are never settings: settings.json cannot set them, only the environment the runner",
    "starts in. The worker provider is a security boundary with its own page",
    "([worker-providers.md](worker-providers.md)); the sandbox opt-out and the uncapped switch",
    "are in [SECURITY.md](../SECURITY.md).",
    "",
  );
  out.push("| Variable | Default | Notes |", "|---|---|---|");
  for (const n of ENV_ONLY) {
    const d = m.defaults.get(n) ?? m.libDefaults.get(n);
    const x = m.extras.get(n);
    const dflt = d
      ? d.derived
        ? `_computed_ (${code(d.default)})`
        : code(d.default)
      : code(x.default);
    const note = firstSentence([d?.doc || x?.doc || ""]);
    out.push(`| \`${n}\` | ${cell(dflt)} | ${cell(note)} |`);
  }
  out.push("");
  out.push("---", "");
  out.push(
    "Every value the settings derive, what each choice sets, and how to override one from the",
    "environment: [Detailed configuration](CONFIG-ADVANCED.md).",
    "",
  );
  return out.join("\n");
}

const COMPARE_TEXT = {
  off: "an old 0 (off) still applies where the setting derives 1",
  on: "an old 1 (on) still applies where the setting derives 0",
  less: "an old lower limit still applies (0 or empty is no limit)",
  less0: "an old lower number still applies",
  more: "an old higher number still applies",
  keep: "the old value still applies while the setting leaves it empty",
  drop: "never: the setting decides it",
};
function compareText(c) {
  if (c.startsWith("rank ")) {
    const levels = c
      .slice(5)
      .split(" ")
      .map((l) => l.replace(/(^|\/)-(\/|$)/, "$1(unset)$2"));
    return `an old value further along ${levels.join(" < ")} still applies`;
  }
  return COMPARE_TEXT[c];
}

/** docs/CONFIG-ADVANCED.md: every derived value, by the setting that decides it. */
export function renderAdvanced(m, { consumers, undocumented, defaults }) {
  const out = [];
  out.push("# Detailed configuration", "");
  out.push(
    "<!-- GENERATED by scripts/config-reference.mjs from the derivation tables in",
    "     runner/config/*.sh. Do not edit by hand. CI runs `node scripts/config-reference.mjs",
    "     --check`. -->",
    "",
  );
  out.push(
    "This is not a supported surface: it lists every value the fourteen settings",
    "([CONFIG.md](CONFIG.md)) derive, for the person who wants to see or change one. Each is",
    "grouped under the setting that decides it, with what each of its choices derives.",
    "",
    "**Override any of them** with a real environment variable: `export NAME=value` before",
    "starting the runner. That is the one way; settings.json does not take these names. An",
    "override is honoured as it always was, and `gaffer config show --all` marks it as coming",
    "from the environment. A value marked _follows_ takes another value's; one marked",
    "_from the setting_ is worked out from the setting's own value (its note says how).",
    "",
  );
  for (const s of m.settings) {
    const t = m.tableOf.get(s.name);
    const cols = columnsOf(s);
    out.push(`## \`${s.name}\``, "");
    out.push(s.description, "");
    const accepted = s.values.length ? s.values.join(", ") : s.kind;
    out.push(
      `Accepted: ${accepted}. Default: ${s.default}. Its table: \`runner/config/${t.part}.sh\`.`,
      "",
    );
    if (SETTING_NOTES[s.name]) out.push(...SETTING_NOTES[s.name], "");
    if (cols.length > 0) {
      out.push(
        `| Derived value | ${cols.map((c) => (c === s.default ? `${c} (default)` : c)).join(" | ")} | Note |`,
        `|---|${cols.map(() => "---|").join("")}---|`,
      );
    } else {
      out.push("| Derived value | Value | Note |", "|---|---|---|");
    }
    for (const r of t.rows) {
      const n = Math.max(cols.length, 1);
      const cells =
        r.cells.length === 1 && r.cells[0] === "~"
          ? Array(n).fill(m.constantOf(r.name).text)
          : r.cells.length === 1
            ? Array(n).fill(cellText(r.cells[0]))
            : r.cells.map(cellText);
      out.push(`| \`${r.name}\` | ${cells.map(cell).join(" | ")} | ${cell(r.note)} |`);
    }
    out.push("");
  }
  out.push("## Old settings.json keys", "");
  out.push(
    "Before the fourteen, the dashboard wrote these to settings.json. Each is now decided by",
    "the setting named here: the runner ignores the key with one warning naming that",
    "setting, except where the old value is stricter than what the setting derives (it",
    "would never widen autonomy or spend): then it still applies, and the warning says so.",
    "`gaffer config show --json` lists what happened to each (`migration`).",
    "",
  );
  out.push("| Old key | Decided now by | When the old value still applies |", "|---|---|---|");
  for (const o of m.oldKeys)
    out.push(`| \`${o.key}\` | \`${o.setting}\` | ${cell(compareText(o.compare))} |`);
  out.push("");
  out.push("## Env reads without a default", "");
  if (undocumented.size === 0) {
    out.push(
      "None: every environment variable the code reads is a setting, a derived value, an",
      "environment-only name, a deprecated name or an internal name. A new read with none of",
      "those shows up here until it gets one.",
    );
  } else {
    out.push(
      "Factory-prefixed names the code reads from the environment and never assigns, with no",
      "setting deciding them: only an operator (or a test) can set them. **Default in code**",
      "is the fallback at the read site.",
      "",
      "| Variable | Default in code | Read in |",
      "|---|---|---|",
    );
    for (const [name, files] of [...undocumented.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const d = [...(defaults.get(name) ?? [])].sort();
      out.push(
        `| \`${name}\` | ${cell(d.map((v) => code(v)).join(" / "))} | ${[...files]
          .sort()
          .map((f) => `\`${f}\``)
          .join(", ")} |`,
      );
    }
  }
  out.push("");
  out.push("## Deprecated", "");
  out.push(
    "These still work: each is mapped onto its replacement and says so once on stderr. With",
    "both set, the replacement wins; an old per-role or per-cap name still applies to a role",
    "or cap the new name does not name.",
    "",
    "| Old name | Use instead |",
    "|---|---|",
  );
  for (const d of DEPRECATED) out.push(`| \`${d.name}\` | ${cell(d.use)} |`);
  out.push("");
  out.push("### Removed", "");
  out.push(
    "Nothing in Gaffer set these, so each held its built-in value, which is now fixed in the",
    "code. A set one is ignored, and the config says so once on stderr.",
    "",
    "| Removed name | What happens now |",
    "|---|---|",
  );
  for (const d of REMOVED) out.push(`| \`${d.name}\` | ${cell(d.now)} |`);
  out.push("");
  out.push("## Internal names (not knobs)", "");
  out.push(
    "The code reads these too, but they are not settings: another component or a test sets",
    "them, or they follow from a value above. They are listed so a name you meet in the code",
    "is not a mystery; a run needs none of them set.",
    "",
  );
  for (const g of INTERNAL_NAMES)
    out.push(`- **${g.group}**: ${g.title}. ${g.names.map((n) => `\`${n}\``).join(", ")}.`);
  out.push(
    `- **test seams**: read only so a test can shorten a wait, stub a command, skip slow bookkeeping or fix the clock; keep the built-in value. ${TEST_SEAMS.map((n) => `\`${n}\``).join(", ")}.`,
  );
  out.push("");
  // Which components read each name, so a reader can follow one into the code.
  out.push("## Who reads what", "");
  out.push("| Name | Read by |", "|---|---|");
  for (const s of m.settings) {
    for (const n of [s.name, ...m.tableOf.get(s.name).rows.map((r) => r.name)]) {
      out.push(`| \`${n}\` | ${[...(consumers.get(n) ?? [])].sort().join(", ")} |`);
    }
  }
  out.push("");
  return out.join("\n");
}

/** runner/config/settings-schema.json: the fourteen and their tables, for the dashboard. */
export function renderSchema(m) {
  const doc = {
    $comment:
      "GENERATED by scripts/config-reference.mjs from runner/config/01-settings.sh and the derivation tables in runner/config/*.sh. Do not edit by hand; `node scripts/config-reference.mjs --check` fails when it is stale.",
    settings: m.settings.map((s) => {
      const t = m.tableOf.get(s.name);
      const cols = columnsOf(s);
      return {
        name: s.name,
        kind: s.kind,
        values: s.values,
        default: s.default,
        description: s.description,
        table: `runner/config/${t.part}.sh`,
        presets: cols,
        derives: t.rows.map((r) => {
          const one = (c) => cellJson(c, c === "~" ? m.constantOf(r.name) : null);
          const row = { name: r.name, note: r.note };
          if (r.cells.length === 1) row.all = one(r.cells[0]);
          else row.byPreset = Object.fromEntries(cols.map((c, i) => [c, one(r.cells[i])]));
          if (r.unsetOnly) row.keepsExplicitEmpty = true;
          return row;
        }),
      };
    }),
    oldKeys: m.oldKeys.map((o) => ({
      key: o.key,
      setting: o.setting,
      compare: o.compare,
      stillApplies: compareText(o.compare),
    })),
    environmentOnly: ENV_ONLY,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

const OUTS = {
  config: path.join(ROOT, "docs", "CONFIG.md"),
  advanced: path.join(ROOT, "docs", "CONFIG-ADVANCED.md"),
  schema: path.join(ROOT, "runner", "config", "settings-schema.json"),
};

/** The three generated files' text, keyed like OUTS. */
export async function generateAll(root = ROOT) {
  const m = model(root);
  verifyExtraKnobs(root);
  verifyInternalNames(root);
  const names = [
    ...new Set([
      ...m.settings.map((s) => s.name),
      ...m.tables.flatMap((t) => t.rows.map((r) => r.name)),
      ...ENV_ONLY,
      ...EXTRA_KNOBS.map((k) => k.name),
      ...m.oldKeys.map((o) => o.key),
      ...notKnobNames(),
    ]),
  ];
  const scan = scanConsumers(root, names);
  return {
    config: renderConfig(m),
    advanced: renderAdvanced(m, scan),
    schema: renderSchema(m),
  };
}

/** docs/CONFIG.md's text (kept for callers of the one-document generator). */
export async function generate(root = ROOT) {
  return (await generateAll(root)).config;
}

async function main(argv) {
  const check = argv.includes("--check");
  const texts = await generateAll();
  let stale = false;
  for (const [k, file] of Object.entries(OUTS)) {
    const rel = path.relative(ROOT, file);
    if (check) {
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (current !== texts[k]) {
        console.error(`${rel} is stale; regenerate with: node scripts/config-reference.mjs`);
        stale = true;
      } else console.log(`${rel} is up to date`);
    } else {
      writeFileSync(file, texts[k]);
      console.log(`wrote ${rel}`);
    }
  }
  if (stale) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
