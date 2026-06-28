// @vitest-environment jsdom
//
// I3 DOM test: the Review view renders the enforced Definition-of-Done checklist
// from the runner's `test_output` DoD evidence row — a compact ✓/✗ board the
// reviewer scans before reading the diff. All text is rendered via text nodes
// (el coerces strings), so this also guards the XSS-safe rendering: a gate `note`
// carrying HTML must appear as literal text, never as live markup.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-dod",
  number: 42,
  title: "Add reset endpoint",
  description: "deliver it",
  status: "in_review",
  risk_level: "low",
  policy_pack: "team_light",
  priority: 0,
  attempt_count: 0,
  branch_name: "gaffer/ticket-42-reset",
  pr_url: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

// A PASS DoD row exactly as the runner records it: a `DoD: PASS` first line, then
// the machine-parseable JSON line, then the human transcript.
function dodEvidence(verdict: "PASS" | "FAIL") {
  const gates =
    verdict === "PASS"
      ? [
          { gate: "tests", repo: "repo", status: "PASS", rc: "0", note: "pnpm test" },
          { gate: "lint", repo: "repo", status: "SKIP", rc: "0", note: "no command configured" },
        ]
      : [
          {
            gate: "tests",
            repo: "repo",
            // The note carries an HTML-looking string to prove text-node rendering.
            status: "FAIL",
            rc: "1",
            note: "exited 1: <img src=x onerror=alert(1)>",
          },
        ];
  const payload = JSON.stringify({ dod: verdict, gates });
  return {
    id: `ev-dod-${verdict}`,
    evidence_type: "test_output",
    summary: `DoD: ${verdict}\n${payload}\n\n  transcript line`,
    payload_json: null,
    created_by: "factory-dod",
    created_at: "2026-01-02T00:00:00Z",
  };
}

function stubFetch(evidence: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes(`/tickets/${TICKET.id}/diff`))
        body = {
          ticketId: TICKET.id,
          repos: [{ repo: "repo", branch: TICKET.branch_name, diff: "+ added a line\n" }],
        };
      else if (url.includes(`/tickets/${TICKET.id}`))
        body = {
          ticket: TICKET,
          acceptance_criteria: [],
          repositories: [],
          scopes: [],
          blocking_decisions: [],
          dependencies: [],
          evidence,
          events: [],
        };
      else if (url.includes("/tickets?status=in_review")) body = { tickets: [TICKET] };
      else body = { tickets: [TICKET] };
      return new Response(JSON.stringify(body), {
        status: 200,
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

const tick = () => new Promise((r) => setTimeout(r, 0));

async function bootReview(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();
  await tick();
  await tick();
}

describe("I3 web: the Review-view Definition-of-Done checklist", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders a PASS checklist with a green ✓ per passing gate", async () => {
    stubFetch([dodEvidence("PASS")]);
    await bootReview();

    const block = document.querySelector(".review-dod");
    expect(block).toBeTruthy();
    expect(block!.classList.contains("dod-ok")).toBe(true);
    const text = block!.textContent ?? "";
    expect(text).toContain("Definition of Done");
    expect(text).toContain("all gates green");
    expect(text).toContain("tests");
    // A passing gate shows the ✓ mark; a skipped gate shows the – mark.
    expect(document.querySelector(".dod-mark.dod-pass")?.textContent).toBe("✓");
    expect(document.querySelector(".dod-mark.dod-skip")?.textContent).toBe("–");
  });

  it("renders a FAIL checklist and shows the failing gate's note as literal text (XSS-safe)", async () => {
    stubFetch([dodEvidence("FAIL")]);
    await bootReview();

    const block = document.querySelector(".review-dod");
    expect(block).toBeTruthy();
    expect(block!.classList.contains("dod-bad")).toBe(true);
    expect(document.querySelector(".dod-mark.dod-fail")?.textContent).toBe("✗");
    // The HTML-looking note is rendered as text, never injected as markup: there
    // must be NO <img> element anywhere in the review surface.
    expect(document.querySelector(".review-dod img")).toBeNull();
    const noteText = document.querySelector(".dod-note")?.textContent ?? "";
    expect(noteText).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders no DoD block when there is no DoD evidence (back-compat)", async () => {
    stubFetch([
      {
        id: "ev-plain",
        evidence_type: "diff_summary",
        summary: "Delivered on branch gaffer/ticket-42-reset",
        payload_json: null,
        created_by: "system",
        created_at: "2026-01-02T00:00:00Z",
      },
    ]);
    await bootReview();
    expect(document.querySelector(".review-dod")).toBeNull();
  });
});
