#!/usr/bin/env node
// runner/lib/scout.mjs — the PRE-WORK SCOUT (delta roadmap gap 3; strategy "3. Better
// first attempts"). Deterministic, read-only, no model call: before a delivery spawns,
// the runner expands what the ticket names into a small packet of likely files, each
// with the reason it was selected:
//
//   named           a path the ticket names (json-tool ticket-named-code)
//   defines X       the module that declares a symbol the ticket names (code index)
//   stack trace     a file:line frame in the ticket text, resolved against the base tree
//   imports X       a caller (importer) of a seed, from `memory index neighbours`
//   tests X         a test that imports a seed or is named for it (code index)
//   2 hops          an importer / test of a first-hop caller (bounded)
//   + tags          config / migration / schema / public API / auth, by path pattern
//
// tick.sh gathers (lib/scout.sh runs git and the memory CLI); this module only derives.
// Every input is optional and every failure degrades: no index → the named items and
// stack frames only, said as such. Bounded: MAX_ITEMS files, MAX_SEEDS seeds, MAX_HOP2
// second-hop queries. The packet is DATA: paths and names only (identifier and path
// characters), rendered inside an untrusted envelope by crew's deliveryPrompt.ts.
//
// CLI (all fail-soft: bad input prints nothing and exits 0):
//   node scout.mjs seeds --show <file> --named <file> --files <file>
//        → P<TAB>path / S<TAB>symbol lines to ask the index about (named + stack frames)
//   node scout.mjs hop2 --nb1 <file>          → P<TAB>path lines (first-hop callers)
//   node scout.mjs packet --show <file> --named <file> --files <file> --nb1 <file>
//        --nb2 <file> [--base-sha S] [--attempt N] [--rf <file>]   → the packet JSON
//   node scout.mjs merge-model --packet <file> --reply <file> --files <file>
//        --repo <dir> --base-sha S      → the packet JSON with "scout suggested" items
//   node scout.mjs with-risk --packet <file> --risk <file>  → the packet with .risk
//   node scout.mjs summary --packet <file>     → the prompt input (compact JSON)
//   node scout.mjs selection --packet <file> --ticket N --attempt K --skills S
//        --lenses L --model M --route <route json> --cards <file-cards block>
//        → one context-selection.jsonl line
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MAX_ITEMS = 25;
export const MAX_SEEDS = 10;
export const MAX_HOP2 = 8;
export const MAX_REASONS = 3;
export const MAX_NOTES = 10;

const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9_./@+-]{0,299}$/;
const SAFE_SYM = /^[A-Za-z_$][\w$]{1,63}$/;
const THIRD_PARTY = /(^|\/)(node_modules|vendor|third_party|site-packages|dist|build)\//;
export const isSafePath = (p) =>
  typeof p === "string" && SAFE_PATH.test(p) && !p.includes("..") && !THIRD_PARTY.test(p);
export const isSafeSymbol = (s) => typeof s === "string" && SAFE_SYM.test(s);

// ── Path classes (shared with lib/risk-classify.mjs) ──────────────────────────
export const TEST_RE =
  /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[A-Za-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|Tests?\.(java|kt|cs)$/;
export const MIGRATION_RE =
  /(^|\/)(migrations?|migrate|alembic|flyway|liquibase|db\/changelog)\/|(^|\/)\d{3,}[_-][^/]*\.sql$/i;
export const SCHEMA_RE =
  /\.(proto|graphql|gql|prisma|avsc|sql)$|(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$|(^|\/)schema\.[a-z]+$/i;
export const AUTH_RE =
  /(^|[/_.-])(auth|authn|authz|authenticat\w*|authori[sz]\w*|login|logout|session|sessions|permission|permissions|rbac|acl|oauth|jwt|password|passwords|secret|secrets|credential|credentials|csrf|policy|policies)([/_.-]|$)/i;
export const CONFIG_RE =
  /(^|\/)(config|configs|settings|conf)\/|\.(config|conf)\.[A-Za-z0-9]+$|(^|\/)\.env[^/]*$|(^|\/)(settings|config|configuration)\.(py|ts|js|mjs|cjs|json|ya?ml|toml|ini)$|\.(ya?ml|toml|ini)$/i;
export const ENTRY_RE = /(^|\/)(index|__init__|mod|lib)\.(ts|tsx|js|mjs|cjs|py|rs)$/;

/** The tags a path carries by pattern (ordered, deterministic). */
export function pathTags(p) {
  const s = String(p || "");
  const tags = [];
  if (TEST_RE.test(s)) tags.push("test");
  if (MIGRATION_RE.test(s)) tags.push("migration");
  else if (SCHEMA_RE.test(s)) tags.push("schema");
  if (!TEST_RE.test(s) && AUTH_RE.test(s)) tags.push("auth");
  if (CONFIG_RE.test(s) && !TEST_RE.test(s)) tags.push("config");
  if (ENTRY_RE.test(s) && !TEST_RE.test(s)) tags.push("public API");
  return tags;
}

// ── Stack-trace seeds ─────────────────────────────────────────────────────────
const SRC_EXT =
  "tsx?|jsx?|mjs|cjs|mts|cts|py|go|rs|java|kt|kts|scala|rb|php|cs|swift|c|cc|cpp|h|hpp|ex|exs|erl|vue|svelte|sql";
const FRAME_RES = [
  // Python: File "app/billing/invoice.py", line 42
  /File "([^"\n]{1,300})", line (\d{1,7})/g,
  // JS/TS/Go/Rust/Ruby/PHP: path.ext:line[:col] (also inside `at fn (path:line:col)`)
  new RegExp(
    `(?:^|[\\s(\\["'\`=])((?:[A-Za-z]:)?(?:file://)?[/~.]?[A-Za-z0-9_@~.+/-]*[A-Za-z0-9_+-]\\.(?:${SRC_EXT})):(\\d{1,7})(?::\\d{1,5})?`,
    "gm",
  ),
];
// Java/Kotlin: at com.acme.billing.Invoice.calc(Invoice.java:42)
const JAVA_FRAME =
  /\bat ((?:[A-Za-z_$][\w$]*\.)+)[A-Za-z_$<>][\w$<>]*\(([A-Za-z_$][\w$]*\.(?:java|kt|scala)):(\d{1,7})\)/g;

/**
 * Frames in the ticket text: [{raw, line, candidates[]}] where candidates are the path
 * spellings to look for in the base tree (exact first, then the Java package path).
 * At most MAX_SEEDS distinct frames; node_modules / site-packages / stdlib frames dropped.
 */
export function stackTraceSeeds(text) {
  const t = String(text || "").slice(0, 40000);
  const out = [];
  const seen = new Set();
  const push = (raw, line, candidates) => {
    if (out.length >= MAX_SEEDS) return;
    if (/(^|\/)(node_modules|site-packages|dist-packages|vendor|internal\/modules)\//.test(raw))
      return;
    if (/^node:/.test(raw)) return;
    // One frame per file name and line: a Java frame's `(Invoice.java:17)` also
    // matches the generic file:line pattern.
    const key = `${candidates[0].split("/").pop()}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ raw, line: Number(line), candidates });
  };
  for (const m of t.matchAll(JAVA_FRAME)) {
    const pkg = m[1].split(".").slice(0, -2).join("/");
    const file = m[2];
    push(`${m[1]}${file}`, m[3], [pkg ? `${pkg}/${file}` : file, file]);
  }
  for (const re of FRAME_RES)
    for (const m of t.matchAll(re)) {
      const raw = m[1].replace(/^file:\/\//, "").replace(/^\.\//, "");
      push(raw, m[2], [raw]);
    }
  return out;
}

/**
 * A frame's path in the base tree: exact; else the unique tree path that the frame's
 * path ends with (an absolute path from another machine), longest suffix first. null
 * when nothing in the tree matches, or more than one does.
 */
export function resolveSeedPath(candidates, files) {
  if (!files || files.size === 0) return null;
  for (const c of candidates) {
    const clean = c
      .replace(/^[A-Za-z]:/, "")
      .replace(/\\/g, "/")
      .replace(/^~?\/+/, "");
    if (files.has(clean)) return clean;
    const segs = clean.split("/").filter(Boolean);
    for (let k = Math.min(segs.length, 8); k >= 1; k--) {
      const suffix = segs.slice(segs.length - k).join("/");
      if (k === segs.length && files.has(suffix)) return suffix;
      const hits = [];
      for (const f of files) if (f === suffix || f.endsWith(`/${suffix}`)) hits.push(f);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) break; // ambiguous at this length: a shorter suffix is worse
    }
  }
  return null;
}

/** P/S lines (json-tool ticket-named-code) → {paths[], symbols[]}. */
export function parseNamed(text) {
  const paths = [];
  const symbols = [];
  for (const l of String(text || "").split("\n")) {
    const [k, v] = l.split("\t");
    if (k === "P" && isSafePath(v) && !paths.includes(v)) paths.push(v);
    else if (k === "S" && isSafeSymbol(v) && !symbols.includes(v)) symbols.push(v);
  }
  return { paths, symbols };
}

function ticketText(show) {
  const t = (show && show.ticket) || {};
  return `${t.title ?? ""}\n${t.description ?? ""}`;
}

/** The seeds the index is asked about: named paths + resolved stack frames, named symbols. */
export function seeds({ show, named, files }) {
  const n = parseNamed(named);
  const paths = [...n.paths];
  for (const f of stackTraceSeeds(ticketText(show))) {
    const p = resolveSeedPath(f.candidates, files);
    if (p && isSafePath(p) && !paths.includes(p) && paths.length < MAX_SEEDS) paths.push(p);
  }
  return { paths, symbols: n.symbols };
}

/** First-hop callers worth a second hop (non-test, bounded). */
export function hop2Paths(nb1) {
  const out = [];
  if (!nb1 || !Array.isArray(nb1.items) || !listable(nb1)) return out;
  // A seed was asked about already: its importers are first-hop, not second.
  const asked = new Set(nb1.items.map((it) => it.path).filter(Boolean));
  for (const it of nb1.items)
    for (const c of it.callers || [])
      if (
        isSafePath(c.path) &&
        !asked.has(c.path) &&
        !out.includes(c.path) &&
        out.length < MAX_HOP2
      )
        out.push(c.path);
  return out;
}

const listable = (nb) => nb && (nb.status === "fresh" || nb.status === "unknown");

/** The ticket's active write repos (json-tool partition's rule). */
export function writeRepos(show) {
  return ((show && show.repositories) || []).filter(
    (r) =>
      r &&
      r.access === "write" &&
      (r.relation === "confirmed" || r.relation === "implicit_single_repo"),
  );
}

function testCommands(show) {
  const out = [];
  for (const r of writeRepos(show)) {
    const cmd = String((r && r.test_command) || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);
    if (cmd) out.push({ repo: String(r.name || r.id || "repo").slice(0, 80), command: cmd });
  }
  return out;
}

/** Prior failed attempts: the send-back reasons (tick.sh's _RF) and the gate retries. */
function priorFailures(show, rfText) {
  const reasons = [];
  for (const l of String(rfText || "").split("\n"))
    if (l.startsWith("  - ")) reasons.push(l.slice(4).replace(/\s+/g, " ").slice(0, 200));
  const t = (show && show.ticket) || {};
  const attempts = Math.max(0, Math.trunc(Number(t.attempt_count || 0)) || 0);
  const gates = [];
  for (const r of (show && show.reworkTrail) || [])
    if (r && typeof r.gate === "string" && !gates.includes(r.gate)) gates.push(r.gate);
  return { attempt_count: attempts, sent_back: reasons.length, reasons: reasons.slice(-5), gates };
}

/**
 * The deterministic packet. Pure: every input already read.
 *   show   ticket show JSON     named  ticket-named-code text   files  Set of base tree paths (or null)
 *   nb1    neighbours of the seeds     nb2  neighbours of the first-hop callers (or null)
 */
export function buildPacket({ show, named, files, nb1, nb2, baseSha, attempt, rf }) {
  const n = parseNamed(named);
  const items = new Map();
  const order = [];
  const add = (path, reason, source) => {
    if (!isSafePath(path)) return;
    let it = items.get(path);
    if (!it) {
      it = { path, reasons: [], sources: [], tags: pathTags(path) };
      items.set(path, it);
      order.push(path);
    }
    if (!it.reasons.includes(reason) && it.reasons.length < MAX_REASONS) it.reasons.push(reason);
    if (!it.sources.includes(source)) it.sources.push(source);
  };
  const exists = (p) => !files || files.size === 0 || files.has(p);
  const missingNamed = [];
  for (const p of n.paths) {
    if (exists(p)) add(p, "named", "named");
    else missingNamed.push(p);
  }
  const frames = stackTraceSeeds(ticketText(show));
  const unresolved = [];
  for (const f of frames) {
    const p = resolveSeedPath(f.candidates, files);
    if (p) add(p, `stack trace (line ${f.line})`, "stack");
    else unresolved.push(f.raw.slice(0, 120));
  }
  const status = nb1 && typeof nb1.status === "string" ? nb1.status : "unavailable";
  const fromIndex = listable(nb1);
  const label = (it) => (it.symbol ? it.symbol : it.path);
  if (fromIndex) {
    // Named symbols first: the module that defines each.
    for (const it of nb1.items || [])
      if (it.symbol && it.path && !it.note) add(it.path, `defines ${it.symbol} (named)`, "index");
    for (const it of nb1.items || []) {
      if (it.note) continue;
      for (const t of it.tests || []) add(t.path, `tests ${label(it)}`, "index");
    }
    for (const it of nb1.items || []) {
      if (it.note) continue;
      for (const c of it.callers || [])
        add(
          c.path,
          c.via === "barrel" && c.through
            ? `imports ${label(it)} through ${c.through}`
            : c.via === "module"
              ? `imports ${it.path || label(it)} (the whole module)`
              : `imports ${label(it)}`,
          "index",
        );
    }
    if (listable(nb2))
      for (const it of nb2.items || []) {
        if (it.note || !it.path) continue;
        for (const t of it.tests || []) add(t.path, `tests ${it.path} (2 hops)`, "index");
        for (const c of it.callers || []) add(c.path, `imports ${it.path} (2 hops)`, "index");
      }
  }
  // Tags as reasons where they tell the worker why to look.
  for (const p of order) {
    const it = items.get(p);
    for (const tag of it.tags)
      if (tag === "config" || tag === "migration" || tag === "schema")
        if (it.reasons.length < MAX_REASONS) it.reasons.push(tag);
  }
  const all = order.map((p) => items.get(p));
  const kept = all.slice(0, MAX_ITEMS);
  // Fan-out and coverage facts per seed (the risk classifier reads them).
  const seedFacts = [];
  if (fromIndex)
    for (const it of nb1.items || [])
      seedFacts.push({
        query: String(it.query || "").slice(0, 200),
        path: it.path || null,
        symbol: it.symbol || null,
        note: it.note || null,
        callers_total: Number(it.callersTotal || 0),
        tests_total: Number(it.testsTotal || 0),
        module_tests_total: Number(it.moduleTestsTotal || 0),
        cross_package_callers: crossPackage(it.path, it.callers || []),
      });
  return {
    version: 1,
    method: "deterministic (ticket text, stack frames, code index by import text, a lower bound)",
    base_sha: baseSha || null,
    attempt: Number.isInteger(attempt) ? attempt : null,
    index: {
      status,
      commit: (nb1 && nb1.build && nb1.build.commit) || null,
      caps_hit: (nb1 && nb1.build && nb1.build.capsHit) || [],
      used: fromIndex,
      hop2: listable(nb2),
    },
    seeds: { paths: n.paths, symbols: n.symbols, frames: frames.length },
    items: kept,
    omitted: all.length - kept.length,
    counts: {
      items: kept.length,
      named: kept.filter((i) => i.sources.includes("named")).length,
      stack: kept.filter((i) => i.sources.includes("stack")).length,
      // Added by the index: not named and not in a stack frame.
      index: kept.filter(
        (i) =>
          i.sources.includes("index") &&
          !i.sources.includes("named") &&
          !i.sources.includes("stack"),
      ).length,
      tests: kept.filter((i) => i.tags.includes("test")).length,
      model: 0,
    },
    seed_facts: seedFacts,
    missing_named: missingNamed.slice(0, 6),
    unresolved_frames: unresolved.slice(0, 5),
    test_commands: testCommands(show),
    prior: priorFailures(show, rf),
    model_scout: null,
  };
}

/** Callers in another workspace package than the module (packages/a vs packages/b). */
function crossPackage(path, callers) {
  const pkg = (p) => {
    const m = String(p || "").match(/^((?:packages|apps|libs|services|modules)\/[^/]+)\//);
    return m ? m[1] : null;
  };
  const own = pkg(path);
  if (!own) return 0;
  return callers.filter((c) => {
    const o = pkg(c.path);
    return o && o !== own;
  }).length;
}

// ── Model scout reply (B2): validated against the checkout, then merged ─────────
/**
 * Parse the model scout's reply: the LAST fenced or bare JSON object holding
 * {files:[{path, why}], symbols:[{name, path}], notes:[...], questions:[...]}.
 * Returns null when there is none.
 */
export function parseModelReply(text) {
  const s = String(text || "");
  const blocks = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...blocks.reverse()];
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(s.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      /* next */
    }
  }
  return null;
}

const oneLine = (x, n) =>
  String(x ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

/**
 * Merge a parsed model reply into the packet. A path is kept only when it exists in the
 * base tree; a symbol only when the file it names (or a packet file) contains it as a
 * word (fileHas(path, name)). At most 8 files, 8 symbols, MAX_NOTES notes; the rest are
 * counted as dropped. The model's words are kept as "scout suggested" and never become
 * a reason of a deterministic item.
 */
export function mergeModel(packet, reply, { files, fileHas, usage }) {
  const p = JSON.parse(JSON.stringify(packet));
  const ms = {
    ran: true,
    parsed: Boolean(reply),
    kept_files: 0,
    dropped_files: 0,
    kept_symbols: 0,
    dropped_symbols: 0,
    notes: [],
    questions: [],
    files: [],
    symbols: [],
    cost_usd: usage && Number.isFinite(usage.cost_usd) ? usage.cost_usd : null,
    model: (usage && usage.model) || null,
  };
  if (reply) {
    for (const f of Array.isArray(reply.files) ? reply.files : []) {
      const path = typeof f === "string" ? f : f && f.path;
      const clean = String(path || "").replace(/^\.\//, "");
      if (ms.files.length < 8 && isSafePath(clean) && files && files.has(clean)) {
        if (!ms.files.some((x) => x.path === clean)) {
          ms.files.push({ path: clean, why: oneLine(f && f.why, 160) });
          ms.kept_files++;
        }
      } else ms.dropped_files++;
    }
    for (const s of Array.isArray(reply.symbols) ? reply.symbols : []) {
      const name = s && s.name;
      const path = String((s && s.path) || "").replace(/^\.\//, "");
      if (
        ms.symbols.length < 8 &&
        isSafeSymbol(name) &&
        isSafePath(path) &&
        files &&
        files.has(path) &&
        fileHas(path, name)
      ) {
        ms.symbols.push({ name, path });
        ms.kept_symbols++;
      } else ms.dropped_symbols++;
    }
    const notes = Array.isArray(reply.notes) ? reply.notes : [];
    ms.notes = notes
      .map((x) => oneLine(x, 200))
      .filter(Boolean)
      .slice(0, MAX_NOTES);
    ms.questions = (Array.isArray(reply.questions) ? reply.questions : [])
      .map((x) => oneLine(x, 200))
      .filter(Boolean)
      .slice(0, 3);
  }
  p.model_scout = ms;
  p.counts.model = ms.kept_files;
  return p;
}

// ── The prompt input and the telemetry line ──────────────────────────────────
/** The compact form deliveryPrompt.ts renders (no seed facts, no raw reasons list). */
export function promptSummary(packet, risk) {
  if (!packet || !Array.isArray(packet.items)) return null;
  const ms = packet.model_scout;
  const hasModel = ms && (ms.files.length || ms.notes.length || ms.symbols.length);
  if (packet.items.length === 0 && !hasModel) return null;
  return {
    items: packet.items.map((i) => ({ path: i.path, reasons: i.reasons })),
    omitted: packet.omitted,
    index: {
      status: packet.index.status,
      commit: packet.index.commit,
      partial: (packet.index.caps_hit || []).length > 0,
    },
    testCommands: packet.test_commands,
    priorSentBack: packet.prior.sent_back,
    model: hasModel
      ? {
          files: ms.files,
          symbols: ms.symbols,
          notes: ms.notes,
          questions: ms.questions,
          dropped: ms.dropped_files + ms.dropped_symbols,
        }
      : null,
    risk:
      risk && risk.raised
        ? {
            declared: risk.declared,
            effective: risk.effective,
            reasons: risk.signals.filter((s) => s.raises).map((s) => s.detail),
          }
        : null,
  };
}

/** One context-selection.jsonl line (B0): what this launch was given and why. */
export function selectionLine({
  packet,
  risk,
  ticket,
  attempt,
  skills,
  lenses,
  model,
  routeReasons,
  cardPaths,
  now,
}) {
  const split = (s) =>
    String(s || "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith("("));
  const files = [];
  for (const i of (packet && packet.items) || [])
    files.push({ path: i.path, reasons: i.reasons, from: i.sources });
  for (const f of (packet && packet.model_scout && packet.model_scout.files) || [])
    if (!files.some((x) => x.path === f.path))
      files.push({ path: f.path, reasons: ["scout suggested"], from: ["model"] });
  const cards = (cardPaths || []).slice(0, 50).map((p) => ({ path: p, reason: "file card" }));
  return {
    ts: (now || new Date()).toISOString().replace(/\.\d{3}Z$/, "Z"),
    ticket: String(ticket || ""),
    role: "delivery",
    attempt: Number.isInteger(attempt) ? attempt : null,
    scout: packet
      ? {
          index_status: packet.index.status,
          items: packet.counts.items,
          from_index: packet.counts.index,
          named: packet.counts.named,
          stack: packet.counts.stack,
          omitted: packet.omitted,
          model_scout: packet.model_scout
            ? {
                kept: packet.model_scout.kept_files,
                dropped: packet.model_scout.dropped_files + packet.model_scout.dropped_symbols,
                cost_usd: packet.model_scout.cost_usd,
              }
            : null,
        }
      : null,
    files,
    cards,
    skills: [
      ...split(skills).map((name) => ({
        name,
        reason: "selector (stack, area, ticket text, named paths)",
      })),
      ...split(lenses).map((name) => ({ name, reason: "always-on quality lens" })),
    ],
    model: model || null,
    route_reasons: Array.isArray(routeReasons) ? routeReasons.slice(0, 10) : [],
    risk: risk ? { declared: risk.declared, effective: risk.effective, raised: risk.raised } : null,
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function readMaybe(p) {
  if (!p) return "";
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
function jsonMaybe(p) {
  const t = readMaybe(p);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}
function filesSet(p) {
  const t = readMaybe(p);
  if (!t) return null;
  return new Set(t.split("\n").filter(Boolean).slice(0, 200000));
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = {};
  for (let i = 0; i < rest.length; i++)
    if (rest[i].startsWith("--")) {
      opt[rest[i].slice(2)] = rest[i + 1] ?? "";
      i++;
    }
  const outJson = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
  switch (cmd) {
    case "seeds": {
      const s = seeds({
        show: jsonMaybe(opt.show) || {},
        named: readMaybe(opt.named),
        files: filesSet(opt.files),
      });
      for (const p of s.paths) process.stdout.write(`P\t${p}\n`);
      for (const v of s.symbols) process.stdout.write(`S\t${v}\n`);
      break;
    }
    case "hop2":
      for (const p of hop2Paths(jsonMaybe(opt.nb1))) process.stdout.write(`P\t${p}\n`);
      break;
    case "packet": {
      const a = Number.parseInt(opt.attempt ?? "", 10);
      outJson(
        buildPacket({
          show: jsonMaybe(opt.show) || {},
          named: readMaybe(opt.named),
          files: filesSet(opt.files),
          nb1: jsonMaybe(opt.nb1),
          nb2: jsonMaybe(opt.nb2),
          baseSha: opt["base-sha"] || null,
          attempt: Number.isFinite(a) ? a : null,
          rf: readMaybe(opt.rf),
        }),
      );
      break;
    }
    case "merge-model": {
      const packet = jsonMaybe(opt.packet);
      if (!packet) break;
      const files = filesSet(opt.files);
      const { execFileSync } = await import("node:child_process");
      const fileHas = (path, name) => {
        try {
          const body = execFileSync("git", ["-C", opt.repo, "show", `${opt["base-sha"]}:${path}`], {
            encoding: "utf8",
            maxBuffer: 2 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
          });
          return new RegExp(`(^|[^\\w$])${name.replace(/\$/g, "\\$")}([^\\w$]|$)`).test(body);
        } catch {
          return false;
        }
      };
      const usage = jsonMaybe(opt.usage) || {};
      outJson(mergeModel(packet, parseModelReply(readMaybe(opt.reply)), { files, fileHas, usage }));
      break;
    }
    case "summary": {
      const packet = jsonMaybe(opt.packet);
      const s = promptSummary(packet, packet ? packet.risk : null);
      if (s) outJson(s);
      break;
    }
    case "selection": {
      const a = Number.parseInt(opt.attempt ?? "", 10);
      const route = jsonMaybe(opt.route);
      const cardPaths = [];
      for (const ln of readMaybe(opt.cards).split("\n")) {
        const m = ln.match(/^ {2}- \[[^\]]*\] (.+?)(?: — .*)?$/);
        if (m && m[1].trim() && !cardPaths.includes(m[1].trim())) cardPaths.push(m[1].trim());
      }
      outJson(
        selectionLine({
          packet: jsonMaybe(opt.packet),
          risk: jsonMaybe(opt.packet)?.risk ?? null,
          ticket: opt.ticket,
          attempt: Number.isFinite(a) ? a : null,
          skills: opt.skills,
          lenses: opt.lenses,
          model: opt.model,
          routeReasons: route && Array.isArray(route.reasons) ? route.reasons : [],
          cardPaths,
        }),
      );
      break;
    }
    case "with-risk": {
      const packet = jsonMaybe(opt.packet);
      if (packet) outJson({ ...packet, risk: jsonMaybe(opt.risk) });
      break;
    }
    default:
      break;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).catch(() => process.exit(0));
}
