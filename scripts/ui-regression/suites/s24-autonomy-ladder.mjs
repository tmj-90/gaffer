/* global document, window */
// S24 the autonomy ladder and its step-down (backlog 58), OWN SERVER: it enables `auto`
// policy rows and lets the runner ship on its own, which must never reach another suite.
// Its env opts out of the OS sandbox for the stub reviewer and the merge gate (every agent
// here is a stub), so the agent-ships path s4 has to skip runs here:
//   1. climbing: Settings > Autonomy shows the ladder for the sample repo, every cell with
//      a word, critical with the ceiling;
//   2. automatic: low approve and merge enabled (REST, confirm), REVIEW_MODE=agent; a
//      low-risk ticket is delivered, the reviewer agent approves it and the runner lands it
//      on its own (done, approved by an agent); the ladder reads Automatic;
//   3. stepped down: a person links a regression of that change; the ladder shows the
//      step-down with its reason and the lift, the Overview names it, and the next
//      low-risk ticket the reviewer agent approves is HELD in review for a person.
// Each state is captured light and dark at 1440 and 390 wide (s24-<state>-<theme>-<w>).
export const server = {
  env: { GAFFER_STRICT_REQUIRE: "0", GAFFER_DOD_SANDBOX: "0" },
  fixtures: [],
};

export default async function s24(t, L) {
  const p = t.page;
  const idle = () =>
    L.maybe(
      async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
      "runs to finish",
      240000,
      1000,
    );
  const ladderCell = async (risk, gate) =>
    (
      (await p
        .locator(`.al-repo tr[data-risk="${risk}"] .al-cell`)
        .nth(gate === "approve" ? 0 : 1)
        .textContent()
        .catch(() => "")) || ""
    ).trim();
  const openLadder = async () => {
    await t.visit("settings");
    // A second visit to the same route keeps the rendered view: read the ladder afresh.
    await p.reload();
    await L.maybe(
      async () => ((await p.locator(".autonomy-ladder .al-cell").count()) >= 8 ? true : null),
      "the ladder to load",
      20000,
      300,
    );
    await p
      .locator("#autonomy-ladder")
      .scrollIntoViewIfNeeded()
      .catch(() => {});
  };
  // Light and dark at 1440 and 390, the ladder in view.
  const capture = async (state) => {
    const original = p.viewportSize();
    for (const theme of ["light", "dark"]) {
      await p.evaluate((th) => document.documentElement.setAttribute("data-theme", th), theme);
      for (const width of [1440, 390]) {
        await p.setViewportSize({ width, height: 1000 });
        await L.sleep(250);
        const box = p.locator("#autonomy-ladder");
        if (await box.count()) {
          await box
            .screenshot({ path: `${L.OUT}/s24-${state}-${theme}-${width}.png` })
            .catch(() => {});
        }
        if (width === 390) {
          const wide = await p.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 1,
          );
          t.check(
            !wide,
            `${state}, ${theme}, 390 wide: the ladder stacks with no sideways scroll`,
            `${state}, ${theme}, 390 wide: the page scrolls sideways`,
          );
        }
      }
    }
    await p.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    if (original) await p.setViewportSize(original);
  };

  // ── 1. climbing: every cell has a word, critical the ceiling ──────────────
  await openLadder();
  const cells = await p.locator(".autonomy-ladder .al-cell").count();
  const words = await p.locator(".autonomy-ladder .al-rung-word").allTextContents();
  t.check(
    cells >= 8 && words.length === cells && words.every((w) => w.trim().length > 0),
    `Settings > Autonomy shows the ladder: ${cells} cells, each with a rung word`,
    `the ladder: ${cells} cells, words ${JSON.stringify(words).slice(0, 200)}`,
  );
  t.check(
    /Not allowed: a person always decides critical changes/.test(
      await ladderCell("critical", "merge"),
    ),
    "critical shows the ceiling",
    `critical/merge reads '${(await ladderCell("critical", "merge")).slice(0, 160)}'`,
  );
  await L.auditA11y(p, "settings (ladder)", t);
  await capture("climbing");

  // ── 2. automatic: the runner ships an agent-approved low-risk ticket ──────
  for (const gate of ["approve", "merge"]) {
    const r = await L.api("POST", "/api/autonomy/policy", {
      repo_id: t.repo.id,
      risk_level: "low",
      gate,
      mode: "auto",
      confirm: true,
    });
    if (r.status >= 300)
      return t.bad(`enabling low/${gate}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  const crit = await L.api("POST", "/api/autonomy/policy", {
    repo_id: t.repo.id,
    risk_level: "critical",
    gate: "merge",
    mode: "auto",
    confirm: true,
  });
  t.check(
    crit.status === 422 &&
      /a person always decides critical changes/.test(JSON.stringify(crit.json)),
    "enabling critical/merge is refused with the ceiling's sentence",
    `enabling critical/merge answered ${crit.status} ${JSON.stringify(crit.json).slice(0, 200)}`,
  );
  await L.putSettings({ REVIEW_MODE: "agent" });
  const shipTo = async (tk, want) => {
    await t.visit("work");
    for (let i = 0; i < 6; i++) {
      const st = (await L.ticketOf(tk.id)).status;
      if (want.includes(st)) return st;
      await t.poll();
      await L.maybe(
        async () => ((await L.ticketOf(tk.id)).status !== st ? true : null),
        "a move",
        90000,
        1000,
      );
      await idle();
    }
    return (await L.ticketOf(tk.id)).status;
  };
  const a = await L.seedTicket(t, {
    title: `Ship on its own (${L.tag("s24")})`,
    acs: ["covered by a test"],
    ready: true,
    risk: "low",
  });
  const aSt = await shipTo(a, ["done"]);
  const aView = await L.ticketView(a.id);
  const approvedBy = (aView.events || [])
    .filter(
      (e) =>
        e.event_type === "ticket.transitioned" &&
        /"to":"(ready_for_merge|in_testing)"/.test(e.payload_json || ""),
    )
    .pop()?.actor_type;
  t.check(
    aSt === "done" && approvedBy === "agent",
    `#${a.number}: the reviewer agent approved it and the runner landed it on its own (done)`,
    `#${a.number} ended '${aSt}', approved by '${approvedBy}'`,
  );
  if (aSt !== "done") return;
  await openLadder();
  t.check(
    /Automatic/.test(await ladderCell("low", "merge")),
    "the ladder reads Automatic for low/merge",
    `low/merge reads '${(await ladderCell("low", "merge")).slice(0, 160)}'`,
  );
  await capture("automatic");

  // ── 3. stepped down: a person links a regression ──────────────────────────
  const d = await L.seedTicket(t, {
    title: `Export broke (${L.tag("s24")})`,
    acs: ["export works again"],
    risk: "low",
  });
  const link = await L.api("POST", `/tickets/${d.id}/regression-of`, {
    of: String(a.number),
    note: "the export crashes since this landed",
  });
  t.check(
    link.status < 300,
    `a person links #${d.number} as a regression of #${a.number}`,
    `the regression link answered ${link.status} ${JSON.stringify(link.json).slice(0, 200)}`,
  );
  await openLadder();
  const lowMerge = await ladderCell("low", "merge");
  t.check(
    /Stepped down/.test(lowMerge) &&
      new RegExp(`#${d.number} was linked by .* as a regression of #${a.number}`).test(lowMerge) &&
      /re-enables it once the evidence|override/i.test(lowMerge),
    "the ladder shows the step-down with its reason and what lifts it",
    `low/merge after the regression reads '${lowMerge.slice(0, 300)}'`,
  );
  t.check(
    /Stepped down/.test(await ladderCell("high", "merge")),
    "the merge step-down covers the higher risks too",
    `high/merge reads '${(await ladderCell("high", "merge")).slice(0, 160)}'`,
  );
  await L.auditA11y(p, "settings (stepped down)", t);
  await capture("stepped-down");
  await t.visit("overview");
  const line = await L.maybe(
    async () => {
      const txt = (await p.textContent(".al-overview").catch(() => "")) || "";
      return /Autonomy stepped down on/.test(txt) ? txt : null;
    },
    "the Overview line",
    15000,
    500,
  );
  t.check(
    !!line,
    "the Overview says autonomy stepped down, and why",
    "no step-down line on the Overview",
  );

  const b = await L.seedTicket(t, {
    title: `Held for a person (${L.tag("s24")})`,
    acs: ["covered by a test"],
    ready: true,
    risk: "low",
  });
  await shipTo(b, ["in_review"]);
  // One more pass: the reviewer agent judges it; the runner may no longer act on it.
  await t.visit("work");
  await t.poll();
  await idle();
  await t.poll();
  await idle();
  const bSt = (await L.ticketOf(b.id)).status;
  t.check(
    bSt === "in_review",
    `#${b.number}: after the step-down the runner holds it in review for a person`,
    `#${b.number} is '${bSt}' after the step-down`,
  );
}
