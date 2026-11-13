// @vitest-environment jsdom
//
// The ticket as one set of parts (dashboard visual pass, package P2; audit A-20, A-22..A-25):
// ticketRef (one face, three sizes, a link to Review when in review, one fallback),
// ticketHead (title first, meta under it), statusBadge({ size }) in place of the board's
// cardStatus, verdictMark (a glyph set apart from the lifecycle glyphs, always with a
// word), priorityTag and reasonText (plain words, the raw code in a title).

import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const WEB = path.resolve(process.cwd(), "src/api/web/js");
const load = (f: string) =>
  import(`${pathToFileURL(path.join(WEB, f)).href}?t=${Date.now()}-${Math.random()}`);

let S: any;
beforeAll(async () => {
  S = await load("status.js");
});

describe("ticketRef", () => {
  it("a link to the ticket, or to Review while in review; three sizes", () => {
    const a = S.ticketRef({ id: "t1", number: 12, status: "ready" });
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("href")).toBe("#/ticket/t1");
    expect(a.textContent).toBe("#12");
    expect(a.className).toBe("tref tref-m");
    expect(a.getAttribute("aria-label")).toBe("Ticket #12");
    const r = S.ticketRef({ id: "t2", number: 3, status: "in_review" }, { size: "s" });
    expect(r.getAttribute("href")).toBe("#/review/t2");
    expect(r.className).toBe("tref tref-s");
    expect(S.ticketRef({ id: "t3", number: 1 }, { size: "l" }).className).toBe("tref tref-l");
  });

  it("link: false is a plain span; one fallback for a missing number", () => {
    const s = S.ticketRef({ id: "abcdef1234567", status: "draft" }, { link: false });
    expect(s.tagName).toBe("SPAN");
    expect(s.textContent).toBe("abcdef12");
    expect(S.ticketRefText({})).toBe("?");
    expect(S.ticketRefText({ number: 0 })).toBe("#0");
  });
});

describe("ticketHead", () => {
  it("title first, the meta under it (ref, status, facts), then the lede", () => {
    const h = S.ticketHead(
      { id: "t1", number: 7, title: "Snooze a reminder", status: "in_review" },
      { facts: ["high risk", "svc"], lede: "Lets a person snooze for a day." },
    );
    expect(h.tagName).toBe("HEADER");
    const kids = [...h.children].map((c) => c.className);
    expect(kids.indexOf("th-title")).toBeLessThan(kids.indexOf("th-meta"));
    expect(h.querySelector("h1.th-title")!.textContent).toBe("Snooze a reminder");
    const meta = h.querySelector(".th-meta")!;
    expect(meta.querySelector(".tref")!.textContent).toBe("#7");
    expect(meta.querySelector(".badge.st")).not.toBeNull();
    expect(meta.textContent).toContain("high risk");
    expect(h.querySelector(".th-lede")!.textContent).toContain("snooze for a day");
    const p = S.ticketHead({ id: "t1", title: "x" }, { level: 0, cls: "rs-ticket" });
    expect(p.querySelector("p.th-title")).not.toBeNull();
    expect(p.classList.contains("rs-ticket")).toBe(true);
  });
});

describe("statusBadge({ size }), verdictMark, priorityTag, reasonText", () => {
  it("statusBadge keeps glyph + word and takes a size", () => {
    const b = S.statusBadge("failed", null, { size: "s" });
    expect(b.className).toContain("badge st status-failed st-s");
    expect(b.querySelector("svg")!.getAttribute("width")).toBe("14");
    expect(b.textContent).toBe("Failed");
    expect(S.statusBadge("done").querySelector("svg")!.getAttribute("width")).toBe("16");
  });

  it("verdictMark: its own glyphs, always with a word", () => {
    for (const [v, word] of [
      ["pass", "passed"],
      ["fail", "failed"],
      ["flag", "flagged"],
      ["skip", "skipped"],
      ["open", "open"],
    ]) {
      const m = S.verdictMark(v);
      expect(m.className).toBe(`vmark vm-${v}`);
      expect(m.querySelector("svg.vglyph")).not.toBeNull();
      expect(m.querySelector("svg.glyph")).toBeNull(); // not a lifecycle glyph
      expect(m.textContent).toBe(word);
    }
    expect(S.verdictMark("pass", { word: "holds" }).textContent).toBe("holds");
  });

  it("priorityTag says P0 with the word in its name", () => {
    const p = S.priorityTag(0);
    expect(p.textContent).toBe("P0");
    expect(p.getAttribute("title")).toBe("Priority 0 (highest)");
    expect(S.priorityTag(null)).toBeNull();
  });

  it("reasonText: plain words, the raw code kept in a title", () => {
    expect(S.reasonText("rework_exhausted")).toBe("Rework ran out of attempts");
    expect(S.reasonText("tester_failed")).toBe("Tester failed it");
    expect(S.reasonText("risk=low")).toBe("Low risk");
    expect(S.reasonText("some_new_code")).toBe("Some new code");
    const n = S.reasonTag("budget_exhausted");
    expect(n.textContent).toBe("Budget used up");
    expect(n.getAttribute("title")).toBe("Server reason code: budget_exhausted");
  });
});
