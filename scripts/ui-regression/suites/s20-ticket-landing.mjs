// S20 the ticket page around a landing — OWN SERVER (it lands on the sample repo's main
// and moves a delivery branch by hand). Exploratory findings ui-workflows/F4 and F6:
//   1. #A approved; its ticket page is open in two tabs; Merge now in tab A lands it.
//      Both tabs turn to Done and drop Merge now / Mark merged without a reload (the
//      ticket page follows the live stream like the board and Review).
//   2. #B approved, then its delivery branch is moved by hand (a commit nobody
//      reviewed). Its page reads "Held · moved since review", Your move matches the
//      hold (never "the merge runner has it") and offers Back to review; Merge now
//      toasts that it is held, not "Merge started"; Back to review (with a reason)
//      takes it back to In review through POST /tickets/:id/reopen-for-review.
export const server = { env: {}, fixtures: [] };

export default async function s20(t, L) {
  const p = t.page;
  const idle = () =>
    L.maybe(
      async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
      "runs to finish",
      240000,
      1000,
    );
  const seed = async (title) =>
    L.seedTicket(t, {
      title: `${title} (${L.tag("s20")})`,
      acs: ["covered by a test"],
      ready: true,
    });
  const a = await seed("Live landing A");
  const b = await seed("Held landing B");
  await t.visit("work");
  for (let i = 0; i < 4; i++) {
    const open = [];
    for (const x of [a, b]) if ((await L.ticketOf(x.id)).status === "ready") open.push(x);
    if (!open.length) break;
    await t.poll();
    await L.maybe(
      async () => ((await L.ticketOf(open[0].id)).status !== "ready" ? true : null),
      "a claim",
      60000,
      1000,
    );
    await idle();
  }
  const sts = await Promise.all([a, b].map(async (x) => (await L.ticketOf(x.id)).status));
  t.check(
    sts.every((s) => s === "in_review"),
    `#${a.number} and #${b.number} delivered and wait in review`,
    `deliveries: ${sts.join(", ")}`,
  );
  if (!sts.every((s) => s === "in_review")) return;

  // ── 1. two tabs on #A's page; Merge now in one ────────────────────────────
  const aa = await t.approve(a);
  if (aa?.status !== "ready_for_merge")
    return t.bad(`approving #${a.number}: '${aa?.status ?? (await L.ticketOf(a.id)).status}'`);
  await t.visit(`ticket/${a.id}`, { label: "ticket/:id" });
  const tabB = await L.openPage(t.browser, { route: `ticket/${a.id}` });
  const offered = async (pg) => (await pg.locator('#app button:has-text("Merge now")').count()) > 0;
  t.check(
    (await offered(p)) && (await offered(tabB)),
    `both tabs of #${a.number}'s page offer Merge now while it waits`,
    "a tab of the approved ticket's page offers no Merge now",
  );
  await p.locator('#app button:has-text("Merge now")').first().click();
  const landed = await L.waitStatus(a.id, ["done"], 120000, 1000);
  t.check(!!landed, `Merge now landed #${a.number}`, `#${a.number} did not land`);
  const doneIn = async (pg) =>
    L.maybe(
      async () => ((await pg.locator(".tk-ft").count()) > 0 && !(await offered(pg)) ? true : null),
      "the ticket page to turn to Done",
      15000,
      500,
    );
  const [doneA, doneB] = await Promise.all([doneIn(p), doneIn(tabB)]);
  t.check(
    doneA && doneB,
    `both open tabs of #${a.number} turned to Done and dropped Merge now, without a reload`,
    `after the landing: tab A done=${!!doneA}, tab B done=${!!doneB}`,
  );
  await L.shot(tabB, "s20-tab-b-done");
  await tabB
    .context()
    .close()
    .catch(() => {});

  // ── 2. #B approved, then its branch moved by hand ─────────────────────────
  const ba = await t.approve(b);
  if (ba?.status !== "ready_for_merge")
    return t.bad(`approving #${b.number}: '${ba?.status ?? (await L.ticketOf(b.id)).status}'`);
  const branch = (await L.ticketOf(b.id)).branch_name;
  const tip = L.git(L.REPO_PATH, "rev-parse", `refs/heads/${branch}`).trim();
  const moved = L.git(
    L.REPO_PATH,
    "-c",
    "user.name=ui",
    "-c",
    "user.email=ui@x",
    "commit-tree",
    `${tip}^{tree}`,
    "-p",
    tip,
    "-m",
    "late commit nobody reviewed (s20)",
  ).trim();
  L.git(L.REPO_PATH, "update-ref", `refs/heads/${branch}`, moved, tip);
  await t.visit(`ticket/${b.id}`, { label: "ticket/:id" });
  const head = (await p.textContent(".tk-head").catch(() => "")) || "";
  const move = (await p.textContent(".tk-move .tk-move-t").catch(() => "")) || "";
  t.check(
    /Held · moved since review/.test(head),
    `#${b.number}'s status reads 'Held · moved since review'`,
    `#${b.number}'s head reads '${head.slice(0, 160)}'`,
  );
  t.check(
    !/merge runner has it/i.test(move) && /Back to review/.test(move),
    "Your move matches the hold and names Back to review",
    `Your move reads '${move.slice(0, 200)}'`,
  );
  await L.clearToast(p);
  await p.locator('#app button:has-text("Merge now")').first().click();
  const toast = await L.waitToast(p, /./, 10000);
  t.check(
    /held/i.test(toast || "") && !/Merge started/.test(toast || ""),
    `Merge now on held #${b.number} says it is held ('${(toast || "").slice(0, 90)}…')`,
    `Merge now on held #${b.number} toasted '${toast}'`,
  );
  await idle();
  await t.visit(`ticket/${b.id}`, { label: "ticket/:id" });
  await p.locator('#app button:has-text("Back to review")').first().click();
  await p.waitForSelector(".reject-dialog", { timeout: 10000 });
  await p.locator(".reject-dialog .reject-reason-input").fill("The branch moved since review");
  const resP = p.waitForResponse((r) => /\/reopen-for-review$/.test(r.url()), { timeout: 15000 });
  await p.locator(".reject-dialog .reject-submit").click();
  const res = await resP.catch(() => null);
  const back = await L.waitStatus(b.id, ["in_review"], 15000, 500);
  t.check(
    res && res.status() < 300 && !!back,
    `Back to review took #${b.number} back to In review (POST reopen-for-review ${res && res.status()})`,
    `Back to review: ${res && res.status()} status=${(await L.ticketOf(b.id)).status}`,
  );
  await L.shot(p, "s20-back-to-review");
}
