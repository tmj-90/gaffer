/**
 * `crew doctor` stops warning on every gaffer factory, and crew can no longer
 * silently open (or create) a different Dispatch DB.
 *
 * Regressions:
 *   - doctor counted repos from crew.yaml only ("no repositories in crew.yaml")
 *     and required an active crew.yaml agent, neither of which the live factory
 *     uses — so every `gaffer status` showed a crew warning that never cleared;
 *   - Memory read "offline Null client" although the factory's real memory path
 *     is the MEMORY_CLI_BIN bridge;
 *   - crew opened crew.yaml's sqlite_path and Dispatch.open CREATED it when
 *     missing, so a drifted path forked idle drafts and onboard registrations
 *     onto a fresh DB nobody reads — and doctor called that "reachable".
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initFactory } from "../src/config/init.js";
import { configuredSqlitePath, resolveSqlitePath } from "../src/config/loader.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { RealDispatchClient } from "../src/dispatch/realClient.js";
import { runDoctor } from "../src/ops/doctor.js";
import { loadFactory, openDispatch } from "../src/runtime/wiring.js";

describe("crew doctor on a dashboard-onboarded factory", () => {
  let tmp: string;
  let ctx: ReturnType<typeof loadFactory>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gaffer-doctor-db-"));
    initFactory({ dir: tmp, factoryName: "doc", force: true }); // repos: [], agents: []
    ctx = loadFactory({ config: join(tmp, "crew.yaml") });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function dispatchWithRepo(): FakeDispatchClient {
    const repoDir = join(tmp, "app");
    mkdirSync(repoDir, { recursive: true });
    const wg = new FakeDispatchClient();
    wg.seedRepository({ id: "r1", name: "app", localPath: repoDir });
    return wg;
  }

  it("counts Dispatch's repos and prints no warning for repos or agents", async () => {
    const wg = dispatchWithRepo();
    const report = await runDoctor({ ctx, openDispatch: async () => wg, env: {} });
    const byLabel = new Map(report.checks.map((c) => [c.label, c]));
    expect(byLabel.has("Repos configured")).toBe(false);
    expect(byLabel.get("Repos resolve")?.level).toBe("ok");
    expect(byLabel.get("Repos resolve")?.detail).toContain("1 repo(s)");
    expect(byLabel.get("Active agents")?.level).toBe("ok");
    expect(byLabel.get("Active agents")?.detail).toContain("only needed for `crew run`");
    expect(report.checks.filter((c) => c.level !== "ok")).toEqual([]);
  });

  it("an empty factory's repo warning points at onboarding, not crew.yaml", async () => {
    const report = await runDoctor({
      ctx,
      openDispatch: async () => new FakeDispatchClient(),
      env: {},
    });
    const repos = report.checks.find((c) => c.label === "Repos configured");
    expect(repos?.level).toBe("warn");
    expect(repos?.fix).toContain("gaffer onboard");
  });

  it("reports the memory CLI bridge as the configured memory path", async () => {
    const report = await runDoctor({
      ctx,
      openDispatch: async () => dispatchWithRepo(),
      env: { MEMORY_CLI_BIN: "/x/memory.js", MEMORY_DB: "/x/memory.sqlite" },
    });
    const memory = report.checks.find((c) => c.label === "Memory");
    expect(memory?.detail).toBe("memory CLI bridge (MEMORY_CLI_BIN)");
  });

  it("FAILS on a missing DB and never creates it (the CLI opens with mustExist)", async () => {
    const dbPath = resolveSqlitePath(ctx.loaded, {});
    expect(existsSync(dbPath)).toBe(false);
    const report = await runDoctor({
      ctx,
      openDispatch: (c) => openDispatch(c, { mustExist: true }),
      env: {},
    });
    const check = report.checks.find((c) => c.label === "Dispatch reachable");
    expect(check?.level).toBe("fail");
    expect(check?.detail).toContain("not found");
    expect(report.ok).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("warns when crew.yaml's sqlite_path differs from the factory DB", async () => {
    const report = await runDoctor({
      ctx,
      openDispatch: async () => dispatchWithRepo(),
      env: { CREW_DISPATCH_DB: join(tmp, "elsewhere", "dispatch.sqlite") },
    });
    const drift = report.checks.find((c) => c.label === "crew.yaml points at the factory DB");
    expect(drift?.level).toBe("warn");
    expect(drift?.detail).toContain(join(tmp, "elsewhere", "dispatch.sqlite"));
  });
});

describe("Dispatch DB resolution", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gaffer-db-resolve-"));
    initFactory({ dir: tmp, factoryName: "db", force: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("CREW_DISPATCH_DB wins over crew.yaml's sqlite_path", () => {
    const ctx = loadFactory({ config: join(tmp, "crew.yaml") });
    const factoryDb = join(tmp, "data", "dispatch.sqlite");
    expect(resolveSqlitePath(ctx.loaded, { CREW_DISPATCH_DB: factoryDb })).toBe(factoryDb);
    expect(resolveSqlitePath(ctx.loaded, {})).toBe(configuredSqlitePath(ctx.loaded));
    expect(resolveSqlitePath(ctx.loaded, { CREW_DISPATCH_DB: "  " })).toBe(
      configuredSqlitePath(ctx.loaded),
    );
  });

  it("open with mustExist refuses a missing file and creates nothing", async () => {
    const missing = join(tmp, "nope", "dispatch.sqlite");
    await expect(RealDispatchClient.open(missing, { mustExist: true })).rejects.toMatchObject({
      code: "DISPATCH_UNAVAILABLE",
    });
    expect(existsSync(missing)).toBe(false);
  });

  it("open without mustExist still creates a fresh DB (crew run / setup paths)", async () => {
    const fresh = join(tmp, "fresh.sqlite");
    const client = await RealDispatchClient.open(fresh);
    expect(client.listReady()).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
  });
});
