// @vitest-environment jsdom
//
// DOM test for fix 4 (the human backstop to the P0 done-gate): the Review
// surface's Approve button must be DISABLED, with a clear banner, whenever the
// delivery diff could not be loaded (repo_not_on_disk / no_branch / git_error /
// empty) — a human must not approve a change they couldn't actually see. When the
// diff loads with a real, non-empty change, Approve becomes enabled.

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

/**
 * Stub the endpoints the Review view touches. `diffRepos` controls the
 * `/tickets/:id/diff` payload so a test can drive the loaded/empty/unavailable
 * branches of the approve guard.
 */
function stubFetch(diffRepos: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let body: unknown = {};
      if (url.includes("/tickets/") && url.endsWith("/diff"))
        body = { ticketId: TICKET.id, repos: diffRepos };
      else if (url.includes(`/tickets/${TICKET.id}`))
        body = { ...TICKET, acceptance_criteria: [], evidence: [], events: [] };
      else if (url.includes("/tickets?status=in_review")) body = { tickets: [TICKET] };
      else if (url.includes("/tickets")) body = { tickets: [TICKET] };
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

/** Boot the SPA fresh and let the async Review render + diff load settle. */
async function bootReview(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick(); // router() → renderReview() (fetches tickets + details)
  await tick(); // the async diff load resolves + applyDiffState fires
  await tick();
}

function approveButton(): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find((b) =>
    b.textContent?.includes("Approve"),
  ) as HTMLButtonElement | undefined;
}

describe("web fix 4: Approve is gated on a diff the human could actually see", () => {
  beforeEach(() => {
    mountShell();
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("DISABLES Approve and shows a banner when the diff is unavailable (repo_not_on_disk)", async () => {
    stubFetch([
      {
        repo: "svc",
        branch: "feat/x",
        baseBranch: "main",
        diff: "",
        files: 0,
        additions: 0,
        deletions: 0,
        truncated: false,
        unavailable: "repo_not_on_disk",
        message: 'Repo path "/x" is not on disk.',
      },
    ]);
    await bootReview();

    const approve = approveButton();
    expect(approve, "Approve button should render in the review card").toBeDefined();
    expect(approve!.hasAttribute("disabled")).toBe(true);

    const banner = document.querySelector(".diff-block-banner") as HTMLElement | null;
    expect(banner).not.toBeNull();
    expect(banner!.style.display).not.toBe("none");
    expect(banner!.textContent).toContain("Approve blocked");
    expect(banner!.textContent?.toLowerCase()).toContain("on disk");
  });

  it("DISABLES Approve when the diff loaded empty (no real change to review)", async () => {
    stubFetch([
      {
        repo: "svc",
        branch: "feat/x",
        baseBranch: "main",
        diff: "",
        files: 0,
        additions: 0,
        deletions: 0,
        truncated: false,
        unavailable: "empty",
        message: "No changes between main and feat/x.",
      },
    ]);
    await bootReview();

    const approve = approveButton();
    expect(approve!.hasAttribute("disabled")).toBe(true);
    const banner = document.querySelector(".diff-block-banner") as HTMLElement | null;
    expect(banner!.style.display).not.toBe("none");
  });

  it("ENABLES Approve when the diff loaded with a real, non-empty change", async () => {
    stubFetch([
      {
        repo: "svc",
        branch: "feat/x",
        baseBranch: "main",
        diff: "diff --git a/x b/x\n+real change\n",
        files: 1,
        additions: 1,
        deletions: 0,
        truncated: false,
      },
    ]);
    await bootReview();

    const approve = approveButton();
    expect(approve, "Approve button should render").toBeDefined();
    expect(approve!.hasAttribute("disabled")).toBe(false);

    const banner = document.querySelector(".diff-block-banner") as HTMLElement | null;
    // Banner present in the DOM but hidden when approvable.
    expect(banner!.style.display).toBe("none");
  });
});
