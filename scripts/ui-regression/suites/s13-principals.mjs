/* global document */
// S13 principals. Settings → Access mints a full (write) credential and a read-only
// one, each token shown once. The full principal signs in through ?token= and files
// a ticket from the Create view, recorded as itself. The read principal signs in, is
// told who it is, sees the squad and the crest with no editors, sees one read-only
// strip with Poll for work and Settings' editors switched off, and a write it sends
// anyway is refused by the server. A ticket-scoped principal (minted with the Ticket
// scope field) sees only its ticket on the board and the list, keeps that ticket's
// controls, finds every factory-wide control switched off with a title naming its
// scope (s18-read-only's walk), and is refused by the server outside its scope.
export default async function s13(t, L) {
  const p = t.page;
  const minted = [];
  const mint = async (name, cap, scope = {}) => {
    await t.visit("settings");
    await p.fill('input[name="principal-name"]', name);
    await p.selectOption('select[name="principal-capability"]', cap);
    await p.fill('input[name="principal-repos"]', scope.repos || "");
    await p.fill('input[name="principal-tickets"]', scope.tickets || "");
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
    // A human principal changes tickets, not repositories or settings: Settings' Save is
    // switched off with a title saying an admin credential is needed (the server answers
    // 403 SCOPE_DENIED admin_required anyway).
    const save = wp.locator('button:has-text("Save changes")').first();
    await save.waitFor({ timeout: 10000 }).catch(() => {});
    const saveTitle = (await save.getAttribute("title").catch(() => "")) || "";
    const refusedSettings = await L.api("POST", "/api/settings", { settings: {} }, wtok);
    t.check(
      (await save.isDisabled().catch(() => false)) &&
        /^Admin access:/.test(saveTitle) &&
        refusedSettings.status === 403 &&
        refusedSettings.json.error?.details?.reason === "admin_required",
      "Settings with a human principal: Save changes is switched off ('Admin access: …') and the server refuses the write (admin_required)",
      `human principal on Settings: Save disabled=${await save.isDisabled().catch(() => "?")} title='${saveTitle}' POST /api/settings=${refusedSettings.status} ${JSON.stringify(refusedSettings.json).slice(0, 160)}`,
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
  await scopedWalk(t, L, mint);
  t.skip(
    "reviewer ≠ author (F103) is enforced for AGENT approvers; a dashboard credential is a human principal, so the browser cannot present the delivering agent's id — covered by the dispatch unit tests",
  );
}

export const SCOPE_TITLE =
  /^Scoped access: this token can change only the tickets in its scope \(ticket #\d+\)\.$/;
// Factory-wide write controls a scoped token must find switched off where they show.
const FACTORY_WRITES = [
  /\bPoll for work\b/i,
  /\bSuggest work\b/i,
  /\bOnboard\b/i,
  /\bCreate ticket\b/i,
  /\bSave changes\b/i,
  /\bNew plan\b/i,
  /\bPlan a build\b/i,
  /\bAuthor a spec\b/i,
  /\bNew ground\b/i,
];

/** Every shown control with its label, whether it is off, and its title. */
async function shownControls(pg) {
  return pg.evaluate(() => {
    const shown = (n) => {
      if (n.closest("[hidden]")) return false;
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    return [...document.querySelectorAll("#app button, #app input, #app select, #app textarea")]
      .filter(shown)
      .map((n) => ({
        label: (
          n.tagName +
          ":" +
          (n.getAttribute("aria-label") || n.textContent.trim() || n.getAttribute("name") || "")
        )
          .replace(/\s+/g, " ")
          .slice(0, 60),
        off: n.disabled || n.getAttribute("aria-disabled") === "true",
        scopeLocked: n.classList.contains("is-scope-locked"),
        title: n.title || "",
      }));
  });
}

/** A ticket-scoped principal on the dashboard: only its ticket, factory writes off. */
async function scopedWalk(t, L, mint) {
  const tag = L.tag("s13scope");
  const mine = await L.seedTicket(t, { title: `Scoped mine ${tag}`, acs: ["covered"] });
  const other = await L.seedTicket(t, { title: `Scoped other ${tag}`, acs: ["covered"] });
  const name = `ci-scoped-${tag}`;
  const tok = await mint(name, "full", { tickets: String(mine.number) });
  if (!tok) return;
  const who = await L.api("GET", "/api/whoami", undefined, tok);
  t.check(
    who.json.scope && (who.json.scope.tickets || []).map((x) => x.id).join() === mine.id,
    `Settings → Access minted '${name}' scoped to ticket #${mine.number}`,
    `scoped whoami: ${JSON.stringify(who.json).slice(0, 200)}`,
  );
  // The server: the other ticket is outside, with details naming the scope.
  const denied = await L.api("GET", `/tickets/${other.id}`, undefined, tok);
  const wdenied = await L.api("POST", `/tickets/${other.id}/ready`, {}, tok);
  const poll = await L.api("POST", "/poll-work", {}, tok);
  t.check(
    denied.status === 403 &&
      denied.json.error?.code === "SCOPE_DENIED" &&
      (denied.json.error?.details?.scope?.tickets || [])[0]?.number === mine.number &&
      wdenied.status === 403 &&
      poll.status === 403,
    "the server refuses the scoped token outside its scope (403 SCOPE_DENIED naming the scope): the other ticket's read and write, Poll for work",
    `scoped refusals: read=${denied.status} ${JSON.stringify(denied.json).slice(0, 160)} write=${wdenied.status} poll=${poll.status}`,
  );

  // The operator makes its ticket wait on the other one: the ticket page must name the
  // dependency by number only (the server leaves the other ticket's title out).
  const dep = await L.api("POST", `/tickets/${mine.id}/dependencies`, { depends_on: other.id });
  const seen = await L.api("GET", `/tickets/${mine.id}/dependencies`, undefined, tok);
  t.check(
    dep.status === 201 &&
      seen.status === 200 &&
      seen.json.dependencies?.[0]?.outside_scope === true &&
      seen.json.dependencies?.[0]?.title === null,
    `scoped token: a dependency on #${other.number} (outside its scope) comes by number, without its title`,
    `scoped dependency: add=${dep.status} read=${seen.status} ${JSON.stringify(seen.json).slice(0, 200)}`,
  );

  const sp = await L.openPage(t.browser, { token: tok, route: "work" });
  const writes = [];
  sp.on("request", (req) => {
    if (!["GET", "HEAD"].includes(req.method())) writes.push(`${req.method()} ${req.url()}`);
  });
  const routes = [
    ["overview", "front page (the Work board for a scoped token)"],
    ["work", "work"],
    ["work?view=list", "work list"],
    [`ticket/${mine.id}`, "ticket (in scope)"],
    ["review", "review"],
    ["epics", "epics"],
    ["create", "create"],
    ["factory", "map"],
    ["specs", "specs"],
    ["memory", "memory"],
    ["squad", "squad"],
    ["floor", "floor"],
    ["health", "health"],
    ["settings", "settings"],
    [`repo/${encodeURIComponent(t.repo.id)}`, "repo/:id"],
    ["hidden", "hidden"],
  ];
  const leaks = [];
  const live = [];
  const badTitle = [];
  let ticketControls = 0;
  for (const [route, label] of routes) {
    await sp.goto(`${L.BASE}/#/${route}`, { waitUntil: "load" });
    await sp
      .waitForFunction(
        () => (document.querySelector("#app")?.textContent || "").trim().length > 50,
        null,
        { timeout: 15000 },
      )
      .catch(() => null);
    await L.sleep(1500);
    const text = (await sp.textContent("#app").catch(() => "")) || "";
    if (text.includes(other.title)) leaks.push(label);
    if (["overview", "work", "work?view=list"].includes(route) && !text.includes(mine.title))
      leaks.push(`${label} (its own ticket missing)`);
    const c = await shownControls(sp);
    for (const x of c) {
      if (!x.off && FACTORY_WRITES.some((re) => re.test(x.label)))
        live.push(`${label}: ${x.label}`);
      if (x.scopeLocked && !SCOPE_TITLE.test(x.title))
        badTitle.push(`${label}: ${x.label} '${x.title}'`);
    }
    if (route.startsWith("ticket/")) {
      ticketControls = c.filter((x) => !x.off && /^BUTTON:/.test(x.label)).length;
      if (!/outside this token's scope/.test(text)) leaks.push(`${label} (dependency not marked)`);
    }
  }
  await L.shot(sp, "s13-scoped-token");
  const strip = (await sp.textContent("#scope-strip").catch(() => "")) || "";
  t.check(
    leaks.length === 0,
    `scoped token: no view shows #${other.number}'s title, the board and list show #${mine.number}, and its dependency on #${other.number} reads "outside this token's scope"`,
    `scoped token showed out-of-scope work or lost its own: ${leaks.join(", ")}`,
  );
  t.check(
    live.length === 0 && /Scoped access/.test(strip),
    "scoped token: one scope strip, and every factory-wide write control shown is switched off",
    `scoped token: live factory writes: ${live.join(" | ").slice(0, 600)} strip='${strip.slice(0, 80)}'`,
  );
  t.check(
    badTitle.length === 0,
    `scoped token: every control switched off for the scope says "Scoped access: … (ticket #${mine.number})."`,
    `scoped token: wrong or missing titles: ${badTitle.join(" | ").slice(0, 600)}`,
  );
  t.check(
    ticketControls > 0,
    `scoped token: the in-scope ticket's own controls stay live (${ticketControls} button(s))`,
    "scoped token: the in-scope ticket page offered no live control",
  );
  const f403 = sp.failedRequests.filter((x) => /→ 403/.test(x));
  t.check(
    f403.length === 0 && sp.consoleErrors.length === 0 && writes.length === 0,
    `scoped token: no request refused (403), no console error and no write sent over all ${routes.length} views`,
    `scoped token: 403s=${f403.join(", ").slice(0, 300)} console=${sp.consoleErrors.join(" | ").slice(0, 300)} writes=${writes.join(", ").slice(0, 200)}`,
  );
  await sp.context().close();
}
