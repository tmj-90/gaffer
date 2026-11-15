// @vitest-environment jsdom
//
// Views on the shared parts (audit A-31, A-32, A-34, A-35, A-36, A-42): the Overview's
// League table is the one dataTable (numeric columns, the share done as "3 of 6 · 50%"
// beside the shared meter, a missing spend as a dash with its reason), and the quiet
// "nothing here" lines on the Overview's pages and a ground's page are the one inline
// emptyState, not hand-rolled paragraphs.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const VIEWS = path.join(path.resolve(process.cwd(), "src/api/web"), "js/views");
const load = (f: string) =>
  import(`${pathToFileURL(path.join(VIEWS, f)).href}?t=${Date.now()}-${Math.random()}`);

describe("web: views on the shared parts", () => {
  it("the League table is a dataTable with the share done counted and metered", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const { leagueTable } = await load("programme.js");
    const f = {
      summary: {
        repoProgress: [
          { repo: "api", total: 6, done: 3, pct: 50, inFlight: 2, blocked: 1 },
          { repo: "web", total: 4, done: 1, pct: 25, inFlight: 1, blocked: 0 },
        ],
      },
      cost: { by_repo: [{ repo: "api", total_cost_usd: 1.5 }] },
    };
    const page = leagueTable(f);
    const table = page.querySelector("table.data-table")!;
    expect(table).not.toBeNull();
    expect(table.querySelector("caption")?.textContent).toMatch(/share of their tickets done/);
    const first = table.querySelector("tbody tr")!;
    const done = first.querySelector("td.dt-num .lt-done")!;
    expect(done.textContent).toBe("3 of 6 · 50%");
    expect(done.querySelector(".meter")).not.toBeNull();
    // A repo with no spend recorded: a dash with its reason, never "$0.00".
    const second = table.querySelectorAll("tbody tr")[1]!;
    expect(second.querySelector(".dt-missing")?.getAttribute("title")).toBe("no spend recorded");
    expect(page.querySelector(".pct-bar")).toBeNull();
  });

  it("no repos: the League table says so in one inline empty line", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const { leagueTable } = await load("programme.js");
    const page = leagueTable({ summary: { repoProgress: [] }, cost: null });
    expect(page.querySelector(".empty-inline")?.textContent).toBe("No repos with tickets yet.");
    expect(page.querySelector("p.quiet")).toBeNull();
  });

  it("a ground's empty fixture list is the inline emptyState", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const { fixtureList } = await load("scope-node.js");
    const node = fixtureList([], { empty: "Nothing in play here." });
    expect(node.className).toBe("empty-inline");
    expect(node.textContent).toBe("Nothing in play here.");
  });

  it("a ground's fixture row numbers its ticket with ticketRef s", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const { fixtureList } = await load("scope-node.js");
    const node = fixtureList([{ id: "tk-1", number: 4, title: "Archive", status: "draft" }], {
      empty: "none",
    });
    expect(node.querySelector(".repo-ticket-row .tref")?.className).toBe("tref tref-s");
    expect(node.querySelector(".repo-ticket-row .num")).toBeNull();
  });

  it("the Fixtures page numbers each ready ticket with ticketRef s, not a bold #N", async () => {
    document.body.innerHTML = `<main id="app"></main>`;
    const { fixtures } = await load("programme.js");
    const t = { id: "tk-3", number: 3, title: "Due dates", status: "ready", priority: 1 };
    const page = fixtures({ tickets: [t], details: new Map(), byId: new Map([[t.id, t]]) });
    const ref = page.querySelector("a .tref")!;
    expect(ref.className).toBe("tref tref-s");
    expect(ref.textContent).toBe("#3");
    expect(page.querySelector("a > b")).toBeNull();
  });
});
