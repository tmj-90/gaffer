// The shared view parts: view and panel heads, empty states, skeletons, stat cells and
// the measure tile, meters (meter, meterRow, segBar), the data table, callouts and the
// one button set. Views compose these; their CSS lives in css/components.css and view
// sheets lay them out without restyling them. Older APIs (panelHead's `kit`, kpiCard,
// band) are thin wrappers kept for the views not yet moved.

import { sparkline, svgSpark } from "./charts.js";
import { el } from "./dom.js";
import { MISSING, pct } from "./format.js";
import { glyph, ycard } from "./icons.js";
import { delta as periodDelta, wilson } from "./stats.js";
import { overviewSkeleton } from "./views/overview.js";

// --- View scaffolding -------------------------------------------------------

/**
 * A view's programme-page header: the title in Big Shoulders (mixed case — it is
 * a name, not an eyebrow), one line of real counts beneath it, and the view's
 * actions on the right. No hero bands, no slogans. `sub` may be a string or a node.
 */
function viewHead(title, sub, actions) {
  return el("header", { class: "view-head" }, [
    el("div", { class: "view-head-main" }, [
      el("h1", {}, title),
      sub ? el("p", { class: "view-sub" }, sub) : null,
    ]),
    actions ? el("div", { class: "view-head-actions" }, [].concat(actions)) : null,
  ]);
}

/**
 * Idle / empty: one quiet sentence (and an optional second line + actions), never
 * an icon in a box. `iconName` is accepted for older callers and ignored.
 * `{ inline: true }` (the last argument) makes it one quiet line inside a panel, the
 * one replacement for the hand-rolled "No ..." paragraphs.
 */
function emptyState(title, sub, _iconName, actions, opts = {}) {
  if (opts && opts.inline)
    return el("p", { class: "empty-inline" }, [
      title,
      sub ? " " : null,
      sub ? el("span", { class: "es-inline-sub" }, sub) : null,
      actions ? el("span", { class: "es-inline-actions" }, [].concat(actions)) : null,
    ]);
  return el("div", { class: "empty-state" }, [
    el("p", { class: "es-title" }, title),
    sub ? el("p", { class: "es-sub" }, sub) : null,
    actions ? el("div", { class: "es-actions" }, [].concat(actions)) : null,
  ]);
}

/**
 * A loading skeleton shaped like the view it stands in for. CSS keeps it
 * invisible for the first 300ms so a fast view never flashes it.
 */
function skeleton(kind = "list") {
  const wrap = el("div", {
    class: `skeleton-view sk-${kind}`,
    "aria-busy": "true",
    "aria-label": "Loading",
  });
  if (kind === "overview") return overviewSkeleton();
  wrap.appendChild(el("div", { class: "skeleton sk-bar", style: "width:40%" }));
  wrap.appendChild(el("div", { class: "skeleton sk-line" }));
  if (kind === "board") {
    wrap.appendChild(el("div", { class: "skeleton sk-board" }));
    return wrap;
  }
  for (let i = 0; i < 5; i++) wrap.appendChild(el("div", { class: "skeleton sk-row" }));
  return wrap;
}

/** The old `kit` values, as tones (what the block MEANS, not what colour it is). */
const KIT_TONE = { claret: "needs", ink: "reference", sky: "drawing", red: "broken" };
const TONE_BLOCK = { needs: "claret", reference: "ink", drawing: "sky", broken: "red" };

/**
 * A section header on a programme page, on the one heading scale: `level` 2 | 3 | 4
 * sets the tag and the size (26 / 20 / 16 px, Big Shoulders caps), with a condensed
 * count/aux or a link beside it. `tone` paints it as a block across the top of its
 * .card, by meaning: "needs" (claret: something the viewer must act on), "reference"
 * (the scoreboard black), "drawing" (sky), "broken" (red). A block is for at most the
 * two sections a view leads with; no tone is a plain heading. The old `kit` option
 * (claret / ink / sky / red) maps onto the tones; an old string `level` ("h3") sets
 * the tag only, and a head with no level keeps the old sizes.
 */
function panelHead(title, aux, link, opts = {}) {
  const tone = opts.tone || KIT_TONE[opts.kit];
  const block = tone ? TONE_BLOCK[tone] : null;
  const num = typeof opts.level === "number" ? opts.level : null;
  const tag = num ? `h${num}` : opts.level || "h2";
  const cls = [
    "panel-head",
    num ? `ph-l${num}` : null,
    block ? `block block-${block} tone-${tone}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return el("div", { class: cls }, [
    el(tag, { class: "panel-title" }, [
      title,
      aux != null && link ? el("span", { class: "panel-aux" }, aux) : null,
    ]),
    link
      ? el("a", { class: "panel-link", href: link.href }, link.text)
      : aux != null && aux !== ""
        ? el("span", { class: "panel-aux" }, aux)
        : null,
  ]);
}

/** A value and its unit, with "%" (or a unit that starts with it) joined to the value. */
function splitPct(unit) {
  if (typeof unit === "string" && unit.startsWith("%")) {
    const rest = unit.slice(1).trim();
    return { pctSign: true, unit: rest || null };
  }
  return { pctSign: false, unit };
}

/**
 * A stat cell (scoreboard / league-table typography): condensed caps label, the
 * number the server gave us, its unit, an optional sub line and an optional
 * sparkline. `size` "hero" | "row" | "inline" owns the figure's size (52 / 34 px Big
 * Shoulders, 20 px Sofia Sans; smaller steps on a phone); no view sheet may restyle a
 * sized cell. The figure uses proportional numerals (tabular only in columns). A
 * null value is a dash with its `reason` (a title and a visible short line), never a
 * zero. "%" is part of the value ("70%", no gap). `series` is either {t, v} points
 * (the sparkline: an even time grid, >= 4 points) or, for older callers, a plain
 * array (the old spark); `seriesFmt` formats its readout. No delta chips: a "▲100%" the data cannot support is not
 * shown. `flip` keys a digit flip on first paint/change.
 */
function statCell({
  label,
  value,
  unit,
  sub,
  series,
  href,
  flip,
  needs = false,
  title,
  after,
  cls,
  size,
  reason,
  seriesFmt,
}) {
  const missing = value === null || value === undefined;
  const why = reason || "no figure yet";
  // A dash stays a dash: a "%" after it would claim a unit for a figure that is not
  // there, so a caller's own MISSING drops the "%" (a word unit like "not wired" stays).
  const u = value === MISSING ? { pctSign: false, unit: splitPct(unit).unit } : splitPct(unit);
  const classes = ["kpi", size ? `kpi--${size}` : null, missing ? "is-missing" : null, cls]
    .filter(Boolean)
    .join(" ");
  const spark =
    Array.isArray(series) && series.length && series[0] && typeof series[0] === "object"
      ? sparkline(series, { label, fmt: seriesFmt })
      : series && series.length > 1
        ? el("div", { class: "kpi-spark", html: svgSpark(series) })
        : null;
  return el(href ? "a" : "div", { class: classes, href, title }, [
    el("div", { class: "kpi-top" }, [el("span", { class: "kpi-label" }, label)]),
    el("div", { class: "kpi-figure" }, [
      missing
        ? el("span", { class: "kpi-val is-missing", title: why }, MISSING)
        : el(
            "span",
            { class: `kpi-val${needs ? " y" : ""}`, dataset: flip ? { flip } : undefined },
            [String(value), u.pctSign ? "%" : null],
          ),
      !missing && u.unit ? el("span", { class: "kpi-unit" }, u.unit) : null,
    ]),
    missing ? el("div", { class: "kpi-reason" }, why) : null,
    sub ? el("div", { class: "kpi-sub" }, sub) : null,
    spark && spark.classList.contains("spark") ? el("div", { class: "kpi-spark" }, spark) : spark,
    after || null,
  ]);
}
/** @deprecated kept for older callers: a statCell (the delta/tone are ignored). */
function kpiCard({ label, value, unit, series }) {
  return statCell({ label, value, unit, series });
}

// --- the measure tile ------------------------------------------------------

/** Glyph and word for a delta's verdict (never colour alone). */
const DELTA_GLYPH = { up: "▲", down: "▼", flat: "=" };

/**
 * A quality measure, one per tile, all the same size (audit B's spec):
 *   label       sentence case
 *   value       the figure (a rate in percent when k/n are given and value is not);
 *               null is a dash and the `note` says why
 *   unit        "%" joins the value; anything else rides beside it
 *   k, n        a rate's count: the n line reads "10 of 11" (`nLabel` appends "accepted");
 *               n alone reads "n 11"
 *   period      the chip for the window the figure covers ("last 30 days")
 *   delta       { prev, prevN, goodWhen: "up"|"down", minN, label } vs the previous equal
 *               period: signed, a glyph and the word better/worse, coloured by direction x
 *               goodWhen; hidden when either period's n is under minN (default 10)
 *   series      [{t, v}] for a sparkline (hidden below 4 points); the previous period's
 *               value is its faint baseline
 *   definition  what it counts, behind a disclosure (keyboard reachable)
 *   note        a small line under it (what it leaves out, why it is missing)
 *   format      how a non-rate value reads (default String); deltaFormat for its change
 * A rate also gets its Wilson 95% whisker. Below minN the rate greys and the tile says
 * the sample is small. Values use the body face and proportional numerals.
 */
function measureTile({
  label,
  value,
  unit,
  k,
  n,
  nLabel,
  period,
  delta,
  series,
  definition,
  note,
  format,
  deltaFormat,
  minN = 10,
  cls,
}) {
  const isRate = typeof k === "number" && typeof n === "number";
  const v =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : value == null && isRate && n > 0
        ? (k / n) * 100
        : null;
  const pctUnit = unit === "%" || (isRate && unit == null);
  const show = (x) => (pctUnit ? pct(x) : format ? format(x) : String(x));
  const small = typeof n === "number" && n < minN;
  const missing = v == null;
  const nText = isRate
    ? `${k} of ${n}${nLabel ? ` ${nLabel}` : ""}`
    : typeof n === "number"
      ? `n ${n}`
      : null;

  let deltaNode = null;
  if (delta && !missing) {
    const d = periodDelta(
      { value: v, n },
      { value: delta.prev, n: delta.prevN },
      {
        goodWhen: delta.goodWhen || "up",
        minN: typeof delta.minN === "number" ? delta.minN : minN,
      },
    );
    if (d.verdict) {
      const sign = d.value > 0 ? "+" : d.value < 0 ? "−" : "±";
      const mag = Math.abs(d.value);
      const amount = deltaFormat
        ? deltaFormat(d.value)
        : pctUnit
          ? `${sign}${Number(mag.toFixed(1))} pts`
          : `${sign}${format ? format(mag) : Number(mag.toFixed(2))}`;
      deltaNode = el("span", { class: `mt-delta is-${d.verdict}` }, [
        el("span", { class: "mt-dglyph", "aria-hidden": "true" }, DELTA_GLYPH[d.direction]),
        ` ${amount} `,
        el("span", { class: "mt-dword" }, d.verdict === "same" ? "no change" : d.verdict),
        el("span", { class: "mt-dvs" }, ` vs ${delta.label || "the period before"}`),
      ]);
    }
  }

  let whisker = null;
  if (isRate && n > 0) {
    const w = wilson(k, n);
    const lo = Math.round(w.lo * 100);
    const hi = Math.round(w.hi * 100);
    const said = `95% interval ${lo}% to ${hi}%`;
    whisker = el("div", { class: "mt-whisker-row" }, [
      el("span", { class: "mt-whisker", role: "img", "aria-label": said, title: said }, [
        el("span", { class: "wh-range", style: { left: `${lo}%`, width: `${hi - lo}%` } }),
        el("span", { class: "wh-point", style: { left: `${(k / n) * 100}%` } }),
      ]),
      el("span", { class: "mt-range" }, `likely ${lo} to ${hi}%`),
    ]);
  }

  const spark = Array.isArray(series)
    ? sparkline(series, {
        label,
        fmt: show,
        baseline: delta && typeof delta.prev === "number" ? delta.prev : undefined,
      })
    : null;

  return el(
    "article",
    {
      class: ["measure-tile", small ? "is-small" : null, missing ? "is-missing" : null, cls]
        .filter(Boolean)
        .join(" "),
      "aria-label": label,
    },
    [
      el("div", { class: "mt-top" }, [
        el("span", { class: "mt-label" }, label),
        period ? el("span", { class: "mt-period" }, period) : null,
      ]),
      el("div", { class: "mt-figure" }, [
        el(
          "span",
          {
            class: "mt-val",
            title: missing
              ? note || "no figure yet"
              : small
                ? `Only ${nText}: too few to read as a rate`
                : null,
          },
          missing ? MISSING : show(v),
        ),
        !missing && unit && !pctUnit ? el("span", { class: "mt-unit" }, unit) : null,
      ]),
      nText || deltaNode
        ? el("div", { class: "mt-meta" }, [
            nText ? el("span", { class: "mt-n" }, nText) : null,
            small ? el("span", { class: "mt-small" }, "small sample") : null,
            deltaNode,
          ])
        : null,
      whisker,
      spark ? el("div", { class: "mt-spark" }, spark) : null,
      // A missing figure always says why in visible text, not only in a title.
      note || missing
        ? el(
            "p",
            { class: "mt-note" },
            note || (isRate && n === 0 ? "No sample yet." : "No figure yet."),
          )
        : null,
      definition
        ? el("details", { class: "mt-def" }, [
            el("summary", {}, "What this counts"),
            el("p", {}, definition),
          ])
        : null,
    ],
  );
}

// --- meters: used-of-a-limit, a rate row, part-of-whole -----------------------

/**
 * How much of a limit is used (budget, slots, queue): the track scales to
 * max(limit, max, value), so an overrun shows as a red part past the limit's tick
 * (the tick only when there is a limit). At `warnAt` (0.9) of the limit the meter
 * says "near the limit"; past it, "over the limit by ..." (in its accessible name and
 * title). `fmt` formats the figures; `label` names it.
 *   opts: { value, limit, max, warnAt = 0.9, label, fmt, ariaLabel }
 */
function meter({ value, limit, max, warnAt = 0.9, label, fmt = String, ariaLabel }) {
  const v = Math.max(0, Number(value) || 0);
  const lim = typeof limit === "number" && limit > 0 ? limit : null;
  const scale = Math.max(lim || 0, typeof max === "number" ? max : 0, v) || 1;
  const over = lim != null && v > lim;
  const warn = lim != null && !over && v >= warnAt * lim;
  const w = (x) => `${((x / scale) * 100).toFixed(2).replace(/\.00$/, "")}%`;
  const said =
    ariaLabel ||
    `${label ? `${label}: ` : ""}${fmt(v)}${lim != null ? ` of ${fmt(lim)}` : typeof max === "number" && max > 0 ? ` of ${fmt(max)}` : ""}${
      over
        ? `, over the limit by ${fmt(Math.round((v - lim) * 100) / 100)}`
        : warn
          ? ", near the limit"
          : ""
    }`;
  return el(
    "div",
    {
      class: `band meter${over ? " is-over" : warn ? " is-warn" : ""}`,
      role: "img",
      "aria-label": said,
      title: said,
    },
    [
      el("span", { class: "band-fill", style: `width:${w(over ? lim : v)}` }),
      over ? el("span", { class: "band-over", style: `left:${w(lim)};width:${w(v - lim)}` }) : null,
      lim != null ? el("span", { class: "band-tick", style: `left:${w(lim)}` }) : null,
    ],
  );
}

/**
 * @deprecated Band-and-pointer bar, kept for older callers: a meter with `max` as its
 * limit. Its accessible label states both numbers.
 */
function band(value, max, label) {
  const v = Number(value) || 0;
  const m = Number(max) || 0;
  return meter({ value: v, limit: m > 0 ? m : null, ariaLabel: label || `${v} of ${m}` });
}

/**
 * One rate row in a list of rows: name, a bar, the figure ("94% · 15 of 16", sized to
 * its content so it never wraps). A zero draws no bar; no sample reads "none yet".
 * `whisker` adds the Wilson 95% interval over the bar; `limit` measures k against a
 * limit instead of n; `fmt(k, n)` replaces the figure. Rows in a .meter-list share
 * their columns (bars aligned).
 *   opts: { name, k, n, fmt, limit, whisker }
 */
function meterRow({ name, k, n, fmt, limit, whisker = false }) {
  const K = Number(k) || 0;
  const N = Number(n) || 0;
  const whole = typeof limit === "number" && limit > 0 ? limit : N;
  const ratio = whole > 0 ? Math.min(1, K / whole) : 0;
  const fig = fmt ? fmt(K, N) : N > 0 ? `${pct((K / N) * 100)} · ${K} of ${N}` : "none yet";
  const w = whisker && N > 0 ? wilson(K, N) : null;
  return el("div", { class: "meter-row" }, [
    el("span", { class: "mr-name", title: name }, name),
    el("span", { class: "mr-bar", "aria-hidden": "true" }, [
      ratio > 0
        ? el("span", { class: "mr-fill", style: `width:${(ratio * 100).toFixed(2)}%` })
        : null,
      w
        ? el("span", {
            class: "mr-whisker",
            title: `95% interval ${Math.round(w.lo * 100)}% to ${Math.round(w.hi * 100)}%`,
            style: `left:${(w.lo * 100).toFixed(2)}%;width:${((w.hi - w.lo) * 100).toFixed(2)}%`,
          })
        : null,
    ]),
    el("span", { class: "mr-fig" }, fig),
  ]);
}

/**
 * Part of a whole, one bar: each part a segment (2px surface gaps between them, a part
 * at zero draws nothing), and a legend of names with their counts, so colour is never
 * the only key. The bar's accessible name gives every part's name, count and share.
 *   parts: [{ label, value }]; opts: { label, legend = true, tall = false }
 */
function segBar(parts, { label, legend = true, tall = false } = {}) {
  const list = (parts || []).map((p, i) => ({
    label: String(p.label),
    value: Math.max(0, Number(p.value) || 0),
    slot: (i % 4) + 1,
  }));
  const total = list.reduce((a, p) => a + p.value, 0);
  const share = (v) => (total > 0 ? pct((v / total) * 100) : "0%");
  const said = `${label ? `${label}: ` : ""}${list.map((p) => `${p.label} ${p.value} (${share(p.value)})`).join(", ")}`;
  return el("div", { class: `seg-wrap${tall ? " is-tall" : ""}` }, [
    el(
      "div",
      { class: "seg-bar", role: "img", "aria-label": said },
      list
        .filter((p) => p.value > 0)
        .map((p) =>
          el(
            "span",
            {
              class: `seg seg-${p.slot}`,
              style: { flexGrow: String(p.value) },
              title: `${p.label}: ${p.value} (${share(p.value)})`,
            },
            tall && total > 0 && p.value / total >= 0.15 ? share(p.value) : null,
          ),
        ),
    ),
    legend
      ? el(
          "ul",
          { class: "seg-legend", "aria-hidden": "true" },
          list.map((p) =>
            el("li", {}, [
              el("span", { class: `seg-key seg-${p.slot}` }),
              p.label,
              " ",
              el("b", {}, String(p.value)),
            ]),
          ),
        )
      : null,
  ]);
}

// --- the data table ----------------------------------------------------------

const NUM = new Intl.NumberFormat("en-GB");

/**
 * A real <table> for multi-column data (never dot-joined rows): a caption, th scope
 * on every head, the first column as row headers (sticky when the table scrolls
 * sideways), numeric columns right-aligned in 16px tabular figures. On a phone it
 * scrolls inside its own card (a focusable region), or with `stackOnPhone` each row
 * becomes a labelled card. A null cell is a dash with the column's `missing` reason.
 *   columns: [{ key, label, align, numeric, format(value, row), missing }]
 *   opts: { rows, groupBy (key or fn), groupLabel(fn), caption, stackOnPhone, empty, cls }
 */
function dataTable({
  columns = [],
  rows = [],
  groupBy,
  groupLabel,
  caption,
  stackOnPhone = false,
  empty = "Nothing to show yet.",
  cls,
}) {
  const cellOf = (col, row, i) => {
    const raw = row[col.key];
    let out = col.format ? col.format(raw, row) : raw;
    if (out == null || out === "")
      out = el("span", { class: "dt-missing", title: col.missing || "not recorded" }, MISSING);
    else if (typeof out === "number") out = col.numeric ? NUM.format(out) : String(out);
    const align = col.align || (col.numeric ? "right" : null);
    const attrs = {
      class:
        [col.numeric ? "dt-num" : null, align ? `al-${align}` : null].filter(Boolean).join(" ") ||
        null,
      "data-label": stackOnPhone ? col.label : null,
    };
    return i === 0 ? el("th", { ...attrs, scope: "row" }, out) : el("td", attrs, out);
  };
  const rowOf = (row) =>
    el(
      "tr",
      {},
      columns.map((c, i) => cellOf(c, row, i)),
    );
  const keyOf = typeof groupBy === "function" ? groupBy : groupBy ? (r) => r[groupBy] : null;
  let bodies;
  if (!rows.length)
    bodies = [
      el(
        "tbody",
        {},
        el("tr", {}, el("td", { colspan: String(columns.length), class: "dt-empty" }, empty)),
      ),
    ];
  else if (keyOf) {
    const groups = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    bodies = [...groups].map(([k, rs]) =>
      el("tbody", {}, [
        el(
          "tr",
          { class: "dt-group" },
          el(
            "th",
            { colspan: String(columns.length), scope: "colgroup" },
            groupLabel ? groupLabel(k, rs) : String(k),
          ),
        ),
        ...rs.map(rowOf),
      ]),
    );
  } else bodies = [el("tbody", {}, rows.map(rowOf))];
  const table = el("table", { class: "data-table" }, [
    caption ? el("caption", {}, caption) : null,
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        columns.map((c) => {
          const align = c.align || (c.numeric ? "right" : null);
          return el(
            "th",
            {
              scope: "col",
              class:
                [c.numeric ? "dt-num" : null, align ? `al-${align}` : null]
                  .filter(Boolean)
                  .join(" ") || null,
            },
            c.label,
          );
        }),
      ),
    ),
    ...bodies,
  ]);
  return el(
    "div",
    {
      class: ["dt-wrap", stackOnPhone ? "dt-stack" : null, cls].filter(Boolean).join(" "),
      tabindex: "0",
      role: "region",
      "aria-label": caption || "Table",
    },
    table,
  );
}

// --- callouts and buttons ------------------------------------------------------

/**
 * A callout inside a page, by tone: "needs" (the yellow card and the mark wash:
 * something the viewer must act on or check), "bad" (the red failed glyph and the red
 * wash: broken or failed), "info" (no glyph, no wash). `title` leads in bold.
 *   opts: { tone = "info", title, body, role = "note", cls }
 */
function callout({ tone = "info", title, body, role = "note", cls }) {
  const mark = tone === "needs" ? ycard(16) : tone === "bad" ? glyph("failed", 16) : null;
  return el("div", { class: ["callout", `callout-${tone}`, cls].filter(Boolean).join(" "), role }, [
    mark,
    el("p", { class: "callout-text" }, [
      title ? el("strong", { class: "callout-title" }, title) : null,
      title && body ? " " : null,
      body,
    ]),
  ]);
}

/**
 * The one button set: "primary" (the one sign-off per view), "secondary" (the
 * default), "danger" (destroys or stops something), "link" (an action that reads as a
 * link in a sentence), and "ghost" (a borderless secondary for dense toolbars).
 * `size: "small"` reads smaller but keeps the tap target. Other attrs pass through.
 */
function button(label, { kind = "secondary", size, cls, type = "button", ...attrs } = {}) {
  const base =
    kind === "link"
      ? "btn-link"
      : ["btn", kind === "secondary" ? null : kind, size === "small" ? "small" : null]
          .filter(Boolean)
          .join(" ");
  return el("button", { ...attrs, type, class: cls ? `${base} ${cls}` : base }, label);
}

export {
  viewHead,
  emptyState,
  skeleton,
  panelHead,
  statCell,
  kpiCard,
  measureTile,
  meter,
  band,
  meterRow,
  segBar,
  dataTable,
  callout,
  button,
};
