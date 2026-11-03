// S5 the independent tester lane. GAFFER_TESTING is switched on in Settings; a
// ticket's "Eligible for black-box testing" switch is flipped on its page. TESTER FIRST:
// the delivery tick sends each one to Testing BEFORE the human review (an approval of
// the untested commit is refused); the next Poll runs the tester (stub verdicts): PASS →
// back in Review, where the person approves the tested commit → Ready for merge, FAIL →
// Refining with the observation as rework feedback, no verdict token → held in Testing,
// where a human records the PASS from the ticket page (a summary required) → Review.
export default async function s5(t, L) {
  const p = t.page;

  await t.visit("settings");
  await t.setSetting("GAFFER_TESTING", "1");
  const sv = await t.saveSettings();
  t.check(
    sv.status < 300 &&
      sv.sent.GAFFER_TESTING === "1" &&
      (await L.settingsMap()).get("GAFFER_TESTING")?.effective === "1",
    "Settings: the tester lane (GAFFER_TESTING) switched on and saved; /api/settings reports it effective",
    `GAFFER_TESTING save: ${sv.status} ${JSON.stringify(sv.sent)}`,
  );

  const modes = ["tester_pass", "tester_fail", "tester_no_verdict"];
  const tks = [];
  for (const m of modes) {
    const tk = await L.seedTicket(t, {
      title: `Tester ${m} (${L.tag("s5")})`,
      acs: ["the task list still grows"],
    });
    L.setStubMode(tk.number, m);
    tks.push(tk);
  }

  // ── flip the testable switch on each ticket page, then ready it ───────────
  for (const tk of tks) {
    await t.visit(`ticket/${tk.id}`);
    const sw = p.locator(".tk-testable input[type=checkbox]");
    const resP = p.waitForResponse((r) => r.url().endsWith(`/tickets/${tk.id}/testable`), {
      timeout: 10000,
    });
    await p.locator(".tk-testable label.switch").click();
    const res = await resP.catch(() => null);
    const body = res ? JSON.parse(res.request().postData() || "{}") : {};
    const on = (await L.ticketOf(tk.id)).can_be_tested;
    t.check(
      res && res.status() < 300 && (on === 1 || on === true) && (await sw.isChecked()),
      `#${tk.number}: the testable switch posted /testable and the ticket is eligible for black-box testing`,
      `testable switch on #${tk.number}: ${res && res.status()} body=${JSON.stringify(body)} can_be_tested=${on}`,
    );
    await p.locator('button:has-text("Mark ready")').first().click();
    await L.waitStatus(tk.id, ["ready"], 10000, 400);
  }

  // ── deliver all three: each goes to Testing before the human review ──────
  for (let i = 0; i < tks.length; i++) {
    await t.visit("work");
    await t.poll();
    await L.maybe(
      async () => {
        const st = await Promise.all(tks.map((x) => L.ticketOf(x.id)));
        return st.filter((x) => x.status === "in_testing").length >= i + 1 ? true : null;
      },
      "delivery",
      240000,
      2000,
    );
    await L.maybe(
      async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
      "tick done",
      60000,
      1000,
    );
  }
  for (const tk of tks) {
    const st = await L.ticketOf(tk.id);
    t.check(
      st.status === "in_testing",
      `with the tester lane on, delivered eligible #${tk.number} went to Testing before the human review`,
      `#${tk.number} after delivery is '${st.status}' (expected in_testing)`,
    );
  }
  // A person cannot approve a commit the tester has not passed (server-side hold).
  const shownHeads = ((await L.api("GET", `/tickets/${tks[0].id}/diff`)).json.repos || []).map(
    (r) => ({ repo: r.repoId, sha: r.headSha }),
  );
  const early = await L.api("POST", `/tickets/${tks[0].id}/review/approve`, {
    commits: shownHeads,
  });
  t.check(
    early.status === 409 && early.json?.error?.details?.reason === "not_tested",
    `an approval of #${tks[0].number} before the tester's verdict is refused (409)`,
    `early approve of #${tks[0].number}: ${early.status} ${JSON.stringify(early.json).slice(0, 200)}`,
  );

  // ── Poll runs the tester on each in_testing ticket ────────────────────────
  for (let i = 0; i < tks.length; i++) {
    await t.visit("work");
    const toast = await t.poll();
    if (i === 0)
      t.check(
        /tester|Testing/i.test(toast),
        `Poll with only Testing work runs the tester ("${toast.slice(0, 60)}")`,
        `Poll toast with tickets in Testing: "${toast}"`,
      );
    await L.maybe(
      async () =>
        L.stubCalls({ kind: "tester" }).filter((c) =>
          tks.some((x) => String(x.number) === c.ticket),
        ).length >=
        i + 1,
      "tester call",
      180000,
      1000,
    );
    await L.maybe(
      async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
      "tester tick done",
      180000,
      1000,
    );
  }
  const [pass, fail, held] = tks;
  const sp = await L.waitStatus(
    pass.id,
    ["in_review", "ready_for_merge", "refining", "in_testing", "done"],
    30000,
  );
  t.check(
    sp?.status === "in_review",
    `tester PASS → #${pass.number} is back in Review for the person`,
    `after a tester PASS #${pass.number} is '${sp?.status}'`,
  );
  await t.visit(`review/${pass.id}`, { label: "review/:id" });
  await L.maybe(
    async () => ((await p.textContent(".signoff-next").catch(() => "")) || "").trim() || null,
    "sign-off line",
    20000,
    500,
  );
  const line = (await p.textContent(".signoff-next").catch(() => "")) || "";
  const cand = (await p.textContent(".vd-cell.vd-candidate").catch(() => "")) || "";
  t.check(
    /You approve tested commit [0-9a-f]{12}/.test(line) && /Tested commit [0-9a-f]{12}/.test(cand),
    "the sign-off line and the candidate cell name the tested commit",
    `sign-off line: '${line.slice(0, 200)}' · candidate: '${cand.slice(0, 200)}'`,
  );
  const ap = await t.approve(pass);
  t.check(
    ap?.status === "ready_for_merge",
    `approving the tested commit of #${pass.number} in Review → Ready for merge (no second testing pass)`,
    `approve after the PASS: '${ap?.status}' ${ap?.held || ""}`,
  );
  await t.visit(`ticket/${pass.id}`);
  const rows = await p.locator(".tk-testing .tt-row.tt-pass").count();
  const rowTxt = (await p.textContent(".tk-testing").catch(() => "")) || "";
  t.check(
    rows >= 1 && /by agent|by system/.test(rowTxt),
    `the ticket page lists the tester's PASS under Tester results with its provenance (${rows} row)`,
    `Tester results on #${pass.number}: ${rows} pass rows, '${rowTxt.slice(0, 200)}'`,
  );

  const sf = await L.waitStatus(
    fail.id,
    ["refining", "ready", "ready_for_merge", "in_testing"],
    30000,
  );
  t.check(
    sf?.status === "refining",
    `tester FAIL → #${fail.number} back in Refining (supervised: a human triages)`,
    `after a tester FAIL #${fail.number} is '${sf?.status}'`,
  );
  await t.visit(`ticket/${fail.id}`);
  const failTxt = (await p.textContent(".view").catch(() => "")) || "";
  t.check(
    /keeps completed tasks/.test(failTxt),
    "the tester's observed failure is on the ticket page (it becomes the rework feedback)",
    `the ticket page does not show the tester's FAIL observation`,
  );

  const sh = await L.ticketOf(held.id);
  t.check(
    sh.status === "in_testing",
    `no verdict token → #${held.number} is HELD in Testing for a human`,
    `tester with no verdict left #${held.number} '${sh.status}'`,
  );
  await t.visit(`ticket/${held.id}`);
  await p.locator('button:has-text("Record tester PASS")').click();
  await p.locator(".reject-dialog .reject-submit").click({ force: true }); // aria-disabled until there is a summary
  await L.sleep(600);
  const stillOpen = await p.locator(".reject-dialog").count();
  t.check(
    stillOpen && (await L.ticketOf(held.id)).status === "in_testing",
    "Record tester PASS with an empty summary does nothing (the sheet stays open; a summary is required)",
    "an empty tester PASS summary was accepted",
  );
  await p
    .locator(".reject-dialog .reject-chip", {
      hasText: "Checked every acceptance criterion by hand",
    })
    .click();
  const resP = p.waitForResponse((r) => r.url().endsWith(`/tickets/${held.id}/tester`), {
    timeout: 10000,
  });
  await p.locator(".reject-dialog .reject-submit").click();
  const res = await resP.catch(() => null);
  const body = res ? JSON.parse(res.request().postData() || "{}") : {};
  const sh2 = await L.waitStatus(held.id, ["in_review"], 10000, 400);
  t.check(
    body.verdict === "pass" && /by hand/.test(body.summary || "") && sh2,
    `a human recorded the tester PASS for held #${held.number} → back in Review for the approval`,
    `human tester PASS: ${JSON.stringify(body)} status=${(await L.ticketOf(held.id)).status}`,
  );
}
