// S2 won't do, from the Ticket page and the Work board (Review's Won't do… is held
// while the Review view is being reworked). A draft and a delivered ticket are closed
// with a reason from their ticket pages, a queued (ready) one from its Work card's
// Move menu, both show in the Work board's Won't do area, Reopen works from the
// board and from the ticket page, the delivery branch survives the close, and an
// abandoned branch does not count against MAX_OPEN_AGENT_BRANCHES_PER_REPO.
export default async function s2(t, L) {
  const p = t.page;

  const wontDoFromTicket = async (tk, { chip, reason }) => {
    await t.visit(`ticket/${tk.id}`);
    await p.locator('.view button:has-text("Won\'t do")').first().click();
    await p.waitForSelector(".reject-dialog", { timeout: 10000 });
    if (chip) await p.locator(".reject-dialog .reject-chip", { hasText: chip }).click();
    else await p.locator(".reject-dialog .reject-reason-input").fill(reason);
    const resP = p.waitForResponse((r) => /\/wont-do$/.test(r.url()), { timeout: 15000 });
    await p.locator(".reject-dialog .reject-submit").click();
    const res = await resP.catch(() => null);
    const body = res ? JSON.parse(res.request().postData() || "{}") : {};
    const toast = await L.waitToast(p, /won't do/i, 8000);
    return { status: res && res.status(), body, toast };
  };

  // ── a draft, closed from its ticket page with a quick reason ───────────────
  const draft = await L.seedTicket(t, { title: `Won't-do draft (${L.tag("s2")})` });
  const r1 = await wontDoFromTicket(draft, { chip: "No longer needed" });
  t.check(
    r1.status < 300 && r1.body.reason === "No longer needed",
    "ticket page Won't do posted /wont-do with the chip's reason",
    `draft Won't do: ${r1.status} ${JSON.stringify(r1.body)}`,
  );
  t.check(
    r1.toast && (await L.ticketOf(draft.id)).status === "cancelled",
    `draft #${draft.number} closed as won't do (toast + status cancelled)`,
    `draft after Won't do: status=${(await L.ticketOf(draft.id)).status} toast=${r1.toast}`,
  );
  const reason = await L.maybe(
    async () =>
      ((await p.textContent(".tk-lede").catch(() => "")) || "").includes("No longer needed"),
    "lede reason",
    8000,
    300,
  );
  t.check(
    reason,
    "the closed ticket's page shows why it will not be built",
    "the ticket page does not show the won't-do reason",
  );

  // ── a queued ticket, closed from its Work card's Move menu ────────────────
  const queued = await L.seedTicket(t, {
    title: `Won't-do queued (${L.tag("s2")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  await t.visit("work");
  const qCard = p.locator(`.board-card[data-id="${queued.id}"]`);
  await qCard.locator(".card-move-btn").click();
  await p.locator('.movemenu .movemenu-item:has-text("Won\'t do")').click();
  await p.waitForSelector(".reject-dialog", { timeout: 10000 });
  await p.locator(".reject-dialog .reject-reason-input").fill("Folded into another ticket");
  const qResP = p.waitForResponse((r) => /\/wont-do$/.test(r.url()), { timeout: 15000 });
  await p.locator(".reject-dialog .reject-submit").click();
  const qRes = await qResP.catch(() => null);
  t.check(
    qRes &&
      qRes.status() < 300 &&
      JSON.parse(qRes.request().postData() || "{}").reason === "Folded into another ticket" &&
      (await L.waitStatus(queued.id, ["cancelled"], 10000, 400)),
    `Work card Move → Won't do… closed ready #${queued.number} with its reason`,
    `card Won't do: ${qRes && qRes.status()} status=${(await L.ticketOf(queued.id)).status}`,
  );

  // ── a delivered ticket, closed from its ticket page with a typed reason ────
  const del = await L.seedTicket(t, {
    title: `Won't-do delivered (${L.tag("s2")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  await t.visit("work");
  await t.poll();
  const inReview = await L.waitStatus(del.id, L.SETTLED, 240000);
  if (inReview?.status !== "in_review")
    t.bad(`delivery for #${del.number} ended in '${inReview?.status}'`);
  const r2 = await wontDoFromTicket(del, { reason: "Superseded by a smaller change" });
  t.check(
    r2.status < 300 && (await L.ticketOf(del.id)).status === "cancelled",
    `in_review #${del.number} closed as won't do from its ticket page`,
    `delivered Won't do: ${r2.status} status=${(await L.ticketOf(del.id)).status}`,
  );
  const branches = L.git(L.REPO_PATH, "branch", "--list", `gaffer/ticket-${del.number}-*`).trim();
  t.check(
    branches.length > 0,
    `the abandoned delivery branch is kept for the record (${branches.replace(/^[*+ ]+/, "")})`,
    `the delivery branch of #${del.number} is gone after won't do`,
  );

  // ── the Work board's Won't do area + Reopen from the board ────────────────
  await t.visit("work");
  const area = p.locator(".wont-do-area");
  const areaTxt = (await area.textContent().catch(() => "")) || "";
  t.check(
    areaTxt.includes(`#${draft.number}`) && areaTxt.includes(`#${del.number}`),
    `Work board's Won't do area lists both closed tickets (#${draft.number}, #${del.number})`,
    `Won't do area reads '${areaTxt.slice(0, 200)}'`,
  );
  await L.shot(p, "s2-wont-do-area");
  await area
    .locator(`li:has(.closed-num:text-is("#${draft.number}")) button:has-text("Reopen")`)
    .click();
  const reopened = await L.waitStatus(draft.id, ["refining"], 10000, 400);
  const tst = await L.waitToast(p, /Reopened to refining/, 5000);
  t.check(
    reopened && tst,
    `Work board Reopen brought #${draft.number} back to Refining (toast: "${tst}")`,
    `board Reopen: status=${(await L.ticketOf(draft.id)).status} toast=${tst}`,
  );
  await L.sleep(1500);
  const after = (await p.textContent(".wont-do-area").catch(() => "")) || "";
  t.check(
    !after.includes(`#${draft.number}`),
    "the board refreshed: the reopened ticket left the Won't do area",
    `the Won't do area still lists #${draft.number} after Reopen`,
  );

  // ── Reopen from the ticket page ───────────────────────────────────────────
  await t.visit(`ticket/${del.id}`);
  await p.locator('button:has-text("Reopen → refining")').click();
  t.check(
    await L.waitStatus(del.id, ["refining"], 10000, 400),
    `ticket page Reopen → refining brought #${del.number} back`,
    `ticket page reopen: status=${(await L.ticketOf(del.id)).status}`,
  );

  // ── an abandoned branch does not hold the open-branch cap ─────────────────
  await t.visit("settings");
  await t.setSetting("MAX_OPEN_AGENT_BRANCHES_PER_REPO", "1");
  const saved = await t.saveSettings();
  t.check(
    saved.status < 300 && saved.sent.MAX_OPEN_AGENT_BRANCHES_PER_REPO === "1",
    "Settings: MAX_OPEN_AGENT_BRANCHES_PER_REPO=1 saved",
    `cap save: ${saved.status} ${JSON.stringify(saved.sent)}`,
  );
  await L.api("POST", `/tickets/${del.id}/wont-do`, {
    reason: "abandoned again for the cap check",
  });
  const next = await L.seedTicket(t, {
    title: `After an abandoned branch (${L.tag("s2")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  await t.visit("work");
  await t.poll();
  const nx = await L.waitStatus(next.id, L.SETTLED, 240000);
  t.check(
    nx?.status === "in_review",
    `with the open-branch cap at 1 and only abandoned (won't-do) branches on the repo, ready #${next.number} was still claimed and delivered`,
    `with the cap at 1, #${next.number} ended '${nx?.status ?? (await L.ticketOf(next.id)).status}' — an abandoned branch counted against the cap`,
  );
}
