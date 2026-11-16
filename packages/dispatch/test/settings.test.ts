// The settings API carries the fourteen settings and nothing else. Their names, kinds,
// accepted values, defaults and descriptions come from runner/config/settings-schema.json,
// a value is validated exactly as the runner's _gaffer_setting_problem validates it, an
// old key is refused naming the setting that decides it now, the derived and migration
// blocks come from the runner's own config, and every secret is masked.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadSchema, RUNNER_DIR } from "../src/api/runnerConfig.js";
import {
  applyNotifyChange,
  applySettingsToEnv,
  cleanupPlan,
  ENV_ONLY_KEYS,
  isKnownSetting,
  keyProblem,
  PRESENTATION_KEYS,
  readSettingsFile,
  readSettingsFileRaw,
  removeOldKeys,
  resetDerivedSettings,
  resolveSettingsPath,
  SETTING_DEFS,
  settingProblems,
  settingsReport,
  settingValueProblem,
  writeSettings,
} from "../src/api/settings.js";

const SLACK = "https://hooks.slack.com/services/T0/B0/slack-secret-token";
const HOOK = "https://hooks.example.com/w/hook-secret-token";

let dir: string;
let settingsPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wg-settings-"));
  settingsPath = join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fresh operator environment (as a dashboard started with nothing exported). */
function op(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir, ...extra };
  resetDerivedSettings(env);
  return env;
}

describe("the fourteen, read from the runner's schema (drift fails here)", () => {
  it("the writable keys equal the fourteen settings (GAFFER_DATA shown, never written)", () => {
    const schema = loadSchema();
    expect(schema.settings.length).toBe(14);
    expect(SETTING_DEFS.map((d) => d.key)).toEqual(schema.settings.map((s) => s.name));
    expect([...PRESENTATION_KEYS].sort()).toEqual(schema.settings.map((s) => s.name).sort());
    const writable = SETTING_DEFS.filter((d) => d.writable).map((d) => d.key);
    expect(writable).toEqual(schema.settings.map((s) => s.name).filter((n) => n !== "GAFFER_DATA"));
    for (const s of schema.settings) {
      const d = SETTING_DEFS.find((x) => x.key === s.name)!;
      expect(d.kind).toBe(s.kind);
      expect(d.values).toEqual(s.values);
      expect(d.description).toBe(s.description);
      expect(d.default).toBe(s.default.startsWith("(") ? "" : s.default);
    }
  });

  it("the schema is the runner's spec: the same fourteen names as runner/config/01-settings.sh", () => {
    const out = execFileSync(
      "bash",
      [
        "-c",
        '_gs_out=""; source "$1/config/01-settings.sh"; echo $_GAFFER_SETTINGS_KEYS',
        "_",
        RUNNER_DIR,
      ],
      { env: { PATH: process.env.PATH }, encoding: "utf8" },
    );
    expect(out.trim().split(/\s+/)).toEqual(SETTING_DEFS.map((d) => d.key));
  });

  it("validation agrees with the runner's _gaffer_setting_problem, value for value and word for word", () => {
    // A corpus per kind, including every form the old page stored or a person might type.
    const corpus: Record<string, string[]> = {
      choice: [
        "supervised",
        "autonomous",
        "yolo",
        "Supervised",
        " lite",
        "small",
        "large",
        "pr",
        "local",
        "auto",
        "docker",
        "none",
        "all",
        "backlog",
      ],
      usd: ["5", "5.25", "5.", ".5", "0", "abc", "-1", "1e3", "$5", "5 ", "5,00"],
      count: ["1", "3", "64", "65", "0", "00", "99", "-1", "3.5", " 3", "abc"],
      models: [
        "standard",
        "economy",
        "strong",
        "opus,sonnet,haiku",
        "a,b",
        "-x,b,c",
        "opus, sonnet, haiku",
        "claude-opus-4@x,b:c,d/e",
      ],
      gates: ["standard", "strict", "tests,lint", "tests lint", "lint,foo", "none"],
      testing: ["auto", "on", "off", "1", "0", "true", "No", "maybe", "AUTO"],
      notify: [
        "desktop",
        `desktop,${SLACK}`,
        `${HOOK} ${SLACK}`,
        `${HOOK},${HOOK}`,
        `${SLACK},${SLACK}`,
        "ftp://x",
        "desk",
      ],
      port: ["8787", "1", "65535", "65536", "0", "80a"],
    };
    const cases: { key: string; value: string }[] = [];
    for (const d of SETTING_DEFS) {
      if (!d.writable) continue;
      for (const v of corpus[d.kind] ?? []) cases.push({ key: d.key, value: v });
    }
    const script = [
      '_gs_out=""; source "$1/config/01-settings.sh"',
      'while IFS=$(printf "\\t") read -r k v; do _gaffer_setting_problem "$k" "$v" settings.json; printf "%s\\n" "$_GAFFER_SP"; done',
    ].join("\n");
    const out = execFileSync("bash", ["-c", script, "_", RUNNER_DIR], {
      env: { PATH: process.env.PATH },
      input: cases.map((c) => `${c.key}\t${c.value}`).join("\n") + "\n",
      encoding: "utf8",
    }).split("\n");
    expect(cases.length).toBeGreaterThan(80);
    cases.forEach((c, i) => {
      const def = SETTING_DEFS.find((d) => d.key === c.key)!;
      const runner = out[i] ?? "";
      const mine = settingValueProblem(def, c.value, {}) ?? "";
      expect(mine, `${c.key}='${c.value}'`).toBe(runner);
    });
  });

  it("every old settings.json key is refused, naming the setting the schema says decides it", () => {
    for (const o of loadSchema().oldKeys) {
      const p = keyProblem(o.key);
      expect(p, o.key).not.toBeNull();
      expect(p!.decidedBy).toBe(o.setting);
      expect(p!.problem).toContain(`${o.setting} decides it now`);
    }
    expect(keyProblem("GAFFER_ALLOW_UNCAPPED")!.problem).toContain("only the environment");
    expect(keyProblem("NODE_OPTIONS")!.problem).toContain("is not a setting");
    expect(keyProblem("GAFFER_DATA")!.problem).toContain("only the environment can move it");
    expect(isKnownSetting("AUTO_MERGE")).toBe(false);
  });

  it("ENV_ONLY_KEYS is the runner's _GAFFER_ENV_ONLY_KEYS", () => {
    const part = readFileSync(resolve(RUNNER_DIR, "config/01-settings.sh"), "utf8");
    const m = /^_GAFFER_ENV_ONLY_KEYS="([^"]*)"/m.exec(part);
    expect(m).not.toBeNull();
    expect(m![1]!.split(/\s+/).filter(Boolean).sort()).toEqual([...ENV_ONLY_KEYS].sort());
  });
});

describe("writes", () => {
  it("trims and validates before storing; a cleared value removes the key", () => {
    const env = op();
    const r = writeSettings(
      { GAFFER_CONCURRENCY: " 3 ", GAFFER_EFFORT: "large" },
      env,
      settingsPath,
    );
    expect(r.written).toEqual(["GAFFER_CONCURRENCY", "GAFFER_EFFORT"]);
    expect(readSettingsFileRaw(settingsPath)).toEqual({
      GAFFER_CONCURRENCY: "3",
      GAFFER_EFFORT: "large",
    });
    writeSettings({ GAFFER_EFFORT: "" }, env, settingsPath);
    expect(readSettingsFileRaw(settingsPath)).toEqual({ GAFFER_CONCURRENCY: "3" });
  });

  it("refuses what the runner would refuse: concurrency above 64, a gates list, an unknown mode", () => {
    const env = op();
    expect(writeSettings({ GAFFER_CONCURRENCY: "65" }, env, settingsPath).invalid).toEqual([
      "GAFFER_CONCURRENCY",
    ]);
    expect(writeSettings({ GAFFER_GATES: "tests" }, env, settingsPath).invalid).toEqual([
      "GAFFER_GATES",
    ]);
    expect(writeSettings({ GAFFER_MODE: "yolo" }, env, settingsPath).invalid).toEqual([
      "GAFFER_MODE",
    ]);
    expect(writeSettings({ GAFFER_MODELS: "-x,b,c" }, env, settingsPath).invalid).toEqual([
      "GAFFER_MODELS",
    ]);
    expect(readSettingsFileRaw(settingsPath)).toEqual({});
    const probs = settingProblems({ GAFFER_CONCURRENCY: "99", AUTO_MERGE: "1" }, env);
    expect(probs.map((p) => p.key)).toEqual(["GAFFER_CONCURRENCY", "AUTO_MERGE"]);
    expect(probs[1]!.decidedBy).toBe("GAFFER_MODE");
  });

  it("an old key or any other name is never written, and keys already in the file are kept", () => {
    writeFileSync(settingsPath, JSON.stringify({ AUTO_MERGE: "0", FOO: "x" }));
    const env = op();
    const r = writeSettings(
      { AUTO_MERGE: "1", GAFFER_ALLOW_UNCAPPED: "1", GAFFER_DATA: "/x", GAFFER_MODE: "lite" },
      env,
      settingsPath,
    );
    expect(r.ignored).toEqual(["AUTO_MERGE", "GAFFER_ALLOW_UNCAPPED", "GAFFER_DATA"]);
    expect(readSettingsFileRaw(settingsPath)).toEqual({
      AUTO_MERGE: "0",
      FOO: "x",
      GAFFER_MODE: "lite",
    });
  });

  it("a setting the operator exported is env-locked: reported, never written", () => {
    const env = op({ GAFFER_MODE: "strict" });
    const r = writeSettings({ GAFFER_MODE: "autonomous" }, env, settingsPath);
    expect(r.rejected).toEqual(["GAFFER_MODE"]);
    const mode = settingsReport(env, settingsPath).settings.find((s) => s.key === "GAFFER_MODE")!;
    expect(mode).toMatchObject({ envLocked: true, origin: "environment", effective: "strict" });
  });

  it("notify URLs pass the outbound URL policy too (stricter than the runner, never looser)", () => {
    const env = op();
    for (const bad of ["http://127.0.0.1:8787/x", "http://169.254.169.254/", "http://10.1.2.3/h"]) {
      expect(writeSettings({ GAFFER_NOTIFY: bad }, env, settingsPath).invalid, bad).toEqual([
        "GAFFER_NOTIFY",
      ]);
    }
    expect(writeSettings({ GAFFER_NOTIFY: `desktop,${SLACK}` }, env, settingsPath).written).toEqual(
      ["GAFFER_NOTIFY"],
    );
  });

  it("a value the API stores always loads in the runner: unicode spaces in a notify value", () => {
    // JavaScript's \s splits on a no-break space (and other unicode spaces); the
    // runner's word splitting does not. "desktop<NBSP>https://..." was stored, and then
    // every runner process refused the config.
    const hostile = [
      "desktop\u00a0https://hooks.example.com/w/x",
      "https://hooks.example.com/w/x\u2003desktop",
      "desktop\u2028desktop",
      "desktop\u3000",
      `desktop,${HOOK}`,
      "desktop https://hooks.example.com/w/x",
    ];
    for (const v of hostile) {
      const env = op();
      rmSync(settingsPath, { force: true });
      const res = writeSettings({ GAFFER_NOTIFY: v }, env, settingsPath);
      if (!res.written.includes("GAFFER_NOTIFY")) continue;
      const run = spawnSync("bash", [join(RUNNER_DIR, "lib", "config-records.sh")], {
        env: { PATH: process.env.PATH, HOME: dir, GAFFER_DATA: dir },
        encoding: "utf8",
      });
      expect(run.status, `stored ${JSON.stringify(v)}: ${run.stderr.slice(-300)}`).toBe(0);
    }
    expect(writeSettings({ GAFFER_NOTIFY: hostile[0]! }, op(), settingsPath).invalid).toEqual([
      "GAFFER_NOTIFY",
    ]);
  });

  it("a notify change keeps the saved URLs on the server", () => {
    expect(applyNotifyChange(`desktop,${HOOK},${SLACK}`, { desktop: false })).toBe(
      `${HOOK},${SLACK}`,
    );
    expect(applyNotifyChange(`${HOOK},${SLACK}`, { slack: null })).toBe(HOOK);
    expect(applyNotifyChange("", { desktop: true, webhook: HOOK })).toBe(`desktop,${HOOK}`);
    expect(applyNotifyChange(`desktop,${HOOK}`, { webhook: "https://new.example.com/h" })).toBe(
      "desktop,https://new.example.com/h",
    );
  });
});

describe("GET: origins, derived, migration, overrides, secrets", () => {
  it("each setting says where it came from: default, dashboard or environment", () => {
    writeFileSync(settingsPath, JSON.stringify({ GAFFER_EFFORT: "large" }));
    const env = op({ GAFFER_TESTING: "off" });
    const byKey = new Map(settingsReport(env, settingsPath).settings.map((s) => [s.key, s]));
    expect(byKey.get("GAFFER_EFFORT")).toMatchObject({
      origin: "dashboard",
      effective: "large",
      value: "large",
    });
    expect(byKey.get("GAFFER_TESTING")).toMatchObject({ origin: "environment", envLocked: true });
    expect(byKey.get("GAFFER_MODE")).toMatchObject({
      origin: "default",
      effective: "supervised",
      value: "",
    });
    expect(byKey.get("GAFFER_DATA")).toMatchObject({ writable: false, effective: dir });
    expect(byKey.size).toBe(14);
  });

  it("derived: every value the runner derives, with what decided it", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ GAFFER_MODE: "autonomous", GAFFER_EFFORT: "large" }),
    );
    const rep = settingsReport(op(), settingsPath);
    expect(rep.configError).toBeUndefined();
    const am = rep.derived.find((d) => d.name === "AUTO_MERGE")!;
    expect(am).toMatchObject({
      value: "1",
      setting: "GAFFER_MODE",
      decidedBy: "GAFFER_MODE=autonomous",
      source: "setting",
    });
    const tt = rep.derived.find((d) => d.name === "GAFFER_TICK_TIMEOUT")!;
    expect(tt.decidedBy).toBe("GAFFER_EFFORT=large");
    const names = new Set(loadSchema().settings.flatMap((s) => s.derives.map((d) => d.name)));
    expect(new Set(rep.derived.map((d) => d.name))).toEqual(names);
  });

  it("migration: each old key, what decides it now, whether it differs and which reading is in force", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        GAFFER_MODE: "autonomous",
        AUTO_MERGE: "0",
        REVIEW_MODE: "agent",
        GAFFER_TICK_TIMEOUT: "99999",
        FOO: "1",
      }),
    );
    const rep = settingsReport(op(), settingsPath);
    const by = new Map(rep.migration.map((m) => [m.key, m]));
    expect(by.get("AUTO_MERGE")).toMatchObject({
      setting: "GAFFER_MODE",
      decision: "kept",
      differs: true,
    });
    expect(by.get("AUTO_MERGE")!.inForce).toContain("old value is in force");
    expect(by.get("GAFFER_TICK_TIMEOUT")).toMatchObject({
      setting: "GAFFER_EFFORT",
      decision: "stricter-derived",
    });
    expect(by.get("REVIEW_MODE")).toMatchObject({ decision: "same", differs: false });
    expect(by.get("FOO")).toMatchObject({ decision: "not-a-setting" });
    // The stricter old value is what the derived block shows in force, from the old key.
    expect(rep.derived.find((d) => d.name === "AUTO_MERGE")).toMatchObject({
      value: "0",
      source: "old-key",
    });
  });

  it("overrides: a derived value a real environment variable sets is listed", () => {
    const rep = settingsReport(
      op({ GAFFER_MAX_TURNS: "12", GAFFER_NOTIFY_WEBHOOK_URL: HOOK }),
      settingsPath,
    );
    expect(rep.overrides).toContainEqual({
      name: "GAFFER_MAX_TURNS",
      value: "12",
      setting: "GAFFER_EFFORT",
    });
    expect(rep.overrides).toContainEqual({
      name: "GAFFER_NOTIFY_WEBHOOK_URL",
      value: "(set, hidden)",
      setting: "GAFFER_NOTIFY",
    });
  });

  it("a secret never appears in any block: settings, derived, migration, overrides, cleanup", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        GAFFER_NOTIFY: `desktop,${SLACK}`,
        GAFFER_NOTIFY_WEBHOOK_URL: HOOK,
        GAFFER_NOTIFY_SLACK_URL: SLACK,
      }),
    );
    const env = op({ GAFFER_NOTIFY_EVENTS: "review_needed", OTHER_WEBHOOK_URL: HOOK });
    const rep = settingsReport(env, settingsPath);
    const text = JSON.stringify(rep);
    expect(text).not.toContain("secret-token");
    const notify = rep.settings.find((s) => s.key === "GAFFER_NOTIFY")!;
    expect(notify).toMatchObject({
      secret: true,
      configured: true,
      effective: "desktop, a Slack URL (hooks.slack.com)",
    });
    expect(notify.channels).toEqual([
      { kind: "desktop", host: null },
      { kind: "slack", host: "hooks.slack.com" },
    ]);
    expect(rep.cleanup.drop.map((d) => d.value)).toEqual(["(set, hidden)", "(set, hidden)"]);
  });

  it("a config the runner refuses is reported, and the dashboard applies no derived value", () => {
    // A hand edit the runner stops on (the old page could store a padded value).
    writeFileSync(
      settingsPath,
      JSON.stringify({ GAFFER_CONCURRENCY: " 3", AUTO_MERGE: "1", GAFFER_MODE: "autonomous" }),
    );
    const env = op();
    const rep = settingsReport(env, settingsPath);
    expect(rep.configError).toMatch(/GAFFER_CONCURRENCY/);
    applySettingsToEnv(env, settingsPath);
    expect(env.AUTO_MERGE).toBeUndefined();
    expect(env.DISPATCH_ALLOW_AGENT_APPROVE).toBeUndefined();
    expect(env.GAFFER_MODE).toBe("autonomous");
    expect(env.GAFFER_CONCURRENCY).toBeUndefined();
  });

  it("environment-only names never come from settings.json into the dashboard's environment", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        GAFFER_ALLOW_UNCAPPED: "1",
        GAFFER_WORKER_COMMAND: "/tmp/evil",
        GAFFER_STRICT_REQUIRE: "0",
        GAFFER_EFFORT: "small",
      }),
    );
    const env = op();
    applySettingsToEnv(env, settingsPath);
    for (const k of ["GAFFER_ALLOW_UNCAPPED", "GAFFER_WORKER_COMMAND", "GAFFER_STRICT_REQUIRE"])
      expect(env[k]).toBeUndefined();
    expect(env.GAFFER_EFFORT).toBe("small");
  });

  it("resolves the path under $GAFFER_DATA", () => {
    expect(resolveSettingsPath({ GAFFER_DATA: dir })).toBe(join(dir, "settings.json"));
    expect(readSettingsFile(join(dir, "missing.json"))).toEqual({});
  });
});

describe("the removal act", () => {
  const OLD = {
    GAFFER_MODE: "lite",
    GAFFER_CONCURRENCY: " 3",
    AUTO_MERGE: "1",
    GAFFER_NOTIFY_SLACK_URL: SLACK,
    FOO: "x",
  };

  it("shows exactly what it drops and rewrites, and nothing changes until it is done", () => {
    writeFileSync(settingsPath, JSON.stringify(OLD));
    const plan = cleanupPlan(op(), settingsPath);
    expect(plan.drop.map((d) => d.key).sort()).toEqual([
      "AUTO_MERGE",
      "FOO",
      "GAFFER_NOTIFY_SLACK_URL",
    ]);
    expect(plan.rewrite).toEqual([{ key: "GAFFER_CONCURRENCY", from: " 3", to: "3" }]);
    expect(readSettingsFileRaw(settingsPath)).toEqual(OLD);
  });

  it("keeps only the fourteen, atomically, with stored values the runner accepts", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ ...OLD, GAFFER_BUDGET_USD: "abc", GAFFER_EFFORT: "large" }),
    );
    const env = op();
    const plan = cleanupPlan(env, settingsPath);
    removeOldKeys(
      {
        drop: plan.drop.map((d) => d.key),
        rewrite: plan.rewrite.map((r) => r.key),
        digest: plan.digest,
      },
      env,
      settingsPath,
    );
    expect(readSettingsFileRaw(settingsPath)).toEqual({
      GAFFER_MODE: "lite",
      GAFFER_CONCURRENCY: "3",
      GAFFER_EFFORT: "large",
    });
    expect(settingsReport(env, settingsPath).configError).toBeUndefined();
  });

  it("clamps a concurrency above 64 (the old page allowed it)", () => {
    writeFileSync(settingsPath, JSON.stringify({ GAFFER_CONCURRENCY: "99" }));
    expect(cleanupPlan(op(), settingsPath).rewrite).toEqual([
      { key: "GAFFER_CONCURRENCY", from: "99", to: "64" },
    ]);
  });

  it("refuses when the file changed since the page showed the plan", () => {
    writeFileSync(settingsPath, JSON.stringify(OLD));
    const env = op();
    const plan = cleanupPlan(env, settingsPath);
    expect(() =>
      removeOldKeys({ drop: ["AUTO_MERGE"], rewrite: [], digest: plan.digest }, env, settingsPath),
    ).toThrow(/changed since/);
    expect(readSettingsFileRaw(settingsPath)).toEqual(OLD);
  });

  it("refuses a file whose VALUES changed since the plan, the keys alike (the person saw other values)", () => {
    writeFileSync(settingsPath, JSON.stringify(OLD));
    const env = op();
    const plan = cleanupPlan(env, settingsPath);
    expect(plan.rewrite).toEqual([{ key: "GAFFER_CONCURRENCY", from: " 3", to: "3" }]);
    // Between the page's plan and the person's click the stored value changes: the same
    // keys, but the act would now clamp to 64 what the person saw become 3.
    const changed = { ...OLD, GAFFER_CONCURRENCY: " 300" };
    writeFileSync(settingsPath, JSON.stringify(changed));
    expect(() =>
      removeOldKeys(
        {
          drop: plan.drop.map((d) => d.key),
          rewrite: plan.rewrite.map((r) => r.key),
          digest: plan.digest,
        },
        env,
        settingsPath,
      ),
    ).toThrow(/changed since/);
    expect(readSettingsFileRaw(settingsPath)).toEqual(changed);
  });

  it("marks each old key whose removal makes the factory looser, with what decides it after", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ GAFFER_EFFORT: "large", GAFFER_TICK_TIMEOUT: "1800", AUTO_MERGE: "1" }),
    );
    const env = op();
    const report = settingsReport(env, settingsPath);
    const tt = report.migration.find((m) => m.key === "GAFFER_TICK_TIMEOUT")!;
    expect(tt.decision).toBe("kept");
    const drop = new Map(report.cleanup.drop.map((d) => [d.key, d]));
    expect(drop.get("GAFFER_TICK_TIMEOUT")).toMatchObject({
      loosens: true,
      setting: "GAFFER_EFFORT",
      after: tt.derived,
    });
    // A permissive old key the mode already overrules: removing it changes nothing.
    expect(drop.get("AUTO_MERGE")!.loosens).toBeUndefined();
  });

  it("never shows the value of a key the runner never read (only its name)", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ GH_PAT: "ghp_hand_stored_token", AUTO_MERGE: "1" }),
    );
    const report = settingsReport(op(), settingsPath);
    const text = JSON.stringify(report);
    expect(text).not.toContain("ghp_hand_stored_token");
    expect(report.cleanup.drop.find((d) => d.key === "GH_PAT")!.value).toBe("(not shown)");
    expect(report.migration.find((m) => m.key === "GH_PAT")!.old).toBe("(not shown)");
  });
});
