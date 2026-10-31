// S12 settings groups. The boot room counts only what the operator really exported
// as env-locked (run-suites.sh exports GAFFER_NOTIFY_DESKTOP=0) and shows that row
// read-only; the server refuses to write it. One value in each of the Autonomy,
// Budget, Delivery and Quality groups is changed and saved with Save changes (one
// save per group): the POST carries only that key, /api/settings reports it
// effective from settings.json, and the NEXT runner tick sees it — the stub records
// the GAFFER_* env and argv the agent got; a key the agent's env never carries is
// read back through the runner's own config layer (factory.config.sh in a clean env).
// Discard drops an unsaved edit.
import { execFileSync } from "node:child_process";
import path from "node:path";

export default async function s12(t, L) {
  const p = t.page;
  await t.visit("settings");

  // ── env-locked: only the operator's export ────────────────────────────────
  const head = (await p.textContent(".view").catch(() => "")) || "";
  const locked = [...(await L.settingsMap()).values()].filter((s) => s.envLocked).map((s) => s.key);
  t.check(
    locked.length === 1 &&
      locked[0] === "GAFFER_NOTIFY_DESKTOP" &&
      /· 1 set by the environment/.test(head),
    "only the operator-exported key is env-locked (GAFFER_NOTIFY_DESKTOP; header says '1 set by the environment')",
    `env-locked keys: ${JSON.stringify(locked)}; header: ${head.match(/\d+ set by the environment/)?.[0]}`,
  );
  const lockedRow = p.locator("#set-GAFFER_NOTIFY_DESKTOP");
  await lockedRow.evaluate((n) => {
    const d = n.closest("details");
    if (d) d.open = true;
  });
  const ro = await lockedRow
    .locator("input")
    .evaluate((n) => n.disabled && n.readOnly)
    .catch(() => false);
  const badge = (await lockedRow.textContent()) || "";
  t.check(
    ro && (await lockedRow.getAttribute("class")).includes("is-locked") && /env/i.test(badge),
    "the env-locked row is read-only in the UI and says the environment sets it",
    `locked row: readOnly=${ro} text='${badge.slice(0, 120)}'`,
  );
  const refuse = await L.putSettings({ GAFFER_NOTIFY_DESKTOP: "1" });
  t.check(
    refuse.status < 300 &&
      (refuse.json.rejected || []).includes("GAFFER_NOTIFY_DESKTOP") &&
      L.readSettingsFile().GAFFER_NOTIFY_DESKTOP === undefined,
    "the server refuses to write an env-locked key (POST /api/settings lists it as rejected; settings.json untouched)",
    `write of a locked key: ${refuse.status} ${JSON.stringify(refuse.json).slice(0, 200)}`,
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

  // ── one change per group, each saved on its own ───────────────────────────
  const groups = [
    { group: "Autonomy", key: "GAFFER_TESTING", value: "1", agentEnv: true },
    {
      group: "Budget",
      key: "GAFFER_MAX_TURNS",
      value: "37",
      agentEnv: true,
      argv: ["--max-turns", "37"],
    },
    { group: "Delivery", key: "GAFFER_PR_MERGE_METHOD", value: "squash", agentEnv: true },
    { group: "Quality", key: "OVERSIZED_MAX_LINES", value: "900", agentEnv: false },
  ];
  for (const g of groups) {
    await t.visit("settings");
    await t.setSetting(g.key, g.value);
    const sv = await t.saveSettings();
    const keys = Object.keys(sv.sent);
    t.check(
      sv.status < 300 && keys.length === 1 && sv.sent[g.key] === g.value,
      `${g.group}: Save changes posted only ${g.key}=${g.value}`,
      `${g.group} save: ${sv.status} ${JSON.stringify(sv.sent)}`,
    );
    const row = (await L.settingsMap()).get(g.key);
    t.check(
      row &&
        row.effective === g.value &&
        row.source === "file" &&
        L.readSettingsFile()[g.key] === g.value,
      `${g.group}: /api/settings reports ${g.key} effective=${g.value} from settings.json`,
      `${g.group}: ${g.key} after save ${JSON.stringify(row)}`,
    );
    await t.visit("settings");
    const shown = await p.locator(`#set-${g.key}`).evaluate((n) => {
      const i = n.querySelector("select, input");
      return i ? (i.type === "checkbox" ? (i.checked ? "1" : "0") : i.value) : "";
    });
    t.check(
      shown === g.value,
      `${g.group}: after a reload the row shows the saved ${g.key}`,
      `${g.group}: reloaded row shows '${shown}'`,
    );
  }

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
    if (g.argv) {
      const i = call ? call.argv.indexOf(g.argv[0]) : -1;
      t.check(
        i >= 0 && call.argv[i + 1] === g.argv[1],
        `the agent was launched with ${g.argv.join(" ")} (the saved turn cap)`,
        `agent argv: ${call ? call.argv.join(" ").slice(0, 200) : "(no call)"}`,
      );
    }
  }
  const cfg = path.join(L.ROOT, "runner", "factory.config.sh");
  for (const g of groups.filter((x) => !x.agentEnv)) {
    let got;
    try {
      got = execFileSync(
        "env",
        [
          "-i",
          `PATH=${process.env.PATH}`,
          `HOME=${process.env.HOME}`,
          `GAFFER_DATA=${L.GAFFER_DATA}`,
          "bash",
          "-c",
          `source "${cfg}" >/dev/null 2>&1; printf %s "\${${g.key}:-}"`,
        ],
        { encoding: "utf8", timeout: 60000 },
      );
    } catch (e) {
      got = `error: ${e.message.slice(0, 80)}`;
    }
    t.check(
      got === g.value,
      `the runner's config layer (what every tick sources) reads ${g.key}=${g.value} from settings.json`,
      `factory.config.sh in a clean env reads ${g.key}='${got}'`,
    );
  }
}
