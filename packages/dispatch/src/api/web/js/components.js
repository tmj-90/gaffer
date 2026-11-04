// View scaffolding: view and panel heads, empty states, skeletons, stat cells, KPI cards, bands.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { svgSpark } from "./charts.js";
import { el } from "./dom.js";
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
 */
function emptyState(title, sub, _iconName, actions) {
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

/**
 * A section header on a programme page: Big Shoulders caps title + a condensed
 * count/aux (or a link). `opts.kit` paints it as a kit-colour block across the top
 * of its .card — "claret" (what needs you), "ink" (the factory's drawings),
 * "sky" (campaigns / reference), "red" (broken). Use a block for the one or two
 * sections a view leads with; everything else stays a plain heading.
 */
function panelHead(title, aux, link, opts = {}) {
  const kit = opts.kit;
  return el("div", { class: kit ? `panel-head block block-${kit}` : "panel-head" }, [
    el(opts.level || "h2", { class: "panel-title" }, [
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

/**
 * A stat cell (scoreboard / league-table typography): condensed caps label, the
 * number the server gave us in Big Shoulders, its unit, an optional sub line and
 * an optional sparkline with its own baseline. No delta chips: a "▲100%" the data
 * cannot support is not shown. `flip` keys a digit flip on first paint/change.
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
}) {
  return el(href ? "a" : "div", { class: cls ? `kpi ${cls}` : "kpi", href, title }, [
    el("div", { class: "kpi-top" }, [el("span", { class: "kpi-label" }, label)]),
    el("div", { class: "kpi-figure" }, [
      el(
        "span",
        { class: `kpi-val tabnum${needs ? " y" : ""}`, dataset: flip ? { flip } : undefined },
        value,
      ),
      unit ? el("span", { class: "kpi-unit" }, unit) : null,
    ]),
    sub ? el("div", { class: "kpi-sub" }, sub) : null,
    series && series.length > 1 ? el("div", { class: "kpi-spark", html: svgSpark(series) }) : null,
    after || null,
  ]);
}
/** @deprecated kept for older callers: a statCell (the delta/tone are ignored). */
function kpiCard({ label, value, unit, series }) {
  return statCell({ label, value, unit, series });
}

/**
 * Band-and-pointer bar: how much of a limit is used (budget, slots, queue).
 * `max` is the band; the tick marks the limit; a fill past it turns red.
 * Returns an element with an accessible label stating both numbers.
 */
function band(value, max, label) {
  const v = Number(value) || 0;
  const m = Number(max) || 0;
  const pct = m > 0 ? Math.min(100, (v / m) * 100) : 0;
  return el("div", { class: "band", role: "img", "aria-label": label || `${v} of ${m}` }, [
    el("span", { class: `band-fill${m > 0 && v > m ? " over" : ""}`, style: `width:${pct}%` }),
    m > 0 ? el("span", { class: "band-tick", style: "left:100%" }) : null,
  ]);
}

export { viewHead, emptyState, skeleton, panelHead, statCell, kpiCard, band };
