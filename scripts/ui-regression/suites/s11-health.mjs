// S11 health, from what a live factory leaves behind (no tampered log: the BROKEN
// event-log chain needs a rewritten row and is left to its unit tests). After one
// delivery and one parked ticket: the Event log card reads intact with the server's
// event count; the treatment list names the blocked ticket with a link to it; a
// finished run's log opens in a sheet with the tick's own output.
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
