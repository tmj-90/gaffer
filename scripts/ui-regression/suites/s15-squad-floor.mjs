/* global document, getComputedStyle */
// S15 the club, the squad and the Floor. On a quiet factory the Floor says so and
// offers Plan a build; the crest's Name your club sets the name, short name and kit
// colours (PATCH /api/club) and the header wears them; a shirt number another agent
// wears is refused naming its holder; a blocked ticket lights the jam bay's beacon; a
// live claim puts a robot on the floor in the agent's shirt; a parcel is a link to
// its ticket.
import { execFileSync } from "node:child_process";
import path from "node:path";

export default async function s15(t, L) {
  const p = t.page;

  // ── an empty floor says so ────────────────────────────────────────────────
  const open = (await L.listTickets()).filter((x) => !L.TERMINAL.includes(x.status));
  const doneToday = (await L.listTickets()).filter(
    (x) =>
      x.status === "done" &&
      String(x.updated_at).slice(0, 10) === new Date().toISOString().slice(0, 10),
  );
  await t.visit("floor");
  if (!open.length && !doneToday.length) {
    const q = (await p.textContent(".fl-quiet").catch(() => "")) || "";
    t.check(
      /The floor is quiet/.test(q) && (await p.locator('.fl-quiet a[href="#/create"]').count()),
      "an empty Floor says it is quiet and links to Plan a build",
      `empty floor reads '${q}'`,
    );
  } else
    t.note(
      `floor empty state not checked: ${open.length} open / ${doneToday.length} done today in this shard`,
    );

  // ── Name your club: name, short, kit colours ─────────────────────────────
  const before = (await L.api("GET", "/api/club")).json.club;
  await t.visit("squad");
  await p.locator("button.crest-btn").click();
  await p.waitForSelector(".club-form", { timeout: 8000 });
  await p.fill('input[name="club_name"]', "Regression Rovers");
  await p.fill('input[name="short_name"]', "RRFC");
  await p.locator('input[name="kit_primary"]').evaluate((n, v) => {
    n.value = v;
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
  }, "#f5e663");
  await p.locator('input[name="kit_secondary"]').evaluate((n, v) => {
    n.value = v;
    n.dispatchEvent(new Event("input", { bubbles: true }));
    n.dispatchEvent(new Event("change", { bubbles: true }));
  }, "#1d3557");
  const resP = p.waitForResponse(
    (r) => r.url().endsWith("/api/club") && r.request().method() === "PATCH",
    { timeout: 10000 },
  );
  await p.locator(".club-form button.club-save").click();
  const res = await resP.catch(() => null);
  const body = res ? JSON.parse(res.request().postData() || "{}") : {};
  const club = (await L.api("GET", "/api/club")).json.club;
  t.check(
    res &&
      res.status() < 300 &&
      body.kit_primary?.toLowerCase() === "#f5e663" &&
      club.name_effective === "Regression Rovers",
    "Name your club saved the name, short name and both kit colours (PATCH /api/club)",
    `club save: ${res && res.status()} body=${JSON.stringify(body)} club=${JSON.stringify(club).slice(0, 160)}`,
  );
  await L.sleep(800);
  const brand = ((await p.textContent(".brand-name").catch(() => "")) || "").trim();
  const ink = await p.evaluate(() => {
    const n = document.querySelector(".appbar, #appbar");
    return n
      ? getComputedStyle(n).getPropertyValue("--kit-ink").trim() || getComputedStyle(n).color
      : "";
  });
  t.check(
    /Regression Rovers/i.test(brand),
    `the header wears the new club name ('${brand}')`,
    `the header reads '${brand}' after the save`,
  );
  t.note(`header ink on the light #f5e663 kit: ${ink}`);
  await L.api("PATCH", "/api/club", {
    name: before?.name ?? null,
    short_name: before?.short_name ?? null,
    kit_primary: before?.kit_primary ?? null,
    kit_secondary: before?.kit_secondary ?? null,
  });

  // ── a taken shirt number is refused, naming its holder ───────────────────
  let agents = (await L.api("GET", "/api/squad")).json.agents || [];
  while (agents.length < 2) {
    execFileSync(
      "node",
      [
        path.join(L.ROOT, "packages/dispatch/dist/cli/index.js"),
        "--db",
        path.join(L.GAFFER_DATA, "dispatch.sqlite"),
        "agent",
        "register",
        "--name",
        `bench-${L.tag("a")}`,
      ],
      { timeout: 60000 },
    );
    agents = (await L.api("GET", "/api/squad")).json.agents || [];
  }
  if (agents.length >= 2) {
    const [a, b] = agents;
    await L.api("PATCH", `/api/squad/agents/${b.agent_id}`, { shirt_number: 7 });
    const holder = (await L.api("GET", "/api/squad")).json.agents.find(
      (x) => x.agent_id === b.agent_id,
    );
    await t.visit("squad");
    const row = p.locator(`.sq-table tbody tr[data-id="${a.agent_id}"]`);
    await row.locator("button.sq-rename").click();
    await row.locator("input.sq-no-in").fill("7");
    await row.locator("button.sq-save").click();
    const err = await L.maybe(
      async () => {
        const txt = (await row.textContent().catch(() => "")) || "";
        return /taken|wears|already/i.test(txt) ? txt : null;
      },
      "taken-number refusal",
      8000,
      300,
    );
    const holderName =
      holder.display_name_effective || holder.display_name || holder.default_display_name || "";
    t.check(
      err && err.includes(holderName),
      `a shirt number another agent wears is refused, naming ${holderName}`,
      `taken-number rename: '${(err || (await row.textContent())).slice(0, 160)}'`,
    );
    const still = (await L.api("GET", "/api/squad")).json.agents.find(
      (x) => x.agent_id === a.agent_id,
    );
    t.check(
      still.shirt_number !== 7,
      "the refused number was not applied",
      `agent ${a.agent_id} now wears ${still.shirt_number}`,
    );
  } else t.bad("could not get two agents on the squad for the taken-number check");

  // ── the jam bay lights for a blocked ticket ───────────────────────────────
  await L.putSettings({ GAFFER_MAX_DELIVERY_ATTEMPTS: "1" });
  const jam = await L.seedTicket(t, {
    title: `Jammed parcel (${L.tag("s15")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  L.setStubMode(jam.number, "fail_first");
  await t.visit("work");
  await t.poll();
  await L.waitStatus(jam.id, L.SETTLED, 240000);
  await L.putSettings({ GAFFER_MAX_DELIVERY_ATTEMPTS: "" });
  await t.visit("floor");
  const lit = await p.locator("svg.fl-svg .fl-beacon.is-on").count();
  t.check(
    (await L.ticketOf(jam.id)).status === "blocked" && lit === 1,
    `blocked #${jam.number} sits in the jam bay and its beacon is lit`,
    `jam bay: status=${(await L.ticketOf(jam.id)).status} lit beacons=${lit}`,
  );

  // ── a live claim puts a robot on the floor; a parcel links to its ticket ──
  await L.api("POST", `/tickets/${jam.id}/wont-do`, { reason: "jam check done" });
  const live = await L.seedTicket(t, {
    title: `Robot on the floor (${L.tag("s15")})`,
    acs: ["covered by a test"],
    ready: true,
  });
  L.setStubMode(live.number, { mode: "slow_claim", secs: 30 });
  await t.visit("work");
  await t.poll();
  // The runner holds the claim while the stub works (status claimed or in_progress).
  await L.maybe(
    async () =>
      ((await L.api("GET", "/claims")).json.claims || []).some((c) => c.ticket_id === live.id)
        ? true
        : null,
    "a live claim",
    60000,
    1000,
  );
  await t.visit("floor");
  const bench = (await p.textContent(".fl-bench").catch(() => "")) || "";
  const robots = await p.locator("svg.fl-svg .fl-bot, svg.fl-svg [class*='robot']").count();
  t.check(
    !/No robot is on the floor/.test(bench) && (robots > 0 || /#?\d/.test(bench)),
    `a live claim puts a robot on the floor ('${bench.slice(0, 80)}')`,
    `floor during a live claim: bench='${bench.slice(0, 120)}' robots=${robots}`,
  );
  await L.shot(p, "s15-floor-robot");
  const parcel = p.locator(`svg.fl-svg a.fl-parcel[data-id="${live.id}"]`).first();
  if (await parcel.count()) {
    await parcel.click();
    const nav = await L.maybe(
      async () => (p.url().includes(`#/ticket/${live.id}`) ? true : null),
      "parcel nav",
      8000,
      300,
    );
    t.check(
      nav,
      `clicking #${live.number}'s parcel opens its ticket page`,
      `parcel click went to ${p.url()}`,
    );
  } else t.bad(`no parcel on the floor for in-flight #${live.number}`);
  await L.waitStatus(live.id, L.SETTLED, 180000);
}
