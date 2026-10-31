// S4 autonomy flags, asserted by ticket STATUS only (Review markup is held while it
// is reworked). On this shared server the containment gate stays on, so the flags
// that let an AGENT ship are exercised where no agent has to launch under them:
//   • AUTO_MERGE ('Auto-merge on approval') saved in Settings: a human approval in
//     Review lands the branch at once (done) — no Merge now;
//   • REVIEW_MODE=both: the reviewer agent's APPROVE screens the delivery and leaves
//     it in Review for the human to confirm;
//   • the dial: choosing Autonomous shows the Go/No-Go with the containment check
//     before anything is saved.
// The agent-ships paths (DISPATCH_ALLOW_AGENT_APPROVE, MERGE_ON_AGENT_REVIEW, the
// merge lane after an agent approval, graduated policies) need a server with an OS
// sandbox (or GAFFER_STRICT_REQUIRE=0 out of band); they are SKIPPED here with that
// reason rather than half-tested. PR mode with required CI is s4b-pr-mode, which runs
// on its own server with a fake `gh` on PATH.
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

  // ── AUTO_MERGE: a human approval lands at once ────────────────────────────
  const a = await deliver("Auto-merge on approval");
  await t.visit("settings");
  await t.setSetting("AUTO_MERGE", "1");
  const sv = await t.saveSettings();
  t.check(
    sv.status < 300 &&
      sv.sent.AUTO_MERGE === "1" &&
      (await L.settingsMap()).get("AUTO_MERGE")?.effective === "1",
    "Settings: 'Auto-merge on approval' saved and effective",
    `AUTO_MERGE save: ${sv.status} ${JSON.stringify(sv.sent)}`,
  );
  const ap = await t.approve(a);
  const landed = await L.waitStatus(a.id, ["done"], 120000, 2000);
  t.check(
    landed,
    `with AUTO_MERGE on, approving #${a.number} in Review landed it (done) without Merge now`,
    `after approval with AUTO_MERGE on #${a.number} is '${(await L.ticketOf(a.id)).status}' (first ${ap?.status})`,
  );
  await t.visit("settings");
  await t.setSetting("AUTO_MERGE", "0");
  await t.saveSettings();

  // ── REVIEW_MODE=both: the agent screens, the human confirms ───────────────
  const b = await deliver("Review mode both");
  await t.visit("settings");
  await t.setSetting("REVIEW_MODE", "both");
  await t.saveSettings();
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
      L.readSettingsFile().GAFFER_MODE === undefined,
      "nothing is saved by moving the dial alone",
      `GAFFER_MODE in settings.json: ${L.readSettingsFile().GAFFER_MODE}`,
    );
    await p
      .locator('.boot-save button:has-text("Discard")')
      .click()
      .catch(() => {});
  } else t.bad("the Team instructions dial has no Autonomous stop");

  t.skip(
    "agent approval / MERGE_ON_AGENT_REVIEW / the merge lane after an agent approval / graduated policies: need a contained runner (OS sandbox or GAFFER_STRICT_REQUIRE=0 out of band) — scaffold for an own-server shard",
  );
}
