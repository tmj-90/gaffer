// S12b idle lanes + GitHub issue ingest — OWN SERVER: a recording fake `gh` first on
// PATH serving labelled issues, the sample repo's origin on github.com (onboarding
// records it, so ingest resolves acme/taskflow-mini), and crew.yaml's
// ingest.github.enabled on (the operator's edit: Settings → Idle loops has no ingest
// switch). With nothing ready:
//   1. Settings → Idle loops (the UI): maintenance on, exactly two lanes (tech debt,
//      documentation); the status line says each idle tick runs ONE of the 2 lanes,
//      rotating by priority; Save writes crew.yaml.
//   2. Poll: the two `agent-ok` issues become DRAFTS (title, body, Source link, their
//      labels), the unlabelled one does not; each ingested issue is relabelled
//      agent-queued; the lane that ran is the higher-priority one (tech debt).
//   3. Poll again: no duplicate drafts, and the lane ROTATED to documentation — as
//      the status line said.
//   4. The Work board's drafts and the ticket page show them.
// The other five lanes, the feature backlog and the legacy IDLE_DRAFT_WHEN_IDLE scan
// need planted findings of their own; the golden path drives tech debt end to end.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const server = { env: {}, fixtures: ["fake-gh", "github-origin", "ingest-on"] };

const ISSUES = [
  {
    number: 41,
    title: "Tasks lose their order after a reload",
    body: "Steps: add three tasks, reload; the order changes.",
    labels: ["agent-ok", "bug"],
  },
  {
    number: 42,
    title: "Let a task carry a due date",
    body: "A task should accept an optional due date.",
    labels: ["agent-ok", "enhancement"],
  },
  {
    number: 43,
    title: "Discuss the colour of the done tick",
    body: "Not for the factory.",
    labels: ["question"],
  },
];

export default async function s12b(t, L) {
  const p = t.page;
  const ST = process.env.FAKE_GH_STATE;
  if (!ST) return t.bad("no FAKE_GH_STATE (the fake-gh fixture did not run)");
  const url = (n) => `https://github.com/acme/taskflow-mini/issues/${n}`;
  writeFileSync(
    path.join(ST, "issues.json"),
    JSON.stringify(
      ISSUES.map((i) => ({
        ...i,
        url: url(i.number),
        state: "OPEN",
        labels: i.labels.map((name) => ({ name })),
      })),
      null,
      2,
    ),
  );
  const ghCalls = (cmd) => {
    try {
      return readFileSync(path.join(ST, "calls.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((c) => !cmd || c.cmd === cmd);
    } catch {
      return [];
    }
  };
  const log = () => {
    try {
      return readFileSync(path.join(L.GAFFER_DATA, "factory.log"), "utf8");
    } catch {
      return "";
    }
  };
  const chosen = () => [...log().matchAll(/maintenance lane chose '([a-z_]+)'/g)].map((m) => m[1]);
  const idle = () =>
    L.maybe(
      async () => ((await L.api("GET", "/api/runs")).json.active || []).length === 0,
      "runs",
      180000,
      1000,
    );
  const ingested = async () =>
    (await L.listTickets()).filter((x) => ISSUES.some((i) => x.title === i.title));

  // ── 1. Settings → Idle loops: maintenance + two lanes ─────────────────────
  await t.visit("settings");
  if (!(await p.$("#idle-loops[open]"))) await p.click("#idle-loops > summary");
  const setSwitch = async (selector, on) => {
    const input = p.locator(selector);
    if ((await input.isChecked()) === on) return;
    const label = input.locator("xpath=ancestor::label[1]");
    await label.scrollIntoViewIfNeeded();
    await label.click();
  };
  await setSwitch('[data-testid="maintenance-toggle"]', true);
  for (const key of [
    "idle_security_hotspot",
    "idle_coverage",
    "idle_test_quality",
    "idle_type_quality",
    "idle_dependencies",
    "idle_feature_backlog",
  ])
    await setSwitch(`[data-testid="idle-loop-${key}"]`, false);
  await setSwitch('[data-testid="idle-loop-idle_tech_debt"]', true);
  await setSwitch('[data-testid="idle-loop-idle_documentation"]', true);
  await setSwitch('[data-testid="self-improve-toggle"]', false);
  const statusTxt = (await p.textContent('[data-testid="idle-status"]').catch(() => "")) || "";
  t.check(
    /runs ONE of the 2 enabled lanes, rotating by priority/.test(statusTxt) &&
      /filed as drafts/.test(statusTxt),
    `Settings → Idle loops: the status line says '${statusTxt.trim().slice(0, 120)}'`,
    `Idle loops status line: '${statusTxt.slice(0, 200)}'`,
  );
  await p.click('button:has-text("Save idle loops")');
  const saved = await L.maybe(
    async () => {
      const v = (await L.api("GET", "/api/idle-loops")).json.idle_loops;
      const on = (v?.loops || []).filter((l) => l.enabled && l.maintenanceLane).map((l) => l.key);
      return v?.maintenance?.enabled &&
        on.length === 2 &&
        on.includes("idle_tech_debt") &&
        on.includes("idle_documentation")
        ? v
        : null;
    },
    "idle loops saved",
    10000,
    300,
  );
  t.check(
    saved,
    "Save idle loops wrote maintenance on + the two lanes to crew.yaml",
    "idle loops after Save are not maintenance + tech debt + documentation",
  );

  // ── 2. Poll on an empty queue: ingest + the first lane ────────────────────
  const ingestEvents = () => {
    try {
      return readFileSync(path.join(L.GAFFER_DATA, "events.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.includes('"ingest_'))
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const pollIdle = async () => {
    const n = chosen().length;
    await t.visit("work");
    const toast = await t.poll();
    await L.maybe(
      async () => (chosen().length > n ? true : null),
      "the maintenance tick",
      120000,
      1000,
    );
    await idle();
    return { toast, lane: chosen()[n] };
  };
  const p1 = await pollIdle();
  const first = await ingested();
  first.forEach((x) => t.created.add(x.id));
  const lists = ghCalls("issue list");
  const skipped = ingestEvents().filter((e) => e.type === "ingest_repo_skipped");
  if (skipped.length)
    t.bad(
      `ingest skipped the repo: ${JSON.stringify(skipped.map((e) => e.payload)).slice(0, 200)}`,
    );
  t.check(
    lists.length >= 1 &&
      lists.every((c) => !c.unknown.length) &&
      lists[0].argv.includes("acme/taskflow-mini") &&
      lists[0].argv[lists[0].argv.indexOf("--label") + 1] === "agent-ok",
    `Poll on an empty queue ran ingest: \`gh issue list --repo acme/taskflow-mini --label agent-ok --json ${lists[0]?.fields.join(",")}\` (real fields only)`,
    `gh issue list calls: ${JSON.stringify(lists.map((c) => ({ argv: c.argv, unknown: c.unknown }))).slice(0, 300)}`,
  );
  const wanted = ISSUES.filter((i) => i.labels.includes("agent-ok"));
  const views = await Promise.all(first.map((x) => L.ticketView(x.id)));
  const descOf = (title) => views.find((v) => v.ticket?.title === title)?.ticket?.description || "";
  t.check(
    first.length === 2 &&
      first.every((x) => x.status === "draft") &&
      wanted.every(
        (i) =>
          descOf(i.title).includes(`Source: ${url(i.number)}`) && descOf(i.title).includes(i.body),
      ),
    `the two agent-ok issues became DRAFTS carrying their body and Source link (#${first.map((x) => x.number).join(", #")}); the unlabelled #43 did not`,
    `ingested tickets: ${JSON.stringify(first.map((x) => [x.number, x.title, x.status]))}`,
  );
  t.check(
    wanted.every((i) => descOf(i.title).includes(`Labels: ${i.labels.join(", ")}`)),
    `each draft carries its issue's labels (${wanted.map((i) => i.labels.join("+")).join(" / ")})`,
    `draft descriptions lack the labels: ${JSON.stringify(wanted.map((i) => descOf(i.title).slice(0, 160)))}`,
  );
  const edits = ghCalls("issue edit");
  t.check(
    wanted.every((i) =>
      edits.some(
        (c) =>
          c.argv[2] === String(i.number) &&
          c.argv[c.argv.indexOf("--remove-label") + 1] === "agent-ok" &&
          c.argv[c.argv.indexOf("--add-label") + 1] === "agent-queued",
      ),
    ),
    "each ingested issue was relabelled agent-ok → agent-queued on GitHub",
    `gh issue edit calls: ${JSON.stringify(edits.map((c) => c.argv))}`,
  );
  t.check(
    p1.lane === "tech_debt",
    `the maintenance lane ran the higher-priority enabled lane first (tech_debt)`,
    `first idle tick's lane: '${p1.lane}' (log: ${log()
      .split("\n")
      .filter((l) => /maintenance lane/.test(l))
      .slice(-2)
      .join(" | ")
      .slice(0, 300)})`,
  );

  // ── 3. Poll again: rotation, and no duplicates ────────────────────────────
  // A teammate puts agent-ok back on #41 (or a relabel never landed): the next list
  // returns it again, and identity dedup (the Source marker) must skip it.
  const iss = JSON.parse(readFileSync(path.join(ST, "issues.json"), "utf8"));
  iss.find((i) => i.number === 41).labels.push({ name: "agent-ok" });
  writeFileSync(path.join(ST, "issues.json"), JSON.stringify(iss, null, 2));
  const dedupBefore = ingestEvents().filter((e) => e.type === "ingest_issue_deduped").length;
  const p2 = await pollIdle();
  const second = await ingested();
  second.forEach((x) => t.created.add(x.id));
  t.check(
    second.length === 2 &&
      ingestEvents().filter((e) => e.type === "ingest_issue_deduped").length > dedupBefore,
    `a second Poll filed no duplicate: #41 was listed again but deduped by its Source link (still ${second.length} drafts)`,
    `after the second Poll: ${second.length} ingested drafts; dedup events ${dedupBefore}→${ingestEvents().filter((e) => e.type === "ingest_issue_deduped").length}`,
  );
  t.check(
    p2.lane === "documentation",
    "the second idle tick ROTATED to the other enabled lane (documentation), as the status line said",
    `second idle tick's lane: '${p2.lane}' (first was '${p1.lane}')`,
  );

  // ── 4. the dashboard shows them ───────────────────────────────────────────
  await t.visit("work");
  const board = (await p.textContent("#app").catch(() => "")) || "";
  t.check(
    wanted.every((i) => board.includes(i.title)),
    "the Work board lists both ingested drafts",
    `the Work board is missing an ingested draft ('${board.slice(0, 200)}')`,
  );
  const due = first.find((x) => x.title === ISSUES[1].title);
  if (due) {
    await t.visit(`ticket/${due.id}`, { label: "ticket/:id" });
    const page = (await p.textContent("#app").catch(() => "")) || "";
    t.check(
      page.includes("Labels: agent-ok, enhancement") && page.includes(url(42)),
      `the ticket page of #${due.number} shows its labels and the issue link`,
      `ticket page of #${due.number}: '${page.slice(0, 240)}'`,
    );
    await L.shot(p, "s12b-ingested");
  }
  t.skip(
    "the other five lanes, the feature backlog and IDLE_DRAFT_WHEN_IDLE need planted findings of their own (the golden path drives tech debt end to end)",
  );
}
