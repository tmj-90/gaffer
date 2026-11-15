// @vitest-environment jsdom
//
// On the pitch (the Work board's claims panel) on the shared parts: each row's ticket
// number is ticketRef at row size, an empty panel is one quiet emptyState line, and
// Revoke's two-press confirmation still names the ticket it stops.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const BOARD_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "js/views/board.js");

const CLAIM = {
  claim_id: "cl-1",
  ticket_id: "tk-5",
  ticket_number: 5,
  ticket_title: "Export tasks to CSV",
  ticket_status: "in_progress",
  agent_id: "ag-1",
  agent_display_name: "Kit Carson",
  expires_at: new Date(Date.now() + 600_000).toISOString(),
  heartbeat_at: new Date().toISOString(),
  branch: "agent/5",
};

async function load() {
  document.body.innerHTML = `<main id="app"></main>`;
  return import(`${pathToFileURL(BOARD_JS).href}?t=${Date.now()}-${Math.random()}`);
}

describe("web: On the pitch on the shared parts", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("a claim row's number is ticketRef s; Revoke's confirmation names the ticket", async () => {
    const { renderClaimsPanel } = await load();
    const page = renderClaimsPanel([CLAIM]);
    document.body.appendChild(page);
    expect(page.querySelector(".cl-num .tref")?.className).toBe("tref tref-s");
    expect(page.querySelector(".cl-num")?.textContent).toBe("#5");
    const revoke = [...page.querySelectorAll("button")].find((b) => b.textContent === "Revoke")!;
    expect(revoke.getAttribute("aria-label")).toBe("Revoke Kit Carson's claim on #5");
    revoke.click();
    expect(revoke.getAttribute("aria-label")).toBe("Press again to stop Kit Carson's work on #5");
  });

  it("no claims: one quiet inline empty line, no hand-rolled paragraph", async () => {
    const { renderClaimsPanel } = await load();
    const page = renderClaimsPanel([]);
    expect(page.querySelector(".empty-inline")?.textContent).toBe(
      "No agents are working right now.",
    );
    expect(page.querySelector(".claims-empty")).toBeNull();
  });
});
