// @vitest-environment jsdom
//
// REVIEW COMMENTS in the Review view (Release A: A1 inline comments, A2 Fix these, A3
// since your review and the live head check).
//
//  - the diff keeps BOTH sides' line numbers (a removed line shows its old number);
//  - every commentable line has a comment button; the form posts the repo, path, line,
//    side and the head commit the reviewer saw; the comment's thread appears under its
//    line, and "Open comments: N (M must-fix)" joins the ONE flags list the summary reads;
//  - `c` comments on the clicked line, and never fires while a modal is open;
//  - a refresh never throws away a typed draft;
//  - Fix these (N) names the server's reject_outcome and sends the open must-fix ids;
//  - a reject pin offers "Changes since your review / Whole change";
//  - when GET /heads reports a moved head, the moved banner shows and Approve is off;
//  - a read token gets no live comment control.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);
const PIN = "c".repeat(40);

const TICKET = {
  id: "tkt-1",
  number: 7,
  title: "Ship the thing",
  status: "in_review",
  risk_level: "low",
  branch_name: "feat/x",
  pr_url: null,
  attempt_count: 1,
  updated_at: "2026-10-30T10:00:00Z",
};
const DIFF = [
  "diff --git a/src/x.ts b/src/x.ts",
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "@@ -10,3 +10,3 @@",
  " keep one",
  "-old two",
  "+new two",
  " keep three",
  "",
].join("\n");

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let comments: Array<Record<string, unknown>> = [];
let capability = "full";
let heads = HEAD;
let evidence: Array<Record<string, unknown>> = [];
let queueStamp = "2026-10-30T10:00:00Z";

const OUTCOME = (n: number) => ({
  kind: "to_refining",
  label: `Fix these (${n})`,
  sentence: `#7 goes back to Refining with your ${n} numbered requirements. Its acceptance criteria reset to not met.`,
  to_status: "refining",
  attempt: 2,
  max_attempts: 3,
  ac_reset: true,
  requirements: n,
});

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const must = () => comments.filter((c) => c.status === "open" && c.severity === "must_fix");
      if (url.includes("/api/whoami")) return json({ capability, actor: { type: "human" } });
      if (url.includes("/diff?since=rejected"))
        return json({
          ticketId: TICKET.id,
          repos: [
            {
              repo: "svc",
              repoId: "r-1",
              headSha: HEAD,
              branch: "feat/x",
              baseBranch: "main",
              diff: "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -11 +11 @@\n-first fix\n+new two\n",
              files: 1,
              additions: 1,
              deletions: 1,
              truncated: false,
              riskAnnotations: [],
            },
          ],
          since: [
            {
              repo: "svc",
              repoId: "r-1",
              from_sha: PIN,
              to_sha: HEAD,
              available: true,
              history_rewritten: false,
            },
          ],
        });
      if (url.endsWith(`/tickets/${TICKET.id}/diff`))
        return json({
          ticketId: TICKET.id,
          repos: [
            {
              repo: "svc",
              repoId: "r-1",
              headSha: HEAD,
              branch: "feat/x",
              baseBranch: "main",
              diff: DIFF,
              files: 1,
              additions: 1,
              deletions: 1,
              truncated: false,
              riskAnnotations: [],
            },
          ],
          reject_outcome: OUTCOME(must().length),
        });
      if (url.endsWith(`/tickets/${TICKET.id}/heads`))
        return json({
          ticketId: TICKET.id,
          heads: [{ repo: "svc", repo_id: "r-1", sha: heads }],
          unavailable: [],
        });
      if (url.includes(`/tickets/${TICKET.id}/review/comments`) && method === "POST") {
        const c = {
          id: `cmt${comments.length}aaaaaaaa`,
          short_id: `cmt${comments.length}aaa`,
          status: "open",
          round: 1,
          sent_round: null,
          repo: "svc",
          repo_id: body.repo ?? null,
          path: body.path ?? null,
          line: body.line ?? null,
          side: body.side ?? null,
          anchor_sha: body.commit ?? null,
          severity: body.severity,
          body: body.body,
          author_id: "dispatch-api",
          agent_replies: [],
        };
        comments.push(c);
        return new Response(JSON.stringify({ comment: c }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes(`/tickets/${TICKET.id}/review/comments`))
        return json({ comments, counts: {}, reject_outcome: OUTCOME(must().length) });
      if (url.includes(`/tickets/${TICKET.id}/review/fix`))
        return json({
          ticket: { ...TICKET, status: "refining" },
          reject_outcome: OUTCOME(must().length),
        });
      if (url.includes(`/tickets/${TICKET.id}/dossier`)) return json({});
      if (url.includes(`/tickets/${TICKET.id}`))
        return json({
          ticket: TICKET,
          acceptance_criteria: [],
          evidence,
          events: [],
          review_comments: comments,
        });
      if (url.includes("/tickets"))
        return json({ tickets: [{ ...TICKET, updated_at: queueStamp }] });
      return json({});
    }),
  );
}

function mountShell(): void {
  document.body.innerHTML = `
    <div id="toast" class="toast" role="alert" hidden></div>
    <div class="shell">
      <header id="appbar" class="appbar" hidden></header>
      <main id="app" class="app"><p class="loading">Loading…</p></main>
      <nav id="bottomnav" class="bottomnav" hidden></nav>
    </div>`;
  location.hash = `#/review/${TICKET.id}`;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 14): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  await settle();
}
const rows = () =>
  [...document.querySelectorAll(".rv-diff .diff-box:not(.since-box) .diff-line")] as HTMLElement[];
const rowOf = (text: string) => rows().find((r) => r.textContent === text)!;
const posts = (re: RegExp) => calls.filter((c) => c.method === "POST" && re.test(c.url));
const key = (k: string) =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

describe("web: review comments", () => {
  beforeEach(() => {
    calls = [];
    comments = [];
    capability = "full";
    heads = HEAD;
    evidence = [];
    queueStamp = "2026-10-30T10:00:00Z";
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    stubFetch();
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("keeps both sides' line numbers and comments on a line with its anchor", async () => {
    await boot();
    expect(rowOf("-old two").dataset.ol).toBe("11");
    expect(rowOf("-old two").dataset.ln).toBeUndefined();
    expect(rowOf("+new two").dataset.ln).toBe("11");
    expect(rowOf(" keep three").dataset).toMatchObject({ ln: "12", ol: "12" });
    // The button adds no text: a copied line is only the line.
    const btn = rowOf("+new two").querySelector("button.diff-cmt") as HTMLButtonElement;
    expect(btn.getAttribute("aria-label")).toBe("Comment on line 11 of src/x.ts");
    btn.click();
    const form = document.querySelector(".rc-composer") as HTMLFormElement;
    expect(form).not.toBeNull();
    (form.querySelector("textarea") as HTMLTextAreaElement).value = "Name it better";
    form.requestSubmit();
    await settle();
    expect(posts(/\/review\/comments$/)[0]!.body).toEqual({
      body: "Name it better",
      severity: "must_fix",
      repo: "r-1",
      path: "src/x.ts",
      line: 11,
      side: "new",
      commit: HEAD,
    });
    // The thread is under the line, and the flags list (which the summary reads) has it.
    const thread = rowOf("+new two").nextElementSibling as HTMLElement;
    expect(thread.classList.contains("rc-thread")).toBe(true);
    expect(thread.textContent).toContain("Name it better");
    expect(document.querySelector(".flag-list")!.textContent).toContain(
      "Open comments: 1 (1 must-fix)",
    );
    expect(document.querySelector(".signoff-sum")!.textContent).toMatch(/open comments/);
    // Fix these names the server's outcome and sends the open must-fix ids.
    const fix = document.querySelector("button.fix-these") as HTMLButtonElement;
    expect(fix.disabled).toBe(false);
    expect(fix.textContent).toBe("Fix these (1)");
    expect(document.querySelector(".fix-next")!.textContent).toContain("acceptance criteria reset");
    fix.click();
    await settle();
    (document.querySelector(".confirm-submit") as HTMLButtonElement).click();
    await settle();
    expect(posts(/\/review\/fix$/)[0]!.body).toEqual({ comment_ids: ["cmt0aaaaaaaa"] });
  });

  it("`c` comments on the clicked line, never inside a modal", async () => {
    await boot();
    rowOf(" keep one").click();
    key("c");
    expect(document.querySelectorAll(".rc-composer")).toHaveLength(1);
    document.querySelector(".rc-composer")!.remove();
    // With the send-back dialog open, `c` does nothing.
    key("r");
    await settle();
    key("c");
    expect(document.querySelectorAll(".rc-composer")).toHaveLength(0);
  });

  it("a refresh never throws away a typed draft", async () => {
    await boot();
    (rowOf("+new two").querySelector("button.diff-cmt") as HTMLButtonElement).click();
    (document.querySelector(".rc-composer textarea") as HTMLTextAreaElement).value =
      "half a thought";
    const before = document.querySelector("#app > .view");
    queueStamp = "2026-10-30T10:05:00Z"; // the ticket changed: a refresh would re-render
    vi.advanceTimersByTime(9000);
    await settle();
    expect(document.querySelector("#app > .view")).toBe(before);
    expect((document.querySelector(".rc-composer textarea") as HTMLTextAreaElement).value).toBe(
      "half a thought",
    );
  });

  it("a moved head shows the banner and turns Approve off", async () => {
    await boot();
    const approve = document.querySelector(".signoff-btn") as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    heads = MOVED;
    vi.advanceTimersByTime(20000);
    await settle();
    const banner = document.querySelector(".moved-live") as HTMLElement;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain("The change moved since you opened it");
    expect(approve.disabled).toBe(true);
  });

  it("a reject pin offers the changes since your review, and the whole change", async () => {
    evidence = [
      {
        id: "e1",
        evidence_type: "commit",
        uri: `gaffer-rejected-commit:${PIN}`,
        summary: "sent back",
      },
    ];
    await boot();
    const bar = document.querySelector(".since-bar") as HTMLElement;
    expect(bar.hidden).toBe(false);
    const [sinceBtn, wholeBtn] = [
      ...bar.querySelectorAll("button[data-since]"),
    ] as HTMLButtonElement[];
    expect(sinceBtn!.textContent).toBe("Changes since your review (attempt 1 → 2)");
    expect(sinceBtn!.getAttribute("aria-pressed")).toBe("true");
    expect((document.querySelector(".since-box") as HTMLElement).hidden).toBe(false);
    expect(bar.textContent).toContain("Approve still covers the whole change");
    wholeBtn!.click();
    expect((document.querySelector(".since-box") as HTMLElement).hidden).toBe(true);
    // Approve stays bound to the whole change's heads.
    expect((document.querySelector(".signoff-btn") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a read token gets no live comment control", async () => {
    capability = "read";
    await boot();
    const btn = rowOf("+new two").querySelector("button.diff-cmt") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    rowOf("+new two").click();
    key("c");
    expect(document.querySelectorAll(".rc-composer")).toHaveLength(0);
    const fix = document.querySelector("button.fix-these") as HTMLButtonElement;
    expect(fix.disabled).toBe(true);
    // The switched-off button keeps the title that says why (s18-read-only's rule).
    expect(fix.title).toMatch(/^Read-only/);
    expect(btn.title).toMatch(/^Read-only/);
  });
});
