// Inline SVG chart primitives (no libraries; axes always drawn).
// sparkline(), barChart() and chartFigure() are the chart parts every view uses: marks
// on the --viz-* tokens (never the club kit), a readout on hover AND keyboard focus,
// and a table view for every chart. svgSpark() and svgBars() are the older markup
// builders, kept for the views not yet moved onto them.

import { button, dataTable } from "./components.js";
import { el, svgEl } from "./dom.js";
import { fmtDay, fmtDuration, money } from "./format.js";
import { clockTime } from "./freshness.js";

// --- inline SVG chart primitives (no libraries; axes always drawn) -----------

const esc = (t) =>
  String(t).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/**
 * A sparkline with a baseline: currentColor line, a dot on the latest value.
 * Used beside a number that already states the value; returns markup.
 * A null is a slot with no value (a day with no completion): it is skipped, never drawn
 * as 0; the line joins the real points at their own positions and the dot sits on the
 * last real one. Phase 2 (F-B2, F-B3) replaces this with a sparkline that breaks at
 * nulls and hides below four real points.
 */
function svgSpark(series) {
  const vals = series.map((v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v)));
  if (vals.length < 2) vals.push(vals[0] ?? null);
  const real = vals.filter((v) => v !== null);
  const w = 132,
    h = 28,
    p = 3;
  const max = Math.max(0, ...real),
    min = Math.min(0, ...real);
  const X = (i) => p + (i / (vals.length - 1)) * (w - 2 * p);
  const Y = (v) => h - p - ((v - min) / (max - min || 1)) * (h - 2 * p);
  let line = "";
  let last = -1;
  vals.forEach((v, i) => {
    if (v === null) return;
    line += `${last < 0 ? "M" : "L"}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `;
    last = i;
  });
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark-svg" aria-hidden="true" focusable="false">
    <line class="spark-base" x1="${p}" y1="${h - p}" x2="${w - p}" y2="${h - p}"/>
    ${line ? `<path class="spark-line" d="${line}"/>` : ""}
    ${last >= 0 ? `<circle class="spark-end" cx="${X(last).toFixed(1)}" cy="${Y(vals[last]).toFixed(1)}" r="2.4"/>` : ""}
  </svg>`;
}

/**
 * A bar chart with a baseline, a max gridline labelled with its value, and a tick
 * label per bar (thinned when narrow). Every bar carries its value in a <title>;
 * the chart's accessible name lists all of them. `opts.fmt` formats values,
 * `opts.today` highlights the last bar, `opts.labels` labels the x axis.
 * A null is a slot with no value (a day with no completion): no bar is drawn and the
 * accessible name says "none", never a zero bar. Phase 2 (F-B4) replaces this chart.
 */
function svgBars(series, opts = {}) {
  const vals = series.map((v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v)));
  const labels = opts.labels || vals.map((_, i) => String(i + 1));
  const fmt = opts.fmt || ((v) => String(v));
  const w = opts.width || 340,
    h = opts.height || 140,
    pl = 4,
    pr = 4,
    pt = 18,
    pb = 22;
  const max = Math.max(1, ...vals.filter((v) => v !== null));
  const n = Math.max(1, vals.length);
  const slot = (w - pl - pr) / n;
  const bw = Math.max(2, slot * 0.66);
  const Y = (v) => pt + (1 - v / max) * (h - pt - pb);
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((w - pl - pr) / 36))));
  const bars = vals
    .map((v, i) => {
      if (v === null) return "";
      const x = pl + i * slot + (slot - bw) / 2;
      const y = Y(v);
      const cls = `chart-bar${v === 0 ? " is-zero" : ""}${opts.today && i === n - 1 ? " is-today" : ""}`;
      return `<rect class="${cls}" x="${x.toFixed(1)}" y="${(v === 0 ? h - pb - 1.5 : y).toFixed(1)}" width="${bw.toFixed(1)}" height="${(v === 0 ? 1.5 : h - pb - y).toFixed(1)}"><title>${esc(labels[i])}: ${esc(fmt(v))}</title></rect>`;
    })
    .join("");
  const ticks = labels
    .map((l, i) =>
      // The last label always shows; a regular tick closer than one step to it is dropped.
      i === n - 1 || (i % every === 0 && n - 1 - i >= every)
        ? `<text class="chart-tick" x="${(pl + i * slot + slot / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(l)}</text>`
        : "",
    )
    .join("");
  const name = `${opts.label ? opts.label + ": " : ""}${labels.map((l, i) => `${l} ${vals[i] === null ? "none" : fmt(vals[i])}`).join(", ")}`;
  return `<svg viewBox="0 0 ${w} ${h}" class="chart-svg" role="img" aria-label="${esc(name)}">
    <line class="chart-axis" x1="${pl}" y1="${pt}" x2="${w - pr}" y2="${pt}"/>
    <text class="chart-val" x="${pl}" y="${pt - 5}">${esc(fmt(max))}</text>
    ${bars}
    <line class="chart-base" x1="${pl}" y1="${h - pb}" x2="${w - pr}" y2="${h - pb}"/>
    ${ticks}
  </svg>`;
}

// --- sparkline: a trend over an even time grid ------------------------------

const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * The points of a time series, or null when it is not one: every point needs a time
 * `t` (ms or ISO) and the times must sit on an even grid (a missing period is a point
 * with v null, never a skipped time). Categories (no t) are not a time series.
 */
function evenSeries(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const pts = [];
  for (const p of points) {
    if (!p || typeof p !== "object") return null;
    const t = typeof p.t === "number" ? p.t : Date.parse(p.t);
    if (!Number.isFinite(t)) return null;
    const v = p.v == null || !Number.isFinite(Number(p.v)) ? null : Number(p.v);
    pts.push({ t, v });
  }
  pts.sort((a, b) => a.t - b.t);
  const step = pts[1].t - pts[0].t;
  if (!(step > 0)) return null;
  const tol = step >= 27 * DAY ? 3 * DAY : step >= DAY ? HOUR : step * 0.02;
  for (let i = 1; i < pts.length; i++)
    if (Math.abs(pts[i].t - pts[i - 1].t - step) > tol) return null;
  return { pts, step };
}

/** The grid's word ("weeks") and how one of its times reads ("week of 5 Jan"). */
function gridWords(step) {
  const near = (x) => Math.abs(step - x) <= x * 0.1;
  const day = (t) => fmtDay(new Date(t).toISOString(), { weekday: false });
  if (near(7 * DAY)) return { unit: "weeks", at: (t) => `week of ${day(t)}` };
  if (step >= 27 * DAY && step <= 32 * DAY) return { unit: "months", at: day };
  if (near(DAY)) return { unit: "days", at: day };
  if (near(HOUR)) return { unit: "hours", at: (t) => clockTime(t) };
  return { unit: "points", at: day };
}

/**
 * A sparkline beside a figure that already states the value: `points` are {t, v} on an
 * even time grid with at least 4 real values, else it draws nothing (returns null).
 * A null v is a gap in the line, never a zero. The line is 2px whatever the width (a
 * non-scaling stroke); the end dot is an HTML dot (r4 with a 2px surface ring) so it
 * stays round when the line stretches; `baseline` draws the previous period's value
 * as a faint rule. Hover or keyboard focus (arrows, Home, End) reads a point out; the
 * accessible name sums it up ("First-pass, 12 weeks, 82% to 91%").
 *   opts: { label, fmt (value), fmtT (time), baseline, height }
 */
function sparkline(points, opts = {}) {
  const series = evenSeries(points);
  if (!series) return null;
  const { pts, step } = series;
  const real = pts.filter((p) => p.v != null);
  if (real.length < 4) return null;
  const words = gridWords(step);
  const fmt = opts.fmt || ((v) => String(Math.round(v * 100) / 100));
  const fmtT = opts.fmtT || words.at;
  const H = opts.height || 28;
  const pad = 5;
  const vals = real.map((p) => p.v);
  const hasBase = typeof opts.baseline === "number" && Number.isFinite(opts.baseline);
  if (hasBase) vals.push(opts.baseline);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const X = (i) => (pts.length === 1 ? 50 : (i / (pts.length - 1)) * 100);
  const Y = (v) => (max === min ? H / 2 : pad + (1 - (v - min) / (max - min)) * (H - 2 * pad));
  let d = "";
  let pen = false;
  pts.forEach((p, i) => {
    if (p.v == null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${X(i).toFixed(2)} ${Y(p.v).toFixed(2)} `;
    pen = true;
  });
  const lastIdx = pts.findLastIndex((p) => p.v != null);
  const svg = svgEl(
    "svg",
    {
      class: "spark-svg2",
      viewBox: `0 0 100 ${H}`,
      preserveAspectRatio: "none",
      height: H,
      "aria-hidden": "true",
      focusable: "false",
    },
    [
      hasBase
        ? svgEl("line", {
            class: "spark-baseline",
            x1: 0,
            x2: 100,
            y1: Y(opts.baseline).toFixed(2),
            y2: Y(opts.baseline).toFixed(2),
            "vector-effect": "non-scaling-stroke",
          })
        : null,
      svgEl("path", { class: "spark-line", d: d.trim(), "vector-effect": "non-scaling-stroke" }),
    ],
  );
  const dot = (cls, i) =>
    el("span", {
      class: cls,
      style: { left: `${X(i).toFixed(2)}%`, top: `${Y(pts[i].v).toFixed(2)}px` },
    });
  const cross = el("span", { class: "spark-x", hidden: "hidden" });
  const hover = el("span", { class: "spark-hover", hidden: "hidden" });
  const readout = el("span", { class: "spark-readout", "aria-live": "polite", hidden: "hidden" });
  const plot = el("span", { class: "spark-plot", style: { height: `${H}px` } }, [
    svg,
    dot("spark-dot", lastIdx),
    cross,
    hover,
  ]);
  const summary = `${opts.label || "Trend"}, ${pts.length} ${words.unit}, ${fmt(real[0].v)} to ${fmt(real[real.length - 1].v)}`;
  const wrap = el(
    "span",
    {
      class: "spark",
      tabindex: "0",
      role: "group",
      "aria-roledescription": "sparkline",
      "aria-label": summary,
    },
    [plot, readout],
  );
  let at = lastIdx;
  const show = (i) => {
    at = Math.max(0, Math.min(pts.length - 1, i));
    const p = pts[at];
    cross.hidden = false;
    cross.style.left = `${X(at).toFixed(2)}%`;
    hover.hidden = p.v == null;
    if (p.v != null) {
      hover.style.left = `${X(at).toFixed(2)}%`;
      hover.style.top = `${Y(p.v).toFixed(2)}px`;
    }
    readout.hidden = false;
    readout.textContent = `${fmtT(p.t)}: ${p.v == null ? "no data" : fmt(p.v)}`;
  };
  const hide = () => {
    if (document.activeElement === wrap) return;
    cross.hidden = true;
    hover.hidden = true;
    readout.hidden = true;
  };
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    show(r.width > 0 ? Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1)) : lastIdx);
  });
  svg.addEventListener("pointerleave", hide);
  wrap.addEventListener("focus", () => show(lastIdx));
  wrap.addEventListener("blur", () => {
    cross.hidden = true;
    hover.hidden = true;
    readout.hidden = true;
  });
  wrap.addEventListener("keydown", (e) => {
    const next =
      e.key === "ArrowLeft"
        ? at - 1
        : e.key === "ArrowRight"
          ? at + 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? pts.length - 1
              : null;
    if (next == null) return;
    e.preventDefault();
    show(next);
  });
  return wrap;
}

// --- barChart: one series of bars on a baseline -------------------------------

/** A nice tick step for a range: 1, 2, 2.5 or 5 times a power of ten. */
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

/** How a value of `unit` reads on the axis and in the tooltip, scaled to the data's max. */
function axisUnit(unit, maxVal, fmt) {
  if (unit === "ms" || unit === "days") {
    const toMs = unit === "days" ? DAY : 1;
    const maxMs = maxVal * toMs;
    const [div, suf] =
      maxMs < 120_000
        ? [1000, "s"]
        : maxMs < 120 * 60_000
          ? [60_000, "m"]
          : maxMs < 48 * HOUR
            ? [HOUR, "h"]
            : [DAY, "d"];
    return {
      scale: toMs / div,
      tick: (u) => (u === 0 ? "0" : `${+u.toFixed(2)}${suf}`),
      value: fmt || ((v) => fmtDuration(v * toMs)),
    };
  }
  if (unit === "usd")
    return { scale: 1, tick: (u) => (u === 0 ? "0" : `$${+u.toFixed(2)}`), value: fmt || money };
  if (unit === "pct")
    return { scale: 1, tick: (u) => `${+u.toFixed(1)}%`, value: fmt || ((v) => `${v}%`) };
  return {
    scale: 1,
    tick: (u) => `${+u.toFixed(2)}`,
    value: fmt || ((v) => String(Math.round(v * 100) / 100)),
  };
}

/**
 * A bar chart of one series: `rows` [{ label, value }] in order, `unit` "ms" | "days" |
 * "count" | "usd" | "pct". Bars are at most 24px wide with 4px rounded data ends and a
 * square foot on the baseline; a null value draws no bar and says "no data", a zero
 * draws none and says 0. The y axis gets nice ticks in a unit that fits the data (a
 * 2-minute cycle reads in minutes, not "0.0 days"); hairline grid. Each bar's slot is
 * its focusable hit area (one tab stop, arrows move) and every bar shares one tooltip,
 * value first. `current` accents one bar (today). The SVG owns its height, x labels
 * included; it is drawn at `width` px and never stretched past it.
 *   opts: { rows, unit, label, current, width = 720, height = 160, fmt }
 */
function barChart({ rows = [], unit = "count", label, current, width = 720, height = 160, fmt }) {
  const vals = rows.map((r) =>
    r.value == null || !Number.isFinite(Number(r.value)) ? null : Number(r.value),
  );
  const ax = axisUnit(unit, Math.max(0, ...vals.filter((v) => v != null)), fmt);
  const maxU = Math.max(0, ...vals.filter((v) => v != null).map((v) => v * ax.scale));
  const step = niceStep(maxU / 4 || 1);
  const top = Math.max(step, Math.ceil(maxU / step - 1e-9) * step);
  const W = width;
  const Hh = height;
  // pt leaves room above the tallest bar for the shared tooltip, inside the chart's box.
  const pl = 44,
    pr = 8,
    pt = 40,
    pb = 26;
  const base = Hh - pb;
  const plotH = base - pt;
  const n = Math.max(1, rows.length);
  const slot = (W - pl - pr) / n;
  const bw = Math.min(24, Math.max(2, slot * 0.66));
  const Y = (u) => base - (u / top) * plotH;
  const kids = [];
  for (let u = 0; u <= top + 1e-9; u += step) {
    const y = Y(u).toFixed(1);
    kids.push(svgEl("line", { class: "bc-grid", x1: pl, x2: W - pr, y1: y, y2: y }));
    kids.push(
      svgEl(
        "text",
        { class: "bc-ytick", x: pl - 6, y: (Number(y) + 4).toFixed(1), "text-anchor": "end" },
        ax.tick(Math.round(u * 1000) / 1000),
      ),
    );
  }
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((W - pl - pr) / 40))));
  const tip = el("div", { class: "bc-tip", hidden: "hidden", "aria-hidden": "true" });
  const hits = [];
  rows.forEach((r, i) => {
    const v = vals[i];
    const cx = pl + i * slot + slot / 2;
    const x = cx - bw / 2;
    if (v != null && v > 0) {
      const y = Y(v * ax.scale);
      const h = base - y;
      const rr = Math.min(4, bw / 2, h);
      const d = `M${x.toFixed(1)} ${base} V${(y + rr).toFixed(1)} Q${x.toFixed(1)} ${y.toFixed(1)} ${(x + rr).toFixed(1)} ${y.toFixed(1)} H${(x + bw - rr).toFixed(1)} Q${(x + bw).toFixed(1)} ${y.toFixed(1)} ${(x + bw).toFixed(1)} ${(y + rr).toFixed(1)} V${base} Z`;
      kids.push(
        svgEl("path", {
          class: `bc-bar${i === current ? " is-current" : ""}`,
          d,
          "data-w": bw.toFixed(1),
        }),
      );
    }
    if (i === n - 1 || (i % every === 0 && n - 1 - i >= every))
      kids.push(
        svgEl(
          "text",
          { class: "bc-xtick", x: cx.toFixed(1), y: Hh - 8, "text-anchor": "middle" },
          String(r.label ?? ""),
        ),
      );
    const said = v == null ? "no data" : ax.value(v);
    const hit = svgEl("rect", {
      class: "bc-hit",
      x: (pl + i * slot).toFixed(1),
      y: pt,
      width: slot.toFixed(1),
      height: plotH,
      tabindex: i === 0 ? "0" : "-1",
      role: "img",
      "aria-label": `${r.label ?? ""}: ${said}`,
    });
    const topY = v != null && v > 0 ? Y(v * ax.scale) : base;
    const show = () => {
      tip.replaceChildren(el("strong", {}, said), el("span", {}, String(r.label ?? "")));
      tip.style.left = `${((cx / W) * 100).toFixed(2)}%`;
      tip.style.top = `${((topY / Hh) * 100).toFixed(2)}%`;
      tip.hidden = false;
      // Centred on its bar, but never past the chart's edges: the first and last bars'
      // tips slid off the side (over the card's edge at phone width).
      const boxW = tip.parentElement ? tip.parentElement.clientWidth : 0;
      const tipW = tip.offsetWidth;
      if (boxW > 0 && tipW > 0) {
        const at = (cx / W) * boxW;
        const half = Math.min(tipW, boxW) / 2;
        tip.style.left = `${Math.min(Math.max(at, half), boxW - half).toFixed(1)}px`;
      }
    };
    const hide = () => {
      tip.hidden = true;
    };
    hit.addEventListener("pointerenter", show);
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("focus", show);
    hit.addEventListener("blur", hide);
    hit.addEventListener("keydown", (e) => {
      const j =
        e.key === "ArrowRight"
          ? i + 1
          : e.key === "ArrowLeft"
            ? i - 1
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? n - 1
                : null;
      if (j == null || j < 0 || j >= hits.length) return;
      e.preventDefault();
      hits.forEach((h, k) => h.setAttribute("tabindex", k === j ? "0" : "-1"));
      hits[j].focus();
    });
    hits.push(hit);
  });
  kids.push(svgEl("line", { class: "bc-base", x1: pl, x2: W - pr, y1: base, y2: base }));
  kids.push(...hits);
  const svg = svgEl(
    "svg",
    {
      class: "bc-svg",
      viewBox: `0 0 ${W} ${Hh}`,
      role: "group",
      "aria-label": label || "Bar chart",
    },
    kids,
  );
  // The wrapper, not just the SVG, stops at W px, so the tooltip's % matches the bars.
  return el("div", { class: "bar-chart", style: { maxWidth: `${W}px` } }, [svg, tip]);
}

// --- chartFigure: the container every chart mounts in ---------------------------

/**
 * A chart's figure: its title (a level-3 heading on the one scale), a caption, the
 * chart, and a "Show as table" toggle that swaps the chart for `rows` as a real table
 * (the chart's accessible twin: every value without hovering); the button keeps its
 * name and says it is on with aria-pressed. The figure grows with
 * its content (axis band included), never a fixed height with a nested scroll.
 *   opts: { title, caption, chart, rows, columns, level = 3, cls }
 */
function chartFigure({ title, caption, chart, rows = [], columns, level = 3, cls }) {
  const cols = columns || [
    { key: "label", label: "" },
    { key: "value", label: "Value", numeric: true },
  ];
  const chartBox = el("div", { class: "cf-chart" }, chart);
  const tableBox = el("div", { class: "cf-table", hidden: "hidden" }, [
    dataTable({ columns: cols, rows, caption: title }),
  ]);
  const toggle = button("Show as table", { kind: "link", cls: "cf-toggle" });
  toggle.setAttribute("aria-pressed", "false");
  toggle.addEventListener("click", () => {
    const table = tableBox.hidden;
    tableBox.hidden = !table;
    chartBox.hidden = table;
    // A toggle keeps its name; aria-pressed alone says which view is showing.
    toggle.setAttribute("aria-pressed", String(table));
  });
  return el("figure", { class: cls ? `chart-figure ${cls}` : "chart-figure" }, [
    el("figcaption", { class: "cf-head" }, [
      el("div", { class: "cf-titles" }, [
        title ? el(`h${level}`, { class: `cf-title ph-l${level}` }, title) : null,
        caption ? el("p", { class: "cf-cap" }, caption) : null,
      ]),
      toggle,
    ]),
    chartBox,
    tableBox,
  ]);
}

export { svgSpark, svgBars, sparkline, barChart, chartFigure };
