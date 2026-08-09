// @vitest-environment jsdom
//
// DOM test for the review-gate PER-FILE DIFF NAVIGATION (Item A).
//
// The delivery diff used to render as ONE flat <pre>. It now renders as one
// collapsible <details> section per file, with a file strip (jumper) listing
// every file, per-file +/- counts, and a visible marker on files whose path
// matches a riskAnnotations entry. This test asserts:
//   - one .diff-file-block per file, with the correct path + counts;
//   - a .diff-filejump per file in the strip, and clicking one expands + scrolls
//     to that file's section;
//   - a .diff-file-risk marker on a file whose path is in riskAnnotations[].paths;
//   - collapsing a file hides only its own lines;
//   - a hostile file path / diff line is rendered as TEXT (never injected markup).

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const TICKET = {
  id: "tkt-1",
  number: 7,
  title: "Ship the thing",
  status: "in_review",
  risk_level: "low",
  branch_name: "feat/x",
  pr_url: null,
};

// A multi-file unified diff. File 2's path is in riskAnnotations. File 3 carries a
// HOSTILE path + a hostile added line to prove the text-node escaping discipline.
const HOSTILE_PATH = 'src/x"><img src=x onerror=alert(1)>.ts';
const MULTI_FILE_DIFF = [
  "diff --git a/src/alpha.ts b/src/alpha.ts",
  "index 111..222 100644",
  "--- a/src/alpha.ts",
  "+++ b/src/alpha.ts",
  "@@ -1,2 +1,3 @@",
  " context",
  "+added alpha one",
  "+added alpha two",
  "-removed alpha",
  "diff --git a/config/secrets.env b/config/secrets.env",
  "index 333..444 100644",
  "--- a/config/secrets.env",
  "+++ b/config/secrets.env",
  "@@ -1 +1 @@",
  "-old secret",
  "+new secret",
  `diff --git a/${HOSTILE_PATH} b/${HOSTILE_PATH}`,
  `--- a/${HOSTILE_PATH}`,
  `+++ b/${HOSTILE_PATH}`,
  "@@ -0,0 +1 @@",
  "+<script>window.__pwned = 1</script>",
  "",
].join("\n");

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let payload: unknown = {};
      if (url.includes("/tickets/") && url.endsWith("/diff"))
        payload = {
          ticketId: TICKET.id,
          repos: [
            {
              repo: "svc",
              branch: "feat/x",
              baseBranch: "main",
              diff: MULTI_FILE_DIFF,
              files: 3,
              additions: 4,
              deletions: 3,
              truncated: false,
              riskAnnotations: [
                {
                  kind: "sensitive-path",
                  severity: "high",
                  detail: "touches a secrets file",
                  paths: ["config/secrets.env"],
                },
              ],
            },
          ],
        };
      else if (url.includes(`/tickets/${TICKET.id}`))
        payload = { ...TICKET, acceptance_criteria: [], evidence: [], events: [] };
      else if (url.includes("/tickets")) payload = { tickets: [TICKET] };
      return new Response(JSON.stringify(payload), {
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

function fileBlocks(): HTMLDetailsElement[] {
  return Array.from(document.querySelectorAll(".diff-file-block")) as HTMLDetailsElement[];
}
function jumpChips(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll(".diff-filejump")) as HTMLButtonElement[];
}

describe("web review gate: per-file diff sections + file jumper (Item A)", () => {
  beforeEach(() => {
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

  it("renders one collapsible section per file with the correct path and +/- counts", async () => {
    await bootReview();
    const blocks = fileBlocks();
    expect(blocks, "one .diff-file-block per file in the diff").toHaveLength(3);

    const paths = blocks.map((b) => b.querySelector(".diff-file-path")?.textContent);
    expect(paths[0]).toBe("src/alpha.ts");
    expect(paths[1]).toBe("config/secrets.env");
    expect(paths[2]).toBe(HOSTILE_PATH);

    // Per-file counts: alpha has +2 (the +++ line is not counted) and -1.
    const alphaStat = blocks[0]!.querySelector(".diff-file-summary .diff-filejump-stat");
    expect(alphaStat?.textContent).toContain("+2");
    expect(alphaStat?.textContent).toContain("1"); // −1
  });

  it("lists every file in the strip and clicking a chip expands + scrolls to that section", async () => {
    await bootReview();
    const chips = jumpChips();
    expect(chips, "one jumper chip per file").toHaveLength(3);

    const target = fileBlocks()[1]!; // config/secrets.env section
    target.open = false; // collapse it first
    const scrollSpy = vi.fn();
    target.scrollIntoView = scrollSpy;

    chips[1]!.click();
    expect(target.open, "clicking the chip expands the target section").toBe(true);
    expect(scrollSpy, "clicking the chip scrolls to the target section").toHaveBeenCalled();
  });

  it("marks files whose path matches a riskAnnotations entry (strip + section header)", async () => {
    await bootReview();
    const chips = jumpChips();
    // Only the secrets file (index 1) is risky.
    expect(chips[0]!.classList.contains("has-risk")).toBe(false);
    expect(chips[1]!.classList.contains("has-risk")).toBe(true);
    expect(chips[1]!.querySelector(".diff-file-risk"), "risk marker in the strip").not.toBeNull();

    const secretsBlock = fileBlocks()[1]!;
    expect(
      secretsBlock.querySelector(".diff-file-summary .diff-file-risk"),
      "risk marker in the section header",
    ).not.toBeNull();
  });

  it("collapsing a file hides only that file's lines", async () => {
    await bootReview();
    const blocks = fileBlocks();
    // Collapse file 0; its <pre> is inside the closed <details>, files 1/2 stay open.
    blocks[0]!.open = false;
    expect(blocks[0]!.open).toBe(false);
    expect(blocks[1]!.open, "other files stay open").toBe(true);
    expect(blocks[2]!.open, "other files stay open").toBe(true);
    // The collapsed file still OWNS its own <pre> (native <details> hides it),
    // and that <pre> is not shared with any other block.
    expect(blocks[0]!.querySelector(".diff-pre")).not.toBeNull();
    expect(blocks[1]!.querySelector(".diff-pre")).not.toBe(blocks[0]!.querySelector(".diff-pre"));
  });

  it("renders a hostile file path / diff line as text — no markup injection", async () => {
    await bootReview();
    // No injected <img>/<script> anywhere in the diff DOM.
    expect(document.querySelector(".diff-box img")).toBeNull();
    expect(document.querySelector(".diff-box script")).toBeNull();
    // The hostile path survives verbatim as text content.
    const hostileBlock = fileBlocks()[2]!;
    expect(hostileBlock.querySelector(".diff-file-path")?.textContent).toBe(HOSTILE_PATH);
    // The hostile added line is present as literal text, not executed markup.
    const hostileLine = Array.from(hostileBlock.querySelectorAll(".diff-line")).find((n) =>
      n.textContent?.includes("__pwned"),
    );
    expect(hostileLine, "the hostile added line renders as a text row").toBeDefined();
    expect(hostileLine!.querySelector("script")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
