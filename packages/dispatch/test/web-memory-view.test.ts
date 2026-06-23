// @vitest-environment jsdom
//
// DOM test for the SPA's Memory view (src/api/web/app.js): Repo Digest +
// Feature ledger (Current/Building/Backlog split, scope-node grouping, freshness
// line) + Lore list, plus the graceful "memory unavailable" state. The view
// reads the Dispatch API's server-side memory endpoints — ONE origin.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

const DIGEST = {
  available: true,
  digest: {
    repo: "sample-repo",
    overview: "A pint-tracking app for Guinness lovers.",
    structure: "Next.js app router with a Postgres backend.",
    conventions: "Strict TypeScript. Zod at the boundaries.",
    stack: "Next.js, Postgres, Vitest.",
    meta: { updatedAt: "2026-06-20T10:00:00Z", source: "merge:#42" },
    caveat: "NOTE: this digest is a summary — verify it against the code for high-stakes work.",
  },
};

const FEATURES = {
  available: true,
  features: [
    {
      status: "shipped",
      name: "Pour logging",
      summary: "Record a pour.",
      id: "f1",
      scopeNode: "ingest",
      area: "core",
      provenance: "merge:#42",
    },
    {
      status: "building",
      name: "Leaderboard",
      summary: "Weekly leaderboard.",
      id: "f2",
      scopeNode: "social",
      area: null,
      provenance: null,
    },
    {
      status: "backlog",
      name: "Push reminders",
      summary: "Nudge users.",
      id: "f3",
      scopeNode: null,
      area: null,
      provenance: null,
    },
  ],
};

const LORE = {
  available: true,
  lore: [
    {
      id: "l1",
      title: "Hash with argon2id",
      summary: "No bcrypt.",
      status: "active",
      confidence: "high",
      source: "manual",
      repos: ["sample-repo"],
      tags: ["security"],
      stale: false,
    },
  ],
};

/** Records each POST /repos/onboard call so tests can assert the button wired through. */
const onboardCalls: Array<{ method: string; body: unknown }> = [];

/** Stub fetch with optional overrides per surface (digest/features/lore). */
function stubFetch(overrides: Partial<Record<"digest" | "features" | "lore", unknown>> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      let body: unknown = {};
      if (url.includes("/repos/onboard")) {
        onboardCalls.push({ method, body: init?.body ? JSON.parse(String(init.body)) : {} });
        body = { onboarding: true, repo: "sample-repo", run: { started: true, pid: 1 } };
      } else if (url.includes("/api/memory/digest/")) body = overrides.digest ?? DIGEST;
      else if (url.includes("/api/memory/features/")) body = overrides.features ?? FEATURES;
      else if (url.includes("/api/memory/lore")) body = overrides.lore ?? LORE;
      else if (url.includes("/repositories"))
        body = { repositories: [{ id: "r1", name: "sample-repo" }] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function mountShell(hash: string): void {
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
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}`);
  await tick();
  await tick();
}

describe("web: Memory view", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });
  beforeEach(() => {
    vi.resetModules();
    onboardCalls.length = 0;
  });

  it("renders the repo picker and a Memory nav entry", async () => {
    stubFetch();
    mountShell("#/memory");
    await boot();
    expect(document.body.textContent).toContain("Memory");
    // Nav exposes a Memory destination.
    const nav = Array.from(document.querySelectorAll("[data-area='memory']"));
    expect(nav.length).toBeGreaterThan(0);
    // Repo picker is present.
    expect(document.querySelector("select[aria-label='Select a repo']")).not.toBeNull();
  });

  it("renders the repo digest with its four sections, freshness line and caveat", async () => {
    stubFetch();
    mountShell("#/memory/sample-repo");
    await boot();
    const text = document.body.textContent || "";
    expect(text).toContain("Repo Digest");
    expect(text).toContain("Overview");
    expect(text).toContain("Structure");
    expect(text).toContain("Conventions");
    expect(text).toContain("Stack");
    expect(text).toContain("pint-tracking app");
    // Freshness ("updated_at · source") + honesty caveat both shown.
    expect(text).toContain("source: merge:#42");
    expect(text).toMatch(/updated/);
    expect(text).toMatch(/verify it against the code/);
  });

  it("splits the feature ledger into Current / Building / Backlog and groups by scope node", async () => {
    stubFetch();
    mountShell("#/memory/sample-repo");
    await boot();
    const text = document.body.textContent || "";
    expect(text).toContain("Current");
    expect(text).toContain("Building");
    expect(text).toContain("Backlog");
    expect(text).toContain("Pour logging");
    expect(text).toContain("Leaderboard");
    expect(text).toContain("Push reminders");
    // Scope-node grouping is visible (the shipped feature sits under @ingest).
    expect(text).toContain("@ingest");
    expect(text).toContain("@social");
    // Lanes are split by status.
    expect(document.querySelector(".ledger-lane[data-status='shipped']")).not.toBeNull();
    expect(document.querySelector(".ledger-lane[data-status='building']")).not.toBeNull();
    expect(document.querySelector(".ledger-lane[data-status='backlog']")).not.toBeNull();
  });

  it("renders the read-only lore list", async () => {
    stubFetch();
    mountShell("#/memory/sample-repo");
    await boot();
    const text = document.body.textContent || "";
    expect(text).toContain("Lore");
    expect(text).toContain("Hash with argon2id");
    expect(document.querySelector(".lore-row")).not.toBeNull();
  });

  it("renders a clean 'memory unavailable' state when a surface degrades", async () => {
    stubFetch({
      digest: { available: false, reason: "Memory is not configured — set MEMORY_CLI_BIN." },
      features: { available: false, reason: "Memory is not configured." },
      lore: { available: false, reason: "Memory is not configured." },
    });
    mountShell("#/memory/sample-repo");
    await boot();
    const text = document.body.textContent || "";
    expect(text).toContain("Memory unavailable");
    expect(document.querySelectorAll(".memory-unavailable").length).toBeGreaterThan(0);
    // The dashboard did NOT crash — the view head still rendered.
    expect(text).toContain("Repo Digest");
  });

  it("renders an 'Onboard a repo' button in the Memory view header", async () => {
    stubFetch();
    mountShell("#/memory");
    await boot();
    // Header action present even with nothing selected.
    const head = document.querySelector(".view-head-actions");
    expect(head).not.toBeNull();
    expect(head!.textContent || "").toContain("Onboard a repo");
  });

  it("renders an 'Onboard a repo' action in the digest empty-state and it POSTs to /repos/onboard", async () => {
    // No digest yet → the empty-state should invite onboarding THIS repo.
    stubFetch({ digest: { available: true, digest: null } });
    mountShell("#/memory/sample-repo");
    await boot();
    const text = document.body.textContent || "";
    expect(text).toContain("No digest for sample-repo yet");

    // The empty-state carries its own onboard action.
    const esBtn = document.querySelector(".es-actions button") as HTMLButtonElement | null;
    expect(esBtn).not.toBeNull();
    expect(esBtn!.textContent || "").toContain("Onboard a repo");

    // Opening the picker and submitting POSTs the targeted repo to /repos/onboard.
    esBtn!.click();
    await tick();
    // The picker form lives inside the slide-up sheet; find IT (not the empty-state).
    const form = document.querySelector("form.form-grid") as HTMLFormElement | null;
    expect(form).not.toBeNull();
    // The picker pre-selects the targeted repo.
    const sel = form!.querySelector("select") as HTMLSelectElement;
    expect(sel.value).toBe("sample-repo");
    if (typeof form!.requestSubmit === "function") form!.requestSubmit();
    else form!.dispatchEvent(new Event("submit", { cancelable: true }));
    await tick();
    await tick();

    expect(onboardCalls.length).toBeGreaterThan(0);
    const last = onboardCalls[onboardCalls.length - 1]!;
    expect(last.method).toBe("POST");
    expect(last.body).toMatchObject({ repo: "sample-repo" });
  });
});
