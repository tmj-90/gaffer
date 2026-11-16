// S4 autonomy, asserted by ticket STATUS only (Review markup is held while it is
// reworked). Autonomy is granted ONE way: the Autonomy mode setting (GAFFER_MODE, the
// dial in Settings), or a variable in the runner's own environment. This suite runs on
// its OWN server whose environment sets REVIEW_MODE=both (no mode derives `both`), and
// opts out of the OS sandbox like every world (every agent is a stub), so the paths
// that let an AGENT ship are exercised where no agent has to launch under them:
//   • an OLD settings.json key never grants: AUTO_MERGE=1 written into settings.json by
//     hand (as the old Settings page did) leaves a human approval waiting at
//     ready_for_merge under the supervised mode (P-B1 of the fourteen-settings review:
//     the dashboard used to hand the old key to the merge runner as environment);
//   • the Autonomy mode set to Autonomous on the dial and saved: a human approval in
//     Review lands the branch at once (done), or the merge gate holds it on this
//     unsandboxed host; no Merge now;
//   • REVIEW_MODE=both from the environment: the reviewer agent's APPROVE screens the
//     delivery and leaves it in Review for the human to confirm;
//   • the dial: choosing Autonomous shows the Go/No-Go with the containment check
//     before anything is saved.
// The agent-ships paths (agent approval, merge on an agent review, the merge lane after
// an agent approval, graduated policies) belong on a server with an OS sandbox; they are
// SKIPPED here with that reason rather than half-tested. PR mode with required CI is
// s4b-pr-mode, which runs on its own server with a fake `gh` on PATH.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const server = { env: { REVIEW_MODE: "both" }, fixtures: [] };

export default async function s4(t, L) {
  const p = t.page;
  const deliver = async (title) => {
    const tk = await L.seedTicket(t, {
      title: `${title} (${L.tag("s4")})`,
      acs: ["covered by a test"],
      ready: true,
    });
    await t.visit("work");
    await t.poll();
    const st = await L.waitStatus(tk.id, L.SETTLED, 240000);
    if (st?.status !== "in_review") t.bad(`seed delivery of #${tk.number} ended '${st?.status}'`);
    await L.maybe(
      async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
      "tick done",
      60000,
      1000,
    );
    return tk;
  };

  const settingsFile = path.join(L.GAFFER_DATA, "settings.json");
  const readFile = () => {
    try {
      return JSON.parse(readFileSync(settingsFile, "utf8"));
    } catch {
      return {};
    }
  };

  // ── an old settings.json key never grants autonomy (P-B1) ─────────────────
  const z = await deliver("Old auto-merge key");
  const before = readFile();
  writeFileSync(settingsFile, JSON.stringify({ ...before, AUTO_MERGE: "1" }, null, 2));
  // Any save makes the dashboard read settings.json again into its own environment
  // (before the fix it copied the old key there too, and every runner it started,
  // the merge runner included, read it as the operator's).
  await L.putSettings({ GAFFER_LANDING: "local" });
  const dm = await L.derivedMap();
  const mig = ((await L.api("GET", "/api/settings")).json.migration || []).find(
    (m) => m.key === "AUTO_MERGE",
  );
  t.check(
    dm.get("AUTO_MERGE")?.value === "0" && mig?.setting === "GAFFER_MODE",
    "an old AUTO_MERGE=1 in settings.json: the runner's reading is the mode's 0, and the migration callout names GAFFER_MODE",
    `derived AUTO_MERGE=${JSON.stringify(dm.get("AUTO_MERGE"))} migration=${JSON.stringify(mig)}`,
  );
  const hz = await t.approve(z);
  await L.sleep(5000);
  const zNow = await L.ticketOf(z.id);
  t.check(
    hz?.status === "ready_for_merge" && zNow.status === "ready_for_merge",
    `with an old AUTO_MERGE=1 in settings.json and the supervised mode, approving #${z.number} does NOT merge it (it waits at ready_for_merge)`,
    `after approval #${z.number} is '${zNow.status}' (first ${hz?.status}): the old key reached the merge runner`,
  );
  writeFileSync(settingsFile, JSON.stringify(before, null, 2));

  // ── the Autonomy mode: a human approval lands at once ─────────────────────
  const a = await deliver("Autonomous mode, human approval");
  await t.visit("settings");
  await t.setSetting("GAFFER_MODE", "autonomous");
  const sv = await t.saveSettings();
  t.check(
    sv.status < 300 &&
      sv.sent.GAFFER_MODE === "autonomous" &&
      Object.keys(sv.sent).length === 1 &&
      (await L.derivedMap()).get("AUTO_MERGE")?.value === "1",
    "Settings: the Autonomy mode dial saved Autonomous (GAFFER_MODE only), and the runner derives AUTO_MERGE=1 from it",
    `GAFFER_MODE save: ${sv.status} ${JSON.stringify(sv.sent)}`,
  );
  const ap = await t.approve(a);
  // Landing is gated: the merge of the branch onto the CURRENT target is built and the
  // repo's Definition-of-Done gates run on that combined code before anything lands.
  // Auto merge (from the mode) is an autonomy flag, so the gate runs under strict containment; on a
  // host with no OS sandbox (this shared server: provider none, no sandbox-exec) the
  // gate cannot run and fails CLOSED: the ticket is HELD (blocked, merge_gate_red) with
  // the merge-gate evidence, and main is untouched. That is the promise under test.
  // The landing itself (done) needs a contained runner; see the note.
  const settled = await L.waitStatus(a.id, ["done", "blocked"], 120000, 2000);
  const view = await L.ticketView(a.id);
  const after = view.ticket;
  const blockedEv = (view.events || []).filter((e) => e.event_type === "ticket.blocked").pop();
  const blockedReason = (() => {
    try {
      return JSON.parse(blockedEv?.payload_json || "{}").reason || "";
    } catch {
      return String(blockedEv?.payload_json || "");
    }
  })();
  if (after.status === "done") {
    t.ok(`under the Autonomous mode, approving #${a.number} landed it through the merge gate (done)`);
  } else {
    t.check(
      settled &&
        after.status === "blocked" &&
        /merge gate|merge_gate|fails its gates|sandbox/i.test(blockedReason),
      `under the Autonomous mode and no OS sandbox, approving #${a.number} did NOT land it: the merge gate held it (blocked) with its reason recorded`,
      `after approval under the Autonomous mode #${a.number} is '${after.status}' (first ${ap?.status}); blocked reason: ${blockedReason.slice(0, 200)}`,
    );
    t.note(
      `an Autonomous landing (done) needs a contained runner (OS sandbox); this host holds at the merge gate instead`,
    );
  }
  if (after.status === "blocked" && L.REPO_PATH) {
    const branch = view.ticket?.branch_name || "";
    const onMain = branch
      ? L.git(L.REPO_PATH, "branch", "--merged", "main", "--list", branch).trim()
      : "";
    t.check(
      onMain === "",
      `main is untouched by the held landing (the delivery branch is not merged)`,
      `the held landing reached main anyway: ${onMain}`,
    );
  }
  await t.visit("settings");
  await t.setSetting("GAFFER_MODE", "supervised");
  await t.saveSettings();

  // ── REVIEW_MODE=both (this server's environment): the agent screens, the human confirms
  const rm = (await L.derivedMap()).get("REVIEW_MODE");
  t.check(
    rm?.value === "both" && rm?.source === "environment",
    "REVIEW_MODE=both comes from the environment and Settings lists it as overridden",
    `derived REVIEW_MODE: ${JSON.stringify(rm)}`,
  );
  const b = await deliver("Review mode both");
  await t.visit("work");
  const toast = await t.poll();
  await L.maybe(
    async () => (L.stubCalls({ kind: "reviewer", ticket: b.number }).length ? true : null),
    "reviewer",
    120000,
    1000,
  );
  await L.maybe(
    async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
    "review tick",
    120000,
    1000,
  );
  t.check(
    /review/i.test(toast) &&
      L.stubCalls({ kind: "reviewer", ticket: b.number }).length === 1 &&
      (await L.ticketOf(b.id)).status === "in_review",
    `REVIEW_MODE=both: the reviewer agent APPROVEd #${b.number} and it stays in Review for the human`,
    `REVIEW_MODE=both: toast="${toast}" reviewer calls=${L.stubCalls({ kind: "reviewer", ticket: b.number }).length} status=${(await L.ticketOf(b.id)).status}`,
  );
  const hb = await t.approve(b);
  t.check(
    hb?.status === "ready_for_merge",
    `the human's approval then moves #${b.number} on (ready_for_merge)`,
    `human approval after the agent screen: '${hb?.status}'`,
  );

  // ── the dial's Go/No-Go before raising autonomy ───────────────────────────
  await t.visit("settings");
  const stop = p.locator('#instructions .dial-stop[data-mode="autonomous"]');
  if (await stop.count()) {
    await stop.click();
    await L.sleep(500);
    const ti = (await p.textContent("#instructions").catch(() => "")) || "";
    t.check(
      /sandbox|contain/i.test(ti),
      "choosing Autonomous on the dial shows the Go/No-Go with the containment (sandbox) check before saving",
      `the dial's Go/No-Go after choosing Autonomous: '${ti.slice(0, 200)}'`,
    );
    t.check(
      L.readSettingsFile().GAFFER_MODE === "supervised",
      "nothing is saved by moving the dial alone",
      `GAFFER_MODE in settings.json: ${L.readSettingsFile().GAFFER_MODE}`,
    );
    await p
      .locator('.boot-save button:has-text("Discard")')
      .click()
      .catch(() => {});
  } else t.bad("the Team instructions dial has no Autonomous stop");

  t.skip(
    "agent approval / merge on an agent review / the merge lane after an agent approval / graduated policies: need a runner with an OS sandbox, not this opted-out server; scaffold for a sandboxed shard",
  );
}
