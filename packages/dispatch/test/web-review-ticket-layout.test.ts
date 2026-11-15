// @vitest-environment jsdom
//
// Review and the ticket page lead with the decision (dashboard visual pass, package V2):
//  - Review at 1440x900: Approve sits in the sign-off, which follows only the ticket head
//    and one compact verdict row; every evidence section comes after it in DOM order
//    (jsdom lays nothing out: this is the layout-free proxy, the browser suite measures
//    the real top). At most two block heads, one primary button, sections on level 2.
//  - the verdict row: each cell a label, a verdictMark with one word and the detail
//    behind a disclosure; a fixed column count; no side stripes in review.css.
//  - one ticket head on both pages (title first, meta under it), the yellow card only
//    when the ticket waits on you.
//  - the numbers carry their reference: "typical $X" beside the packet's cost, the queue
//    wait before a person opens a change, the factory median beside a done ticket's time.
//  - Must fix wears the needs treatment, the anchor tag is a neutral chip, a known agent
//    wears its shirt, a rework reason code reads in words.
//  - on a phone the three sign-off actions ride in a fixed bar above the tab bar.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WEB = path.resolve(process.cwd(), "src/api/web");
const APP_JS = path.join(WEB, "app.js");

const T = {
  id: "tkt-9",
  number: 9,
  title: "Clear done tasks",
  status: "in_review",
  risk_level: "medium",
  policy_pack: "team_light",
  priority: 1,
  attempt_count: 1,
  branch_name: "gaffer/ticket-9",
  pr_url: null,
  can_be_tested: 0,
  test_contract: null,
  delivery_budget_usd: null,
  description: "Users can clear every done task in one click.",
  created_at: "2026-10-29T09:00:00Z",
  updated_at: "2026-10-30T10:00:00Z",
};

const PACKET = {
  intent: "Users can clear every done task in one click.",
  gates: {
    overall: "PASS",
    recorded_at: "2026-10-30T09:58:00Z",
    rows: [
      { gate: "tests", repo: "svc", status: "PASS", rc: "0", command: "npm test", note: null },
      { gate: "lint", repo: "svc", status: "PASS", rc: "0", command: "npm run lint", note: null },
    ],
    tally: { framework: "vitest", passed: 40, failed: 0, skipped: 0, total: 40, lines: [] },
  },
  tester: null,
  tester_expected: false,
  cost: {
    cost_usd: 1.23,
    measured_usd: 1.23,
    estimated_usd: 0,
    num_turns: 31,
    unknown_calls: 0,
    ledger_status: "ok",
    budget_usd: null,
  },
  attempts: {
    attempt_count: 1,
    max_attempts: 3,
    rework: [
      { at: "2026-10-29T15:00:00Z", by: "tester", gate: null, reason: "tester_failed:empty list" },
    ],
  },
  risk: { level: "medium", reasons: [] },
  pin: null,
  acceptance: [],
  disagreements: [],
};

const HEALTH = {
  accepted_change: { accepted_changes: 12, cost_per_accepted_change_usd: 0.71 },
  review_time: { queue_wait: { n: 9, median_ms: 12 * 60_000, p75_ms: null, p90_ms: null } },
  cycle_time: { median_days: 2.5, p75_days: 3, p90_days: 4, series: [], series_n: [] },
};

const COMMENTS = [
  {
    id: "c1",
    short_id: "c1",
    body: "Handle the empty list",
    severity: "must_fix",
    status: "open",
    path: null,
    line: null,
    round: 0,
    anchor_state: "changed",
    author_id: "agent-7",
  },
  {
    id: "c2",
    short_id: "c2",
    body: "Maybe rename it",
    severity: "consider",
    status: "open",
    path: null,
    line: null,
    round: 0,
    anchor_state: "changed",
    author_id: "pat",
  },
];

type World = {
  queue: (typeof T)[];
  ticket: Record<string, unknown>;
  health: unknown;
  events?: unknown[];
};
let world: World;

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const t = world.ticket;
      let body: unknown;
      if (url.includes("/api/health")) body = world.health;
      else if (url.includes("status=in_review")) body = { tickets: world.queue };
      else if (url.includes("/dossier"))
        body = { schema: "dossier.v1", hash: "x", subject: {}, review_packet: PACKET };
      else if (url.includes("/review/comments")) body = { comments: COMMENTS };
      else if (url.includes("/diff"))
        body = {
          ticketId: t.id,
          repos: [
            {
              repo: "svc",
              repoId: "r1",
              headSha: "abcdef1234567",
              branch: t.branch_name,
              baseBranch: "main",
              files: 1,
              additions: 1,
              deletions: 0,
              diff: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,2 @@\n a\n+b",
              riskAnnotations: [],
            },
          ],
        };
      else if (url.includes("/claimability"))
        body = { ticketId: t.id, ready: true, blockers: [], warnings: [] };
      else if (url.includes("/work-repos"))
        body = {
          writeRepos: [],
          readOnlyRepos: [],
          testRepos: [],
          deniedRepos: [],
          suggestedRepos: [],
          rejectedRepos: [],
        };
      else if (url.includes(`/tickets/${t.id}`))
        body = {
          ticket: t,
          acceptance_criteria: [],
          repositories: [{ id: "r1", name: "svc", local_path: "/r/svc", access: "write" }],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence: [],
          events: world.events || [],
          rework_trail: [],
          review_comments: COMMENTS,
        };
      else if (url.includes("/agents"))
        body = { agents: [{ id: "agent-7", name: "crew-delivery-07", display_name: "Kev" }] };
      else if (url.includes("/tickets")) body = { tickets: world.queue.length ? world.queue : [] };
      else body = {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}
function mount(hash: string): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = hash;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  for (let i = 0; i < 16; i++) await tick();
}
const app = () => document.getElementById("app") as HTMLElement;
const before = (a: Element, b: Element) =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("web: Review leads with the decision", () => {
  beforeEach(() => {
    world = { queue: [T], ticket: T, health: HEALTH };
    vi.resetModules();
    stubFetch();
    mount("#/review");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("puts Approve right after the head and one verdict row, ahead of every evidence section", async () => {
    await boot();
    const approve = app().querySelector("button.signoff-btn") as HTMLElement;
    expect(approve, "an Approve button").toBeTruthy();
    // What comes before the sign-off: the queue, the ticket head, the verdict row. Nothing else.
    const head = app().querySelector(".rv-head")!;
    const strip = app().querySelector(".rv-verdict")!;
    const grid = app().querySelector(".rv-grid")!;
    expect(head.nextElementSibling).toBe(strip);
    expect(strip.nextElementSibling).toBe(grid);
    expect(grid.querySelector(".rv-left")!.firstElementChild).toBe(app().querySelector(".signoff"));
    for (const sel of [".rv-flags", ".rv-comments", ".rv-checks", ".rv-evid", ".rv-diff"]) {
      const sec = app().querySelector(sel)!;
      expect(sec, sel).toBeTruthy();
      expect(before(approve, sec), `Approve before ${sel}`).toBe(true);
    }
    // The three sign-off actions are one group (the phone's bar), Won't do apart.
    const bar = app().querySelector(".signoff .rv-actions")!;
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Approve",
      "Fix these (1)",
      "Send back…",
    ]);
    expect(bar.querySelector(".btn.danger")).toBeNull();
  });

  it("has at most two block heads, one primary button and level-2 sections", async () => {
    await boot();
    expect(app().querySelectorAll(".panel-head.block").length).toBeLessThanOrEqual(2);
    expect(app().querySelectorAll(".signoff > .panel-head.block.tone-needs.ph-l2")).toHaveLength(1);
    expect(app().querySelectorAll(".btn.primary")).toHaveLength(1);
    expect(app().querySelectorAll(".rv-h2, .rv-h3, h2.rv-intent-h")).toHaveLength(0);
    for (const sel of [".rv-flags", ".rv-comments", ".rv-evid", ".rv-diff", ".rv-checks"])
      expect(app().querySelector(`${sel} .panel-head.ph-l2 h2`), sel).toBeTruthy();
  });

  it("draws each verdict cell as a label, a mark with one word and a disclosure", async () => {
    await boot();
    const cells = [...app().querySelectorAll(".rv-verdict .vd-cell")];
    expect(cells.length).toBeGreaterThan(3);
    for (const c of cells) {
      expect(c.querySelector(":scope > .vd-k")?.textContent, c.className).toBeTruthy();
      expect(c.querySelector(":scope > .vd-v > .vmark .vglyph"), c.className).toBeTruthy();
      const more = c.querySelector(":scope > details.vd-more");
      expect(more, c.className).toBeTruthy();
      expect(more!.querySelector("summary")).toBeTruthy();
      expect(more!.querySelector(".vd-body")).toBeTruthy();
      expect(more!.hasAttribute("open")).toBe(false);
    }
    expect(app().querySelector(".vd-gates .vd-v .vmark.vm-pass")?.textContent).toBe("Passed");
    // A fixed column count, the strip's own cell count.
    const grid = app().querySelector(".vd-cells") as HTMLElement;
    expect(grid.style.getPropertyValue("--vd-n")).toBe(String(cells.length));
    expect(grid.style.getPropertyValue("--vd-half")).toBe(String(Math.ceil(cells.length / 2)));
    // No text-character marks anywhere on the page.
    expect(app().querySelector(".dod-mark")).toBeNull();
  });

  it("shows the packet's cost beside the typical cost of an accepted change", async () => {
    await boot();
    expect(app().querySelector(".vd-cost .vd-v")?.textContent).toBe("$1.23");
    const norm = app().querySelector(".vd-cost .vd-norm") as HTMLElement;
    expect(norm.hidden).toBe(false);
    expect(norm.textContent).toBe("typical $0.71");
  });

  it("says no typical cost when Health cannot say one", async () => {
    world.health = {};
    await boot();
    expect((app().querySelector(".vd-cost .vd-norm") as HTMLElement).hidden).toBe(true);
  });

  it("reads a rework reason code in words, the raw code in its title", async () => {
    await boot();
    const why = app().querySelector(".vd-attempts .vd-why") as HTMLElement;
    expect(why.textContent).toBe("Tester failed it: empty list");
    expect(why.title).toContain("tester_failed:empty list");
  });

  it("one ticket head: title first, the number and status under it, the yellow card", async () => {
    await boot();
    const head = app().querySelector(".rv-head.ticket-head")!;
    expect(head.firstElementChild?.tagName).toBe("H1");
    expect(head.firstElementChild?.textContent).toBe("Clear done tasks");
    expect(head.querySelector(".th-meta .tref")?.textContent).toBe("#9");
    expect(head.querySelector(".th-meta .badge.st")?.textContent).toContain("In review");
    expect(head.querySelector(".th-mark .ycard")).toBeTruthy();
    // What was asked is a plain quote block, inside the head.
    expect(head.querySelector(".rv-intent blockquote .rv-intent-t")?.textContent).toBe(
      "Users can clear every done task in one click.",
    );
  });

  it("comments: Must fix wears the needs card, the anchor tag is neutral, an agent its shirt", async () => {
    world.ticket = { ...T, attempt_count: 1 };
    await boot();
    const must = app().querySelector('.rc-item[data-comment-id="c1"]')!;
    const sev = must.querySelector(".rc-sev-must")!;
    expect(sev.classList.contains("needs")).toBe(true);
    expect(sev.querySelector(".ycard")).toBeTruthy();
    expect(sev.textContent).toBe("Must fix");
    const anchor = must.querySelector(".rc-anchor")!;
    expect(anchor.classList.contains("info")).toBe(true);
    expect(anchor.classList.contains("warn")).toBe(false);
    expect(must.querySelector(".rc-meta .agent")?.textContent).toContain("Kev");
    const consider = app().querySelector('.rc-item[data-comment-id="c2"]')!;
    expect(consider.querySelector(".rc-sev-must")).toBeNull();
    expect(consider.querySelector(".rc-meta .who-name")?.textContent).toBe("pat");
  });
});

describe("web: the clear desk's numbers", () => {
  beforeEach(() => {
    world = { queue: [], ticket: T, health: HEALTH };
    vi.resetModules();
    stubFetch();
    mount("#/review");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("says how long a change waits before you open it, in plain figures", async () => {
    await boot();
    const sub = app().querySelector(".rv-clear-board .hl-sub")!;
    expect(sub.querySelector(".rv-queue-wait")?.textContent).toBe(
      "a change waits 12m before you open it",
    );
    expect(sub.textContent).not.toContain("on the median");
    const vals = [...app().querySelectorAll(".rv-clear-board .kpi-val")].map((v) => v.textContent);
    expect(vals.every((v) => !/^0\d/.test(v || ""))).toBe(true);
  });
});

describe("web: the ticket page's head and numbers", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
  const open = async (ticket: Record<string, unknown>, events: unknown[] = []) => {
    world = { queue: [], ticket: { ...T, ...ticket }, health: HEALTH, events };
    stubFetch();
    mount(`#/ticket/${T.id}`);
    await boot();
  };

  it("uses the shared ticket head, the card only when the ticket waits on you", async () => {
    await open({ status: "in_review" });
    let head = app().querySelector(".tk-head.ticket-head")!;
    expect(head.firstElementChild?.textContent).toBe("Clear done tasks");
    expect(head.querySelector(".th-meta .tref")?.textContent).toBe("#9");
    expect(head.querySelector(".th-meta .prio")?.textContent).toBe("P1");
    expect(head.querySelector(".th-mark .ycard")).toBeTruthy();
    expect(app().querySelector(".ref-card")).toBeNull();

    vi.resetModules();
    await open({ status: "in_progress" });
    head = app().querySelector(".tk-head.ticket-head")!;
    expect(head.querySelector(".th-mark")).toBeNull();

    vi.resetModules();
    await open({
      status: "ready_for_merge",
      landing_state: { kind: "lands_next_tick", label: "Approved · lands next tick", detail: "x" },
    });
    head = app().querySelector(".tk-head.ticket-head")!;
    expect(head.querySelector(".th-mark")).toBeNull();
  });

  for (const status of ["in_review", "blocked", "paused", "in_testing", "done", "in_progress"])
    it(`a ${status} ticket has at most two block heads and one primary button`, async () => {
      await open({ status });
      expect(app().querySelectorAll(".panel-head.block").length).toBeLessThanOrEqual(2);
      expect(app().querySelectorAll(".btn.primary").length).toBeLessThanOrEqual(1);
      expect(app().querySelectorAll(".tk-h2, .tk-h3")).toHaveLength(0);
    });

  it("a done ticket's full time names the factory median beside its own time", async () => {
    await open({ status: "done", created_at: "2026-10-20T09:00:00Z" }, [
      {
        event_type: "claim.created",
        created_at: "2026-10-21T09:00:00Z",
        actor_id: "agent-7",
        payload_json: "{}",
      },
      {
        event_type: "ticket.transitioned",
        created_at: "2026-10-22T09:00:00Z",
        payload_json: JSON.stringify({ from: "ready_for_merge", to: "done" }),
      },
    ]);
    const ft = app().querySelector(".tk-ft")!;
    expect(ft.textContent).toContain("Claim to merge");
    expect(ft.textContent).toContain("Created to done");
    const norm = ft.querySelector(".tk-ft-norm") as HTMLElement;
    expect(norm.hidden).toBe(false);
    expect(norm.textContent).toBe("factory median 2d 12h");
  });

  it("the paused banner is the shared needs callout, its spend said the one money way", async () => {
    await open({ status: "paused" }, [
      {
        event_type: "ticket.paused",
        created_at: "2026-10-22T09:00:00Z",
        payload_json: JSON.stringify({ reason: "budget_cap", spend: "$2.5600", turns: 40 }),
      },
    ]);
    const banner = app().querySelector(".paused-banner")!;
    expect(banner.classList.contains("callout")).toBe(true);
    expect(banner.classList.contains("callout-needs")).toBe(true);
    expect(banner.textContent).toContain("spend so far $2.56");
    expect(banner.textContent).not.toContain("2.5600");
  });
});

describe("review.css: no side stripes, a phone bar for the sign-off", () => {
  const css = readFileSync(path.join(WEB, "css/views/review.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  it("draws no side-tab stripe", () => {
    expect(css).not.toMatch(/inset\s+6px\s+0\s+0/);
    expect(css).not.toMatch(/border-left:\s*\d+px\s+solid/);
  });
  it("fixes the three sign-off actions above the tab bar on a phone", () => {
    const phone = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
    const rule = /\.rv-actions\s*\{([^}]*)\}/.exec(phone)?.[1] || "";
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/bottom:\s*calc\(60px/);
    // On a wide screen the group is part of the sign-off's button row.
    expect(css).toMatch(/\.rv-actions\s*\{\s*display:\s*contents;/);
  });
});
