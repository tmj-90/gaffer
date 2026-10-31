// S17 conflict re-review — OWN SERVER (its merges rewrite the sample repo's main, and a
// held resolution leaves a side ref behind). Three deliveries in stub mode `conflict`
// rewrite line 1 of src/tasks.js (addTask) and append their helper, so each conflicts
// with whatever landed before it:
//   1. #A, #B, #C delivered and in review; #A approved + Merge now → done.
//   2. #B approved + Merge now → the merge conflicts → the resolver (the stub merges main
//      in and resolves) commits ON the branch → the RE-GATE runs (no markers, the DoD
//      gates on a clean checkout of the resolved head) → #B is back in Review, with the
//      'Merge conflict resolved' flag, a fresh DoD evidence row and the timeline's
//      'Reopened for review'. Re-approved + Merge now → done; main carries both helpers
//      and no marker.
//   3. #C's resolver commits the conflict MARKERS (stub option resolver:"markers"): the
//      re-gate holds it — not reopened, not landed, the resolution parked on
//      refs/gaffer/conflict-resolved/<n>, the branch put back, main clean.
// Review-view assertions stay at status, the flag/banner's presence and evidence rows
// (the view is being reworked by other packages).
import { readFileSync } from "node:fs";
import path from "node:path";

export const server = { env: {}, fixtures: [] };

const MARKER = /^(<<<<<<<|>>>>>>>|=======$)/m;

export default async function s17(t, L) {
  const p = t.page;
  const idle = () =>
    L.maybe(
      async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
      "runs to finish",
      240000,
      1000,
    );
  const evidence = async (id) => {
    const v = await L.ticketView(id);
    return v.evidence || v.ac_evidence || [];
  };
  const regateRows = async (id) =>
    (await evidence(id)).filter((e) => /conflict resolution re-gate/.test(e.summary || ""));
  const events = async (id) => {
    const r = (await L.api("GET", `/tickets/${id}/events`)).json;
    return Array.isArray(r) ? r : r.events || [];
  };
  const mainFile = (f) => L.git(L.REPO_PATH, "show", `main:${f}`);
  const mergeNow = async (tk) => {
    await t.visit(`ticket/${tk.id}`, { label: "ticket/:id" });
    await p.locator('button:has-text("Merge now")').first().click();
  };

  // ── seed three conflicting deliveries ─────────────────────────────────────
  const seed = async (title, mode) => {
    const tk = await L.seedTicket(t, {
      title: `${title} (${L.tag("s17")})`,
      acs: ["covered by a test"],
    });
    L.setStubMode(tk.number, mode);
    await L.api("POST", `/tickets/${tk.id}/ready`);
    return tk;
  };
  const a = await seed("Conflict A", "conflict");
  const b = await seed("Conflict B", "conflict");
  const c = await seed("Conflict C", { mode: "conflict", resolver: "markers" });
  await t.visit("work");
  for (let i = 0; i < 4; i++) {
    const open = [];
    for (const x of [a, b, c]) if ((await L.ticketOf(x.id)).status === "ready") open.push(x);
    if (!open.length) break;
    await t.poll();
    await L.maybe(
      async () => ((await L.ticketOf(open[0].id)).status !== "ready" ? true : null),
      "a claim",
      60000,
      1000,
    );
    await idle();
  }
  const sts = await Promise.all([a, b, c].map(async (x) => (await L.ticketOf(x.id)).status));
  t.check(
    sts.every((s) => s === "in_review"),
    `#${a.number}, #${b.number} and #${c.number} delivered (each rewrote addTask) and wait in review`,
    `deliveries: ${sts.join(", ")}`,
  );
  if (!sts.every((s) => s === "in_review")) return;

  // ── 1. #A lands ───────────────────────────────────────────────────────────
  const aa = await t.approve(a);
  if (aa?.status === "ready_for_merge") await mergeNow(a);
  const aDone = await L.waitStatus(a.id, ["done"], 120000, 1500);
  t.check(
    aDone && mainFile("src/tasks.js").split("\n")[0].includes(`conflict ${a.number} `),
    `#${a.number} approved + Merge now → done (main's addTask is now #${a.number}'s)`,
    `#${a.number} after Merge now: ${(await L.ticketOf(a.id)).status}`,
  );

  // ── 2. #B conflicts → resolver → re-gate → back in Review ─────────────────
  const regBefore = (await regateRows(b.id)).length;
  const ba = await t.approve(b);
  if (ba?.status !== "ready_for_merge")
    return t.bad(`approving #${b.number}: '${ba?.status ?? (await L.ticketOf(b.id)).status}'`);
  await mergeNow(b);
  const back = await L.maybe(
    async () => {
      const s = (await L.ticketOf(b.id)).status;
      return s === "in_review" || s === "done" || s === "blocked" ? s : null;
    },
    "the resolver",
    180000,
    1500,
  );
  const resolverCalls = L.stubCalls({ kind: "resolver", ticket: b.number });
  t.check(
    back === "in_review" && resolverCalls.length === 1,
    `Merge now on #${b.number} hit the conflict: the resolver ran once and #${b.number} is back in review (not landed)`,
    `#${b.number} after Merge now: '${back}', resolver calls=${resolverCalls.length}`,
  );
  // The re-gate's checklist is recorded just AFTER the reopen (the newest row the
  // reviewer reads), so it can trail the status flip by a moment.
  const fresh =
    (await L.maybe(
      async () => {
        const rows = (await regateRows(b.id)).slice(regBefore);
        return rows.length ? rows : null;
      },
      "the re-gate evidence",
      20000,
      500,
    )) || [];
  t.check(
    fresh.length >= 1 && /re-run on a clean checkout of the resolved head/.test(fresh[0].summary),
    `the re-gate ran on the resolved head and recorded a fresh DoD evidence row ("${(fresh[0]?.summary || "").split("\n").pop().slice(0, 110)}")`,
    `no fresh re-gate evidence on #${b.number}: ${JSON.stringify((await evidence(b.id)).map((e) => (e.summary || "").slice(0, 80))).slice(0, 400)}`,
  );
  const evs = await events(b.id);
  t.check(
    evs.some((e) => e.event_type === "ticket.reopened_for_review"),
    `#${b.number}'s timeline records 'Reopened for review'`,
    `#${b.number} events: ${evs
      .map((e) => e.event_type)
      .slice(-8)
      .join(", ")}`,
  );
  const branch = (await L.ticketOf(b.id)).branch_name;
  const resolved = L.git(L.REPO_PATH, "show", `${branch}:src/tasks.js`);
  t.check(
    !MARKER.test(resolved) &&
      resolved.includes(`helper${a.number}`) &&
      resolved.includes(`helper${b.number}`),
    `the resolution on ${branch} keeps both sides (helper${a.number} and helper${b.number}) with no conflict marker`,
    `resolved src/tasks.js on ${branch}:\n${resolved.slice(0, 400)}`,
  );
  await t.visit(`review/${b.id}`, { label: "review/:id" });
  const rv = await L.maybe(
    async () => {
      const txt = (await p.textContent("#app").catch(() => "")) || "";
      return /Merge conflict resolved/.test(txt) ? txt : null;
    },
    "the conflict flag",
    15000,
    500,
  );
  t.check(
    rv,
    `Review shows #${b.number} with the 'Merge conflict resolved' flag`,
    `Review of #${b.number} has no 'Merge conflict resolved' flag`,
  );
  await L.shot(p, "s17-review-resolved");
  await t.visit(`ticket/${b.id}`, { label: "ticket/:id" });
  const tv = (await p.textContent("#app").catch(() => "")) || "";
  t.check(
    /Merge conflict resolved on the branch/.test(tv),
    `the ticket page carries the re-review banner for #${b.number}`,
    `ticket page of #${b.number}: '${tv.slice(0, 200)}'`,
  );
  const bb = await t.approve(b);
  if (bb?.status === "ready_for_merge") await mergeNow(b);
  const bDone = await L.waitStatus(b.id, ["done"], 120000, 1500);
  const main = mainFile("src/tasks.js");
  t.check(
    bDone &&
      !MARKER.test(main) &&
      main.includes(`helper${a.number}`) &&
      main.includes(`helper${b.number}`),
    `re-approved #${b.number} landed: main has both helpers and no conflict marker`,
    `#${b.number}: ${(await L.ticketOf(b.id)).status}; main:\n${main.slice(0, 300)}`,
  );

  // ── 3. a resolution with committed markers is HELD ────────────────────────
  const cBranch = (await L.ticketOf(c.id)).branch_name;
  const cHead = L.git(L.REPO_PATH, "rev-parse", cBranch).trim();
  const mainBeforeC = L.git(L.REPO_PATH, "rev-parse", "main").trim();
  const ca = await t.approve(c);
  if (ca?.status !== "ready_for_merge")
    return t.bad(`approving #${c.number}: '${ca?.status ?? (await L.ticketOf(c.id)).status}'`);
  await mergeNow(c);
  await L.maybe(
    async () => (L.stubCalls({ kind: "resolver", ticket: c.number }).length ? true : null),
    "the markers resolver",
    120000,
    1000,
  );
  const held = await L.maybe(
    async () => {
      const ev = await evidence(c.id);
      return ev.some((e) => /re-gate FAILED/.test(e.summary || "")) ? ev : null;
    },
    "the failed re-gate",
    120000,
    1500,
  );
  await L.sleep(1500);
  const cNow = (await L.ticketOf(c.id)).status;
  const sideRef = `refs/gaffer/conflict-resolved/${c.number}`;
  const side = (() => {
    try {
      return L.git(L.REPO_PATH, "rev-parse", "--verify", "-q", sideRef).trim();
    } catch {
      return "";
    }
  })();
  t.check(
    held && !["in_review", "done"].includes(cNow),
    `#${c.number}'s resolver committed conflict markers: the re-gate FAILED it and it is held ('${cNow}'), not reopened and not landed`,
    `#${c.number} after a markers resolution: status '${cNow}', re-gate failure evidence=${Boolean(held)}`,
  );
  t.check(
    side &&
      MARKER.test(L.git(L.REPO_PATH, "show", `${side}:src/tasks.js`)) &&
      L.git(L.REPO_PATH, "rev-parse", cBranch).trim() === cHead &&
      L.git(L.REPO_PATH, "rev-parse", "main").trim() === mainBeforeC &&
      !MARKER.test(mainFile("src/tasks.js")),
    `the bad resolution was parked on ${sideRef}, ${cBranch} put back to its delivered head, main untouched and marker-free`,
    `side ref '${side}', branch head ${L.git(L.REPO_PATH, "rev-parse", cBranch).trim().slice(0, 12)} (was ${cHead.slice(0, 12)}), main moved=${L.git(L.REPO_PATH, "rev-parse", "main").trim() !== mainBeforeC}`,
  );
  const why = (held || []).find((e) => /re-gate FAILED/.test(e.summary || ""));
  t.check(
    why && /conflict markers/.test(why.summary),
    `the held reason names the markers ("${((why?.summary || "").split("\n").find((l) => /FAILED/.test(l)) || "").slice(0, 120)}")`,
    `the re-gate failure does not name the markers: ${(why?.summary || "").slice(0, 200)}`,
  );
  await t.visit(`ticket/${c.id}`, { label: "ticket/:id" });
  await L.shot(p, "s17-markers-held");
  // The factory log's line for the held merge, for the record.
  try {
    const log = readFileSync(path.join(L.GAFFER_DATA, "factory.log"), "utf8");
    const line = log
      .split("\n")
      .filter((l) => new RegExp(`#${c.number}\\b.*(re-gate|resolver)`).test(l))
      .pop();
    if (line) t.note(`factory log: ${line.slice(0, 200)}`);
  } catch {
    /* no log */
  }
}
