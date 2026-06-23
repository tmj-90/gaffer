import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createProductOwnerRunner,
  PRODUCT_OWNER_CMD_ENV,
  PRODUCT_OWNER_REPO_ENV,
} from "../src/api/productOwner.js";

/**
 * P2-A — DISPATCH_API_TOKEN must NOT leak into the product-owner agent child
 * env (the contract the merge/poll-work runners already keep), and the spawn must
 * be shell-free (argv array, no `shell: true`). We point the command at a tiny
 * `node` script that writes its env + argv to a file, then assert the token is
 * absent while the validated repo still rides through PRODUCT_OWNER_REPO_ENV.
 */

interface ChildSnapshot {
  token: string | null;
  repo: string | null;
  argv: string[];
}

async function runAndCapture(extraEnv: NodeJS.ProcessEnv, repo?: string): Promise<ChildSnapshot> {
  const dir = mkdtempSync(join(tmpdir(), "wg-po-"));
  const outFile = join(dir, "out.json");
  const scriptFile = join(dir, "fake-po.cjs");
  writeFileSync(
    scriptFile,
    "const fs=require('fs');" +
      "fs.writeFileSync(process.env.WG_PO_OUT,JSON.stringify({" +
      "token:process.env.DISPATCH_API_TOKEN??null," +
      "repo:process.env.DISPATCH_PRODUCT_OWNER_REPO??null," +
      "argv:process.argv.slice(2)}));",
  );

  const env: NodeJS.ProcessEnv = {
    ...extraEnv,
    WG_PO_OUT: outFile,
    [PRODUCT_OWNER_CMD_ENV]: `${process.execPath} ${scriptFile}`,
  };
  const runner = createProductOwnerRunner(env);
  const res = runner.run(repo !== undefined ? { repo } : {});
  expect(res.started).toBe(true);

  const deadline = Date.now() + 4000;
  let raw: string | null = null;
  while (Date.now() < deadline) {
    try {
      raw = readFileSync(outFile, "utf8");
      if (raw) break;
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(raw).not.toBeNull();
  return JSON.parse(raw!) as ChildSnapshot;
}

describe("P2-A: product-owner runner strips the bearer token from the child env", () => {
  it("does NOT pass DISPATCH_API_TOKEN to the spawned child", async () => {
    const snap = await runAndCapture({
      ...process.env,
      DISPATCH_API_TOKEN: "super-secret-bearer",
    });
    expect(snap.token).toBeNull();
  });

  it("still forwards the validated repo via PRODUCT_OWNER_REPO_ENV (no command-line interpolation)", async () => {
    const snap = await runAndCapture(
      { ...process.env, DISPATCH_API_TOKEN: "super-secret-bearer" },
      "dispatch",
    );
    expect(snap.token).toBeNull();
    expect(snap.repo).toBe("dispatch");
    // The repo is NOT appended to argv — it rides in the env only.
    expect(snap.argv).not.toContain("dispatch");
  });

  it("throws NOT_CONFIGURED when the command is unset/blank", () => {
    const runner = createProductOwnerRunner({});
    expect(() => runner.run({})).toThrowError(/NOT_CONFIGURED|product-owner/i);
  });
});

// Belt-and-braces: the env var constant the child reads is the documented one.
describe("P2-A: contract surface", () => {
  it("exposes the repo env var name used to pass the target repo", () => {
    expect(PRODUCT_OWNER_REPO_ENV).toBe("DISPATCH_PRODUCT_OWNER_REPO");
  });
});
