// @vitest-environment jsdom
//
// The shared view parts in js/components.js (dashboard visual pass, package P2): the one
// heading scale with semantic tones, statCell sizes and its missing value, the
// measureTile (n line, period, delta with a word, Wilson whisker, sparkline, definition
// behind a disclosure), meter / meterRow / segBar, dataTable, callout, the inline empty
// state and the one button set. The old APIs (panelHead kit, kpiCard, band) still work.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const WEB = path.resolve(process.cwd(), "src/api/web/js");
const load = (f: string) =>
  import(`${pathToFileURL(path.join(WEB, f)).href}?t=${Date.now()}-${Math.random()}`);

let C: any;
beforeAll(async () => {
  C = await load("components.js");
});

const DAY = 86_400_000;
const weekly = (vals: (number | null)[]) =>
  vals.map((v, i) => ({ t: Date.UTC(2026, 0, 5) + i * 7 * DAY, v }));

describe("panelHead: one scale, semantic tones", () => {
  it("level 2 | 3 | 4 picks the tag and the size class", () => {
    for (const level of [2, 3, 4]) {
      const h = C.panelHead("Code index", null, null, { level });
      expect(h.querySelector(`h${level}.panel-title`)).not.toBeNull();
      expect(h.classList.contains(`ph-l${level}`)).toBe(true);
      expect(h.classList.contains("block")).toBe(false);
    }
  });

  it("tone paints a block; the old kit values map onto tones", () => {
    const needs = C.panelHead("Your move", null, null, { tone: "needs" });
    expect(needs.className).toContain("block-claret");
    expect(needs.className).toContain("tone-needs");
    expect(C.panelHead("A", null, null, { kit: "claret" }).className).toContain("tone-needs");
    expect(C.panelHead("A", null, null, { kit: "ink" }).className).toContain("tone-reference");
    expect(C.panelHead("A", null, null, { kit: "sky" }).className).toContain("tone-drawing");
    expect(C.panelHead("A", null, null, { kit: "red" }).className).toContain("tone-broken");
    expect(C.panelHead("A", null, null, { tone: "reference" }).className).toContain("block-ink");
    expect(C.panelHead("A", null, null, { tone: "drawing" }).className).toContain("block-sky");
    // No tone: a plain heading.
    expect(C.panelHead("A").className).toBe("panel-head");
  });

  it("an old string level ('h3') still sets the tag", () => {
    expect(C.panelHead("A", null, null, { level: "h3" }).querySelector("h3")).not.toBeNull();
  });
});

describe("statCell: sizes, proportional figures, a missing value", () => {
  it("size adds its class; the value is never tabular", () => {
    for (const size of ["hero", "row", "inline"]) {
      const c = C.statCell({ label: "Cycle time", value: "1.2", unit: "days", size });
      expect(c.classList.contains(`kpi--${size}`)).toBe(true);
      expect(c.querySelector(".kpi-val")!.classList.contains("tabnum")).toBe(false);
    }
  });

  it("'%' joins the value with no gap", () => {
    const c = C.statCell({ label: "Flow efficiency", value: "70", unit: "%" });
    expect(c.querySelector(".kpi-val")!.textContent).toBe("70%");
    expect(c.querySelector(".kpi-unit")).toBeNull();
  });

  it("null is a dash with a reason (title and visible), never a zero", () => {
    const c = C.statCell({ label: "Coverage", value: null, reason: "nothing measured yet" });
    const v = c.querySelector(".kpi-val")!;
    expect(v.textContent).toBe("\u2014");
    expect(v.getAttribute("title")).toBe("nothing measured yet");
    expect(c.querySelector(".kpi-reason")!.textContent).toBe("nothing measured yet");
  });

  it("a caller's own dash drops a '%' unit, never '\u2014%' (review)", () => {
    const c = C.statCell({ label: "Rework cost", value: "\u2014", unit: "%" });
    expect(c.textContent).toBe("Rework cost\u2014");
    const share = C.statCell({ label: "Spend", value: "\u2014", unit: "% of spend" });
    expect(share.querySelector(".kpi-val")!.textContent).toBe("\u2014");
    expect(share.querySelector(".kpi-unit")!.textContent).toBe("of spend");
    // A word unit is the reason, and stays.
    const wired = C.statCell({ label: "Skill hit-rate", value: "\u2014", unit: "not wired" });
    expect(wired.querySelector(".kpi-unit")!.textContent).toBe("not wired");
  });

  it("kpiCard is a deprecated wrapper over statCell", () => {
    const c = C.kpiCard({ label: "Cost", value: "$1.00", tone: "bad", delta: 4 });
    expect(c.classList.contains("kpi")).toBe(true);
    expect(c.querySelector(".kpi-val")!.textContent).toBe("$1.00");
  });

  it("a {t, v} series draws the new sparkline", () => {
    const c = C.statCell({
      label: "Done",
      value: "1",
      series: weekly([1, 2, 3, 4]),
      seriesFmt: (v: number) => `${v} shipped`,
    });
    expect(c.querySelector(".spark")).not.toBeNull();
    expect(c.querySelector(".spark")!.getAttribute("aria-label")).toBe(
      "Done, 4 weeks, 1 shipped to 4 shipped",
    );
  });
});

describe("measureTile: the measure spec", () => {
  const base = {
    label: "First-pass acceptance",
    unit: "%",
    k: 10,
    n: 11,
    period: "last 30 days",
    definition: "Done tickets with no send-back after review.",
  };

  it("value from k of n, the n line, the period chip, a Wilson whisker", () => {
    const t = C.measureTile(base);
    expect(t.querySelector(".mt-val")!.textContent).toBe("91%");
    expect(t.querySelector(".mt-n")!.textContent).toBe("10 of 11");
    expect(t.querySelector(".mt-period")!.textContent).toBe("last 30 days");
    const wh = t.querySelector(".mt-whisker")!;
    expect(wh.getAttribute("aria-label")).toMatch(/95% interval 62% to 98%/);
  });

  it("delta: glyph and word, coloured by direction x goodWhen", () => {
    const up = C.measureTile({ ...base, delta: { prev: 80, prevN: 20, goodWhen: "up" } });
    const d = up.querySelector(".mt-delta")!;
    expect(d.classList.contains("is-better")).toBe(true);
    expect(d.textContent).toContain("better");
    expect(d.querySelector(".mt-dglyph")).not.toBeNull();
    const down = C.measureTile({
      label: "Review time",
      value: 30,
      n: 12,
      format: (v: number) => `${v}m`,
      delta: { prev: 20, prevN: 12, goodWhen: "down" },
    });
    expect(down.querySelector(".mt-delta")!.classList.contains("is-worse")).toBe(true);
    expect(down.querySelector(".mt-delta")!.textContent).toContain("worse");
    expect(down.querySelector(".mt-n")!.textContent).toBe("n 12");
  });

  it("below minN: no delta, the rate greys", () => {
    const t = C.measureTile({ ...base, k: 4, n: 4, delta: { prev: 50, prevN: 30 } });
    expect(t.querySelector(".mt-delta")).toBeNull();
    expect(t.classList.contains("is-small")).toBe(true);
    expect(t.querySelector(".mt-n")!.textContent).toContain("4 of 4");
  });

  it("a sparkline only with >= 4 points; the definition behind a keyboard disclosure", () => {
    const t = C.measureTile({ ...base, series: weekly([80, 82, 85, 91]) });
    expect(t.querySelector(".spark")).not.toBeNull();
    const t3 = C.measureTile({ ...base, series: weekly([80, 82, 85]) });
    expect(t3.querySelector(".spark")).toBeNull();
    const def = t.querySelector("details.mt-def")!;
    expect(def.querySelector("summary")).not.toBeNull();
    expect(def.textContent).toContain("Done tickets with no send-back");
  });

  it("null value: a dash and the reason", () => {
    const t = C.measureTile({ label: "Escaped", value: null, note: "nothing accepted yet" });
    expect(t.querySelector(".mt-val")!.textContent).toBe("\u2014");
    expect(t.textContent).toContain("nothing accepted yet");
  });

  it("null value with no note still says why in visible text (review)", () => {
    const none = C.measureTile({ label: "First-pass", k: 0, n: 0 });
    expect(none.querySelector(".mt-val")!.textContent).toBe("\u2014");
    expect(none.querySelector(".mt-note")!.textContent).toBe("No sample yet.");
    const bare = C.measureTile({ label: "Review time", value: null });
    expect(bare.querySelector(".mt-note")!.textContent).toBe("No figure yet.");
  });
});

describe("meter, meterRow, segBar; band is a wrapper", () => {
  const width = (n: Element | null) => (n as HTMLElement | null)?.style.width;

  it("meter scales to max(limit, value), ticks only with a limit, shows an overrun", () => {
    const m = C.meter({ value: 30, limit: 25, label: "Spend today" });
    expect(m.classList.contains("is-over")).toBe(true);
    // The fill runs to the limit's tick; the overrun past it is its own red part.
    const at = `${((25 / 30) * 100).toFixed(2)}%`;
    expect(width(m.querySelector(".band-fill"))).toBe(at);
    expect((m.querySelector(".band-tick") as HTMLElement).style.left).toBe(at);
    const over = m.querySelector(".band-over") as HTMLElement;
    expect(over.style.left).toBe(at);
    expect(over.style.width).toBe(`${((5 / 30) * 100).toFixed(2)}%`);
    expect(m.getAttribute("aria-label")).toMatch(/over the limit/);
    const free = C.meter({ value: 40, max: 100, label: "Flow efficiency" });
    expect(free.querySelector(".band-tick")).toBeNull();
    expect(width(free.querySelector(".band-fill"))).toBe("40%");
    const warn = C.meter({ value: 23, limit: 25 });
    expect(warn.classList.contains("is-warn")).toBe(true);
    expect(warn.getAttribute("aria-label")).toMatch(/near the limit/);
  });

  it("meter with max 0 never says 'of 0' (review)", () => {
    expect(C.meter({ value: 0, max: 0, label: "Queue" }).getAttribute("aria-label")).toBe(
      "Queue: 0",
    );
  });

  it("band(value, max, label) keeps its DOM and label", () => {
    const b = C.band(5, 10, "Slots 5 of 10");
    expect(b.classList.contains("band")).toBe(true);
    expect(b.getAttribute("aria-label")).toBe("Slots 5 of 10");
    expect(width(b.querySelector(".band-fill"))).toBe("50%");
    expect(b.querySelector(".band-tick")).not.toBeNull();
  });

  it("meterRow: the figure column, zero draws nothing, an optional whisker", () => {
    const r = C.meterRow({ name: "Index added files", k: 15, n: 16, whisker: true });
    expect(r.querySelector(".mr-fig")!.textContent).toBe("94% · 15 of 16");
    expect(width(r.querySelector(".mr-fill"))).toBe(`${((15 / 16) * 100).toFixed(2)}%`);
    expect(r.querySelector(".mr-whisker")).not.toBeNull();
    const zero = C.meterRow({ name: "Nothing found", k: 0, n: 3 });
    expect(zero.querySelector(".mr-fill")).toBeNull();
    const none = C.meterRow({ name: "Not scouted", k: 0, n: 0 });
    expect(none.querySelector(".mr-fig")!.textContent).toBe("none yet");
    const custom = C.meterRow({
      name: "x",
      k: 1,
      n: 2,
      fmt: (k: number, n: number) => `${k}/${n}`,
    });
    expect(custom.querySelector(".mr-fig")!.textContent).toBe("1/2");
  });

  it("segBar: parts with 2px gaps, zero draws nothing, a legend with names and counts", () => {
    const s = C.segBar(
      [
        { label: "Index items", value: 5 },
        { label: "Named only", value: 3 },
        { label: "Nothing found", value: 0 },
      ],
      { label: "What each attempt started with" },
    );
    const segs = s.querySelectorAll(".seg");
    expect(segs.length).toBe(2);
    expect((segs[0] as HTMLElement).style.flexGrow).toBe("5");
    const bar = s.querySelector(".seg-bar")!;
    expect(bar.getAttribute("role")).toBe("img");
    expect(bar.getAttribute("aria-label")).toContain("Index items 5 (63%)");
    const legend = [...s.querySelectorAll(".seg-legend li")].map((li) => li.textContent);
    expect(legend).toEqual(["Index items 5", "Named only 3", "Nothing found 0"]);
  });
});

describe("dataTable", () => {
  const columns = [
    { key: "repo", label: "Repo" },
    { key: "files", label: "Files", numeric: true },
    { key: "built", label: "Built", format: (v: string) => `at ${v}` },
  ];
  const rows = [
    { repo: "svc", files: 1200, built: "noon", group: "a" },
    { repo: "web", files: null, built: "one", group: "b" },
  ];

  it("a real table: caption, th scope, numeric columns right and tabular, row headers", () => {
    const t = C.dataTable({ columns, rows, caption: "Code index by repo" });
    expect(t.classList.contains("dt-wrap")).toBe(true);
    expect(t.getAttribute("tabindex")).toBe("0");
    const table = t.querySelector("table.data-table")!;
    expect(table.querySelector("caption")!.textContent).toBe("Code index by repo");
    const ths = [...table.querySelectorAll("thead th")];
    expect(ths.map((th) => th.getAttribute("scope"))).toEqual(["col", "col", "col"]);
    expect(ths[1]!.classList.contains("dt-num")).toBe(true);
    const first = table.querySelector("tbody tr")!;
    expect(first.firstElementChild!.tagName).toBe("TH");
    expect(first.firstElementChild!.getAttribute("scope")).toBe("row");
    expect(first.children[1]!.textContent).toBe("1,200");
    expect(first.children[1]!.classList.contains("dt-num")).toBe(true);
    expect(first.children[2]!.textContent).toBe("at noon");
  });

  it("a missing value is a dash with a reason", () => {
    const t = C.dataTable({ columns, rows });
    const cell = t.querySelectorAll("tbody tr")[1]!.children[1]!;
    expect(cell.textContent).toBe("\u2014");
    expect(cell.querySelector("[title]")).not.toBeNull();
  });

  it("groupBy adds a group header row; stackOnPhone labels each cell", () => {
    const t = C.dataTable({ columns, rows, groupBy: "group", stackOnPhone: true });
    const groups = [...t.querySelectorAll("tr.dt-group th")].map((th) => th.textContent);
    expect(groups).toEqual(["a", "b"]);
    expect(t.classList.contains("dt-stack")).toBe(true);
    expect(t.querySelector("tbody td")!.getAttribute("data-label")).toBe("Files");
  });
});

describe("callout, emptyState inline, buttons", () => {
  it("callout tones: needs has the yellow card, bad the red glyph, info no wash", () => {
    const n = C.callout({ tone: "needs", title: "Waived:", body: "checked by hand" });
    expect(n.classList.contains("callout")).toBe(true);
    expect(n.classList.contains("callout-needs")).toBe(true);
    expect(n.querySelector(".ycard")).not.toBeNull();
    expect(n.textContent).toBe("Waived: checked by hand");
    const b = C.callout({ tone: "bad", title: "Failed", body: "x" });
    expect(b.querySelector(".glyph.g-failed")).not.toBeNull();
    const i = C.callout({ body: "Just so you know" });
    expect(i.classList.contains("callout-info")).toBe(true);
    expect(i.querySelector("svg")).toBeNull();
  });

  it("emptyState({ inline }) is one quiet line", () => {
    const e = C.emptyState("No repo indexed yet.", "It is built at onboard.", null, null, {
      inline: true,
    });
    expect(e.tagName).toBe("P");
    expect(e.classList.contains("empty-inline")).toBe(true);
    expect(e.textContent).toBe("No repo indexed yet. It is built at onboard.");
    const block = C.emptyState("Nothing here");
    expect(block.classList.contains("empty-state")).toBe(true);
  });

  it("button(): primary, secondary, danger, link", () => {
    expect(C.button("Approve", { kind: "primary" }).className).toBe("btn primary");
    expect(C.button("Edit").className).toBe("btn");
    expect(C.button("Delete", { kind: "danger" }).className).toBe("btn danger");
    const link = C.button("Show as table", { kind: "link" });
    expect(link.className).toBe("btn-link");
    expect(link.getAttribute("type")).toBe("button");
  });
});
