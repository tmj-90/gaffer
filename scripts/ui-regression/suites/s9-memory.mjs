// S9 the memory ledger. The repo page shows its digest (or its honest empty state)
// and the feature ledger by status; a Send back… from Review with "also capture as
// a lore draft" files the reason as draft lore (reject-to-lore), in one toast that
// links to Memory; the Memory view's search finds that draft, its History reads its
// versions, and the view rejects it with a reason; an Approve pressed on a draft that is no longer
// a draft (closed elsewhere while the page was open) is refused with a readable
// message, not an outage; a ticket that merges leaves a distilled requirement draft;
// the ticket page shows what the delivery prompt was primed with.
import { execFileSync } from "node:child_process";
import path from "node:path";

export default async function s9(t, L) {
  const p = t.page;
  const repo = t.repo.name;
  const memCli = (...args) =>
    execFileSync("node", [path.join(L.ROOT, "packages/memory/dist/bin/memory.js"), ...args], {
      env: { ...process.env, MEMORY_DB: path.join(L.GAFFER_DATA, "memory.sqlite") },
      encoding: "utf8",
      timeout: 60000,
    });
  const lore = async (status) =>
    (await L.api("GET", `/api/memory/lore?repo=${repo}&status=${status}`)).json.lore || [];

  // ── digest + feature ledger ───────────────────────────────────────────────
  const fname = `Clear completed tasks ${L.tag("s9")}`;
  memCli("feature", "add", repo, "--name", fname, "--summary", "drop done tasks from the list");
  await t.visit(`memory/${repo}`, { label: "memory/:repo" });
  const page = (await p.textContent(".view").catch(() => "")) || "";
  const fresh = await p.locator(".digest-fresh").count();
  t.check(
    fresh > 0 || /no digest|not onboarded|nothing yet|digest/i.test(page),
    `the repo's Memory page shows its digest freshness or an honest empty state (${fresh ? "digest" : "empty state"})`,
    `the repo Memory page has neither a digest nor a digest empty state`,
  );
  const backlog = p.locator('.ledger-lane[data-status="backlog"]');
  const blTxt = (await backlog.textContent().catch(() => "")) || "";
  t.check(
    blTxt.includes(fname),
    `the feature ledger lists the new feature under Backlog ("${fname}")`,
    `Backlog lane reads '${blTxt.slice(0, 160)}'`,
  );

  // ── reject-to-lore from Review ────────────────────────────────────────────
  const tk = await L.seedTicket(t, {
    title: `Memory ledger ticket (${L.tag("s9")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  await t.visit("work");
  await t.poll();
  const rv = await L.waitStatus(tk.id, L.SETTLED, 240000);
  if (rv?.status !== "in_review") t.bad(`memory ticket delivery ended '${rv?.status}'`);
  const REASON = `Prefer pure helpers over mutation in src/tasks.js (${L.tag("lesson")})`;
  await t.visit(`review/${tk.id}`, { label: "review/:id" });
  await p.locator('.signoff button:has-text("Send back…")').click();
  await p.locator(".reject-dialog .reject-reason-input").fill(REASON);
  const cb = p.locator(".reject-dialog .reject-capture-cb");
  const hasCb = (await cb.count()) > 0;
  if (hasCb) await cb.check();
  await L.clearToast(p);
  await p.locator(".reject-dialog .reject-submit").click();
  // One toast says both: sent back, and where the draft waits.
  const capToast = await L.waitToast(p, /sent back · reason filed as draft lore for/, 10000);
  const capLink = await p
    .locator("#toast a.toast-link")
    .getAttribute("href", { timeout: 3000 })
    .catch(() => null);
  await L.waitStatus(tk.id, ["refining"], 15000, 400);
  t.check(
    hasCb && capToast && capToast.includes(repo) && capLink === `#/memory/${repo}`,
    `one toast names the send back and the capture, linking to Memory: "${capToast}"`,
    `send back with capture toasted '${capToast ?? (await L.toasts(p).catch(() => ""))}' link=${capLink}`,
  );
  const drafted = await L.maybe(
    async () =>
      (await lore("draft")).find((l) =>
        `${l.title} ${l.summary || ""} ${l.body || ""}`.includes(REASON.slice(0, 40)),
      ) || null,
    "captured lore draft",
    20000,
    1000,
  );
  t.check(
    hasCb && drafted,
    "Send back… with 'also capture as a lore draft' filed the reason as draft lore for the repo",
    `reject-to-lore: checkbox=${hasCb} draft=${drafted ? drafted.id : "none"}`,
  );

  // ── reject that draft from the Memory view, with a reason ─────────────────
  if (drafted) {
    await t.visit(`memory/${repo}`, { label: "memory/:repo" });
    await p.selectOption("select.lore-filter-status", "draft");
    const row = p.locator(`.lore-row[data-lore-id="${drafted.id}"]`);
    await row.waitFor({ timeout: 15000 });
    // The search box narrows the rows in place; the row's History reads its versions.
    await p.fill(".lore-search-input", "pure helpers mutation");
    const found = await row.isVisible();
    const visibleRows = await p.locator(".lore-row:not([hidden])").count();
    await p.fill(".lore-search-input", "");
    await row.locator("details.lore-history > summary").click();
    const hist = await L.maybe(
      async () => {
        const txt =
          (await row
            .locator(".lore-history-body")
            .textContent()
            .catch(() => "")) || "";
        return /No earlier versions|v\d+ · current/.test(txt) ? txt : null;
      },
      "lore history",
      10000,
      300,
    );
    t.check(
      found && visibleRows >= 1 && hist,
      `Memory: the search box found the captured draft, and its History read the versions ("${(hist || "").slice(0, 60)}")`,
      `lore search/history: found=${found} rows shown=${visibleRows} history='${hist}'`,
    );
    await row.locator("details.lore-history > summary").click();
    await row.locator("button.lore-reject").click();
    await row.locator("input.lore-reason").fill("too specific to one review");
    const resP = p.waitForResponse(
      (r) => r.url().includes(`/api/memory/lore/${drafted.id}/reject`),
      { timeout: 15000 },
    );
    await row.locator("button.lore-reject-confirm").click();
    const res = await resP.catch(() => null);
    const sent = res ? JSON.parse(res.request().postData() || "{}") : {};
    const gone = await L.maybe(
      async () => !(await lore("draft")).some((l) => l.id === drafted.id),
      "draft rejected",
      15000,
      500,
    );
    t.check(
      res && res.status() < 300 && /too specific/.test(JSON.stringify(sent)) && gone,
      "Memory view Reject (with a reason) dropped the draft (POST …/reject carries the reason)",
      `lore reject: ${res && res.status()} body=${JSON.stringify(sent)} gone=${gone}`,
    );
  }

  // ── a stale Approve on a draft closed elsewhere is refused readably ───────
  const stale = memCli(
    "suggest",
    "--title",
    `Stale draft ${L.tag("s9")}`,
    "--summary",
    "closed elsewhere while the page is open",
    "--body",
    "seeded by S9",
    "--repo",
    repo,
    "--kind",
    "convention",
    "--json",
  );
  const staleId =
    (/"id"\s*:\s*"([^"]+)"/.exec(stale) || [])[1] ||
    (await lore("draft")).find((l) => /Stale draft/.test(l.title))?.id;
  await t.visit(`memory/${repo}`, { label: "memory/:repo" });
  await p.selectOption("select.lore-filter-status", "draft");
  const srow = p.locator(`.lore-row[data-lore-id="${staleId}"]`);
  if (
    !(await srow.waitFor({ timeout: 15000 }).then(
      () => true,
      () => false,
    ))
  )
    t.bad(`the seeded stale draft ${staleId} is not on the drafts page`);
  else {
    memCli("approve", staleId); // closed elsewhere (a terminal) while the page shows it as a draft
    await L.clearToast(p);
    const resP = p.waitForResponse((r) => r.url().includes(`/api/memory/lore/${staleId}/approve`), {
      timeout: 15000,
    });
    // A DOM click: the row may sit under the sticky header after the filter scroll.
    await srow.locator("button.lore-approve").evaluate((b) => b.click());
    const res = await resP.catch(() => null);
    const toast = (await L.waitToast(p, /./, 8000)) || "";
    t.check(
      res && res.status() === 409 && toast && !/503|unavailable|unexpected/i.test(toast),
      `Approve on a draft already approved elsewhere: 409 with a readable message ("${toast.slice(0, 90)}")`,
      `stale approve: status=${res && res.status()} toast='${toast}'`,
    );
  }

  // ── a merged ticket leaves a distilled requirement draft ──────────────────
  await t.visit(`ticket/${tk.id}`);
  await p.locator('button:has-text("Mark ready")').first().click();
  await L.waitStatus(tk.id, ["ready"], 10000, 400);
  await t.visit("work");
  await t.poll();
  if ((await L.waitStatus(tk.id, L.SETTLED, 240000))?.status === "in_review") {
    await t.approve(tk);
    await t.visit(`ticket/${tk.id}`);
    await p.locator('button:has-text("Merge now")').click();
    const done = await L.waitStatus(tk.id, ["done"], 120000, 2000);
    t.check(
      done,
      `#${tk.number} merged through Merge now`,
      `#${tk.number} did not merge (${(await L.ticketOf(tk.id)).status})`,
    );
    const req = await L.maybe(
      async () =>
        (await lore("draft")).find(
          (l) =>
            l.kind === "requirement" &&
            `${l.title} ${l.summary || ""} ${l.source || ""}`.includes(`#${tk.number}`),
        ) || null,
      "requirement draft",
      60000,
      2000,
    );
    t.check(
      req,
      `the merged ticket's intent was distilled into a requirement draft for the repo ("${req ? req.title.slice(0, 60) : ""}")`,
      `no requirement draft mentions #${tk.number} after its merge`,
    );
  } else t.bad(`memory ticket redelivery did not reach Review`);

  // ── the scouting report on the ticket page ────────────────────────────────
  await t.visit(`ticket/${tk.id}`);
  const tp = (await p.textContent(".view").catch(() => "")) || "";
  t.check(
    /scouting report/i.test(tp),
    "the ticket page has 'The scouting report' (what the delivery prompt was primed with)",
    "the ticket page has no scouting report section",
  );
}
