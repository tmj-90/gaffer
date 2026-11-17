/* global document, window */
// S25 post-merge findings and lessons (backlog 59), OWN SERVER (it lands on the sample
// repo's main and approves a lesson that later deliveries on src/tasks.js would read):
//   1. #A (names src/tasks.js) is delivered, approved by a person and landed (Merge now);
//   2. on #A's ticket page a person opens "Something was wrong with this?", writes what
//      went wrong (category Test gap) and records it: the finding is listed with who and
//      when, its paths taken from what the delivery touched;
//   3. "Propose as a lesson" files a lore draft tagged post-merge-finding for the repo;
//      the draft is in Memory, and a person approves it there;
//   4. #B (names src/tasks.js too) is delivered: the stub's recorded delivery prompt
//      carries "Lessons from earlier changes here" with the lesson inside
//      <untrusted-lessons>;
//   5. Health's "Lessons from findings" reads 1 live.
// Captured light and dark at 1440 and 390 wide: the ticket form, the finding on the
// ticket, the draft in Memory and the Health section (s25-<state>-<theme>-<w>).
export const server = { env: {}, fixtures: [] };

export default async function s25(t, L) {
  const p = t.page;
  const repo = t.repo.name;
  const idle = () =>
    L.maybe(
      async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
      "runs to finish",
      240000,
      1000,
    );
  const deliver = async (tk) => {
    await t.visit("work");
    for (let i = 0; i < 4; i++) {
      if ((await L.ticketOf(tk.id)).status !== "ready") break;
      await t.poll();
      await L.maybe(
        async () => ((await L.ticketOf(tk.id)).status !== "ready" ? true : null),
        "a claim",
        60000,
        1000,
      );
      await idle();
    }
    return (await L.ticketOf(tk.id)).status;
  };
  const lore = async (status) =>
    (await L.api("GET", `/api/memory/lore?repo=${repo}&status=${status}`)).json.lore || [];
  // Light and dark at 1440 and 390 of one part of the page, with the sideways-scroll check.
  const capture = async (state, selector) => {
    const original = p.viewportSize();
    for (const theme of ["light", "dark"]) {
      await p.evaluate((th) => document.documentElement.setAttribute("data-theme", th), theme);
      for (const width of [1440, 390]) {
        await p.setViewportSize({ width, height: 1000 });
        await L.sleep(250);
        const box = p.locator(selector).first();
        if (await box.count()) {
          await box.scrollIntoViewIfNeeded().catch(() => {});
          await box
            .screenshot({ path: `${L.OUT}/s25-${state}-${theme}-${width}.png` })
            .catch(() => {});
        }
        if (width === 390) {
          const wide = await p.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 1,
          );
          t.check(
            !wide,
            `${state}, ${theme}, 390 wide: no sideways scroll`,
            `${state}, ${theme}, 390 wide: the page scrolls sideways`,
          );
        }
      }
    }
    await p.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    if (original) await p.setViewportSize(original);
  };

  // ── 1. #A lands ───────────────────────────────────────────────────────────
  const a = await L.seedTicket(t, {
    title: `Lesson source (${L.tag("s25")})`,
    description: "Add a helper to src/tasks.js that drops completed tasks.",
    acs: ["covered by a test"],
    ready: true,
  });
  const aSt = await deliver(a);
  if (aSt !== "in_review") return t.bad(`#${a.number} did not reach review: '${aSt}'`);
  const aa = await t.approve(a);
  if (aa?.status !== "ready_for_merge")
    return t.bad(`approving #${a.number}: '${aa?.status ?? (await L.ticketOf(a.id)).status}'`);
  await t.visit(`ticket/${a.id}`, { label: "ticket/:id" });
  await p.locator('#app button:has-text("Merge now")').first().click();
  const landed = await L.waitStatus(a.id, ["done"], 120000, 1000);
  t.check(!!landed, `#${a.number} landed (done)`, `#${a.number} did not land`);
  if (!landed) return;

  // ── 2. a person writes the finding on the ticket page ─────────────────────
  await p.reload({ waitUntil: "load" });
  const open = p.locator(".fd-card button.fd-open");
  const offered = await L.maybe(
    async () => ((await open.count()) > 0 ? true : null),
    "the findings card",
    20000,
    300,
  );
  t.check(
    !!offered,
    `#${a.number}'s page offers "Something was wrong with this?"`,
    "no findings card on the done ticket",
  );
  if (!offered) return;
  await open.click();
  const text = `The empty task list was never tested and broke callers (${L.tag("s25")}).`;
  await p.fill(".fd-form textarea", text);
  await p.selectOption(".fd-form select", "test_gap");
  await L.auditA11y(p, "ticket (finding form)", t);
  await capture("ticket-form", ".fd-card");
  await p.locator('.fd-form button[type="submit"]').click();
  const item = await L.maybe(
    async () => {
      const txt = (await p.textContent(".fd-card .fd-item").catch(() => "")) || "";
      return txt.includes(text) ? txt : null;
    },
    "the finding on the page",
    20000,
    300,
  );
  t.check(
    !!item && /Test gap/.test(item) && /src\/tasks\.js/.test(item),
    "the finding is listed with its category and the paths the delivery touched",
    `the finding reads '${(item || "").slice(0, 200)}'`,
  );
  await capture("finding", ".fd-card");

  // ── 3. propose it as a lesson; a person approves it in Memory ─────────────
  await L.clearToast(p);
  await p.locator('.fd-card button:has-text("Propose as a lesson")').first().click();
  const toast = (await L.waitToast(p, /lesson/i, 15000)) || "";
  const draft = await L.maybe(
    async () => (await lore("draft")).find((l) => (l.title || "").includes(`#${a.number}`)) || null,
    "the lesson draft",
    20000,
    500,
  );
  t.check(
    !!draft && /waits for a person/.test(toast),
    `"Propose as a lesson" filed draft ${draft ? draft.id : "?"} and said it waits for a person`,
    `propose: toast='${toast}' draft=${draft ? draft.id : "none"}`,
  );
  if (!draft) return;
  await t.visit(`memory/${repo}`, { label: "memory/:repo" });
  const sel = p.locator("select.lore-filter-status");
  if ((await sel.inputValue().catch(() => "")) !== "draft") await sel.selectOption("draft");
  const row = p.locator(`.lore-row[data-lore-id="${draft.id}"]`);
  const shown = await row.waitFor({ timeout: 15000 }).then(
    () => true,
    () => false,
  );
  t.check(
    shown,
    "the lesson draft is in Memory, waiting for a person",
    "the lesson draft is not on the drafts page",
  );
  if (!shown) return;
  await L.clearToast(p);
  await capture("memory-draft", `.lore-row[data-lore-id="${draft.id}"]`);
  await row.locator("button.lore-approve").evaluate((b) => b.click());
  const live = await L.maybe(
    async () => ((await lore("active")).some((l) => l.id === draft.id) ? true : null),
    "the lesson approved",
    15000,
    500,
  );
  t.check(!!live, "a person approved the lesson in Memory", "the lesson did not become active");
  if (!live) return;

  // ── 4. #B on the same file: its delivery prompt carries the lesson ────────
  const b = await L.seedTicket(t, {
    title: `Same file later (${L.tag("s25")})`,
    description: "Add another helper to src/tasks.js.",
    acs: ["covered by a test"],
    ready: true,
  });
  const bSt = await deliver(b);
  t.check(
    bSt === "in_review",
    `#${b.number} delivered`,
    `#${b.number} is '${bSt}'\n${await L.whyStuck(b, t.lastPoll)}`,
  );
  const calls = L.stubCalls({ kind: "delivery", ticket: b.number });
  const prompt = calls.length ? String(calls[calls.length - 1].prompt || "") : "";
  const close = prompt.indexOf("</untrusted-lessons>");
  const inside =
    close > 0 ? prompt.slice(prompt.lastIndexOf("<untrusted-lessons>", close), close) : "";
  t.check(
    /Lessons from earlier changes here\./.test(prompt) &&
      inside.includes(text) &&
      inside.includes(`from #${a.number}, lesson ${draft.id}`),
    `#${b.number}'s recorded delivery prompt carries the lesson from #${a.number}, inside <untrusted-lessons>`,
    `#${b.number}'s prompt (${calls.length} delivery calls) has no lesson block: '${inside.slice(0, 200)}'`,
  );

  // ── 5. Health counts it ───────────────────────────────────────────────────
  await t.visit("health");
  const summary = await L.maybe(
    async () => {
      const txt = (await p.textContent(".fd-lessons .fd-summary").catch(() => "")) || "";
      return /^Lessons: 1 live/.test(txt) ? txt : null;
    },
    "the lessons section",
    20000,
    500,
  );
  t.check(
    !!summary,
    `Health's lessons section reads '${summary}'`,
    "Health's lessons section does not read 1 live",
  );
  await capture("health", ".fd-lessons");
}
