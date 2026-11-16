#!/usr/bin/env node
// runner/lib/json-serve.mjs: the tick's JSON helper server.
//
// A tick calls lib/json-tool.mjs (`gaffer_json`, `jget`) about fifty times, and each call
// was a node process paying ~60 ms of start-up for a millisecond of work. tick.sh starts
// this process once (config/17-cli.sh gaffer_wg_serve_start) and `gaffer_json` sends it the
// argv, environment, cwd and stdin the one-shot call would have had. Each request
// EVALUATES json-tool.mjs AFRESH (a new module instance: the file is unchanged and runs
// top to bottom exactly as `node json-tool.mjs <args>` would) with process.argv, the
// environment, the cwd and fd 0 put in place, its stdout and stderr captured in write
// order and process.exit turned into the request's exit code.
//
// json-tool only reads and prints (its two git calls read), so anything this cannot make
// identical is answered NOT-RUN and the caller runs the one-shot call (from the stdin it
// captured): an exception (a one-shot prints node's crash report), a process.exit that a
// try/catch swallowed, a read of stdin the caller did not send, a changed start-up
// environment. The wire protocol is the dispatch server's (packages/dispatch/src/cli/
// serveCore.ts), plus <dir>/i.<nonce>: the call's stdin, removed on `D <nonce>`.
//
//   node json-serve.mjs --fifo <dir> --owner-pid <pid>
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const TOOL = fileURLToPath(new URL("./json-tool.mjs", import.meta.url));
const TOOL_URL = pathToFileURL(TOOL).href;
/** Each request keeps its module instance; past this many, calls run one-shot. */
const MAX_REQUESTS = 2000;
const NONCE_RE = /^[0-9]{1,10}\.[0-9]{1,10}\.[0-9]{1,10}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Environment Node reads once at start-up (the same list as the dispatch server's). */
export function isStartupEnvName(name) {
  return (
    /^(NODE_|UV_|LC_|OPENSSL_|SSL_CERT_|LD_|DYLD_|MALLOC_)/.test(name) ||
    name === "LANG" ||
    name === "LANGUAGE" ||
    name === "TZ"
  );
}

/** NUL-terminated fields of a request file; null when it does not end with a NUL. */
export function splitFields(buf) {
  if (buf.length === 0 || buf[buf.length - 1] !== 0) return null;
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      out.push(buf.subarray(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  return out;
}

/** GWG1, nonce, cwd, umask, nSet, (name, value)*, nUnset, name*, nArgs, arg*. Null: malformed. */
export function parseRequest(fields) {
  let i = 0;
  const next = () => fields[i++];
  const count = () => {
    const v = next();
    return v !== undefined && /^[0-9]{1,6}$/.test(v) ? Number(v) : null;
  };
  if (next() !== "GWG1") return null;
  const nonce = next();
  const cwd = next();
  const um = next();
  if (nonce === undefined || !NONCE_RE.test(nonce)) return null;
  if (cwd === undefined || !cwd.startsWith("/")) return null;
  if (um === undefined || !/^[0-7]{1,4}$/.test(um)) return null;
  const nSet = count();
  if (nSet === null) return null;
  const set = [];
  for (let k = 0; k < nSet; k++) {
    const name = next();
    const value = next();
    if (name === undefined || value === undefined || !ENV_NAME_RE.test(name)) return null;
    set.push([name, value]);
  }
  const nUnset = count();
  if (nUnset === null) return null;
  const unset = [];
  for (let k = 0; k < nUnset; k++) {
    const name = next();
    if (name === undefined || !ENV_NAME_RE.test(name)) return null;
    unset.push(name);
  }
  const nArgs = count();
  if (nArgs === null) return null;
  const args = [];
  for (let k = 0; k < nArgs; k++) {
    const a = next();
    if (a === undefined) return null;
    args.push(a);
  }
  if (i !== fields.length) return null;
  return { nonce, cwd, umask: parseInt(um, 8), set, unset, args };
}

class ExitSignal {
  constructor(code) {
    this.code = code;
  }
}

function replaceEnv(env) {
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (process.env[k] !== v) process.env[k] = v;
}

/** The server state and one request's run. */
export class JsonServer {
  constructor() {
    this.startEnv = Object.freeze(
      Object.fromEntries(Object.entries(process.env).filter((e) => e[1] !== undefined)),
    );
    this.startCwd = process.cwd();
    this.startArgv = process.argv;
    this.served = 0;
    // fd 0 of a request: its captured stdin, or null (it sent none). json-tool reads
    // stdin with readFileSync(0); its named import sees this through the builtin's
    // live binding (syncBuiltinESMExports).
    this.current = null;
    const orig = fs.readFileSync;
    const state = () => this.current;
    fs.readFileSync = function readFileSync(p, ...rest) {
      const cur = state();
      if (cur === null || p !== 0) return orig.call(this, p, ...rest);
      if (cur.stdin === null) {
        cur.stdinWanted = true;
        return orig.call(this, "/dev/null", ...rest);
      }
      const enc = typeof rest[0] === "string" ? rest[0] : rest[0]?.encoding;
      return enc ? cur.stdin.toString(enc) : Buffer.from(cur.stdin);
    };
    syncBuiltinESMExports();
  }

  /**
   * Run one request the way `node json-tool.mjs <args>` would: { kind: "ran", code,
   * segments } or { kind: "not-run", reason }.
   */
  async handle(req, stdin) {
    if (this.served >= MAX_REQUESTS) return { kind: "not-run", reason: "limit" };
    const env = { ...this.startEnv };
    for (const n of req.unset) delete env[n];
    for (const [n, v] of req.set) env[n] = v;
    for (const n of new Set([...Object.keys(this.startEnv), ...Object.keys(env)])) {
      if (isStartupEnvName(n) && this.startEnv[n] !== env[n]) {
        return { kind: "not-run", reason: "startup-env" };
      }
    }
    try {
      process.chdir(req.cwd);
    } catch {
      return { kind: "not-run", reason: "cwd" };
    }
    replaceEnv(env);
    const segments = [];
    const capture = (fd) => (chunk, encoding, cb) => {
      const data =
        typeof chunk === "string"
          ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
          : Buffer.from(chunk);
      const last = segments[segments.length - 1];
      if (last && last.fd === fd) last.data = Buffer.concat([last.data, data]);
      else if (data.length > 0) segments.push({ fd, data });
      const done = typeof encoding === "function" ? encoding : cb;
      if (typeof done === "function") queueMicrotask(done);
      return true;
    };
    const cur = { stdin, stdinWanted: false, exitCalled: false };
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    const realExit = process.exit;
    let result;
    this.served += 1;
    try {
      this.current = cur;
      process.argv = [process.execPath, TOOL, ...req.args];
      process.exit = (code) => {
        cur.exitCalled = true;
        throw new ExitSignal(code);
      };
      process.stdout.write = capture(1);
      process.stderr.write = capture(2);
      let code = 0;
      let crashed = false;
      try {
        await import(`${TOOL_URL}?request=${this.served}`);
        if (cur.exitCalled) crashed = true; // an exit some try/catch swallowed
      } catch (err) {
        if (err instanceof ExitSignal) code = Number(err.code ?? 0) || 0;
        else crashed = true;
      }
      if (crashed) result = { kind: "not-run", reason: "exception" };
      else if (cur.stdinWanted) result = { kind: "not-run", reason: "stdin" };
      else result = { kind: "ran", code, segments };
    } finally {
      this.current = null;
      process.stdout.write = realOut;
      process.stderr.write = realErr;
      process.exit = realExit;
      process.argv = this.startArgv;
      replaceEnv(this.startEnv);
      try {
        process.chdir(this.startCwd);
      } catch {
        process.chdir("/");
      }
    }
    return result;
  }
}

/** The reply line (without the newline). */
export function replyLine(nonce, reply) {
  if (reply.kind === "not-run") return `GWG1 ${nonce} N ${reply.reason}`;
  const segs =
    reply.segments.length === 0
      ? "-"
      : reply.segments
          .map((s) => {
            const c = s.fd === 1 ? "o" : "e";
            return s.data.includes(0) ? c.toUpperCase() : c;
          })
          .join("");
  return `GWG1 ${nonce} R ${reply.code} ${segs}`;
}

function removeQuietly(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    // already gone
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function answer(server, dir, nonce) {
  const qPath = path.join(dir, `q.${nonce}`);
  let req;
  try {
    const fields = splitFields(fs.readFileSync(qPath));
    req = fields ? parseRequest(fields) : null;
  } catch {
    req = null;
  } finally {
    removeQuietly(qPath);
  }
  if (!req || req.nonce !== nonce) return { line: `GWG1 ${nonce} N malformed`, segments: 0 };
  let stdin;
  try {
    stdin = fs.readFileSync(path.join(dir, `i.${nonce}`));
  } catch {
    stdin = null; // the call sent none
  }
  let reply;
  try {
    reply = await server.handle(req, stdin);
  } catch {
    // json-tool is pure: running it again one-shot is safe.
    return { line: `GWG1 ${nonce} N exception`, segments: 0 };
  }
  if (reply.kind === "not-run") return { line: replyLine(nonce, reply), segments: 0 };
  try {
    reply.segments.forEach((s, n) => {
      fs.writeFileSync(path.join(dir, `s.${nonce}.${n}`), s.data, { mode: 0o600 });
    });
  } catch {
    return { line: `GWG1 ${nonce} N io`, segments: reply.segments.length };
  }
  return { line: replyLine(nonce, reply), segments: reply.segments.length };
}

/** Serve the FIFO protocol in `dir` until `Q`, or until the owner process is gone. */
export async function serveFifo(dir, ownerPid) {
  const server = new JsonServer();
  // As the dispatch server: the tick stops it (Q); a group signal must not kill a call
  // the tick's cleanup is waiting on. The tick's death is noticed below.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"]) process.on(sig, () => undefined);
  // Hold the request FIFO before saying `ready`: a line written while no process has it
  // open is lost when its writer closes it.
  const fd = fs.openSync(path.join(dir, "req"), fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  fs.writeFileSync(path.join(dir, "ready"), "", { mode: 0o600 });
  const input = new net.Socket({ fd, readable: true, writable: false });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(watch);
    lines.close();
    input.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const watch = setInterval(() => {
    if (!isAlive(ownerPid) || !fs.existsSync(dir)) stop();
  }, 1000);
  const written = new Map();
  for await (const line of lines) {
    if (stopping || line === "Q") break;
    if (line.startsWith("D ")) {
      const nonce = line.slice(2);
      if (!NONCE_RE.test(nonce)) continue;
      const n = written.get(nonce) ?? 0;
      written.delete(nonce);
      for (let i = 0; i < n; i++) removeQuietly(path.join(dir, `s.${nonce}.${i}`));
      removeQuietly(path.join(dir, `i.${nonce}`));
      continue;
    }
    if (!NONCE_RE.test(line)) continue;
    const nonce = line;
    const { line: text, segments } = await answer(server, dir, nonce);
    if (segments > 0) written.set(nonce, segments);
    const rPath = path.join(dir, `r.${nonce}`);
    try {
      const out = fs.openSync(rPath, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      try {
        fs.writeSync(out, `${text}\n`);
      } finally {
        fs.closeSync(out);
      }
    } catch {
      // nobody is waiting
    }
    removeQuietly(rPath);
  }
  stop();
}

const isMain = (() => {
  try {
    return (
      fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
})();
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.length === 4 && argv[0] === "--fifo" && argv[2] === "--owner-pid") {
    const pid = Number(argv[3]);
    if (!Number.isInteger(pid) || pid <= 1) process.exit(2);
    await serveFifo(argv[1], pid);
    process.exit(0);
  }
  process.stderr.write("usage: json-serve.mjs --fifo <dir> --owner-pid <pid>\n");
  process.exit(2);
}
