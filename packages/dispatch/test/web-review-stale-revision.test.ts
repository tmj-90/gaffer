// @vitest-environment jsdom
//
// STALE REVISION (external review #2) — the Review view approves exactly the commit it
// rendered. The diff endpoint returns each write repo's `repoId` + `headSha`; Approve
// POSTs them back as `commits`; when the server refuses with 409 stale_revision (the
// branch moved between the render and the click) the view says the change moved,
// approves nothing, and reloads the new diff — whose head is then what Approve sends.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_A2 = "c".repeat(40);

const TICKET = {
  id: "tkt-1",
  number: 7,
  title: "Ship the thing",
  status: "in_review",
  risk_level: "low",
  branch_name: "feat/x",
  pr_url: null,
};

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let headA = SHA_A;
let refuseNextApprove = false;

function repoDiff(repo: string, repoId: string, headSha: string) {
  return {
    repo,
    repoId,
    headSha,
    branch: "feat/x",
    baseBranch: "main",
    diff: `diff --git a/${repo} b/${repo}\n--- a/${repo}\n+++ b/${repo}\n+real change\n`,
    files: 1,
    additions: 1,
    deletions: 0,
    truncated: false,
    riskAnnotations: [],
  };
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      let status = 200;
      let payload: unknown = {};
      if (url.endsWith("/tickets/tkt-1/diff")) {
        payload = {
          ticketId: "tkt-1",
          repos: [repoDiff("svc-a", "repo-a", headA), repoDiff("svc-b", "repo-b", SHA_B)],
        };
      } else if (url.includes("/review/approve")) {
        if (refuseNextApprove) {
          refuseNextApprove = false;
          status = 409;
          payload = {
            error: {
              code: "STATE_CONFLICT",
              message: `The change moved since it was shown: svc-a is now ${SHA_A2.slice(0, 12)}.`,
              details: { reason: "stale_revision" },
            },
          };
        } else {
          payload = { ticket: { ...TICKET, status: "ready_for_merge" }, event_id: "e1" };
        }
      } else if (url.match(/\/tickets\/tkt-1$/)) {
        payload = { ...TICKET, ticket: TICKET, acceptance_criteria: [], evidence: [], events: [] };
      } else if (url.includes("/tickets")) payload = { tickets: [TICKET] };
      return new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
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
  location.hash = "#/review";
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => wait(0);
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await tick();
}

function pressKey(key: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}
const approves = () =>
  calls.filter((c) => c.method === "POST" && c.url.includes("/review/approve"));

describe("web review: approve names the commits it rendered (stale revision)", () => {
  beforeEach(() => {
    calls = [];
    headA = SHA_A;
    refuseNextApprove = false;
    mountShell();
    vi.resetModules();
    stubFetch();
  });
  afterEach(async () => {
    document.getElementById("app")?.replaceChildren();
    await tick();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("POSTs one commit per repo — the heads the diff endpoint returned", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await settle();
    pressKey("a");
    await tick();
    pressKey("a");
    await settle();
    const sent = approves();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({
      commits: [
        { repo: "repo-a", sha: SHA_A },
        { repo: "repo-b", sha: SHA_B },
      ],
    });
  });

  it("a 409 stale_revision approves nothing, says the change moved, and reloads the new diff", async () => {
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    await settle();
    // The branch moves after the render; the server refuses the approval of the old head.
    refuseNextApprove = true;
    headA = SHA_A2;
    const diffLoadsBefore = calls.filter((c) => c.url.endsWith("/diff")).length;
    pressKey("a");
    await tick();
    pressKey("a");
    await settle();
    await settle();
    expect(approves()).toHaveLength(1);
    expect(approves()[0]!.body).toEqual({
      commits: [
        { repo: "repo-a", sha: SHA_A },
        { repo: "repo-b", sha: SHA_B },
      ],
    });
    // The view did not claim success, and told the human what happened.
    expect(document.querySelector(".rv-done:not([hidden])")).toBeNull();
    const banner = document.querySelector(".diff-moved-banner");
    expect(banner, "the moved banner is shown above the reloaded diff").not.toBeNull();
    expect(banner!.getAttribute("role")).toBe("alert");
    expect(banner!.getAttribute("aria-label")).toBe(
      "The change moved since you opened it, so nothing was approved.",
    );
    expect(banner!.textContent).toContain("The change moved since you opened it.");
    expect(calls.filter((c) => c.url.endsWith("/diff")).length).toBeGreaterThan(diffLoadsBefore);
    // Approving again now sends the NEW head.
    pressKey("a");
    await tick();
    pressKey("a");
    await settle();
    expect(approves()).toHaveLength(2);
    expect(approves()[1]!.body).toEqual({
      commits: [
        { repo: "repo-a", sha: SHA_A2 },
        { repo: "repo-b", sha: SHA_B },
      ],
    });
  });
});
