/* global document */
// S13 principals. Settings → Access mints a full (write) credential and a read-only
// one, each token shown once. The full principal signs in through ?token= and files
// a ticket from the Create view, recorded as itself. The read principal signs in, is
// told who it is, sees the squad and the crest with no editors, sees one read-only
// strip with Poll for work and Settings' editors switched off, and a write it sends
// anyway is refused by the server.
export default async function s13(t, L) {
  const p = t.page;
  const minted = [];
  const mint = async (name, cap) => {
    await t.visit("settings");
    await p.fill('input[name="principal-name"]', name);
    await p.selectOption('select[name="principal-capability"]', cap);
    await p.click('form.access-form button[type="submit"]');
    const tok = await L.maybe(
      async () => {
        const v = await p.inputValue('[data-testid="access-token"]').catch(() => "");
        return v.startsWith("gfp_") && !minted.includes(v) ? v : null;
      },
      "one-time token",
      10000,
      300,
    );
    if (tok) minted.push(tok);
    t.check(
      tok,
      `Settings → Access minted '${name}' (${cap}) and showed its gfp_ token once`,
      `no one-time token for '${name}'`,
    );
    return tok;
  };
  const writerName = `ci-writer-${L.tag("p")}`;
  const readerName = `ci-reader-${L.tag("p")}`;
  const wtok = await mint(writerName, "full");
  const rtok = await mint(readerName, "read");

  // ── the full principal files a ticket from the Create view ────────────────
  if (wtok) {
    const wp = await L.openPage(t.browser, { token: wtok, route: "settings" });
    const who = (await wp.textContent('[data-testid="access-whoami"]').catch(() => "")) || "";
    t.check(
      who.includes(writerName),
      `signed in with the full credential, Access names the principal ("${who.slice(0, 80)}")`,
      `Access whoami with the writer token: '${who.slice(0, 120)}'`,
    );
    const title = `Filed by a principal (${L.tag("s13")})`;
    await wp.goto(`${L.BASE}/#/create`, { waitUntil: "load" });
    await wp.waitForSelector('input[placeholder="Short, action-oriented title"]', {
      timeout: 15000,
    });
    await wp.fill('input[placeholder="Short, action-oriented title"]', title);
    await wp.fill("#one-ticket textarea", "created under a named principal");
    // The Create form needs a write repo: pick it in "Add a repo…" and press Add.
    await wp.evaluate((name) => {
      const sel = [...document.querySelectorAll("#one-ticket select")].find((s) =>
        [...s.options].some((o) => (o.textContent || "").includes(name)),
      );
      if (!sel) return;
      sel.value = [...sel.options].find((o) => (o.textContent || "").includes(name)).value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, t.repo.name);
    await wp.click('#one-ticket button:has-text("Add")');
    await L.clearToast(wp);
    await wp.click('#one-ticket button:has-text("Create ticket")');
    const ctoast = (await L.waitToast(wp, /./, 8000)) || "";
    const made = await L.maybe(
      async () => (await L.listTickets()).find((x) => x.title === title) || null,
      "principal ticket",
      15000,
      500,
    );
    if (made) t.created.add(made.id);
    const ev = made
      ? (await L.ticketView(made.id)).events.find((e) => e.event_type === "ticket.created")
      : null;
    t.check(
      made && ev && ev.actor_id === writerName,
      `the ticket filed with the full credential is recorded as created by '${writerName}'`,
      `principal-created ticket: ${made ? `created_by=${ev && ev.actor_id}` : `not created (toast: ${ctoast})`}`,
    );
    t.check(
      wp.consoleErrors.length === 0,
      "no console errors for the full principal's session",
      `writer session console errors: ${wp.consoleErrors.join(" | ").slice(0, 200)}`,
    );
    await wp.context().close();
  }

  // ── the read principal: names visible, no editors, refusals readable ─────
  if (rtok) {
    const rp = await L.openPage(t.browser, { token: rtok, route: "squad" });
    const who = await L.api("GET", "/api/whoami", undefined, rtok);
    t.check(
      who.json.capability === "read" && who.json.actor?.id === readerName,
      `the read credential authenticates as '${readerName}' with capability read`,
      `reader whoami: ${JSON.stringify(who.json).slice(0, 160)}`,
    );
    await L.sleep(1200);
    const rename = await rp.locator("button.sq-rename").count();
    const rows = await rp.locator(".sq-table tbody tr").count();
    t.check(
      rename === 0,
      `Squad with a read token: ${rows} agent row(s) shown, no Rename editor`,
      `Squad with a read token offers ${rename} Rename button(s)`,
    );
    await rp
      .locator(".brand, .club-crest, .brand-name")
      .first()
      .click()
      .catch(() => {});
    await L.sleep(600);
    const editor = await rp.locator('.sheet.open:has-text("Name your club")').count();
    t.check(
      editor === 0,
      "the crest with a read token opens no 'Name your club' editor",
      "a read token got the club editor from the crest",
    );
    await rp.goto(`${L.BASE}/#/work`, { waitUntil: "load" });
    const poll = rp.locator('button:has-text("Poll for work")').first();
    await poll.waitFor({ timeout: 10000 }).catch(() => {});
    const strip = (await rp.textContent("#ro-strip").catch(() => "")) || "";
    const pollOff =
      (await poll.count()) > 0 &&
      (await poll.isDisabled()) &&
      /Read-only access/.test((await poll.getAttribute("title")) || "");
    t.check(
      pollOff && /Read-only access/.test(strip),
      "the read token sees one read-only strip and Poll for work switched off, with a title saying why",
      `read token on Work: strip='${strip.slice(0, 80)}' poll disabled=${await poll.isDisabled().catch(() => "?")}`,
    );
    await rp.goto(`${L.BASE}/#/settings`, { waitUntil: "load" });
    const save = rp.locator('button:has-text("Save changes")').first();
    await save.waitFor({ timeout: 10000 }).catch(() => {});
    const editors = await rp.locator(".boot-main .setting-row input:enabled").count();
    t.check(
      (await save.isDisabled().catch(() => false)) && editors === 0,
      "Settings with a read token: Save changes and every editor are switched off",
      `read token on Settings: ${editors} live editor(s), Save disabled=${await save.isDisabled().catch(() => "?")}`,
    );
    // The server still refuses a write the page no longer offers.
    const refused = await L.api("POST", "/poll-work", {}, rtok);
    t.check(
      refused.status === 403,
      "a write sent with the read token anyway is refused by the server (403)",
      `POST /poll-work with the read token answered ${refused.status}`,
    );
    await rp.context().close();
  }
  t.skip(
    "reviewer ≠ author (F103) is enforced for AGENT approvers; a dashboard credential is a human principal, so the browser cannot present the delivering agent's id — covered by the dispatch unit tests",
  );
}
