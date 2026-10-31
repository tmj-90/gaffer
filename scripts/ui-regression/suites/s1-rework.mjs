// S1 rework loop. A delivery whose first attempt breaks a test is reworked inside the
// same tick with the REAL failure fed back to the agent; the ticket page shows the
// attempt trail; a human Send back… from Review (chip reason) resets the criteria; an
// agent reviewer's CHANGES verdict (REVIEW_MODE=agent saved through Settings) sends
// it back to the queue with the reviewer's words, and the redelivery prompt carries
// them; Dispatch's own reject cap (DISPATCH_MAX_ATTEMPTS, saved through Settings)
// parks a rejected delivery for a human.
export default async function s1(t, L) {
  const p = t.page;

  // ── a ticket whose first attempt fails the DoD tests gate ──────────────────
  const tk = await L.seedTicket(t, {
    title: `Rework loop ticket (${L.tag("s1")})`,
    acs: [{ text: "the helper is covered by a passing test", check_command: "npm test" }],
    ready: true,
  });
  L.setStubMode(tk.number, { mode: "fail_first", secs: 12 });
  await t.visit("work");
  const toast = await t.poll();
  t.check(
    /tick fired/i.test(toast),
    `Poll for work fired a tick for ready #${tk.number} ("${toast.slice(0, 60)}")`,
    `Poll for work toast unexpected: "${toast}"`,
  );

  // While attempt 2 runs (the stub sleeps on rework calls), the card says so.
  const reworking = await L.maybe(
    async () => {
      const txt = await p
        .textContent(`.board-card:has(.num:text-is("#${tk.number}"))`)
        .catch(() => "");
      return /Reworking · attempt 2\/\d/.test(txt || "") ? txt : null;
    },
    "Reworking card",
    90000,
    500,
  );
  t.check(
    reworking,
    `Work card reads 'Reworking · attempt 2/N' while the runner re-invokes the agent on #${tk.number}`,
    `Work card never showed 'Reworking · attempt 2/N' for #${tk.number}`,
  );
  await L.shot(p, "s1-reworking-card");

  const delivered = await L.waitStatus(tk.id, L.SETTLED, 240000);
  t.check(
    delivered?.status === "in_review",
    `the reworked delivery passed its gates on attempt 2 and landed in Review (#${tk.number} → in_review)`,
    `the reworked delivery ended in '${delivered?.status}' instead of in_review`,
  );
  const calls = L.stubCalls({ kind: "delivery", ticket: tk.number });
  t.check(
    calls.length === 2,
    `the runner invoked the agent exactly twice for #${tk.number} (attempt 1 failed, attempt 2 fixed it)`,
    `the agent was invoked ${calls.length} time(s) for #${tk.number}, expected 2`,
  );
  t.check(
    calls[1] && calls[1].prompt.includes(`stubFailFirst${tk.number}`),
    `attempt 2's prompt names the real failing test (stubFailFirst${tk.number}) — the failure was fed back, not a generic retry`,
    `attempt 2's prompt does not name the failing test stubFailFirst${tk.number}`,
  );

  // ── the ticket page: attempt trail + the runner-verified criterion ─────────
  await t.visit(`ticket/${tk.id}`);
  const attempts = await p.locator(".failure-history .failure-attempt").count();
  const histTxt = (await p.textContent(".failure-history").catch(() => "")) || "";
  t.check(
    attempts >= 1 && /test/i.test(histTxt),
    `ticket page lists the failed attempt in its Attempts / Failure history (${attempts} row(s), names the tests gate)`,
    `ticket page failure history: ${attempts} rows, text '${histTxt.slice(0, 160)}'`,
  );
  t.check(
    new RegExp(`stubFailFirst${tk.number}`).test(histTxt) &&
      /Expected values to be strictly equal/.test(histTxt),
    "the failure history quotes the failing test's name and its assertion as the runner captured them",
    `the failure history does not quote stubFailFirst${tk.number}: '${histTxt.slice(0, 200)}'`,
  );
  // The captured stack names the repo's files, not the runner's worktree dir.
  const histShown = await p
    .locator(".failure-history")
    .innerText()
    .catch(() => "");
  t.check(
    !/\/worktrees\//.test(histShown),
    "the failure history shows paths relative to the repo root (no worktree prefix)",
    `the failure history still carries a worktree path: '${(histShown.match(/\S*\/worktrees\/\S*/) || [""])[0]}'`,
  );
  const trail = (await L.api("GET", `/tickets/${tk.id}/rework-trail`)).json;
  const rows = trail.trail || trail.attempts || trail.rework_trail || [];
  t.check(
    Array.isArray(rows) && rows.length === attempts,
    `the page's attempt rows match GET /tickets/:id/rework-trail (${rows.length})`,
    `rework-trail has ${Array.isArray(rows) ? rows.length : "?"} rows, page shows ${attempts}`,
  );
  await L.shot(p, "s1-failure-history");

  // ── Review: Send back… with a quick-reason chip ────────────────────────────
  await t.visit(`review/${tk.id}`, { label: "review/:id" });
  await p.locator('button:has-text("Send back…")').first().click();
  await p.locator(".reject-dialog .reject-chip", { hasText: "Tests missing or failing" }).click();
  const rejP = p.waitForResponse((r) => /\/review\/reject$/.test(r.url()), { timeout: 15000 });
  await p.locator(".reject-dialog .reject-submit").click();
  const rej = await rejP.catch(() => null);
  const sent = rej ? JSON.parse(rej.request().postData() || "{}") : {};
  t.check(
    rej &&
      rej.status() < 300 &&
      sent.reason === "Tests missing or failing" &&
      sent.to === "refining",
    "Send back… posted review/reject {to: refining, reason: the chip's words}",
    `Send back… request: status=${rej && rej.status()} body=${JSON.stringify(sent)}`,
  );
  const back = await L.waitStatus(tk.id, ["refining"], 15000, 500);
  const acsAfter = L.acsOf(await L.ticketView(tk.id));
  t.check(
    back && acsAfter.length && acsAfter.every((a) => a.status !== "satisfied"),
    `#${tk.number} is in Refining and its criteria reset to not met after the send back`,
    `after send back: status=${back?.status} ACs=${JSON.stringify(acsAfter.map((a) => a.status))}`,
  );

  // ── an agent reviewer's CHANGES verdict under REVIEW_MODE=agent (saved through
  //    Settings). Supervised: the verdict is advisory, the ticket waits for a human ──
  await t.visit("settings");
  await t.setSetting("REVIEW_MODE", "agent");
  const saved = await t.saveSettings();
  t.check(
    saved.status < 300 &&
      saved.sent.REVIEW_MODE === "agent" &&
      Object.keys(saved.sent).length === 1,
    "Settings: Save changes posted only the changed key (REVIEW_MODE=agent)",
    `Settings save: ${saved.status} ${JSON.stringify(saved.sent)}`,
  );
  const sm = await L.settingsMap();
  t.check(
    sm.get("REVIEW_MODE")?.effective === "agent" && sm.get("REVIEW_MODE")?.source === "file",
    "GET /api/settings reports REVIEW_MODE effective=agent from settings.json",
    `after save: ${JSON.stringify(sm.get("REVIEW_MODE"))}`,
  );

  L.setStubMode(tk.number, "changes_verdict");
  await t.visit(`ticket/${tk.id}`);
  await p.locator('button:has-text("Mark ready")').first().click();
  t.check(
    await L.waitStatus(tk.id, ["ready"], 15000, 500),
    `ticket page Mark ready re-queued #${tk.number}`,
    `Mark ready did not re-queue #${tk.number}`,
  );
  await t.visit("work");
  await t.poll();
  const redelivered = await L.waitStatus(tk.id, L.SETTLED, 240000);
  t.check(
    redelivered?.status === "in_review",
    `the re-queued ticket was delivered again (#${tk.number} → in_review)`,
    `redelivery ended in '${redelivered?.status}'`,
  );
  await L.maybe(
    async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
    "tick done",
    60000,
    1000,
  );
  const toastR = await t.poll();
  t.check(
    /review/i.test(toastR),
    `with REVIEW_MODE=agent a Poll on an in_review ticket runs the reviewer agent ("${toastR.slice(0, 70)}")`,
    `Poll toast with a ticket in Review under REVIEW_MODE=agent: "${toastR}"`,
  );
  const rv = await L.maybe(
    async () => {
      const c = L.stubCalls({ kind: "reviewer", ticket: tk.number });
      return c.length ? c : null;
    },
    "reviewer call",
    120000,
    1000,
  );
  t.check(
    rv && rv[0].mode === "changes_verdict",
    "the reviewer agent ran and answered CHANGES (stub record)",
    `reviewer calls for #${tk.number}: ${rv ? rv.length : 0}`,
  );
  await L.maybe(
    async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
    "review tick done",
    120000,
    1000,
  );
  const advisory = await L.ticketOf(tk.id);
  t.check(
    advisory.status === "in_review",
    `supervised: the reviewer's CHANGES is advisory — #${tk.number} stays in Review for a human`,
    `after an advisory CHANGES #${tk.number} is '${advisory.status}'`,
  );
  const ev = ((await L.ticketView(tk.id)).evidence || []).filter((e) =>
    /docstring/.test(e.summary || ""),
  );
  t.check(
    ev.length >= 1,
    "the reviewer agent's CHANGES reasoning is recorded on the ticket as evidence (through its MCP record_ac_evidence)",
    "no reviewer evidence mentions the docstring",
  );
  // The ticket page keeps the reviewer's rows in its Evidence card.
  await t.visit(`ticket/${tk.id}`);
  await p
    .locator("details.tk-evidence > summary")
    .click()
    .catch(() => {});
  const evTxt = (await p.textContent("details.tk-evidence").catch(() => "")) || "";
  t.check(
    /docstring/.test(evTxt) && /Reported by agents|Recorded by the runner/.test(evTxt),
    "the ticket page's Evidence card lists the reviewer's rows by who recorded them",
    `the ticket page's Evidence card reads '${evTxt.slice(0, 160)}'`,
  );
  t.skip(
    "where Review shows the reviewer agent's advisory verdict (its evidence rows) is HELD until the review-packet change lands",
  );

  // ── agent approval needs containment: with DISPATCH_ALLOW_AGENT_APPROVE on and
  //    no OS sandbox, the runner refuses to launch an agent and says so ──
  await t.visit("settings");
  await t.setSetting("DISPATCH_ALLOW_AGENT_APPROVE", "1");
  const savedA = await t.saveSettings();
  t.check(
    savedA.status < 300 && savedA.sent.DISPATCH_ALLOW_AGENT_APPROVE === "1",
    "Settings: 'Agents may approve reviews' switched on and saved",
    `agent-approve save: ${savedA.status} ${JSON.stringify(savedA.sent)}`,
  );
  const contained = await L.seedTicket(t, {
    title: `Containment check (${L.tag("s1")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  await t.visit("work");
  await t.poll();
  const refused = await L.waitStatus(contained.id, L.SETTLED, 120000);
  await t.visit("work");
  const cardC =
    (await p
      .textContent(`.board-card:has(.num:text-is("#${contained.number}"))`)
      .catch(() => "")) || "";
  t.check(
    refused?.status === "blocked" &&
      /sandbox/i.test(cardC) &&
      L.stubCalls({ kind: "delivery", ticket: contained.number }).length === 0,
    `with agent approval on and no OS sandbox the runner fails closed: #${contained.number} parked, no agent launched, and its Work card names the missing sandbox`,
    `containment: status=${refused?.status} agent calls=${L.stubCalls({ kind: "delivery", ticket: contained.number }).length} card='${cardC.slice(0, 160)}'`,
  );
  t.skip(
    "CHANGES → rework with the reviewer's feedback (the AFK loop) needs a contained runner (sandbox or GAFFER_STRICT_REQUIRE=0 out of band); this shared server keeps the containment gate on — see suites/s4-autonomy.mjs",
  );

  // ── Dispatch's reject cap, lowered from Settings ──────────────────────────
  await t.visit("settings");
  await t.setSetting("REVIEW_MODE", "human");
  await t.setSetting("DISPATCH_ALLOW_AGENT_APPROVE", "0");
  await t.setSetting("DISPATCH_MAX_ATTEMPTS", "1");
  const saved2 = await t.saveSettings();
  t.check(
    saved2.status < 300 && saved2.sent.DISPATCH_MAX_ATTEMPTS === "1",
    "Settings: DISPATCH_MAX_ATTEMPTS=1 saved from the Budget group",
    `save of DISPATCH_MAX_ATTEMPTS: ${saved2.status} ${JSON.stringify(saved2.sent)}`,
  );
  const capped = await L.seedTicket(t, {
    title: `Reject cap ticket (${L.tag("s1")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  await t.visit("work");
  await t.poll();
  const capDelivered = await L.waitStatus(capped.id, L.SETTLED, 240000);
  if (capDelivered?.status !== "in_review")
    t.bad(`reject-cap ticket delivery ended in '${capDelivered?.status}'`);
  else {
    await t.visit(`review/${capped.id}`, { label: "review/:id" });
    await p.locator('button:has-text("Send back…")').first().click();
    await p
      .locator(".reject-dialog .reject-reason-input")
      .fill("first rejection under a cap of one");
    await p.locator(".reject-dialog .reject-submit").click();
    const parked = await L.waitStatus(capped.id, ["blocked", "refining"], 15000, 500);
    t.check(
      parked?.status === "blocked",
      `with DISPATCH_MAX_ATTEMPTS=1 saved in Settings, the first send back parks #${capped.number} for a human (blocked) — the server honours the saved cap without a restart`,
      `with DISPATCH_MAX_ATTEMPTS=1 saved in Settings, the first send back moved #${capped.number} to '${parked?.status}' instead of parking it`,
    );
  }
}
