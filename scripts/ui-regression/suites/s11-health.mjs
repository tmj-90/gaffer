// S11 health, from what a live factory leaves behind (no tampered log: the BROKEN
// event-log chain needs a rewritten row and is left to its unit tests). After one
// delivery and one parked ticket: the event log line reads intact with the server's
// event count; the scoreboard's four measure tiles show the server's first-pass figure
// and the escaped-defect rate as the server counted it (only what a person filed); the
// lane table lists every judging lane from lane_value; a ticket page carries the
// Escaped defects card, and filing a link there (when an
// accepted change exists) moves Health's count; the treatment list names the
// blocked ticket with a link to it; a finished run's log opens in a sheet with the
// tick's own output.
export default async function s11(t, L) {
  const p = t.page;
  // seed: Effort small (two attempts; GAFFER_EFFORT decides the attempt cap) and a
  // delivery that fails every one of them, so it parks.
  await L.putSettings({ GAFFER_EFFORT: "small" });
  const parked = await L.seedTicket(t, {
    title: `Injured ticket (${L.tag("s11")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  L.setStubMode(parked.number, "fail_always");
  await t.visit("work");
  await t.poll();
  await L.waitStatus(parked.id, L.SETTLED, 240000);
  await L.putSettings({ GAFFER_EFFORT: "" });
  if ((await L.ticketOf(parked.id)).status !== "blocked")
    t.bad(`seed: #${parked.number} did not park (${(await L.ticketOf(parked.id)).status})`);

  // The page reads its measures over the window the Referee's record shows (30 days).
  const health = (await L.api("GET", "/api/health?window_days=30")).json;
  await t.visit("health");
  // Wait for the board's tiles (a hash visit can pass its own check on the old page).
  await p
    .waitForSelector(".physio-board .measure-strip > .measure-tile", { timeout: 15000 })
    .catch(() => null);
  const view = (await p.textContent(".view").catch(() => "")) || "";
  const ev = health.event_log || health.eventLog;
  t.check(
    ev && ev.chain_ok && view.includes("intact") && view.includes(`${ev.events} events chained`),
    `Health's event log line reads intact with the server's count (${ev && ev.events} events chained)`,
    `event log line: api=${JSON.stringify(ev)} page has intact=${view.includes("intact")}`,
  );
  // The four top-level measures are the scoreboard's tiles (V1), read from the same
  // payload: each tile's figure as the server computed it, in the one percent format
  // (pct: whole at 10 and up, one decimal below) or a dash when nothing is accepted yet;
  // the escaped-defect rate as the server served it, with its definition saying it
  // counts only what a person filed. The four tiles are the first thing in the strip.
  const pct = (v) =>
    typeof v !== "number"
      ? "\u2014"
      : v >= 99.5 && v < 100
        ? ">99%"
        : Math.abs(v) >= 10
          ? `${Math.round(v)}%`
          : `${Number(v.toFixed(1))}%`;
  const tiles = await p
    .$$eval(".physio-board .measure-strip > .measure-tile", (els) =>
      els.map((e) => ({
        label: e.getAttribute("aria-label"),
        value: e.querySelector(".mt-val")?.textContent || "",
        text: e.textContent || "",
      })),
    )
    .catch(() => []);
  const tile = (label) => tiles.find((x) => x.label === label) || { value: "", text: "" };
  const fp = health.first_pass;
  const fpShown = fp && fp.done ? pct((fp.first_pass / fp.done) * 100) : "\u2014";
  const esc = health.escaped_defects;
  const escShown =
    esc && esc.accepted_changes ? pct((esc.escaped / esc.accepted_changes) * 100) : "\u2014";
  t.check(
    fp &&
      health.review_time &&
      tiles.map((x) => x.label).join("|") ===
        "First-pass acceptance|Human review time|Accepted-change cost|Escaped-defect rate" &&
      tile("First-pass acceptance").value === fpShown &&
      esc &&
      esc.recorded === true &&
      tile("Escaped-defect rate").value === escShown &&
      tile("Escaped-defect rate").text.includes("Counts only what a person filed"),
    `Health's scoreboard is the four measures (first-pass ${fpShown} over ${fp && fp.done} done, review time basis ${health.review_time && health.review_time.basis}, escaped defects ${escShown} of ${esc && esc.accepted_changes} accepted)`,
    `four measures strip: api first_pass=${JSON.stringify(fp)} tiles=${JSON.stringify(tiles.map((x) => [x.label, x.value]))}`,
  );
  // What each lane changed (D1): a table row per lane with verdicts (its verdict count
  // in the Verdicts cell), the lanes with none on one "No verdicts recorded" line, and
  // the footnote that recommends nothing.
  const laneCard =
    (await p.textContent('[aria-label="What each lane changed"]').catch(() => "")) || "";
  const laneRows = await p
    .$$eval('[aria-label="What each lane changed"] tbody tr', (trs) =>
      trs.map((tr) => [...tr.children].map((c) => (c.textContent || "").trim())),
    )
    .catch(() => []);
  const lv = health.lane_value;
  t.check(
    lv &&
      Array.isArray(lv.lanes) &&
      lv.lanes.every((l) =>
        l.note
          ? /No verdicts recorded:/.test(laneCard) && laneCard.includes(l.label)
          : laneRows.some((r) => r[0].startsWith(l.label) && r[1] === String(l.verdicts_recorded)),
      ) &&
      laneCard.includes("never switched off by telemetry"),
    `Health shows what each lane changed (${lv && lv.attempts} attempts; ${lv && lv.lanes.filter((l) => !l.note).length} lanes with verdicts)`,
    `lane card: api=${JSON.stringify(lv && lv.lanes.map((l) => [l.lane, l.verdicts_recorded]))} rows=${JSON.stringify(laneRows)} page='${laneCard.slice(0, 300)}'`,
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
  // t.visit's "rendered" check passes on the ticket page's text still in #app (a hash
  // navigation), and Health paints its treatment table only after /api/health and the
  // flow panels' own fetches: a bare count() raced that paint and read 0 while the
  // table, a moment later, named the ticket. Wait for the row (as long as visit waits).
  await row.waitFor({ timeout: 15000 }).catch(() => null);
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
