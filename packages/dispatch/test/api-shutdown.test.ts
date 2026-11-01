/**
 * The dashboard server stops promptly on SIGTERM / SIGINT even with a live event
 * stream open, and removes its pid file on the way out (exploratory finding
 * api-robustness/F4). server.close() waits for every open connection, and an SSE
 * stream stays open for up to an hour, so a SIGTERM used to free the port and then
 * leave the process alive with the database open; `gaffer dashboard --restart` left
 * the old server behind, and the launcher's dashboard.pid was never removed.
 *
 * Drives the BUILT server (dist/api/bin.js), like the CLI tests drive dist/cli.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const BIN = resolve(__dirname, "..", "dist", "api", "bin.js");
const TOKEN = "shutdown-test-token-0123456789abcdef";
// The fix package's port range (exploratory fix brief: 9431-9440).
const PORT = Number(process.env["API_SHUTDOWN_TEST_PORT"] ?? 9431);

let child: ChildProcess | undefined;
let dir: string | undefined;

afterEach(() => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  child = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function startServer(data: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env["PATH"],
    HOME: data,
    GAFFER_DATA: data,
    DISPATCH_DB: join(data, "dispatch.db"),
    DISPATCH_API_TOKEN: TOKEN,
    DISPATCH_AUDIT_OFF: "1",
  };
  const c = spawn(process.execPath, [BIN, "--port", String(PORT)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((ok, fail) => {
    let out = "";
    const timer = setTimeout(() => fail(new Error(`server did not start: ${out}`)), 10_000);
    const onData = (b: Buffer) => {
      out += b.toString();
      if (out.includes("listening on")) {
        clearTimeout(timer);
        ok(c);
      }
    };
    c.stdout!.on("data", onData);
    c.stderr!.on("data", onData);
    c.on("exit", () => fail(new Error(`server exited early: ${out}`)));
  });
}

/** Open the event stream and resolve once its first frame arrived; `ended` settles when the server ends it. */
function openStream(): Promise<{ ended: Promise<string> }> {
  return new Promise((ok, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/api/events/stream",
        headers: { authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        expect(res.statusCode).toBe(200);
        let body = "";
        const ended = new Promise<string>((done) => {
          res.on("end", () => done(body));
          res.on("close", () => done(body));
        });
        res.once("data", () => ok({ ended }));
        res.on("data", (b: Buffer) => (body += b.toString()));
      },
    );
    req.on("error", fail);
    req.end();
  });
}

function exited(c: ChildProcess, ms: number): Promise<number | "timeout"> {
  return new Promise((done) => {
    if (c.exitCode !== null) return done(c.exitCode);
    const t = setTimeout(() => done("timeout"), ms);
    c.on("exit", (code) => {
      clearTimeout(t);
      done(code ?? -1);
    });
  });
}

describe("dispatch-api shutdown (exploratory finding api-robustness/F4)", () => {
  it("SIGTERM with an open event stream ends the stream, exits within 2 s and removes its own pid file", async () => {
    expect(existsSync(BIN), "build packages/dispatch first").toBe(true);
    dir = mkdtempSync(join(tmpdir(), "wg-api-shutdown-"));
    child = await startServer(dir);
    const pidFile = join(dir, "dashboard.pid");
    writeFileSync(pidFile, `${child.pid}\n`);
    const stream = await openStream();
    const t0 = Date.now();
    child.kill("SIGTERM");
    const code = await exited(child, 3000);
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2500);
    await expect(stream.ended).resolves.toMatch(/connected seq=/);
    expect(existsSync(pidFile)).toBe(false);
  }, 20_000);

  it("SIGINT leaves a pid file that names another process alone", async () => {
    dir = mkdtempSync(join(tmpdir(), "wg-api-shutdown-"));
    child = await startServer(dir);
    const pidFile = join(dir, "dashboard.pid");
    // A newer launch already recorded its own server: never delete that one's file.
    writeFileSync(pidFile, "999999\n");
    child.kill("SIGINT");
    expect(await exited(child, 3000)).toBe(0);
    expect(existsSync(pidFile)).toBe(true);
  }, 20_000);
});
