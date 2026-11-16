// P-B1 (the part A review of the fourteen settings): a run the dashboard starts (Poll
// for work, the merge runner, any runner it spawns with its own environment) must get
// exactly what a run started from the command line gets from the same settings.json.
// Before, applySettingsToEnv copied every settings.json key into the dashboard's own
// environment and the launcher dropped the operator record, so an old AUTO_MERGE=1 (or
// GAFFER_TICK_TIMEOUT=99999, MAX_TICKS_PER_DAY=0) reached every dashboard-started run
// as if the operator had exported it, beating GAFFER_MODE; the dashboard's own approve
// floor and auto merge read it too.
//
// Compared mechanically: every record the runner's config prints (each of the fourteen
// with its value and origin, every derived value with its origin, every old key and the
// decision taken) from a command-line run and from a dashboard-started run, for a file
// full of permissive old keys; once for a dashboard started directly and once for one
// started by `gaffer dashboard` (the launcher's env scrub, runner/lib/dashboard.sh).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSchema, RUNNER_DIR } from "../src/api/runnerConfig.js";
import { applySettingsToEnv, resetDerivedSettings } from "../src/api/settings.js";
import { envFlagOn } from "../src/services/autonomyPolicyService.js";

/** The old keys: the dashboard's own readers need the runner's reading of each. */
const OLD_KEYS = new Set(loadSchema().oldKeys.map((o) => o.key));

const PERMISSIVE_OLD_FILE = {
  GAFFER_MODE: "supervised",
  GAFFER_EFFORT: "large",
  GAFFER_DAILY_BUDGET_USD: "5",
  AUTO_MERGE: "1",
  MERGE_ON_AGENT_REVIEW: "1",
  DISPATCH_ALLOW_AGENT_APPROVE: "1",
  GAFFER_AUTO_PUSH: "1",
  MEMORY_AUTO_APPROVE: "1",
  REVIEW_MODE: "agent",
  GAFFER_ALLOW_SELF_DELIVERY: "1",
  GAFFER_TICK_TIMEOUT: "99999",
  GAFFER_MAX_TURNS: "999",
  MAX_TICKS_PER_DAY: "0",
  GAFFER_MAX_DELIVERY_ATTEMPTS: "50",
  GAFFER_REWORK_BUDGET_USD: "1000",
  GAFFER_REQUIRE_CI: "0",
  HYGIENE_ENFORCE: "0",
  STRICT_MODE: "0",
  STRICT_ALLOW_NETWORK: "1",
  SANDBOX_PROVIDER: "none",
  CLARIFY_DRAFTS_WHEN_IDLE: "1",
  GAFFER_IDLE_MODE: "create_ready_tickets",
  GAFFER_PLAN_DEBATE: "1",
};

/** The records a run's config prints (lib/config-records.sh), sorted, and its exit code. */
function records(env: NodeJS.ProcessEnv): { out: string; status: number | null } {
  const r = spawnSync(
    "bash",
    [
      "--norc",
      "--noprofile",
      "-c",
      'source "$1/factory.config.sh" 2>/dev/null; source "$1/lib/config-records.sh"; gaffer_config_records',
      "_",
      RUNNER_DIR,
    ],
    { env, encoding: "utf8" },
  );
  return { out: r.stdout.split("\n").filter(Boolean).sort().join("\n"), status: r.status };
}

function record(out: string, kind: "S" | "D", name: string): string[] {
  const line = out.split("\n").find((l) => l.startsWith(`${kind}\t${name}\t`));
  return line ? line.split("\t").slice(2) : [];
}

describe("P-B1: a dashboard-started run gets what a command-line run gets", () => {
  let dir: string;
  let base: NodeJS.ProcessEnv;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-pb1-"));
    writeFileSync(join(dir, "settings.json"), JSON.stringify(PERMISSIVE_OLD_FILE));
    base = { PATH: process.env.PATH, HOME: dir, GAFFER_DATA: dir };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a dashboard started directly: every value and origin matches the command line", () => {
    const cli = records(base);
    expect(cli.status).toBe(0);
    const dash: NodeJS.ProcessEnv = { ...base };
    resetDerivedSettings(dash);
    applySettingsToEnv(dash, join(dir, "settings.json"));
    // A Poll / merge-runner child inherits the dashboard's env (minus its API token).
    const run = records(dash);
    expect(run.status).toBe(0);
    expect(run.out).toBe(cli.out);
    // The supervised mode decides; the old permissive keys do not.
    expect(record(run.out, "D", "AUTO_MERGE")).toEqual(["derived", "1", "0"]);
    expect(record(run.out, "D", "DISPATCH_ALLOW_AGENT_APPROVE")).toEqual(["derived", "1", "0"]);
    expect(record(run.out, "D", "GAFFER_TICK_TIMEOUT")[2]).not.toBe("99999");
    expect(record(run.out, "D", "MAX_TICKS_PER_DAY")[2]).not.toBe("0");
    // `gaffer config show` in that run says where each setting came from.
    expect(record(run.out, "S", "GAFFER_MODE")).toEqual(["settings.json", "supervised"]);
    expect(record(run.out, "S", "GAFFER_EFFORT")).toEqual(["settings.json", "large"]);
  });

  it("the dashboard's own readers answer from the mode, never from an old key", () => {
    const dash: NodeJS.ProcessEnv = { ...base };
    resetDerivedSettings(dash);
    applySettingsToEnv(dash, join(dir, "settings.json"));
    // The approve floor (services/reviewGate/approval.ts) and auto merge (routes/tickets.ts).
    expect(envFlagOn(dash["DISPATCH_ALLOW_AGENT_APPROVE"])).toBe(false);
    expect(envFlagOn(dash["AUTO_MERGE"])).toBe(false);
    expect(envFlagOn(dash["MERGE_ON_AGENT_REVIEW"])).toBe(false);
    expect(dash["REVIEW_MODE"]).toBe("human");
    // A spend or size value never takes the old, costlier figure.
    expect(dash["GAFFER_TICK_TIMEOUT"]).not.toBe("99999");
    expect(dash["MAX_TICKS_PER_DAY"]).not.toBe("0");
    // ...but an old STRICTER value is the runner's reading too (no lifetime budget means
    // no per-ticket cap, so the old 1000 is the stricter one, and both keep it).
    expect(dash["GAFFER_REWORK_BUDGET_USD"]).toBe("1000");
    // The settings themselves arrive, as the runner reads them.
    expect(dash["GAFFER_MODE"]).toBe("supervised");
    expect(dash["GAFFER_DAILY_BUDGET_USD"]).toBe("5");
  });

  it("a dashboard started by `gaffer dashboard`: the same, through the launcher's scrub", () => {
    const cli = records(base);
    // The server's environment as runner/gaffer launches it (factory.config.sh sourced,
    // then `env $(gaffer_dashboard_env_unset_flags) node ...`).
    const launched = spawnSync(
      "bash",
      [
        "--norc",
        "--noprofile",
        "-c",
        'source "$1/factory.config.sh" 2>/dev/null; source "$1/lib/dashboard.sh"; env $(gaffer_dashboard_env_unset_flags) "$2" -e "process.stdout.write(JSON.stringify(process.env))"',
        "_",
        RUNNER_DIR,
        process.execPath,
      ],
      { env: base, encoding: "utf8" },
    );
    expect(launched.status).toBe(0);
    const server = JSON.parse(launched.stdout) as NodeJS.ProcessEnv;
    // Nothing the config derived from settings.json reaches the server as environment.
    for (const k of ["AUTO_MERGE", "GAFFER_TICK_TIMEOUT", "GAFFER_MODE", "MAX_TICKS_PER_DAY"]) {
      expect(server[k], k).toBeUndefined();
    }
    expect(server["_GAFFER_OPERATOR_ENV"]).toBeDefined();
    resetDerivedSettings(server);
    applySettingsToEnv(server, join(dir, "settings.json"));
    const run = records(server);
    expect(run.status).toBe(0);
    expect(run.out).toBe(cli.out);
  });

  it("a value the operator really exported still wins, in both runs alike", () => {
    const op = { ...base, GAFFER_MAX_TURNS: "12" };
    const cli = records(op);
    const dash: NodeJS.ProcessEnv = { ...op };
    resetDerivedSettings(dash);
    applySettingsToEnv(dash, join(dir, "settings.json"));
    const run = records(dash);
    expect(run.out).toBe(cli.out);
    expect(record(run.out, "D", "GAFFER_MAX_TURNS")).toEqual(["environment", "1", "12"]);
  });

  it("a setting changed through the dashboard reaches the next run the same way", () => {
    const dash: NodeJS.ProcessEnv = { ...base };
    resetDerivedSettings(dash);
    applySettingsToEnv(dash, join(dir, "settings.json"));
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ ...PERMISSIVE_OLD_FILE, GAFFER_MODE: "autonomous", GAFFER_EFFORT: "small" }),
    );
    applySettingsToEnv(dash, join(dir, "settings.json"));
    expect(records(dash).out).toBe(records(base).out);
  });

  it("a helper the dashboard starts that is not a runner script gets what a runner's helper gets", () => {
    // Plan a build (runner/bin/decompose.mjs), the spec author and the worker seam they
    // share are node programs: they never re-source the config, they read what the
    // dashboard hands them. A command-line run exports the values the fourteen derive
    // (GAFFER_PLAN_MODEL for the planner's --model, the model tiers, the kill estimate),
    // so a helper the dashboard starts must find the same ones. Before, the launcher's
    // scrub unset every schema name and the dashboard put back only the old keys: the
    // planner ran with no --model whatever GAFFER_MODELS chose.
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ GAFFER_MODELS: "economy", GAFFER_EFFORT: "large", GAFFER_MODE: "strict" }),
    );
    const dumpEnv = `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.env))"`;
    const cliChild = spawnSync(
      "bash",
      [
        "--norc",
        "--noprofile",
        "-c",
        `source "$1/factory.config.sh" 2>/dev/null; ${dumpEnv}`,
        "_",
        RUNNER_DIR,
      ],
      { env: base, encoding: "utf8" },
    );
    const cliEnv = JSON.parse(cliChild.stdout) as NodeJS.ProcessEnv;
    const launched = spawnSync(
      "bash",
      [
        "--norc",
        "--noprofile",
        "-c",
        `source "$1/factory.config.sh" 2>/dev/null; source "$1/lib/dashboard.sh"; env $(gaffer_dashboard_env_unset_flags) GAFFER_DASHBOARD_URL=http://127.0.0.1:9911 ${dumpEnv}`,
        "_",
        RUNNER_DIR,
      ],
      { env: base, encoding: "utf8" },
    );
    const server = JSON.parse(launched.stdout) as NodeJS.ProcessEnv;
    resetDerivedSettings(server);
    applySettingsToEnv(server, join(dir, "settings.json"));
    const schema = JSON.parse(
      readFileSync(join(RUNNER_DIR, "config", "settings-schema.json"), "utf8"),
    ) as { settings: { name: string; derives: { name: string }[] }[] };
    const differ: string[] = [];
    for (const s of schema.settings)
      // The derived values (a setting at its default is left to each reader's default,
      // which is the setting's own).
      for (const n of s.derives.map((d) => d.name)) {
        if (n === "GAFFER_DATA" || n === "GAFFER_DASHBOARD_URL") continue;
        const want = cliEnv[n];
        if (want !== undefined && want !== "" && server[n] !== want)
          differ.push(`${n}: runner helper ${want}, dashboard helper ${server[n] ?? "(unset)"}`);
      }
    expect(differ).toEqual([]);
    expect(server["GAFFER_PLAN_MODEL"]).toBe("sonnet");
    // A value the config keeps to itself is not pushed: DRY_RUN's default is decided by
    // the launcher before it sources the config (Poll for work runs live when unset), and
    // a DRY_RUN=1 handed down turned every dashboard poll into a preview.
    expect(cliEnv["DRY_RUN"]).toBeUndefined();
    expect(server["DRY_RUN"]).toBeUndefined();
    // No derived value reaches a dashboard helper that a runner's helper would not see.
    const extra: string[] = [];
    for (const s of schema.settings)
      for (const n of s.derives.map((d) => d.name))
        if (cliEnv[n] === undefined && server[n] !== undefined && !OLD_KEYS.has(n)) extra.push(n);
    expect(extra).toEqual([]);
    // The address the launcher handed the server on purpose stays.
    expect(server["GAFFER_DASHBOARD_URL"]).toBe("http://127.0.0.1:9911");
    // ...and a run the dashboard starts still derives every value afresh (but the
    // dashboard address, which the launcher sets on purpose, as before).
    const noUrl = (o: string) =>
      o
        .split("\n")
        .filter((l) => !l.startsWith("D\tGAFFER_DASHBOARD_URL\t"))
        .join("\n");
    expect(noUrl(records(server).out)).toBe(noUrl(records(base).out));
  });
});
