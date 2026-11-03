// S11 health, from what a live factory leaves behind (no tampered log: the BROKEN
// event-log chain needs a rewritten row and is left to its unit tests). After one
// delivery and one parked ticket: the Event log card reads intact with the server's
// event count; the four measures card shows the server's first-pass and review-time
// figures and the escaped-defect rate as the server counted it (only what a person
// filed); a ticket page carries the Escaped defects card, and filing a link there (when an
// accepted change exists) moves Health's count; the treatment list names the
// blocked ticket with a link to it; a finished run's log opens in a sheet with the
// tick's own output.
export default async function s11(t, L) {
  const p = t.page;
  await L.putSettings({ GAFFER_MAX_DELIVERY_ATTEMPTS: "1" });
  const parked = await L.seedTicket(t, {
    title: `Injured ticket (${L.tag("s11")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  L.setStubMode(parked.number, "fail_first");
  await t.visit("work");
  await t.poll();
  await L.waitStatus(parked.id, L.SETTLED, 240000);
  await L.putSettings({ GAFFER_MAX_DELIVERY_ATTEMPTS: "" });
  if ((await L.ticketOf(parked.id)).status !== "blocked")
    t.bad(`seed: #${parked.number} did not park (${(await L.ticketOf(parked.id)).status})`);

  const health = (await L.api("GET", "/api/health")).json;
  await t.visit("health");
  const view = (await p.textContent(".view").catch(() => "")) || "";
  const ev = health.event_log || health.eventLog;
  t.check(
    ev && ev.chain_ok && view.includes("intact") && view.includes(`${ev.events} events chained`),
    `Health's Event log card reads intact with the server's count (${ev && ev.events} events chained)`,
    `event log card: api=${JSON.stringify(ev)} page has intact=${view.includes("intact")}`,
  );
  // The four top-level measures, read from the same /api/health payload: first-pass
  // acceptance and the median review time as the server computed them (a dash when
  // nothing is accepted yet), the escaped-defect rate as the server served it, with the
  // sentence that it counts only what a person filed.
  const measures = (await p.textContent('[aria-label="The four measures"]').catch(() => "")) || "";
  const fp = health.first_pass;
  const fpShown = fp && typeof fp.rate_pct === "number" ? `${fp.rate_pct}%` : "—";
  const esc = health.escaped_defects;
  const escShown = esc && typeof esc.rate_pct === "number" ? `${esc.rate_pct}%` : "—";
  t.check(
    fp &&
      health.review_time &&
      measures.includes("First-pass acceptance") &&
      measures.includes(fpShown) &&
      measures.includes("Human review time") &&
      measures.includes("Accepted-change cost") &&
      health.escaped_defects &&
      health.escaped_defects.recorded === true &&
      new RegExp(`Escaped-defect rate\\s*${escShown.replace("%", "\\%")}`).test(measures) &&
      measures.includes("Counts only what a person filed"),
    `Health shows the four measures (first-pass ${fpShown} over ${fp && fp.done} done, review time basis ${health.review_time && health.review_time.basis}, escaped defects ${escShown} of ${health.escaped_defects && health.escaped_defects.accepted_changes} accepted)`,
    `four measures card: api first_pass=${JSON.stringify(fp)} page='${measures.slice(0, 300)}'`,
  );
  // ── escaped defects: the ticket page's link control (MF5) ─────────────────
  await t.visit(`ticket/${parked.id}`, { label: "ticket/:id" });
  const regCard = p.locator('[aria-label="Escaped defects"]');
  const hasForm = await regCard
    .locator("form.tk-regression-form")
    .waitFor({ timeout: 15000 })
    .then(
      () => true,
      () => false,
    );
  t.check(
    hasForm,
    `#${parked.number}'s page has the Escaped defects card with the link control`,
    "no Escaped defects card with a form on the ticket page",
  );
  const doneTicket = (await L.listTickets()).find((x) => x.status === "done");
  if (hasForm && doneTicket) {
    await regCard.locator("input").first().fill(String(doneTicket.number));
    await regCard.locator('button[type="submit"]').click();
    const linked = await L.maybe(
      async () => {
        const v = await L.ticketView(parked.id);
        return v.regression && v.regression.regression_of.some((l) => l.ticket_id === doneTicket.id)
          ? v
          : null;
      },
      "regression link",
      15000,
      500,
    );
    const after = (await L.api("GET", "/api/health")).json.escaped_defects || {};
    t.check(
      linked && after.all_time && after.all_time.escaped >= 1,
      `linking #${parked.number} as a regression of accepted #${doneTicket.number} from the page counts in Health (${after.all_time && after.all_time.escaped} escaped of ${after.all_time && after.all_time.accepted_changes} all time)`,
      `regression link: view=${JSON.stringify(linked && linked.regression)} health=${JSON.stringify(after)}`,
    );
  } else if (hasForm) {
    t.note("escaped defects: no accepted change in this world, so no link was filed");
  }
  await t.visit("health");

  const row = p
    .locator(`.needs-item a[href*="${parked.id}"], .needs-item:has-text("#${parked.number}") a`)
    .first();
  const listed = await row.count();
  t.check(
    listed > 0,
    `the treatment list names blocked #${parked.number} with a link`,
    `the treatment list does not name #${parked.number}: '${((await p.textContent(".needs-hero").catch(() => "")) || "").slice(0, 200)}'`,
  );
  if (listed) {
    await row.click();
    const nav = await L.maybe(
      async () => (/#\/(ticket|work)/.test(p.url()) ? true : null),
      "treatment link",
      8000,
      300,
    );
    t.check(
      nav,
      `the treatment row's link leads to the work (${p.url().split("#")[1]})`,
      `treatment link went to ${p.url()}`,
    );
  }

  // ── a finished run's log ──────────────────────────────────────────────────
  await t.visit("health");
  const vl = p.locator("#running-now button.run-viewlog").first();
  const hasRun = await vl.waitFor({ timeout: 15000 }).then(
    () => true,
    () => false,
  );
  t.check(
    hasRun,
    "Running now lists a finished run with View log",
    "no View log on Health's Running now",
  );
  if (hasRun) {
    await vl.click();
    const log = await L.maybe(
      async () => {
        const txt = (await p.textContent(".sheet.open .run-log").catch(() => "")) || "";
        return /TICK_RESULT|tick|claimed|delivering|gaffer/i.test(txt) && !/Loading log/.test(txt)
          ? txt
          : null;
      },
      "run log",
      15000,
      500,
    );
    t.check(
      log,
      `the run log sheet shows the run's captured output ("${(log || "").trim().slice(0, 60)}…")`,
      "the run log sheet never showed the run's output",
    );
    await p.keyboard.press("Escape");
  }
}
