// @vitest-environment jsdom
//
// The Memory view under the live refresh (the SSE push / the 9 s tick) and its own
// lore re-reads. The browser scenario suite S9 lost an open "Reject" (reason +
// confirm) on a slow CI runner: the lore card's filter re-read landed after the
// reject form was opened on the card it replaced, and the row (confirm button and
// all) was rebuilt without it. The same loss was reachable from the refresh: after a
// filter change the view kept the signature of its FIRST read, so the next tick
// rebuilt the whole view even with nothing changed, and any change to another row
// rebuilt the open row too.
//
// Now: an unchanged read keeps the DOM (also after a filter change, because the
// card re-signs the view), and an open inline form is carried into the new tree in
// place of its row's fresh twin when the data did change, focus and text included.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "app.js");

type Lore = Record<string, unknown>;
const draft = (id: string, title: string): Lore => ({
  id,
  title,
  summary: `${title}.`,
  status: "draft",
  kind: "convention",
  confidence: "medium",
  source: "review",
  repos: ["sample-repo"],
  tags: [],
  stale: false,
  flagged: false,
});
let lore: Lore[] = [];
/** When set, the next lore read waits for this before answering (a slow server). */
let holdLore: Promise<void> | null = null;
const loreReads: string[] = [];

function json(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/memory/digest/")) return json({ available: true, digest: null });
      if (url.includes("/api/memory/features/")) return json({ available: true, features: [] });
      if (url.includes("/api/memory/lore")) {
        loreReads.push(url);
        const hold = holdLore;
        holdLore = null;
        if (hold) await hold;
        const status = new URL(url, "http://x").searchParams.get("status");
        const page = status ? lore.filter((l) => l.status === status) : lore;
        return json({ available: true, lore: page, total: page.length, limit: 50, offset: 0 });
      }
      if (url.includes("/repositories"))
        return json({ repositories: [{ id: "r1", name: "sample-repo" }] });
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
  location.hash = "#/memory/sample-repo";
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle(n = 10): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}
async function boot(): Promise<void> {
  await import(`${pathToFileURL(APP_JS).href}?t=${Date.now()}-${Math.random()}`);
  await settle();
}
const view = () => document.querySelector("#app > .view");
const row = (id: string) => document.querySelector(`.lore-row[data-lore-id="${id}"]`);
/** Open the in-row Reject on draft `id` and type a reason; answers the confirm button. */
async function openReject(id: string, reason: string): Promise<HTMLButtonElement> {
  (row(id)!.querySelector("button.lore-reject") as HTMLButtonElement).click();
  await tick();
  const why = row(id)!.querySelector("input.lore-reason") as HTMLInputElement;
  why.value = reason;
  return row(id)!.querySelector("button.lore-reject-confirm") as HTMLButtonElement;
}
/** One live refresh tick, with the focus OFF the card so nothing but the data decides. */
async function refreshTick(): Promise<void> {
  (document.activeElement as HTMLElement | null)?.blur();
  const reads = loreReads.length;
  vi.advanceTimersByTime(9000);
  await settle(14);
  expect(loreReads.length).toBeGreaterThan(reads); // the refresh did re-read
}
async function filterDrafts(): Promise<void> {
  const sel = document.querySelector("select.lore-filter-status") as HTMLSelectElement;
  sel.value = "draft";
  sel.dispatchEvent(new Event("change"));
  await settle();
}

describe("web: the Memory view keeps an open reject through refreshes", () => {
  beforeEach(() => {
    lore = [draft("d1", "Prefer pure helpers"), draft("d2", "Name tests after behaviour")];
    holdLore = null;
    loreReads.length = 0;
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

  it("a refresh with unchanged data leaves the view and the open confirm button attached", async () => {
    await boot();
    const before = view();
    const confirm = await openReject("d1", "too specific");
    await refreshTick();
    expect(view()).toBe(before);
    expect(confirm.isConnected).toBe(true);
    expect(row("d1")!.contains(confirm)).toBe(true);
  });

  it("keeps the DOM after a filter change too (the card re-signs the view)", async () => {
    await boot();
    await filterDrafts();
    const before = view();
    const confirm = await openReject("d2", "not a convention");
    await refreshTick();
    expect(view()).toBe(before);
    expect(confirm.isConnected).toBe(true);
  });

  it("carries the open form into the new view when another row changed", async () => {
    await boot();
    const before = view();
    const confirm = await openReject("d1", "too specific");
    lore = [draft("d3", "A new draft from the distiller"), ...lore];
    await refreshTick();
    // The data changed, so the view was rebuilt and shows the new row…
    expect(view()).not.toBe(before);
    expect(row("d3")).not.toBeNull();
    // …and the operator's open reject is the same form, in its row, reason kept.
    expect(confirm.isConnected).toBe(true);
    expect(row("d1")!.contains(confirm)).toBe(true);
    expect((row("d1")!.querySelector("input.lore-reason") as HTMLInputElement).value).toBe(
      "too specific",
    );
    // Its handlers came with it: Cancel puts Approve / Reject back on the row.
    (row("d1")!.querySelector(".lore-reject-btns button.quiet") as HTMLButtonElement).click();
    expect(row("d1")!.querySelector(".lore-reject-form")).toBeNull();
    expect(row("d1")!.querySelector("button.lore-approve")).not.toBeNull();
  });

  it("drops the form with its row when the draft is gone from the new data", async () => {
    await boot();
    const confirm = await openReject("d1", "too specific");
    lore = lore.filter((l) => l.id !== "d1");
    await refreshTick();
    expect(row("d1")).toBeNull();
    expect(confirm.isConnected).toBe(false);
  });

  it("a filter re-read that lands after the reject was opened keeps the form, its focus and text", async () => {
    await boot();
    let release!: () => void;
    holdLore = new Promise<void>((r) => (release = r));
    const sel = document.querySelector("select.lore-filter-status") as HTMLSelectElement;
    sel.value = "draft";
    sel.dispatchEvent(new Event("change"));
    await settle();
    // The slow read has not answered: the reject opens on the card it will replace.
    const confirm = await openReject("d1", "too specific");
    const why = row("d1")!.querySelector("input.lore-reason") as HTMLInputElement;
    why.focus();
    release();
    await settle();
    expect(loreReads.at(-1)).toContain("status=draft");
    expect(confirm.isConnected).toBe(true);
    expect(row("d1")!.contains(confirm)).toBe(true);
    expect(document.activeElement).toBe(why);
    expect(why.value).toBe("too specific");
  });
});
