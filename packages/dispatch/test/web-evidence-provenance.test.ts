// @vitest-environment jsdom
//
// EVIDENCE-PROVENANCE DOM test: the Review card's evidence list shows a
// provenance line (who recorded · when) for every row, and an amber
// "agent-reported" chip ONLY on rows the server flagged as agent self-reported
// (`recorded_by_agent === true`). A non-agent row shows who/when with NO chip
// (no fabricated "trusted" label). All text renders via el() text nodes, so a
// `created_by` carrying HTML must appear as literal text, never as live markup.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-prov",
  number: 7,
  title: "Provenance",
  description: "deliver it",
  status: "in_review",
  risk_level: "low",
  policy_pack: "team_light",
  priority: 0,
  attempt_count: 0,
  branch_name: "gaffer/ticket-7",
  pr_url: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

// Two evidence rows as the ticket view serves them (EvidenceView): one flagged as
// an agent self-report, one recorded by a human whose `created_by` carries an
// HTML-looking string to prove text-node (XSS-safe) rendering of the who field.
const EVIDENCE = [
  {
    id: "ev-agent",
    evidence_type: "diff_summary",
    summary: "implemented the endpoint",
    uri: null,
    payload_json: null,
    created_by: "mcp-agent",
    created_at: "2026-01-02T09:00:00Z",
    recorded_by_agent: true,
  },
  {
    id: "ev-human",
    evidence_type: "manual_note",
    summary: "eyeballed the diff",
    uri: null,
    payload_json: null,
    created_by: "<img src=x onerror=alert(1)>",
    created_at: "2026-01-02T10:00:00Z",
    recorded_by_agent: false,
  },
];

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

describe("web: review-card evidence provenance", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("shows who/when for every row and an amber agent chip only on agent self-reports", async () => {
    stubFetch(EVIDENCE);
    await bootReview();

    const evBlock = document.querySelector(".review-evidence");
    expect(evBlock).toBeTruthy();

    // Both rows carry a who/when provenance line.
    const whoLines = Array.from(document.querySelectorAll(".review-evidence .evi-who")).map(
      (n) => n.textContent ?? "",
    );
    expect(whoLines.length).toBe(2);
    expect(whoLines.some((t) => t.includes("mcp-agent"))).toBe(true);

    // Exactly ONE agent chip — on the agent-reported row, not the human row.
    const chips = document.querySelectorAll(".review-evidence .badge.prov-agent");
    expect(chips.length).toBe(1);
    expect(chips[0]!.textContent).toContain("agent-reported");
  });

  it("renders a malicious created_by as literal text, never as markup (XSS-safe)", async () => {
    stubFetch(EVIDENCE);
    await bootReview();

    // The HTML-looking created_by must NOT become a live element …
    expect(document.querySelector(".review-evidence img")).toBeNull();
    // … it appears verbatim as text in a who/when line.
    const whoText = Array.from(document.querySelectorAll(".review-evidence .evi-who"))
      .map((n) => n.textContent ?? "")
      .join("\n");
    expect(whoText).toContain("<img src=x onerror=alert(1)>");
  });

  it("omits the agent chip entirely when no row is agent-reported", async () => {
    stubFetch([{ ...EVIDENCE[1] }]); // only the human row
    await bootReview();

    expect(document.querySelector(".review-evidence")).toBeTruthy();
    expect(document.querySelector(".review-evidence .badge.prov-agent")).toBeNull();
    // who/when still shown for the trusted row.
    expect(document.querySelector(".review-evidence .evi-who")).toBeTruthy();
  });
});
