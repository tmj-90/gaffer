// @vitest-environment jsdom
//
// The chart primitives in js/charts.js (dashboard visual pass, package P2; audit F-B1..F-B4):
// sparkline() takes only {t, v} on an even time grid with at least 4 real points, breaks
// at nulls, keeps its end dot round (an HTML dot, not a stretched SVG circle), reads out
// on hover AND keyboard focus and has a summary for a screen reader; barChart() caps bars
// at 24px with rounded data ends, picks an adaptive duration unit for nice ticks and
// shares one tooltip across focusable bars; chartFigure() owns the table view.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const WEB = path.resolve(process.cwd(), "src/api/web/js");
const load = (f: string) =>
  import(`${pathToFileURL(path.join(WEB, f)).href}?t=${Date.now()}-${Math.random()}`);

let K: any;
beforeAll(async () => {
  K = await load("charts.js");
});

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);
const weekly = (vals: (number | null)[]) => vals.map((v, i) => ({ t: T0 + i * 7 * DAY, v }));

describe("sparkline", () => {
  it("draws nothing below 4 real points, for categories, or on an uneven grid", () => {
    expect(K.sparkline(weekly([1, 2, 3]))).toBeNull();
    expect(K.sparkline(weekly([1, null, 2, null, 3]))).toBeNull();
    expect(K.sparkline([1, 2, 3, 4, 5])).toBeNull();
    expect(K.sparkline([{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }])).toBeNull();
    const uneven = [0, 1, 2, 9].map((d, i) => ({ t: T0 + d * DAY, v: i }));
    expect(K.sparkline(uneven)).toBeNull();
  });

  it("a 2px non-scaling line that breaks at a null, a round end dot, a faint baseline", () => {
    const s = K.sparkline(weekly([80, 82, null, 85, 91]), { baseline: 84, label: "First-pass" });
    const path = s.querySelector("path.spark-line")!;
    expect(path.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    // Two runs: M..L (before the gap) and M..L (after it).
    expect((path.getAttribute("d")!.match(/M/g) || []).length).toBe(2);
    expect(s.querySelector(".spark-dot")).not.toBeNull();
    expect(s.querySelector("circle")).toBeNull();
    expect(s.querySelector("line.spark-baseline")).not.toBeNull();
  });

  it("an aria summary like 'First-pass, 5 weeks, 80 to 91'", () => {
    const s = K.sparkline(weekly([80, 82, 84, 85, 91]), {
      label: "First-pass",
      fmt: (v: number) => `${v}%`,
    });
    expect(s.getAttribute("aria-label")).toBe("First-pass, 5 weeks, 80% to 91%");
    expect(s.getAttribute("tabindex")).toBe("0");
  });

  it("reads out on keyboard focus and arrows, and on hover", () => {
    const s = K.sparkline(weekly([1, 2, 3, 4]), { fmt: (v: number) => `${v} done` });
    document.body.appendChild(s);
    const out = s.querySelector(".spark-readout")!;
    expect((out as HTMLElement).hidden).toBe(true);
    s.dispatchEvent(new FocusEvent("focus"));
    expect((out as HTMLElement).hidden).toBe(false);
    expect(out.textContent).toContain("4 done");
    s.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    expect(out.textContent).toContain("3 done");
    s.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
    expect(out.textContent).toContain("1 done");
    s.dispatchEvent(new FocusEvent("blur"));
    expect((out as HTMLElement).hidden).toBe(true);
    const ev = new MouseEvent("pointermove", { clientX: 0 });
    s.querySelector("svg")!.dispatchEvent(ev);
    expect((out as HTMLElement).hidden).toBe(false);
    s.remove();
  });
});

describe("barChart", () => {
  const rows = [
    { label: "1/11", value: 2 * 60_000 },
    { label: "2/11", value: 30 * 60_000 },
    { label: "3/11", value: null },
    { label: "4/11", value: 0 },
  ];

  it("bars at most 24px wide with rounded data ends, square at the baseline", () => {
    const c = K.barChart({ rows, unit: "ms", width: 720 });
    const bars = [...c.querySelectorAll("path.bc-bar")];
    expect(bars.length).toBe(2); // null and zero draw nothing
    for (const b of bars) expect(Number(b.getAttribute("data-w"))).toBeLessThanOrEqual(24);
    expect(bars[0]!.getAttribute("d")).toMatch(/Q|A/); // rounded top corners
  });

  it("nice ticks in an adaptive unit: 2 to 30 minutes reads in minutes, not 0.0 days", () => {
    const c = K.barChart({ rows, unit: "ms" });
    const ticks = [...c.querySelectorAll(".bc-ytick")].map((t) => t.textContent);
    expect(ticks[0]).toBe("0");
    expect(ticks.at(-1)).toMatch(/^\d+m$/);
    expect(ticks.join(" ")).not.toMatch(/d$/);
    const days = K.barChart({ rows: [{ label: "a", value: 3.5 }], unit: "days" });
    const dt = [...days.querySelectorAll(".bc-ytick")].map((t) => t.textContent);
    expect(dt.at(-1)).toMatch(/d$/);
  });

  it("focusable bars (one tab stop, arrows move) share one tooltip", () => {
    const c = K.barChart({ rows, unit: "ms", label: "Cycle time by day" });
    document.body.appendChild(c);
    const hits = [...c.querySelectorAll(".bc-hit")] as SVGElement[];
    expect(hits.length).toBe(4);
    expect(hits.filter((h) => h.getAttribute("tabindex") === "0").length).toBe(1);
    const tip = c.querySelector(".bc-tip") as HTMLElement;
    hits[1]!.dispatchEvent(new FocusEvent("focus"));
    expect(tip.hidden).toBe(false);
    expect(tip.textContent).toBe("30m2/11");
    hits[2]!.dispatchEvent(new FocusEvent("focus"));
    expect(tip.textContent).toContain("no data");
    expect(c.querySelectorAll(".bc-tip").length).toBe(1);
    hits[1]!.focus();
    hits[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(hits[2]);
    c.remove();
  });

  it("the shared tooltip stays inside the chart at its first and last bar (review)", () => {
    // At 390px the last bar's tip, centred on the bar, ran past the chart onto the
    // card's edge. jsdom has no layout: give the chart 330px and the tip 70px.
    const c = K.barChart({ rows, unit: "ms", width: 360 });
    document.body.appendChild(c);
    const tip = c.querySelector(".bc-tip") as HTMLElement;
    Object.defineProperty(c, "clientWidth", { configurable: true, value: 330 });
    Object.defineProperty(tip, "offsetWidth", { configurable: true, value: 70 });
    const hits = [...c.querySelectorAll(".bc-hit")] as SVGElement[];
    for (const h of [hits[0]!, hits[3]!]) {
      h.dispatchEvent(new FocusEvent("focus"));
      const left = parseFloat(tip.style.left);
      expect(tip.style.left).toMatch(/px$/);
      expect(left - 35).toBeGreaterThanOrEqual(0);
      expect(left + 35).toBeLessThanOrEqual(330);
    }
    // A middle bar stays centred on its bar.
    hits[1]!.dispatchEvent(new FocusEvent("focus"));
    const mid = ((44 + (360 - 52) / 4 + (360 - 52) / 8) / 360) * 330;
    expect(parseFloat(tip.style.left)).toBeCloseTo(mid, 0);
    c.remove();
  });

  it("the current bar is accented", () => {
    const c = K.barChart({ rows, unit: "ms", current: 1 });
    expect(c.querySelector("path.bc-bar.is-current")).not.toBeNull();
  });
});

describe("chartFigure", () => {
  it("owns the title, caption and a 'Show as table' toggle rendering a real table", () => {
    const chart = K.barChart({ rows: [{ label: "a", value: 1 }], unit: "count" });
    const f = K.chartFigure({
      title: "Cycle time, by day",
      caption: "Median per day",
      chart,
      rows: [{ label: "a", value: "1" }],
      columns: [
        { key: "label", label: "Day" },
        { key: "value", label: "Median", numeric: true },
      ],
    });
    expect(f.tagName).toBe("FIGURE");
    expect(f.querySelector("figcaption")!.textContent).toContain("Median per day");
    expect(f.querySelector("h3")!.textContent).toBe("Cycle time, by day");
    const btn = f.querySelector("button.cf-toggle") as HTMLButtonElement;
    expect(btn.textContent).toBe("Show as table");
    const table = f.querySelector(".cf-table") as HTMLElement;
    expect(table.hidden).toBe(true);
    btn.click();
    expect(table.hidden).toBe(false);
    expect((f.querySelector(".cf-chart") as HTMLElement).hidden).toBe(true);
    // A toggle keeps its name; aria-pressed alone says it is on (REVIEW-P2 follow-up).
    expect(btn.textContent).toBe("Show as table");
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    btn.click();
    expect(btn.textContent).toBe("Show as table");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(table.hidden).toBe(true);
    expect(table.querySelector("table th[scope=col]")!.textContent).toBe("Day");
  });
});

describe("the old primitives still render", () => {
  it("svgSpark and svgBars return markup", () => {
    expect(K.svgSpark([1, 2, 3])).toContain("<svg");
    expect(K.svgBars([1, 2], { labels: ["a", "b"] })).toContain("chart-bar");
  });
});
