import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

import { runCli } from "./helpers/cli.js";

/**
 * Exploratory finding cli-wg/F-08: a ticket title (or criterion text) carrying a
 * newline, tab, NUL or \x01 was stored verbatim, so `factory.log`, `gaffer status`
 * and the dossier heading got forged/split lines. Titles and criterion text now
 * refuse control characters with the same rule club set / agent rename use, on the
 * CLI and over REST; emoji and other unicode stay allowed. Descriptions and check
 * commands stay multiline (they are not one-line fields).
 */
const human: Actor = { type: "human", id: "tom" };
const BAD = ["line1\nline2", "tab\there", "nul\u0000x", "ctrl\u0001x", "del\u007fx"];

describe("cli-wg F-08: control characters in titles and criterion text", () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-ctrl-"));
    db = join(dir, "d.sqlite");
    Dispatch.open(db).db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ticket create refuses a title with a control character and creates nothing", () => {
    for (const title of BAD) {
      const r = runCli(db, ["ticket", "create", "-t", title]);
      expect(r.error, JSON.stringify(title)).toBeDefined();
      expect(r.json).toBeNull();
    }
    const wg = Dispatch.open(db);
    expect(wg.list()).toHaveLength(0);
    wg.db.close();
  });

  it("keeps emoji, unicode and a multiline description", () => {
    const r = runCli(db, ["ticket", "create", "-t", "Ship 🚀 café façade", "-d", "line1\nline2"]);
    expect(r.error).toBeUndefined();
    const wg = Dispatch.open(db);
    const t = wg.list()[0]!;
    expect(t.title).toBe("Ship 🚀 café façade");
    expect(t.description).toBe("line1\nline2");
    wg.db.close();
  });

  it("ac add refuses criterion text with a control character; a check command may be multiline", () => {
    runCli(db, ["ticket", "create", "-t", "t"]);
    for (const text of BAD) {
      const r = runCli(db, ["ac", "add", "1", "-t", text]);
      expect(r.error, JSON.stringify(text)).toBeDefined();
    }
    const ok = runCli(db, [
      "ac",
      "add",
      "1",
      "-t",
      "suite ✓ passes",
      "--check",
      "npm test\nnpm run lint",
    ]);
    expect(ok.error).toBeUndefined();
    const wg = Dispatch.open(db);
    expect(wg.view("1").acceptanceCriteria.map((a) => a.text)).toEqual(["suite ✓ passes"]);
    wg.db.close();
  });
});

describe("cli-wg F-08: REST POST /tickets and POST …/acceptance-criteria", () => {
  let close: (() => Promise<void>) | undefined;
  const saved = process.env.DISPATCH_API_TOKEN;
  afterEach(async () => {
    await close?.();
    close = undefined;
    if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = saved;
  });

  it("422s a control character in a title or criterion text", async () => {
    process.env.DISPATCH_API_TOKEN = "ctrl-chars-test-token-0123456789abcdef";
    const wg = Dispatch.open(":memory:");
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${process.env.DISPATCH_API_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return res.status;
    };
    for (const title of BAD)
      expect(await post("/tickets", { title }), JSON.stringify(title)).toBe(422);
    expect(await post("/tickets", { title: "emoji 🚀 ok" })).toBe(201);
    const t = wg.createTicket({ title: "x" }, human);
    for (const text of BAD) {
      expect(
        await post(`/tickets/${t.id}/acceptance-criteria`, { text }),
        JSON.stringify(text),
      ).toBe(422);
    }
    expect(wg.list().filter((x) => x.title !== "x" && x.title !== "emoji 🚀 ok")).toHaveLength(0);
    wg.db.close();
  });
});
