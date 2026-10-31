// S3 blocked / unblock, the Team Sheet's one-action rows, the human lane, revoking
// a live claim, and the command palette. A delivery that exhausts its rework budget
// parks to blocked and is unblocked from the Team Sheet (to Refining, then Ready); an
// approved-but-unmerged ticket is closed with "I merged it by hand"; a ready ticket is
// taken by hand and handed back from its Work card; a live agent claim is revoked with
// the two-press button; the palette finds a ticket by number.
export default async function s3(t, L) {
  const p = t.page;

  // ── a delivery that exhausts its attempts parks to blocked ────────────────
  await L.putSettings({ GAFFER_MAX_DELIVERY_ATTEMPTS: "1" }); // seed: one attempt only
  const stuck = await L.seedTicket(t, {
    title: `Rework-exhausted ticket (${L.tag("s3")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  L.setStubMode(stuck.number, "fail_always");
  await t.visit("work");
  await t.poll();
  const parked = await L.waitStatus(stuck.id, L.SETTLED, 240000);
  t.check(
    parked?.status === "blocked",
    `a delivery that failed its only attempt is parked: #${stuck.number} → blocked`,
    `the exhausted delivery ended '${parked?.status}'`,
  );
  await L.putSettings({ GAFFER_MAX_DELIVERY_ATTEMPTS: "" });
  await t.visit("work");
  const card =
    (await p.textContent(`.board-card:has(.num:text-is("#${stuck.number}"))`).catch(() => "")) ||
    "";
  t.check(
    /Rework exhausted/.test(card),
    `its Work card in the Blocked lane reads 'Rework exhausted' (${card.match(/Rework exhausted[^:]*/)?.[0] || "?"})`,
    `the blocked card reads '${card.slice(0, 160)}'`,
  );

  // ── Team Sheet: Unblock… → Refining, then Unblock… → Ready ────────────────
  const unblock = async (to) => {
    await t.visit("overview");
    const btn = p.locator(`#what-i-own button[aria-label="Unblock #${stuck.number}"]`);
    await btn.waitFor({ timeout: 15000 });
    await btn.click();
    await p.locator(`.sheet.open input[name="unblock-to"][value="${to}"]`).check();
    const resP = p.waitForResponse((r) => r.url().endsWith(`/tickets/${stuck.id}/move`), {
      timeout: 15000,
    });
    await p.locator('.sheet.open button:has-text("Unblock")').last().click();
    const res = await resP.catch(() => null);
    const toast = await L.waitToast(p, new RegExp(`Unblocked #${stuck.number}`), 8000);
    return { body: res ? JSON.parse(res.request().postData() || "{}") : {}, toast };
  };
  const u1 = await unblock("refining");
  t.check(
    u1.body.to === "refining" && u1.toast && (await L.ticketOf(stuck.id)).status === "refining",
    `Team Sheet Unblock… → Refining moved #${stuck.number} (POST /move {to: refining}; toast "${u1.toast}")`,
    `unblock to refining: body=${JSON.stringify(u1.body)} toast=${u1.toast} status=${(await L.ticketOf(stuck.id)).status}`,
  );
  const left = await L.maybe(
    async () =>
      !(await p.locator(`#what-i-own button[aria-label="Unblock #${stuck.number}"]`).count()),
    "row to leave",
    8000,
    400,
  );
  t.check(
    left,
    "the Blocked row left the Team Sheet after the unblock",
    `the Team Sheet still offers Unblock for #${stuck.number}`,
  );
  // Park it again (a second exhausted attempt) and unblock it to Ready this time.
  await L.putSettings({ GAFFER_MAX_DELIVERY_ATTEMPTS: "1" });
  await L.api("POST", `/tickets/${stuck.id}/ready`);
  L.setStubMode(stuck.number, "fail_always");
  await t.visit("work");
  await t.poll();
  await L.waitStatus(stuck.id, L.SETTLED, 240000);
  await L.putSettings({ GAFFER_MAX_DELIVERY_ATTEMPTS: "" });
  if ((await L.ticketOf(stuck.id)).status !== "blocked")
    t.note(
      `#${stuck.number} did not park a second time (${(await L.ticketOf(stuck.id)).status}); Unblock → Ready not exercised`,
    );
  else {
    L.setStubMode(stuck.number, "ok");
    const u2 = await unblock("ready");
    t.check(
      u2.body.to === "ready" && (await L.ticketOf(stuck.id)).status === "ready",
      `Team Sheet Unblock… → Ready re-queued #${stuck.number} for another go`,
      `unblock to ready: body=${JSON.stringify(u2.body)} status=${(await L.ticketOf(stuck.id)).status}`,
    );
  }

  // ── Team Sheet: Merge… → "I merged it by hand" on an approved ticket ──────
  const appr = await L.seedTicket(t, {
    title: `Approved, not merged (${L.tag("s3")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  await L.api("POST", `/tickets/${stuck.id}/move`, { to: "draft" }); // keep the queue to one
  await t.visit("work");
  await t.poll();
  const rv = await L.waitStatus(appr.id, L.SETTLED, 240000);
  if (rv?.status !== "in_review") t.bad(`approval seed: delivery ended '${rv?.status}'`);
  else {
    const a = await t.approve(appr);
    if (a?.status !== "ready_for_merge")
      t.bad(`approving #${appr.number} in Review left it '${a?.status}'`);
    await t.visit("overview");
    const mbtn = p.locator(`#what-i-own button[aria-label="Merge #${appr.number}"]`);
    const seen = await mbtn.waitFor({ timeout: 15000 }).then(
      () => true,
      () => false,
    );
    t.check(
      seen,
      `the Team Sheet lists #${appr.number} as 'Approved, not merged' with a Merge… action`,
      `no Merge… row for #${appr.number} on the Team Sheet`,
    );
    if (seen) {
      await mbtn.click();
      await p.locator('.sheet.open button:has-text("I merged it by hand")').click();
      const done = await L.waitStatus(appr.id, ["done"], 15000, 500);
      const tst = await L.waitToast(p, /marked merged/, 5000);
      t.check(
        done && tst,
        `"I merged it by hand" closed #${appr.number} as done (toast "${tst}")`,
        `mark-merged: status=${(await L.ticketOf(appr.id)).status} toast=${tst}`,
      );
    }
  }

  // ── human lane: I'll do this by hand → Hand back ─────────────────────────
  const hand = await L.seedTicket(t, {
    title: `By-hand ticket (${L.tag("s3")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  await t.visit("work");
  const cardSel = `.board-card:has(.num:text-is("#${hand.number}"))`;
  await p.locator(`${cardSel} button:has-text("I'll do this by hand")`).click();
  const mine = await L.maybe(
    async () => {
      const tk = await L.ticketOf(hand.id);
      return tk.status === "in_progress" && tk.human_owner ? tk : null;
    },
    "human claim",
    10000,
    400,
  );
  t.check(
    mine,
    `"I'll do this by hand" took #${hand.number} (in_progress, human_owner=${mine?.human_owner})`,
    `human claim: ${JSON.stringify(await L.ticketOf(hand.id)).slice(0, 200)}`,
  );
  const pollBy = await L.api("POST", "/poll-work");
  t.check(
    pollBy.json.polled === false || pollBy.json.readyCount === 0,
    "a by-hand ticket is out of the agents' queue (Poll finds no ready work)",
    `Poll after a human claim: ${JSON.stringify(pollBy.json).slice(0, 160)}`,
  );
  await t.visit("work");
  await p.locator(`${cardSel} button:has-text("Hand back")`).click();
  const back = await L.maybe(
    async () => {
      const tk = await L.ticketOf(hand.id);
      return tk.status === "ready" && !tk.human_owner ? tk : null;
    },
    "hand back",
    10000,
    400,
  );
  t.check(
    back,
    `"Hand back" returned #${hand.number} to the queue (ready, no human owner)`,
    `hand back: ${JSON.stringify(await L.ticketOf(hand.id)).slice(0, 200)}`,
  );

  // ── revoke a live claim (the stub takes its time) ────────────────────────
  L.setStubMode(hand.number, { mode: "slow_claim", secs: 40 });
  await t.visit("work");
  await t.poll();
  const live = await L.maybe(
    async () => (await p.locator(".claims-table button:has-text('Revoke')").count()) > 0,
    "a live claim row",
    60000,
    1000,
  );
  t.check(
    live,
    `the Work board lists the live claim on #${hand.number} with a Revoke button`,
    "no live claim row appeared on the Work board",
  );
  if (live) {
    const rb = p.locator(".claims-table .cl-act button").first();
    await rb.click();
    const armed = (await rb.textContent()) || "";
    t.check(
      /Stop the work\?/.test(armed),
      "Revoke takes two presses: the first arms it ('Stop the work?')",
      `first Revoke press left '${armed}'`,
    );
    const resP = p.waitForResponse((r) => /\/claims\/[^/]+\/revoke$/.test(r.url()), {
      timeout: 10000,
    });
    await rb.click();
    const res = await resP.catch(() => null);
    t.check(
      res && res.status() < 300,
      "the second press revoked the claim (POST /claims/:id/revoke)",
      `revoke: ${res && res.status()}`,
    );
    const freed = await L.waitStatus(hand.id, ["ready", "refining", "blocked"], 20000, 500);
    t.check(
      freed?.status === "ready",
      `the revoked ticket #${hand.number} is back in the queue (ready)`,
      `after revoke #${hand.number} is '${freed?.status ?? (await L.ticketOf(hand.id)).status}'`,
    );
    L.setStubMode(hand.number, null);
  }

  // ── the command palette finds a ticket by number ─────────────────────────
  await t.visit("overview");
  await p.locator(".cmdk-trigger").click();
  await p.locator(".palette-input").fill(`#${stuck.number}`);
  await L.sleep(800);
  await p.keyboard.press("Enter");
  const nav = await L.maybe(
    async () => (p.url().includes(`#/ticket/${stuck.id}`) ? true : null),
    "palette navigation",
    8000,
    300,
  );
  t.check(
    nav,
    `the command palette: '#${stuck.number}' + Enter opened the ticket page`,
    `palette Enter went to ${p.url()}`,
  );
}
