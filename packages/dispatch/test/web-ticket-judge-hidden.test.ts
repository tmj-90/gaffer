// @vitest-environment jsdom
//
// BLINDING (review13/4): the ticket page's match report reads the events GET /tickets/:id
// returns. While the ticket is in review and the judge's view has not been opened, the
// server hands the eval judge's lane verdict back as `{ lane: "eval-judge", hidden: true }`
// (ticketReadService.hideJudgeInReview); the page says the grade is hidden and shows no
// verdict. Once it is opened (or the ticket left review) the verdict line is as before.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const CARDS = path.join(path.resolve(process.cwd(), "src/api/web"), "js/views/ticket-cards.js");

type Ev = { id: string; event_type: string; payload_json: string; created_at: string };
const ev = (id: string, type: string, payload: unknown, at: string): Ev =>
  ({
    id,
    event_type: type,
    payload_json: JSON.stringify(payload),
    created_at: at,
    actor_type: "system",
    actor_id: null,
  }) as Ev;

async function report(events: Ev[]): Promise<string> {
  const mod = (await import(pathToFileURL(CARDS).href)) as {
    ticketMatchReport: (events: Ev[], repos: unknown[]) => HTMLElement;
  };
  const node = mod.ticketMatchReport(events, []);
  document.body.append(node);
  return [...node.querySelectorAll(".ev-type")].map((e) => e.textContent ?? "").join("\n");
}

describe("the ticket page's match report and the judge's hidden grade", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("a hidden eval judge verdict says it is hidden and shows no verdict", async () => {
    const text = await report([
      ev("e1", "ticket.created", {}, "2026-11-01T10:00:00Z"),
      ev("e2", "ticket.lane_verdict", { lane: "eval-judge", hidden: true }, "2026-11-01T10:05:00Z"),
      ev("e3", "ticket.lane_verdict", { lane: "tester", verdict: "pass" }, "2026-11-01T10:06:00Z"),
    ]);
    expect(text).toContain("Eval judge (a model's opinion): hidden until you decide");
    expect(text).not.toMatch(/Eval judge[^\n]*: (pass|borderline|fail|\?)/);
    expect(text).toContain("Tester: pass");
  });

  it("an open verdict reads as before", async () => {
    const text = await report([
      ev(
        "e1",
        "ticket.lane_verdict",
        { lane: "eval-judge", verdict: "fail" },
        "2026-11-01T10:05:00Z",
      ),
    ]);
    expect(text).toContain("Eval judge (a model's opinion): fail");
  });
});
