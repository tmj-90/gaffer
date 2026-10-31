// S7 plan a build + epics (canned GAFFER_DECOMPOSE_BIN, no model). From #/epics:
// Plan a build → Extend existing → taskflow-mini → brief → the planner's two
// questions → an answer → a dependency-ordered plan of three tickets plus the
// Final (Acceptance) card; a reload restores the conversation (durable plan
// session); Create as draft makes the epic (POST /epics with dependsOn, the target
// repo stamped); #/epics/:id draws it as rounds with the Final. A second plan forced
// with "Build the tickets now" is created and readied: the ticket that depends on
// another is not claimable until it lands, so Poll claims the first only. A
// greenfield plan (New app) leads with a bootstrap ticket.
import { readFileSync } from "node:fs";
import path from "node:path";

export default async function s7(t, L) {
  const p = t.page;
  const decCalls = () => {
    try {
      return readFileSync(path.join(L.GAFFER_DATA, "decompose-calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const openPanel = async () => {
    await t.visit("epics");
    await p.locator('.view button:has-text("Plan a build")').first().click();
    // The composer hides once a plan is on screen (a restored session), so wait for the panel.
    await p.waitForSelector('.pb-panel[aria-label="Plan a build"]', { timeout: 10000 });
  };
  const send = async (text) => {
    await p.fill('.pb-panel[aria-label="Plan a build"] .pb-input', text);
    await p.locator('.pb-panel[aria-label="Plan a build"] .pb-send').click();
  };
  const extendTo = async (repoName) => {
    await p
      .locator(
        '.pb-panel[aria-label="Plan a build"] .mode-option:has-text("Extend existing") input',
      )
      .check();
    const sel = p.locator('.pb-panel[aria-label="Plan a build"] .target-picker-select');
    await sel.waitFor({ timeout: 8000 });
    await sel.selectOption({ label: repoName });
  };
  const planShown = () =>
    L.maybe(
      async () =>
        (await p.locator('.pb-confirm-actions button:has-text("Create as draft")').count())
          ? true
          : null,
      "plan on screen",
      20000,
      400,
    );

  // ── brief → questions → answer → plan ─────────────────────────────────────
  await openPanel();
  await p
    .locator('.pb-panel[aria-label="Plan a build"] .pb-new-plan')
    .click()
    .catch(() => {});
  await extendTo(t.repo.name);
  const brief = `Archive completed tasks ${L.tag("s7")}`;
  await send(brief);
  const qs = await L.maybe(
    async () =>
      (
        (await p.textContent('.pb-panel[aria-label="Plan a build"] .pb-log').catch(() => "")) || ""
      ).includes("archived or deleted") || null,
    "planner questions",
    20000,
    400,
  );
  const first = decCalls().pop();
  t.check(
    qs && first && first.context && first.context.repo === t.repo.name,
    `the planner's clarifying questions are shown; POST /plan-build carried the extend target (context.repo=${first && first.context && first.context.repo})`,
    `plan turn 1: questions=${Boolean(qs)} context=${JSON.stringify(first && first.context)}`,
  );
  await send("Archive them; no sorting needed");
  const shown = await planShown();
  const planTxt =
    (await p.textContent('.pb-panel[aria-label="Plan a build"]').catch(() => "")) || "";
  t.check(
    shown &&
      /Add an archive helper/.test(planTxt) &&
      /Show archived tasks count/.test(planTxt) &&
      /Acceptance:/.test(planTxt),
    "the plan renders its three tickets and the Final (Acceptance) card",
    `plan render: shown=${Boolean(shown)} text='${planTxt.slice(0, 200)}'`,
  );
  await L.shot(p, "s7-plan");

  // ── a reload restores the session ─────────────────────────────────────────
  await p.reload({ waitUntil: "load" });
  await openPanel();
  const restored = await L.maybe(
    async () => {
      const txt =
        (await p.textContent('.pb-panel[aria-label="Plan a build"]').catch(() => "")) || "";
      return txt.includes(brief) && /Add an archive helper/.test(txt) ? true : null;
    },
    "restored session",
    15000,
    500,
  );
  const active = (await L.api("GET", "/plan-sessions/active")).json;
  t.check(
    restored && JSON.stringify(active).includes(brief),
    "after a reload the Plan a build panel restores the brief, the answers and the plan (GET /plan-sessions/active)",
    `restore: on screen=${Boolean(restored)} active session has brief=${JSON.stringify(active).includes(brief)}`,
  );

  // ── Create as draft → the epic ────────────────────────────────────────────
  const eP = p.waitForResponse(
    (r) => r.url().endsWith("/epics") && r.request().method() === "POST",
    { timeout: 15000 },
  );
  await p.locator('.pb-confirm-actions button:has-text("Create as draft")').click();
  const er = await eP.catch(() => null);
  const ebody = er ? JSON.parse(er.request().postData() || "{}") : {};
  const ejson = er ? await er.json().catch(() => ({})) : {};
  const tks = ebody.tickets || [];
  t.check(
    er &&
      er.status() < 300 &&
      tks.length === 3 &&
      JSON.stringify(tks[1].dependsOn) === "[0]" &&
      tks.every((x) => x.repo === t.repo.name),
    "Create as draft posted /epics: three tickets, the second dependsOn the first, each stamped with the target repo",
    `create epic: ${er && er.status()} body=${JSON.stringify(ebody).slice(0, 240)}`,
  );
  const epicId = ejson.epic_node_id || ejson.epic?.id || ejson.node?.id;
  const all = await L.listTickets();
  const mine = all.filter(
    (x) =>
      /archive helper|archived tasks count|Document the archive|Acceptance:/i.test(x.title) &&
      x.status === "draft",
  );
  mine.forEach((x) => t.created.add(x.id));
  t.check(
    mine.some((x) => /^Acceptance/.test(x.title)),
    `the epic's Acceptance ticket was added (${mine.length} draft tickets)`,
    `no Acceptance ticket among ${mine.map((x) => x.title).join(" | ")}`,
  );
  await p.keyboard.press("Escape").catch(() => {});
  if (epicId) {
    await t.visit(`epics/${epicId}`, { label: "epics/:id" });
    const ep = (await p.textContent(".view").catch(() => "")) || "";
    t.check(
      /Round 1/i.test(ep) && /Round 2/i.test(ep) && /Final/i.test(ep) && /Acceptance/.test(ep),
      "#/epics/:id draws the epic as rounds (dependency order) with the Final",
      `epic page reads '${ep.slice(0, 220)}'`,
    );
    await L.shot(p, "s7-epic");
  } else
    t.bad(
      `could not read the new epic's id from POST /epics (${JSON.stringify(ejson).slice(0, 160)})`,
    );

  // ── a forced plan, created and readied: the dependency gates claims ───────
  await openPanel();
  await p.locator('.pb-panel[aria-label="Plan a build"] .pb-new-plan').click();
  await extendTo(t.repo.name);
  await send(`Archive again ${L.tag("s7")}`);
  // Force is offered once a brief is in: after the planner's first questions.
  await L.maybe(
    async () =>
      (await p
        .locator('.pb-panel[aria-label="Plan a build"] .pb-force')
        .isEnabled()
        .catch(() => false)) || null,
    "force enabled",
    20000,
    300,
  );
  await p.locator('.pb-panel[aria-label="Plan a build"] .pb-force').click();
  const forced = await planShown();
  const fcall = decCalls().pop();
  t.check(
    forced && fcall && fcall.forcePlan === true,
    "'Build the tickets now' skipped the questions and planned straight away (forcePlan)",
    `force plan: shown=${Boolean(forced)} forcePlan=${fcall && fcall.forcePlan}`,
  );
  const before = new Set((await L.listTickets()).map((x) => x.id));
  await p.locator('.pb-confirm-actions button:has-text("Create & ready")').click();
  const made = await L.maybe(
    async () => {
      const now = (await L.listTickets()).filter((x) => !before.has(x.id));
      return now.length >= 4 ? now : null;
    },
    "readied epic",
    20000,
    500,
  );
  (made || []).forEach((x) => t.created.add(x.id));
  const t1 = made && made.find((x) => /archive helper/i.test(x.title));
  const t2 = made && made.find((x) => /archived tasks count/i.test(x.title));
  if (!t1 || !t2)
    t.bad(`Create & ready did not make the planned tickets (${made ? made.length : 0})`);
  else {
    await L.maybe(
      async () => ((await L.ticketOf(t1.id)).status === "ready" ? true : null),
      "t1 ready",
      10000,
      400,
    );
    const c2 = (await L.api("GET", `/tickets/${t2.id}/claimability`)).json;
    t.check(
      (await L.ticketOf(t1.id)).status === "ready" && c2.ready === false,
      `Create & ready readied the tickets; #${t2.number} is not claimable while #${t1.number} (its dependency) is open`,
      `after Create & ready: #${t1.number}=${(await L.ticketOf(t1.id)).status} #${t2.number} claimability=${JSON.stringify(c2).slice(0, 160)}`,
    );
    // Keep only the pair in the queue so the poll's choice is the gate's, not order.
    for (const x of made)
      if (x.id !== t1.id && x.id !== t2.id && ["ready"].includes((await L.ticketOf(x.id)).status))
        await L.api("POST", `/tickets/${x.id}/move`, { to: "draft" });
    await t.visit("work");
    await t.poll();
    await L.maybe(
      async () =>
        L.stubCalls({ kind: "delivery", ticket: t1.number }).length ||
        L.stubCalls({ kind: "delivery", ticket: t2.number }).length
          ? true
          : null,
      "a claim",
      120000,
      1000,
    );
    await L.maybe(
      async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
      "tick done",
      240000,
      2000,
    );
    t.check(
      L.stubCalls({ kind: "delivery", ticket: t1.number }).length === 1 &&
        L.stubCalls({ kind: "delivery", ticket: t2.number }).length === 0,
      `Poll claimed #${t1.number} and left dependent #${t2.number} waiting`,
      `poll claims: #${t1.number}=${L.stubCalls({ kind: "delivery", ticket: t1.number }).length} #${t2.number}=${L.stubCalls({ kind: "delivery", ticket: t2.number }).length}`,
    );
  }

  // ── a greenfield plan leads with a bootstrap ticket ───────────────────────
  await openPanel();
  await p.locator('.pb-panel[aria-label="Plan a build"] .pb-new-plan').click();
  await p
    .locator('.pb-panel[aria-label="Plan a build"] .mode-option:has-text("New app") input')
    .check();
  await send(`A greenfield task app ${L.tag("s7")}`);
  // Force is offered once a brief is in: after the planner's first questions.
  await L.maybe(
    async () =>
      (await p
        .locator('.pb-panel[aria-label="Plan a build"] .pb-force')
        .isEnabled()
        .catch(() => false)) || null,
    "force enabled",
    20000,
    300,
  );
  await p.locator('.pb-panel[aria-label="Plan a build"] .pb-force').click();
  const gshown = await planShown();
  const gtxt = (await p.textContent('.pb-panel[aria-label="Plan a build"]').catch(() => "")) || "";
  t.check(
    gshown && /Bootstrap the task app/.test(gtxt),
    "a New app (greenfield) plan leads with its bootstrap ticket",
    `greenfield plan: shown=${Boolean(gshown)} '${gtxt.slice(0, 160)}'`,
  );
  t.skip(
    "greenfield delivery (the bootstrap scaffolding a new repo under GAFFER_REPOS_DIR) needs its own server; only the plan shape is asserted here",
  );
  await p.keyboard.press("Escape").catch(() => {});
}
