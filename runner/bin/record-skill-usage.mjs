#!/usr/bin/env node
// Gaffer factory — skill-selection telemetry writer.
//
// Appends one JSONL record per agent run (delivery, bootstrap, review,
// security-review, clarify, and the headless plan / spec / product / test / merge
// runners) capturing which skills were SELECTED (mounted for the run — the mount
// dir is the source of truth when given, so the universal mechanics count too) and,
// best-effort, which were APPLIED (their name appears in the agent's final output),
// OPENED (a Read / Bash target under `.claude/skills/<name>/` that the safety hook
// ALLOWED, per its decision-stamped tool ledger $GAFFER_DATA/tool-metrics.jsonl) or
// REFUSED (the same, but the hook blocked it: the agent never saw the file). An open
// is not an application: `applied` is never inferred from `opened`. A Skill-tool
// invocation itself is not visible to either signal (the hook does not see the Skill
// tool and the json envelope carries no tool calls), so both are lower bounds. This is the "instrument first
// so pruning isn't blind" step: the data-driven prune of the ~50 generic skills
// is a LATER follow-up that needs this usage trail accumulated over time.
//
// FAIL-SOFT by contract: any error (bad args, unreadable scan file, unwritable
// output) exits 0 without throwing — telemetry must NEVER fail a delivery.
//
// Usage:
//   record-skill-usage.mjs --ticket 42 --role delivery --stack typescript-react \
//     --selected "run-tests,run-lint,frontend-component" \
//     [--applied "run-tests"] [--scan /path/to/agent-output.json] \
//     [--mount <skill-mount-dir>] [--tool-ledger <tool-metrics.jsonl> \
//      --since <iso-ts> --root <agent-dir>] \
//     --out /path/to/skills-telemetry.jsonl
//
// Exported helpers are unit-tested directly (see test/skill-telemetry.test.mjs).

import { appendFileSync, readdirSync, readFileSync } from "node:fs";

/** Split a comma/whitespace/newline-separated list into a de-duped, ordered array. */
export function parseList(value) {
  const seen = new Set();
  const out = [];
  for (const raw of String(value ?? "").split(/[\s,]+/)) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Best-effort "applied" detection: a SELECTED skill counts as applied when its name —
 * as the slug (`run-tests`) OR its space-separated form (`run tests`) — appears in the
 * agent's output, case-insensitively. The old slug-only, case-sensitive match near-never
 * fired: agents narrate in prose ("ran the tests", "Self Review"), not skill slugs, so
 * earning skills were mislabelled dead weight in the Health panel. Still a heuristic, and
 * bounded to SELECTED (mounted) skills, so it can only mis-count among skills the agent
 * actually had — never invent an unmounted one. Never throws.
 */
export function detectApplied(selected, outputText) {
  const text = String(outputText ?? "");
  if (!text) return [];
  return selected.filter((name) => {
    const forms = new Set([name, name.replace(/-/g, " ")]);
    return [...forms].some((form) => {
      const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Hyphen-excluding boundary (as before) so the slug `run-tests` never matches a
      // longer token like `run-tests-extra`; case-insensitive for prose capitalisation.
      return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`, "i").test(text);
    });
  });
}

// Shell commands that READ the files they are given (a Bash row counts as a read only
// through one of these). Anything else that merely names a skill path — echo, ls, touch,
// a redirect — opened nothing.
const BASH_READERS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "sed",
  "awk",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "nl",
  "bat",
  "view",
  "batcat",
]);

/** Normalise a path lexically (`a/b/../c` → `a/c`), keeping a leading `/`. */
function normalisePath(p) {
  const abs = p.startsWith("/");
  const out = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}

/**
 * The file paths a ledger row READ, normalised: a Read's file_path, or the operands of a
 * reader command in a Bash row (each `;` / `&&` / `||` / `|` segment on its own). Every
 * other tool — Write, Edit, Grep, Glob, a Bash `echo` — read no skill file: [].
 */
function readPaths(tool, target) {
  if (tool === "Read") return [normalisePath(target)];
  if (tool !== "Bash") return [];
  const paths = [];
  for (const seg of target.split(/&&|\|\||[;|\n]/)) {
    const words = seg
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/^["'`]+|["'`]+$/g, ""))
      .filter(Boolean);
    if (!words.length || !BASH_READERS.has(words[0].split("/").pop())) continue;
    for (const w of words.slice(1))
      if (!w.startsWith("-") && w.includes("/")) paths.push(normalisePath(w));
  }
  return paths;
}

/**
 * Skills the agent OPENED, and skills whose read the hook REFUSED, from the safety
 * hook's tool ledger (one JSON row per tool call: {ts, ticket, tool, target, decision}).
 * A row counts when it is at or after `since` and belongs to THIS run — it carries this
 * `ticket` (delivery sets GAFFER_TICKET) or its target names one of this run's `roots`
 * (the agent's worktree / mount dir; the other roles run without a ticket) — and its
 * target is a path inside a selected skill's dir (`.claude/skills/<name>/…`, the
 * mount's `<name>/…`). Bounded to SELECTED skills. Never throws.
 *
 * THE HOOK'S DECISION IS THE SOURCE OF TRUTH: a row is an OPEN only when the hook
 * stamped it `decision: "allow"`. A `"block"` row is a REFUSED read (the agent tried,
 * the hook said no — it never saw the file), and a row with no decision (a ledger
 * written before rows were stamped) proves nothing either way, so it counts as neither.
 */
export function scanLedger(selected, ledgerText, { ticket = "", since = "", roots = [] } = {}) {
  const sinceMs = since ? Date.parse(since) : NaN;
  // A root matches only as a whole path: it must start at a non-path character (or the
  // start of the target) and end at `/`, a shell separator or the end. A bare substring
  // test let root `…/review-wt-7` claim `…/review-wt-71/…` reads (another ticket's agent).
  const scopes = roots
    .map((r) => String(r ?? "").replace(/\/+$/, ""))
    .filter(Boolean)
    .map(
      (r) =>
        new RegExp(
          `(^|[^A-Za-z0-9_.~/-])${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[/\\s"'\`;&|)<>])`,
        ),
    );
  // A path is INSIDE a skill only once normalised (`.claude/skills/x/../../src/A.java` is
  // a repo file) and only at a mount location: the agent's `.claude/skills/<name>/` (its
  // copies) or a mount manifest. A repo's own `src/skills/<name>/` is not a skill.
  const res = selected.map((name) => [
    name,
    new RegExp(
      `(^|/)(\\.claude/skills|skills-mount|skills-mounts/[^/]+)/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^/]`,
    ),
  ]);
  const opened = new Set();
  const refused = new Set();
  for (const line of String(ledgerText ?? "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const target = typeof row?.target === "string" ? row.target : "";
    if (!target) continue;
    const into = row.decision === "allow" ? opened : row.decision === "block" ? refused : null;
    if (!into) continue;
    if (!Number.isNaN(sinceMs) && !(Date.parse(row.ts) >= sinceMs)) continue;
    const ours =
      (ticket && row.ticket != null && String(row.ticket) === String(ticket)) ||
      scopes.some((re) => re.test(target));
    if (!ours) continue;
    for (const path of readPaths(row.tool, target))
      for (const [name, re] of res) if (re.test(path)) into.add(name);
  }
  return {
    opened: selected.filter((n) => opened.has(n)),
    // A skill read once refused and later allowed was opened: report it there only.
    refused: selected.filter((n) => refused.has(n) && !opened.has(n)),
  };
}

/** The skills the hook let the agent OPEN (see scanLedger). */
export function detectOpened(selected, ledgerText, opts = {}) {
  return scanLedger(selected, ledgerText, opts).opened;
}

/** The skill names actually mounted in a per-agent mount dir ([] when unreadable). */
export function mountedNames(mountDir) {
  if (!mountDir) return [];
  try {
    return readdirSync(mountDir)
      .filter((n) => !n.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Build the telemetry record (pure — no I/O). `applied` is what the agent's output
 * names (or an explicit --applied); `opened` is a read the hook ALLOWED; `refused` a
 * read the hook BLOCKED. An open is not an application, so `applied` never includes a
 * skill merely because it was opened.
 */
export function buildRecord({ ticket, role, stack, selected, applied, opened = [], refused = [] }) {
  return {
    ts: new Date().toISOString(),
    ticket: ticket || null,
    role: role || null,
    stack: stack || null,
    count: selected.length,
    selected,
    applied,
    opened,
    refused,
  };
}

export function parseArgs(argv) {
  const opts = {
    ticket: "",
    role: "",
    stack: "",
    selected: "",
    applied: "",
    scan: "",
    mount: "",
    toolLedger: "",
    since: "",
    roots: [],
    out: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)] ?? "";
    switch (arg) {
      case "--ticket":
        opts.ticket = next();
        break;
      case "--role":
        opts.role = next();
        break;
      case "--stack":
        opts.stack = next();
        break;
      case "--selected":
        opts.selected = next();
        break;
      case "--applied":
        opts.applied = next();
        break;
      case "--scan":
        opts.scan = next();
        break;
      case "--mount":
        opts.mount = next();
        break;
      case "--tool-ledger":
        opts.toolLedger = next();
        break;
      case "--since":
        opts.since = next();
        break;
      case "--root":
        opts.roots.push(next());
        break;
      case "--out":
        opts.out = next();
        break;
      default:
        break;
    }
  }
  return opts;
}

/**
 * The names whose `.claude/skills/<name>/` holds GAFFER'S copy: with a mount manifest, only
 * the manifest's names (a selected name missing from it is a repo skill that shadows the
 * pack — reading the repo's file is not opening Gaffer's pack); without one, `selected`.
 */
function mountedOnly(selected, mounted) {
  return mounted.length ? selected.filter((n) => mounted.includes(n)) : selected;
}

/** Compose a record from parsed opts, reading the scan file if provided. */
export function recordFromOpts(opts) {
  // The mount is what the agent could actually see (selection ∪ the universal set).
  const mounted = mountedNames(opts.mount);
  const selected = parseList([opts.selected, ...mounted].join(","));
  const explicit = parseList(opts.applied);
  let scanned = [];
  if (opts.scan) {
    try {
      scanned = detectApplied(selected, readFileSync(opts.scan, "utf8"));
    } catch {
      scanned = [];
    }
  }
  let ledger = { opened: [], refused: [] };
  if (opts.toolLedger) {
    try {
      ledger = scanLedger(mountedOnly(selected, mounted), readFileSync(opts.toolLedger, "utf8"), {
        ticket: opts.ticket,
        since: opts.since,
        roots: [...(opts.roots ?? []), opts.mount].filter(Boolean),
      });
    } catch {
      ledger = { opened: [], refused: [] };
    }
  }
  const applied = parseList([...explicit, ...scanned].join(","));
  return buildRecord({ ...opts, selected, applied, ...ledger });
}

/**
 * Append one record for a headless .mjs runner (decompose, spec-author,
 * product-owner-run, tester-run, merge-ticket). Fail-soft: never throws. Writes to
 * GAFFER_SKILL_TELEMETRY, else $GAFFER_DATA/skills-telemetry.jsonl; nothing when
 * neither is set.
 */
export function recordSkillUsage({
  ticket = "",
  role = "",
  stack = "",
  selected = [],
  output = "",
  agentDir = "",
  mount = "",
  since = "",
  env = process.env,
} = {}) {
  try {
    const out =
      env.GAFFER_SKILL_TELEMETRY ||
      (env.GAFFER_DATA ? `${env.GAFFER_DATA}/skills-telemetry.jsonl` : "");
    if (!out) return null;
    const names = parseList(Array.isArray(selected) ? selected.join(",") : selected);
    const scanned = detectApplied(names, output);
    let ledger = { opened: [], refused: [] };
    if (env.GAFFER_DATA) {
      try {
        const ledgerText = readFileSync(`${env.GAFFER_DATA}/tool-metrics.jsonl`, "utf8");
        ledger = scanLedger(mountedOnly(names, mountedNames(mount)), ledgerText, {
          ticket: "",
          since,
          roots: [agentDir].filter(Boolean),
        });
      } catch {
        ledger = { opened: [], refused: [] };
      }
    }
    const record = buildRecord({
      ticket: String(ticket ?? ""),
      role,
      stack,
      selected: names,
      applied: scanned,
      ...ledger,
    });
    appendFileSync(out, JSON.stringify(record) + "\n");
    return record;
  } catch {
    return null;
  }
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.out) return; // nowhere to write — nothing to do
    const record = recordFromOpts(opts);
    appendFileSync(opts.out, JSON.stringify(record) + "\n");
  } catch {
    // Fail-soft: telemetry must never fail a delivery.
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
