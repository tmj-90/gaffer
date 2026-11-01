/* global document */
// S18 read-only token, every view. A read token (`dispatch-api print-read-token`) may
// look at everything and change nothing, and the server refuses every non-GET with 403
// READ_ONLY_TOKEN. The README promises the dashboard does not offer such a write: every
// control that would change something is switched off with the title "Read-only
// access: this token can look, not change anything." This suite seeds a world with
// something to act on in every view (a delivered ticket in Review, a live claim with a
// Revoke, a won't-do ticket with a Reopen, a paused ticket, an epic, a spec, a ground
// and the seeded lore draft), signs in with the read token and walks every view:
//   - no enabled control is a write control (the allowlist below names the read-only
//     controls a viewer may still use: search, filters, view toggles, navigation);
//   - every control switched off for the token carries that title;
//   - the page sends no non-GET request at all, so nothing is refused with a 403
//     (the Create view used to POST /scope/repo-suggestions on open).
// Then the gate itself: with no token the members' entrance sends no API call that
// answers 401, and with a wrong token only the one whoami that says so
// (exploratory finding ui-explore/F-05).
// Exploratory findings ui-explore/F-01 and ui-workflows/F7.
import { execFileSync } from "node:child_process";
import path from "node:path";

export const TITLE = "Read-only access: this token can look, not change anything.";

// Controls a read token may use: they change what is SHOWN, never the factory. A label
// is matched against "<tag>:<text|aria-label|name|placeholder|type>".
const READ_SAFE = [
  /^INPUT:(search|Search|Find|Filter)/i,
  /^INPUT:.*(search|find|filter)/i,
  /^INPUT:Words in a title/i, // Memory's lore search
  /^SELECT:/i, // filters (status, repo, lore status/kind); writes use selects only inside forms we lock
  /^BUTTON:Open /, // a link-like button (a card's repo chip)
  /^BUTTON:(Search|More|Logout|Log out|Sign out|Close|Cancel|Back|Show|Hide|Expand|Collapse|View|Open|Copy|Refresh|Reload|Try again|Retry|Board|List|Light|Dark|Theme|Previous|Next|Older|Newer|Load more|All|Clear)/i,
  /^BUTTON:.*(view log|log tail|details|history|toggle|filter|zoom|fit|reset view)/i,
  /^BUTTON:.*(open .*sheet|show .*|hide .*|more…?|less)$/i,
  /^BUTTON:(\d+|#\d+)/, // pagers / ticket jump chips
  /^BUTTON:.*: \d+ added, \d+ removed$/, // a diff file's fold
];
// Write controls the dashboard has had: an enabled one of these is always a failure,
// whatever the allowlist says.
const WRITE = [
  /\bApprove\b/i,
  /\bSend back\b/i,
  /\bWon.t do\b/i,
  /\bRevoke\b/i,
  /\bReopen\b/i,
  /\bNew ground\b/i,
  /\bOnboard\b/i,
  /\bAuthor a spec\b/i,
  /\bBuild the tickets\b/i,
  /\bNew plan\b/i,
  /\bPoll for work\b/i,
  /\bSuggest work\b/i,
  /\bMark ready\b/i,
  /\bMerge\b/i,
  /\bContinue\b/i,
  /\bStop\b/i,
  /\bSave\b/i,
  /\bCreate\b/i,
  /^BUTTON:Add\b/i,
  /^BUTTON:Send\b/i,
  /^TEXTAREA:/i,
  /\bAnswer\b/i,
  /\bUnblock\b/i,
  /\bRename\b/i,
  /\bMove\b/i,
  /\bReject\b/i,
  /\bPlan a build\b/i,
  /\bDelete\b/i,
  /\bLink repo\b/i,
  /\bAdd connection\b/i,
];

const readToken = (L) =>
  execFileSync(
    "node",
    [path.join(L.ROOT, "packages/dispatch/dist/api/bin.js"), "print-read-token"],
    {
      env: { ...process.env, DISPATCH_API_TOKEN: L.TOKEN, GAFFER_DATA: L.GAFFER_DATA },
    },
  )
    .toString()
    .trim();

const cli = (L, ...args) =>
  JSON.parse(
    execFileSync(
      "node",
      [
        path.join(L.ROOT, "packages/dispatch/dist/cli/index.js"),
        "--db",
        path.join(L.GAFFER_DATA, "dispatch.sqlite"),
        ...args,
      ],
      { env: { ...process.env, GAFFER_DATA: L.GAFFER_DATA } },
    ).toString(),
  );

/** Seed one ticket in every state a write control hangs off. Answers the ids. */
export async function seedWorld(t, L, tagPrefix) {
  const tag = L.tag(tagPrefix);
  // delivered → in_review (Review's Approve / Send back / Won't do)
  const review = await L.seedTicket(t, {
    title: `RO review ${tag}`,
    acs: ["covered by a test"],
    ready: true,
  });
  // turn-cap pause (the ticket page's Continue / Stop, the Team Sheet row)
  const paused = await L.seedTicket(t, {
    title: `RO paused ${tag}`,
    acs: ["covered by a test"],
    ready: true,
  });
  L.setStubMode(paused.number, "pause_first");
  await t.poll();
  await L.waitStatus(review.id, L.SETTLED, 240000);
  await L.maybe(
    async () => (((await L.api("GET", "/api/runs")).json.active || []).length === 0 ? 1 : null),
    "tick to finish",
    240000,
    2000,
  );
  if ((await L.ticketOf(paused.id)).status !== "paused") {
    await t.poll();
    await L.waitStatus(paused.id, L.SETTLED, 240000);
  }
  // won't do → cancelled (the Work board's Reopen)
  const closed = await L.seedTicket(t, { title: `RO closed ${tag}` });
  await L.api("POST", `/tickets/${closed.id}/wont-do`, { reason: "seeded for the read-only walk" });
  // a live claim held by an agent with a long name (On the pitch: Revoke)
  const held = await L.seedTicket(t, {
    title: `RO held ${tag} ${"with a very long title that keeps going ".repeat(4)}`.slice(0, 200),
    acs: ["covered by a test"],
    ready: true,
  });
  // 39 characters: one short of the 40 a display name may have (F-14 clamps it).
  const longName = "Long-named delivery agent number 123456";
  const agent = cli(L, "agent", "register", "-n", longName).agent;
  cli(L, "agent", "rename", agent.id, "--name", longName);
  agent.display_name = longName;
  const claim = cli(L, "claim-ticket", held.id, "-a", agent.id, "--ttl", "3600");
  // an epic, a spec and a ground (their detail pages)
  const epic = (
    await L.api("POST", "/epics", {
      epic: { name: `RO epic ${tag}`, description: "seeded", brief: "a read-only walk" },
      tickets: [
        {
          title: `RO epic first ${tag}`,
          description: "one",
          acceptanceCriteria: ["it works"],
          repo: t.repo.name,
          dependsOn: [],
        },
      ],
    })
  ).json;
  for (const x of (await L.listTickets()).filter((k) => k.title.includes(tag))) t.created.add(x.id);
  const spec = (
    await L.api("POST", "/specs", {
      title: `RO spec ${tag}`,
      target_repo: t.repo.name,
      clauses: [{ clause_id: "c1", kind: "requirement", text: "a requirement" }],
    })
  ).json.spec;
  const node = (
    await L.api("POST", "/scope/nodes", {
      name: `RO ground ${tag}`,
      type: "product",
      risk_level: "low",
    })
  ).json.node;
  return {
    tag,
    review: await L.ticketOf(review.id),
    paused: await L.ticketOf(paused.id),
    closed,
    held,
    agent,
    claim,
    epicId: epic.epic_node_id || epic.epic?.id || epic.node?.id,
    spec,
    node,
  };
}

/** Revoke the seeded claim, so cleanup can close its ticket. */
export async function revokeHeld(L, w) {
  const claims = (await L.api("GET", "/claims")).json.claims || [];
  for (const c of claims.filter((x) => x.ticket_id === w.held.id))
    await L.api("POST", `/claims/${c.claim_id || c.id}/revoke`, {});
}

/** Every enabled control on the page, and every disabled one without the title. */
async function controls(pg) {
  return pg.evaluate(() => {
    const shown = (n) => {
      if (n.closest("[hidden]")) return false;
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const label = (n) =>
      (
        n.tagName +
        ":" +
        (
          (/^Open /.test(n.title || "") ? n.title : "") ||
          n.getAttribute("aria-label") ||
          n.textContent.trim() ||
          n.getAttribute("name") ||
          n.getAttribute("placeholder") ||
          n.getAttribute("type") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
      ).slice(0, 60);
    const all = [
      ...document.querySelectorAll(
        "#app button, #app input, #app select, #app textarea, #app [role=button], #app [role=switch], .sheet.open button, .sheet.open input, .sheet.open textarea, .sheet.open select",
      ),
    ].filter(shown);
    const off = (n) => n.disabled || n.getAttribute("aria-disabled") === "true";
    return {
      enabled: all.filter((n) => !off(n)).map(label),
      offNoTitle: all
        .filter((n) => off(n) && n.classList.contains("is-read-only") && !n.title)
        .map(label),
      locked: all
        .filter((n) => n.classList.contains("is-read-only"))
        .map((n) => [label(n), n.title]),
    };
  });
}

export default async function s18(t, L) {
  const w = await seedWorld(t, L, "s18");
  t.check(
    w.review.status === "in_review" && w.paused.status === "paused" && w.claim.claimToken,
    `seeded: #${w.review.number} in review, #${w.paused.number} paused, #${w.held.number} claimed by '${w.agent.display_name}', #${w.closed.number} won't do, an epic, a spec and a ground`,
    `seed: review=${w.review.status} paused=${w.paused.status} claim=${JSON.stringify(w.claim).slice(0, 120)}`,
  );
  const rtok = readToken(L);
  const who = await L.api("GET", "/api/whoami", undefined, rtok);
  t.check(
    who.json.capability === "read",
    "`dispatch-api print-read-token` printed a token the server takes as read-scoped",
    `whoami with the printed token: ${JSON.stringify(who.json).slice(0, 160)}`,
  );

  const rp = await L.openPage(t.browser, { token: rtok, route: "overview" });
  const writes = [];
  rp.on("request", (req) => {
    if (!["GET", "HEAD"].includes(req.method())) writes.push(`${req.method()} ${req.url()}`);
  });
  const routes = [
    ["overview", "overview"],
    ["work", "work"],
    ["work?view=list", "work list"],
    [`review/${w.review.id}`, "review/:id"],
    ["review", "review"],
    [`ticket/${w.review.id}`, "ticket (in review)"],
    [`ticket/${w.paused.id}`, "ticket (paused)"],
    [`ticket/${w.closed.id}`, "ticket (won't do)"],
    [`ticket/${w.held.id}`, "ticket (claimed)"],
    ["epics", "epics"],
    w.epicId ? [`epics/${w.epicId}`, "epics/:id"] : null,
    ["create", "create"],
    ["factory", "map"],
    w.node ? [`node/${w.node.id}`, "node/:id"] : null,
    ["specs", "specs"],
    w.spec ? [`specs/${w.spec.id}`, "specs/:id"] : null,
    ["memory", "memory"],
    ["squad", "squad"],
    ["floor", "floor"],
    ["health", "health"],
    ["settings", "settings"],
    [`repo/${encodeURIComponent(t.repo.id)}`, "repo/:id"],
  ].filter(Boolean);
  const live = [];
  const noTitle = [];
  for (const [route, label] of routes) {
    const before = writes.length;
    await rp.goto(`${L.BASE}/#/${route}`, { waitUntil: "load" });
    await rp
      .waitForFunction(
        () => (document.querySelector("#app")?.textContent || "").trim().length > 50,
        null,
        { timeout: 15000 },
      )
      .catch(() => null);
    await L.sleep(1200);
    const c = await controls(rp);
    const bad = c.enabled.filter(
      (x) => WRITE.some((re) => re.test(x)) || !READ_SAFE.some((re) => re.test(x)),
    );
    if (bad.length) {
      live.push(`${label}: ${[...new Set(bad)].join(" | ")}`);
      t.note(`read token on ${label}: enabled ${[...new Set(bad)].join(" | ")}`);
    }
    const wrong = c.locked.filter(([, title]) => title !== TITLE).map(([l]) => l);
    if (c.offNoTitle.length || wrong.length)
      noTitle.push(`${label}: ${[...new Set([...c.offNoTitle, ...wrong])].join(" | ")}`);
    if (writes.length > before) live.push(`${label} sent ${writes.slice(before).join(", ")}`);
  }
  await L.shot(rp, "s18-read-only-last");
  t.check(
    live.length === 0,
    `read token: no enabled write control and no non-GET request on any of ${routes.length} views`,
    `read token: enabled write controls / writes sent: ${live.join(" ;; ").slice(0, 1500)}`,
  );
  t.check(
    noTitle.length === 0,
    `read token: every switched-off control says "${TITLE}"`,
    `read token: switched off without the title: ${noTitle.join(" ;; ").slice(0, 800)}`,
  );
  const f403 = rp.failedRequests.filter((x) => /→ 403/.test(x));
  t.check(
    f403.length === 0 && rp.consoleErrors.length === 0,
    "read token: no request was refused (403) and no console error over the whole walk",
    `read token: 403s=${f403.join(", ").slice(0, 300)} console=${rp.consoleErrors.join(" | ").slice(0, 300)}`,
  );
  await rp.context().close();

  // ── the members' entrance asks for nothing it cannot have (F-05) ──────────
  for (const [label, q] of [
    ["no token", ""],
    ["a wrong token", "?token=not-the-token"],
  ]) {
    const ctx = await t.browser.newContext({ viewport: { width: 1280, height: 800 } });
    const gp = await ctx.newPage();
    const unauth = [];
    const errs = [];
    gp.on("response", (r) => {
      if (r.status() === 401) unauth.push(`${r.request().method()} ${new URL(r.url()).pathname}`);
    });
    gp.on("console", (m) => {
      if (m.type() === "error") errs.push(m.text());
    });
    await gp.goto(`${L.BASE}/${q}#/overview`, { waitUntil: "load" });
    await L.sleep(2500);
    const gate = await gp.evaluate(() => Boolean(document.querySelector("form.login-gate")));
    // A wrong token is checked once (one 401 says it was rejected); nothing else may ask.
    const allowed = q ? 1 : 0;
    t.check(
      gate &&
        unauth.length <= allowed &&
        errs.filter((e) => !/401/.test(e) || unauth.length > allowed).length === 0,
      `the login gate with ${label} shows the entrance and makes ${unauth.length ? "only the one token check" : "no API call"} (no 401 console noise)`,
      `login gate with ${label}: gate=${gate} 401s=${unauth.join(", ")} console=${errs.join(" | ").slice(0, 200)}`,
    );
    await ctx.close();
  }

  // leave nothing live: the claim and the agent's ticket
  await revokeHeld(L, w);
}
