// Inline SVG chart primitives (no libraries; axes always drawn).
// Moved verbatim from app.js (the entry); the module map is in app.js.

// --- inline SVG chart primitives (no libraries; axes always drawn) -----------

const esc = (t) =>
  String(t).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

/**
 * A sparkline with a baseline: currentColor line, a dot on the latest value.
 * Used beside a number that already states the value; returns markup.
 */
function svgSpark(series) {
  const vals = series.map((v) => (v == null || !Number.isFinite(Number(v)) ? 0 : Number(v)));
  if (vals.length < 2) vals.push(vals[0] ?? 0);
  const w = 132,
    h = 28,
    p = 3;
  const max = Math.max(...vals),
    min = Math.min(0, ...vals);
  const X = (i) => p + (i / (vals.length - 1)) * (w - 2 * p);
  const Y = (v) => h - p - ((v - min) / (max - min || 1)) * (h - 2 * p);
  let line = "";
  vals.forEach((v, i) => (line += `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `));
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark-svg" aria-hidden="true" focusable="false">
    <line class="spark-base" x1="${p}" y1="${h - p}" x2="${w - p}" y2="${h - p}"/>
    <path class="spark-line" d="${line}"/>
    <circle class="spark-end" cx="${X(vals.length - 1).toFixed(1)}" cy="${Y(vals[vals.length - 1]).toFixed(1)}" r="2.4"/>
  </svg>`;
}

/**
 * A bar chart with a baseline, a max gridline labelled with its value, and a tick
 * label per bar (thinned when narrow). Every bar carries its value in a <title>;
 * the chart's accessible name lists all of them. `opts.fmt` formats values,
 * `opts.today` highlights the last bar, `opts.labels` labels the x axis.
 */
function svgBars(series, opts = {}) {
  const vals = series.map((v) => (v == null || !Number.isFinite(Number(v)) ? 0 : Number(v)));
  const labels = opts.labels || vals.map((_, i) => String(i + 1));
  const fmt = opts.fmt || ((v) => String(v));
  const w = opts.width || 340,
    h = opts.height || 140,
    pl = 4,
    pr = 4,
    pt = 18,
    pb = 22;
  const max = Math.max(1, ...vals);
  const n = Math.max(1, vals.length);
  const slot = (w - pl - pr) / n;
  const bw = Math.max(2, slot * 0.66);
  const Y = (v) => pt + (1 - v / max) * (h - pt - pb);
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((w - pl - pr) / 36))));
  const bars = vals
    .map((v, i) => {
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
  const name = `${opts.label ? opts.label + ": " : ""}${labels.map((l, i) => `${l} ${fmt(vals[i])}`).join(", ")}`;
  return `<svg viewBox="0 0 ${w} ${h}" class="chart-svg" role="img" aria-label="${esc(name)}">
    <line class="chart-axis" x1="${pl}" y1="${pt}" x2="${w - pr}" y2="${pt}"/>
    <text class="chart-val" x="${pl}" y="${pt - 5}">${esc(fmt(max))}</text>
    ${bars}
    <line class="chart-base" x1="${pl}" y1="${h - pb}" x2="${w - pr}" y2="${h - pb}"/>
    ${ticks}
  </svg>`;
}

export { svgSpark, svgBars };
