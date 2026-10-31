// S6 decisions asked and answered. The delivery agent (stub mode clarify) raises a
// human_required decision through the real dispatch MCP server and parks its ticket;
// the Team Sheet shows a Decision row; Answer… refuses an empty answer, then records
// the human's answer; once the ticket is back in the queue the next delivery's
// prompt quotes that answer and its get_ticket (the agent's first call over MCP)
// returns it. A second question is rejected from the Team Sheet. Then the
// intake clarify pass (CLARIFY_DRAFTS_WHEN_IDLE, saved in Settings) files criteria and
// a decision on a vague draft through the same MCP server, without wedging on a
// repo-less draft.
import { readFileSync } from "node:fs";
import path from "node:path";

export default async function s6(t, L) {
  const p = t.page;
  const ANSWER = "Keep insertion order; sorting is a separate ticket";

  // ── the agent asks ────────────────────────────────────────────────────────
  const tk = await L.seedTicket(t, {
    title: `Agent asks a question (${L.tag("s6")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  L.setStubMode(tk.number, "clarify");
  await t.visit("work");
  await t.poll();
  const parked = await L.waitStatus(tk.id, L.SETTLED, 180000);
  const view = await L.ticketView(tk.id);
  const blocking = view.blocking_decisions || view.blockingDecisions || [];
  t.check(
    parked?.status === "blocked" && blocking.length === 1,
    `the agent's request_decision (over MCP) parked #${tk.number} on one blocking decision`,
    `after the agent asked: status=${parked?.status}, blocking decisions=${blocking.length}`,
  );
  const dec = blocking[0];

  // ── the ticket page lists it; the Team Sheet offers Answer… ──────────────
  await t.visit(`ticket/${tk.id}`);
  const tpage = (await p.textContent(".view").catch(() => "")) || "";
  t.check(
    dec && tpage.includes(dec.title),
    "the ticket page lists the blocking decision by its title",
    `ticket page does not show the decision '${dec && dec.title}'`,
  );
  await t.visit("overview");
  const ans = p.locator(`#what-i-own button[aria-label^="Answer"]`).filter({ hasText: "Answer" });
  const rowSeen = await ans
    .first()
    .waitFor({ timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
  t.check(
    rowSeen,
    "the Team Sheet shows a Decision row with an Answer… action",
    "no Answer… row on the Team Sheet",
  );
  if (rowSeen && dec) {
    await p
      .locator(`#what-i-own button[aria-label^="Answer"][aria-label*="${dec.title.slice(0, 24)}"]`)
      .first()
      .click();
    await p.waitForSelector(".sheet.open textarea[name=answer]", { timeout: 8000 });
    await L.clearToast(p);
    await p.locator('.sheet.open button:has-text("Answer")').first().click();
    const empty = await L.waitToast(p, /Write an answer first/, 4000);
    t.check(
      empty && (await p.locator(".sheet.open").count()),
      "Answer with an empty box is refused ('Write an answer first.') and the sheet stays open",
      `empty answer: toast=${empty}`,
    );
    await p.fill(".sheet.open textarea[name=answer]", ANSWER);
    await p.fill('.sheet.open input[name="rationale"]', "the UI lists tasks as entered");
    const resP = p.waitForResponse((r) => /\/decisions\/[^/]+\/resolve$/.test(r.url()), {
      timeout: 10000,
    });
    await p.locator('.sheet.open button:has-text("Answer")').first().click();
    const res = await resP.catch(() => null);
    const body = res ? JSON.parse(res.request().postData() || "{}") : {};
    t.check(
      res &&
        res.status() < 300 &&
        body.status === "accepted" &&
        body.answer === ANSWER &&
        body.rationale,
      "Answer posted /decisions/:id/resolve {status: accepted, answer, rationale}",
      `resolve: ${res && res.status()} ${JSON.stringify(body)}`,
    );
    const d = (await L.api("GET", `/decisions/${dec.id}`)).json.decision;
    t.check(
      d && d.status === "accepted" && d.resolved_answer === ANSWER,
      "the decision is accepted with the human's answer (GET /decisions/:id)",
      `decision after answer: ${JSON.stringify(d).slice(0, 200)}`,
    );
    await L.sleep(1200);
    t.check(
      !(await p.locator(`#what-i-own button[aria-label*="${dec.title.slice(0, 24)}"]`).count()),
      "the answered Decision row left the Team Sheet",
      "the answered decision is still on the Team Sheet",
    );
  }

  // ── back in the queue, the next delivery prompt carries the answer ───────
  const tkNow = await L.ticketOf(tk.id);
  if (tkNow.status === "blocked") await L.api("POST", `/tickets/${tk.id}/move`, { to: "ready" }); // the human unblocks it (S3 drives that button)
  const claim = (await L.api("GET", `/tickets/${tk.id}/claimability`)).json;
  t.check(
    claim.ready === true || (claim.blockers || []).length === 0,
    `with the decision answered #${tk.number} is claimable again (no blockers)`,
    `claimability after the answer: ${JSON.stringify(claim).slice(0, 200)}`,
  );
  await t.visit("work");
  await t.poll();
  const redone = await L.waitStatus(tk.id, ["in_review", "blocked", "refining"], 240000);
  const prompt = L.stubCalls({ kind: "delivery", ticket: tk.number }).pop()?.prompt || "";
  t.check(
    redone?.status === "in_review",
    `the agent delivered #${tk.number} after the answer`,
    `redelivery after the answer ended '${redone?.status}'`,
  );
  let seen = "";
  try {
    seen = readFileSync(
      path.join(L.GAFFER_DATA, "stub-state", `delivery-${tk.number}.get_ticket.json`),
      "utf8",
    );
  } catch {
    /* no record */
  }
  t.check(
    seen.includes(ANSWER) && /resolved_decisions|resolvedDecisions/.test(seen),
    "the human's answer reached the agent on its next delivery: get_ticket (the agent's first call) returns it under resolved_decisions",
    `the redelivered agent's get_ticket did not carry the answer: '${seen.slice(0, 160)}'`,
  );
  // The prompt quotes it too (inside its untrusted envelope), so an agent that skips
  // get_ticket does not ask again.
  const answers = (prompt.match(
    /<untrusted-decision-answers>[\s\S]*?<\/untrusted-decision-answers>/,
  ) || [""])[0];
  t.check(
    /HUMAN ANSWERS/.test(prompt) && answers.includes(ANSWER),
    "the next delivery prompt quotes the human's answer inside its untrusted envelope",
    `the redelivery prompt does not quote the answer: '${answers || "(no decision-answers envelope)"}'`,
  );

  // ── reject a question from the Team Sheet ─────────────────────────────────
  const q = (
    await L.api("POST", "/decisions", {
      title: `Rename the list? (${L.tag("s6")})`,
      question: "Should the list be called a board?",
      severity: "human_required",
    })
  ).json.decision;
  await t.visit("overview");
  const qrow = p
    .locator(`#what-i-own button[aria-label^="Answer"][aria-label*="${q.title.slice(0, 16)}"]`)
    .first();
  if (
    await qrow.waitFor({ timeout: 15000 }).then(
      () => true,
      () => false,
    )
  ) {
    await qrow.click();
    await p.locator('.sheet.open button:has-text("Reject the question")').click();
    const rj = await L.maybe(
      async () =>
        (await L.api("GET", `/decisions/${q.id}`)).json.decision?.status === "rejected"
          ? true
          : null,
      "rejected",
      8000,
      400,
    );
    t.check(
      rj,
      "Reject the question resolved the decision as rejected",
      `decision after Reject: ${(await L.api("GET", `/decisions/${q.id}`)).json.decision?.status}`,
    );
  } else t.bad("a seeded human_required decision did not appear on the Team Sheet");

  // ── the intake clarify pass on idle ticks ─────────────────────────────────
  await t.visit("settings");
  await t.setSetting("CLARIFY_DRAFTS_WHEN_IDLE", "1");
  const sv = await t.saveSettings();
  t.check(
    sv.status < 300 && sv.sent.CLARIFY_DRAFTS_WHEN_IDLE === "1",
    "Settings: 'Clarify vague drafts when idle' switched on and saved",
    `clarify save: ${sv.status} ${JSON.stringify(sv.sent)}`,
  );
  const orphan = await L.seedTicket(t, { title: `Repo-less draft (${L.tag("s6")})`, repo: false });
  const vague = await L.seedTicket(t, {
    title: `Vague draft to clarify (${L.tag("s6")})`,
    description: "Make the list better.",
  });
  L.setStubMode(vague.number, "clarify");
  await t.visit("work");
  const ct = await t.poll();
  t.check(
    !/Nothing for a tick to do/.test(ct),
    `with clarify-when-idle on and drafts waiting, Poll runs a tick ("${ct.slice(0, 70)}")`,
    `Poll with clarify-when-idle on and two drafts: "${ct}"`,
  );
  const clarified = await L.maybe(
    async () => {
      const v = await L.ticketView(vague.id);
      return L.acsOf(v).length >= 1 && (v.blocking_decisions || []).length >= 1 ? v : null;
    },
    "clarify pass",
    180000,
    2000,
  );
  t.check(
    clarified,
    `the clarify pass filed a criterion and a blocking decision on draft #${vague.number} (past repo-less #${orphan.number})`,
    `draft #${vague.number} after the clarify poll: ACs=${L.acsOf(await L.ticketView(vague.id)).length}`,
  );
  t.check(
    (await L.ticketOf(vague.id)).status === "draft",
    "the clarify pass never marks a draft ready",
    `clarified draft is '${(await L.ticketOf(vague.id)).status}'`,
  );
}
