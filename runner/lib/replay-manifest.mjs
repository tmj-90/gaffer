#!/usr/bin/env node
// runner/lib/replay-manifest.mjs: the REPLAY MANIFEST of one delivery attempt (delta
// roadmap gap 4, P0).
//
// One JSON file per attempt under $GAFFER_DATA/manifests/<ticket>-<n>.json (n counts the
// ticket's attempts across ticks), written when the attempt starts and completed when it
// ends, whichever way it ends (submit, a gate's rework, a park, a pause at a cap, a
// usage-window or budget refusal, a kill). It records what an offline experiment needs to
// re-run the attempt and what the scorecards join on, and nothing else:
//
//   ticket     id and number
//   attempt    the ticket's attempt n, the in-tick attempt, its ledger attempt id, phase/role
//   repos      each write repo: name, local path, base ref, base commit, registered test command
//              (secret-looking assignments redacted), stack; the head commit at the end
//   routing    declared and effective risk, the router's tier, model, provider and reasons
//   settings   the knobs that shape an attempt (GAFFER_SCOUT, GAFFER_SCOUT_PACKET,
//              GAFFER_TESTING, memory priming on/off, the skills mounted, sandbox mode)
//   hashes     sha256 of the prompt and of the scout packet: never their text
//   ledger     the usage-ledger row it joins to (kind delivery, ticket, attempt_id)
//   outcome    as the runner knows it: submit / rework:<gate> / park:<gate> / paused:<why> /
//              released:<to>:<code> / failed / killed / ended, the rc, the gate rows, and
//              later the lane verdicts (tester included) and the landed sha
//
// BOUNDED: every string is capped, every list is capped, and a manifest over MAX_BYTES
// drops its optional lists before it is written. NO SECRETS, NO TEXT: values come from a
// fixed list of fields, a setting is kept only when it is a short token, the prompt and
// packet are hashed, a test command loses anything that looks like a credential. The
// runner calls this fail-soft (lib/replay-manifest.sh): a failure is logged, never fatal.
//
// CLI (lib/replay-manifest.sh is the only caller on the live path):
//   node replay-manifest.mjs start  --dir D --ticket N [--ticket-id ID] --attempt K [...]
//        (prompt on stdin; prints the manifest path)
//   node replay-manifest.mjs finish --file F --outcome O [--rc N] [--gates-file G] [--heads-file H]
//   node replay-manifest.mjs close  --file F --cause signal|exit   (only an OPEN manifest)
//   node replay-manifest.mjs annotate --dir D --ticket N [--lane L --verdict V] [--landed-sha S]
//   node replay-manifest.mjs read --dir D [--ticket N]          (JSONL of the manifests)
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const MANIFEST_SCHEMA = "gaffer.replay-manifest/1";
export const MAX_BYTES = 16 * 1024;
const MAX_STR = 200;
const MAX_REPOS = 16;
const MAX_REASONS = 8;
const MAX_SKILLS = 32;
const MAX_GATES = 32;
const MAX_LANES = 8;
const RISKS = new Set(["low", "medium", "high", "critical"]);

/** The settings a manifest records, by env name. Values must be short tokens. */
export const SETTING_KEYS = [
  "GAFFER_SCOUT",
  "GAFFER_SCOUT_PACKET",
  "GAFFER_TESTING",
  "GAFFER_WORKER_PROVIDER",
  "STRICT_MODE",
  "SANDBOX_PROVIDER",
  "GAFFER_MAX_DELIVERY_ATTEMPTS",
  "REVIEW_MODE",
  "GAFFER_MODE",
];

const cap = (v, n = MAX_STR) => {
  if (v == null) return null;
  const s = String(v)
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return s ? s.slice(0, n) : null;
};
/** A short token (a setting value, a tier, a gate name): anything else is dropped. */
const token = (v) => {
  const s = cap(v, 64);
  return s && /^[A-Za-z0-9._:/@+-]{1,64}$/.test(s) ? s : null;
};
const sha = (v) => (typeof v === "string" && /^[0-9a-f]{7,64}$/.test(v) ? v : null);
const posInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * A registered test command with anything that looks like a credential removed: a
 * `NAME=value` whose name says key/token/secret/password/auth/credential, a `--token x`
 * style flag value, a URL's user:password, and any long opaque token.
 */
export function redactCommand(cmd) {
  const s = cap(cmd, MAX_STR);
  if (!s) return null;
  return s
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASS(?:WORD)?|AUTH|CREDENTIAL|PWD)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi,
      "$1=<redacted>",
    )
    .replace(
      /(--?(?:[a-z-]*(?:token|secret|password|passwd|api-key|apikey|auth)[a-z-]*))(=|\s+)("[^"]*"|'[^']*'|\S+)/gi,
      "$1$2<redacted>",
    )
    .replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1<redacted>@")
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "<redacted>");
}

/** sha256 hex of a string, or null for an empty one. */
export function hashText(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  return createHash("sha256").update(text).digest("hex");
}

function readJson(path) {
  if (!path) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function hashFile(path) {
  if (!path) return null;
  try {
    const buf = readFileSync(path);
    return buf.length ? createHash("sha256").update(buf).digest("hex") : null;
  } catch {
    return null;
  }
}

/** TSV rows (`a\tb\t…`) of a small file, or []. */
function tsv(path) {
  if (!path) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => l.split("\t"));
  } catch {
    return [];
  }
}

/**
 * Build the attempt's opening manifest. Pure apart from the files named in `inp`
 * (the ticket show JSON, the route decision, the repo rows, the scout packet).
 */
export function buildStart(inp, env = process.env) {
  const show = readJson(inp.showFile) ?? {};
  const t = show.ticket && typeof show.ticket === "object" ? show.ticket : {};
  const repoMeta = new Map();
  for (const r of Array.isArray(show.repositories) ? show.repositories : []) {
    if (!r || typeof r !== "object") continue;
    const meta = { test: r.test_command, stack: r.stack };
    if (r.id) repoMeta.set(String(r.id), meta);
    if (r.name) repoMeta.set(`name:${r.name}`, meta);
  }
  const bases = new Map(tsv(inp.basesFile).map((c) => [c[0], c[1]]));
  const repos = [];
  for (const c of tsv(inp.reposFile).slice(0, MAX_REPOS)) {
    const [rid, rname, rpath, rbase] = c;
    const meta = repoMeta.get(String(rid)) ?? repoMeta.get(`name:${rname}`) ?? {};
    repos.push({
      id: cap(rid, 64),
      name: cap(rname, 80),
      // The real repo's local path: where an offline experiment re-creates the base.
      path: cap(rpath, MAX_STR),
      base_ref: token(rbase) ?? "main",
      base_commit: sha(bases.get(rpath)) ?? null,
      test_command: redactCommand(meta.test),
      stack: token(meta.stack),
    });
  }
  const route = readJson(inp.routeFile);
  const reasons = Array.isArray(route?.reasons)
    ? route.reasons
        .filter((x) => typeof x === "string")
        .slice(0, MAX_REASONS)
        .map((x) => cap(x, 160))
    : [];
  // The ticket's own declared risk; the effective one is what the router saw (the scout's
  // classifier can only raise it).
  const declaredRaw = inp.riskDeclared ?? t.risk_level;
  const declared = RISKS.has(String(declaredRaw)) ? String(declaredRaw) : null;
  const effective = RISKS.has(String(inp.riskEffective)) ? String(inp.riskEffective) : declared;
  const settings = {};
  for (const k of SETTING_KEYS) {
    const v = token(env[k]);
    if (v !== null) settings[k] = v;
  }
  settings.memory_priming = {
    product_context: inp.productContext === "1",
    file_cards: inp.fileCards === "1",
  };
  settings.skills_mounted = String(inp.skills ?? "")
    .split(/[,\s]+/)
    .map((s) => token(s))
    .filter(Boolean)
    .slice(0, MAX_SKILLS);
  const attemptId =
    typeof inp.attemptId === "string" && /^[A-Za-z0-9._:/-]{1,96}$/.test(inp.attemptId)
      ? inp.attemptId
      : null;
  const number = posInt(inp.ticket);
  return {
    schema: MANIFEST_SCHEMA,
    status: "open",
    written_at: new Date().toISOString(),
    completed_at: null,
    ticket: { id: cap(t.id ?? inp.ticketId, 64), number },
    attempt: {
      n: null,
      in_tick: posInt(inp.attempt),
      max: posInt(inp.maxAttempts),
      id: attemptId,
      started_at:
        typeof inp.startedAt === "string" && !Number.isNaN(Date.parse(inp.startedAt))
          ? new Date(Date.parse(inp.startedAt)).toISOString()
          : null,
      phase: token(inp.phase) ?? "implement",
      role: "delivery",
      resumed: inp.resumed === "1",
    },
    repos,
    routing: {
      declared_risk: declared,
      effective_risk: effective,
      risk_raised: declared !== null && effective !== null && declared !== effective,
      ac_count: Number.isInteger(Number(inp.acCount)) ? Number(inp.acCount) : null,
      tier: token(route?.tier),
      model: token(route?.model),
      attempt_model: token(inp.attemptModel) ?? null,
      provider: token(env.GAFFER_WORKER_PROVIDER) ?? "claude-code",
      reasons,
    },
    settings,
    hashes: {
      prompt_sha256: hashText(inp.prompt ?? ""),
      prompt_bytes: Buffer.byteLength(inp.prompt ?? "", "utf8"),
      scout_packet_sha256: hashFile(inp.packetFile),
    },
    ledger: { kind: "delivery", ticket: number, attempt_id: attemptId },
    outcome: null,
  };
}

/** Outcome strings the runner writes. Anything else is stored as `other`. */
const OUTCOME_RE =
  /^(?:submit|failed(?::[a-z0-9_-]{1,40})?|killed|ended|usage_paused|auth_error|budget_refused|(?:rework|park|paused):[A-Za-z0-9_.-]{1,48}|released:[a-z_]{1,16}(?::[a-z0-9_]{1,40})?)$/;

export function buildOutcome(inp) {
  const raw = String(inp.outcome ?? "");
  const result = OUTCOME_RE.test(raw) ? raw : "other";
  const colon = result.indexOf(":");
  const gates = tsv(inp.gatesFile)
    .filter((c) => c[0] === "GATE")
    .slice(0, MAX_GATES)
    .map((c) => ({ gate: token(c[1]), repo: cap(c[2], 80), status: token(c[3]) }));
  // One `name\thead` row per write repo: the commit its branch held when the attempt ended.
  const heads = tsv(inp.headsFile).map((c) => ({ name: c[0], head: sha(c[1]) }));
  const rc = Number(inp.rc);
  return {
    out: {
      result,
      kind: colon > 0 ? result.slice(0, colon) : result,
      gate: colon > 0 ? result.slice(colon + 1) : null,
      rc: Number.isInteger(rc) ? rc : null,
      gates,
      tester_verdict: null,
      lane_verdicts: {},
      landed_sha: null,
      exit_cause: token(inp.cause),
    },
    heads,
  };
}

/** Serialise within MAX_BYTES: drop the optional lists first, never the join keys. */
export function boundedJson(m) {
  let s = JSON.stringify(m);
  if (Buffer.byteLength(s) <= MAX_BYTES) return s;
  const c = structuredClone(m);
  c.routing.reasons = c.routing.reasons.slice(0, 2);
  c.settings.skills_mounted = c.settings.skills_mounted.slice(0, 4);
  if (c.outcome) c.outcome.gates = c.outcome.gates.slice(0, 4);
  c.truncated = true;
  s = JSON.stringify(c);
  if (Buffer.byteLength(s) <= MAX_BYTES) return s;
  c.repos = c.repos.slice(0, 2).map((r) => ({ ...r, test_command: null }));
  c.routing.reasons = [];
  c.settings.skills_mounted = [];
  if (c.outcome) c.outcome.gates = [];
  return JSON.stringify(c);
}

function writeAtomic(path, obj) {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, boundedJson(obj) + "\n");
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** The ticket's manifests in attempt order: [{n, path}]. */
export function ticketManifests(dir, ticket) {
  const n = posInt(ticket);
  if (!n || !existsSync(dir)) return [];
  const re = new RegExp(`^${n}-(\\d+)\\.json$`);
  return readdirSync(dir)
    .map((f) => {
      const m = f.match(re);
      return m ? { n: Number(m[1]), path: join(dir, f) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
}

/** Create the next attempt's file (exclusive create, so two writers never share one). */
export function startManifest(dir, inp, env = process.env) {
  const m = buildStart(inp, env);
  const ticket = m.ticket.number;
  if (!ticket) throw new Error("a manifest needs a ticket number");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = ticketManifests(dir, ticket);
  let n = (existing.length ? existing[existing.length - 1].n : 0) + 1;
  for (let tries = 0; tries < 50; tries += 1, n += 1) {
    const path = join(dir, `${ticket}-${n}.json`);
    let fd;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if (e && e.code === "EEXIST") continue;
      throw e;
    }
    closeSync(fd);
    m.attempt.n = n;
    writeAtomic(path, m);
    return path;
  }
  throw new Error("no free manifest slot");
}

/** Complete an open manifest. A complete one is left as it is (the first outcome wins). */
export function finishManifest(path, inp) {
  const m = readJson(path);
  if (!m || m.schema !== MANIFEST_SCHEMA) return false;
  if (m.status === "complete") return false;
  const { out, heads } = buildOutcome(inp);
  m.outcome = out;
  const byName = new Map(heads.map((h) => [h.name, h.head]));
  for (const r of m.repos) {
    const h = byName.get(r.name ?? "");
    if (h) r.head_commit = h;
  }
  m.status = "complete";
  m.completed_at = new Date().toISOString();
  writeAtomic(path, m);
  return true;
}

/** Add a later fact (a lane verdict, the landed sha) to the ticket's latest manifest. */
export function annotateManifest(dir, inp) {
  const list = ticketManifests(dir, inp.ticket);
  if (!list.length) return false;
  const path = list[list.length - 1].path;
  const m = readJson(path);
  if (!m || m.schema !== MANIFEST_SCHEMA) return false;
  m.outcome ??= buildOutcome({ outcome: "ended" }).out;
  const lane = token(inp.lane);
  const verdict = token(inp.verdict);
  if (lane && verdict) {
    const lanes = m.outcome.lane_verdicts ?? {};
    if (lane in lanes || Object.keys(lanes).length < MAX_LANES) lanes[lane] = verdict;
    m.outcome.lane_verdicts = lanes;
    if (lane === "tester") m.outcome.tester_verdict = verdict;
  }
  const landed = sha(inp.landedSha);
  if (landed) m.outcome.landed_sha = landed;
  writeAtomic(path, m);
  return true;
}

/** Every manifest under dir (optionally one ticket's), parsed; unreadable files skipped. */
export function readManifests(dir, ticket = null) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /^\d+-\d+\.json$/.test(f));
  const out = [];
  for (const f of files) {
    if (ticket != null && !f.startsWith(`${ticket}-`)) continue;
    const m = readJson(join(dir, f));
    if (m && m.schema === MANIFEST_SCHEMA) out.push(m);
  }
  return out.sort(
    (a, b) => (a.ticket?.number ?? 0) - (b.ticket?.number ?? 0) || a.attempt.n - b.attempt.n,
  );
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) o[key] = "1";
    else {
      o[key] = next;
      i += 1;
    }
  }
  return o;
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const o = parseArgs(rest);
  switch (cmd) {
    case "start": {
      o.prompt = o.promptStdin === "1" ? readStdin() : "";
      process.stdout.write(startManifest(o.dir, o) + "\n");
      return 0;
    }
    case "finish":
      finishManifest(o.file, o);
      return 0;
    case "close": {
      const m = readJson(o.file);
      if (!m || m.status !== "open") return 0;
      finishManifest(o.file, {
        outcome: o.cause === "signal" ? "killed" : "ended",
        cause: o.cause,
        headsFile: o.headsFile,
      });
      return 0;
    }
    case "annotate":
      annotateManifest(o.dir, o);
      return 0;
    case "read":
      for (const m of readManifests(o.dir, o.ticket ? posInt(o.ticket) : null))
        process.stdout.write(JSON.stringify(m) + "\n");
      return 0;
    default:
      process.stderr.write("replay-manifest: start | finish | close | annotate | read\n");
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    process.stderr.write(`replay-manifest: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
}
