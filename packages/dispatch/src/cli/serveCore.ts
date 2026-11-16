import {
  closeSync,
  constants as fsConstants,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import type { Command } from "commander";

import { resetAuditPathCache } from "../audit/audit.js";
import { resetNotifyWarnings } from "../notify/config.js";
import { resetFactoryIsolationCache } from "../services/reviewGate/waiver.js";
import { blockStdin, setCliPrincipal } from "./helpers.js";
import { buildProgram, commandPath, runProgram } from "./program.js";
import { heavy, loadCliModules } from "./runtime.js";
import { internalErrorBody } from "./stdio.js";

// THE TICK'S DISPATCH SERVER (`node dist/cli/serve.js`). One runner tick used to start
// about 25 dispatch CLI processes, each paying ~250 ms of module loading before it did
// a few milliseconds of work. The tick now starts this process once and sends it the
// same argv the one-shot `wg` would have run (runner/config/17-cli.sh). Each request
// runs through THE SAME code path as `node dist/cli/index.js`: a fresh command tree
// from buildProgram(), runProgram() with the same argv, the same root hooks (principal
// resolution and capability checks), the same per-command database open and close,
// the same error boundary and exit codes. What a long-lived process would carry over
// from one command to the next is put back before each one: the environment, the cwd,
// the umask, process.exitCode, the acting principal and the per-process memos
// (resetPerProcessState). Anything that cannot be made identical is refused with a
// NOT-RUN reply, and the caller then runs the one-shot CLI (nothing was executed).
//
// Wire protocol (all of it written and read by bash builtins, so a call starts no
// process but one mkfifo):
//   <dir>/req          a FIFO; one line per message, each ending with " <key>", the
//                      tick key (serveFifo says why; a line without it is ignored):
//                        <nonce>      run the request in <dir>/q.<nonce>
//                        D <nonce>    the caller has read the reply: remove its files
//                        Q            stop
//   <dir>/q.<nonce>    the request, NUL-separated fields:
//                        GWG1, nonce, cwd, umask (octal), nSet, (name, value)*nSet,
//                        nUnset, name*nUnset, nArgs, arg*nArgs
//                      (the environment travels as the change from the one this
//                      process started with, which the caller snapshotted then)
//   <dir>/r.<nonce>    a FIFO the caller made and holds open; the server writes ONE line:
//                        GWG1 <nonce> R <exit code> <segments>   it ran
//                        GWG1 <nonce> N <reason>                 it did NOT run
//                      <segments> is "-" or one letter per output segment in write
//                      order: o (stdout) / e (stderr), upper case when the segment
//                      holds a NUL byte (bash cannot hold one in a variable).
//   <dir>/s.<nonce>.<i> the bytes of segment i.
// `--stdio` speaks the same records on stdin/stdout for tests: a request is the
// NUL-separated fields followed by an empty field; the reply is the line followed by
// each segment as "<length>\n<bytes>".

/** The leaf commands a tick runs (runner/tick.sh, runner/lib/*.sh). Anything else: NOT-RUN. */
export const SERVED_COMMANDS: ReadonlySet<string> = new Set([
  "ac check-result",
  "agent register",
  "attach-evidence",
  "autonomy policies",
  "claim-ticket",
  "decisions list",
  "delivery-artifact",
  "expire-claims",
  "heartbeat",
  "init",
  "judge-agreement",
  "repo add",
  "repo link",
  "repo set-commands",
  "review approve",
  "review reject",
  "runner-release",
  "runner-rework",
  "stats",
  "submit",
  "ticket allow-test-changes",
  "ticket auto-decision",
  "ticket ci-required",
  "ticket ci-result",
  "ticket ci-status",
  "ticket eval-score",
  "ticket hold",
  "ticket landing",
  "ticket landing-begin",
  "ticket lane-verdict",
  "ticket list",
  "ticket mark-merged",
  "ticket move",
  "ticket pause",
  "ticket paused-clear",
  "ticket paused-context",
  "ticket record-landing",
  "ticket record-tester-replay",
  "ticket reopen-for-review",
  "ticket repo-access inherit",
  "ticket repo-access set",
  "ticket repo-delivery list",
  "ticket repo-delivery record",
  "ticket resume-begin",
  "ticket resume-requested",
  "ticket scout-record",
  "ticket show",
  "ticket tester-route",
  "unblock",
]);

/** Served commands that read stdin when no `--file <path>` is given (or `--file -`). */
export const READS_STDIN_WITHOUT_FILE: ReadonlySet<string> = new Set([
  "ticket eval-score",
  "ticket scout-record",
]);

/** True when argv names an input file other than stdin: `--file <path>` / `--file=<path>`. */
export function namesInputFile(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--file") {
      const v = args[i + 1];
      return v !== undefined && v !== "-" && v !== "";
    }
    if (a.startsWith("--file=")) {
      const v = a.slice("--file=".length);
      return v !== "-" && v !== "";
    }
  }
  return false;
}

/**
 * Environment Node reads once at start-up (the module loader, the ICU locale, the
 * time zone, OpenSSL, the dynamic loader). A request that changes one of these from
 * the value this process started with cannot behave as a fresh process would: NOT-RUN.
 */
export function isStartupEnvName(name: string): boolean {
  return (
    /^(NODE_|UV_|LC_|OPENSSL_|SSL_CERT_|LD_|DYLD_|MALLOC_)/.test(name) ||
    name === "LANG" ||
    name === "LANGUAGE" ||
    name === "TZ"
  );
}

export interface ServeRequest {
  nonce: string;
  cwd: string;
  umask: number;
  set: ReadonlyArray<readonly [string, string]>;
  unset: readonly string[];
  args: readonly string[];
}

export type Segment = { fd: 1 | 2; data: Buffer };

export type ServeReply =
  { kind: "ran"; code: number; segments: Segment[] } | { kind: "not-run"; reason: string };

const NONCE_RE = /^[0-9]{1,10}\.[0-9]{1,10}\.[0-9]{1,10}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse a request's NUL-separated fields. Null: malformed. */
export function parseRequest(fields: readonly string[]): ServeRequest | null {
  let i = 0;
  const next = (): string | undefined => fields[i++];
  const count = (): number | null => {
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
  const set: Array<readonly [string, string]> = [];
  for (let k = 0; k < nSet; k++) {
    const name = next();
    const value = next();
    if (name === undefined || value === undefined || !ENV_NAME_RE.test(name)) return null;
    set.push([name, value]);
  }
  const nUnset = count();
  if (nUnset === null) return null;
  const unset: string[] = [];
  for (let k = 0; k < nUnset; k++) {
    const name = next();
    if (name === undefined || !ENV_NAME_RE.test(name)) return null;
    unset.push(name);
  }
  const nArgs = count();
  if (nArgs === null) return null;
  const args: string[] = [];
  for (let k = 0; k < nArgs; k++) {
    const a = next();
    if (a === undefined) return null;
    args.push(a);
  }
  if (i !== fields.length) return null;
  return { nonce, cwd, umask: parseInt(um, 8), set, unset, args };
}

/** Split a request buffer on NUL; null when it does not end with one. */
export function splitFields(buf: Buffer): string[] | null {
  if (buf.length === 0 || buf[buf.length - 1] !== 0) return null;
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      out.push(buf.subarray(start, i).toString("utf8"));
      start = i + 1;
    }
  }
  return out;
}

function findSub(cmd: Command, token: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === token || c.aliases().includes(token));
}

/**
 * The leaf command `args` would run, by the same tree buildProgram() builds, or null
 * when the argv is anything but a plain command (root options other than --db and
 * --as-principal, --version, help in any spelling, an unknown command, an option
 * before the leaf).
 */
export function leafCommandPath(program: Command, args: readonly string[]): string | null {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    const a = args[i]!;
    if (a === "--db" || a === "--as-principal") i += 2;
    else if (a.startsWith("--db=") || a.startsWith("--as-principal=")) i += 1;
    else return null;
  }
  if (args.slice(i).some((a) => a === "--help" || a === "-h")) return null;
  // Commander's own walk: a token naming a subcommand dispatches to it; otherwise a
  // command with an action of its own runs it (`stats` has `stats routing` below it).
  let cur = program;
  for (;;) {
    const token = args[i];
    const sub = token !== undefined && !token.startsWith("-") ? findSub(cur, token) : undefined;
    if (sub) {
      cur = sub;
      i += 1;
      continue;
    }
    if (cur === program) return null;
    if (cur.commands.length === 0 || hasAction(cur)) return commandPath(cur);
    return null;
  }
}

/** Whether a command runs an action of its own (commander keeps no public accessor). */
function hasAction(cmd: Command): boolean {
  return typeof (cmd as unknown as { _actionHandler?: unknown })._actionHandler === "function";
}

/** Put back what one command could leave behind in this process for the next one. */
function resetPerProcessState(): void {
  setCliPrincipal(null);
  resetNotifyWarnings();
  resetAuditPathCache();
  resetFactoryIsolationCache();
  process.exitCode = undefined;
}

/** Make process.env exactly `env` (in place: child processes and every reader use it). */
function replaceEnv(env: Readonly<Record<string, string>>): void {
  for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (process.env[k] !== v) process.env[k] = v;
}

type WriteFn = typeof process.stdout.write;

export interface ServeOptions {
  /** The argv[1] a one-shot call has: dist/cli/index.js. */
  cliScript?: string;
}

/** The server state: the environment it started with and the one-shot entry path. */
export class DispatchServer {
  private readonly startEnv: Readonly<Record<string, string>>;
  private readonly startCwd: string;
  private readonly startUmask: number;
  private readonly cliScript: string;

  constructor(opts: ServeOptions = {}) {
    this.startEnv = Object.freeze(
      Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      ),
    );
    this.startCwd = process.cwd();
    this.startUmask = process.umask();
    this.cliScript = opts.cliScript ?? fileURLToPath(new URL("./index.js", import.meta.url));
  }

  /** Load what every command needs, once (a request would load it on first use anyway). */
  async preload(): Promise<void> {
    await loadCliModules();
  }

  /** The environment a request asks for: the start environment with its changes applied. */
  effectiveEnv(req: ServeRequest): Record<string, string> {
    const env: Record<string, string> = { ...this.startEnv };
    for (const name of req.unset) delete env[name];
    for (const [name, value] of req.set) env[name] = value;
    return env;
  }

  /** Why a request cannot run here as it would in a fresh process, or null when it can. */
  refusal(
    program: Command,
    req: ServeRequest,
    env: Readonly<Record<string, string>>,
  ): string | null {
    const leaf = leafCommandPath(program, req.args);
    if (leaf === null || !SERVED_COMMANDS.has(leaf)) return "command";
    // These read their JSON from stdin unless --file names a file; the caller's stdin
    // does not reach this process (the tick always passes --file).
    if (READS_STDIN_WITHOUT_FILE.has(leaf) && !namesInputFile(req.args)) return "stdin";
    const names = new Set([...Object.keys(this.startEnv), ...Object.keys(env)]);
    for (const name of names) {
      if (isStartupEnvName(name) && this.startEnv[name] !== env[name]) return "startup-env";
    }
    // DISPATCH_DEBUG prints stacks, whose frames would name this module.
    if (env["DISPATCH_DEBUG"] === "1") return "debug";
    // A notifier delivers after the command returns (a webhook POST, a desktop
    // notification), and a one-shot process waits for it before it exits.
    if (heavy().buildNotifierFromEnv(env, () => undefined).enabled) return "notify";
    return null;
  }

  /**
   * Run one request the way `node dist/cli/index.js <args>` would. A "not-run" reply
   * is returned only before the command started; once it has, the reply is "ran"
   * (or this throws, and the caller must not run it again).
   */
  async handle(req: ServeRequest): Promise<ServeReply> {
    const env = this.effectiveEnv(req);
    try {
      replaceEnv(env);
      try {
        process.chdir(req.cwd);
      } catch {
        return { kind: "not-run", reason: "cwd" };
      }
      // The same tree a one-shot call builds (its name comes from DISPATCH_CLI_NAME).
      const program = buildProgram();
      const why = this.refusal(program, req, env);
      if (why !== null) return { kind: "not-run", reason: why };
      process.umask(req.umask);
      resetPerProcessState();
      return { kind: "ran", ...(await this.run(program, req.args)) };
    } finally {
      this.restore();
    }
  }

  private async run(
    program: Command,
    args: readonly string[],
  ): Promise<{ code: number; segments: Segment[] }> {
    const segments: Segment[] = [];
    const capture = (fd: 1 | 2): WriteFn =>
      ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
        const data =
          typeof chunk === "string"
            ? Buffer.from(
                chunk,
                typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8",
              )
            : Buffer.from(chunk as Uint8Array);
        const last = segments[segments.length - 1];
        if (last && last.fd === fd) last.data = Buffer.concat([last.data, data]);
        else if (data.length > 0) segments.push({ fd, data });
        const done = typeof encoding === "function" ? encoding : cb;
        if (typeof done === "function") queueMicrotask(() => (done as () => void)());
        return true;
      }) as WriteFn;
    const realOut = process.stdout.write;
    const realErr = process.stderr.write;
    process.stdout.write = capture(1);
    process.stderr.write = capture(2);
    blockStdin(true);
    let code: number;
    try {
      code = await runProgram(program, [process.execPath, this.cliScript, ...args]);
    } catch (err) {
      // runProgram has its own boundary; this is the entry's last resort (index.ts).
      process.stderr.write(`${JSON.stringify(internalErrorBody(err))}\n`);
      code = 1;
    } finally {
      // Writes a command queued for the next turn of the loop still belong to it.
      await new Promise<void>((r) => setImmediate(r));
      process.stdout.write = realOut;
      process.stderr.write = realErr;
      blockStdin(false);
      // A handle a command left open (one-shot: closed by the exit) would hold its
      // connection, and any transaction on it, into the next command.
      heavy().closeOpenedHandles();
    }
    return { code, segments };
  }

  private restore(): void {
    resetPerProcessState();
    replaceEnv(this.startEnv);
    process.umask(this.startUmask);
    try {
      process.chdir(this.startCwd);
    } catch {
      process.chdir("/");
    }
  }
}

/** The reply line (without the newline). */
export function replyLine(nonce: string, reply: ServeReply): string {
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

/** The reply to a request that could not be read: it did not run. */
function malformed(nonce: string): string {
  return `GWG1 ${nonce} N malformed`;
}

/** The reply when something failed after the command may have started: never run it again. */
function failed(nonce: string): string {
  return `GWG1 ${nonce} F`;
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Answer one `<nonce>` line: read and remove q.<nonce>, run it, write the segment
 * files, and return the reply line and how many segment files it wrote.
 */
async function answer(
  server: DispatchServer,
  dir: string,
  nonce: string,
): Promise<{ line: string; segments: number }> {
  const qPath = join(dir, `q.${nonce}`);
  let req: ServeRequest | null;
  try {
    const fields = splitFields(readFileSync(qPath));
    req = fields ? parseRequest(fields) : null;
  } catch {
    req = null;
  } finally {
    removeQuietly(qPath);
  }
  if (!req || req.nonce !== nonce) return { line: malformed(nonce), segments: 0 };
  let reply: ServeReply;
  try {
    reply = await server.handle(req);
  } catch {
    return { line: failed(nonce), segments: 0 };
  }
  if (reply.kind === "not-run") return { line: replyLine(nonce, reply), segments: 0 };
  try {
    reply.segments.forEach((s, n) => {
      writeFileSync(join(dir, `s.${nonce}.${n}`), s.data, { mode: 0o600 });
    });
  } catch {
    return { line: failed(nonce), segments: reply.segments.length };
  }
  return { line: replyLine(nonce, reply), segments: reply.segments.length };
}

/** A tick key: at least 128 bits as lower-case hex (runner/lib/helper-servers.sh makes it). */
const KEY_RE = /^[0-9a-f]{32,128}$/;

/**
 * The tick key on fd 0: the tick writes one line into a pipe and closes it. Null when
 * there is none (stdin a terminal, /dev/null, a file, anything but one key line).
 */
export function readTickKey(): string | null {
  let text: string;
  try {
    text = readFileSync(0, "latin1");
  } catch {
    return null;
  }
  const key = text.endsWith("\n") ? text.slice(0, -1) : text;
  return KEY_RE.test(key) ? key : null;
}

/**
 * Split a request-FIFO line into its message and the tick key it carries (the last
 * space-separated word) and check the key in constant time. Null: not from the tick.
 */
export function authenticLine(line: string, key: string): string | null {
  const sp = line.lastIndexOf(" ");
  if (sp < 1) return null;
  const given = Buffer.from(line.slice(sp + 1), "latin1");
  const want = Buffer.from(key, "latin1");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return line.slice(0, sp);
}

/**
 * Serve the FIFO protocol in `dir` until `Q`, or until the owner process is gone.
 *
 * WHO MAY ASK. The directory is 0700, which stops no process of the same user, and an
 * agent runs as the tick's user. So every line on the request FIFO must end with the
 * tick key: 128 random bits the tick made, holds only in its shell's memory (never
 * exported, never in an argv, never in a file) and handed to this process through a
 * pipe on fd 0 (`key`). A line without it is ignored: an agent that finds the FIFO
 * cannot have a command run, and this process runs nothing without a key.
 */
export async function serveFifo(dir: string, ownerPid: number, key: string): Promise<void> {
  if (!KEY_RE.test(key)) throw new Error("serveFifo: no tick key");
  const server = new DispatchServer();
  // The tick stops this process itself (Q). A signal to the tick's process group (the
  // pool's TERM, a Ctrl-C) must not kill a command half-way while the tick's cleanup
  // still needs this process; the tick's own death is noticed below, and a KILL (the
  // reaper's last resort) still stops it.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGPIPE"] as const) {
    process.on(sig, () => undefined);
  }
  // Hold the request FIFO first: a line written while no process has it open is lost
  // when its writer closes it. `ready` tells the caller it may send from now on (a line
  // sent during the preload below waits in the FIFO).
  const fd = openSync(join(dir, "req"), fsConstants.O_RDWR | fsConstants.O_NONBLOCK);
  writeFileSync(join(dir, "ready"), "", { mode: 0o600 });
  await server.preload();
  const input = new Socket({ fd, readable: true, writable: false });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    clearInterval(watch);
    lines.close();
    input.destroy();
    // The directory is the tick's private one; nothing else lives in it.
    rmSync(dir, { recursive: true, force: true });
  };
  const watch = setInterval(() => {
    if (!isAlive(ownerPid) || !existsSync(dir)) stop();
  }, 1000);
  const written = new Map<string, number>();
  for await (const raw of lines) {
    if (stopping) break;
    const line = authenticLine(raw, key);
    if (line === null) continue;
    if (line === "Q") break;
    if (line.startsWith("D ")) {
      const nonce = line.slice(2);
      if (!NONCE_RE.test(nonce)) continue;
      const n = written.get(nonce) ?? 0;
      written.delete(nonce);
      for (let i = 0; i < n; i++) removeQuietly(join(dir, `s.${nonce}.${i}`));
      continue;
    }
    if (!NONCE_RE.test(line)) continue;
    const nonce = line;
    const { line: text, segments } = await answer(server, dir, nonce);
    if (segments > 0) written.set(nonce, segments);
    // The caller holds its reply FIFO open for reading; when it is gone (killed, timed
    // out) the open fails with ENXIO and the reply is dropped.
    const rPath = join(dir, `r.${nonce}`);
    try {
      const out = openSync(rPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
      try {
        writeSync(out, `${text}\n`);
      } finally {
        closeSync(out);
      }
    } catch {
      // nobody is waiting
    }
    removeQuietly(rPath);
  }
  stop();
}

/**
 * The same requests on stdin/stdout, for tests: a request is `<length>\n` and that many
 * bytes of NUL-separated fields; the reply is the reply line, then each segment as
 * `<length>\n` and its bytes.
 */
export async function serveStdio(): Promise<void> {
  const server = new DispatchServer();
  await server.preload();
  const out = process.stdout.write.bind(process.stdout);
  let pending = Buffer.alloc(0);
  const send = (buf: Buffer): Promise<void> =>
    new Promise<void>((r) => {
      out(buf, () => r());
    });
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    for (;;) {
      const nl = pending.indexOf(10);
      if (nl < 0) break;
      const len = Number(pending.subarray(0, nl).toString("latin1"));
      if (!Number.isInteger(len) || len < 0) {
        await send(Buffer.from(`${malformed("0.0.0")}\n`));
        return;
      }
      if (pending.length < nl + 1 + len) break;
      const record = pending.subarray(nl + 1, nl + 1 + len);
      pending = pending.subarray(nl + 1 + len);
      const fields = splitFields(record);
      const req = fields ? parseRequest(fields) : null;
      if (!req) {
        await send(Buffer.from(`${malformed("0.0.0")}\n`));
        continue;
      }
      let reply: ServeReply;
      try {
        reply = await server.handle(req);
      } catch {
        await send(Buffer.from(`${failed(req.nonce)}\n`));
        continue;
      }
      const parts: Buffer[] = [Buffer.from(`${replyLine(req.nonce, reply)}\n`)];
      if (reply.kind === "ran") {
        for (const s of reply.segments) parts.push(Buffer.from(`${s.data.length}\n`), s.data);
      }
      await send(Buffer.concat(parts));
    }
  }
}

/** `serve.js --fifo <dir> --owner-pid <pid>` or `serve.js --stdio`. Returns the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--stdio") {
    await serveStdio();
    return 0;
  }
  if (argv.length === 4 && argv[0] === "--fifo" && argv[2] === "--owner-pid") {
    const pid = Number(argv[3]);
    if (!Number.isInteger(pid) || pid <= 1) return 2;
    // No key on fd 0: never serve (the tick then runs every call one-shot).
    const key = readTickKey();
    if (key === null) {
      process.stderr.write("serve.js: no tick key on stdin; refusing to serve\n");
      return 2;
    }
    await serveFifo(argv[1]!, pid, key);
    return 0;
  }
  process.stderr.write("usage: serve.js --fifo <dir> --owner-pid <pid> (key on stdin) | --stdio\n");
  return 2;
}
