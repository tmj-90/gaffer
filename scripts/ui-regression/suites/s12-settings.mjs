// S12 the boot room carries the fourteen settings. Only what the operator really
// exported is env-locked (run-suites.sh exports GAFFER_SANDBOX=auto) and that row is
// read-only; the server refuses to write it. A derived value the environment sets
// (GAFFER_NOTIFY_DESKTOP=0, also exported) is listed under Overridden from the
// environment. An old knob is refused by the API, naming the setting that decides it.
// One setting in each of the Budget, Models and effort, Safety and Notify sections is
// changed and saved with Save changes (one save per section): the POST carries only
// that setting, /api/settings reports it set here, "What this sets" shows what it
// derives, and the NEXT runner tick sees it (the stub records the GAFFER_* env and argv
// the agent got; a value the agent's env never carries is read back through the
// runner's own config layer). Discard drops an unsaved edit. Old keys written into
// settings.json raise the migration callout, and its removal act (after the confirm)
// leaves only the fourteen.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const FOURTEEN = [
  "GAFFER_MODE",
  "GAFFER_DAILY_BUDGET_USD",
  "GAFFER_BUDGET_USD",
  "GAFFER_MODELS",
  "GAFFER_EFFORT",
  "GAFFER_CONCURRENCY",
  "GAFFER_SANDBOX",
  "GAFFER_GATES",
  "GAFFER_LANDING",
  "GAFFER_TESTING",
  "GAFFER_IDLE",
  "GAFFER_NOTIFY",
  "GAFFER_DATA",
  "DISPATCH_API_PORT",
];

export default async function s12(t, L) {
  const p = t.page;
  await t.visit("settings");

  // ── fourteen controls, and no old knob ────────────────────────────────────
  const ids = await p.$$eval("[id^='set-']", (ns) => ns.map((n) => n.id.slice(4)).sort());
  t.check(
    JSON.stringify(ids) === JSON.stringify([...FOURTEEN].sort()) &&
      (await p.locator("#set-AUTO_MERGE, #set-REVIEW_MODE, #set-GAFFER_TICK_TIMEOUT").count()) ===
        0,
    "the boot room has one control per setting (the fourteen; the Autonomy mode is the dial) and none for an old knob",
    `controls: ${JSON.stringify(ids)}`,
  );

  // ── env-locked: only the operator's export ────────────────────────────────
  const head = (await p.textContent(".view").catch(() => "")) || "";
  const locked = [...(await L.settingsMap()).values()].filter((s) => s.envLocked).map((s) => s.key);
  // The world's operator environment: GAFFER_SANDBOX (run-suites.sh), and the data dir
  // and port setup.sh exports for every world. Nothing saved in settings.json is locked.
  const exported = ["GAFFER_SANDBOX", "GAFFER_DATA", "DISPATCH_API_PORT"];
  t.check(
    locked.includes("GAFFER_SANDBOX") &&
      locked.every((k) => exported.includes(k)) &&
      new RegExp(`· ${locked.length} set by the environment`).test(head),
    "only what the operator exported is env-locked (GAFFER_SANDBOX, plus the world's data dir and port; the header counts them)",
    `env-locked: ${JSON.stringify(locked)}; header: ${head.match(/\d+ set by the environment/)?.[0]}`,
  );
  const lockedRow = p.locator("#set-GAFFER_SANDBOX");
  const editors = await lockedRow.locator("input, select").count();
  const badge = (await lockedRow.textContent()) || "";
  t.check(
    editors === 0 &&
      (await lockedRow.getAttribute("class")).includes("is-locked") &&
      /set by the environment/.test(badge),
    "the env-locked row is read-only (no editor) and says the environment sets it",
    `locked row: editors=${editors} text='${badge.slice(0, 160)}'`,
  );
  const refuse = await L.putSettings({ GAFFER_SANDBOX: "docker" });
  t.check(
    refuse.status < 300 &&
      (refuse.json.rejected || []).includes("GAFFER_SANDBOX") &&
      L.readSettingsFile().GAFFER_SANDBOX === undefined,
    "the server refuses to write an env-locked setting (listed as rejected; settings.json untouched)",
    `write of a locked setting: ${refuse.status} ${JSON.stringify(refuse.json).slice(0, 200)}`,
  );
  const over = (await p.textContent("#settings-overrides").catch(() => "")) || "";
  t.check(
    /GAFFER_NOTIFY_DESKTOP/.test(over) && /GAFFER_NOTIFY\b/.test(over),
    "Overridden from the environment lists GAFFER_NOTIFY_DESKTOP (Notify would decide it otherwise)",
    `override list: '${over.slice(0, 200)}'`,
  );
  await L.shot(p, "s12-override-list");
  const old = await L.putSettings({ AUTO_MERGE: "1" });
  t.check(
    old.status === 422 &&
      /AUTO_MERGE is no longer a setting: GAFFER_MODE decides it now/.test(
        JSON.stringify(old.json),
      ) &&
      L.readSettingsFile().AUTO_MERGE === undefined,
    "an old knob is refused (422) naming the setting that decides it now; nothing written",
    `write of AUTO_MERGE: ${old.status} ${JSON.stringify(old.json).slice(0, 200)}`,
  );
  t.check(
    /Changes apply on the next tick/.test(head),
    "the boot room says changes apply on the next tick",
    "the 'apply on the next tick' note is missing",
  );

  // ── Discard drops an unsaved edit ─────────────────────────────────────────
  await t.setSetting("GAFFER_CONCURRENCY", "4");
  const dirty = (await p.textContent(".boot-dirty").catch(() => "")) || "";
  await p.locator('.boot-save button:has-text("Discard")').click();
  await L.sleep(900);
  const val = await p
    .locator("#set-GAFFER_CONCURRENCY input")
    .inputValue()
    .catch(() => "?");
  t.check(
    /1 unsaved change/.test(dirty) &&
      val === "" &&
      L.readSettingsFile().GAFFER_CONCURRENCY === undefined,
    "an edit shows '1 unsaved change'; Discard puts the row back and saves nothing",
    `discard: dirty='${dirty}' value after='${val}' file=${L.readSettingsFile().GAFFER_CONCURRENCY}`,
  );

  // ── one change per section, each saved on its own ─────────────────────────
  const shownOf = (key) =>
    p.locator(`#set-${key}`).evaluate((n) => {
      const r = n.querySelector("input[type=radio]:checked");
      if (r) return r.value;
      const c = n.querySelector("input[type=checkbox]");
      if (c) return c.checked ? "desktop" : "";
      const i = n.querySelector("select, input");
      return i ? i.value : "";
    });
  const groups = [
    { group: "Budget", key: "GAFFER_BUDGET_USD", value: "50", agentEnv: true },
    { group: "Models and effort", key: "GAFFER_EFFORT", value: "large", agentEnv: true },
    { group: "Safety", key: "GAFFER_TESTING", value: "off", agentEnv: true },
    // Notify saves a structured change (the page never holds a saved URL).
    { group: "Notify", key: "GAFFER_NOTIFY", value: "desktop", agentEnv: false },
  ];
  for (const g of groups) {
    await t.visit("settings");
    if (g.key === "GAFFER_NOTIFY") await p.locator("#set-GAFFER_NOTIFY label.switch").click();
    else await t.setSetting(g.key, g.value);
    const sv = await t.saveSettings();
    const keys = Object.keys(sv.sent);
    t.check(
      sv.status < 300 &&
        (g.key === "GAFFER_NOTIFY"
          ? keys.length === 0 && (sv.body.written || []).includes("GAFFER_NOTIFY")
          : keys.length === 1 && sv.sent[g.key] === g.value),
      `${g.group}: Save changes posted only ${g.key}=${g.value}`,
      `${g.group} save: ${sv.status} ${JSON.stringify(sv.sent)} written=${JSON.stringify(sv.body.written)}`,
    );
    const row = (await L.settingsMap()).get(g.key);
    t.check(
      row &&
        row.origin === "dashboard" &&
        row.effective === g.value &&
        L.readSettingsFile()[g.key] === g.value,
      `${g.group}: /api/settings reports ${g.key}=${g.value}, set here`,
      `${g.group}: ${g.key} after save ${JSON.stringify(row)}`,
    );
    await t.visit("settings");
    const shown = await shownOf(g.key);
    t.check(
      shown === g.value,
      `${g.group}: after a reload the control shows the saved ${g.key}`,
      `${g.group}: reloaded control shows '${shown}'`,
    );
  }
  // What this sets: Effort large and the turn cap it derives, with the figure in force.
  const turns = (await L.derivedMap()).get("GAFFER_MAX_TURNS");
  await t.visit("settings");
  await p.locator("#set-GAFFER_EFFORT .what-sets > summary").click();
  const sets = (await p.textContent("#set-GAFFER_EFFORT .what-sets").catch(() => "")) || "";
  t.check(
    turns?.decidedBy === "GAFFER_EFFORT=large" &&
      sets.includes(`GAFFER_MAX_TURNS${turns.value}`) &&
      /GAFFER_TICK_TIMEOUT/.test(sets),
    `What this sets under Effort lists the values it derives, with the turn cap in force (${turns?.value})`,
    `What this sets: '${sets.slice(0, 200)}' (turn cap ${JSON.stringify(turns)})`,
  );
  await L.shot(p, "s12-what-this-sets");

  // ── the next tick sees them ───────────────────────────────────────────────
  const tk = await L.seedTicket(t, {
    title: `Settings reach the tick (${L.tag("s12")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  await t.visit("work");
  await t.poll();
  await L.waitStatus(tk.id, L.SETTLED, 240000);
  const call = L.stubCalls({ kind: "delivery", ticket: tk.number })[0];
  for (const g of groups.filter((x) => x.agentEnv)) {
    t.check(
      call && call.env[g.key] === g.value,
      `the next tick's agent ran with ${g.key}=${g.value} (stub-recorded env)`,
      `the next tick's agent env has ${g.key}=${call ? call.env[g.key] : "(no call)"}`,
    );
  }
  const i = call ? call.argv.indexOf("--max-turns") : -1;
  t.check(
    i >= 0 && call.argv[i + 1] === turns?.value,
    `the agent was launched with --max-turns ${turns?.value} (what Effort large derives)`,
    `agent argv: ${call ? call.argv.join(" ").slice(0, 200) : "(no call)"}`,
  );
  t.check(
    call && call.env.GAFFER_NOTIFY === undefined,
    "the agent's environment never carries GAFFER_NOTIFY",
    `agent env GAFFER_NOTIFY=${call ? call.env.GAFFER_NOTIFY : "(no call)"}`,
  );
  const cfg = path.join(L.ROOT, "runner", "factory.config.sh");
  const runnerReads = (name) => {
    try {
      return execFileSync(
        "env",
        [
          "-i",
          `PATH=${process.env.PATH}`,
          `HOME=${process.env.HOME}`,
          `GAFFER_DATA=${L.GAFFER_DATA}`,
          "bash",
          "-c",
          `source "${cfg}" >/dev/null 2>&1; printf %s "\${${name}:-}"`,
        ],
        { encoding: "utf8", timeout: 60000 },
      );
    } catch (e) {
      return `error: ${e.message.slice(0, 80)}`;
    }
  };
  const notify = runnerReads("GAFFER_NOTIFY");
  const desk = runnerReads("GAFFER_NOTIFY_DESKTOP");
  t.check(
    notify === "desktop" && desk === "1",
    "the runner's config layer (what every tick sources) reads GAFFER_NOTIFY=desktop and derives the desktop channel",
    `factory.config.sh in a clean env reads GAFFER_NOTIFY='${notify}' GAFFER_NOTIFY_DESKTOP='${desk}'`,
  );

  // ── old keys: the migration callout and its removal act ───────────────────
  const file = path.join(L.GAFFER_DATA, "settings.json");
  const kept = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(
    file,
    JSON.stringify({ ...kept, AUTO_MERGE: "1", GAFFER_TICK_TIMEOUT: "1800", FOO_OLD: "x" }),
  );
  await t.visit("settings");
  await p.reload({ waitUntil: "load" });
  await p.waitForSelector("#settings-migration", { timeout: 15000 }).catch(() => {});
  const mig = (await p.textContent("#settings-migration").catch(() => "")) || "";
  t.check(
    /AUTO_MERGE/.test(mig) && /GAFFER_MODE/.test(mig) && /GAFFER_TICK_TIMEOUT/.test(mig),
    "old keys in settings.json raise one callout naming each and the setting that decides it now",
    `migration callout: '${mig.slice(0, 240)}'`,
  );
  await L.shot(p, "s12-migration-callout");
  await p.locator(".mig-start").click();
  const confirm = (await p.textContent(".mig-confirm").catch(() => "")) || "";
  t.check(
    /AUTO_MERGE/.test(confirm) && /FOO_OLD/.test(confirm) && L.readSettingsFile().AUTO_MERGE === "1",
    "the removal act first shows exactly what it drops, and nothing is removed yet",
    `confirm: '${confirm.slice(0, 200)}'`,
  );
  const resP = p.waitForResponse((r) => /\/api\/settings\/remove-old-keys$/.test(r.url()), {
    timeout: 15000,
  });
  await p.locator(".mig-remove").click();
  const res = await resP.catch(() => null);
  const after = L.readSettingsFile();
  t.check(
    res &&
      res.status() === 200 &&
      Object.keys(after).every((k) => FOURTEEN.includes(k)) &&
      after.GAFFER_EFFORT === "large",
    "Remove leaves only the fourteen in settings.json (the settings saved here kept)",
    `after the removal act: ${res ? res.status() : "(no response)"} ${JSON.stringify(after)}`,
  );
  await p
    .waitForSelector("#settings-migration", { state: "detached", timeout: 15000 })
    .catch(() => {});
  t.check(
    (await p.locator("#settings-migration").count()) === 0,
    "after the removal act the callout is gone",
    "the migration callout is still shown after the removal act",
  );
}
