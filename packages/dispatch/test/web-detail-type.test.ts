// @vitest-environment jsdom
//
// Condensed type only for headlines (external UI review, fix 3).
// The condensed programme face reads well on TEAM SHEET, THE DIFF and the big score,
// and badly on timestamps, branch lines, evidence detail and small pitch labels. The
// operational detail now sets in the body face through one token (--f-detail, with
// --t13 / --lh-detail for a little more size and breathing room); the headlines keep
// the display and condensed faces.
//
// The check renders the real Review view and resolves, for each element, the last
// stylesheet rule that matches it and sets a font: a timestamp, the branch line, the
// evidence detail must resolve to the body face; the section titles to the display face.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WEB = path.resolve(process.cwd(), "src/api/web");
const APP_JS = path.join(WEB, "app.js");
const CSS_DIR = path.join(WEB, "css");

/** Every innermost `selector { declarations }` rule that sets a font, in load order. */
function fontRules(): Array<{ selector: string; font: string }> {
  const files = [
    "tokens.css",
    "base.css",
    "layout.css",
    "components.css",
    "utilities.css",
    "shell.css",
    ...readdirSync(path.join(CSS_DIR, "views"))
      .filter((f) => f.endsWith(".css"))
      .sort()
      .map((f) => `views/${f}`),
  ];
  const out: Array<{ selector: string; font: string }> = [];
  for (const f of files) {
    const css = readFileSync(path.join(CSS_DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decl = m[2]!.match(/(?:^|;)\s*font(?:-family)?\s*:\s*([^;]+)/);
      if (!decl) continue;
      out.push({ selector: m[1]!.trim(), font: decl[1]!.trim() });
    }
  }
  return out;
}
const RULES = fontRules();

/** The font of the last rule that matches `el` (source order; good enough for these). */
function fontOf(el: Element): string {
  let font = "";
  for (const r of RULES) {
    let hit: boolean;
    try {
      hit = el.matches(r.selector);
    } catch {
      hit = false; // a selector jsdom cannot parse (e.g. :has) never matches here
    }
    if (hit) font = r.font;
  }
  return font;
}

const T = {
  id: "tkt-1",
  number: 16,
  title: "Partial refunds",
  status: "in_review",
  risk_level: "low",
  branch_name: "gaffer/ticket-16-partial-refunds",
  pr_url: null,
};
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown;
      if (url.includes("/diff"))
        body = {
          ticketId: T.id,
          repos: [
            {
              repo: "billing-api",
              branch: T.branch_name,
              baseBranch: "main",
              files: 1,
              additions: 1,
              deletions: 0,
              diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n a\n+b\n",
              riskAnnotations: [],
            },
          ],
        };
      else if (url.includes(`/tickets/${T.id}`))
        body = {
          ticket: T,
          acceptance_criteria: [],
          repositories: [{ id: "r1", name: "billing-api", access: "write" }],
          evidence: [
            {
              id: "ev-1",
              evidence_type: "manual_note",
              summary: "needs_human_review: oversized_diff — 41 files\nsecond line",
              created_by: "system",
              created_at: "2026-10-29T11:44:00Z",
            },
          ],
          events: [],
        };
      else body = { tickets: [T] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

describe("web type: condensed for headlines, the body face for operational detail", () => {
  beforeEach(async () => {
    vi.resetModules();
    stubFetch();
    document.body.innerHTML = `
      <div id="toast" class="toast" role="alert" hidden></div>
      <div class="shell">
        <header id="appbar" class="appbar" hidden></header>
        <main id="app" class="app"><p class="loading">Loading…</p></main>
        <nav id="bottomnav" class="bottomnav" hidden></nav>
      </div>`;
    location.hash = `#/review/${T.id}`;
    await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("the token exists and is the body face, with a size step and a looser line", () => {
    const tokens = readFileSync(path.join(CSS_DIR, "tokens.css"), "utf8");
    expect(tokens).toMatch(/--f-detail:\s*var\(--f-text\)/);
    expect(tokens).toMatch(/--t13:\s*13px/);
    expect(tokens).toMatch(/--lh-detail:\s*1\.\d+/);
  });

  it("timestamps, the branch line and evidence detail resolve to the body face", () => {
    const els = {
      timestamp: document.querySelector(".evi-time"),
      branch: document.querySelector(".rv-branch"),
      who: document.querySelector(".evi-who"),
      more: document.querySelector(".evi-more > summary"),
      source: document.querySelector(".flag-src"),
    };
    for (const [name, el] of Object.entries(els)) {
      expect(el, `${name} is on the page`).toBeTruthy();
      const font = fontOf(el!);
      expect(font, `${name}: ${font}`).toContain("var(--f-detail)");
      expect(font, `${name}: ${font}`).not.toContain("--f-cond");
    }
  });

  it("the headlines keep the programme's display face", () => {
    for (const sel of [".rv-h2", ".rv-title"]) {
      const el = document.querySelector(sel);
      expect(el, sel).toBeTruthy();
      expect(fontOf(el!), sel).toContain("--f-display");
    }
  });

  it("the operational detail across the dashboard is off the condensed face", () => {
    const detail = [
      ".sb-clock",
      ".own-meta",
      ".feed-time",
      ".ev-tick",
      ".res-list time",
      ".wl-time",
      ".cl-beat",
      ".closed-meta",
      ".tk-report .timeline li > .ev-time",
      ".failure-attempt-time",
      ".mem-primed-at",
      ".tb-note",
      ".pitch-key",
      ".cl",
      ".tag-t",
      ".mr-min",
      ".mr-day",
      // Timestamps the review packet and a repo's ticket list print (reviewer pass).
      ".vd-when",
      ".repo-ticket-time",
    ];
    for (const sel of detail) {
      const rule = [...RULES]
        .reverse()
        .find((r) => r.selector.split(",").some((x) => x.trim() === sel));
      expect(rule, sel).toBeTruthy();
      expect(rule!.font, sel).toContain("var(--f-detail)");
    }
  });
});
