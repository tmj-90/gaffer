// S8 specs (canned GAFFER_SPEC_AUTHOR_BIN + GAFFER_DECOMPOSE_BIN, no model). #/specs
// Author a spec → brief → the author's question → "Draft the spec" → three draft
// clauses; the target repo is picked and Create spec POSTs /specs; Freeze spec locks
// it and seeds the clauses as draft lore; "Build the tickets from this spec" hands
// the frozen clauses to the planner, whose plan threads each requirement onto an AC
// (clauseRef) and is created as a draft epic; #/specs/:id traces each clause to the
// criteria that cover it.
import { readFileSync } from "node:fs";
import path from "node:path";

export default async function s8(t, L) {
  const p = t.page;
  const calls = (f) => {
    try {
      return readFileSync(path.join(L.GAFFER_DATA, f), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const title = `Archive spec ${L.tag("s8")}`;

  await t.visit("specs");
  await p.locator('.view button:has-text("Author a spec")').first().click();
  await p.waitForSelector('.pb-panel[aria-label="Author a spec"] .pb-input', { timeout: 10000 });
  await p.fill(
    '.pb-panel[aria-label="Author a spec"] .pb-input',
    "Archive completed tasks instead of deleting them",
  );
  await p.locator('.pb-panel[aria-label="Author a spec"] .pb-send').click();
  const q = await L.maybe(
    async () =>
      (
        (await p.textContent('.pb-panel[aria-label="Author a spec"] .pb-log').catch(() => "")) || ""
      ).includes("Who archives tasks") || null,
    "spec question",
    20000,
    400,
  );
  t.check(
    q,
    "the spec author's clarifying question is shown in the panel (POST /spec-build, canned author)",
    "the spec author's question never appeared",
  );
  await p.locator('.pb-panel[aria-label="Author a spec"] .pb-force').click();
  const drafted = await L.maybe(
    async () => ((await p.locator(".sb-clauses li").count()) >= 3 ? true : null),
    "draft clauses",
    20000,
    400,
  );
  t.check(
    drafted,
    "'Draft the spec' produced three editable draft clauses",
    `draft clauses on screen: ${await p.locator(".sb-clauses li").count()}`,
  );
  const titleIn = p.locator(".sb-title");
  if (await titleIn.count()) await titleIn.fill(title);
  const repoSel = p.locator(".sb-target-repo");
  if (await repoSel.count())
    await repoSel.selectOption({ label: t.repo.name }).catch(() => repoSel.selectOption(t.repo.id));
  const cP = p.waitForResponse(
    (r) => r.url().endsWith("/specs") && r.request().method() === "POST",
    { timeout: 10000 },
  );
  await p.locator(".sb-create").click();
  const cr = await cP.catch(() => null);
  const body = cr ? JSON.parse(cr.request().postData() || "{}") : {};
  const spec = cr ? (await cr.json().catch(() => ({}))).spec : null;
  t.check(
    cr &&
      cr.status() < 300 &&
      spec &&
      (body.target_repo || body.targetRepo) === t.repo.name &&
      (body.clauses || []).length === 3,
    `Create spec posted /specs with the target repo (${body.target_repo || body.targetRepo}) and 3 clauses`,
    `create spec: ${cr && cr.status()} body=${JSON.stringify(body).slice(0, 200)}`,
  );
  if (!spec) return;

  // ── freeze: locks it and seeds the clauses as draft lore ──────────────────
  const fP = p.waitForResponse((r) => r.url().endsWith(`/specs/${spec.id}/freeze`), {
    timeout: 10000,
  });
  await p.locator(".sb-freeze").click();
  const fr = await fP.catch(() => null);
  const frozen = (await L.api("GET", `/specs/${spec.id}`)).json.spec;
  t.check(
    fr && fr.status() < 300 && frozen && frozen.status === "frozen",
    "Freeze spec locked the spec (POST /specs/:id/freeze → frozen)",
    `freeze: ${fr && fr.status()} status=${frozen && frozen.status}`,
  );
  const seeded = await L.maybe(
    async () => {
      const d =
        (await L.api("GET", `/api/memory/lore?repo=${t.repo.name}&status=draft`)).json.lore || [];
      const hits = d.filter((l) =>
        /archive\(list\) separates|countArchived\(list\) reports|automatic archiving/.test(
          `${l.title} ${l.summary || ""} ${l.body || ""}`,
        ),
      );
      return hits.length >= 3 ? hits : null;
    },
    "clause lore drafts",
    20000,
    1000,
  );
  t.check(
    seeded,
    `the frozen spec's clauses were seeded as gated draft lore (${seeded ? seeded.length : 0} drafts)`,
    "the frozen clauses did not appear as draft lore",
  );

  // ── build the tickets from the spec ───────────────────────────────────────
  await p.locator(".sb-build").click();
  // The plan panel opens with the spec's brief in the box; the human sends it.
  await p.waitForSelector('.pb-panel[aria-label="Plan a build"] .pb-send', { timeout: 10000 });
  const prefilled = await p
    .inputValue('.pb-panel[aria-label="Plan a build"] .pb-input')
    .catch(() => "");
  t.check(
    prefilled.trim().length > 0,
    `the plan panel opens with the spec's brief already in the box ("${prefilled.slice(0, 50)}")`,
    "the plan panel opened from the spec has an empty brief",
  );
  await p.locator('.pb-panel[aria-label="Plan a build"] .pb-send').click();
  const plan = await L.maybe(
    async () =>
      (await p.locator('.pb-confirm-actions button:has-text("Create as draft")').count())
        ? true
        : null,
    "spec-driven plan",
    20000,
    400,
  );
  const dc = calls("decompose-calls.jsonl").pop();
  t.check(
    plan && dc && Array.isArray(dc.spec) && dc.spec.length === 3,
    "'Build the tickets from this spec' handed the frozen clauses to the planner and its plan is on screen",
    `spec-driven plan: shown=${Boolean(plan)} planner got spec=${dc ? JSON.stringify(dc.spec).slice(0, 80) : "no call"}`,
  );
  if (!plan) return;
  const eP = p.waitForResponse(
    (r) => r.url().endsWith("/epics") && r.request().method() === "POST",
    { timeout: 15000 },
  );
  await p.locator('.pb-confirm-actions button:has-text("Create as draft")').click();
  const er = await eP.catch(() => null);
  const ebody = er ? JSON.parse(er.request().postData() || "{}") : {};
  const refs = JSON.stringify(ebody).match(/"clauseRef":"[^"]+"/g) || [];
  t.check(
    er && er.status() < 300 && refs.length === 2,
    `the epic was created as draft with two criteria carrying clauseRef (POST /epics)`,
    `create epic: ${er && er.status()} clauseRefs=${refs.length}`,
  );
  for (const tk of (await L.listTickets()).filter(
    (x) => /archive|Archived|archive helpers/i.test(x.title) && x.status === "draft",
  ))
    t.created.add(tk.id);

  // ── the spec page traces each clause ──────────────────────────────────────
  // Create as draft lands on the new epic; let that navigation finish first.
  await L.maybe(async () => (/#\/epics/.test(p.url()) ? true : null), "epic page", 10000, 300);
  await L.sleep(800);
  await p.keyboard.press("Escape").catch(() => {});
  await t.visit(`specs/${spec.id}`, { label: "specs/:id" });
  const txt = (await p.textContent(".view").catch(() => "")) || "";
  const cov = (await L.api("GET", `/specs/${spec.id}/coverage`)).json.coverage || {};
  const reqs = (cov.clauses || []).filter((c) => c.kind === "requirement");
  const covered = reqs.filter((c) => (c.covering_acs || []).length > 0);
  t.check(
    reqs.length === 2 && covered.length === 2,
    "every requirement clause is covered by a planned ticket's criterion (GET /specs/:id/coverage)",
    `coverage: ${covered.length} of ${reqs.length} requirements covered`,
  );
  const coveringTicket = covered[0] && covered[0].covering_acs[0];
  t.check(
    txt.includes("archive(list) separates") &&
      coveringTicket &&
      txt.includes(`#${coveringTicket.ticket_number}`),
    `#/specs/:id lists each clause with the ticket that covers it (#${coveringTicket && coveringTicket.ticket_number})`,
    `spec page does not trace the clause to its ticket: '${txt.slice(0, 200)}'`,
  );
}
