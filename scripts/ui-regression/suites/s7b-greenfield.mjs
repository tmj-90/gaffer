// S7b greenfield — OWN SERVER: an EMPTY factory (no repo onboarded: `onboard = false`),
// GAFFER_BOOTSTRAP_ROOT a throwaway dir, the canned decompose bin.
//   1. #/epics → Plan a build → New app → a greenfield brief → 'Build the tickets now':
//      the plan leads with the bootstrap ticket and names the new repo (task-app);
//      Create & ready posts the epic with the repo links deferred to the bootstrap.
//   2. Poll: only the bootstrap is claimable (the rest depend on it); the runner
//      CREATES <root>/task-app (git init + baseline), the stub scaffolds it on the
//      delivery branch, the repo is registered + onboarded, the ticket is in review.
//   3. The Factory Map lists task-app, the Work board shows the plan's tickets, the
//      Floor draws the bootstrap's parcel.
//   4. Approve + Merge now: the scaffold lands on task-app's main, the bootstrap is
//      done and its dependents are now claimable against the new repo.
// The tester lane is on (GAFFER_TESTING=1): the plan's tickets are created testable
// with nobody running `wg ticket set-testable`, the bootstrap is not.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const server = { env: { GAFFER_TESTING: "1" }, fixtures: ["bootstrap-root"] };
export const onboard = false;
export const needsRepo = false;

export default async function s7b(t, L) {
  const p = t.page;
  const root = path.join(path.dirname(L.REPO_PATH), "greenfield");
  const dir = path.join(root, "task-app");
  const panel = '.pb-panel[aria-label="Plan a build"]';
  const repos = async () => (await L.api("GET", "/repositories")).json.repositories || [];

  t.check(
    (await repos()).length === 0,
    "the factory starts with no registered repo",
    `repos already registered: ${(await repos()).map((r) => r.name).join(", ")}`,
  );

  // ── 1. plan a brand-new app ───────────────────────────────────────────────
  await t.visit("epics");
  await p.locator('.view button:has-text("Plan a build")').first().click();
  await p.waitForSelector(panel, { timeout: 10000 });
  await p
    .locator(`${panel} .pb-new-plan`)
    .click()
    .catch(() => {});
  const newApp = p.locator(`${panel} .mode-option:has-text("New app") input`);
  if (await newApp.count()) await newApp.check();
  await p.fill(`${panel} .pb-input`, `A greenfield task app ${L.tag("s7b")}`);
  await p.locator(`${panel} .pb-send`).click();
  await L.maybe(
    async () =>
      (await p
        .locator(`${panel} .pb-force`)
        .isEnabled()
        .catch(() => false)) || null,
    "force enabled",
    20000,
    300,
  );
  await p.locator(`${panel} .pb-force`).click();
  const shown = await L.maybe(
    async () =>
      (await p.locator('.pb-confirm-actions button:has-text("Create & ready")').count())
        ? true
        : null,
    "plan on screen",
    20000,
    400,
  );
  const planTxt = (await p.textContent(panel).catch(() => "")) || "";
  t.check(
    shown && /Bootstrap the task app/.test(planTxt) && /bootstrap/i.test(planTxt),
    "a New app plan leads with its bootstrap ticket (badged bootstrap)",
    `greenfield plan: shown=${Boolean(shown)} '${planTxt.slice(0, 200)}'`,
  );
  await L.shot(p, "s7b-plan");
  const eP = p.waitForResponse(
    (r) => r.url().endsWith("/epics") && r.request().method() === "POST",
    { timeout: 15000 },
  );
  await p.locator('.pb-confirm-actions button:has-text("Create & ready")').click();
  const er = await eP.catch(() => null);
  const body = er ? JSON.parse(er.request().postData() || "{}") : {};
  const boot = (body.tickets || [])[0] || {};
  t.check(
    er &&
      er.status() < 300 &&
      boot.bootstrap === true &&
      boot.source === "task-app" &&
      !boot.repo &&
      (body.tickets || []).slice(1).every((x) => !x.repo && x.source === "task-app"),
    "Create & ready posted the epic: the bootstrap first, every repo link deferred to it (source task-app)",
    `POST /epics: ${er && er.status()} ${JSON.stringify(body).slice(0, 300)}`,
  );
  await p.keyboard.press("Escape").catch(() => {});
  const bt = await L.maybe(
    async () =>
      (await L.listTickets()).find(
        (x) => x.title === "Bootstrap the task app" && x.status === "ready",
      ),
    "bootstrap ready",
    20000,
    500,
  );
  const planned = (await L.listTickets()).filter((x) => x.status !== "cancelled");
  planned.forEach((x) => t.created.add(x.id));
  if (!bt) return t.bad("the bootstrap ticket is not ready after Create & ready");
  // The tester lane is on: every planned implementation ticket is testable, the
  // bootstrap is not, and nobody marked one by hand.
  const flags = await Promise.all(
    planned.map(async (x) => [x, (await L.ticketOf(x.id)).can_be_tested]),
  );
  const impl = flags.filter(([x]) => x.id !== bt.id && !/^Acceptance:/.test(x.title));
  t.check(
    impl.length > 0 &&
      impl.every(([, f]) => f === 1) &&
      flags.find(([x]) => x.id === bt.id)?.[1] === 0 &&
      (body.tickets || []).every((x) => x.testable === undefined),
    "with the tester lane on, the plan's tickets were created testable (the bootstrap not) without set-testable",
    `testable flags: ${JSON.stringify(flags.map(([x, f]) => [x.title, f]))}`,
  );

  // ── 2. Poll: the bootstrap creates the repo ───────────────────────────────
  await t.visit("work");
  await t.poll();
  const st = await L.waitStatus(bt.id, ["in_review", "blocked", "refining", "failed"], 240000);
  await L.maybe(
    async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
    "tick done",
    120000,
    1000,
  );
  const deliveries = L.stubCalls({ kind: "delivery" }).length;
  t.check(
    st?.status === "in_review" &&
      L.stubCalls({ kind: "bootstrap", ticket: bt.number }).length === 1 &&
      deliveries === 0,
    `Poll claimed only the bootstrap (#${bt.number}): the stub scaffolded it and it waits in review`,
    `bootstrap #${bt.number}: status=${st?.status} bootstrap calls=${L.stubCalls({ kind: "bootstrap" }).length} other deliveries=${deliveries}`,
  );
  const branch = (await L.ticketOf(bt.id)).branch_name || "";
  const onDisk =
    existsSync(path.join(dir, ".git")) &&
    /^gaffer\/ticket-\d+-/.test(branch) &&
    L.git(dir, "show", `${branch}:package.json`).includes('"test"');
  t.check(
    onDisk,
    `the runner created the repo under GAFFER_BOOTSTRAP_ROOT (${dir}) and the scaffold is committed on ${branch}`,
    `new repo at ${dir}: exists=${existsSync(dir)} branch='${branch}'`,
  );
  const reg = (await repos()).find((r) => r.name === "task-app");
  t.check(
    reg && path.resolve(reg.local_path || "") === dir,
    "task-app is registered (onboarded) at that path",
    `registered repos: ${JSON.stringify((await repos()).map((r) => [r.name, r.local_path]))}`,
  );

  // ── 3. Map, Work board, Floor ─────────────────────────────────────────────
  await t.visit("factory");
  const map = (await p.textContent("#app").catch(() => "")) || "";
  t.check(
    /task-app/.test(map),
    "the Factory Map shows the new repo task-app",
    `the Factory Map does not name task-app ('${map.slice(0, 200)}')`,
  );
  await t.visit("work");
  const board = (await p.textContent("#app").catch(() => "")) || "";
  t.check(
    /Bootstrap the task app/.test(board) && /Add an archive helper/.test(board),
    "the Work board shows the bootstrap and the tickets waiting on it",
    `the Work board: '${board.slice(0, 200)}'`,
  );
  await t.visit("floor");
  const parcel = await p.locator(`svg.fl-svg a.fl-parcel[data-id="${bt.id}"]`).count();
  t.check(
    parcel > 0,
    `the Floor draws #${bt.number}'s parcel`,
    `no parcel on the Floor for #${bt.number}`,
  );
  await L.shot(p, "s7b-floor");

  // ── 4. approve + merge: the scaffold lands, the dependents unblock ────────
  const ap = await t.approve(bt);
  if (ap?.status === "ready_for_merge") {
    await t.visit(`ticket/${bt.id}`, { label: "ticket/:id" });
    await p.locator('button:has-text("Merge now")').first().click();
  }
  const done = await L.waitStatus(bt.id, ["done"], 120000, 1500);
  const mainHasScaffold = (() => {
    try {
      return L.git(dir, "show", "main:package.json").includes('"test"');
    } catch {
      return false;
    }
  })();
  t.check(
    done && mainHasScaffold,
    `#${bt.number} approved and merged: the scaffold is on task-app's main`,
    `bootstrap after approve: ${(await L.ticketOf(bt.id)).status}; main has package.json=${mainHasScaffold}`,
  );
  const dep = planned.find((x) => x.title === "Add an archive helper for completed tasks");
  if (dep) {
    const c = await L.maybe(
      async () => {
        const r = (await L.api("GET", `/tickets/${dep.id}/claimability`)).json;
        return r.ready === true ? r : null;
      },
      "dependent claimable",
      20000,
      1000,
    );
    const view = await L.ticketView(dep.id);
    t.check(
      c && (view.repositories || []).some((r) => r.name === "task-app"),
      `#${dep.number} (it depended on the bootstrap) is now claimable, linked to task-app`,
      `dependent #${dep.number}: claimability=${JSON.stringify(c)} repos=${JSON.stringify((view.repositories || []).map((r) => r.name))}`,
    );
  }
  const log = (() => {
    try {
      return readFileSync(path.join(L.GAFFER_DATA, "factory.log"), "utf8");
    } catch {
      return "";
    }
  })();
  if (!/BOOTSTRAP: registered \+ onboarded new repo 'task-app'/.test(log))
    t.note("the factory log has no 'registered + onboarded new repo task-app' line");
}
