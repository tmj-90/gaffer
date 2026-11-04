// Icons and glyphs: the line icons, status glyphs, kit shirts, agent chips, the crest and badges.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { agentTitle, agentWho } from "./access.js";
import { SVGNS, el, svgEl } from "./dom.js";
import { appState } from "./state.js";

/** Inline SVG icon (24x24 stroke icons, currentColor). */
const ICONS = {
  overview: '<path d="M3 13h8V3H3zM13 21h8V3h-8zM3 21h8v-6H3z"/>',
  work: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  review:
    '<path d="M9 11l3 3 8-8"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  map: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><circle cx="6" cy="18" r="3"/><path d="M9 6h6a3 3 0 0 1 3 3v6M6 9v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  backarrow: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert:
    '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  question:
    '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  ticket:
    '<path d="M4 9V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4Z"/><path d="M13 5v14"/>',
  epics:
    '<path d="M4 5h10M4 12h7M4 19h12"/><circle cx="18" cy="5" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="20" cy="19" r="2"/>',
  spark:
    '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="M7.5 7.5l2.5 2.5M14 14l2.5 2.5M16.5 7.5L14 10M10 14l-2.5 2.5"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"/>',
  link: '<path d="M9 17H7a5 5 0 0 1 0-10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/>',
  squad:
    '<path d="M8.5 3 4 5 1.8 9.6l3.2 1.8L6 10.4V21h12V10.4l1 1 3.2-1.8L20 5l-4.5-2a3.6 3.6 0 0 1-7 0Z"/>',
  floor: '<path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9Z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9"/>',
  memory:
    '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  specs:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M9 13l1.5 1.5L13 12M9 17h5"/>',
  health:
    '<path d="M20.8 4.6a5.5 5.5 0 0 0-8 0L12 5.4l-.8-.8a5.5 5.5 0 1 0-7.8 7.8l.8.8L12 21l7.8-8 .8-.8a5.5 5.5 0 0 0 .2-7.6Z"/><path d="M3 12.5h4l1.5-4 3 8 1.5-4H17"/>',
  // --- pipeline stage icons (Plan → Ready → Build → Review → Deploy) --------
  gitbranch:
    '<circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="7" r="2.6"/><path d="M6 8.6v6.8M18 9.6c0 3.2-4.4 3.4-6.4 5.6"/>',
  inbox:
    '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z"/>',
  wrench:
    '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.9 2.9-2-.5-.5-2 2.9-2.8Z"/>',
  clipboardcheck:
    '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  diamond: '<path d="M12 2 22 12 12 22 2 12Z"/>',
  // --- spec scanner-frame line icons (keyword-matched by title) ------------
  globe:
    '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5a15 15 0 0 1 0 19a15 15 0 0 1 0-19Z"/>',
  gauge:
    '<path d="m12 13 3.5-3.5"/><path d="M4 18.5a10 10 0 1 1 16 0"/><circle cx="12" cy="19" r="1"/>',
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  chevdown: '<path d="m6 9 6 6 6-6"/>',
  back: '<path d="M15 6 9 12l6 6"/>',
  external: '<path d="M10 4H4v16h16v-6M14 4h6v6M20 4l-9 9"/>',
  logout: '<path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/>',
};
/**
 * Inline SVG icon (24×24 stroke icons, currentColor). Always carries width and
 * height attributes (default 20px) so a class that sets only colour can never
 * leave an unsized SVG to stretch across its flex row (the 830px Access lock).
 * CSS width/height still override the attributes.
 */
function icon(name, cls, size = 20) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", cls ? `ico ${cls}` : "ico");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = ICONS[name] || "";
  return svg;
}

/**
 * §6 status glyphs, the same shape everywhere (20px grid, currentColor, 1.75
 * stroke). The status WORD is always adjacent (statusBadge) or in the accessible
 * name (pass `label`). Squares are blocked, triangles failed, bars paused.
 */
const GLYPHS = {
  draft: '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.75"/>',
  refining:
    '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-dasharray="1.6 2.6" stroke-linecap="round"/>',
  ready:
    '<path d="M10 3 A7 7 0 1 1 4.5 5.7" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>',
  claimed:
    '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M10 10 L10 3 A7 7 0 0 1 17 10 Z" fill="currentColor"/>',
  in_progress:
    '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M10 3 A7 7 0 0 1 10 17 Z" fill="currentColor"/>',
  in_review:
    '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.75"/><circle cx="10" cy="10" r="2.6" fill="currentColor"/>',
  in_testing:
    '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M7 10.5 L9.2 12.6" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>',
  ready_for_merge:
    '<circle cx="10" cy="10" r="8" fill="currentColor"/><path d="M6.5 10 H13 M10.5 7 L13.5 10 L10.5 13" fill="none" stroke="var(--glyph-knock)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>',
  done: '<circle cx="10" cy="10" r="8" fill="currentColor"/><path d="M6.4 10.3 L8.9 12.7 L13.8 7.6" fill="none" stroke="var(--glyph-knock)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>',
  blocked: '<rect x="3.5" y="3.5" width="13" height="13" rx="1" fill="currentColor"/>',
  failed: '<path d="M10 2.8 L17.6 16.4 H2.4 Z" fill="currentColor" stroke-linejoin="round"/>',
  paused:
    '<rect x="5" y="4" width="3.4" height="12" rx=".6" fill="currentColor"/><rect x="11.6" y="4" width="3.4" height="12" rx=".6" fill="currentColor"/>',
  cancelled:
    '<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.75"/><path d="M5 15 L15 5" stroke="currentColor" stroke-width="1.75"/>',
  decision:
    '<path d="M10 2.5 L17.5 10 L10 17.5 L2.5 10 Z" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linejoin="round"/><circle cx="10" cy="10" r="2" fill="currentColor"/>',
};
function glyph(status, size = 16, label) {
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", `glyph g-${status}`);
  svg.setAttribute("focusable", "false");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = GLYPHS[status] || GLYPHS.draft;
  return svg;
}

/** The referee's yellow card: needs you. Always paired with words on its row. */
function ycard(size = 14, cls = "") {
  return svgEl(
    "svg",
    {
      viewBox: "0 0 12 16",
      width: (size * 0.75).toFixed(1),
      height: size,
      class: `ycard ${cls}`.trim(),
      "aria-hidden": "true",
      focusable: "false",
    },
    svgEl("rect", {
      x: 1,
      y: 1,
      width: 10,
      height: 14,
      rx: 1.4,
      fill: "var(--yellow)",
      stroke: "var(--ycard-edge)",
      "stroke-width": 1.2,
    }),
  );
}

// Kit drawings. A repo is identified by its kit PATTERN (not a hue), which
// survives greyscale and forced colours; an agent wears the club shirt with its
// stencil squad number. The shirt outline is shared.
const SHIRT_PATH =
  "M13 4 L7 6.5 L1.5 12.5 L6 18 L10 15.5 L10 37 L30 37 L30 15.5 L34 18 L38.5 12.5 L33 6.5 L27 4 Q20 9.5 13 4 Z";
const KIT_PATTERNS = ["stripes", "hoops", "halves", "sash", "quarters"];
// Every repo name the server has shown us. Patterns are assigned over the whole
// roster so no two repos wear the same kit (while there are patterns to go round).
const kitRoster = new Set();
let kitAssigned = null;
function kitHash(name) {
  let h = 0;
  for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}
/** Record repo names so their kits are assigned distinctly. */
function learnKits(names) {
  for (const n of names || []) {
    if (n && !kitRoster.has(n)) {
      kitRoster.add(n);
      kitAssigned = null;
    }
  }
}
/**
 * The kit pattern a repo wears. Each repo (in name order) takes its hashed
 * pattern, or the next one no other repo has taken; adding a repo only moves a
 * later-named repo whose pattern it now takes. Past five repos, kits repeat.
 */
function kitPattern(name) {
  const key = String(name || "");
  if (!kitRoster.has(key)) learnKits([key]);
  if (!kitAssigned) {
    kitAssigned = new Map();
    const used = new Set();
    for (const n of [...kitRoster].sort()) {
      let i = kitHash(n) % KIT_PATTERNS.length;
      if (used.size < KIT_PATTERNS.length)
        while (used.has(KIT_PATTERNS[i])) i = (i + 1) % KIT_PATTERNS.length;
      else used.clear();
      used.add(KIT_PATTERNS[i]);
      kitAssigned.set(n, KIT_PATTERNS[i]);
    }
  }
  return kitAssigned.get(key);
}
function kitShirt(repoName, size = 18) {
  const id = "kit" + ++appState.svgUid;
  const pat = kitPattern(repoName);
  const fill = svgEl("g", { "clip-path": `url(#${id})`, fill: "currentColor" });
  if (pat === "stripes")
    for (let x = 8; x < 34; x += 8)
      fill.appendChild(svgEl("rect", { x, y: 0, width: 4, height: 40 }));
  if (pat === "hoops")
    for (let y = 10; y < 40; y += 8)
      fill.appendChild(svgEl("rect", { x: 0, y, width: 40, height: 4 }));
  if (pat === "halves") fill.appendChild(svgEl("rect", { x: 0, y: 0, width: 20, height: 40 }));
  if (pat === "sash") fill.appendChild(svgEl("path", { d: "M2 6 L10 2 L40 34 L34 40 Z" }));
  if (pat === "quarters") {
    fill.appendChild(svgEl("rect", { x: 0, y: 0, width: 20, height: 20 }));
    fill.appendChild(svgEl("rect", { x: 20, y: 20, width: 20, height: 20 }));
  }
  return svgEl(
    "svg",
    {
      viewBox: "0 0 40 40",
      width: size,
      height: size,
      class: `kit kit-${pat}`,
      "aria-hidden": "true",
      focusable: "false",
    },
    [
      svgEl("defs", {}, svgEl("clipPath", { id }, svgEl("path", { d: SHIRT_PATH }))),
      svgEl("path", { d: SHIRT_PATH, fill: "var(--paper)", class: "kit-paper" }),
      fill,
      svgEl("path", {
        d: SHIRT_PATH,
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 2.2,
        "stroke-linejoin": "round",
      }),
    ],
  );
}
/** A repo name with its kit, e.g. ▥ billing-api. */
function repoTag(name, size = 18) {
  return el("span", { class: "repo" }, [kitShirt(name, size), el("span", {}, name)]);
}
/** The squad number an agent wears: the trailing digits of its name (01, 02…). */
function agentNo(name) {
  const m = String(name || "").match(/(\d+)$/);
  return m ? m[1].slice(-2).padStart(2, "0") : "";
}
/**
 * An agent: the club shirt (claret, sky chevron + collar) with its stencil number.
 * `no` is the number it wears (its squad shirt_number, see agentWho); without one
 * it falls back to the trailing digits of `name` (crew-delivery-02 wears 02).
 */
function agentShirt(name, size = 24, no) {
  const id = "shirt" + ++appState.svgUid;
  return svgEl(
    "svg",
    {
      viewBox: "0 0 40 40",
      width: size,
      height: size,
      class: "shirt",
      "aria-hidden": "true",
      focusable: "false",
    },
    [
      svgEl("defs", {}, svgEl("clipPath", { id }, svgEl("path", { d: SHIRT_PATH }))),
      svgEl("path", { d: SHIRT_PATH, fill: "var(--claret)" }),
      svgEl("g", { "clip-path": `url(#${id})`, fill: "var(--sky)" }, [
        svgEl("path", { d: "M13 4 Q20 9.5 27 4 L27 6.4 Q20 12 13 6.4 Z" }),
        svgEl("path", { d: "M10 9.6 L20 15 L30 9.6 L30 12.6 L20 18 L10 12.6 Z" }),
        svgEl("rect", { x: 0, y: 15.5, width: 6.5, height: 3 }),
        svgEl("rect", { x: 33.5, y: 15.5, width: 6.5, height: 3 }),
      ]),
      svgEl("path", {
        d: SHIRT_PATH,
        fill: "none",
        stroke: "var(--shirt-edge)",
        "stroke-width": 1.4,
        "stroke-linejoin": "round",
      }),
      svgEl(
        "text",
        { x: 20, y: 34, "text-anchor": "middle", class: "shirt-no" },
        no != null ? String(no) : agentNo(name),
      ),
    ],
  );
}
/** An agent named on screen: its shirt and its name (`title` adds the number). */
function agentTag(name, size = 22, no, title) {
  return el("span", { class: "agent", title: title || null }, [
    agentShirt(name, size, no),
    el("span", {}, name),
  ]);
}
/** The agent with this id as the squad knows it (its shirt and display name). */
function agentChip(id, fallback, size = 22) {
  const w = agentWho(id, fallback);
  return agentTag(w.name, size, w.no, agentTitle(w));
}
/**
 * The club crest: a shield split claret and sky with a fern frond. It carries the
 * club's short name (GET /api/club short_name_effective): one letter sits on the
 * claret half, two to four run across a claret band.
 */
function crest(cls = "crest", w = 34, h = 40, letters = "G") {
  const t = String(letters || "G").slice(0, 4);
  const band = t.length > 1;
  const fs = [15, 16, 15, 14, 12][t.length];
  return svgEl(
    "svg",
    {
      viewBox: "0 0 44 52",
      width: w,
      height: h,
      class: cls,
      "aria-hidden": "true",
      focusable: "false",
    },
    [
      svgEl("path", {
        d: "M22 2 L41 8 V26 C41 38 32 46 22 50 C12 46 3 38 3 26 V8 Z",
        fill: "var(--sky)",
        stroke: "var(--crest-edge)",
        "stroke-width": 2.4,
      }),
      svgEl("path", { d: "M22 2 L41 8 V26 C41 38 32 46 22 50 Z", fill: "var(--claret)" }),
      svgEl("path", {
        d: "M14 40 C15 30 18 22 26 13",
        fill: "none",
        stroke: "var(--claret)",
        "stroke-width": 2,
        "stroke-linecap": "round",
      }),
      ...[0, 1, 2, 3, 4].map((i) =>
        svgEl("path", {
          d: `M${15.2 + i * 2.2} ${35 - i * 5} q-6 -1 -8 -5`,
          fill: "none",
          stroke: "var(--claret)",
          "stroke-width": 1.8,
          "stroke-linecap": "round",
        }),
      ),
      band
        ? svgEl("rect", {
            x: 4.2,
            y: 21,
            width: 35.6,
            height: 13,
            fill: "var(--claret)",
            stroke: "var(--sky)",
            "stroke-width": 1.2,
            class: "crest-band",
          })
        : null,
      svgEl(
        "text",
        {
          x: band ? 22 : 31.5,
          y: band ? 27.5 + fs * 0.36 : 31,
          "text-anchor": "middle",
          class: "crest-t",
          style: `font-size:${fs}px`,
        },
        t,
      ),
    ],
  );
}

/** One neutral tag. Status and risk have their own helpers (glyph + word). */
function badge(text, kind) {
  return el("span", { class: kind ? `badge ${kind}` : "badge" }, text);
}

export {
  icon,
  glyph,
  ycard,
  SHIRT_PATH,
  learnKits,
  kitShirt,
  repoTag,
  agentNo,
  agentShirt,
  agentTag,
  agentChip,
  crest,
  badge,
};
