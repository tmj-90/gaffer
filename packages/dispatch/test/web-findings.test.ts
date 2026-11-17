// @vitest-environment jsdom
//
// POST-MERGE FINDINGS AND LESSONS on the dashboard (backlog 59): js/views/findings.js.
//  - The Ticket page of a DONE ticket offers "Something was wrong with this?" (a quiet
//    secondary action) that opens a small form and POSTs the finding; findings are listed
//    with who and when, state said in words (Withdrawn, Proposed as a lesson, Fix ticket),
//    the text as text.
//  - "Open a fix ticket" asks the server first and says what the link does to autonomy;
//    the confirm, built after that read, is locked when it is created for a read-only
//    viewer, like every other control here.
//  - Health's section: "Lessons: N live, M drafts waiting, recurrences after: k of n".
//  - ticket.js and health.js mount the module with one line each.

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WEB = path.resolve(process.cwd(), "src/api/web");
const FINDINGS_JS = path.join(WEB, "js/views/findings.js");
const ACCESS_JS = path.join(WEB, "js/access.js");
const READ_ONLY_TITLE = "Read-only access: this token can look, not change anything.";

const DONE = { id: "tkt-5", number: 5, status: "done", title: "Add the export" };

const FINDING = {
  id: "f-1111-aaaa",
  ticket_id: "tkt-5",
  number: 5,
  text: 'The empty export lost its header <img src=x onerror="alert(1)">',
  category: "test_gap",
  paths: ["src/export/csv.ts"],
  paths_source: "delivery",
  criteria: [],
  repo: "app",
  source: "person",
  regression_ticket: null,
  filed_by: { type: "human", id: "tom" },
  filed_at: "2026-11-01T10:00:00.000Z",
  withdrawn: null,
  lesson: null,
  fix_ticket: null,
};

const PREVIEW = {
  finding_id: FINDING.id,
  regression_of: { ticket_id: "tkt-5", number: 5 },
  steps_down: true,
  step_downs: [{ repo: "app", risk_level: "low", gate: "approve", cascade: false }],
  message:
    "This also takes automatic approval back for app at low risk (approval), because #5 was approved or landed automatically.",
};

const REPORT = {
  live: 2,
  drafts_waiting: 1,
  unknown: 0,
  recurrences_after: { k: 1, n: 2 },
  min_changes: 5,
  note: "A lesson is a person's post-merge finding a person approved.",
  lessons: [
    {
      lore_id: "abcd2345",
      finding_id: "f1",
      ticket_id: "tkt-5",
      number: 5,
      repo: "app",
      paths: ["src/export/"],
      proposed_at: "2026-11-01T00:00:00.000Z",
      proposed_by: "tom",
      lore_status: "active",
      approved_at: "2026-11-02T00:00:00.000Z",
      measure: {
        state: "not_enough_data",
        window_days: 3,
        changes_before: 1,
        recurrences_before: 1,
        rate_before_pct: null,
        changes_after: 2,
        recurrences_after: 1,
        rate_after_pct: null,
        note: "",
      },
    },
    {
      lore_id: "draft234",
      finding_id: "f2",
      ticket_id: "tkt-6",
      number: 6,
      repo: "app",
      paths: ["src/a.ts"],
      proposed_at: "2026-11-01T00:00:00.000Z",
      proposed_by: "tom",
      lore_status: "draft",
      approved_at: null,
      measure: {
        state: "not_approved",
        window_days: null,
        changes_before: 0,
        recurrences_before: 0,
        rate_before_pct: null,
        changes_after: 0,
        recurrences_after: 0,
        rate_after_pct: null,
        note: "",
      },
    },
  ],
};

let sent: Array<{ method: string; url: string; body: unknown }> = [];
function stubFetch(): void {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (method === "GET" && url.includes("/fix-ticket")) return json(PREVIEW);
      if (method === "GET" && url.includes("/api/lessons")) return json(REPORT);
      if (method === "POST" && url.includes("/fix-ticket"))
        return json(
          { ticket: { id: "tkt-9", number: 9 }, finding: FINDING, stepped_down: [] },
          201,
        );
      if (method === "POST") return json({ ok: true }, 201);
      return json({});
    }),
  );
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await tick();
};

async function load(viewer: "operator" | "read-only") {
  stubFetch();
  const access = await import(ACCESS_JS);
  access.learnWhoami(
    viewer === "read-only"
      ? { capability: "read", actor: { type: "human", id: "ro" } }
      : { capability: "full", actor: { type: "human", id: "tom" } },
  );
  return (await import(FINDINGS_JS)) as Record<string, any>;
}

const buttons = (root: Element) =>
  [...root.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
const byText = (root: Element, text: string) =>
  [...root.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === text) as
    HTMLButtonElement | undefined;

describe("web: the findings card on the Ticket page", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="toast" class="toast" role="alert" hidden></div><header id="appbar" class="appbar"></header><main id="app"></main>`;
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("not done and no findings: no card", async () => {
    const m = await load("operator");
    expect(m.findingsCard({ ...DONE, status: "in_review" }, [])).toBeNull();
  });

  it("a done ticket: the quiet action opens the form, which POSTs text, category and paths", async () => {
    const m = await load("operator");
    const card = m.findingsCard(DONE, []) as HTMLElement;
    document.getElementById("app")!.appendChild(card);
    const open = byText(card, "Something was wrong with this?")!;
    expect(open.className).toContain("btn-link");
    open.click();
    const form = card.querySelector(".fd-form") as HTMLFormElement;
    expect(form).not.toBeNull();
    (form.querySelector("textarea") as HTMLTextAreaElement).value =
      "Header row lost on empty export";
    (form.querySelector("select") as HTMLSelectElement).value = "test_gap";
    (form.querySelector("input") as HTMLInputElement).value =
      "src/export/csv.ts, test/export.test.ts";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await settle();
    const post = sent.find((s) => s.method === "POST")!;
    expect(post.url).toMatch(/\/tickets\/tkt-5\/findings$/);
    expect(post.body).toEqual({
      text: "Header row lost on empty export",
      category: "test_gap",
      paths: ["src/export/csv.ts", "test/export.test.ts"],
    });
  });

  it("lists findings with who, when and their state in words; the text stays text", async () => {
    const m = await load("operator");
    const card = m.findingsCard(DONE, [
      FINDING,
      {
        ...FINDING,
        id: "f-2222",
        category: "constructor",
        withdrawn: { by: { type: "human", id: "ann" }, at: "2026-11-02T00:00:00Z", reason: "dup" },
      },
      {
        ...FINDING,
        id: "f-3333",
        category: null,
        lesson: { lore_id: "abcd2345", proposed_at: "x", proposed_by: "tom" },
        fix_ticket: { ticket_id: "tkt-9", number: 9 },
      },
    ]) as HTMLElement;
    const items = card.querySelectorAll(".fd-item");
    expect(items).toHaveLength(3);
    expect(items[0]!.querySelector(".fd-cat")!.textContent).toBe("Test gap");
    expect(items[0]!.textContent).toContain("tom");
    expect(items[0]!.querySelector(".fd-paths")!.textContent).toBe(
      "Paths (from the delivery): src/export/csv.ts",
    );
    expect(card.querySelector("img")).toBeNull();
    expect(items[0]!.querySelector(".fd-text")!.textContent).toContain(
      '<img src=x onerror="alert(1)">',
    );
    // A category the page does not know (even "constructor") reads as a word, not a function.
    expect(items[1]!.querySelector(".fd-cat")!.textContent).toBe("Other");
    expect(items[1]!.querySelector(".fd-withdrawn")!.textContent).toContain("Withdrawn by ann");
    expect(buttons(items[1]!)).toEqual([]); // nothing to do on a withdrawn finding
    expect(items[2]!.querySelector(".fd-lesson")!.textContent).toContain(
      "Proposed as a lesson (abcd2345)",
    );
    expect(items[2]!.querySelector(".fd-fix a")!.getAttribute("href")).toBe("#/ticket/tkt-9");
    expect(buttons(items[2]!)).toEqual(["Withdraw"]);
    expect(buttons(items[0]!)).toEqual(["Propose as a lesson", "Open a fix ticket", "Withdraw"]);
  });

  it("Open a fix ticket asks the server first, says the step-down, then opens on confirm", async () => {
    const m = await load("operator");
    const card = m.findingsCard(DONE, [FINDING]) as HTMLElement;
    document.getElementById("app")!.appendChild(card);
    byText(card, "Open a fix ticket")!.click();
    await settle();
    expect(sent.map((s) => `${s.method} ${s.url.replace(/^https?:\/\/[^/]+/, "")}`)).toEqual([
      `GET /tickets/tkt-5/findings/${FINDING.id}/fix-ticket`,
    ]);
    const confirm = card.querySelector(".fd-confirm") as HTMLElement;
    expect(confirm.textContent).toContain("Autonomy steps down.");
    expect(confirm.textContent).toContain("takes automatic approval back for app at low risk");
    expect(confirm.querySelector(".callout-needs")).not.toBeNull();
    byText(confirm, "Open the fix ticket")!.click();
    await settle();
    expect(sent.some((s) => s.method === "POST" && s.url.endsWith("/fix-ticket"))).toBe(true);
    expect(location.hash).toBe("#/ticket/tkt-9");
  });

  it("a read-only viewer: every act is locked, and the confirm built after the read is locked when created", async () => {
    const m = await load("read-only");
    const card = m.findingsCard(DONE, [FINDING]) as HTMLElement;
    for (const label of [
      "Something was wrong with this?",
      "Propose as a lesson",
      "Open a fix ticket",
      "Withdraw",
    ]) {
      const b = byText(card, label)!;
      expect(b.disabled, label).toBe(true);
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect(b.classList.contains("is-read-only")).toBe(true);
      expect(b.title).toBe(READ_ONLY_TITLE);
    }
    const host = document.createElement("div");
    await m.fixTicketConfirm(DONE, FINDING, host);
    const go = byText(host, "Open the fix ticket")!;
    expect(go.disabled).toBe(true);
    expect(go.title).toBe(READ_ONLY_TITLE);
    go.click();
    await settle();
    expect(sent.filter((s) => s.method === "POST")).toEqual([]);
  });
});

describe("web: the lessons section on Health", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div id="toast" class="toast" role="alert" hidden></div><header id="appbar" class="appbar"></header><main id="app"></main>`;
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("says N live, M drafts waiting, recurrences after: k of n, and each lesson's before and after", async () => {
    const m = await load("operator");
    const panel = m.lessonsPanel() as HTMLElement;
    document.getElementById("app")!.appendChild(panel);
    await settle();
    expect(panel.querySelector(".fd-summary")!.textContent).toBe(
      "Lessons: 2 live, 1 draft waiting, recurrences after: 1 of 2",
    );
    const rows = [...panel.querySelectorAll("tbody tr")].map((tr) =>
      [...tr.children].map((c) => (c.textContent || "").trim()),
    );
    expect(rows).toEqual([
      ["#5", "Live", "src/export/", "1 of 1", "1 of 2"],
      ["#6", "Draft: waiting for a person in Memory", "src/a.ts", "0 of 0", "not live yet"],
    ]);
  });

  it("memory or the read failing says so in words", async () => {
    const m = await load("operator");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    const panel = m.lessonsPanel() as HTMLElement;
    await settle();
    expect(panel.textContent).toContain("Lessons could not be read.");
  });
});

describe("web: the mount lines", () => {
  it("ticket.js and health.js each mount the module with one line (plus its import)", () => {
    const ticket = readFileSync(path.join(WEB, "js/views/ticket.js"), "utf8");
    const health = readFileSync(path.join(WEB, "js/views/health.js"), "utf8");
    expect(ticket.match(/findingsCard\(t, view\.findings\)/g)).toHaveLength(1);
    expect(health.match(/wrap\.appendChild\(lessonsPanel\(\)\)/g)).toHaveLength(1);
    expect(readFileSync(path.join(WEB, "index.html"), "utf8")).toContain(
      '<link rel="stylesheet" href="/css/views/findings.css" />',
    );
  });
});
