/**
 * THE TICK'S DISPATCH SERVER (src/cli/serveCore.ts). A tick sends its `wg` calls to one
 * long-lived process instead of starting node for each; every request must behave
 * exactly as the one-shot CLI does on the same database: the same exit code, the same
 * stdout and stderr bytes (refusals included), the same rows written. And anything it
 * cannot make identical is answered NOT-RUN, so the caller runs the one-shot CLI.
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildProgram } from "../src/cli/program.js";
import {
  DispatchServer,
  isStartupEnvName,
  leafCommandPath,
  namesInputFile,
  parseRequest,
  READS_STDIN_WITHOUT_FILE,
  replyLine,
  SERVED_COMMANDS,
  splitFields,
} from "../src/cli/serveCore.js";
import { closeOpenedHandles, open } from "../src/cli/shared.js";

import { CLI_BIN, CLI_BUILT } from "./helpers/cliBin.js";

const SERVE_BIN = resolve(__dirname, "..", "dist", "cli", "serve.js");

describe("serve: the request format", () => {
  it("splits NUL-terminated fields, keeping empty ones", () => {
    expect(splitFields(Buffer.from("a\0\0b\0"))).toEqual(["a", "", "b"]);
    expect(splitFields(Buffer.from("a\0b"))).toBeNull();
    expect(splitFields(Buffer.alloc(0))).toBeNull();
  });

  it("parses a request and refuses any malformed one", () => {
    const ok = ["GWG1", "12.3.4", "/tmp", "022", "1", "A", "x", "1", "B", "2", "--db", "/d"];
    expect(parseRequest(ok)).toEqual({
      nonce: "12.3.4",
      cwd: "/tmp",
      umask: 0o22,
      set: [["A", "x"]],
      unset: ["B"],
      args: ["--db", "/d"],
    });
    const bad = (f: string[]) => expect(parseRequest(f)).toBeNull();
    bad(["GWG2", ...ok.slice(1)]);
    bad(ok.map((v, i) => (i === 1 ? "../x" : v))); // nonce names files
    bad(ok.map((v, i) => (i === 2 ? "relative" : v)));
    bad(ok.map((v, i) => (i === 3 ? "999" : v)));
    bad(ok.map((v, i) => (i === 5 ? "A=B" : v))); // not an env name
    bad([...ok, "extra"]);
    bad(ok.slice(0, -1));
    bad(ok.map((v, i) => (i === 9 ? "3" : v)));
  });

  it("writes the reply line: segments in order, upper case when one holds a NUL", () => {
    expect(replyLine("1.2.3", { kind: "not-run", reason: "command" })).toBe("GWG1 1.2.3 N command");
    expect(replyLine("1.2.3", { kind: "ran", code: 0, segments: [] })).toBe("GWG1 1.2.3 R 0 -");
    expect(
      replyLine("1.2.3", {
        kind: "ran",
        code: 1,
        segments: [
          { fd: 2, data: Buffer.from("w") },
          { fd: 1, data: Buffer.from("a\0b") },
        ],
      }),
    ).toBe("GWG1 1.2.3 R 1 eO");
  });

  it("knows when a command names an input file other than stdin", () => {
    expect(namesInputFile(["ticket", "eval-score", "1", "--file", "/x.json"])).toBe(true);
    expect(namesInputFile(["--file=/x.json"])).toBe(true);
    expect(namesInputFile(["--file", "-"])).toBe(false);
    expect(namesInputFile(["--file="])).toBe(false);
    expect(namesInputFile(["--file"])).toBe(false);
    expect(namesInputFile(["ticket", "eval-score", "1"])).toBe(false);
  });

  it("names the start-up environment Node reads once", () => {
    for (const n of ["NODE_OPTIONS", "UV_THREADPOOL_SIZE", "LANG", "LC_ALL", "TZ", "LD_PRELOAD"]) {
      expect(isStartupEnvName(n)).toBe(true);
    }
    for (const n of ["GAFFER_PRINCIPAL_TOKEN", "DISPATCH_DB", "USER", "PATH"]) {
      expect(isStartupEnvName(n)).toBe(false);
    }
  });
});

describe("serve: which commands it runs", () => {
  const program = buildProgram();

  it("every served command is a real leaf command of the CLI", () => {
    for (const path of SERVED_COMMANDS) {
      const leaf = leafCommandPath(program, ["--db", "/x", ...path.split(" ")]);
      expect(leaf, path).toBe(path);
    }
  });

  it("resolves the leaf through root options, and refuses help, --version and odd argv", () => {
    expect(leafCommandPath(program, ["--db", "/d", "ticket", "show", "3"])).toBe("ticket show");
    expect(leafCommandPath(program, ["--db=/d", "--as-principal", "t", "stats"])).toBe("stats");
    expect(leafCommandPath(program, ["--db", "/d", "ticket", "show", "3", "--help"])).toBeNull();
    expect(leafCommandPath(program, ["--db", "/d", "-v"])).toBeNull();
    expect(leafCommandPath(program, ["--db", "/d", "help", "ticket"])).toBeNull();
    expect(leafCommandPath(program, ["--db", "/d", "ticket"])).toBeNull();
    expect(leafCommandPath(program, ["--db", "/d", "ticket", "--json", "show"])).toBeNull();
    expect(leafCommandPath(program, ["--db", "/d", "nosuch"])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Equivalence: the one-shot CLI and a served request on two copies of one database.
// ---------------------------------------------------------------------------------------

let dir: string;
let base: string;
let agentId = "";
let readToken = "";

function oneShot(
  db: string,
  args: readonly string[],
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI_BIN, "--db", db, ...args], {
    encoding: "utf8",
    env: { ...serverEnv(), ...env },
    cwd: dir,
    timeout: 60_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** The environment the server starts with (and each one-shot call gets, plus its extras). */
function serverEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "DISPATCH_DB" && k !== "GAFFER_PRINCIPAL_TOKEN") env[k] = v;
  }
  return env;
}

/** A served-mode client over `serve.js --stdio`. */
class StdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private wake: (() => void) | null = null;
  private n = 0;

  constructor() {
    this.child = spawn(process.execPath, [SERVE_BIN, "--stdio"], {
      env: serverEnv(),
      cwd: dir,
    });
    this.child.stdout.on("data", (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      this.wake?.();
    });
  }

  private async take(len: number): Promise<Buffer> {
    while (this.buf.length < len) await new Promise<void>((r) => (this.wake = r));
    const out = this.buf.subarray(0, len);
    this.buf = this.buf.subarray(len);
    return out;
  }

  private async line(): Promise<string> {
    for (;;) {
      const nl = this.buf.indexOf(10);
      if (nl >= 0) return (await this.take(nl + 1)).toString("utf8").slice(0, -1);
      await new Promise<void>((r) => (this.wake = r));
    }
  }

  async run(
    db: string,
    args: readonly string[],
    env: Record<string, string> = {},
  ): Promise<{ reply: string; code: number; stdout: string; stderr: string }> {
    this.n += 1;
    const nonce = `1.${this.n}.0`;
    const set = Object.entries(env).flat();
    const fields = [
      "GWG1",
      nonce,
      dir,
      "0022",
      String(set.length / 2),
      ...set,
      "0",
      String(args.length + 2),
      "--db",
      db,
      ...args,
    ];
    const body = Buffer.from(fields.map((f) => `${f}\0`).join(""));
    this.child.stdin.write(`${body.length}\n`);
    this.child.stdin.write(body);
    const reply = await this.line();
    const m = /^GWG1 \S+ R (\d+) (\S+)$/.exec(reply);
    if (!m) return { reply, code: -1, stdout: "", stderr: "" };
    let stdout = "";
    let stderr = "";
    if (m[2] !== "-") {
      for (const c of m[2]!) {
        const len = Number(await this.line());
        const data = (await this.take(len)).toString("utf8");
        if (c.toLowerCase() === "o") stdout += data;
        else stderr += data;
      }
    }
    return { reply, code: Number(m[1]), stdout, stderr };
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

/** Ids, tokens, hashes, timestamps and the copy's own file name differ by construction. */
function normalize(s: string, db: string): string {
  return s
    .split(db)
    .join("<db>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?Z?/g, "<ts>")
    .replace(/\b[0-9a-f]{32,128}\b/g, "<hex>")
    .replace(/"(claimToken|claim_token|token)": "[^"]*"/g, '"$1": "<token>"')
    .replace(/"(duration_ms|elapsedMs|ms)": \d+/g, '"$1": 0');
}

/** Every row of every table (minus volatile columns), for comparing two copies. */
function dumpRows(db: string): string {
  const conn = new Database(db, { readonly: true });
  try {
    const tables = conn
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    return tables
      .map(({ name }) => {
        const rows = conn.prepare(`SELECT * FROM "${name}"`).all();
        return `${name}: ${normalize(JSON.stringify(rows), db)}`;
      })
      .join("\n");
  } finally {
    conn.close();
  }
}

let copies = 0;
function copyPair(): { a: string; b: string } {
  copies += 1;
  // Same directory: the factory key and the event-log anchor are keyed by it.
  const a = join(dir, `a${copies}.sqlite`);
  const b = join(dir, `b${copies}.sqlite`);
  copyFileSync(base, a);
  copyFileSync(base, b);
  return { a, b };
}

const SKIP = !CLI_BUILT;

describe.skipIf(SKIP)("serve: a served call equals the one-shot call", () => {
  let client: StdioClient;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-serve-"));
    base = join(dir, "base.sqlite");
    const setup = (args: string[]): string => {
      const r = oneShot(base, args);
      if (r.code !== 0) throw new Error(`setup ${args.join(" ")}: ${r.stderr}`);
      return r.stdout;
    };
    spawnSync("git", ["init", "-q", dir]);
    setup(["init"]);
    setup(["repo", "add", "-n", "repo", "--path", dir, "--branch", "main", "--stack", "node"]);
    const t = (title: string): void => {
      setup([
        "ticket",
        "create",
        "-t",
        title,
        "-d",
        'a $HOME `id` "q"\ttab\nline',
        "--risk",
        "low",
      ]);
    };
    t("First 'quoted' $title");
    t("Second ticket");
    setup(["ac", "add", "1", "-t", "helper added"]);
    setup([
      "ticket",
      "repo-access",
      "set",
      "1",
      "repo",
      "--access",
      "write",
      "--relation",
      "confirmed",
    ]);
    setup(["ticket", "ready", "1"]);
    agentId = (
      JSON.parse(
        setup(["agent", "register", "-n", "f", "--max-risk", "high", "--as", "system"]),
      ) as {
        agent: { id: string };
      }
    ).agent.id;
    writeFileSync(join(dir, "in.json"), '{"verdict":"pass","score":0.9}');
    readToken = (
      JSON.parse(setup(["principal", "create", "reader", "--read"])) as { token: string }
    ).token;
    client = new StdioClient();
  });

  afterAll(() => {
    client?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const CASES: Array<{ name: string; args: () => string[]; env?: () => Record<string, string> }> = [
    { name: "ticket show", args: () => ["ticket", "show", "1"] },
    { name: "ticket show --json", args: () => ["ticket", "show", "1", "--json"] },
    { name: "unknown ticket", args: () => ["ticket", "show", "999"] },
    { name: "ticket list ready", args: () => ["ticket", "list", "-s", "ready"] },
    { name: "ticket list claimable", args: () => ["ticket", "list", "-s", "ready", "--claimable"] },
    { name: "decisions list", args: () => ["decisions", "list"] },
    { name: "autonomy policies", args: () => ["autonomy", "policies", "--mode", "auto"] },
    { name: "resume-requested", args: () => ["ticket", "resume-requested"] },
    { name: "paused-context", args: () => ["ticket", "paused-context", "1"] },
    { name: "repo-delivery list", args: () => ["ticket", "repo-delivery", "list", "1"] },
    {
      name: "agent register",
      args: () => ["agent", "register", "-n", "g", "--max-risk", "high", "--as", "system"],
    },
    { name: "claim-ticket", args: () => ["claim-ticket", "1", "--agent", agentId, "--ttl", "600"] },
    {
      name: "attach-evidence (hostile text)",
      args: () => [
        "attach-evidence",
        "1",
        "--type",
        "manual_note",
        "--summary",
        "PARKED: $HOME `id` \"q\" 'x'\ttab\nnext line",
      ],
    },
    { name: "refused transition", args: () => ["ticket", "move", "2", "done", "--as", "system"] },
    { name: "landing refused", args: () => ["ticket", "landing-begin", "1"] },
    { name: "unblock refused", args: () => ["unblock", "2"] },
    {
      name: "review approve refused",
      args: () => ["review", "approve", "1", "--as", "agent", "--agent", agentId],
    },
    {
      name: "pause refused",
      args: () => ["ticket", "pause", "1", "--reason", "timeout", "--attempt", "1"],
    },
    { name: "expire-claims", args: () => ["expire-claims"] },
    { name: "init on an existing db", args: () => ["init"] },
    {
      name: "a read-only principal's write (per-request token)",
      args: () => ["ticket", "move", "1", "refining"],
      env: () => ({ GAFFER_PRINCIPAL_TOKEN: readToken }),
    },
    {
      name: "a revoked/unknown principal token",
      args: () => ["ticket", "show", "1"],
      env: () => ({ GAFFER_PRINCIPAL_TOKEN: "gfp_nope" }),
    },
    {
      name: "a principal's read",
      args: () => ["ticket", "show", "1", "--as-principal", readToken],
    },
    { name: "missing argument (usage error)", args: () => ["ticket", "show"] },
    { name: "unknown option (usage error)", args: () => ["ticket", "show", "1", "--bogus"] },
    { name: "a bad --as value", args: () => ["agent", "register", "-n", "x", "--as", "agnet"] },
    {
      name: "the actor name from USER",
      args: () => ["ticket", "move", "2", "refining"],
      env: () => ({ USER: "someone-else" }),
    },
  ];

  for (const c of CASES) {
    it(c.name, async () => {
      const { a, b } = copyPair();
      const env = c.env?.() ?? {};
      const one = oneShot(a, c.args(), env);
      const served = await client.run(b, c.args(), env);
      expect(served.reply).toMatch(/^GWG1 \S+ R /);
      expect(served.code).toBe(one.code);
      expect(normalize(served.stdout, b)).toBe(normalize(one.stdout, a));
      expect(normalize(served.stderr, b)).toBe(normalize(one.stderr, a));
      expect(dumpRows(b)).toBe(dumpRows(a));
    });
  }

  it("answers NOT-RUN for a command it does not serve, help, --version and a changed start-up env", async () => {
    const { b } = copyPair();
    for (const args of [
      ["ticket", "create", "-t", "x"],
      ["epic", "create", "-"],
      ["ticket", "show", "1", "--help"],
      ["--version"],
      ["help", "ticket"],
    ]) {
      expect((await client.run(b, args)).reply, args.join(" ")).toMatch(/^GWG1 \S+ N command$/);
    }
    // A command that would read the caller's stdin (no --file, or --file -).
    for (const args of [
      ["ticket", "eval-score", "1"],
      ["ticket", "scout-record", "1", "--file", "-"],
    ]) {
      expect((await client.run(b, args)).reply, args.join(" ")).toMatch(/ N stdin$/);
    }
    expect((await client.run(b, ["ticket", "show", "1"], { NODE_OPTIONS: "--x" })).reply).toMatch(
      / N startup-env$/,
    );
    expect((await client.run(b, ["ticket", "show", "1"], { DISPATCH_DEBUG: "1" })).reply).toMatch(
      / N debug$/,
    );
    expect(
      (
        await client.run(b, ["ticket", "show", "1"], {
          GAFFER_NOTIFY_WEBHOOK_URL: "https://hooks.example.com/x",
        })
      ).reply,
    ).toMatch(/ N notify$/);
    // Nothing ran: the copy is exactly the base.
    expect(dumpRows(b)).toBe(dumpRows(base));
  });

  it("keeps serving after each of those (one process, many requests)", async () => {
    const { a, b } = copyPair();
    const one = oneShot(a, ["ticket", "show", "2"]);
    const served = await client.run(b, ["ticket", "show", "2"]);
    expect(normalize(served.stdout, b)).toBe(normalize(one.stdout, a));
  });

  // Every served command, with its positional arguments filled in ("1") and nothing
  // else: most are refusals or usage errors (a required option missing), which must be
  // the same bytes too. The table above covers the calls the tick makes with real args.
  const program = buildProgram();
  for (const path of SERVED_COMMANDS) {
    it(`every served command: ${path}`, async () => {
      let cmd = program;
      for (const t of path.split(" ")) cmd = cmd.commands.find((c) => c.name() === t)!;
      const positional = cmd.registeredArguments.filter((a) => a.required).map(() => "1");
      // A command that reads stdin without --file is answered NOT-RUN (tested above):
      // here it gets a file, as the tick always passes one.
      const file = READS_STDIN_WITHOUT_FILE.has(path) ? ["--file", join(dir, "in.json")] : [];
      const args = [...path.split(" "), ...positional, ...file];
      const { a, b } = copyPair();
      const one = oneShot(a, args);
      const served = await client.run(b, args);
      expect(served.reply, args.join(" ")).toMatch(/^GWG1 \S+ R /);
      expect(served.code).toBe(one.code);
      expect(normalize(served.stdout, b)).toBe(normalize(one.stdout, a));
      expect(normalize(served.stderr, b)).toBe(normalize(one.stderr, a));
      expect(dumpRows(b)).toBe(dumpRows(a));
    });
  }
});

// ---------------------------------------------------------------------------------------
// In-process: what the server puts back between requests.
// ---------------------------------------------------------------------------------------

describe.skipIf(SKIP)("serve: nothing carries over from one request to the next", () => {
  let d: string;
  let db: string;

  beforeAll(() => {
    d = mkdtempSync(join(tmpdir(), "wg-serve-inproc-"));
    db = join(d, "d.sqlite");
    const r = spawnSync(process.execPath, [CLI_BIN, "--db", db, "init"], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });
  afterAll(() => rmSync(d, { recursive: true, force: true }));

  const req = (args: string[], set: Array<[string, string]> = [], cwd = d) => ({
    nonce: "1.1.1",
    cwd,
    umask: 0o022,
    set,
    unset: [],
    args: ["--db", db, ...args],
  });

  it("restores the environment, the cwd, the umask and process.exitCode", async () => {
    const server = new DispatchServer();
    await server.preload();
    const cwd = process.cwd();
    const umask = process.umask();
    const reply = await server.handle(req(["ticket", "list"], [["GAFFER_SERVE_PROBE", "x"]], "/"));
    expect(reply.kind).toBe("ran");
    expect(process.env["GAFFER_SERVE_PROBE"]).toBeUndefined();
    expect(process.cwd()).toBe(cwd);
    expect(process.umask()).toBe(umask);
    expect(process.exitCode).toBeUndefined();
  });

  it("runs a relative --db against the request's cwd", async () => {
    const server = new DispatchServer();
    await server.preload();
    const reply = await server.handle({ ...req([]), args: ["--db", "d.sqlite", "ticket", "list"] });
    expect(reply).toMatchObject({ kind: "ran", code: 0 });
  });

  it("answers NOT-RUN when the cwd is gone, and runs nothing", async () => {
    const server = new DispatchServer();
    await server.preload();
    const reply = await server.handle(req(["ticket", "list"], [], join(d, "no-such-dir")));
    expect(reply).toEqual({ kind: "not-run", reason: "cwd" });
  });

  it("closes a handle a command left open", () => {
    const wg = open({ db });
    expect(wg.db.open).toBe(true);
    expect(closeOpenedHandles()).toBe(1);
    expect(wg.db.open).toBe(false);
    expect(closeOpenedHandles()).toBe(0);
  });

  it("captures stdout and stderr in write order", async () => {
    const server = new DispatchServer();
    await server.preload();
    const reply = await server.handle(req(["ticket", "show", "42"]));
    expect(reply.kind).toBe("ran");
    if (reply.kind !== "ran") return;
    expect(reply.code).toBe(1);
    expect(reply.segments.map((s) => s.fd)).toEqual([2]);
    expect(JSON.parse(reply.segments[0]!.data.toString()).code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------------------
// The FIFO transport the runner uses, end to end (the bash side is runner/config/17-cli.sh).
// ---------------------------------------------------------------------------------------

describe.skipIf(SKIP || process.platform === "win32")("serve: the FIFO transport", () => {
  it("answers a request, removes its files on D, and exits on Q", () => {
    const d = mkdtempSync(join(tmpdir(), "wg-serve-fifo-"));
    try {
      const db = join(d, "d.sqlite");
      spawnSync(process.execPath, [CLI_BIN, "--db", db, "init"]);
      const script = join(d, "drive.sh");
      writeFileSync(
        script,
        [
          "set -u",
          `D="${d}/s"; mkdir -m 700 "$D"; mkfifo "$D/req"`,
          `"${process.execPath}" "${SERVE_BIN}" --fifo "$D" --owner-pid $$ & P=$!`,
          'for i in $(seq 1 100); do [ -e "$D/ready" ] && break; sleep 0.1; done',
          '[ -e "$D/ready" ] && echo READY',
          `printf '%s\\0' GWG1 1.1.1 "${d}" 0022 0 0 4 --db "${db}" ticket list > "$D/q.1.1.1"`,
          'mkfifo "$D/r.1.1.1"; exec 7<>"$D/r.1.1.1"',
          "printf '1.1.1\\n' 1<>\"$D/req\"",
          'read -r -t 30 line <&7; echo "REPLY=$line"',
          'cat "$D/s.1.1.1.0"',
          "printf 'D 1.1.1\\n' 1<>\"$D/req\"; sleep 0.5",
          'ls "$D"',
          'printf \'Q\\n\' 1<>"$D/req"; wait $P; echo "EXIT=$?"',
          '[ -e "$D" ] && echo LEFT || echo GONE',
        ].join("\n"),
      );
      const r = spawnSync("bash", [script], { encoding: "utf8", timeout: 60_000 });
      expect(r.stdout).toMatch(/^READY$/m);
      expect(r.stdout).toMatch(/^REPLY=GWG1 1\.1\.1 R 0 o$/m);
      expect(r.stdout).toContain("[]");
      // After D only the request FIFO and `ready` are left; after Q the server removed its
      // dir and exited 0.
      expect(r.stdout).toMatch(/^req$/m);
      expect(r.stdout).not.toMatch(/^s\.1\.1\.1\.0$/m);
      expect(r.stdout).toMatch(/^EXIT=0$/m);
      expect(r.stdout).toMatch(/^GONE$/m);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("exits by itself when its owner process is gone", () => {
    const d = mkdtempSync(join(tmpdir(), "wg-serve-owner-"));
    try {
      const script = join(d, "drive.sh");
      writeFileSync(
        script,
        [
          `D="${d}/s"; mkdir -m 700 "$D"; mkfifo "$D/req"`,
          "sleep 30 & OWNER=$!",
          `"${process.execPath}" "${SERVE_BIN}" --fifo "$D" --owner-pid $OWNER & P=$!`,
          "sleep 1; kill -KILL $OWNER",
          "for i in $(seq 1 50); do kill -0 $P 2>/dev/null || break; sleep 0.1; done",
          "kill -0 $P 2>/dev/null && echo ALIVE || echo STOPPED",
        ].join("\n"),
      );
      const r = spawnSync("bash", [script], { encoding: "utf8", timeout: 60_000 });
      expect(r.stdout.trim()).toBe("STOPPED");
      expect(readFileSync(script, "utf8")).toContain("--owner-pid");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
