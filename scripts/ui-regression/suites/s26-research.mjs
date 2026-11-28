// S26 research first (backlog 69; canned GAFFER_RESEARCH_BIN, no model, no network).
// #/create, the Plan a build page:
//   - the "Research this idea on the web first" box is there, UNCHECKED; sending a brief
//     unticked goes to the planner and creates NO research run;
//   - New plan, tick the box, send the brief: ONE research run is created; its card
//     shows the editable features; a feature is dropped, one renamed and one added, and
//     saved; a reload shows the same run (no second paid run);
//   - "Draft the spec from this" opens the spec step on the drafted clauses (must and
//     should kept as requirements, wont as a non-goal, the kept question as a
//     decision); Create spec saves them onto that draft and Freeze freezes it;
//   - a read token sees the box switched off;
//   - a 2x screenshot of the research card for docs/FEATURES.md.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const server = {
  env: {
    GAFFER_RESEARCH_BIN: "${HERE}/suites/bin/research-stub.mjs",
    GAFFER_SANDBOX_STATUS_CMD: '["node","${HERE}/suites/bin/isolation-ok.mjs"]',
  },
  fixtures: [],
};

export default async function s26(t, L) {
  const p = t.page;
  const researchCalls = () => {
    try {
      return readFileSync(path.join(L.GAFFER_DATA, "research-calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const planCalls = () => {
    try {
      return readFileSync(path.join(L.GAFFER_DATA, "decompose-calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const runs = async () => (await L.api("GET", "/research")).json.research || [];
  const PANEL = '.pb-panel[aria-label="Plan a build"]';

  await t.visit("create");
  const box = p.locator(`${PANEL} .pb-research-box`);
  const ready = await L.maybe(
    async () => ((await box.count()) && !(await box.isDisabled()) ? true : null),
    "research box",
    15000,
    300,
  );
  t.check(
    ready,
    "the Plan a build brief form has an enabled 'Research this idea on the web first' box",
    "the research box is missing or disabled",
  );
  t.check(
    !(await box.isChecked()),
    "the research box is unchecked by default",
    "the research box starts ticked",
  );

  // ── unticked: the planner, no research ───────────────────────────────────────
  const before = planCalls().length;
  await p.fill(`${PANEL} .pb-input`, "Archive completed tasks instead of deleting them");
  await p.locator(`${PANEL} .pb-send`).click();
  const planned = await L.maybe(
    async () => (planCalls().length > before ? true : null),
    "planner call",
    20000,
    400,
  );
  t.check(
    planned && (await runs()).length === 0 && researchCalls().length === 0,
    "unticked, the brief went to the planner and no research run was created",
    `planner called=${Boolean(planned)} runs=${(await runs()).length}`,
  );

  // ── ticked: one research run ───────────────────────────────────────────────────
  // Every request the page makes from here on: none may go to a host a research result
  // names (the dashboard never fetches a research URL, an image included).
  const requests = [];
  p.on("request", (r) => requests.push(r.url()));
  await p.locator(`${PANEL} .pb-new-plan`).click();
  await L.sleep(800);
  await box.check();
  await p.fill(`${PANEL} .pb-input`, "Archive completed tasks instead of deleting them");
  await p.locator(`${PANEL} .pb-send`).click();
  const card = await L.maybe(
    async () => ((await p.locator(`${PANEL} .rs-feature`).count()) >= 4 ? true : null),
    "research card",
    30000,
    500,
  );
  t.check(
    card && (await runs()).length === 1 && researchCalls().length === 1,
    "ticked, the brief started one research run and its features are on screen",
    `card=${Boolean(card)} runs=${(await runs()).length} calls=${researchCalls().length}`,
  );
  if (!card) return;
  const links = await p
    .locator(`${PANEL} .rs-card a`)
    .evaluateAll((as) => as.map((a) => [a.getAttribute("href"), a.getAttribute("rel")]));
  t.check(
    links.length > 0 &&
      links.every(([h, r]) => /^https:\/\//.test(h) && r === "noopener noreferrer"),
    `every research link is https with rel="noopener noreferrer" (${links.length})`,
    `links: ${JSON.stringify(links)}`,
  );
  t.check(
    (await p.locator(`${PANEL} .rs-card img, ${PANEL} .rs-card iframe`).count()) === 0,
    "the research card holds no image or embed",
    "an image or embed was rendered from research",
  );
  // The hostile finding: its markup is text, no element came from it, nothing ran, and the
  // only links are https sources that passed the rules.
  const hostile = await p.locator(`${PANEL} .rs-card`).evaluate((card) => {
    const tags = new Set();
    for (const el of card.querySelectorAll("*")) tags.add(el.tagName.toLowerCase());
    return {
      text: card.textContent || "",
      tags: [...tags],
      pwned: globalThis.__pwned ?? null,
      hrefs: [...card.querySelectorAll("a")].map((a) => a.getAttribute("href")),
    };
  });
  const allowedTags = new Set([
    "div",
    "span",
    "p",
    "ul",
    "ol",
    "li",
    "a",
    "button",
    "input",
    "label",
    "select",
    "option",
    "textarea",
    "h2",
    "h3",
    "h4",
    "strong",
    "em",
    "small",
    "details",
    "summary",
    "section",
    "header",
    "footer",
    "form",
    "fieldset",
    "legend",
    "br",
    "b",
  ]);
  const badTags = hostile.tags.filter((tg) => !allowedTags.has(tg));
  t.check(
    hostile.text.includes('<img src="https://img.hostile-research.dev/p.png"') &&
      hostile.text.includes("<script>") &&
      badTags.length === 0 &&
      hostile.pwned === null &&
      hostile.hrefs.every((h) => /^https:\/\/[^@/]+\//.test(h)),
    "a hostile result renders as inert text: no element from it, nothing runs, only safe https links",
    `tags beyond the card's own: ${JSON.stringify(badTags)} pwned=${hostile.pwned} hrefs=${JSON.stringify(hostile.hrefs)}`,
  );
  const leaked = requests.filter((u) =>
    /(?:^|\/\/|\.)(?:todoist\.com|reddit\.com|hostile-research\.dev)(?:[:/]|$)/.test(u),
  );
  t.check(
    leaked.length === 0,
    `the page made no request to any research URL (${requests.length} requests seen)`,
    `requests to research hosts: ${JSON.stringify(leaked.slice(0, 5))}`,
  );

  // A 2x picture of the card for the docs.
  try {
    const ctx = await t.browser.newContext({
      viewport: { width: 1200, height: 1400 },
      deviceScaleFactor: 2,
    });
    const pg = await ctx.newPage();
    await pg.route("https://fonts.googleapis.com/**", (r) => r.abort());
    await pg.route("https://fonts.gstatic.com/**", (r) => r.abort());
    await pg.goto(`${L.BASE}/?token=${L.TOKEN}#/create`, { waitUntil: "load" });
    await pg.waitForSelector(`${PANEL} .rs-feature`, { timeout: 20000 });
    await pg
      .locator(`${PANEL} .rs-card`)
      .screenshot({ path: path.join(L.OUT, "research-card-2x.png") });
    await ctx.close();
  } catch (e) {
    t.check(false, "", `2x screenshot failed: ${e && e.message}`);
  }

  // ── a person's edits, saved; a reload keeps the same run ─────────────────────────
  const rows = p.locator(`${PANEL} .rs-feature`);
  await rows.nth(1).locator(".rs-keep").uncheck();
  await rows.nth(0).locator(".rs-title-input").fill("Archive a task when it is completed");
  await p.locator(`${PANEL} .rs-add`).click();
  await p
    .locator(`${PANEL} .rs-feature`)
    .last()
    .locator(".rs-title-input")
    .fill("Show archived tasks in their own list");
  const sP = p.waitForResponse(
    (r) => /\/research\/[^/]+$/.test(r.url()) && r.request().method() === "PATCH",
    { timeout: 10000 },
  );
  await p.locator(`${PANEL} button:has-text("Save changes")`).click();
  const sr = await sP.catch(() => null);
  const saved = (await runs())[0];
  t.check(
    sr &&
      sr.status() === 200 &&
      saved.features.length === 5 &&
      saved.features[1].kept === false &&
      saved.features[0].title === "Archive a task when it is completed",
    "dropping, renaming and adding a feature were saved",
    `save: ${sr && sr.status()} ${JSON.stringify(saved && saved.features).slice(0, 200)}`,
  );
  await p.reload({ waitUntil: "load" });
  const again = await L.maybe(
    async () => ((await p.locator(`${PANEL} .rs-feature`).count()) === 5 ? true : null),
    "research after reload",
    20000,
    500,
  );
  t.check(
    again && (await runs()).length === 1 && researchCalls().length === 1,
    "a reload shows the same research run and starts no second one",
    `after reload: card=${Boolean(again)} runs=${(await runs()).length} calls=${researchCalls().length}`,
  );

  // ── draft the spec, create, freeze ─────────────────────────────────────────────
  await p.locator(`${PANEL} .rs-draft`).click();
  const spec = await L.maybe(
    async () => ((await p.locator(".sb-clauses li").count()) >= 4 ? true : null),
    "spec clauses",
    20000,
    400,
  );
  const texts = await p
    .locator(".sb-clauses li textarea, .sb-clauses li input[type=text]")
    .evaluateAll((els) => els.map((e) => e.value));
  t.check(
    spec &&
      texts.some((x) => /Archive a task when it is completed/.test(x)) &&
      texts.some((x) => /Show archived tasks/.test(x)) &&
      texts.some((x) => /To decide:/.test(x)) &&
      !texts.some((x) => /Undo an archive|Search the archive/.test(x)),
    "'Draft the spec from this' opened the spec step on the kept items (no dropped or could feature)",
    `spec clauses: ${JSON.stringify(texts).slice(0, 300)}`,
  );
  const pP = p.waitForResponse(
    (r) => /\/specs\/[^/]+$/.test(r.url()) && r.request().method() === "PATCH",
    { timeout: 10000 },
  );
  await p.locator(".sb-create").click();
  const pr = await pP.catch(() => null);
  t.check(
    pr && pr.status() === 200,
    "Create spec saved the clauses onto the drafted spec",
    `create: ${pr && pr.status()}`,
  );
  const fP = p.waitForResponse((r) => /\/specs\/[^/]+\/freeze$/.test(r.url()), { timeout: 10000 });
  await p.locator(".sb-freeze").click();
  const fr = await fP.catch(() => null);
  const specId = (await runs())[0].spec_id;
  const frozen = specId ? (await L.api("GET", `/specs/${specId}`)).json.spec : null;
  t.check(
    fr && frozen && frozen.status === "frozen",
    "Freeze froze the spec drafted from research",
    `freeze: ${fr && fr.status()} ${frozen && frozen.status}`,
  );

  // ── a read token: the box is off ────────────────────────────────────────────────
  const readTok = execFileSync(
    "node",
    [path.join(L.ROOT, "packages/dispatch/dist/api/bin.js"), "print-read-token"],
    { env: { ...process.env, DISPATCH_API_TOKEN: L.TOKEN, GAFFER_DATA: L.GAFFER_DATA } },
  )
    .toString()
    .trim();
  {
    const rp = await t.open({ token: readTok, route: "create" });
    const rbox = rp.locator(`${PANEL} .pb-research-box`);
    const off = await L.maybe(
      async () => ((await rbox.count()) && (await rbox.isDisabled()) ? true : null),
      "read box",
      15000,
      300,
    );
    t.check(
      off,
      "a read token sees the research box switched off",
      "a read token could tick the research box",
    );
  }
}
