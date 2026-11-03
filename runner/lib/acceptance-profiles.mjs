#!/usr/bin/env node
// Gaffer factory — ACCEPTANCE PROFILES (Release C: C1 CLI, C2 API).
//
// "Accepted" should mean the change was exercised the way a user meets it, with evidence
// the RUNNER recorded, never the agent's word. A ticket's test contract can name a profile
// (packages/dispatch/src/domain/acceptanceProfile.ts) and a PERSON registers what to run
// for it. After the tester's PASS survived the clean replay (bin/tester-run.mjs), the
// runner runs those commands itself, in the same clean checkout of the tested commit:
//   cli  each registered argv (never a shell string), with stdin, a throwaway HOME and a
//        time cap: argv, exit code, stdout/stderr (sha256 + a bounded, redacted excerpt),
//        duration and the checkout's filesystem diff; then the expectations (exit code,
//        stdout/stderr patterns, files) are checked.
//   api  the registered boot argv on a free port (the port in an env var), in its own
//        process group, polled on its health path with a deadline, then each probe
//        (method, path, headers, body): status, a headers subset, the body's sha256 and a
//        bounded excerpt; expectations: status (negative and auth probes expect a 4xx),
//        body substrings, JSON keys and, where a schema file is declared, a JSON-schema
//        subset check of the body. The process group is killed whatever happens.
// Every spawn goes through the sandbox seam the DoD gates use (lib/worker.mjs
// sandboxWrapArgv -> lib/sandbox.sh, the validation profile: no data plane, no model
// credential), with a stripped environment (PATH, a throwaway HOME, TMPDIR, locale, CI=1
// and the spec's own env). A required sandbox the host cannot supply refuses the run
// (the PASS is then held). Under the docker provider the api profile is refused: its
// probes run on the host and the container sits on an internal network.
//
// The transcript is canonicalised, hashed (digest) and HMAC-signed with a key only the
// runner holds ($GAFFER_DATA/acceptance-signing.key, mode 0600), so a row typed in by
// hand can be told from the runner's own record. Excerpts are redacted with the crew
// redaction (packages/crew/dist/safety/redaction.js); without it nothing is recorded.
//
// CLI (used by bin/tester-run.mjs, which stays synchronous):
//   node lib/acceptance-profiles.mjs run --profile cli|api --checkout <dir> --spec-file <json>
//   -> one JSON object on stdout: { passed, reason, sandbox, cases: [...] }
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sandboxWanted, sandboxWrapArgv } from "./worker.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(HERE, "..");
const GAFFER_HOME = resolve(RUNNER_DIR, "..");

/** The profiles the runner runs today; the rest are defined in dispatch, not executable. */
export const RUNNABLE_PROFILES = Object.freeze(["cli", "api"]);
export const ALL_PROFILES = Object.freeze([
  "unit",
  "cli",
  "api",
  "web",
  "migration",
  "performance",
]);

export const EXCERPT_CHARS = 4000;
export const BODY_EXCERPT_CHARS = 2000;
export const PAYLOAD_MAX = 60 * 1024; // dispatch caps the payload at 64 KB
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_MAX_FILES = 20000;
const HASH_MAX_BYTES = 1024 * 1024;
const DIFF_LIST_MAX = 50;

const falsy = (v) => /^(0|false|no|off)$/i.test(String(v ?? "").trim());
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/** The profile and spec a parsed test contract names (unknown profile reads as unit). */
export function contractProfile(contract) {
  const p = contract && typeof contract.profile === "string" ? contract.profile : "unit";
  const profile = ALL_PROFILES.includes(p) ? p : "unit";
  const spec =
    profile !== "unit" &&
    contract.profile_spec &&
    typeof contract.profile_spec === "object" &&
    !Array.isArray(contract.profile_spec)
      ? contract.profile_spec
      : null;
  return { profile, spec };
}

/** The overall time cap for one profile run (GAFFER_ACCEPTANCE_TIMEOUT_MS, default 5 min). */
export function acceptanceTimeoutMs(env = process.env) {
  const v = Number(env.GAFFER_ACCEPTANCE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 5 * 60 * 1000;
}

/**
 * The stripped environment a profile command runs in (an allowlist, never the runner's
 * env): PATH, the throwaway HOME, TMPDIR, locale, CI=1, then the spec's own variables.
 * No DISPATCH_API_TOKEN, GITHUB_TOKEN, model credential or cloud key crosses.
 */
export function profileEnv({ home, extra = {}, base = process.env }) {
  const env = {
    PATH: base.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: base.TMPDIR || tmpdir(),
    LANG: base.LANG || "C.UTF-8",
    CI: "1",
    NO_COLOR: "1",
  };
  if (base.LC_ALL) env.LC_ALL = base.LC_ALL;
  for (const [k, v] of Object.entries(extra || {}))
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v);
  return env;
}

/**
 * The sandbox posture for a profile run: the same decision the DoD gates make (wrap when
 * the sandbox is on or required, GAFFER_DOD_SANDBOX=0 opts out), from the same provider
 * seam, with the validation profile. → { ok, wrap: string[], label, docker, message? }.
 */
export function profileSandbox({ writeRoots, env = process.env }) {
  if (!sandboxWanted(env))
    return { ok: true, wrap: [], label: "none (no OS sandbox configured)", docker: false };
  if (falsy(env.GAFFER_DOD_SANDBOX))
    return { ok: true, wrap: [], label: "none (GAFFER_DOD_SANDBOX=0)", docker: false };
  const wrapped = sandboxWrapArgv({
    writeRoots: writeRoots.join("\n"),
    readRoots: "",
    env: {
      ...env,
      GAFFER_SANDBOX_PROFILE: "validation",
      GAFFER_MCP_BRIDGE_SOCKET: "",
      GAFFER_SANDBOX_DATA_PLANE: "none",
    },
  });
  if (!wrapped.ok)
    return { ok: false, wrap: [], label: "refused", docker: false, message: wrapped.message };
  const docker = wrapped.wrap.some((w) => /(^|\/)sandbox-docker\.sh$/.test(w));
  return {
    ok: true,
    wrap: wrapped.wrap,
    label: wrapped.wrap.length
      ? `${env.SANDBOX_PROVIDER || "sandbox-exec"} (validation profile)`
      : "none (the provider added no wrap)",
    docker,
  };
}

/** The spawn [bin, args, env] for argv under the sandbox posture `sb` (see profileSandbox). */
export function wrappedSpawn(argv, env, sb, base = process.env) {
  if (!sb.wrap.length) return [argv[0], argv.slice(1), env];
  const wrapperEnv = {
    ...env,
    PATH: base.PATH || env.PATH,
    RUNNER_DIR,
    GAFFER_HOME: base.GAFFER_HOME || GAFFER_HOME,
    GAFFER_DATA: base.GAFFER_DATA || resolve(GAFFER_HOME, ".gaffer"),
    GAFFER_SANDBOX_PROFILE: "validation",
    GAFFER_MCP_BRIDGE_SOCKET: "",
    GAFFER_SANDBOX_DATA_PLANE: "none",
  };
  const inner = sb.docker
    ? [
        "env",
        "-i",
        ...Object.entries({
          ...env,
          HOME: base.GAFFER_SANDBOX_HOME || "/root",
          PATH:
            base.GAFFER_SANDBOX_PATH ||
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          TMPDIR: "/tmp",
        }).map(([k, v]) => `${k}=${v}`),
        ...argv,
      ]
    : argv;
  return [sb.wrap[0], [...sb.wrap.slice(1), ...inner], wrapperEnv];
}

/** A bounded, redacted view of one output stream: sha256 and byte count of the whole. */
export function streamRecord(text, redact, max = EXCERPT_CHARS) {
  const s = String(text ?? "");
  const red = redact(s);
  return {
    sha256: sha256(s),
    bytes: Buffer.byteLength(s),
    excerpt:
      red.length > max ? red.slice(0, max) + `\n[... ${red.length - max} more characters]` : red,
  };
}

/** `/re/flags` is a regular expression, anything else a plain substring. */
export function matchesPattern(text, pattern) {
  const m = /^\/(.+)\/([imsu]*)$/s.exec(String(pattern));
  if (m) {
    try {
      return new RegExp(m[1], m[2]).test(text);
    } catch {
      return false;
    }
  }
  return String(text).includes(String(pattern));
}

/** Resolve `rel` inside `root`, never outside it (a symlink out is refused): abs path or null. */
export function confinedPath(root, rel) {
  if (typeof rel !== "string" || !rel || rel.startsWith("/") || rel.includes("\0")) return null;
  if (rel.split(/[\\/]/).includes("..")) return null;
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return null;
  }
  const abs = resolve(realRoot, rel);
  if (!(abs === realRoot || abs.startsWith(realRoot + sep))) return null;
  try {
    const real = realpathSync(abs);
    if (!(real === realRoot || real.startsWith(realRoot + sep))) return null;
  } catch {
    /* does not exist (yet): the lexical check above is the confinement */
  }
  return abs;
}

/**
 * A snapshot of the checkout: relative path -> content hash (or size+mtime for a big
 * file), skipping .git and node_modules, never following a symlinked directory.
 */
export function snapshotTree(root) {
  const out = new Map();
  const walk = (rel) => {
    if (out.size >= SNAPSHOT_MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(childRel);
      else {
        const abs = join(root, childRel);
        try {
          const st = lstatSync(abs);
          if (st.isSymbolicLink()) out.set(childRel, `link:${sha256(String(readlinkSafe(abs)))}`);
          else if (st.size > HASH_MAX_BYTES) out.set(childRel, `size:${st.size}:${st.mtimeMs}`);
          else out.set(childRel, sha256(readFileSync(abs)));
        } catch {
          /* vanished */
        }
        if (out.size >= SNAPSHOT_MAX_FILES) return;
      }
    }
  };
  walk("");
  return out;
}
function readlinkSafe(p) {
  try {
    return realpathSync(p);
  } catch {
    return "";
  }
}

/** What changed between two snapshots (each list bounded). */
export function diffTrees(before, after) {
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [p, h] of after) {
    if (!before.has(p)) added.push(p);
    else if (before.get(p) !== h) modified.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) deleted.push(p);
  const cap = (l) => ({
    list: l.sort().slice(0, DIFF_LIST_MAX),
    more: Math.max(0, l.length - DIFF_LIST_MAX),
  });
  const a = cap(added);
  const m = cap(modified);
  const d = cap(deleted);
  return {
    added: a.list,
    modified: m.list,
    deleted: d.list,
    ...(a.more || m.more || d.more ? { truncated: a.more + m.more + d.more } : {}),
  };
}

/** Check one CLI case's expectations against what ran. → checks [{what, held, detail}] */
export function cliChecks(expect, ran, checkout) {
  const e = expect || {};
  const checks = [];
  const want = Number.isInteger(e.exit) ? e.exit : 0;
  checks.push({
    what: `exit code ${want}`,
    held: ran.exit === want,
    detail: ran.timed_out
      ? "timed out"
      : ran.exit === null
        ? `killed (${ran.signal ?? "no exit code"})`
        : `exited ${ran.exit}`,
  });
  for (const p of e.stdout || [])
    checks.push({ what: `stdout has ${p}`, held: matchesPattern(ran.stdoutText, p) });
  for (const p of e.stderr || [])
    checks.push({ what: `stderr has ${p}`, held: matchesPattern(ran.stderrText, p) });
  for (const p of e.stdout_absent || [])
    checks.push({ what: `stdout lacks ${p}`, held: !matchesPattern(ran.stdoutText, p) });
  for (const f of e.files || []) {
    const abs = confinedPath(checkout, f.path);
    const wantExists = f.exists !== false;
    if (!abs) {
      checks.push({ what: `file ${f.path}`, held: false, detail: "outside the checkout" });
      continue;
    }
    const exists = existsSync(abs);
    checks.push({
      what: `file ${f.path} ${wantExists ? "exists" : "is absent"}`,
      held: exists === wantExists,
    });
    if (wantExists && exists && f.contains) {
      let body;
      try {
        body = statSync(abs).size <= HASH_MAX_BYTES ? readFileSync(abs, "utf8") : "";
      } catch {
        body = "";
      }
      checks.push({
        what: `file ${f.path} contains ${f.contains}`,
        held: body.includes(f.contains),
      });
    }
  }
  return checks;
}

/**
 * C1: run each registered CLI case in `checkout`. Pure apart from the spawns; `redact` is
 * the redaction function. → { passed, reason, cases }
 */
export function runCliProfile({ checkout, spec, redact, sb, env = process.env, deadline }) {
  const cases = Array.isArray(spec?.cases) ? spec.cases : [];
  if (cases.length === 0)
    return { passed: false, reason: "no commands are registered for the cli profile", cases: [] };
  const home = mkdtempSync(join(tmpdir(), "gaffer-accept-home-"));
  const out = [];
  try {
    for (const [i, c] of cases.entries()) {
      const argv = Array.isArray(c.argv) ? c.argv.map(String) : [];
      const name = c.name || `case ${i + 1}`;
      if (!argv.length) {
        out.push({
          name,
          argv,
          held: false,
          checks: [{ what: "argv", held: false, detail: "empty" }],
        });
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        out.push({
          name,
          argv,
          held: false,
          checks: [{ what: "ran", held: false, detail: "the profile's time cap ran out" }],
        });
        continue;
      }
      const timeout = Math.min(Number(c.timeout_ms) > 0 ? Number(c.timeout_ms) : 30000, left);
      const before = snapshotTree(checkout);
      const cenv = profileEnv({ home, extra: c.env, base: env });
      const [bin, args, spawnEnv] = wrappedSpawn(argv, cenv, sb, env);
      const t0 = Date.now();
      const r = spawnSync(bin, args, {
        cwd: checkout,
        env: spawnEnv,
        input: typeof c.stdin === "string" ? c.stdin : "",
        encoding: "utf8",
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT_BYTES,
        detached: true,
      });
      if (r.pid && (r.signal || r.error)) {
        try {
          process.kill(-r.pid, "SIGKILL");
        } catch {
          /* the group is already gone */
        }
      }
      const duration = Date.now() - t0;
      const after = snapshotTree(checkout);
      const timedOut = !!r.error && r.error.code === "ETIMEDOUT";
      const ran = {
        exit: typeof r.status === "number" ? r.status : null,
        signal: r.signal || null,
        timed_out: timedOut,
        stdoutText: r.stdout || "",
        stderrText: r.stderr || "",
      };
      const checks =
        r.error && !timedOut && r.error.code !== "ENOBUFS"
          ? [
              {
                what: "ran",
                held: false,
                detail: `could not start: ${r.error.code || r.error.message}`,
              },
            ]
          : cliChecks(c.expect, ran, checkout);
      out.push({
        name,
        argv: argv.map((a) => redact(a)),
        ...(typeof c.stdin === "string" ? { stdin: streamRecord(c.stdin, redact, 500) } : {}),
        exit: ran.exit,
        signal: ran.signal,
        timed_out: timedOut,
        duration_ms: duration,
        stdout: streamRecord(ran.stdoutText, redact),
        stderr: streamRecord(ran.stderrText, redact),
        fs: diffTrees(before, after),
        checks,
        held: checks.every((k) => k.held),
      });
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const bad = out.filter((c) => !c.held);
  return {
    passed: bad.length === 0,
    reason: bad.length
      ? `${bad.length} of ${out.length} commands did not meet their expectations (first: ${bad[0].name}: ${bad[0].checks
          .filter((k) => !k.held)
          .map((k) => k.what + (k.detail ? ` (${k.detail})` : ""))
          .join("; ")})`
      : `${out.length} ${out.length === 1 ? "command" : "commands"} met their expectations`,
    cases: out,
  };
}

/** A free local port: from GAFFER_ACCEPTANCE_PORT_BASE upward when set, else the kernel's pick. */
export async function freePort(env = process.env) {
  const tryPort = (port) =>
    new Promise((res) => {
      const srv = createServer();
      srv.once("error", () => res(null));
      srv.listen(port, "127.0.0.1", () => {
        const p = srv.address().port;
        srv.close(() => res(p));
      });
    });
  const base = Number(env.GAFFER_ACCEPTANCE_PORT_BASE);
  if (Number.isInteger(base) && base > 0) {
    for (let p = base; p < base + 20; p += 1) {
      const got = await tryPort(p);
      if (got) return got;
    }
    return null;
  }
  return tryPort(0);
}

/** Resolve a JSON pointer ("#/a/b") in `doc`. */
function jsonPointer(doc, ref) {
  const path = String(ref).replace(/^#/, "").split("/").filter(Boolean);
  let cur = doc;
  for (const raw of path) {
    const k = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur && typeof cur === "object" && k in cur) cur = cur[k];
    else return undefined;
  }
  return cur;
}

/**
 * A deterministic JSON-schema SUBSET check (type, required, properties, items, enum,
 * local $ref): the mismatches between `value` and `schema`, at most 20. Not a full
 * validator: what it does not understand it does not judge.
 */
export function schemaDiff(value, schema, root = schema, at = "$", out = [], depth = 0) {
  if (out.length >= 20 || depth > 20 || !schema || typeof schema !== "object") return out;
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#"))
    return schemaDiff(value, jsonPointer(root, schema.$ref), root, at, out, depth + 1);
  const typeOf = (v) =>
    v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const ok = types.some((w) => w === t || (w === "number" && t === "integer"));
    if (!ok) {
      out.push(`${at}: expected ${types.join("|")}, got ${t}`);
      return out;
    }
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))
  )
    out.push(`${at}: not one of the enum values`);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const k of Array.isArray(schema.required) ? schema.required : [])
      if (!(k in value)) out.push(`${at}.${k}: required, missing`);
    for (const [k, sub] of Object.entries(schema.properties || {}))
      if (k in value) schemaDiff(value[k], sub, root, `${at}.${k}`, out, depth + 1);
  }
  if (Array.isArray(value) && schema.items)
    value
      .slice(0, 50)
      .forEach((v, i) => schemaDiff(v, schema.items, root, `${at}[${i}]`, out, depth + 1));
  return out;
}

const HEADER_SUBSET = [
  "content-type",
  "content-length",
  "location",
  "www-authenticate",
  "cache-control",
  "allow",
];

/** Check one probe's expectations against its response. → checks */
export function probeChecks(expect, resp, schemaDoc) {
  const checks = [
    {
      what: `status ${expect.status}`,
      held: resp.status === expect.status,
      detail: `answered ${resp.status}`,
    },
  ];
  for (const p of expect.body_contains || [])
    checks.push({ what: `body has ${p}`, held: matchesPattern(resp.body, p) });
  let json;
  let jsonOk = false;
  if ((expect.json_keys && expect.json_keys.length) || expect.schema_ref) {
    try {
      json = JSON.parse(resp.body);
      jsonOk = true;
    } catch {
      checks.push({ what: "body is JSON", held: false });
    }
  }
  if (jsonOk) {
    for (const k of expect.json_keys || []) {
      const v = k
        .split(".")
        .reduce((o, part) => (o && typeof o === "object" ? o[part] : undefined), json);
      checks.push({ what: `JSON key ${k}`, held: v !== undefined });
    }
    if (expect.schema_ref) {
      const sub = schemaDoc ? jsonPointer(schemaDoc, expect.schema_ref) : undefined;
      if (sub === undefined)
        checks.push({
          what: `schema ${expect.schema_ref}`,
          held: false,
          detail: schemaDoc ? "not found in the schema file" : "no schema file could be read",
        });
      else {
        const diff = schemaDiff(json, sub, schemaDoc);
        checks.push({
          what: `schema ${expect.schema_ref}`,
          held: diff.length === 0,
          ...(diff.length ? { detail: diff.join("; ").slice(0, 600) } : {}),
        });
      }
    }
  }
  return checks;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Kill a detached process group: TERM, a short grace, then KILL. Never throws. */
async function killGroup(child) {
  if (!child || !child.pid) return;
  const alive = () => child.exitCode === null && child.signalCode === null;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* gone */
  }
  for (let i = 0; i < 20 && alive(); i += 1) await sleep(100);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

/**
 * C2: boot the candidate, wait for health, run each probe, kill the group (always).
 * → { passed, reason, cases, boot }
 */
export async function runApiProfile({ checkout, spec, redact, sb, env = process.env, deadline }) {
  const probes = Array.isArray(spec?.probes) ? spec.probes : [];
  const bootArgv = Array.isArray(spec?.boot_argv) ? spec.boot_argv.map(String) : [];
  if (!probes.length || !bootArgv.length)
    return {
      passed: false,
      reason: "no boot command or probes are registered for the api profile",
      cases: [],
    };
  if (sb.docker)
    return {
      passed: false,
      reason:
        "the api profile cannot run under the docker sandbox yet (its probes run on the host and the container sits on an internal network)",
      cases: [],
    };
  const port = await freePort(env);
  if (!port) return { passed: false, reason: "no free local port for the api profile", cases: [] };
  const home = mkdtempSync(join(tmpdir(), "gaffer-accept-home-"));
  const portEnv = spec.port_env || "PORT";
  const cenv = profileEnv({
    home,
    extra: { ...(spec.env || {}), [portEnv]: String(port) },
    base: env,
  });
  const [bin, args, spawnEnv] = wrappedSpawn(bootArgv, cenv, sb, env);
  let stdout = "";
  let stderr = "";
  let child;
  const cases = [];
  const boot = { argv: bootArgv.map((a) => redact(a)), port, port_env: portEnv };
  try {
    try {
      child = spawn(bin, args, {
        cwd: checkout,
        env: spawnEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return {
        passed: false,
        reason: `the boot command could not start (${e?.code || e?.message})`,
        cases,
        boot,
      };
    }
    let spawnError = null;
    child.on("error", (e) => {
      spawnError = e;
    });
    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += d;
    });
    const base = `http://127.0.0.1:${port}`;
    const bootDeadline = Math.min(
      deadline,
      Date.now() + (Number(spec.boot_timeout_ms) > 0 ? Number(spec.boot_timeout_ms) : 30000),
    );
    const t0 = Date.now();
    let healthy = false;
    let lastHealth = "no answer";
    while (Date.now() < bootDeadline) {
      if (spawnError || child.exitCode !== null || child.signalCode !== null) break;
      try {
        const r = await fetch(base + spec.health_path, { signal: AbortSignal.timeout(2000) });
        lastHealth = `answered ${r.status}`;
        await r.arrayBuffer().catch(() => null);
        if (r.status >= 200 && r.status < 300) {
          healthy = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await sleep(200);
    }
    boot.health = { path: spec.health_path, healthy, waited_ms: Date.now() - t0, last: lastHealth };
    if (!healthy) {
      const why = spawnError
        ? `could not start (${spawnError.code || spawnError.message})`
        : child.exitCode !== null || child.signalCode !== null
          ? `exited ${child.exitCode ?? child.signalCode} before it was healthy`
          : `${spec.health_path} was not healthy within the boot deadline (${lastHealth})`;
      return { passed: false, reason: `the service ${why}`, cases, boot };
    }
    let schemaDoc = null;
    if (spec.schema_path) {
      const abs = confinedPath(checkout, spec.schema_path);
      try {
        schemaDoc = abs ? JSON.parse(readFileSync(abs, "utf8")) : null;
      } catch {
        schemaDoc = null;
      }
      boot.schema = { path: spec.schema_path, read: schemaDoc !== null };
    }
    for (const [i, p] of probes.entries()) {
      const name = p.name || `${p.method || "GET"} ${p.path}`;
      if (Date.now() >= deadline) {
        cases.push({
          name,
          held: false,
          checks: [{ what: "ran", held: false, detail: "the profile's time cap ran out" }],
        });
        continue;
      }
      const method = p.method || "GET";
      const headers = { ...(p.headers || {}) };
      let body;
      if (p.body !== undefined && method !== "GET" && method !== "HEAD") {
        if (typeof p.body === "string") body = p.body;
        else {
          body = JSON.stringify(p.body);
          if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type"))
            headers["content-type"] = "application/json";
        }
      }
      const t1 = Date.now();
      let resp;
      try {
        const r = await fetch(base + p.path, {
          method,
          headers,
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(Math.max(1000, Math.min(10000, deadline - Date.now()))),
        });
        const text = await r.text();
        const h = {};
        for (const k of HEADER_SUBSET) if (r.headers.get(k) !== null) h[k] = r.headers.get(k);
        resp = { status: r.status, headers: h, body: text };
      } catch (e) {
        cases.push({
          name,
          request: { method, path: p.path },
          held: false,
          checks: [
            {
              what: "answered",
              held: false,
              detail: String(e?.cause?.code || e?.name || e?.message || e),
            },
          ],
        });
        continue;
      }
      const checks = probeChecks(p.expect || { status: 200 }, resp, schemaDoc);
      cases.push({
        name,
        index: i,
        request: {
          method,
          path: redact(p.path),
          headers: Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [
              k,
              /^(authorization|cookie|x-api-key)$/i.test(k) ? "[REDACTED]" : redact(String(v)),
            ]),
          ),
          ...(body !== undefined ? { body: streamRecord(body, redact, 500) } : {}),
        },
        response: {
          status: resp.status,
          headers: resp.headers,
          body: streamRecord(resp.body, redact, BODY_EXCERPT_CHARS),
        },
        duration_ms: Date.now() - t1,
        checks,
        held: checks.every((k) => k.held),
      });
    }
  } finally {
    await killGroup(child);
    boot.stdout = streamRecord(stdout, redact, 1500);
    boot.stderr = streamRecord(stderr, redact, 1500);
    rmSync(home, { recursive: true, force: true });
  }
  const bad = cases.filter((c) => !c.held);
  return {
    passed: bad.length === 0,
    reason: bad.length
      ? `${bad.length} of ${cases.length} probes did not meet their expectations (first: ${bad[0].name}: ${bad[0].checks
          .filter((k) => !k.held)
          .map((k) => k.what + (k.detail ? ` (${k.detail})` : ""))
          .join("; ")})`
      : `${cases.length} ${cases.length === 1 ? "probe" : "probes"} met their expectations`,
    cases,
    boot,
  };
}

/** Load the crew redaction (fail closed: null when it cannot be loaded). */
export async function loadRedaction(env = process.env) {
  const path =
    env.GAFFER_REDACTION_MODULE || resolve(GAFFER_HOME, "packages/crew/dist/safety/redaction.js");
  try {
    const mod = await import(pathToFileURL(path).href);
    return typeof mod.redact === "function" ? (s) => mod.redact(String(s ?? "")) : null;
  } catch {
    return null;
  }
}

/** Run one profile end to end. → { passed, reason, sandbox, cases, boot? } */
export async function runProfile({ profile, checkout, spec, env = process.env }) {
  if (!RUNNABLE_PROFILES.includes(profile))
    return {
      passed: false,
      reason: `the ${profile} profile is not run by the runner yet`,
      sandbox: "none",
      cases: [],
    };
  const redact = await loadRedaction(env);
  if (!redact)
    return {
      passed: false,
      reason:
        "the redaction module could not be loaded, so no transcript is recorded (build packages/crew)",
      sandbox: "none",
      cases: [],
    };
  const sb = profileSandbox({ writeRoots: [checkout, tmpdir()], env });
  if (!sb.ok)
    return {
      passed: false,
      reason: sb.message || "the sandbox refused the run",
      sandbox: "refused",
      cases: [],
    };
  const deadline = Date.now() + acceptanceTimeoutMs(env);
  const res =
    profile === "cli"
      ? runCliProfile({ checkout, spec, redact, sb, env, deadline })
      : await runApiProfile({ checkout, spec, redact, sb, env, deadline });
  return { ...res, sandbox: sb.label, reason: redact(res.reason || "") };
}

/** The runner's signing key ($GAFFER_DATA/acceptance-signing.key, created 0600). */
export function signingKey(gafferData) {
  const path = resolve(gafferData, "acceptance-signing.key");
  try {
    if (existsSync(path)) return readFileSync(path, "utf8").trim();
    mkdirSync(gafferData, { recursive: true });
    const k = randomBytes(32).toString("hex");
    writeFileSync(path, k + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
    return k;
  } catch {
    return "";
  }
}

/** Canonical JSON (sorted keys) for the digest. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

const signedPart = (p) => ({
  profile: p.profile,
  kind: p.kind,
  tested_commit: p.tested_commit,
  contract_hash: p.contract_hash,
  passed: p.passed,
  cases: p.cases,
  ...(p.boot ? { boot: p.boot } : {}),
});

/**
 * The evidence payload dispatch stores (ticket acceptance-evidence): bound to the tested
 * commit and contract, digested and signed, and shrunk under PAYLOAD_MAX by cutting the
 * excerpts (never the facts: exit codes, statuses, hashes, checks).
 */
export function buildEvidencePayload({ profile, testedCommit, contractHash, result, key }) {
  const base = {
    kind: profile === "cli" ? "transcript" : "api_response",
    profile,
    tested_commit: String(testedCommit).toLowerCase(),
    contract_hash: contractHash,
    passed: result.passed === true,
    reason: String(result.reason || "").slice(0, 1500),
    sandbox: String(result.sandbox || "").slice(0, 200),
    cases: (result.cases || []).slice(0, 50),
    ...(result.boot ? { boot: result.boot } : {}),
  };
  const shrink = (o, max) => {
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        const out = {};
        for (const [k, x] of Object.entries(v))
          out[k] =
            k === "excerpt" && typeof x === "string" && x.length > max
              ? x.slice(0, max) + "\n[... cut to fit]"
              : walk(x);
        return out;
      }
      return v;
    };
    return walk(o);
  };
  let p = base;
  for (const max of [EXCERPT_CHARS, 1500, 500, 120, 0]) {
    p = shrink(base, max);
    const digest = sha256(canonical(signedPart(p)));
    const signed = {
      ...p,
      digest,
      ...(key ? { signature: createHmac("sha256", key).update(digest).digest("hex") } : {}),
    };
    if (JSON.stringify(signed).length <= PAYLOAD_MAX) return signed;
    p = signed;
  }
  return p;
}

/** Verify a payload's digest and (with the key) its signature. → { digest, signature } booleans */
export function verifyEvidencePayload(payload, key) {
  const digest = sha256(canonical(signedPart(payload)));
  const digestOk = digest === payload.digest;
  let sigOk = false;
  if (key && typeof payload.signature === "string" && /^[0-9a-f]{64}$/.test(payload.signature)) {
    const want = createHmac("sha256", key).update(digest).digest();
    sigOk = timingSafeEqual(want, Buffer.from(payload.signature, "hex"));
  }
  return { digest: digestOk, signature: sigOk };
}

// ── CLI entry ────────────────────────────────────────────────────────────────
async function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--profile") opts.profile = argv[++i];
    else if (argv[i] === "--checkout") opts.checkout = argv[++i];
    else if (argv[i] === "--spec-file") opts.specFile = argv[++i];
  }
  let res;
  try {
    const spec = JSON.parse(readFileSync(opts.specFile, "utf8"));
    res = await runProfile({ profile: opts.profile, checkout: opts.checkout, spec });
  } catch (e) {
    res = {
      passed: false,
      reason: `the profile run failed: ${e?.message ?? e}`,
      sandbox: "none",
      cases: [],
    };
  }
  process.stdout.write(JSON.stringify(res) + "\n");
}

if (process.argv[2] === "run" && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(3)).then(
    () => process.exit(0),
    () => process.exit(1),
  );
}
