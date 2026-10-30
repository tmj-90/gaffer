// Gaffer dashboard — plain ES-module SPA over the Dispatch REST API.
// No framework, no build step. Every view calls the JSON API via fetch().
//
// Presentation: "Match Day". The gaffer is the manager and the factory is the
// club on match day — a claret club header, a stadium scoreboard, programme
// pages with kit-colour section blocks, referee's cards for status. The tokens,
// components and conventions are in css/ (see css/tokens.css) and the shared
// helpers below (el/field/icon/glyph, viewHead, panelHead, emptyState,
// skeleton, statCell, charts). Every mark carries data the server gave us.

// --- API client ------------------------------------------------------------

// Bearer token (set when the server enforces DISPATCH_API_TOKEN). Stored in
// localStorage so it survives reloads; sent on every API call. Empty = no auth.
const TOKEN_KEY = "wg_api_token";
const authToken = () => localStorage.getItem(TOKEN_KEY) || "";
const setAuthToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearAuthToken = () => localStorage.removeItem(TOKEN_KEY);

/**
 * One-scan phone access (AFK-LOOP P3). `gaffer dashboard --lan` prints a QR of
 * `http://LAN:PORT/?token=…`; when a scan lands here with that param we adopt
 * the token and immediately scrub it from the URL (history + query) so it never
 * lingers in browser history. A malformed URL must never block boot — the login
 * gate is always the safe fallback.
 */
function adoptTokenFromUrl() {
  try {
    const params = new URLSearchParams(location.search || "");
    const t = params.get("token");
    if (!t) return;
    setAuthToken(t.trim());
    params.delete("token");
    const qs = params.toString();
    history.replaceState(
      null,
      "",
      location.pathname + (qs ? `?${qs}` : "") + (location.hash || ""),
    );
  } catch {
    // Ignore — fall through to the normal (paste-a-token) login gate.
  }
}

/**
 * Call the Dispatch REST API. Resolves to the parsed JSON body on 2xx.
 * On a non-2xx response it throws an Error carrying the API error envelope
 * ({ error: { code, message } }) so callers can surface it to the user.
 * A 401 means the server requires a token — render the login gate and stop.
 *
 * Honest failure modes: a network failure or timeout becomes code NETWORK with
 * one plain sentence (never the browser's raw "Failed to fetch"); a non-JSON
 * body (a proxy's HTML error page) becomes BAD_GATEWAY instead of a SyntaxError.
 * Every outcome is reported to the freshness tracker that drives the header's
 * "Data as of" line. `opts.signal` lets the router abort a superseded view's
 * reads; an aborted call rejects with code ABORTED and is never toasted.
 */
const API_GET_TIMEOUT_MS = 15000;
async function api(method, path, body, opts = {}) {
  const headers = body !== undefined ? { "content-type": "application/json" } : {};
  const tok = authToken();
  if (tok) headers["authorization"] = "Bearer " + tok;
  const signals = [];
  if (opts.signal) signals.push(opts.signal);
  // Reads time out; writes may legitimately run long (spawns, merges) and do not.
  if (method === "GET" && typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    signals.push(AbortSignal.timeout(opts.timeoutMs || API_GET_TIMEOUT_MS));
  }
  const signal =
    signals.length > 1 && typeof AbortSignal.any === "function"
      ? AbortSignal.any(signals)
      : signals[0];
  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (cause) {
    if (opts.signal && opts.signal.aborted) {
      const e = new Error("Superseded");
      e.code = "ABORTED";
      throw e;
    }
    freshness.fail("network");
    const e = new Error("Can't reach the factory — retrying.");
    e.code = "NETWORK";
    e.cause = cause;
    throw e;
  }
  if (res.status === 401) {
    freshness.fail("auth");
    renderLogin(Boolean(tok)); // tok present + still 401 ⇒ wrong token
    const e = new Error("Authentication required");
    e.code = "UNAUTHORIZED";
    throw e;
  }
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      freshness.fail("network");
      const e = new Error(`The factory answered ${res.status} with a page that isn't data.`);
      e.code = "BAD_GATEWAY";
      throw e;
    }
  }
  // Any parsed answer from the server — even a 4xx refusal — proves it is up.
  freshness.ok();
  if (!res.ok) {
    const err =
      data && data.error ? data.error : { code: String(res.status), message: res.statusText };
    const e = new Error(err.message || "Request failed");
    e.code = err.code;
    throw e;
  }
  if (data && Array.isArray(data.repositories))
    learnKits(data.repositories.map((r) => r && r.name));
  return data;
}

// --- DOM helpers -----------------------------------------------------------

const app = document.getElementById("app");
const appbar = document.getElementById("appbar");
const bottomnav = document.getElementById("bottomnav");

/** Reduced-motion check that is safe when matchMedia is absent (tests/SSR). */
function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Create an element with attributes + children. Strings become text nodes.
 * `style` may be a string or an object; object keys starting with `--` are set
 * with setProperty (Object.assign silently drops custom properties).
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === undefined || sv === null) continue;
        if (sk.startsWith("--")) node.style.setProperty(sk, String(sv));
        else node.style[sk] = sv;
      }
    } else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children).flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === "") continue;
    node.appendChild(
      typeof child === "string" || typeof child === "number"
        ? document.createTextNode(String(child))
        : child,
    );
  }
  return node;
}

/** Create an SVG element (same attribute rules as el(), no listeners). */
const SVGNS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    node.setAttribute(k, String(v));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * A labelled form control. The <label> is ASSOCIATED with the control (for/id), so
 * assistive tech announces "Repository, combo box" instead of an unnamed select and
 * a click on the label focuses the control. Every form field goes through here —
 * the former `el("div", { class: "field" }, [el("label", {}, text), control])` pattern
 * rendered a visually adjacent but programmatically unrelated label (axe: select-name /
 * label). `attrs` extends the wrapper (`class` is appended to "field").
 */
let fieldSeq = 0;
function field(labelText, control, attrs = {}) {
  if (!control.id) control.id = `field-${++fieldSeq}`;
  const { class: extra, ...rest } = attrs;
  return el("div", { ...rest, class: extra ? `field ${extra}` : "field" }, [
    el("label", { for: control.id }, labelText),
    control,
  ]);
}

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
let svgUid = 0;
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
  const id = "kit" + ++svgUid;
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
/** An agent: the club shirt (claret, sky chevron + collar) with its stencil number. */
function agentShirt(name, size = 24) {
  const id = "shirt" + ++svgUid;
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
      svgEl("text", { x: 20, y: 34, "text-anchor": "middle", class: "shirt-no" }, agentNo(name)),
    ],
  );
}
function agentTag(name, size = 22) {
  return el("span", { class: "agent" }, [agentShirt(name, size), el("span", {}, name)]);
}
/** The club crest: a shield split claret and sky with a fern frond — the product mark. */
function crest(cls = "crest", w = 34, h = 40) {
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
      svgEl("text", { x: 31.5, y: 31, "text-anchor": "middle", class: "crest-t" }, "G"),
    ],
  );
}

/** One neutral tag. Status and risk have their own helpers (glyph + word). */
function badge(text, kind) {
  return el("span", { class: kind ? `badge ${kind}` : "badge" }, text);
}

/** Compact, human-friendly duration from milliseconds (e.g. "2d 3h", "45m"). */
function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}

/** Relative time from an ISO stamp, e.g. "3d ago" / "just now". */
function fmtRelative(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const ms = Date.now() - t;
  if (ms < 60_000) return "just now";
  return `${fmtDuration(ms)} ago`;
}

/** Short, human-friendly timestamp. Falls back to the raw string. */
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // British, like the voice: "29 Oct, 18:56" (24-hour clock, day before month).
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${clockTime(d.getTime())}`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** A date the British way: "Thu 29 Oct" (weekday optional). */
function fmtDay(iso, { weekday = true } = {}) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${weekday ? WEEKDAYS[d.getDay()] + " " : ""}${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
/**
 * Money, one format everywhere: dollars and cents ("$15.74"). A sliver under a cent
 * reads "<$0.01" (never a four-decimal "$0.0034"); no figure reads "—", never "$0".
 */
function money(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  if (v > 0 && v < 0.005) return "<$0.01";
  return `$${v.toFixed(2)}`;
}
/** A budget or cap: whole dollars when it is whole ("$25"), else cents. */
function moneyW(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? `$${v}` : money(v);
}
/** JSON.parse that answers null for a malformed or empty payload. */
function parseJsonSafe(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}
/** "3 diffs" / "1 diff". */
function plural(n, one, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

// Agents are people on the team sheet: a raw agent UUID is never printed. Every
// read of /agents or /claims feeds this map; actorName() falls back to a short id.
const agentNames = new Map();
function learnAgents(list) {
  for (const a of list || []) {
    if (a && a.id && a.display_name) agentNames.set(a.id, a.display_name);
    if (a && a.agent_id && a.agent_display_name) agentNames.set(a.agent_id, a.agent_display_name);
  }
}
let agentsLoaded = null;
/** Load the squad list once per page (best-effort), so feeds can name agents. */
function ensureAgents() {
  if (!agentsLoaded) {
    agentsLoaded = api("GET", "/agents")
      .then((r) => learnAgents(r.agents))
      .catch(() => {
        agentsLoaded = null;
      });
  }
  return agentsLoaded;
}
/** Who did it, in words: "crew-delivery-02", "priya.raman", "the runner". */
function actorName(type, id) {
  if (id && agentNames.has(id)) return agentNames.get(id);
  if (type === "system" || (!id && type !== "human")) return "the runner";
  if (type === "agent") return id ? `an agent (${String(id).slice(0, 8)})` : "an agent";
  return id || type || "—";
}

// --- Toast ------------------------------------------------------------------

let toastTimer;
function toast(message, { ok = false, code } = {}) {
  const node = document.getElementById("toast");
  clear(node);
  node.className = `toast${ok ? " ok" : ""}`;
  if (code) node.appendChild(el("span", { class: "toast-code" }, code));
  node.appendChild(document.createTextNode(message));
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      node.hidden = true;
    },
    ok ? 2600 : 5200,
  );
}

/** Wrap an async action so any thrown API error is shown as a toast. */
async function guard(fn) {
  try {
    await fn();
  } catch (e) {
    toast(e.message || "Unexpected error", { code: e.code });
  }
}

/**
 * Shared async-action helper. Every long-running button (Suggest work,
 * Plan a build, Poll for work) fires a backend job that returns immediately but
 * whose RESULT lands ~a minute later. Without instant feedback the buttons feel
 * dead, so this gives one consistent running state for all three:
 *
 *   - disables the trigger button and swaps its label to `running` (e.g.
 *     "Polling…") with an inline spinner, so the click visibly "took";
 *   - runs the action through {@link guard} so a thrown API error still toasts;
 *   - always restores the button (label + enabled) in a `finally`, even on error.
 *
 * `fn` receives nothing and may return a value; the button is the single source
 * of the busy state so callers never hand-roll disabled/label juggling.
 */
async function runAsyncAction(btn, running, fn) {
  if (!btn || btn.disabled) return;
  const original = [...btn.childNodes];
  btn.disabled = true;
  btn.classList.add("is-running");
  btn.setAttribute("aria-busy", "true");
  clear(btn);
  btn.appendChild(el("span", { class: "btn-spinner", "aria-hidden": "true" }));
  btn.appendChild(el("span", {}, running));
  try {
    await guard(fn);
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-running");
    btn.removeAttribute("aria-busy");
    clear(btn);
    for (const node of original) btn.appendChild(node);
  }
}

/**
 * Like {@link runAsyncAction}, but keeps the button in its running state until
 * the REAL background run (not just the HTTP spawn-ack) finishes.
 *
 * The pre-RUN-ACTIVITY bug: the spawn POST returns in milliseconds, so the
 * button reset while the (~minute-long) `claude -p` work churned on invisibly —
 * the button looked "done" when it wasn't. Here `fn` returns the run id(s) the
 * action started; the button stays disabled + spinning while ANY of them is
 * still active (polled via GET /api/runs?active=1), then resets. A safety cap
 * stops the poll so a wedged run can never disable the button forever; the
 * "Running now" panel remains the source of truth either way.
 */
async function runAsyncActionUntilDone(btn, running, fn) {
  if (!btn || btn.disabled) return;
  const original = [...btn.childNodes];
  const restore = () => {
    btn.disabled = false;
    btn.classList.remove("is-running");
    btn.removeAttribute("aria-busy");
    clear(btn);
    for (const node of original) btn.appendChild(node);
  };
  btn.disabled = true;
  btn.classList.add("is-running");
  btn.setAttribute("aria-busy", "true");
  clear(btn);
  btn.appendChild(el("span", { class: "btn-spinner", "aria-hidden": "true" }));
  btn.appendChild(el("span", {}, running));

  let runIds;
  try {
    const ids = await fn();
    runIds = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  } catch (e) {
    toast(e.message || "Unexpected error", { code: e.code });
    restore();
    return;
  }

  // No trackable run id came back (e.g. unconfigured) — nothing to wait on.
  if (runIds.length === 0) {
    restore();
    return;
  }

  // Poll until none of our run ids is still active, or a safety cap elapses
  // (~10 min) so a stuck run never wedges the button. The panel still reflects it.
  const POLL_MS = 3000;
  const MAX_POLLS = 200;
  const wanted = new Set(runIds);
  let polls = 0;
  const done = () =>
    new Promise((resolve) => {
      const tick = async () => {
        polls += 1;
        let activeIds = new Set();
        try {
          const data = await api("GET", "/api/runs?active=1");
          activeIds = new Set((data.active || []).map((r) => r.id));
        } catch {
          // transient — try again next tick
        }
        const stillRunning = [...wanted].some((id) => activeIds.has(id));
        if (!stillRunning || polls >= MAX_POLLS) {
          resolve();
          return;
        }
        setTimeout(tick, POLL_MS);
      };
      setTimeout(tick, POLL_MS);
    });
  await done();
  restore();
  // The run finished (or the cap elapsed) — say so when it FAILED. Before this a
  // failed onboard / product-owner / poll run only showed in the Running-now panel
  // while the button quietly reset, so a first-run misconfiguration looked like
  // "nothing happened". Best-effort: a read error here never throws.
  try {
    const data = await api("GET", "/api/runs");
    const recent = [...(data.recent || []), ...(data.active || [])];
    const failed = recent.filter((r) => wanted.has(r.id) && r.status === "failed");
    for (const r of failed) {
      const why = r.summary || r.error || r.last_line || "";
      toast(
        `${RUN_KIND_LABELS[r.kind] || r.kind || "Run"} failed${r.exit_code != null ? ` (exit ${r.exit_code})` : ""}${why ? ` — ${String(why).slice(0, 160)}` : ""}. Open it under Running now for the log.`,
        { code: "RUN_FAILED" },
      );
    }
  } catch {
    // best-effort
  }
}

// --- Login gate (restyled, behaviour preserved) -----------------------------

/** Render the access-token login gate into #app and hide app chrome. */
function renderLogin(wasWrong) {
  const root = document.getElementById("app");
  if (!root) return;
  // A write 401 can fire from the Plan-a-build sheet (body-level overlay); dismiss it
  // so the token gate isn't stranded behind it — the CSS also covers it defensively.
  closeSheet();
  if (appbar) appbar.hidden = true;
  if (bottomnav) bottomnav.hidden = true;
  root.classList.add("login-shell");
  clear(root);

  const input = el("input", {
    type: "password",
    name: "token",
    placeholder: "access token",
    autocomplete: "off",
    autofocus: "",
    "aria-label": "Access token",
  });
  const form = el("form", { class: "login-gate" }, [
    crest("login-mark", 52, 62),
    el("h1", {}, "Gaffer"),
    el("p", {}, "This factory needs an access token."),
    wasWrong ? el("p", { class: "login-error" }, "That token was rejected — try again.") : null,
    input,
    el("button", { class: "btn primary", type: "submit" }, "Enter"),
    // Tell a new operator where the token actually comes from — the hardest
    // first-run wall was a gate that never said this.
    el(
      "p",
      { class: "login-hint" },
      "Printed in the terminal that started Dispatch, or set as DISPATCH_API_TOKEN.",
    ),
  ]);
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const val = input.value.trim();
    if (!val) return;
    setAuthToken(val);
    location.reload();
  });
  root.appendChild(form);
}

/** Clear the token and return to the login gate. Wired to the header logout. */
function logout() {
  clearAuthToken();
  location.reload();
}
window.wgLogout = logout;

// --- Shared status vocabulary ----------------------------------------------

const STATUS_LABELS = {
  draft: "Draft",
  refining: "Refining",
  ready: "Ready",
  claimed: "Claimed",
  in_progress: "In progress",
  blocked: "Blocked",
  in_review: "In review",
  in_testing: "In testing",
  ready_for_merge: "Approved · merging",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  paused: "Paused",
};
function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}
/** A status: its §6 glyph + its word, together (never colour alone). */
function statusBadge(status) {
  return el("span", { class: `badge st status-${status}` }, [
    glyph(status, 16),
    el("span", {}, statusLabel(status)),
  ]);
}
/** Risk: outlined condensed caps ("HIGH RISK" reads on its own, not by hue). */
function riskBadge(risk) {
  return el("span", { class: `badge risk-${risk}`, title: `${risk} risk` }, risk);
}
function accessBadge(access) {
  return badge(access, `access-${access}`);
}
/**
 * A repo name that navigates to that repo's detail page (#/repo/:id). renderRepo
 * resolves the param by id OR name, so either works. Falls back to a plain span
 * when there's nothing to link to. `stop` halts click propagation so the link
 * works inside a clickable board card without also opening the ticket.
 */
function repoLink(repo, { className = "", stop = false } = {}) {
  const ref = repo && (repo.id || repo.name);
  const name = (repo && (repo.name || repo.id)) || "repo";
  if (!ref) return el("span", { class: `repo-link plain ${className}`.trim() }, name);
  return el(
    "a",
    {
      class: `repo-link ${className}`.trim(),
      href: `#/repo/${encodeURIComponent(ref)}`,
      title: `Open ${name}`,
      onclick: stop ? (e) => e.stopPropagation() : null,
    },
    name,
  );
}

/**
 * Lifecycle progress marks: five stages (draft → ready → in progress → review →
 * done); stages passed are filled, the current one is the long mark, a terminal
 * failure paints it red. Class `.pdots` — `.pipeline` belongs to the Overview's
 * development-flow strip (the old shared name broke its overflow on phones).
 */
const LIFECYCLE = ["draft", "ready", "in_progress", "in_review", "done"];
const STAGE_FOR_STATUS = {
  draft: 0,
  refining: 0,
  ready: 1,
  claimed: 2,
  in_progress: 2,
  blocked: 2,
  // PAUSE-ON-CAP: paused shares the blocked column on the board (boardService maps
  // both to "blocked"). Use the same pipeline stage so a paused in-flight ticket
  // never falls back to stage 0 (draft).
  paused: 2,
  in_review: 3,
  // BBT-001: the independent-testing lane shares the "review" lifecycle stage —
  // it's post-delivery, pre-merge, just like in_review/ready_for_merge.
  in_testing: 3,
  ready_for_merge: 3,
  done: 4,
  failed: 4,
  cancelled: 4,
};
function pipelineDots(status) {
  const stage = STAGE_FOR_STATUS[status] ?? 0;
  const failed = status === "failed" || status === "cancelled";
  const wrap = el("span", {
    class: "pdots",
    role: "img",
    "aria-label": `Lifecycle: ${statusLabel(status)}`,
  });
  for (let i = 0; i < LIFECYCLE.length; i++) {
    let cls = "pd";
    if (i < stage) cls += " done";
    else if (i === stage) cls += failed ? " fail" : " active";
    wrap.appendChild(el("span", { class: cls }));
  }
  return wrap;
}

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
  if (kind === "overview") {
    wrap.appendChild(el("div", { class: "skeleton sk-scoreboard" }));
    wrap.appendChild(
      el("div", { class: "grid-2" }, [
        el("div", { class: "skeleton sk-card" }),
        el("div", { class: "skeleton sk-card" }),
      ]),
    );
    return wrap;
  }
  wrap.appendChild(el("div", { class: "skeleton sk-bar", style: "width:40%" }));
  wrap.appendChild(el("div", { class: "skeleton sk-line" }));
  if (kind === "board") {
    wrap.appendChild(el("div", { class: "skeleton sk-board" }));
    return wrap;
  }
  for (let i = 0; i < 5; i++) wrap.appendChild(el("div", { class: "skeleton sk-row" }));
  return wrap;
}

// --- Detail sheet (mobile bottom-sheet / desktop side-panel) ----------------

let sheetEls = null;
let sheetReturnFocus = null; // element to restore focus to when the sheet closes
function ensureSheet() {
  if (sheetEls) return sheetEls;
  const scrim = el("div", { class: "sheet-scrim", onclick: closeSheet });
  const head = el("div", { class: "sheet-head" });
  const body = el("div", { class: "sheet-body" });
  // tabindex -1 so we can focus the dialog itself as a fallback; aria-labelledby
  // gives it an accessible name from its own <h2> title (set per-open below).
  const sheet = el(
    "div",
    {
      class: "sheet",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "sheet-title",
      tabindex: "-1",
    },
    [el("div", { class: "sheet-grip" }), head, body],
  );
  sheet.addEventListener("click", (e) => e.stopPropagation());
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  sheetEls = { scrim, sheet, head, body };
  return sheetEls;
}
/** Focusable elements inside a container, in DOM order (visible + enabled). */
function focusableIn(root) {
  return [
    ...root.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((e) => e.offsetParent !== null || e === document.activeElement);
}
function openSheet(title, contentNode) {
  const { scrim, sheet, head, body } = ensureSheet();
  sheetReturnFocus = document.activeElement; // so focus returns here on close
  clear(head);
  clear(body);
  head.appendChild(el("h2", { id: "sheet-title" }, title));
  head.appendChild(
    el(
      "button",
      { class: "icon-btn", type: "button", "aria-label": "Close", onclick: closeSheet },
      el("span", { html: "✕" }),
    ),
  );
  body.appendChild(contentNode);
  scrim.classList.add("open");
  sheet.classList.add("open");
  document.addEventListener("keydown", sheetKeydown);
  // Move focus INTO the dialog so keyboard/AT users aren't stranded behind it.
  const first = focusableIn(sheet)[0];
  (first || sheet).focus();
}
function closeSheet() {
  if (!sheetEls) return;
  sheetEls.scrim.classList.remove("open");
  sheetEls.sheet.classList.remove("open");
  document.removeEventListener("keydown", sheetKeydown);
  // Restore focus to whatever opened the sheet (the trigger), not the body.
  if (sheetReturnFocus && typeof sheetReturnFocus.focus === "function") {
    sheetReturnFocus.focus();
  }
  sheetReturnFocus = null;
}
function sheetKeydown(e) {
  if (e.key === "Escape") {
    closeSheet();
    return;
  }
  // Trap Tab within the open sheet so focus can't walk into the covered content.
  if (e.key === "Tab" && sheetEls) {
    const f = focusableIn(sheetEls.sheet);
    if (f.length === 0) {
      e.preventDefault();
      sheetEls.sheet.focus();
      return;
    }
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

// --- Routing & IA -----------------------------------------------------------
//
// 8 tabs folded to 5 areas. Legacy hashes are aliased so deep links and the
// previous IA keep working: every prior view is still reachable.

const VIEWS = {
  overview: renderOverview,
  health: renderHealth,
  work: renderWork,
  review: renderReview,
  factory: renderFactory,
  memory: renderMemory,
  epics: renderEpics,
  specs: renderSpecs,
  settings: renderSettings,
  create: renderCreate,
  ticket: renderTicket,
  node: renderNode,
  repo: renderRepo,
  hidden: renderHidden,
};

// Map old view names onto the new IA so existing links never break.
const VIEW_ALIASES = {
  dashboard: "overview",
  decisions: "overview",
  board: "work",
  backlog: "work",
  claims: "work",
  map: "factory",
};

// Sub-views highlight their parent area in the nav.
const AREA_FOR_VIEW = {
  ticket: "work",
  node: "factory",
  repo: "factory",
  create: "epics",
  hidden: "factory",
};

/** Parse the hash into { view, param, query }. e.g. #/ticket/abc -> ticket. */
function parseHash() {
  const raw = (location.hash || "#/overview").replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const [rawView, param] = pathPart.split("/");
  const view = VIEW_ALIASES[rawView] || rawView || "overview";
  const query = new URLSearchParams(queryPart || "");
  return { view, param, query };
}

function navigate(hash) {
  // Re-selecting the view you are already on must still re-fetch. Assigning an
  // IDENTICAL location.hash fires no `hashchange`, so router() (the sole data-fetch
  // trigger) never runs and the view shows stale data until a manual reload. When the
  // hash is unchanged, re-render explicitly; otherwise let the hashchange drive it.
  const next = hash.startsWith("#") ? hash : "#" + hash;
  if (location.hash === next) router();
  else location.hash = next;
}

let activeArea = "overview";
// Where a ticket detail's "← Back" returns to. Tracks the last LIST view the
// operator came from (Work or Review) so opening a ticket from the Review queue
// returns to Review, not always Work.
let detailBackHash = "#/work";

// Route generations. Every navigation bumps routeGen and aborts the previous
// route's reads. A render that resolves after the operator has moved on is
// DISCARDED (and disposed, so its document-level key handlers die with it):
// a slow Review render must never land under the Specs URL with live Approve
// buttons (router-stale-render-race).
let routeGen = 0;
let routeAbort = null;
/** The AbortSignal for the current route's reads (views pass it to api()). */
function routeSignal() {
  return routeAbort ? routeAbort.signal : undefined;
}
/**
 * Tear down a rendered view tree: views register cleanup as `node._dispose`
 * (document listeners, timers, observers). Safe to call twice.
 */
function disposeView(node) {
  if (!node) return;
  const fns = [];
  if (typeof node._dispose === "function") fns.push(node._dispose);
  if (node.querySelectorAll) {
    for (const n of node.querySelectorAll("*")) {
      if (typeof n._dispose === "function") fns.push(n._dispose);
    }
  }
  for (const fn of fns) {
    try {
      fn();
    } catch {
      /* cleanup is best-effort */
    }
  }
  node._dispose = null;
}
/** Swap #app's content, disposing whatever view was there. */
function mountView(content) {
  for (const child of [...app.children]) disposeView(child);
  clear(app);
  app.appendChild(content);
  // A view that measures itself (the tactics board, the wage chart) draws once it is in the DOM.
  if (typeof content._mounted === "function") {
    try {
      content._mounted();
    } catch {
      /* a drawing that cannot measure keeps its first draw */
    }
  }
}

async function router() {
  const { view, param } = parseHash();
  // Unknown views fall through to Overview; aliases are resolved in parseHash.
  const render = VIEWS[view] || renderOverview;
  activeArea = AREA_FOR_VIEW[view] || (VIEWS[view] ? view : "overview");
  if (view === "work" || view === "review") detailBackHash = "#/" + view;

  const gen = ++routeGen;
  workRefCache = null; // a navigation re-reads repos/nodes (the refresh reuses them)
  if (routeAbort) routeAbort.abort();
  routeAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
  const isCurrent = () => gen === routeGen;

  app.dataset.area = activeArea; // lets CSS give width-hungry views (work/map/epics) the full screen
  app.dataset.view = view;
  syncNav();
  updateNavBadges();
  setDocTitle(view); // detail views refine this once their data loads
  app.classList.remove("login-shell");

  // The DOM swap: a view-shaped skeleton (invisible for its first 300ms), then the
  // awaited content — unless a newer navigation superseded this one meanwhile.
  const swap = async () => {
    if (!isCurrent()) return;
    mountView(skeleton(view === "overview" ? "overview" : view === "work" ? "board" : "list"));
    let content;
    try {
      content = await render(param);
    } catch (e) {
      if (!isCurrent()) return; // a stale failure never paints over the new view
      // A 401 is already handled inside api() (the login screen is shown).
      if (e && (e.code === "UNAUTHORIZED" || e.code === "ABORTED")) return;
      // One specific message + a retry, shown once — not repeated in a toast.
      const panel = emptyState(
        "That page could not load.",
        (e && e.message) || "The request failed. Check the connection and retry.",
        null,
        el(
          "button",
          { class: "btn primary", type: "button", onclick: () => router() },
          "Try again",
        ),
      );
      panel.classList.add("is-error");
      mountView(el("div", { class: "view" }, panel));
      return;
    }
    if (!isCurrent()) {
      disposeView(content);
      return;
    }
    mountView(content);
    window.scrollTo?.(0, 0);
    flipDigits(content);
    // Tell a screen reader the view changed (one short line, not the whole DOM).
    announce(`${VIEW_TITLES[view] || "View"} loaded`);
  };

  const reduce = prefersReducedMotion();
  if (document.startViewTransition && !reduce && app.childElementCount) {
    // A rapid navigation aborts the in-flight transition, rejecting its promises
    // with InvalidStateError; the update still runs (and bails if stale).
    try {
      const vt = document.startViewTransition(swap);
      vt.ready?.catch(() => {});
      vt.finished?.catch(() => {});
      vt.updateCallbackDone?.catch(() => {});
    } catch {
      void swap();
    }
  } else {
    await swap();
  }
}

/**
 * Scoreboard digits flip in on first paint (and when a refresh changes them):
 * each character of a `.kpi-val[data-flip]` becomes a `.dg` with a stagger index.
 * A flip, never a count-up — we never show a number the server did not give.
 */
function flipDigits(root, prev = null) {
  if (prefersReducedMotion() || !root || !root.querySelectorAll) return;
  for (const node of root.querySelectorAll("[data-flip]")) {
    const text = node.textContent || "";
    if (node.dataset.flipped === text) continue;
    node.dataset.flipped = text;
    // A background refresh flips only the numbers that actually changed.
    if (prev && prev[node.dataset.flip] === text) continue;
    clear(node);
    [...text].forEach((ch, i) =>
      node.appendChild(el("span", { class: "dg", style: { "--i": i } }, ch)),
    );
    node.classList.add("flip");
  }
}
/** The current text of every flip-digit node under root, keyed by data-flip. */
function digitValues(root) {
  const out = {};
  if (root && root.querySelectorAll)
    for (const n of root.querySelectorAll("[data-flip]")) out[n.dataset.flip] = n.textContent;
  return out;
}

// --- Data freshness ----------------------------------------------------------
//
// The header shows WHEN the data on screen was last confirmed by the server —
// the time of the last API response or live-stream byte — never a lamp that
// stays lit when the factory is unreachable (live-lamp-hardcoded). States:
//   live     the event stream is connected (pushes arrive within a second)
//   polling  the stream is down but API calls succeed (9s refresh fallback)
//   offline  the last call failed to reach the server, or nothing has been
//            confirmed for 2.5 refresh intervals — actions pause, data is stale
//   auth     the server refused our token
const FRESH_STALE_MS = 2.5 * 9000;
const freshness = {
  lastOkAt: 0,
  lastFailAt: 0,
  failKind: null,
  stream: "down",
  listeners: new Set(),
  ok() {
    const was = this.state();
    this.lastOkAt = Date.now();
    this.failKind = null;
    this.emit(was);
  },
  fail(kind) {
    const was = this.state();
    this.lastFailAt = Date.now();
    this.failKind = kind;
    this.emit(was);
  },
  setStream(state) {
    const was = this.state();
    this.stream = state;
    if (state === "up") this.lastOkAt = Date.now();
    this.emit(was);
  },
  state(now = Date.now()) {
    if (this.failKind === "auth") return "auth";
    if (this.failKind === "network" && this.lastFailAt >= this.lastOkAt) return "offline";
    if (!this.lastOkAt) return "connecting";
    if (now - this.lastOkAt > FRESH_STALE_MS && this.stream !== "up") return "offline";
    return this.stream === "up" ? "live" : "polling";
  },
  emit(was) {
    const now = this.state();
    for (const fn of this.listeners) fn(now, was);
  },
};

/** "18:58" in the viewer's clock (the header line is a fact, not a countdown). */
function clockTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Paint the header freshness line from the tracker (also re-run every 15s). */
function paintFreshness() {
  const node = document.getElementById("freshness");
  if (!node) return;
  const st = freshness.state();
  node.dataset.state = st;
  clear(node);
  const at = freshness.lastOkAt;
  if (st === "auth") {
    node.appendChild(el("span", { class: "rail-status-text" }, "Token refused"));
  } else if (st === "offline") {
    node.appendChild(glyph("blocked", 12));
    node.appendChild(
      el("span", {}, [
        "Offline",
        at
          ? el("span", { class: "rail-status-text" }, [
              " · data from ",
              el("time", { datetime: new Date(at).toISOString() }, clockTime(at)),
            ])
          : null,
      ]),
    );
  } else if (at) {
    node.appendChild(
      el("span", { class: "rail-status-text" }, [
        el("span", { class: "rs-prefix" }, st === "live" ? "Live · data as of " : "Data as of "),
        el("time", { datetime: new Date(at).toISOString() }, clockTime(at)),
      ]),
    );
  } else {
    node.appendChild(el("span", { class: "rail-status-text" }, "Connecting…"));
  }
  node.title =
    st === "live"
      ? "Connected to the factory's event stream; updates arrive as they happen."
      : st === "polling"
        ? "The live stream is down; the view refreshes every 9 seconds."
        : st === "offline"
          ? "Can't reach the factory. What you see is from the time shown; actions are paused."
          : st === "auth"
            ? "The factory refused this token."
            : "Waiting for the first answer from the factory.";
  document.body.classList.toggle("is-offline", st === "offline");
  const strip = document.getElementById("offline-strip");
  if (strip) {
    strip.hidden = st !== "offline";
    if (st === "offline") {
      clear(strip);
      strip.appendChild(
        el("div", {}, [
          glyph("blocked", 14),
          at
            ? `Can't reach the factory. You're looking at data from ${clockTime(at)}; actions are paused until it answers.`
            : "Can't reach the factory. Actions are paused until it answers.",
        ]),
      );
    }
  }
}
let freshPainted = "";
freshness.listeners.add((now, was) => {
  // Repaint only when what the line says would change (state or the minute shown).
  const key = `${now}|${freshness.lastOkAt ? clockTime(freshness.lastOkAt) : ""}`;
  if (key !== freshPainted) {
    freshPainted = key;
    paintFreshness();
  }
  // Coming back: re-read the view at once instead of waiting for the next tick.
  if (was === "offline" && (now === "live" || now === "polling")) refreshCurrentView();
});

// --- Theme (per-viewer kit) ----------------------------------------------------

const THEME_KEY = "gaffer_theme";
function storedTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}
/** The kit actually showing: the stored override, else the system setting. */
function effectiveTheme() {
  const t = storedTheme();
  if (t !== "system") return t;
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
/** Pin the kit ("light" | "dark") or follow the system ("system"). */
function setTheme(t) {
  try {
    if (t === "light" || t === "dark") localStorage.setItem(THEME_KEY, t);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  else document.documentElement.removeAttribute("data-theme");
  paintThemeToggle();
}
function toggleTheme() {
  setTheme(effectiveTheme() === "dark" ? "light" : "dark");
}
function paintThemeToggle() {
  for (const b of document.querySelectorAll(".theme-toggle")) {
    const dark = effectiveTheme() === "dark";
    clear(b);
    b.appendChild(icon(dark ? "sun" : "moon", null, 18));
    b.setAttribute(
      "aria-label",
      dark ? "Switch to the day kit (light)" : "Switch to the floodlit kit (dark)",
    );
    b.title = b.getAttribute("aria-label");
  }
}

// --- App chrome: the club header + the phone bottom nav ----------------------

// Primary nav in programme order. Counts are live data from /api/dashboard:
// Review's count is yellow (it needs you); Work's is plain (load, not a demand).
const NAV = [
  { id: "overview", label: "Overview", icon: "overview" },
  { id: "work", label: "Work", icon: "work" },
  { id: "review", label: "Review", icon: "review" },
  { id: "epics", label: "Epics", icon: "epics" },
  { id: "factory", label: "Map", icon: "map" },
  { id: "specs", label: "Specs", icon: "specs" },
  { id: "memory", label: "Memory", icon: "memory" },
  { id: "health", label: "Health", icon: "health" },
  { id: "settings", label: "Settings", icon: "settings" },
];
/** The phone bottom nav: the loop an operator drives; the rest sit under More. */
const BOTTOM_NAV_IDS = ["overview", "work", "review"];
const navCounts = {};

function navCountEl(id) {
  return el("span", { class: "nav-count", dataset: { count: id }, hidden: true });
}

function buildChrome() {
  clear(appbar);
  const brand = el("a", { class: "brand", href: "#/overview", "aria-label": "Gaffer — Overview" }, [
    crest(),
    el("span", { class: "brand-t" }, [
      el("span", { class: "brand-name" }, "Gaffer"),
      el("span", { class: "brand-sub", id: "brand-sub" }),
    ]),
  ]);

  const railItems = NAV.map((n) =>
    el("a", { class: "nav-link", href: `#/${n.id}`, dataset: { area: n.id }, onclick: reselect }, [
      el("span", { class: "nav-label" }, n.label),
      navCountEl(n.id),
    ]),
  );
  const more = el(
    "button",
    {
      class: "nav-more",
      type: "button",
      "aria-haspopup": "true",
      "aria-expanded": "false",
      hidden: true,
      onclick: (e) => toggleNavMenu(e.currentTarget),
    },
    ["More", icon("chevdown", null, 16)],
  );
  const rail = el("nav", { class: "nav-rail", "aria-label": "Primary views" }, [
    ...railItems,
    more,
  ]);

  const freshnessNode = el("span", {
    class: "rail-status",
    id: "freshness",
    role: "status",
    "aria-live": "polite",
    dataset: { state: "connecting" },
  });
  const cmdk = el(
    "button",
    {
      class: "btn-club cmdk-trigger",
      type: "button",
      "aria-label": "Search",
      "aria-keyshortcuts": "Control+K Meta+K",
      onclick: () => openPalette(),
    },
    [
      icon("search", null, 18),
      el("span", { class: "cmdk-label" }, "Search"),
      el("span", { class: "kbd" }, "⌘K"),
    ],
  );
  const theme = el("button", {
    class: "btn-club icon-only theme-toggle",
    type: "button",
    onclick: toggleTheme,
  });
  const newBtn = el("a", { class: "btn-club btn-new", href: "#/create" }, [
    icon("plus", null, 18),
    el("span", {}, "New"),
  ]);
  const end = el("div", { class: "club-end" }, [freshnessNode, cmdk, theme, newBtn]);
  // Logout affordance — only when authenticating with a token.
  if (authToken()) {
    end.appendChild(
      el("button", { class: "btn-club logout-btn", type: "button", onclick: logout }, "Logout"),
    );
  }
  appbar.appendChild(el("div", { class: "club-in" }, [brand, rail, end]));
  appbar.hidden = false;
  if (!document.getElementById("offline-strip")) {
    appbar.after(
      el("div", { class: "offline-strip", id: "offline-strip", role: "alert", hidden: true }),
    );
  }

  // Phone bottom nav: Overview · Work · Review · More (the More sheet reaches every
  // other route plus Search and the kit switch — nothing is unreachable on a phone).
  clear(bottomnav);
  for (const n of NAV.filter((x) => BOTTOM_NAV_IDS.includes(x.id))) {
    bottomnav.appendChild(
      el(
        "a",
        { class: "bottomnav-item", href: `#/${n.id}`, dataset: { area: n.id }, onclick: reselect },
        [el("span", {}, n.label), navCountEl(n.id)],
      ),
    );
  }
  bottomnav.appendChild(
    el(
      "button",
      { class: "bottomnav-item bottomnav-more", type: "button", onclick: openMoreSheet },
      "More",
    ),
  );
  bottomnav.hidden = false;

  paintThemeToggle();
  paintFreshness();
  fitNav();
  if (typeof window.ResizeObserver === "function" && !appbar._ro) {
    appbar._ro = new window.ResizeObserver(() => fitNav());
    appbar._ro.observe(appbar);
  }
  if (typeof document.fonts?.ready?.then === "function") document.fonts.ready.then(fitNav);
  if (!window._freshTimer) window._freshTimer = setInterval(paintFreshness, 15000);
  startAutoRefresh();
}

/**
 * Re-selecting the view you are on still re-reads it: an identical hash fires no
 * hashchange, so the nav link routes explicitly (as navigate() does).
 */
function reselect(e) {
  const href = e.currentTarget.getAttribute("href");
  if (href && location.hash === href) {
    e.preventDefault();
    router();
  }
}

/**
 * Priority+ nav: show as many tabs as fit in the bar and move the rest into the
 * More menu, so the header can never be wider than the viewport
 * (appbar-overflow-760-1565). Folding order, first to last: the kit switch and
 * Logout (both also live in More), then the reference tabs from the right
 * (Settings, Health, Memory, Specs, Map, Epics), then Work. Overview, Review —
 * with its yellow "needs you" count — and the active tab never fold. More shows
 * the sum of any counts it holds.
 */
const NAV_PINNED = new Set(["overview", "review"]);
function fitNav() {
  const rail = appbar.querySelector(".nav-rail");
  if (!rail || !rail.clientWidth) return;
  const links = [...rail.querySelectorAll(".nav-link")];
  const more = rail.querySelector(".nav-more");
  const extras = [...appbar.querySelectorAll(".club-end .theme-toggle, .club-end .logout-btn")];
  links.forEach((l) => (l.hidden = false));
  extras.forEach((b) => b.removeAttribute("data-folded"));
  appbar.classList.remove("nav-tight");
  more.hidden = true;
  const fits = () => rail.scrollWidth <= rail.clientWidth;
  if (fits()) return paintMoreCount(more, links);
  more.hidden = false;
  extras.forEach((b) => b.setAttribute("data-folded", ""));
  // Then the header's small print: the club name and the freshness prefix (the
  // time itself stays — it is the one liveness signal).
  if (!fits()) appbar.classList.add("nav-tight");
  const order = [...links]
    .reverse()
    .filter((l) => !NAV_PINNED.has(l.dataset.area) && l.dataset.area !== activeArea);
  // Work folds last of the foldable tabs.
  order.sort((a, b) => (a.dataset.area === "work") - (b.dataset.area === "work"));
  for (const l of order) {
    if (fits()) break;
    l.hidden = true;
  }
  more.classList.toggle(
    "active",
    links.some((l) => l.hidden && l.dataset.area === activeArea),
  );
  paintMoreCount(more, links);
}
/** More carries the counts of the tabs folded into it (plain: Review never folds). */
function paintMoreCount(more, links) {
  more.querySelector(".nav-count")?.remove();
  if (more.hidden) return;
  const n = links
    .filter((l) => l.hidden)
    .reduce((sum, l) => sum + (Number(navCounts[l.dataset.area]) || 0), 0);
  if (n > 0) more.insertBefore(el("span", { class: "nav-count" }, String(n)), more.lastChild);
}

let navMenuEl = null;
function closeNavMenu() {
  if (!navMenuEl) return;
  navMenuEl.remove();
  navMenuEl = null;
  const btn = appbar.querySelector(".nav-more");
  if (btn) btn.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", navMenuOutside, true);
  document.removeEventListener("keydown", navMenuKey);
}
function navMenuOutside(e) {
  if (navMenuEl && !navMenuEl.contains(e.target) && !e.target.closest?.(".nav-more"))
    closeNavMenu();
}
function navMenuKey(e) {
  if (e.key === "Escape") {
    const btn = appbar.querySelector(".nav-more");
    closeNavMenu();
    btn?.focus();
  }
}
function toggleNavMenu(btn) {
  if (navMenuEl) {
    closeNavMenu();
    return;
  }
  const hidden = [...appbar.querySelectorAll(".nav-link[hidden]")];
  const items = hidden.map((l) => {
    const id = l.dataset.area;
    const n = NAV.find((x) => x.id === id);
    return el(
      "a",
      {
        href: `#/${id}`,
        "aria-current": id === activeArea ? "page" : null,
        onclick: closeNavMenu,
      },
      [n ? n.label : id, navCounts[id] ? navCountBadge(id) : null],
    );
  });
  // The kit switch and Logout, when fitNav folded them out of the header.
  if (appbar.querySelector(".theme-toggle[data-folded]")) {
    const dark = effectiveTheme() === "dark";
    items.push(
      el("button", { type: "button", onclick: () => (closeNavMenu(), toggleTheme()) }, [
        dark ? "Day kit (light)" : "Floodlit kit (dark)",
        icon(dark ? "sun" : "moon", null, 18),
      ]),
    );
  }
  if (appbar.querySelector(".logout-btn[data-folded]")) {
    items.push(
      el("button", { type: "button", onclick: () => (closeNavMenu(), logout()) }, [
        "Log out",
        icon("logout", null, 18),
      ]),
    );
  }
  navMenuEl = el("div", { class: "nav-menu", role: "menu", "aria-label": "More views" }, items);
  const r = btn.getBoundingClientRect();
  navMenuEl.style.top = `${r.bottom + 6}px`;
  navMenuEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 240))}px`;
  navMenuEl.style.position = "fixed";
  document.body.appendChild(navMenuEl);
  btn.setAttribute("aria-expanded", "true");
  navMenuEl.querySelector("a")?.focus();
  setTimeout(() => document.addEventListener("click", navMenuOutside, true), 0);
  document.addEventListener("keydown", navMenuKey);
}
function navCountBadge(id) {
  const v = navCounts[id];
  return el("span", { class: `nav-count${id === "review" ? " urgent" : ""}` }, String(v));
}

/** The phone More sheet: every route not in the bottom nav, Search, the kit. */
function openMoreSheet() {
  const links = NAV.filter((n) => !BOTTOM_NAV_IDS.includes(n.id)).map((n) =>
    el(
      "a",
      {
        class: "more-link",
        href: `#/${n.id}`,
        "aria-current": n.id === activeArea ? "page" : null,
        onclick: closeSheet,
      },
      [n.label, icon("chevron", null, 18)],
    ),
  );
  const dark = effectiveTheme() === "dark";
  openSheet(
    "More",
    el("div", { class: "more-list" }, [
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => {
            closeSheet();
            openPalette();
          },
        },
        [icon("search", null, 18), "Search tickets and views"],
      ),
      ...links,
      el(
        "button",
        {
          class: "more-link",
          type: "button",
          onclick: () => {
            toggleTheme();
            closeSheet();
          },
        },
        [dark ? "Day kit (light)" : "Floodlit kit (dark)", icon(dark ? "sun" : "moon", null, 18)],
      ),
      authToken()
        ? el("button", { class: "more-link", type: "button", onclick: logout }, [
            "Log out",
            icon("logout", null, 18),
          ])
        : null,
    ]),
  );
}

// Hot-refresh: read-mostly views quietly re-fetch so the board, overview and
// review reflect what the factory is doing without a manual reload. It never
// fights the operator: skipped while typing, dragging, with a sheet/menu open,
// when the tab is hidden, or if the route changed mid-fetch. It keeps the scroll
// position (on the document — the real scroller), holds the view's height while
// async parts (diffs) settle so the page can't shrink and clamp scroll to 0, and
// skips the swap entirely when the view's data signature did not change.
const AUTO_REFRESH_MS = 9000;
const AUTO_REFRESHABLE = new Set(["overview", "work", "review", "epics", "memory"]);
let autoRefreshTimer;
function busyEditing() {
  const a = document.activeElement;
  return !!(
    a &&
    (a.tagName === "INPUT" ||
      a.tagName === "TEXTAREA" ||
      a.tagName === "SELECT" ||
      a.isContentEditable)
  );
}
// --- live event stream --------------------------------------------------------
// The control plane pushes its append-only event log as Server-Sent Events
// (GET /api/events/stream). Every push schedules ONE debounced refresh of the
// current view. Streamed with fetch (not EventSource) so the bearer token travels
// in the Authorization header, never in the URL. A read watchdog treats ~40s of
// silence (the server pings every 15s) as a dead connection, so a half-open
// socket after sleep or a network change can't keep the header saying "Live".
let liveStreamAbort = null;
let liveStreamSeq = null;
let liveRefreshTimer = null;
const LIVE_REFRESH_DEBOUNCE_MS = 400;
const LIVE_RECONNECT_MS = 5000;
const LIVE_WATCHDOG_MS = 40000;

function scheduleLiveRefresh() {
  if (liveRefreshTimer) return;
  liveRefreshTimer = setTimeout(() => {
    liveRefreshTimer = null;
    refreshCurrentView();
  }, LIVE_REFRESH_DEBOUNCE_MS);
}

async function startLiveStream() {
  if (liveStreamAbort || typeof fetch !== "function" || typeof ReadableStream === "undefined")
    return;
  const controller = new AbortController();
  liveStreamAbort = controller;
  const headers = { accept: "text/event-stream" };
  const tok = authToken();
  if (tok) headers["authorization"] = "Bearer " + tok;
  const since = liveStreamSeq === null ? "" : `?since=${liveStreamSeq}`;
  let watchdog = null;
  const pet = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => controller.abort(), LIVE_WATCHDOG_MS);
  };
  try {
    const res = await fetch(`/api/events/stream${since}`, { headers, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    pet();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pet();
      if (freshness.stream !== "up") freshness.setStream("up");
      else freshness.lastOkAt = Date.now();
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let isEvent = false;
        for (const line of frame.split("\n")) {
          if (line.startsWith("id: ")) liveStreamSeq = Number(line.slice(4)) || liveStreamSeq;
          else if (line.startsWith("event: work_event")) isEvent = true;
        }
        if (isEvent) scheduleLiveRefresh();
      }
    }
  } catch {
    // fall through to reconnect (the interval refresh keeps the UI honest meanwhile)
  } finally {
    clearTimeout(watchdog);
    liveStreamAbort = null;
    freshness.setStream("down");
    if (document.visibilityState !== "hidden") setTimeout(startLiveStream, LIVE_RECONNECT_MS);
  }
}
// A phone tab coming back to the foreground re-checks at once instead of
// trusting its old state: restart the stream and re-read the view.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !autoRefreshTimer) return;
  startLiveStream();
  refreshCurrentView();
});

/**
 * Cheap per-view change signatures. When a refresh's signature matches the one
 * the view on screen was rendered from, the view is left alone: no detail or diff
 * re-fetches, no DOM swap, nothing moves (review-n-plus-one-refresh).
 */
const VIEW_SIGNATURES = {
  review: async () => {
    const tickets = (await api("GET", "/tickets?status=in_review")).tickets || [];
    return reviewSignature(tickets);
  },
};
function reviewSignature(tickets) {
  return tickets.map((t) => `${t.id}@${t.updated_at || ""}`).join("|");
}

/** Re-render the current view in place if it is safe to do so (shared by the interval + stream). */
let refreshing = false;
function refreshCurrentView() {
  if (document.visibilityState === "hidden") return;
  if (busyEditing()) return;
  // don't yank a card mid-drag or a menu/sheet out from under a click.
  if (document.querySelector(".dragging, .is-dragging, .sheet.open, .menu-open")) return;
  if (navMenuEl) return;
  // A modal owns the screen (reject dialog, move menu, command palette).
  if (isModalOpen()) return;
  // Never tear down the review queue mid-triage (armed approve or focus in a card).
  if (reviewInteractionInProgress()) return;
  const { view, param } = parseHash();
  if (!AUTO_REFRESHABLE.has(view)) return;
  const render = VIEWS[view];
  if (!render || refreshing) return;
  const gen = routeGen;
  const current = app.firstElementChild;
  refreshing = true;
  (async () => {
    try {
      const sigFn = VIEW_SIGNATURES[view];
      if (sigFn && current && current.dataset.sig != null) {
        const sig = await sigFn();
        if (sig === current.dataset.sig) return;
      }
      const content = await render(param);
      // bail if the operator navigated or started interacting during the fetch — the
      // armed-approve check must run AGAIN here: a refresh that started a moment before
      // the first Approve click would otherwise swap in a fresh, unarmed button under
      // the confirming second click (the click then only re-arms; nothing is approved).
      if (gen !== routeGen || busyEditing() || reviewInteractionInProgress() || isModalOpen()) {
        disposeView(content);
        return;
      }
      if (content.dataset.sig != null && current && content.dataset.sig === current.dataset.sig) {
        disposeView(content); // same data: keep the DOM (and its scroll + open details)
        return;
      }
      const se = document.scrollingElement || document.documentElement;
      const y = se.scrollTop;
      const prevDigits = digitValues(current);
      // Hold the old height across the swap: async parts of the new view (diffs)
      // mount as short placeholders, and a shorter page would clamp scroll to 0.
      app.style.minHeight = `${app.offsetHeight}px`;
      mountView(content);
      se.scrollTop = y;
      flipDigits(content, prevDigits);
      const release = () => {
        if (app.firstElementChild === content) app.style.minHeight = "";
      };
      if (content._settled && typeof content._settled.then === "function") {
        Promise.race([content._settled, new Promise((r) => setTimeout(r, 8000))]).then(release);
      } else release();
    } catch (e) {
      if (e && (e.code === "UNAUTHORIZED" || e.code === "ABORTED")) return;
      // The header already says "Offline"; one toast per outage, not one per tick.
      if (e && e.code === "NETWORK") return;
      toast(e.message || "Refresh failed", { code: e.code });
    } finally {
      refreshing = false;
    }
  })();
}

/** An approve is armed (keyboard `.card-armed` or mouse `.btn-armed`) or the operator is focused inside a review card. */
function reviewInteractionInProgress() {
  if (document.querySelector(".card-armed, .btn-armed")) return true;
  const a = document.activeElement;
  return !!(a && typeof a.closest === "function" && a.closest(".view .card"));
}

function startAutoRefresh() {
  if (autoRefreshTimer) return;
  startLiveStream();
  autoRefreshTimer = setInterval(refreshCurrentView, AUTO_REFRESH_MS);
}

function syncNav() {
  document.querySelectorAll("[data-area]").forEach((n) => {
    const on = n.dataset.area === activeArea;
    n.classList.toggle("active", on);
    // Programmatic active state for assistive tech (WCAG 1.4.1).
    if (on) n.setAttribute("aria-current", "page");
    else n.removeAttribute("aria-current");
  });
  const moreBtn = bottomnav && bottomnav.querySelector(".bottomnav-more");
  if (moreBtn) moreBtn.classList.toggle("active", !BOTTOM_NAV_IDS.includes(activeArea));
  fitNav();
}

// One-line polite announcement into the dedicated #sr-status region (see
// index.html). Used for view changes and background refreshes so a screen
// reader hears a short message instead of the whole re-rendered view.
function announce(msg) {
  const r = document.getElementById("sr-status");
  if (!r) return;
  r.textContent = "";
  // A frame gap makes the region change register as a fresh announcement.
  requestAnimationFrame(() => {
    r.textContent = msg;
  });
}

// Human-facing browser-tab title per view, so several open tabs (Review, a
// ticket, Settings) are distinguishable in the tab strip, history and bookmarks.
const VIEW_TITLES = {
  overview: "Overview",
  health: "Health",
  work: "Work",
  review: "Review",
  epics: "Epics",
  specs: "Specs",
  factory: "Map",
  memory: "Memory",
  settings: "Settings",
  ticket: "Ticket",
  repo: "Repo",
  node: "Map",
  create: "Plan a build",
  hidden: "Hidden repos",
};
function setDocTitle(view, detail) {
  const base = VIEW_TITLES[view] || "Gaffer";
  document.title = detail ? `${detail} · Gaffer` : `${base} · Gaffer`;
}

/** The club's name under the crest: the factory node on the scope map (read once). */
let factoryNamePromise = null;
function factoryName() {
  if (!factoryNamePromise) {
    factoryNamePromise = api("GET", "/scope/nodes")
      .then((r) => (r.nodes || []).find((n) => n.type === "factory")?.name || null)
      .catch(() => {
        factoryNamePromise = null;
        return null;
      });
  }
  return factoryNamePromise;
}

/** Live nav counts from /api/dashboard: Review = the gate queue (yellow: it needs
 *  you); Work = tickets in flight (plain). Best-effort; the nav works without them. */
let navBadgeBusy = false;
async function updateNavBadges() {
  if (navBadgeBusy) return;
  navBadgeBusy = true;
  try {
    const { summary } = await api("GET", "/api/dashboard");
    const s = summary.ticketsByStatus || {};
    navCounts.work =
      (s.ready || 0) +
      (s.in_progress || 0) +
      (s.claimed || 0) +
      (s.in_review || 0) +
      (s.in_testing || 0) +
      (s.ready_for_merge || 0) +
      (s.blocked || 0);
    navCounts.review = s.in_review || 0;
    const club = summary.club?.name || summary.clubName || (await factoryName());
    const sub = document.getElementById("brand-sub");
    if (sub && club) sub.textContent = club;
    document.querySelectorAll(".nav-count[data-count]").forEach((n) => {
      const id = n.dataset.count;
      const v = navCounts[id];
      if (v > 0) {
        n.textContent = String(v);
        n.hidden = false;
        n.classList.toggle("urgent", id === "review");
        n.setAttribute("aria-label", id === "review" ? `${v} waiting for you` : `${v} in flight`);
      } else {
        n.hidden = true;
      }
    });
    fitNav();
  } catch {
    /* best-effort */
  } finally {
    navBadgeBusy = false;
  }
}

// --- Command palette (⌘K) ---------------------------------------------------

let paletteEls = null;
let paletteItems = [];
let paletteActive = 0;

async function buildPaletteSources() {
  // Static destinations + actions always available; tickets fetched lazily.
  const base = [
    {
      group: "Go",
      label: "Overview",
      hint: "needs you · activity",
      icon: "overview",
      run: () => navigate("#/overview"),
    },
    {
      group: "Go",
      label: "Work",
      hint: "board ⇄ list",
      icon: "work",
      run: () => navigate("#/work"),
    },
    {
      group: "Go",
      label: "Review queue",
      hint: "approve · reject",
      icon: "review",
      run: () => navigate("#/review"),
    },
    {
      group: "Go",
      label: "Epics",
      hint: "build plans · phases · deps",
      icon: "epics",
      run: () => navigate("#/epics"),
    },
    {
      group: "Go",
      label: "Map",
      hint: "scope graph",
      icon: "map",
      run: () => navigate("#/factory"),
    },
    {
      group: "Go",
      label: "Health",
      hint: "delivery metrics · ledger",
      icon: "health",
      run: () => navigate("#/health"),
    },
    {
      group: "Go",
      label: "Specs",
      hint: "frozen intent · coverage",
      icon: "specs",
      run: () => navigate("#/specs"),
    },
    {
      group: "Go",
      label: "Memory",
      hint: "digest · feature ledger · lore",
      icon: "memory",
      run: () => navigate("#/memory"),
    },
    {
      group: "Go",
      label: "Settings",
      hint: "autonomy · delivery · sandbox",
      icon: "settings",
      run: () => navigate("#/settings"),
    },
    {
      group: "Create",
      label: "New ticket",
      hint: "one ticket, outside any campaign",
      icon: "plus",
      run: () => navigate("#/create/ticket"),
    },
    {
      group: "Create",
      label: "Plan a build",
      hint: "brief → epic of tickets",
      icon: "spark",
      run: () => openPlanBuild(),
    },
    {
      group: "Create",
      label: "Author a spec",
      hint: "brief → editable clauses → freeze",
      icon: "spark",
      run: () => openSpecBuild(),
    },
    {
      group: "Create",
      label: "New scope node",
      hint: "map",
      icon: "map",
      run: () => navigate("#/node"),
    },
    {
      group: "Kit",
      label: effectiveTheme() === "dark" ? "Day kit (light theme)" : "Floodlit kit (dark theme)",
      hint: "this browser only",
      icon: effectiveTheme() === "dark" ? "sun" : "moon",
      run: () => toggleTheme(),
    },
    {
      group: "Kit",
      label: "Follow the system theme",
      hint: storedTheme() === "system" ? "on" : "off",
      icon: "settings",
      run: () => setTheme("system"),
    },
  ];
  let tickets = [];
  try {
    tickets = (await api("GET", "/tickets")).tickets || [];
  } catch {
    // Palette still works for navigation if the list call fails.
  }
  const ticketItems = tickets.slice(0, 60).map((t) => ({
    group: "Tickets",
    label: `${t.number != null ? `#${t.number} ` : ""}${t.title}`,
    hint: statusLabel(t.status),
    icon: "ticket",
    run: () => navigate(`#/ticket/${t.id}`),
  }));
  return [...base, ...ticketItems];
}

function ensurePalette() {
  if (paletteEls) return paletteEls;
  const input = el("input", {
    class: "palette-input",
    type: "text",
    placeholder: "Jump to a view, ticket or action…",
    "aria-label": "Command palette",
  });
  const list = el("ul", { class: "palette-list" });
  const palette = el("div", { class: "palette", role: "dialog", "aria-modal": "true" }, [
    el("div", { class: "palette-input-wrap" }, [icon("search"), input]),
    list,
    el("div", { class: "palette-foot" }, [
      el("span", {}, [el("span", { class: "kbd" }, "↑↓"), " navigate"]),
      el("span", {}, [el("span", { class: "kbd" }, "↵"), " open"]),
      el("span", {}, [el("span", { class: "kbd" }, "esc"), " close"]),
    ]),
  ]);
  const scrim = el("div", { class: "palette-scrim", onclick: closePalette });
  scrim.appendChild(palette);
  palette.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("input", () => renderPaletteList(input.value));
  input.addEventListener("keydown", paletteKeydown);
  document.body.appendChild(scrim);
  paletteEls = { scrim, palette, input, list };
  return paletteEls;
}

let paletteAllItems = [];
async function openPalette() {
  const { scrim, input } = ensurePalette();
  scrim.classList.add("open");
  input.value = "";
  input.focus();
  paletteAllItems = await buildPaletteSources();
  renderPaletteList("");
}
function closePalette() {
  if (paletteEls) paletteEls.scrim.classList.remove("open");
}
function fuzzyMatch(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return true;
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return t.includes(q);
}
function renderPaletteList(query) {
  const { list } = ensurePalette();
  clear(list);
  paletteItems = paletteAllItems.filter((it) =>
    fuzzyMatch(query, it.label + " " + (it.hint || "")),
  );
  paletteActive = 0;
  if (!paletteItems.length) {
    list.appendChild(el("div", { class: "palette-empty" }, "No matches."));
    return;
  }
  let lastGroup = null;
  paletteItems.forEach((it, idx) => {
    if (it.group !== lastGroup) {
      list.appendChild(el("li", { class: "palette-group-label" }, it.group));
      lastGroup = it.group;
    }
    list.appendChild(
      el(
        "li",
        {
          class: `palette-item${idx === 0 ? " active" : ""}`,
          dataset: { idx: String(idx) },
          onmouseenter: () => setPaletteActive(idx),
          onclick: () => runPaletteItem(idx),
        },
        [
          icon(it.icon || "arrow", "pi-ico"),
          el("span", { class: "pi-label" }, it.label),
          it.hint ? el("span", { class: "pi-hint" }, it.hint) : null,
        ],
      ),
    );
  });
}
function setPaletteActive(idx) {
  paletteActive = idx;
  paletteEls.list.querySelectorAll(".palette-item").forEach((n) => {
    n.classList.toggle("active", Number(n.dataset.idx) === idx);
  });
}
function runPaletteItem(idx) {
  const it = paletteItems[idx];
  if (!it) return;
  closePalette();
  it.run();
}
function paletteKeydown(e) {
  if (e.key === "Escape") {
    closePalette();
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (paletteItems.length) setPaletteActive((paletteActive + 1) % paletteItems.length);
    scrollPaletteActive();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (paletteItems.length)
      setPaletteActive((paletteActive - 1 + paletteItems.length) % paletteItems.length);
    scrollPaletteActive();
  } else if (e.key === "Enter") {
    e.preventDefault();
    runPaletteItem(paletteActive);
  }
}
function scrollPaletteActive() {
  const node = paletteEls.list.querySelector(".palette-item.active");
  if (node) node.scrollIntoView({ block: "nearest" });
}

// Global ⌘K / Ctrl+K hotkey.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (paletteEls && paletteEls.scrim.classList.contains("open")) closePalette();
    else openPalette();
  }
});

// ===========================================================================
//  View: Overview — the control room
//  Lead with "what needs you now" → live activity → bento stats → repo pressure.
// ===========================================================================

// ===========================================================================
//  View: Overview — the match-day programme's front page
//    the stadium scoreboard (headline + four counters), the Team Sheet (what
//    needs you, each row with one real action), the Tactics Board (every ticket
//    in play on a drawn pitch, agents in numbered shirts, chalk arrows for the
//    real moves), then the programme pages: Cup runs, Injury list, League table,
//    Wage bill, Squad & form, Full time, Fixtures and the Match report.
//  Every mark is a field a server response carried. The flow numbers, governance
//  rates and run list live in the Health view (the physio room).
// ===========================================================================

/** The statuses drawn on the pitch, left (ready) to right (to merge). */
const PITCH_ZONES = [
  { key: "ready", label: "Ready", x0: 0, x1: 210 },
  { key: "claimed", label: "Claimed", x0: 210, x1: 360 },
  { key: "in_progress", label: "In progress", x0: 360, x1: 525 },
  { key: "in_review", label: "In review", x0: 525, x1: 700 },
  { key: "in_testing", label: "In testing", x0: 700, x1: 860 },
  { key: "ready_for_merge", label: "To merge", x0: 860, x1: 1050 },
];
const ON_PITCH = new Set(PITCH_ZONES.map((z) => z.key));
const OFF_PITCH = new Set(["blocked", "paused", "failed"]);
const ON_BENCH = new Set(["draft", "refining"]);
const PITCH_MAX_CHANNELS = 6;
const ARROW_WINDOW_MS = 3 * 3600e3;

/** SVG builder for the drawings: like svgEl, but `style` may be an object. */
function svgS(tag, attrs = {}, ...children) {
  const a = { ...attrs };
  if (a.style && typeof a.style === "object") {
    a.style = Object.entries(a.style)
      .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}:${v}`)
      .join(";");
  }
  return svgEl(tag, a, children.flat());
}

// Text measurement for the board's layout engine (tags, label boxes). jsdom and
// some locked-down browsers have no 2D canvas: fall back to an average glyph width.
let measureCtx;
/**
 * Break a name into at most `max` lines that each fit `width` (breaking after
 * - _ / . first); the last line is cut with an ellipsis if it still overflows.
 */
function wrapLabel(str, size, width, max = 2) {
  const parts = String(str).match(/[^-_/.]+[-_/.]?/g) || [String(str)];
  const lines = [];
  let cur = "";
  for (const p of parts) {
    if (cur && textWidth(cur + p, size) > width && lines.length < max - 1) {
      lines.push(cur);
      cur = p;
    } else cur += p;
  }
  lines.push(cur);
  const last = lines.length - 1;
  if (textWidth(lines[last], size) > width) {
    let t = lines[last];
    while (t.length > 1 && textWidth(t + "…", size) > width) t = t.slice(0, -1);
    lines[last] = t + "…";
  }
  return lines;
}
function textWidth(str, size, track = 0) {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d") || null;
    } catch {
      measureCtx = null;
    }
  }
  const s = String(str);
  if (!measureCtx) return s.length * size * (0.5 + track);
  measureCtx.font = `700 ${size}px "Sofia Sans Condensed", "Arial Narrow", sans-serif`;
  return measureCtx.measureText(s).width + s.length * size * track;
}

/** A ball, for the net tallies. */
function pitchBall(r = 7) {
  return svgS(
    "g",
    { class: "ball" },
    svgS("circle", { r, fill: "var(--chalk)", stroke: "var(--ink-on-pitch)", "stroke-width": 1 }),
    svgS("path", {
      d: `M0 ${-r * 0.42} L${r * 0.4} ${-r * 0.13} L${r * 0.25} ${r * 0.34} L${-r * 0.25} ${r * 0.34} L${-r * 0.4} ${-r * 0.13} Z`,
      fill: "var(--ink-on-pitch)",
    }),
  );
}
/** The club shirt as a group, placed at (x, y) and scaled (40 units across). */
function shirtGroup(no, x = 0, y = 0, scale = 1, numPx) {
  const id = "sg" + ++svgUid;
  return svgS(
    "g",
    { transform: `translate(${x} ${y}) scale(${scale})` },
    svgS("defs", {}, svgS("clipPath", { id }, svgS("path", { d: SHIRT_PATH }))),
    svgS("path", { d: SHIRT_PATH, fill: "var(--claret)" }),
    svgS(
      "g",
      { "clip-path": `url(#${id})`, fill: "var(--sky)" },
      svgS("path", { d: "M13 4 Q20 9.5 27 4 L27 6.4 Q20 12 13 6.4 Z" }),
      svgS("path", { d: "M10 9.6 L20 15 L30 9.6 L30 12.6 L20 18 L10 12.6 Z" }),
      svgS("rect", { x: 0, y: 15.5, width: 6.5, height: 3 }),
      svgS("rect", { x: 33.5, y: 15.5, width: 6.5, height: 3 }),
    ),
    svgS("path", {
      d: SHIRT_PATH,
      fill: "none",
      stroke: "var(--shirt-edge)",
      "stroke-width": 1.4,
      "stroke-linejoin": "round",
    }),
    svgS(
      "text",
      {
        x: 20,
        y: 34,
        "text-anchor": "middle",
        class: "shirt-no",
        style: numPx ? { fontSize: (numPx / scale).toFixed(2) + "px" } : undefined,
      },
      no,
    ),
  );
}

/** Ticket details (scopes, deps, events, evidence) cached by updated_at. */
const ticketDetailCache = new Map();
const TICKET_DETAIL_TTL_MS = 120000;
async function ticketDetails(tickets, signal) {
  const now = Date.now();
  const need = tickets.filter((t) => {
    const c = ticketDetailCache.get(t.id);
    return !c || c.stamp !== t.updated_at || now - c.at > TICKET_DETAIL_TTL_MS;
  });
  for (let i = 0; i < need.length; i += EPIC_DETAIL_CONCURRENCY) {
    const batch = need.slice(i, i + EPIC_DETAIL_CONCURRENCY);
    const got = await Promise.all(
      batch.map((t) =>
        api("GET", `/tickets/${t.id}`, undefined, { signal }).catch((e) => {
          if (e && e.code === "ABORTED") throw e;
          return null;
        }),
      ),
    );
    batch.forEach((t, j) => {
      if (got[j]) ticketDetailCache.set(t.id, { stamp: t.updated_at, at: now, data: got[j] });
    });
  }
  const out = new Map();
  for (const t of tickets) {
    const c = ticketDetailCache.get(t.id);
    if (c) out.set(t.id, c.data);
  }
  return out;
}
const runDetailCache = new Map();
async function activeRunDetails(active, signal) {
  const out = new Map();
  await Promise.all(
    (active || []).map(async (r) => {
      const c = runDetailCache.get(r.id);
      let d = c && Date.now() - c.at < 20000 ? c.data : null;
      if (!d) {
        d = await api("GET", `/api/runs/${r.id}`, undefined, { signal })
          .then((x) => x.detail || x)
          .catch((e) => {
            if (e && e.code === "ABORTED") throw e;
            return null;
          });
        if (d) runDetailCache.set(r.id, { at: Date.now(), data: d });
      }
      if (d && d.ticket_number != null) out.set(d.ticket_number, d);
    }),
  );
  return out;
}

/** How many details the overview may read (the newest first): a big club stays fast. */
const OVERVIEW_DETAIL_CAP = 150;
const TERMINAL = new Set(["done", "cancelled", "failed"]);

/** Everything the Overview draws, read once per render. */
async function loadMatchDay() {
  const signal = routeSignal();
  const opt = (p, fb) =>
    api("GET", p, undefined, { signal }).catch((e) => {
      if (e && (e.code === "ABORTED" || e.code === "UNAUTHORIZED")) throw e;
      return fb;
    });
  const [
    dash,
    queue,
    board,
    cost,
    health,
    settings,
    claimsRes,
    agentsRes,
    runsRes,
    activity,
    decs,
    nodes,
  ] = await Promise.all([
    api("GET", "/api/dashboard", undefined, { signal }),
    opt("/api/human-queue", { items: [], counts: { total: 0 } }),
    opt("/api/board", null),
    opt("/api/cost", null),
    opt("/api/health", null),
    opt("/api/settings", null),
    opt("/claims", { claims: [] }),
    opt("/agents", { agents: [] }),
    opt("/api/runs?active=1", { active: [] }),
    opt("/api/activity?limit=200", { events: [] }),
    opt("/decisions", { decisions: [] }),
    opt("/scope/nodes", { nodes: [] }),
  ]);
  const summary = dash.summary || {};
  const claims = (claimsRes && claimsRes.claims) || [];
  const agents = (agentsRes && agentsRes.agents) || [];
  learnAgents(agents);
  learnAgents(claims);

  // Tickets: the board's cards carry the repo and the claim; the board covers
  // every status (lanes + closed + won't do).
  let tickets = [];
  if (board) {
    for (const c of board.columns || []) tickets.push(...(c.cards || []));
    tickets.push(...(board.closed || []), ...(board.wontDo || []));
  } else {
    tickets = ((await opt("/tickets", { tickets: [] })).tickets || []).map((t) => ({
      ...t,
      repos: [],
    }));
  }
  const seen = new Set();
  tickets = tickets.filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
  const byId = new Map(tickets.map((t) => [t.id, t]));

  // Details for the live tickets and the most recent closed ones (capped).
  const ranked = tickets
    .filter((t) => t.status !== "cancelled")
    .sort(
      (a, b) =>
        TERMINAL.has(a.status) - TERMINAL.has(b.status) ||
        String(b.updated_at).localeCompare(String(a.updated_at)),
    );
  const detailCapped = ranked.length > OVERVIEW_DETAIL_CAP;
  const details = await ticketDetails(ranked.slice(0, OVERVIEW_DETAIL_CAP), signal);
  const runByTicket = await activeRunDetails((runsRes && runsRes.active) || [], signal);

  const repoOf = new Map();
  for (const t of tickets) {
    const d = details.get(t.id);
    const write = d?.repositories?.find((r) => r.access === "write") || d?.repositories?.[0];
    const name = write?.name || t.repos?.[0]?.name || null;
    if (name) repoOf.set(t.id, name);
  }
  learnKits([...repoOf.values()].sort());

  const setting = (k) => {
    const s = (settings?.settings || []).find((x) => x.key === k);
    const v = s ? Number(s.effective ?? s.value) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  // Epics: membership from each ticket's scopes; phases from in-epic dependencies.
  const epicNodes = ((nodes && nodes.nodes) || []).filter((n) => n.type === "epic");
  const epics = epicNodes.map((n) => ({ node: n, members: [] }));
  const epicById = new Map(epics.map((e) => [e.node.id, e]));
  const epicOf = new Map();
  for (const t of tickets) {
    for (const s of details.get(t.id)?.scopes || []) {
      const e = epicById.get(s.id);
      if (e) {
        e.members.push(t);
        if (!epicOf.has(t.id)) epicOf.set(t.id, e.node.name);
      }
    }
  }
  const factoryNode = ((nodes && nodes.nodes) || []).find((n) => n.type === "factory");

  const claimByTicket = new Map(claims.map((c) => [c.ticket_id, c]));
  for (const t of tickets) {
    if (!claimByTicket.has(t.id) && t.claim && !t.claim.stale) {
      claimByTicket.set(t.id, {
        ticket_id: t.id,
        ticket_number: t.number,
        agent_id: t.claim.agentId,
        agent_display_name: t.claim.agentDisplayName,
      });
    }
  }

  return {
    now: Date.now(),
    summary,
    queue,
    items: (queue && queue.items) || [],
    tickets,
    byId,
    byNo: new Map(tickets.filter((t) => t.number != null).map((t) => [t.number, t])),
    details,
    detailCapped,
    repoOf,
    epics: epics.filter((e) => e.members.length),
    epicOf,
    claims,
    claimByTicket,
    agents,
    runByTicket,
    cost,
    health,
    budget: setting("GAFFER_DAILY_BUDGET_USD"),
    slots: setting("GAFFER_CONCURRENCY"),
    autoMerge: (settings?.settings || []).find((x) => x.key === "AUTO_MERGE")?.effective,
    decisions: (decs && decs.decisions) || [],
    events: (activity && activity.events) || [],
    clubName: summary.club?.name || summary.clubName || factoryNode?.name || null,
  };
}

/** The ticket a team-sheet row is about (with its current status), if any. */
function rowTicket(f, it) {
  return it.ticket ? f.byId.get(it.ticket.id) || it.ticket : null;
}
/** Did a parked ticket stop on a failing test? (the rework trail or the reason says so) */
function parkedOnTest(f, t, reason) {
  const trail = (t && f.details.get(t.id)?.rework_trail) || [];
  if (trail.length) return trail[trail.length - 1].gate === "tests";
  return /\btests?\b/i.test(reason || "");
}

/**
 * The scoreboard's headline: one specific sentence from the queue, every clause a
 * link to its object. "5 things need you. ■ Epic “Repeat orders” is blocked at #6
 * by a failing test." When nothing does, it says what the squad is doing instead.
 */
function matchHeadline(f) {
  const items = f.items;
  const kind = (k) => items.filter((i) => i.kind === k);
  const parked = kind("parked");
  const reviews = kind("review");
  const decisions = kind("decision");
  const merges = kind("awaiting_merge");
  const others = items.filter(
    (i) => !["parked", "review", "decision", "awaiting_merge"].includes(i.kind),
  );
  const onPitch = f.summary.activeClaims ?? f.claims.length;
  const slots = f.slots;
  const today = f.cost && typeof f.cost.today_usd === "number" ? f.cost.today_usd : null;
  const wage =
    today == null
      ? null
      : f.budget
        ? `${money(today)} of ${moneyW(f.budget)} wage bill today`
        : `${money(today)} wage bill today`;
  const squadLine = slots
    ? `${onPitch} of ${slots} agents on the pitch`
    : `${plural(onPitch, "agent")} on the pitch`;
  const sub = [];
  let lead;
  if (items.length) {
    lead = [
      el(
        "span",
        { class: "hl-count" },
        `${plural(items.length, "thing")} ${items.length === 1 ? "needs" : "need"} you.`,
      ),
    ];
    for (const p of parked.slice(0, 2)) {
      const t = rowTicket(f, p);
      const epic = t && f.epicOf.get(t.id);
      const test = parkedOnTest(f, t, p.reason);
      const ref = t && t.number != null ? `#${t.number}` : "a ticket";
      lead.push(
        " ",
        el("a", { class: "hl-block", href: t ? `#/ticket/${t.id}` : "#what-i-own" }, [
          el("span", { class: "hl-nb" }, [glyph("blocked", 34), epic ? "Epic" : ref]),
          " ",
          epic
            ? [el("q", {}, epic), ` is blocked at ${ref}`]
            : t && t.status === "blocked"
              ? "is blocked"
              : "is parked",
          test ? " by a failing test." : ".",
        ]),
      );
    }
    if (reviews.length) {
      const first = rowTicket(f, reviews[0]);
      sub.push(
        el(
          "a",
          { href: first ? `#/review/${first.id}` : "#/review" },
          `${plural(reviews.length, "diff")} ${reviews.length === 1 ? "awaits" : "await"} review`,
        ),
      );
    }
    if (decisions.length)
      sub.push(el("a", { href: "#what-i-own" }, plural(decisions.length, "decision")));
    for (const m of merges.slice(0, 2)) {
      const t = rowTicket(f, m);
      if (t) sub.push(el("a", { href: `#/ticket/${t.id}` }, `#${t.number} approved, not merged`));
    }
    if (merges.length > 2) sub.push(`${merges.length - 2} more approved, not merged`);
    if (others.length)
      sub.push(el("a", { href: "#what-i-own" }, plural(others.length, "other call")));
    sub.push(squadLine);
  } else {
    lead = [el("span", { class: "hl-count" }, "Nothing needs you.")];
    const on = f.claims
      .map((c) => c.ticket_number)
      .filter((n) => n != null)
      .sort((a, b) => a - b)
      .map((n) => "#" + n);
    const free = slots ? Math.max(0, slots - onPitch) : null;
    sub.push(
      `${squadLine}${on.length ? `, on ${on.join(on.length === 2 ? " and " : ", ")}` : ""}` +
        (free != null ? `; ${plural(free, "slot")} free` : ""),
    );
  }
  if (f.summary.staleClaims > 0)
    sub.push(
      el("a", { href: "#/work" }, `${plural(f.summary.staleClaims, "stale claim")} (no heartbeat)`),
    );
  if (wage) sub.push(wage);
  return { lead, sub };
}

/**
 * The stadium scoreboard: the headline sentence plus four counters (need you ·
 * on the pitch against the slots · delivered today · the wage bill against the
 * daily budget). Full-bleed and always dark; the digits flip once on arrival.
 */
function overviewScoreboard(f) {
  const { lead, sub } = matchHeadline(f);
  const total = f.items.length;
  const onPitch = f.summary.activeClaims ?? f.claims.length;
  const today = f.cost && typeof f.cost.today_usd === "number" ? f.cost.today_usd : null;
  const subP = el("p", { class: "hl-sub" });
  sub.forEach((c, i) => {
    if (i) subP.appendChild(el("span", { class: "sep", "aria-hidden": "true" }, " · "));
    subP.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  const chain = f.health?.event_log;
  const logStatus =
    chain?.chain_ok === false
      ? `Ledger: event log ALTERED at seq ${chain.broken_at_seq} — see Health`
      : chain?.chain_ok === true
        ? `Ledger: event log intact (${chain.events} events)`
        : null;
  const nowIso = new Date(f.now).toISOString();
  return el("section", { class: "scoreboard bleed", "aria-label": "Scoreboard" }, [
    el("div", { class: "scoreboard-in" }, [
      el("div", { class: "sb-main" }, [
        el("h1", { class: "hl" }, lead),
        subP,
        logStatus
          ? el("p", { class: `view-hero-status${chain?.chain_ok !== false ? " ok" : ""}` }, [
              chain?.chain_ok !== false ? glyph("done", 14) : glyph("failed", 14),
              el("span", {}, logStatus),
            ])
          : null,
      ]),
      el("div", { class: "sb-cells kpi-row", role: "group", "aria-label": "Today" }, [
        statCell({
          label: "Need you",
          value: String(total).padStart(2, "0"),
          needs: total > 0,
          href: "#what-i-own",
          flip: "needs",
          title: `${total} waiting for you`,
        }),
        statCell({
          label: "On the pitch",
          value: f.slots ? `${onPitch}/${f.slots}` : String(onPitch),
          href: "#tactics",
          flip: "pitch",
          title: f.slots
            ? `${onPitch} of ${f.slots} agent slots working`
            : `${onPitch} agents working`,
        }),
        statCell({
          label: "Delivered today",
          value: String(f.summary.deliveredToday ?? 0).padStart(2, "0"),
          href: "#/work?status=done",
          flip: "delivered",
        }),
        statCell({
          label: "Wage bill",
          value: today == null ? "—" : money(today),
          flip: "wage",
          title: "API-equivalent spend today, from the usage ledger",
          after:
            today != null && f.budget
              ? el("div", { class: "sc-band" }, [
                  band(
                    today,
                    f.budget,
                    `${money(today)} of the ${moneyW(f.budget)} daily budget (${Math.round((today / f.budget) * 100)}%)`,
                  ),
                  el("span", { class: "kpi-sub" }, `of ${moneyW(f.budget)} today`),
                ])
              : el("span", { class: "kpi-sub" }, "today, API-equivalent"),
        }),
      ]),
      el(
        "time",
        { class: "sb-clock", datetime: nowIso },
        `${fmtDay(nowIso)} · ${clockTime(f.now)}`,
      ),
    ]),
  ]);
}

// --- The Team Sheet: what needs you, ranked, each with one real action -------

/** The verb on each row. Every one is a real button or link (never a decoration). */
const OWN_VERB = {
  review: "Review",
  decision: "Answer…",
  parked: "Unblock…",
  awaiting_merge: "Merge…",
  ready_approval: "Approve…",
  reviewer_assignment: "Assign…",
  dependency_cancelled: "Re-plan…",
};
/** The word each kind of row leads with (the referee's call, not the queue's jargon). */
const OWN_WORD = {
  parked: "Blocked",
  decision: "Decision",
  review: "Review sign-off",
  awaiting_merge: "Approved, not merged",
};
const OWN_GLYPH = {
  review: "in_review",
  decision: "decision",
  parked: "blocked",
  awaiting_merge: "ready_for_merge",
  ready_approval: "ready",
  dependency_cancelled: "cancelled",
};

function whatIOwnPanel(queue, f) {
  const items = (queue && queue.items) || [];
  const total = (queue && queue.counts && queue.counts.total) || items.length;
  const card = el(
    "section",
    { class: "card what-i-own", id: "what-i-own", "aria-label": "Team sheet" },
    [
      panelHead("Team sheet", items.length ? `needs you · ${total}` : null, null, {
        kit: "claret",
      }),
    ],
  );
  if (!items.length) {
    card.appendChild(
      el(
        "div",
        { class: "empty-state" },
        "Nothing is waiting on you right now. Every ticket in play is with an agent or the queue.",
      ),
    );
    return card;
  }
  const well = el("ol", { class: "own-well" });
  items.forEach((it, i) => well.appendChild(el("li", {}, renderOwnedItem(it, i, f))));
  card.appendChild(well);
  return card;
}

/** The one action a row offers: a real button (a sheet that acts) or a real link. */
function ownAction(it, primary, f) {
  const t = it.ticket;
  const cls = `btn own-act${primary ? " primary" : ""}`;
  const verb = OWN_VERB[it.kind] || "Open";
  const ref = t && t.number != null ? ` #${t.number}` : "";
  const label = `${verb.replace("…", "")}${ref}`;
  switch (it.kind) {
    case "parked":
      return t
        ? el(
            "button",
            { class: cls, type: "button", "aria-label": label, onclick: () => unblockSheet(t, it) },
            verb,
          )
        : null;
    case "decision":
      return it.decisionId
        ? el(
            "button",
            {
              class: cls,
              type: "button",
              "aria-label": `Answer: ${decisionTitle(it, f)}`,
              onclick: () => answerSheet(it, f),
            },
            verb,
          )
        : null;
    case "awaiting_merge":
      return t
        ? el(
            "button",
            { class: cls, type: "button", "aria-label": label, onclick: () => mergeSheet(t) },
            verb,
          )
        : null;
    case "ready_approval":
      return t
        ? el(
            "button",
            {
              class: cls,
              type: "button",
              "aria-label": label,
              onclick: () => readyApprovalSheet(t, it),
            },
            verb,
          )
        : null;
    case "review":
      return t
        ? el("a", { class: cls, href: `#/review/${t.id}`, "aria-label": label }, verb)
        : null;
    default:
      return t
        ? el("a", { class: cls, href: `#/ticket/${t.id}`, "aria-label": label }, verb)
        : null;
  }
}
/** A decision's question: its title from /decisions (the reason is the detail). */
function decisionTitle(it, f) {
  const d = f && f.decisions.find((x) => x.id === it.decisionId);
  return (d && d.title) || it.title || it.reason || "Decision";
}

/** One team-sheet row: rank · card · kind · #ref, the title (a link), the reason, the wait, the action. */
function renderOwnedItem(it, i = 0, f = null) {
  const t = it.ticket;
  const ref = t ? (t.number != null ? `#${t.number}` : t.id.slice(0, 8)) : null;
  const href = t ? (it.kind === "review" ? `#/review/${t.id}` : `#/ticket/${t.id}`) : null;
  const title = t && t.title ? t.title : it.kind === "decision" ? decisionTitle(it, f) : null;
  const reason = it.reason || "(no reason given)";
  return el("div", { class: `own-row own-row--${it.kind}`, dataset: { kind: it.kind } }, [
    el("span", { class: "own-rank", "aria-hidden": "true" }, String(i + 1)),
    el("div", { class: "own-body" }, [
      el("p", { class: "own-head" }, [
        el("span", { class: `own-kind own-kind--${it.kind}` }, [
          ycard(16, "ycard-row"),
          OWN_GLYPH[it.kind] ? glyph(OWN_GLYPH[it.kind], 16) : null,
          OWN_WORD[it.kind] || it.label,
        ]),
        ref ? el("span", { class: "own-ref" }, ref) : null,
      ]),
      title ? el("p", { class: "own-title" }, href ? el("a", { href }, title) : title) : null,
      // A decision's reason IS its question text; the title above is its headline.
      el("p", { class: "own-reason" }, reason),
      el("p", { class: "own-meta" }, [
        el(
          "span",
          { class: "own-age tabnum", title: `Waiting since ${fmtTime(it.since)}` },
          `waited ${fmtDuration(it.waitedMs)}`,
        ),
        it.reasonCode != null ? el("span", { class: "own-code" }, it.reasonCode) : null,
        it.suggestedAction ? el("span", { class: "own-action" }, `→ ${it.suggestedAction}`) : null,
      ]),
    ]),
    el("div", { class: "own-cta" }, ownAction(it, i === 0, f)),
  ]);
}

/** A bottom sheet / side panel with a short intro, a form and its actions. */
function actionSheet(title, { intro, body, actions }) {
  openSheet(
    title,
    el("div", { class: "act-sheet" }, [
      intro ? el("p", { class: "act-intro" }, intro) : null,
      body || null,
      el("div", { class: "btn-row act-actions" }, actions),
    ]),
  );
}

/** Unblock: move a blocked ticket back to Ready (another go) or Refining (rewrite first). */
function unblockSheet(t, it = {}) {
  const ref = t.number != null ? `#${t.number}` : "this ticket";
  const opt = (value, word, rest, checked) =>
    el("label", {}, [
      el("input", { type: "radio", name: "unblock-to", value, checked: checked ? "" : null }),
      el("span", {}, [el("b", {}, word), ` ${rest}`]),
    ]);
  const choice = el("fieldset", { class: "choice" }, [
    el("legend", {}, `Move ${ref} to`),
    opt(
      "ready",
      "Ready",
      "— an agent claims it and delivers again, with a fresh set of attempts.",
      true,
    ),
    opt(
      "refining",
      "Refining",
      "— it comes back to you to rewrite the ticket or its criteria first.",
    ),
  ]);
  const go = el(
    "button",
    {
      class: "btn primary",
      type: "button",
      onclick: () =>
        guard(async () => {
          const to = choice.querySelector("input:checked")?.value || "ready";
          await api("POST", `/tickets/${t.id}/move`, { to });
          closeSheet();
          toast(`Unblocked ${ref}: it is ${statusLabel(to)} now.`, { ok: true });
          router();
        }),
    },
    "Unblock",
  );
  actionSheet(`Unblock ${ref}`, {
    intro: [it.reason ? `Parked: ${it.reason}` : "This ticket is blocked."].join(" "),
    body: el("div", {}, [
      choice,
      el("p", { class: "act-hint" }, [
        "To brief the next attempt, add or sharpen an acceptance criterion on ",
        el("a", { href: `#/ticket/${t.id}`, onclick: closeSheet }, `the ticket page`),
        " first.",
      ]),
    ]),
    actions: [go, el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel")],
  });
}

/** Answer a decision the agents are waiting on (resolves it as accepted, with your answer). */
function answerSheet(it, f) {
  const d = (f && f.decisions.find((x) => x.id === it.decisionId)) || {};
  const answer = el("textarea", { rows: 4, name: "answer", required: "" });
  const rationale = el("input", { type: "text", name: "rationale" });
  const resolve = (status) =>
    guard(async () => {
      if (status === "accepted" && !answer.value.trim()) {
        answer.setAttribute("aria-invalid", "true");
        answer.focus();
        toast("Write an answer first.");
        return;
      }
      const body = { status };
      if (answer.value.trim()) body.answer = answer.value.trim();
      if (rationale.value.trim()) body.rationale = rationale.value.trim();
      await api("POST", `/decisions/${it.decisionId}/resolve`, body);
      closeSheet();
      toast(status === "accepted" ? "Answered. Agents read it next time." : "Question rejected.", {
        ok: true,
      });
      router();
    });
  actionSheet(d.title || "Answer the decision", {
    intro: d.question || it.reason,
    body: el("div", { class: "stack" }, [
      field("Your answer", answer),
      field("Why (optional)", rationale),
    ]),
    actions: [
      el(
        "button",
        { class: "btn primary", type: "button", onclick: () => resolve("accepted") },
        "Answer",
      ),
      el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel"),
      el(
        "button",
        { class: "btn danger", type: "button", onclick: () => resolve("rejected") },
        "Reject the question",
      ),
    ],
  });
}

/** Merge an approved branch (the merge runner), or record that you merged it by hand. */
function mergeSheet(t) {
  const ref = t.number != null ? `#${t.number}` : "this ticket";
  actionSheet(`Merge ${ref}`, {
    intro:
      "It is approved, but its delivery branch has not merged. Merge runs the merge runner on the branch; the board updates when it lands.",
    actions: [
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/merge`);
              closeSheet();
              toast(`Merge started for ${ref}.`, { ok: true });
              router();
            }),
        },
        "Merge",
      ),
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/mark-merged`);
              closeSheet();
              toast(`${ref} marked merged.`, { ok: true });
              router();
            }),
        },
        "I merged it by hand",
      ),
      el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel"),
    ],
  });
}

/** Regulated tickets: the ready-approval a human must give before the queue takes it. */
function readyApprovalSheet(t, it) {
  const ref = t.number != null ? `#${t.number}` : "this ticket";
  actionSheet(`Approve ${ref} for the queue`, {
    intro: it.reason,
    actions: [
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/ready-approval`);
              closeSheet();
              toast(`${ref} approved for the queue.`, { ok: true });
              router();
            }),
        },
        "Approve",
      ),
      el("a", { class: "btn", href: `#/ticket/${t.id}`, onclick: closeSheet }, "Open the ticket"),
    ],
  });
}

// --- The Tactics Board -------------------------------------------------------

/** Which repos get a channel: those with tickets in play or done, most busy first. */
function pitchChannels(f) {
  const score = new Map();
  for (const t of f.tickets) {
    const r = f.repoOf.get(t.id);
    if (!r) continue;
    if (ON_PITCH.has(t.status)) score.set(r, (score.get(r) || 0) + 10);
    else if (t.status === "done") score.set(r, (score.get(r) || 0) + 1);
  }
  const all = [...score.keys()].sort((a, b) => score.get(b) - score.get(a) || a.localeCompare(b));
  if (all.length <= PITCH_MAX_CHANNELS) return { channels: all.sort(), other: null };
  const keep = all.slice(0, PITCH_MAX_CHANNELS - 1).sort();
  return { channels: [...keep, "Other repos"], other: new Set(all.slice(PITCH_MAX_CHANNELS - 1)) };
}

/** The window the chalk arrows cover: the last 3 hours, or the 3 before the last move. */
function arrowWindow(f) {
  let last = 0;
  for (const e of f.events) {
    if (e.event_type === "ticket.transitioned")
      last = Math.max(last, Date.parse(e.created_at) || 0);
  }
  const recent = last && f.now - last < ARROW_WINDOW_MS;
  const end = recent || !last ? f.now : last;
  return { start: end - ARROW_WINDOW_MS, end, recent: recent || !last };
}

/**
 * The tactics board drawing (ported from the approved comp's layout engine).
 * x is the lifecycle stage, y the repo channel. Every label keeps a pixel floor
 * at the size it is seen (k = viewBox units per CSS px); tags and arrows are laid
 * out at those sizes, so nothing collides.
 */
const PITCH_VW = { landscape: 14 + 1050 + 104, portrait: 14 + 680 + 14 };
function pitchBoard(f, orientation, k = orientation === "portrait" ? 2 : 1.26) {
  const P = orientation === "portrait";
  const { channels, other } = pitchChannels(f);
  const chanOf = (t) => {
    const r = f.repoOf.get(t.id);
    if (!r) return null;
    if (other && other.has(r)) return "Other repos";
    return channels.includes(r) ? r : null;
  };
  const NC = Math.max(1, channels.length);
  const L = 1050,
    W = 680,
    CH = W / NC;
  const fz = (design, floor = 12.5) => Math.max(design, floor * k);
  // Portrait leaves room under the kits for each channel's repo name (2 lines).
  const M = P
    ? { l: 14, t: 124, r: 14, b: 70 + Math.ceil(2 * fz(17) * 1.15) + 6 }
    : { l: 14, t: 58, r: 104, b: 14 };
  const VW = P ? M.l + W + M.r : M.l + L + M.r,
    VH = P ? M.t + L + M.b : M.t + W + M.b;
  const T = (px, py) => (P ? [M.l + py, M.t + (L - px)] : [M.l + px, M.t + py]);
  const R = P ? 25 : 19,
    SH = P ? 56 : 46;
  const pxs = (n) => ({ fontSize: n.toFixed(2) + "px" });
  const FS = {
    zl: fz(P ? 24 : 18, 12.5),
    cl: fz(17, 12.5),
    disc: fz(P ? 28 : 22, 14),
    tally: fz(P ? 28 : 22, 14),
    tag: fz(P ? 26 : 16, 13),
    shirt: fz(P ? 22 : 17, 12.5),
  };
  const rect = (x0, y0, x1, y1, a) => {
    const [ax, ay] = T(x0, y0),
      [bx, by] = T(x1, y1);
    return svgS("rect", {
      x: Math.min(ax, bx),
      y: Math.min(ay, by),
      width: Math.abs(bx - ax),
      height: Math.abs(by - ay),
      ...a,
    });
  };
  const line = (x0, y0, x1, y1, a) => {
    const [ax, ay] = T(x0, y0),
      [bx, by] = T(x1, y1);
    return svgS("line", { x1: ax, y1: ay, x2: bx, y2: by, ...a });
  };
  const arc = (cx, cy, r, a0, a1, a) => {
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const t = a0 + ((a1 - a0) * i) / 40;
      pts.push(T(cx + r * Math.cos(t), cy + r * Math.sin(t)).join(","));
    }
    return svgS("polyline", { points: pts.join(" "), fill: "none", ...a });
  };
  const obs = [];
  const box = (x0, y0, x1, y1, why) => {
    const b = { x0, y0, x1, y1, why };
    obs.push(b);
    return b;
  };
  const tid = `pitch-t-${orientation}-${++svgUid}`;
  const svg = svgS(
    "svg",
    {
      viewBox: `0 0 ${VW} ${VH}`,
      class: `pitch pitch-${orientation}`,
      role: "group",
      "aria-labelledby": tid,
    },
    svgS(
      "title",
      { id: tid },
      "Tactics board: every ticket in play, placed by stage (towards goal) and repo (channel). Agents are the shirts.",
    ),
  );
  const turf = svgS("g", { class: "turf" });
  PITCH_ZONES.forEach((z, i) =>
    turf.append(rect(z.x0, 0, z.x1, W, { class: i % 2 ? "mow-b" : "mow-a" })),
  );
  svg.append(turf);
  const chalk = svgS("g", { class: "chalk" });
  chalk.append(
    rect(0, 0, L, W, { fill: "none" }),
    line(525, 0, 525, W),
    arc(525, 340, 91.5, 0, Math.PI * 2),
    rect(0, 138.4, 165, 541.6, { fill: "none" }),
    rect(885, 138.4, 1050, 541.6, { fill: "none" }),
    rect(0, 248.4, 55, 431.6, { fill: "none" }),
    rect(995, 248.4, 1050, 431.6, { fill: "none" }),
    arc(110, 340, 91.5, -0.93, 0.93),
    arc(940, 340, 91.5, Math.PI - 0.93, Math.PI + 0.93),
  );
  for (const cx of [110, 525, 940]) {
    const [x, y] = T(cx, 340);
    chalk.append(svgS("circle", { cx: x, cy: y, r: 3.5, class: "spot" }));
  }
  chalk.append(rect(1050, 303.4, 1078, 376.6, { class: "goal" }));
  for (let j = 0; j < 6; j++)
    chalk.append(line(1050 + j * 5, 303.4, 1050 + j * 5, 376.6, { class: "net" }));
  svg.append(chalk);
  const guides = svgS("g", { class: "guides" });
  for (let c = 1; c < NC; c++) guides.append(line(0, c * CH, L, c * CH, { class: "lane-guide" }));
  svg.append(guides);

  const labels = svgS("g", { class: "zone-labels", "aria-hidden": "true" });
  for (const z of PITCH_ZONES) {
    const mid = (z.x0 + z.x1) / 2,
      w = textWidth(z.label, FS.zl, 0.1);
    if (P) {
      const [x, y] = T(z.x1, 0);
      labels.append(
        svgS(
          "text",
          {
            x: x + 8,
            y: y + 8 + FS.zl,
            class: `zl ${PITCH_ZONES.indexOf(z) % 2 ? "halo-b" : "halo-a"}`,
            style: pxs(FS.zl),
          },
          z.label,
        ),
      );
      box(x + 4, y + 4, x + 12 + w, y + 14 + FS.zl, "zl");
    } else {
      const [x, y] = T(mid, 0);
      labels.append(
        svgS(
          "text",
          { x, y: y - 16, "text-anchor": "middle", class: "zl", style: pxs(FS.zl) },
          z.label,
        ),
      );
    }
  }
  {
    const [gx, gy] = P ? T(L, W / 2) : T(L, 0);
    const cx = P ? gx : gx + 52,
      by = P ? 8 : gy - 46,
      h = FS.zl + 14,
      w = textWidth("DONE", FS.zl, 0.08) + 22;
    labels.append(
      svgS("rect", { x: cx - w / 2, y: by, width: w, height: h, rx: 3, class: "zl-plaque" }),
      svgS(
        "text",
        {
          x: cx,
          y: by + h / 2 + FS.zl * 0.36,
          "text-anchor": "middle",
          class: "zl zl-goal",
          style: pxs(FS.zl),
        },
        "Done",
      ),
    );
    box(cx - w / 2, by, cx + w / 2, by + h, "done");
  }
  const kits = svgS("g", { class: "channel-kits", "aria-hidden": "true" });
  channels.forEach((r, c) => {
    const ks = P ? 40 : 30,
      kt = kitShirt(r, ks);
    const [x, y] = P ? T(0, (c + 0.5) * CH) : T(8, c * CH + 8);
    const kx = P ? x - 20 : x,
      ky = P ? y + 14 : y;
    kt.setAttribute("x", kx);
    kt.setAttribute("y", ky);
    kt.classList.add("kit-chalk");
    kits.append(kt);
    box(kx, ky, kx + ks, ky + ks, "kit");
    if (P) {
      // A phone has no room beside the kit: the name sits under it, wrapped.
      const lines = wrapLabel(r, FS.cl, CH - 10, 2);
      lines.forEach((ln, i) =>
        kits.append(
          svgS(
            "text",
            {
              x,
              y: ky + ks + 6 + FS.cl * (0.9 + i * 1.15),
              "text-anchor": "middle",
              class: "cl cl-p",
              style: pxs(FS.cl),
            },
            ln,
          ),
        ),
      );
    } else {
      kits.append(
        svgS(
          "text",
          { x: x + 36, y: y + 15 + FS.cl * 0.4, class: "cl halo-a", style: pxs(FS.cl) },
          r,
        ),
      );
      box(x + 34, y + 2, x + 38 + textWidth(r, FS.cl), y + 22 + FS.cl * 0.4, "cl");
    }
  });

  const cells = new Map();
  const inPlay = f.tickets.filter((t) => ON_PITCH.has(t.status) && chanOf(t));
  for (const t of inPlay.sort((a, b) => (a.number || 0) - (b.number || 0))) {
    const key = t.status + "|" + chanOf(t);
    (cells.get(key) || cells.set(key, []).get(key)).push(t);
  }
  const claimOf = (t) => f.claimByTicket.get(t.id);
  const pos = new Map();
  for (const [key, list] of cells) {
    const [st, repo] = key.split("|");
    const z = PITCH_ZONES.find((x) => x.key === st),
      c = channels.indexOf(repo);
    const withAgent = list.some((t) => claimOf(t));
    // A crowded cell packs tighter, then wraps into a second row.
    const zoneW = z.x1 - z.x0;
    const step0 = withAgent ? SH + (P ? 30 : 24) : 2.2 * R + (P ? 4 : 10);
    const perRow = Math.max(1, Math.floor((P ? CH : zoneW) / step0));
    const rows = Math.ceil(list.length / perRow);
    list.forEach((t, i) => {
      const row = Math.floor(i / perRow),
        col = i % perRow;
      const inRow = Math.min(perRow, list.length - row * perRow);
      let qx = (z.x0 + z.x1) / 2,
        qy = (c + 0.5) * CH;
      const off = (col - (inRow - 1) / 2) * step0;
      const roff = (row - (rows - 1) / 2) * (P ? 2.4 * R : Math.min(CH / rows, 2.4 * R));
      if (P) {
        qy += off;
        qx += roff;
      } else {
        qx += off;
        qy += roff;
      }
      if (claimOf(t) && !P) qy += 14;
      if (claimOf(t) && P) qx -= 30;
      pos.set(t.id, [qx, qy]);
    });
  }
  const zoneCentre = (st, repo) => {
    const z = PITCH_ZONES.find((x) => x.key === st);
    return z ? [(z.x0 + z.x1) / 2, (channels.indexOf(repo) + 0.5) * CH] : null;
  };
  const needs = new Set(f.items.map((i) => i.ticket?.id).filter(Boolean));
  const win = arrowWindow(f);
  const shirtTop = (y) => y - R - SH * 0.925 + (P ? 11 : 9);
  const geo = new Map();
  for (const t of inPlay) {
    const [x, y] = T(...pos.get(t.id));
    const g = { x, y, circles: [{ x, y, r: R + 6 }] };
    box(x - R, y - R, x + R, y + R + 3, "disc");
    if (claimOf(t)) {
      const top = shirtTop(y);
      g.shirt = { top };
      g.circles.push({ x, y: top + SH * 0.52, r: SH * 0.5 + 8 });
      box(x - SH / 2, top + SH * 0.08, x + SH / 2, y, "shirt");
    }
    geo.set(t.id, g);
  }

  const net = svgS("g", { class: "net-tally" });
  const ballAt = new Map();
  channels.forEach((r, c) => {
    const done = f.tickets
      .filter((t) => t.status === "done" && chanOf(t) === r)
      .map((t) => t.number)
      .sort((a, b) => a - b);
    const [x, y] = T(L, (c + 0.5) * CH);
    const gx = P ? x : x + 52,
      gy = P ? M.t - 64 : y - 10,
      br = P ? 15 : 12;
    const g = svgS(
      "g",
      { transform: `translate(${gx} ${gy})`, class: "tally" },
      svgS(
        "title",
        {},
        `${r}: ${done.length} done${done.length ? ` (${done.map((n) => "#" + n).join(", ")})` : ""}`,
      ),
    );
    g.append(pitchBall(br));
    const nw = textWidth(String(done.length), FS.tally);
    if (P)
      g.append(
        svgS(
          "text",
          { x: br + 6, y: FS.tally * 0.36, class: "tally-n", style: pxs(FS.tally) },
          String(done.length),
        ),
      );
    else
      g.append(
        svgS(
          "text",
          {
            x: 0,
            y: br + 6 + FS.tally * 0.75,
            "text-anchor": "middle",
            class: "tally-n",
            style: pxs(FS.tally),
          },
          String(done.length),
        ),
      );
    net.append(g);
    ballAt.set(r, {
      x: gx,
      y: gy,
      r: br,
      extra: P ? [{ x: gx + br + 6 + nw / 2, y: gy, r: Math.max(nw, FS.tally) / 2 + 8 }] : [],
    });
    if (P) box(gx - br - 2, gy - br - 2, gx + br + 10 + nw, gy + br + 2, "ball");
    else box(gx - br - 2, gy - br - 2, gx + br + 2, gy + br + 8 + FS.tally * 0.8, "ball");
  });
  svg.append(net);

  const arrows = svgS("g", { class: "arrows" });
  const mid = `ah-${orientation}-${svgUid}`;
  svg.prepend(
    svgS(
      "defs",
      {},
      svgS(
        "marker",
        {
          id: mid,
          viewBox: "0 0 10 10",
          refX: 6,
          refY: 5,
          markerWidth: 4.5,
          markerHeight: 4.5,
          orient: "auto-start-reverse",
        },
        svgS("path", {
          d: "M0 1 L8 5 L0 9",
          fill: "none",
          stroke: "var(--chalk)",
          "stroke-width": 2,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }),
      ),
    ),
  );
  const allCircles = [...geo.values()].flatMap((g) => g.circles);
  const quad = (a, b, c, t) => [
    (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * b[0] + t * t * c[0],
    (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * b[1] + t * t * c[1],
  ];
  const blossom = (a, b, c, u, v) =>
    [0, 1].map((i) => (1 - u) * (1 - v) * a[i] + ((1 - u) * v + u * (1 - v)) * b[i] + u * v * c[i]);
  const inAny = (p, cs) => cs.some((c) => Math.hypot(p[0] - c.x, p[1] - c.y) < c.r);
  const labelBoxes = obs.filter((o) => ["zl", "cl", "kit", "done"].includes(o.why));
  const plans = [];
  for (const t of f.tickets) {
    const evs = (f.details.get(t.id)?.events || []).filter((e) => {
      if (e.event_type !== "ticket.transitioned") return false;
      const at = Date.parse(e.created_at);
      return at > win.start && at <= win.end;
    });
    if (!evs.length) continue;
    let first;
    try {
      first = JSON.parse(evs[0].payload_json || "{}");
    } catch {
      continue;
    }
    const repo = chanOf(t);
    if (!repo) continue;
    const from = zoneCentre(first.from, repo);
    const done = t.status === "done";
    if (!from || (!done && !geo.has(t.id)) || (done && !ballAt.has(repo))) continue;
    const a = T(...from);
    const tgt = done ? ballAt.get(repo) : geo.get(t.id);
    const b = [tgt.x, tgt.y];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 30) continue;
    plans.push({
      t,
      first,
      evs,
      a,
      b,
      key: done ? "net|" + repo : "t" + t.id,
      endCs: done ? [{ x: tgt.x, y: tgt.y, r: tgt.r + 9 }, ...tgt.extra] : tgt.circles,
    });
  }
  const byKey = new Map();
  for (const p of plans) (byKey.get(p.key) || byKey.set(p.key, []).get(p.key)).push(p);
  const moved = [],
    arrowPts = [],
    routed = [];
  const pitchArea = P
    ? { x0: M.l + 4, y0: 20, x1: M.l + W - 4, y1: M.t + L - 4 }
    : { x0: M.l + 4, y0: M.t + 4, x1: M.l + L - 4, y1: M.t + W - 4 };
  const inBoxes = (q, bs, pad = 0) =>
    bs.some(
      (o) => q[0] > o.x0 - pad && q[0] < o.x1 + pad && q[1] > o.y0 - pad && q[1] < o.y1 + pad,
    );
  const routeArrow = (p, i, tagBoxes) => {
    const { a, b } = p;
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      len = Math.hypot(dx, dy);
    const base = Math.min(70, len * 0.2) + i * 26;
    const startCs = allCircles.filter((cc) => Math.hypot(a[0] - cc.x, a[1] - cc.y) < cc.r + 14);
    const others = allCircles.filter((cc) => !startCs.includes(cc) && !p.endCs.includes(cc));
    const ctrl = (bend) => [
      (a[0] + b[0]) / 2 + (-dy / len) * bend,
      (a[1] + b[1]) / 2 + (dx / len) * bend,
    ];
    const sign = P ? 1 : -1;
    let c = ctrl(base * sign),
      bestX = Infinity;
    for (const m of [1, -1, 1.7, -1.7, 0.4, -0.4, 2.4, -2.4, 3.2, -3.2]) {
      const cc = ctrl(base * sign * m);
      let x = Math.abs(m) * 0.5;
      for (let j = 1; j < 48; j++) {
        const q = quad(a, cc, b, j / 48);
        if (inAny(q, others)) x += 3;
        if (inBoxes(q, tagBoxes, 6)) x += 6;
        if (inBoxes(q, labelBoxes)) x += 1;
        if (
          q[1] < pitchArea.y0 ||
          q[1] > pitchArea.y1 ||
          q[0] < pitchArea.x0 ||
          q[0] > pitchArea.x1 + (P ? 0 : 60)
        )
          x += 8;
      }
      if (x < bestX) {
        bestX = x;
        c = cc;
      }
    }
    let t0 = 0,
      t1 = 1;
    while (
      t0 < 0.6 &&
      (inAny(
        quad(a, c, b, t0),
        startCs.map((cc) => ({ ...cc, r: cc.r - 2 })),
      ) ||
        Math.hypot(...quad(a, c, b, t0).map((v, j) => v - a[j])) < 10)
    )
      t0 += 0.004;
    while (t0 < 0.5 && inBoxes(quad(a, c, b, t0), tagBoxes, 6)) t0 += 0.004;
    while (t1 > t0 + 0.1 && inAny(quad(a, c, b, t1), p.endCs)) t1 -= 0.004;
    const s0 = blossom(a, c, b, t0, t0),
      c1 = blossom(a, c, b, t0, t1),
      e1 = blossom(a, c, b, t1, t1);
    return Math.hypot(e1[0] - s0[0], e1[1] - s0[1]) < 26 ? null : { s0, c1, e1 };
  };
  for (const group of byKey.values()) {
    group.sort(
      (p, q) =>
        Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) - Math.hypot(q.b[0] - q.a[0], q.b[1] - q.a[1]),
    );
    group.forEach((p, i) => {
      const r = routeArrow(p, i, []);
      if (!r) return;
      for (let j = 0; j <= 36; j++) arrowPts.push(quad(r.s0, r.c1, r.e1, j / 36));
      routed.push({ p, i });
      moved.push({ id: p.t.id, fromXY: p.a });
    });
  }
  svg.append(arrows, labels, kits);

  const layer = svgS("g", { class: "counters" });
  const agentMoves = [];
  const pitchBox = P
    ? { x0: M.l + 2, y0: M.t + 2, x1: M.l + W - 2, y1: M.t + L - 2 }
    : { x0: M.l + 2, y0: M.t + 2, x1: M.l + L - 2, y1: M.t + W - 2 };
  const hits = (b) => {
    let n = 0;
    for (const o of obs)
      if (b.x0 < o.x1 + 3 && b.x1 > o.x0 - 3 && b.y0 < o.y1 + 3 && b.y1 > o.y0 - 3) n += 60;
    for (const [qx, qy] of arrowPts)
      if (qx > b.x0 - 5 && qx < b.x1 + 5 && qy > b.y0 - 5 && qy < b.y1 + 5) n += 4;
    if (b.x0 < pitchBox.x0 || b.x1 > pitchBox.x1 || b.y0 < pitchBox.y0 || b.y1 > pitchBox.y1)
      n += 400;
    return n;
  };
  for (const t of inPlay) {
    const { x, y, shirt } = geo.get(t.id);
    const claim = claimOf(t);
    const run = f.runByTicket.get(t.number);
    const nm = needs.has(t.id);
    const label = `#${t.number} ${statusLabel(t.status)}${claim ? ", " + claim.agent_display_name + " on it" : ""}${nm ? ", needs you" : ""}: ${t.title}`;
    const a = svgS("a", {
      href: t.status === "in_review" ? `#/review/${t.id}` : `#/ticket/${t.id}`,
      class: `counter${claim ? " has-agent" : ""}${nm ? " needs" : ""}`,
      "aria-label": label,
    });
    a.append(svgS("title", {}, label));
    const disc = [
      svgS("circle", { cx: x, cy: y + 2.5, r: R, class: "disc-shadow" }),
      svgS("circle", { cx: x, cy: y, r: R, class: "disc" }),
      svgS(
        "text",
        { x, y: y + FS.disc * 0.34, "text-anchor": "middle", class: "disc-n", style: pxs(FS.disc) },
        String(t.number),
      ),
    ];
    if (claim) {
      const no = agentNo(claim.agent_display_name);
      const g = svgS("g", { class: "agent-on" });
      g.append(...disc, shirtGroup(no, x - SH / 2, shirt.top, SH / 40, FS.shirt));
      a.append(g);
      const mv = moved.find((m) => m.id === t.id);
      if (mv) agentMoves.push({ g, dx: mv.fromXY[0] - x, dy: mv.fromXY[1] - y });
      const lines = run
        ? run.num_turns
          ? [`${run.num_turns} turns`, money(run.cost_usd)]
          : ["just claimed"]
        : null;
      if (lines) {
        const fs = FS.tag,
          padX = fs * 0.45,
          padY = fs * 0.32,
          lh = fs * 1.12;
        const w = Math.max(...lines.map((l) => textWidth(l, fs, 0.02))) + padX * 2,
          h = lines.length * lh + padY * 2 - fs * 0.12;
        const top = shirt.top + SH * 0.1,
          gap = 6;
        const cands = [
          { x0: x + SH / 2 + gap, y0: y - h / 2 - (P ? 4 : 2) },
          { x0: x + R + gap, y0: y + 4 },
          { x0: x - SH / 2 - gap - w, y0: y - h / 2 },
          { x0: x - w / 2, y0: y + R + gap + 2 },
          { x0: x - R, y0: y + R + gap + 2 },
          { x0: x + R - w, y0: y + R + gap + 2 },
          { x0: x - w / 2, y0: top - gap - h },
          { x0: x + SH / 2 + gap, y0: top - 4 },
          { x0: x - SH / 2 - gap - w, y0: top - 4 },
        ].map((c) => ({ x0: c.x0, y0: c.y0, x1: c.x0 + w, y1: c.y0 + h }));
        let best = cands[0],
          bestHits = Infinity;
        for (const c of cands) {
          const hN = hits(c);
          if (hN < bestHits) {
            best = c;
            bestHits = hN;
          }
          if (!hN) break;
        }
        let lead = null;
        if (bestHits >= 60) {
          let bestScore = bestHits * 1000;
          for (let gy = -5; gy <= 5; gy++)
            for (let gx = -4; gx <= 4; gx++) {
              const c = { x0: x - w / 2 + gx * (w * 0.55), y0: y - h / 2 + gy * (h * 0.7) };
              c.x1 = c.x0 + w;
              c.y1 = c.y0 + h;
              const d = Math.hypot((c.x0 + c.x1) / 2 - x, (c.y0 + c.y1) / 2 - y);
              const sc = hits(c) * 1000 + d;
              if (sc < bestScore) {
                bestScore = sc;
                best = c;
                lead = true;
              }
            }
        }
        box(best.x0, best.y0, best.x1, best.y1, "tag");
        const tg = svgS("g", { class: "agent-tag" });
        if (lead) {
          const above = best.y1 < shirt.top + SH * 0.2;
          const ox = x,
            oy = above ? shirt.top + SH * 0.12 : y;
          const tx = Math.min(Math.max(ox, best.x0), best.x1),
            ty = Math.min(Math.max(oy, best.y0), best.y1);
          const dd = Math.hypot(tx - ox, ty - oy) || 1,
            r0 = above ? 2 : R + 3;
          tg.append(
            svgS("circle", {
              cx: ox + ((tx - ox) / dd) * r0,
              cy: oy + ((ty - oy) / dd) * r0,
              r: 2.5,
              class: "tag-dot",
            }),
            svgS("line", {
              x1: ox + ((tx - ox) / dd) * r0,
              y1: oy + ((ty - oy) / dd) * r0,
              x2: tx,
              y2: ty,
              class: "tag-lead",
            }),
          );
        }
        tg.append(
          svgS("rect", { x: best.x0, y: best.y0, width: w, height: h, rx: 3, class: "tag-plate" }),
        );
        lines.forEach((l, i) =>
          tg.append(
            svgS(
              "text",
              {
                x: best.x0 + padX,
                y: best.y0 + padY + fs * 0.8 + i * lh,
                class: `tag-t${i ? " tag-t2" : ""}`,
                style: pxs(fs),
              },
              l,
            ),
          ),
        );
        a.append(tg);
      }
    } else a.append(...disc);
    if (nm) {
      const cx = claim ? x + SH * 0.42 : x + R * 0.8,
        cy = claim ? shirt.top + SH * 0.18 : y - R;
      a.append(
        svgS("rect", {
          x: cx - R * 0.35,
          y: cy - R * 0.45,
          width: R * 0.72,
          height: R * 0.98,
          rx: 2,
          class: "ycard-on",
          transform: `rotate(10 ${cx} ${cy})`,
        }),
      );
      box(cx - R * 0.4, cy - R * 0.5, cx + R * 0.4, cy + R * 0.55, "ycard");
    }
    layer.append(a);
  }
  const tagBoxes = obs.filter((o) => o.why === "tag");
  for (const { p, i } of routed) {
    const r = routeArrow(p, i, tagBoxes);
    if (!r) continue;
    const f1 = (v) => v.toFixed(1);
    arrows.append(
      svgS("path", {
        d: `M${f1(r.s0[0])} ${f1(r.s0[1])} Q${f1(r.c1[0])} ${f1(r.c1[1])} ${f1(r.e1[0])} ${f1(r.e1[1])}`,
        class: "arrow",
        "marker-end": `url(#${mid})`,
      }),
    );
  }
  svg.append(layer);
  return { svg, agentMoves, arrows, count: inPlay.length, arrowsDrawn: arrows.childElementCount };
}

/** Chalk in once, shirts slide from where they were, tags rise: once, never under reduced motion. */
function animatePitch(board) {
  if (prefersReducedMotion() || !board || typeof board.svg.animate !== "function") return;
  board.arrows.querySelectorAll("path").forEach((p, i) => {
    if (typeof p.getTotalLength !== "function") return;
    const len = p.getTotalLength();
    p.style.strokeDasharray = `${len}`;
    p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], {
      duration: 520,
      delay: 80 + i * 60,
      easing: "cubic-bezier(.16,1,.3,1)",
      fill: "backwards",
    }).finished.then(
      () => (p.style.strokeDasharray = ""),
      () => {},
    );
  });
  board.agentMoves.forEach(({ g, dx, dy }, i) =>
    g.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0,0)" }], {
      duration: 640,
      delay: 520 + i * 60,
      easing: "cubic-bezier(.16,1,.3,1)",
      fill: "backwards",
    }),
  );
  board.svg.querySelectorAll(".agent-tag").forEach((c, i) =>
    c.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 240,
      delay: 1100 + i * 70,
      fill: "backwards",
    }),
  );
}

function tacticsBoard(f) {
  const boards = {};
  const observers = [];
  const host = (o) => {
    const h = el("div", { class: o === "portrait" ? "pw-port" : "pw-land" });
    let lastK = 0;
    h.fit = () => {
      const w = h.clientWidth;
      if (!w) return false;
      const k = PITCH_VW[o] / w;
      if (Math.abs(k - lastK) / k < 0.02) return false;
      lastK = k;
      boards[o] = pitchBoard(f, o, k);
      h.replaceChildren(boards[o].svg);
      return true;
    };
    boards[o] = pitchBoard(f, o);
    h.append(boards[o].svg);
    if (typeof window.ResizeObserver === "function") {
      const ro = new window.ResizeObserver(() => h.fit());
      ro.observe(h);
      observers.push(ro);
    }
    return h;
  };
  const hl = host("landscape"),
    hp = host("portrait");
  const inPlay = f.tickets.filter((t) => ON_PITCH.has(t.status)).length;
  const off = f.tickets.filter((t) => OFF_PITCH.has(t.status)).sort((a, b) => a.number - b.number);
  const bench = f.tickets.filter((t) => ON_BENCH.has(t.status)).sort((a, b) => a.number - b.number);
  const win = arrowWindow(f);
  const when = win.recent
    ? "in the last 3 hours"
    : `in the 3 hours to the last move (${fmtTime(new Date(win.end).toISOString())})`;
  const { channels } = pitchChannels(f);
  const sec = el("section", { class: "tactics", id: "tactics", "aria-labelledby": "tb-h" }, [
    el("div", { class: "tactics-head" }, [
      el("h2", { id: "tb-h", class: "tb-title" }, [
        "Tactics board",
        el("span", { class: "panel-aux" }, `${inPlay} in play`),
      ]),
      el("p", { class: "tb-note" }, [
        el("span", { class: "tb-land" }, "Left to right"),
        el("span", { class: "tb-port" }, "Bottom to top"),
        ` is the lifecycle; each channel is a repo. Chalk arrows are the moves ${when}.`,
      ]),
    ]),
    channels.length
      ? el("div", { class: "pitch-wrap" }, [hl, hp])
      : el("div", { class: "pitch-wrap is-empty" }, [
          el("p", { class: "pitch-empty" }, "Nobody on the pitch: no ticket is in play yet."),
        ]),
    el("div", { class: "touchline" }, [
      el("div", { class: "dugout" }, [
        el("h3", {}, "Off the pitch"),
        off.length
          ? el(
              "ul",
              {},
              off.map((t) =>
                el("li", {}, [
                  el("a", { href: `#/ticket/${t.id}`, class: `off-${t.status}` }, [
                    statusBadge(t.status),
                    el("b", {}, `#${t.number}`),
                    el("span", { class: "off-t" }, t.title),
                  ]),
                ]),
              ),
            )
          : el("p", {}, "Nobody: nothing is blocked, paused or failed."),
      ]),
      el("div", { class: "bench" }, [
        el("h3", {}, "Bench"),
        el("p", {}, [
          bench.length
            ? `${bench.filter((t) => t.status === "draft").length} draft, ${bench.filter((t) => t.status === "refining").length} refining: `
            : "Empty.",
          ...bench.flatMap((t, i) => [
            i ? " " : "",
            el("a", { href: `#/ticket/${t.id}`, title: t.title }, `#${t.number}`),
          ]),
        ]),
      ]),
    ]),
    el("ul", { class: "pitch-key", "aria-label": "Key" }, [
      el("li", {}, [agentShirt("01", 26), "Agent (shirt number) on a ticket"]),
      el("li", {}, [
        svgS(
          "svg",
          { viewBox: "0 0 20 20", width: 20, height: 20, "aria-hidden": "true" },
          svgS("circle", { cx: 10, cy: 10, r: 8, class: "key-disc" }),
        ),
        "Ticket",
      ]),
      el("li", {}, [
        el("span", { class: "key-tag", "aria-hidden": "true" }, [
          "31 turns ",
          el("b", {}, "$1.02"),
        ]),
        "Agent's run so far",
      ]),
      el("li", {}, [ycard(18), "Needs you"]),
      el("li", {}, [
        svgS(
          "svg",
          { viewBox: "0 0 40 12", width: 40, height: 12, "aria-hidden": "true" },
          svgS("path", { d: "M2 9 Q20 0 36 6", class: "key-arrow" }),
        ),
        "A move",
      ]),
      ...channels
        .filter((r) => r !== "Other repos")
        .map((r) => el("li", { class: "key-kit" }, [kitShirt(r, 20), r])),
    ]),
  ]);
  sec._arrive = () => {
    const o = window.matchMedia?.("(max-width: 760px)").matches ? "portrait" : "landscape";
    (o === "portrait" ? hp : hl).fit();
    animatePitch(boards[o]);
  };
  sec._dispose = () => observers.forEach((ro) => ro.disconnect());
  return sec;
}

// --- The programme pages -----------------------------------------------------

/** A programme page: a kit-colour title block over a 2px ink frame. */
function progPage(cls, kit, title, aux, body) {
  return el("section", { class: `card prog ${cls}`, "aria-label": title }, [
    panelHead(title, aux, null, { kit }),
    ...[].concat(body),
  ]);
}

/** Cup runs: every epic as rounds (dependency depth); the acceptance ticket is the Final. */
function cupRuns(f) {
  if (!f.epics.length) {
    return progPage("campaigns", "sky", "Cup runs", "epics, by phase", [
      el("p", { class: "quiet" }, [
        "No cup runs yet. ",
        el(
          "button",
          { class: "btn-link", type: "button", onclick: () => openPlanBuild() },
          "Plan a build",
        ),
        " and the epic lands here as rounds.",
      ]),
    ]);
  }
  return progPage(
    "campaigns",
    "sky",
    "Cup runs",
    "epics, by phase",
    f.epics.map((e) => {
      const deps = new Map(
        e.members.map((t) => [
          t.id,
          (f.details.get(t.id)?.dependencies || []).map((d) => d.depends_on_ticket_id),
        ]),
      );
      const byPhase = computePhases(e.members, deps);
      const phases = [...byPhase.keys()].sort((a, b) => a - b).map((p) => byPhase.get(p));
      const held = e.members.filter((t) => OFF_PITCH.has(t.status));
      const heldIds = new Set(held.map((t) => t.id));
      const waits = e.members.filter((t) => (deps.get(t.id) || []).some((d) => heldIds.has(d)));
      const done = e.members.filter((t) => t.status === "done").length;
      return el("article", { class: `cup${held.length ? " is-held" : ""}` }, [
        el("header", { class: "cup-head" }, [
          el("h3", {}, el("a", { href: `#/epics/${e.node.id}` }, e.node.name)),
          el(
            "p",
            { class: held.length ? "cup-why is-red" : "cup-why" },
            held.length
              ? [
                  glyph("blocked", 16),
                  `Held at #${held[0].number}${waits.length ? `: ${waits.map((t) => "#" + t.number).join(", ")} wait on it.` : "."}`,
                ]
              : `${done} of ${e.members.length} done. Nothing is holding it.`,
          ),
        ]),
        el(
          "ol",
          { class: "rounds" },
          phases.map((ph, i) =>
            el("li", { class: "round" }, [
              el(
                "span",
                { class: "round-name" },
                i === phases.length - 1 &&
                  phases.length > 1 &&
                  ph.some((t) => /^Acceptance/i.test(t.title))
                  ? "Final"
                  : `Round ${i + 1}`,
              ),
              el(
                "ul",
                {},
                ph
                  .slice()
                  .sort((a, b) => a.number - b.number)
                  .map((t) =>
                    el("li", { class: `tie st-${t.status}` }, [
                      el(
                        "a",
                        {
                          href: `#/ticket/${t.id}`,
                          "aria-label": `#${t.number} ${statusLabel(t.status)}: ${t.title}`,
                        },
                        [
                          glyph(t.status, 16),
                          el("b", {}, `#${t.number}`),
                          el("span", { class: "tie-t" }, t.title),
                        ],
                      ),
                    ]),
                  ),
              ),
            ]),
          ),
        ),
      ]);
    }),
  );
}

/** Why a failed or paused ticket is out: the pause event, or the last failing gate. */
function injuryWhy(f, t) {
  const d = f.details.get(t.id);
  if (t.status === "paused") {
    const p = d ? pausedInfo(d.events || []) : {};
    if (p.reason === "budget_cap")
      return `Stopped at its budget cap: ${p.spend || "its spend"} spent${t.delivery_budget_usd != null || d?.ticket?.delivery_budget_usd != null ? ` of ${money(Number(d?.ticket?.delivery_budget_usd ?? t.delivery_budget_usd))}` : ""}.`;
    if (p.reason === "timeout") return "Stopped at the wall-clock timeout.";
    return `Stopped at the turn cap${p.turns != null ? ` (${p.turns} turns)` : ""}.`;
  }
  const trail = d?.rework_trail || [];
  if (trail.length) {
    const last = trail[trail.length - 1];
    const first =
      String(last.distilled_failure || "")
        .split("\n")
        .find((l) => l.trim()) || "";
    return `Failed the ${last.gate} gate${first ? `: ${first.slice(0, 140)}` : "."}`;
  }
  const ev = (d?.evidence || []).find((e) => /FAIL/.test(e.summary || ""));
  if (ev) {
    const g = String(ev.summary).match(/\[FAIL\]\s+(\w+)\s*\(([^)]+)\)\s*[—-]\s*([^\n]+)/);
    const err = String(ev.summary)
      .split("\n")
      .find((l) => /^Error/.test(l.trim()));
    if (g)
      return `The ${g[1]} gate failed in ${g[2]} (${g[3].trim()})${err ? `: ${err.trim().slice(0, 120)}` : "."}`;
  }
  return "Failed its gates.";
}
function injuryList(f) {
  const list = f.tickets.filter((t) => t.status === "failed" || t.status === "paused");
  return progPage(
    "injuries",
    "red",
    "Injury list",
    "failed or paused",
    list.length
      ? el(
          "ul",
          { class: "inj-list" },
          list.map((t) =>
            el("li", {}, [
              el("p", { class: "inj-top" }, [
                statusBadge(t.status),
                el("a", { href: `#/ticket/${t.id}` }, `#${t.number} ${t.title}`),
              ]),
              el("p", { class: "inj-why" }, injuryWhy(f, t)),
              f.repoOf.get(t.id)
                ? el("p", { class: "inj-meta" }, repoTag(f.repoOf.get(t.id), 18))
                : null,
            ]),
          ),
        )
      : el("p", { class: "quiet" }, "No failed or paused tickets."),
  );
}

function leagueTable(f) {
  const spend = new Map(((f.cost && f.cost.by_repo) || []).map((r) => [r.repo, r.total_cost_usd]));
  const rows = (f.summary.repoProgress || [])
    .slice()
    .sort((a, b) => b.pct - a.pct || b.done - a.done);
  const head = ["Pos", "Repo", "Tickets", "Done", "In play", "Blocked", "Spend", "Done %"];
  return progPage(
    "league",
    "claret",
    "League table",
    "repos by share done",
    rows.length
      ? el("div", { class: "lt-wrap" }, [
          el("table", { class: "lt" }, [
            el(
              "thead",
              {},
              el(
                "tr",
                {},
                head.map((h, i) => el("th", { scope: "col", class: i > 1 ? "num" : null }, h)),
              ),
            ),
            el(
              "tbody",
              {},
              rows.map((r, i) =>
                el("tr", {}, [
                  el("td", { class: "pos" }, String(i + 1)),
                  el("th", { scope: "row" }, repoTag(r.repo, 20)),
                  el("td", { class: "num" }, String(r.total)),
                  el("td", { class: "num" }, String(r.done)),
                  el("td", { class: "num" }, String(r.inFlight ?? 0)),
                  el(
                    "td",
                    { class: `num${r.blocked ? " is-red" : ""}` },
                    r.blocked ? [glyph("blocked", 12), " ", String(r.blocked)] : "0",
                  ),
                  el("td", { class: "num" }, spend.has(r.repo) ? money(spend.get(r.repo)) : "—"),
                  el("td", { class: "num" }, [
                    el(
                      "span",
                      { class: "pct-bar", "aria-hidden": "true" },
                      el("span", { style: { width: `${r.pct}%` } }),
                    ),
                    `${r.pct}%`,
                  ]),
                ]),
              ),
            ),
          ]),
        ])
      : el("p", { class: "quiet" }, "No repos with tickets yet."),
  );
}

/** Daily spend bars against the budget line, drawn at real pixel width. */
function wageSvg(f, W) {
  const daily = ((f.health && f.health.daily_spend) || [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  const spend = new Map(daily.map((d) => [d.date, d.total_cost_usd]));
  const todayKey = new Date(f.now).toISOString().slice(0, 10);
  const days = [];
  const startKey = daily[0]?.date || todayKey;
  const start = new Date(startKey + "T00:00:00Z");
  const end = new Date(todayKey + "T00:00:00Z");
  // At most the last 21 days, so a long season stays readable.
  for (
    let d = new Date(Math.max(start.getTime(), end.getTime() - 20 * 864e5));
    d <= end;
    d = new Date(d.getTime() + 864e5)
  )
    days.push(d.toISOString().slice(0, 10));
  const budget = f.budget || 0;
  const narrow = W < 480;
  const H = narrow ? 200 : 220,
    padL = 36,
    padR = 4,
    padB = 36,
    padT = 22;
  const max = Math.max(budget, ...days.map((d) => spend.get(d) || 0), 1);
  const bw = (W - padL - padR) / days.length,
    gap = Math.max(3, Math.min(8, bw * 0.18));
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const svg = svgS("svg", {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    class: "wage-chart",
    role: "img",
    "aria-label": `Daily spend from ${fmtDay(days[0] + "T12:00:00Z", { weekday: false })} to today: ${days
      .map(
        (d) =>
          `${fmtDay(d + "T12:00:00Z", { weekday: false })} ${spend.has(d) ? money(spend.get(d)) : "none recorded"}`,
      )
      .join(", ")}.${budget ? ` Daily budget ${moneyW(budget)}.` : ""}`,
  });
  const stepV = max > 40 ? 10 : 5;
  for (let v = 0; v <= max; v += stepV) {
    svg.append(
      svgS("line", { x1: padL, x2: W - padR, y1: y(v), y2: y(v), class: v ? "grid" : "axis" }),
      svgS("text", { x: padL - 6, y: y(v) + 4, "text-anchor": "end", class: "tick" }, "$" + v),
    );
  }
  if (budget) {
    svg.append(
      svgS("line", { x1: padL, x2: W - padR, y1: y(budget), y2: y(budget), class: "budget-line" }),
      svgS(
        "text",
        { x: W - padR, y: y(budget) - 6, "text-anchor": "end", class: "budget-t" },
        `Daily budget ${moneyW(budget)}`,
      ),
    );
  }
  const topDay = [...spend.entries()]
    .filter(([d]) => d !== todayKey && days.includes(d))
    .sort((p, q) => q[1] - p[1])[0]?.[0];
  days.forEach((d, i) => {
    const v = spend.get(d),
      x = padL + gap / 2 + i * bw,
      today = d === todayKey,
      w = bw - gap,
      cx = x + w / 2;
    if (v != null) {
      svg.append(
        svgS(
          "rect",
          {
            x,
            y: y(v),
            width: w,
            height: Math.max(1, y(0) - y(v)),
            class: today ? "bar bar-today" : "bar",
          },
          svgS("title", {}, `${fmtDay(d + "T12:00:00Z")}: ${money(v)}`),
        ),
      );
      if (today || bw >= 36 || d === topDay) {
        const anchor = today && cx + 26 > W ? "end" : "middle";
        svg.append(
          svgS(
            "text",
            {
              x: anchor === "end" ? x + w : cx,
              y: y(v) - 6,
              "text-anchor": anchor,
              class: today ? "val val-today" : "val",
            },
            money(v),
          ),
        );
      }
    } else
      svg.append(
        svgS("text", { x: cx, y: y(0) - 5, "text-anchor": "middle", class: "val none" }, "–"),
      );
    const dd = new Date(d + "T12:00:00Z");
    svg.append(
      svgS(
        "text",
        { x: cx, y: H - 20, "text-anchor": "middle", class: "tick" },
        String(dd.getUTCDate()),
      ),
    );
    if (dd.getUTCDay() === 1 || i === 0)
      svg.append(
        svgS(
          "text",
          { x: cx, y: H - 4, "text-anchor": "middle", class: "tick tick-s" },
          WEEKDAYS[dd.getUTCDay()],
        ),
      );
  });
  return svg;
}
function wageBill(f) {
  const h = f.health || {};
  const host = el("div", { class: "wage-host" });
  let lastW = 0;
  const fit = () => {
    const w = Math.floor(host.clientWidth);
    if (!w || Math.abs(w - lastW) < 2) return;
    lastW = w;
    host.replaceChildren(wageSvg(f, w));
  };
  host.append(wageSvg(f, 360));
  host._fit = fit;
  const kinds = Array.isArray(h.by_kind) ? h.by_kind : [];
  const top = (f.cost && f.cost.top_tickets && f.cost.top_tickets[0]) || null;
  const topT = top ? f.byNo.get(top.ticket) : null;
  const cov =
    h.coverage && typeof h.coverage.coverage_pct === "number" ? h.coverage.coverage_pct : null;
  const est = f.cost && f.cost.estimated_usd > 0 ? f.cost.estimated_usd : 0;
  const sec = progPage(
    "wage",
    "ink",
    "Wage bill",
    f.cost && typeof f.cost.total_usd === "number"
      ? `${money(f.cost.total_usd)} this season`
      : null,
    [
      host,
      el(
        "p",
        { class: "wage-note" },
        `Days with no spend recorded show a dash. API-equivalent cost from the usage ledger${cov != null ? ` (${cov}% of calls measured)` : ""}${est ? `; ${money(est)} is a labelled estimate for killed calls` : ""}.`,
      ),
      el("dl", { class: "wage-facts" }, [
        el("div", {}, [
          el("dt", {}, "Per shipped ticket"),
          el("dd", {}, [
            money(h.cost_per_shipped_usd),
            el("small", {}, h.shipped_count != null ? `over ${h.shipped_count} shipped` : ""),
          ]),
        ]),
        el("div", {}, [
          el("dt", {}, "Spent on rework"),
          el("dd", {}, [
            money(h.rework?.total_rework_cost_usd),
            el(
              "small",
              {},
              h.rework?.rework_cost_share_pct != null
                ? `${h.rework.rework_cost_share_pct}% of spend`
                : "",
            ),
          ]),
        ]),
        el("div", {}, [
          el("dt", {}, "Top earner"),
          el(
            "dd",
            {},
            top
              ? [
                  topT
                    ? el("a", { href: `#/ticket/${topT.id}` }, `#${top.ticket}`)
                    : `#${top.ticket}`,
                  el("small", {}, `${money(top.total_cost_usd)}, ${top.num_turns} turns`),
                ]
              : "—",
          ),
        ]),
      ]),
      kinds.length
        ? el(
            "div",
            {
              class: "kind-bar",
              role: "img",
              "aria-label":
                "Spend by kind: " +
                kinds.map((k) => `${k.kind} ${money(k.total_cost_usd)}`).join(", "),
            },
            kinds.map((k, i) =>
              el("span", {
                class: `kb kb-${Math.min(i, 4)}`,
                style: { flexGrow: k.total_cost_usd || 0 },
              }),
            ),
          )
        : null,
      kinds.length
        ? el(
            "ul",
            { class: "kind-key" },
            kinds.map((k, i) =>
              el("li", {}, [
                el("span", { class: `kb-sw kb-${Math.min(i, 4)}` }),
                `${k.kind} ${money(k.total_cost_usd)}`,
              ]),
            ),
          )
        : null,
    ],
  );
  sec._arrive = fit;
  return sec;
}

/** Squad & form: each agent, what it is on now, and every ticket it claimed (where it is now). */
function squadForm(f) {
  const history = new Map();
  for (const e of f.events) {
    if (e.event_type !== "claim.created" || !e.actor_id) continue;
    const nm = agentNames.get(e.actor_id);
    if (!nm) continue;
    (history.get(nm) || history.set(nm, []).get(nm)).push({
      id: e.entity_id,
      n: e.ticket_number,
      at: e.created_at,
    });
  }
  const claimByAgent = new Map(f.claims.map((c) => [c.agent_id, c]));
  const agents = f.agents
    .filter((a) => a.agent_type !== "human")
    .slice()
    .sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
  const onPitch = f.claims.length;
  return progPage(
    "squad",
    "sky",
    "Squad & form",
    f.slots ? `${onPitch} of ${f.slots} on the pitch` : `${onPitch} on the pitch`,
    agents.length
      ? [
          el(
            "ul",
            { class: "sq-list" },
            agents.map((a) => {
              const claim = claimByAgent.get(a.id);
              const t = claim ? f.byId.get(claim.ticket_id) : null;
              const run = claim ? f.runByTicket.get(claim.ticket_number) : null;
              const rework = t
                ? (f.details.get(t.id)?.events || [])
                    .filter((e) => e.event_type === "ticket.reworking")
                    .pop()
                : null;
              const rw = rework ? parseJsonSafe(rework.payload_json) : null;
              const form = (history.get(a.display_name) || [])
                .sort((x, y) => x.at.localeCompare(y.at))
                .slice(-6);
              return el("li", { class: `sq-row${claim ? " is-on" : ""}` }, [
                agentShirt(a.display_name, 56),
                el("div", { class: "sq-body" }, [
                  el("p", { class: "sq-name" }, a.display_name),
                  el(
                    "p",
                    { class: "sq-now" },
                    claim
                      ? [
                          t
                            ? el("a", { href: `#/ticket/${t.id}` }, `On #${claim.ticket_number}`)
                            : `On #${claim.ticket_number}`,
                          t ? ` · ${statusLabel(t.status).toLowerCase()}` : "",
                          run
                            ? run.num_turns
                              ? ` · ${run.phase ? run.phase + " · " : ""}${run.num_turns} turns · ${money(run.cost_usd)}`
                              : " · just claimed"
                            : "",
                          rw && rw.attempt
                            ? el(
                                "span",
                                { class: "is-warn" },
                                ` · rework ${rw.attempt}/${rw.max_attempts} on ${rw.gate || "gates"}`,
                              )
                            : null,
                        ]
                      : `On the bench. Last seen ${a.last_seen_at ? fmtTime(a.last_seen_at) : "never"}.`,
                  ),
                  form.length
                    ? el("p", { class: "sq-form" }, [
                        el("span", { class: "sq-form-l" }, "Form"),
                        el(
                          "span",
                          { class: "form-row" },
                          form.map((x) => {
                            const ft = f.byId.get(x.id);
                            const st = ft ? ft.status : "draft";
                            return el(
                              "a",
                              {
                                href: `#/ticket/${x.id}`,
                                class: `form-chip st-${st}`,
                                title: `#${x.n} ${statusLabel(st)}`,
                                "aria-label": `#${x.n} now ${statusLabel(st)}`,
                              },
                              [glyph(st, 14), String(x.n)],
                            );
                          }),
                        ),
                      ])
                    : null,
                ]),
              ]);
            }),
          ),
          el(
            "p",
            { class: "quiet small" },
            "Form: the tickets each agent claimed recently, oldest first, with where each one is now.",
          ),
        ]
      : el("p", { class: "quiet" }, "No agents registered yet."),
  );
}

function fullTime(f) {
  const done = f.tickets
    .filter((t) => t.status === "done")
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 6);
  const spend = new Map(
    ((f.cost && f.cost.top_tickets) || []).map((t) => [t.ticket, t.total_cost_usd]),
  );
  return progPage(
    "results",
    "ink",
    "Full time",
    "recently done",
    done.length
      ? el(
          "ul",
          { class: "res-list" },
          done.map((t) =>
            el("li", {}, [
              el("span", { class: "res-ft", "aria-hidden": "true" }, "FT"),
              el("time", { datetime: t.updated_at }, fmtDay(t.updated_at, { weekday: false })),
              el("a", { href: `#/ticket/${t.id}` }, [el("b", {}, `#${t.number}`), " ", t.title]),
              el(
                "span",
                { class: "res-cost" },
                spend.has(t.number) ? money(spend.get(t.number)) : "",
              ),
            ]),
          ),
        )
      : el("p", { class: "quiet" }, "Nothing delivered yet."),
  );
}

function fixtures(f) {
  const ready = f.tickets
    .filter((t) => t.status === "ready")
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.number - b.number);
  return progPage(
    "fixtures",
    "sky",
    "Fixtures",
    `${ready.length} ready`,
    ready.length
      ? el(
          "ul",
          { class: "fx-list" },
          ready.slice(0, 8).map((t) => {
            const deps = (f.details.get(t.id)?.dependencies || []).filter(
              (d) => !d.satisfied && d.status !== "done",
            );
            const red = deps.some((d) => OFF_PITCH.has(d.status));
            return el("li", {}, [
              glyph("ready", 16),
              el("a", { href: `#/ticket/${t.id}` }, [el("b", {}, `#${t.number}`), " ", t.title]),
              el(
                "span",
                { class: red ? "fx-gate is-red" : "fx-gate" },
                deps.length
                  ? `waits on ${deps.map((d) => `#${d.number} (${statusLabel(d.status).toLowerCase()})`).join(", ")}`
                  : "next up",
              ),
            ]);
          }),
        )
      : el("p", { class: "quiet" }, "No ticket is ready to be claimed."),
  );
}

/** The match report: the latest events, in words, with who did them. */
function matchReport(f) {
  const evs = f.events.slice(0, 10);
  return progPage(
    "report",
    "ink",
    "Match report",
    f.events.length ? `latest ${evs.length}` : null,
    evs.length
      ? el("ul", { class: "feed" }, evs.map(renderFeedRow))
      : el("p", { class: "quiet" }, "No activity recorded yet."),
  );
}

async function renderOverview() {
  const [f] = await Promise.all([
    loadMatchDay(),
    document.fonts?.load?.('700 16px "Sofia Sans Condensed"').catch(() => null),
  ]);
  const wrap = el("div", { class: "view view-overview" });
  // A short Team Sheet (nothing, or one or two rows) leaves the column beside
  // the pitch mostly empty: Squad & form moves up into it, as in the idle comp.
  const idle = f.items.length <= 2;
  wrap.appendChild(overviewScoreboard(f));
  const sheet = whatIOwnPanel(f.queue, f);
  const board = tacticsBoard(f);
  const squad = squadForm(f);
  const wage = wageBill(f);
  wrap.appendChild(
    el("div", { class: "ov-main" }, [
      idle ? el("div", { class: "ov-left" }, [sheet, squad]) : sheet,
      board,
    ]),
  );
  wrap.appendChild(
    el("div", { class: `ov-prog${idle ? " is-idle" : ""}` }, [
      cupRuns(f),
      injuryList(f),
      leagueTable(f),
      wage,
      idle ? null : squad,
      fullTime(f),
      fixtures(f),
      matchReport(f),
    ]),
  );
  // A signature of what was drawn: an unchanged factory keeps its DOM on refresh.
  wrap.dataset.sig = hashText(
    JSON.stringify([
      f.items.map((i) => [
        i.kind,
        i.ticket?.id,
        i.decisionId,
        Math.floor((i.waitedMs || 0) / 60000),
      ]),
      f.tickets.map((t) => [t.id, t.status, t.updated_at]),
      f.claims.map((c) => [c.ticket_id, c.agent_id]),
      [...f.runByTicket].map(([n, r]) => [n, r.num_turns, r.cost_usd]),
      f.cost?.today_usd,
      f.cost?.total_usd,
      f.summary.deliveredToday,
      f.events[0]?.id,
      f.health?.event_log?.events,
    ]),
  );
  // Draw the board at its real size (labels keep their pixel floor) once mounted.
  wrap._mounted = () => {
    board._arrive?.();
    wage._arrive?.();
  };
  wrap._dispose = () => board._dispose?.();
  if (typeof window.ResizeObserver === "function") {
    const ro = new window.ResizeObserver(() => wage._arrive?.());
    const host = wage.querySelector(".wage-host");
    if (host) ro.observe(host);
    const prev = wrap._dispose;
    wrap._dispose = () => {
      prev();
      ro.disconnect();
    };
  }
  return wrap;
}

/**
 * The physio room's flow panels (moved off the Overview, which is the comp's
 * programme now): the Form guide, Governance ROI, the cost line, Development
 * flow, the treatment table (at risk / stale), cycle time and flow efficiency,
 * the "keeps bouncing" list and Running now. Returns the panels in order.
 */
async function fitnessRoomPanels(healthRes) {
  const [{ summary }, ticketsRes, decisionsRes, costRes, bouncingRes] = await Promise.all([
    api("GET", "/api/dashboard"),
    api("GET", "/tickets").catch(() => ({ tickets: [] })),
    api("GET", "/decisions").catch(() => ({ decisions: [] })),
    api("GET", "/api/cost").catch(() => null),
    api("GET", "/api/rework/bouncing").catch(() => ({ bouncing: [] })),
  ]);

  const byStatus = summary.ticketsByStatus || {};
  const tickets = ticketsRes.tickets || [];
  const decisions = decisionsRes.decisions || [];
  const inReview = byStatus.in_review || 0;
  const blocked = summary.blocked ?? byStatus.blocked ?? 0;
  const openDecisions = summary.openDecisions ?? decisions.length;
  const staleClaims = summary.staleClaims || 0;
  const inProgress = (byStatus.in_progress || 0) + (byStatus.claimed || 0);
  const doneTickets = tickets.filter((t) => t.status === "done");

  // --- real time-series, bucketed by day from ticket + event timestamps -----
  const DAY = 86_400_000;
  const now = Date.now();
  const N = 14;
  const days = [];
  for (let i = N - 1; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    days.push({ key: d.toISOString().slice(0, 10), lbl: `${d.getDate()}/${d.getMonth() + 1}` });
  }
  const bucket = (items, tsOf) => {
    const m = Object.fromEntries(days.map((d) => [d.key, 0]));
    for (const it of items) {
      const k = String(tsOf(it)).slice(0, 10);
      if (k in m) m[k] += 1;
    }
    return days.map((d) => m[d.key]);
  };

  // AUTHORITATIVE cycle-time / throughput: read the ONE server-side definition
  // from /api/health (src/health/deliveryFlow.ts) instead of recomputing it here.
  // The server reproduces the former client maths, so displayed numbers are
  // unchanged. Falls back to a zeroed 14-day shape when the endpoint is
  // unavailable, so the KPI cards still render.
  const health = healthRes || {};
  const flowCycle = health.cycle_time || {};
  const flowThr = health.throughput || {};
  const zeroSeries = () => days.map(() => 0);
  const cycleLine =
    Array.isArray(flowCycle.series) && flowCycle.series.length === N
      ? flowCycle.series
      : zeroSeries();
  const doneByDay =
    Array.isArray(flowThr.series) && flowThr.series.length === N ? flowThr.series : zeroSeries();

  // --- distinct, real per-metric daily series (each KPI gets its own shape) --
  const createdByDay = bucket(tickets, (t) => t.created_at);
  // deployments: cumulative tickets shipped (a monotonic delivery curve)
  let depAcc = 0;
  const deploySeries = doneByDay.map((v) => (depAcc += v));
  // lead time: 7-day trailing mean of daily cycle (a smoothed lead trend)
  const leadSeries = cycleLine.map((_, i) => {
    const w = cycleLine.slice(Math.max(0, i - 6), i + 1).filter((x) => x > 0);
    return w.length ? +(w.reduce((a, b) => a + b, 0) / w.length).toFixed(2) : 0;
  });
  // flow efficiency: 7-day trailing shipped / created (a real ratio trend, %)
  const flowEffSeries = days.map((_, i) => {
    const lo = Math.max(0, i - 6);
    const shipped = doneByDay.slice(lo, i + 1).reduce((a, b) => a + b, 0);
    const opened = createdByDay.slice(lo, i + 1).reduce((a, b) => a + b, 0);
    return opened > 0 ? Math.round((shipped / (shipped + opened)) * 100) : 0;
  });

  // --- headline metrics -----------------------------------------------------
  // Cycle time + throughput are server-authoritative (from /api/health above).
  // cycleVals is retained ONLY to derive the Lead-time percentile below.
  const cycleVals = doneTickets
    .map((t) => (Date.parse(t.updated_at) - Date.parse(t.created_at)) / DAY)
    .filter((x) => x >= 0);
  const cycleTime = typeof flowCycle.median_days === "number" ? flowCycle.median_days : 0;
  const leadTime = cycleVals.length
    ? Math.max(
        ...cycleVals
          .slice()
          .sort((a, b) => a - b)
          .slice(0, Math.ceil(cycleVals.length / 2)),
      ) || cycleTime
    : 0;
  const last7 = typeof flowThr.last7 === "number" ? flowThr.last7 : 0;
  const prev7 = typeof flowThr.prev7 === "number" ? flowThr.prev7 : 0;
  // Flow efficiency is SERVER-AUTHORITATIVE when the endpoint carries it: the median
  // (active time / lead time) over shipped tickets, from the transition log
  // (src/health/deliveryFlow.ts). The former client number was a WIP ratio
  // (done / done+in-flight), which is not flow efficiency; it remains only as the
  // fallback when the server has no shipped ticket with the signal yet.
  const flowEffServer = health.flow_efficiency || {};
  const flowEff =
    typeof flowEffServer.median_pct === "number"
      ? Math.round(flowEffServer.median_pct)
      : Math.round(
          ((byStatus.done || 0) /
            Math.max(
              1,
              (byStatus.done || 0) + inReview + blocked + inProgress + (byStatus.ready || 0),
            )) *
            100,
        );
  const right = el("div", { class: "fitness-panels stack" });
  const left = right;

  // --- Form guide: the flow numbers, each from the server's one definition ------
  right.appendChild(
    el("section", { class: "card panel form-guide", "aria-label": "Flow" }, [
      panelHead("Form guide", "last 14 days", null, { kit: "claret" }),
      el("div", { class: "kpi-row" }, [
        statCell({
          label: "Cycle time",
          value: cycleTime.toFixed(1),
          unit: "days",
          series: cycleLine,
          flip: "cycle",
        }),
        statCell({
          label: "Throughput",
          value: String(last7),
          unit: "shipped / 7d",
          sub: `${prev7} the week before`,
          series: doneByDay,
          flip: "thr",
        }),
        statCell({
          label: "Flow efficiency",
          value: String(flowEff),
          unit: "%",
          series: flowEffSeries,
          flip: "eff",
        }),
        statCell({
          label: "Deployments",
          value: String(doneTickets.length),
          unit: "all-time",
          series: deploySeries,
          flip: "dep",
        }),
        statCell({
          label: "Lead time",
          value: leadTime.toFixed(1),
          unit: "days",
          series: leadSeries,
          flip: "lead",
        }),
      ]),
    ]),
  );

  // --- Governance-ROI panel: does the oversight machinery EARN its cost? -------
  // Merge / rework / unattended-safe rates from /api/health.governance, computed
  // server-side from REAL ticket transitions (src/health/governanceRoi.ts) — never
  // the demo dataset. Window-selectable. Every rate is shown WITH the raw counts it
  // derives from, and an empty window renders an explicit note, never a fake 0%.
  {
    const govPanel = el("div", { class: "card gov-panel" });
    const pct = (r) => (r && typeof r.rate === "number" ? Math.round(r.rate * 100) : null);
    const tile = (label, r, subFn) => {
      const p = pct(r);
      const has = p !== null;
      return el("div", { class: "gov-tile" + (has ? "" : " gov-tile-empty") }, [
        el("div", { class: "gov-tile-label" }, label),
        el("div", { class: "gov-tile-val tabnum" }, has ? p + "%" : "—"),
        el("div", { class: "gov-tile-sub" }, has ? subFn(r) : "no eligible deliveries yet"),
      ]);
    };
    const paint = (gov) => {
      govPanel.replaceChildren();
      const wd = gov && gov.windowDays ? gov.windowDays : 30;
      const sel = el(
        "select",
        {
          class: "gov-window",
          title: "Time window for the governance rates",
          onchange: async (e) => {
            const v = e.target.value;
            const res = await api("GET", "/api/health?window_days=" + v).catch(() => null);
            paint(res && res.governance ? res.governance : { empty: true, windowDays: Number(v) });
          },
        },
        [7, 30, 90, 365].map((n) => {
          const o = el("option", { value: String(n) }, `last ${n}d`);
          if (n === wd) o.selected = true;
          return o;
        }),
      );
      govPanel.appendChild(
        el("div", { class: "gov-head" }, [
          el(
            "div",
            {
              class: "gov-title",
              title:
                "Does gaffer's governance (gates + review + opt-in autonomy) earn its overhead? Computed from YOUR real ticket transitions — not the demo dataset.",
            },
            "Governance ROI",
          ),
          sel,
        ]),
      );
      if (!gov || gov.empty) {
        govPanel.appendChild(
          el(
            "div",
            { class: "gov-emptystate" },
            `No deliveries reached a review decision in the last ${wd} days — governance ROI needs shipped/rejected history to measure. Ship some tickets to done first.`,
          ),
        );
        return;
      }
      govPanel.appendChild(
        el("div", { class: "gov-tiles" }, [
          tile(
            "Merge rate",
            gov.mergeRate,
            (r) => `${r.numerator} merged of ${r.denominator} reviewed`,
          ),
          tile(
            "Rework rate",
            gov.reworkRate,
            (r) => `${r.numerator} of ${r.denominator} shipped needed rework`,
          ),
          tile(
            "Unattended-safe",
            gov.unattendedSafeRate,
            (r) =>
              `${r.numerator} of ${r.denominator} agent-approved merge cycle${r.denominator === 1 ? "" : "s"} stayed shipped` +
              // Observation age: a cycle merged minutes ago is "not reopened YET".
              (Number.isFinite(gov.counts?.youngestUnattendedMergeAgeMs) &&
              gov.counts.youngestUnattendedMergeAgeMs !== null
                ? ` · newest ${fmtDuration(gov.counts.youngestUnattendedMergeAgeMs)} ago`
                : ""),
          ),
        ]),
      );
    };
    paint(health.governance);
    right.appendChild(govPanel);
  }

  // --- Cost banner (H1) -------------------------------------------------------
  // One small row: total spend all-time + today. Reads from /api/cost which
  // reads the usage-ledger. Hidden when the ledger is absent / not configured.
  if (costRes && (costRes.total_usd > 0 || costRes.today_usd > 0 || costRes.ticket_count > 0)) {
    const fmtUsd = money;
    // B28(e): the totals INCLUDE the labelled estimate the runner books for a
    // killed/timed-out call — the same sum the daemon's day-USD cap halts on, so
    // "Today" can never read lower than the figure the factory stopped at. The
    // estimated share is shown marked as such, never passed off as measured.
    const estNote = (v) =>
      typeof v === "number" && v > 0
        ? el(
            "span",
            {
              class: "cost-est",
              title: `${money(v)} of this is a labelled estimate booked for killed/timed-out calls (not measured usage).`,
            },
            `incl. ${fmtUsd(v)} est.`,
          )
        : null;
    right.appendChild(
      el(
        "div",
        {
          class: "cost-banner",
          // HONESTY: this is an API-EQUIVALENT estimate from Claude Code usage, not real
          // money — on a Max/Pro subscription the marginal cost is the flat fee. A
          // timed-out/killed call has no measured usage; the runner books a labelled
          // conservative estimate for it, which is counted here and marked "est.".
          title:
            "API-equivalent estimate from Claude Code usage — NOT real charges on a Max/Pro subscription (there the marginal cost is the flat fee). Killed/timed-out calls carry a labelled conservative estimate (marked est.) — the same figure the runner's daily budget counts.",
        },
        [
          el("span", { class: "cost-item" }, [
            el("span", { class: "cost-label" }, "All-time (API-equiv)"),
            el("span", { class: "cost-val tabnum" }, fmtUsd(costRes.total_usd)),
            estNote(costRes.estimated_usd),
          ]),
          el("span", { class: "cost-sep" }, "·"),
          el("span", { class: "cost-item" }, [
            el("span", { class: "cost-label" }, "Today"),
            el("span", { class: "cost-val tabnum" }, fmtUsd(costRes.today_usd)),
            estNote(costRes.today_estimated_usd),
          ]),
          el("span", { class: "cost-sep" }, "·"),
          el("span", { class: "cost-item" }, [
            el("span", { class: "cost-label" }, "Tickets costed"),
            el("span", { class: "cost-val tabnum" }, String(costRes.ticket_count)),
          ]),
        ],
      ),
    );
  }

  // --- Development flow + Needs your attention (2-up) -----------------------
  right.appendChild(
    el("div", { class: "ov-grid ov-2" }, [
      devFlowPanel(tickets, byStatus, now),
      needsPanel({
        inReview,
        blocked,
        openDecisions,
        staleClaims,
        stuck: summary.stuckTickets || [],
      }),
    ]),
  );

  // --- Progress by repo + Cycle-time chart + Flow-efficiency donut (3-up) ---
  right.appendChild(
    el("div", { class: "ov-grid ov-3" }, [
      repoProgressPanel(summary.repoProgress || []),
      el("div", { class: "card panel" }, [
        panelHead("Cycle time", "median days to ship, by day"),
        el("div", {
          class: "chart",
          html: svgBars(cycleLine, {
            labels: days.map((d) => d.lbl),
            fmt: (v) => `${(+v).toFixed(1)}d`,
            label: "Median cycle time by day",
            today: true,
          }),
        }),
      ]),
      el("div", { class: "card panel flow-eff" }, [
        panelHead("Flow efficiency", `${flowEff}%`),
        band(flowEff, 100, `Flow efficiency ${flowEff}% of lead time spent working`),
        el(
          "p",
          { class: "section-note" },
          "Share of each shipped ticket's lead time spent being worked on, not waiting (median).",
        ),
      ]),
    ]),
  );

  // --- "Running now" — what's in flight right now (RUN-ACTIVITY) -----------
  // Polls GET /api/runs every ~3s so a triggered background run (Suggest work /
  // onboard / poll-work / merge) is visible while it churns, with its captured
  // log a click away when it finishes. Quiet empty state when nothing's running.
  left.appendChild(runActivityPanel());

  // --- FAILURE-DIAGNOSIS: "these keep bouncing" quality signal --------------
  // Cross-ticket read model: tickets whose rework trail keeps growing, ranked so
  // the ones repeatedly failing the SAME gate lead. Only shown when something is
  // actually bouncing (a quiet factory shows no panel).
  const bouncing = (bouncingRes && bouncingRes.bouncing) || [];
  if (bouncing.length) {
    right.appendChild(renderBouncingPanel(bouncing));
  }

  return [...right.children];
}

/**
 * FAILURE-DIAGNOSIS: the cross-ticket "these keep bouncing" panel. Each row is a
 * ticket with a growing rework trail; the "same gate ×N" chip is the key signal —
 * a ticket stuck failing one gate repeatedly is the operator's cue to intervene.
 */
function renderBouncingPanel(bouncing) {
  return el("div", { class: "card panel bouncing-panel" }, [
    panelHead("Repeatedly bouncing", `${bouncing.length}`),
    el(
      "p",
      { class: "dim bouncing-sub" },
      "Tickets reworking the most — those stuck on the same gate need a human.",
    ),
    el(
      "ul",
      { class: "bouncing-list" },
      bouncing.map((b) => {
        const ref = b.number != null ? `#${b.number}` : b.ticket_id.slice(0, 8);
        const sameGate =
          b.top_gate && b.top_gate_count > 1
            ? el(
                "span",
                {
                  class: "bounce-samegate",
                  title: `Failed the ${b.top_gate} gate ${b.top_gate_count} times`,
                },
                `${b.top_gate} ×${b.top_gate_count}`,
              )
            : null;
        return el(
          "li",
          {},
          el("a", { class: "bounce-row", href: `#/ticket/${b.ticket_id}` }, [
            el("span", { class: "bounce-num mono" }, ref),
            el("span", { class: "bounce-title" }, b.title || "(untitled)"),
            el("span", { class: "bounce-count", title: "Total rework attempts" }, [
              `${b.rework_count}×`,
            ]),
            sameGate,
          ]),
        );
      }),
    ),
  ]);
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
function statCell({ label, value, unit, sub, series, href, flip, needs = false, title, after }) {
  return el(href ? "a" : "div", { class: "kpi", href, title }, [
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

/**
 * Development flow as a horizontal NODE PIPELINE — the Overview's signature
 * element. Five stage nodes (Plan → Ready → Build → Review → Deploy) mapped from
 * the authoritative board counts (summary.ticketsByStatus). Each node is a
 * circular icon disc + LABEL + COUNT; a node with work is "active" (amber ring +
 * glow), an empty node is "dim". Discs are joined by a hairline connector; the
 * segment leading into an active node tints amber. On mobile the row becomes a
 * single horizontally-scrollable strip. `tickets` is retained for signature
 * compatibility but counts come from the aggregate `byStatus`.
 */
const PIPELINE_STAGES = [
  {
    label: "Plan",
    icon: "gitbranch",
    statuses: ["draft", "refining"],
    href: "#/work?status=draft",
  },
  { label: "Ready", icon: "inbox", statuses: ["ready"], href: "#/work?status=ready" },
  {
    label: "Build",
    icon: "wrench",
    statuses: ["in_progress", "claimed"],
    href: "#/work?status=in_progress",
  },
  {
    label: "Review",
    icon: "clipboardcheck",
    statuses: ["in_review", "in_testing", "ready_for_merge"],
    href: "#/review",
  },
  { label: "Deploy", icon: "diamond", statuses: ["done", "shipped"], href: "#/work?status=done" },
];

function devFlowPanel(_tickets, byStatus, _now) {
  const counts = byStatus || {};
  const nodes = PIPELINE_STAGES.map((s) => ({
    ...s,
    count: s.statuses.reduce((sum, st) => sum + (counts[st] || 0), 0),
  }));

  return el("div", { class: "card panel pipeline-panel" }, [
    el("div", { class: "panel-head" }, [
      el("span", { class: "panel-title" }, "Development flow"),
      // When these counts were read — a fact from the response, not a "LIVE" lamp.
      el("span", { class: "pl-live", title: "The time these counts were read from the factory" }, [
        "as of ",
        el("time", { datetime: new Date().toISOString() }, clockTime(Date.now())),
      ]),
    ]),
    el(
      "div",
      { class: "pipeline", role: "list", "aria-label": "Development flow stages" },
      nodes.map((n) => {
        const active = n.count > 0;
        return el(
          "a",
          {
            class: `pl-node ${active ? "active" : "dim"}`,
            href: n.href,
            role: "listitem",
            "aria-label": `${n.label}: ${n.count}`,
          },
          [
            el("span", { class: "pl-disc" }, icon(n.icon)),
            el("span", { class: "pl-label" }, n.label),
            el("span", { class: "pl-count tabnum" }, String(n.count)),
          ],
        );
      }),
    ),
  ]);
}

/**
 * Needs your attention: the human-gate queue as severity-coded alert rows. Each
 * row carries a left status icon keyed to severity — a red diamond for a
 * critical/failing condition (blocked work), an amber triangle for something
 * waiting/overdue (review queue, open decisions, at-risk/stale tickets) — a bold
 * title + a muted sub-line (the detail), and a right-aligned action link that
 * routes to the relevant view. All items derive from real overview state; when
 * nothing is owed the panel keeps its reassuring green all-clear row.
 */
function needsPanel({ inReview, blocked, openDecisions, staleClaims, stuck }) {
  const items = [];
  if (blocked > 0)
    items.push({
      severity: "critical",
      title: `${blocked} blocked ${blocked === 1 ? "task" : "tasks"}`,
      sub: "waiting on a human to clear the path",
      action: "View",
      href: "#/work?status=blocked",
    });
  if (inReview > 0)
    items.push({
      severity: "waiting",
      title: `Review queue · ${inReview}`,
      sub: "changes waiting on your sign-off",
      action: "Review",
      href: "#/review",
    });
  if (openDecisions > 0)
    items.push({
      severity: "waiting",
      title: `${openDecisions} open ${openDecisions === 1 ? "decision" : "decisions"}`,
      sub: "a question is waiting on you",
      action: "Review",
      href: "#/overview",
    });
  if ((stuck || []).length)
    items.push({
      severity: "waiting",
      title: `${stuck.length} at risk`,
      sub: `held too long — oldest ${fmtDuration(stuck[0].stuckForMs)}`,
      action: "View",
      href: "#/work",
    });
  if (staleClaims > 0)
    items.push({
      severity: "waiting",
      title: `${staleClaims} stale ${staleClaims === 1 ? "claim" : "claims"}`,
      sub: "leases past expiry",
      action: "View",
      href: "#/work",
    });

  // red diamond = critical/failing · amber triangle = waiting/overdue
  const sevIcon = (severity) => icon(severity === "critical" ? "diamond" : "alert");

  const body = items.length
    ? el(
        "ul",
        { class: "needs-list" },
        items.map((n) =>
          el(
            "li",
            { class: `needs-item`, dataset: { sev: n.severity } },
            el("a", { class: "ni-link", href: n.href }, [
              el("span", { class: "ni-icon" }, sevIcon(n.severity)),
              el("span", { class: "ni-body" }, [
                el("span", { class: "ni-title" }, n.title),
                el("span", { class: "ni-sub" }, n.sub),
              ]),
              el("span", { class: "ni-action" }, [
                n.action,
                el("span", { class: "ni-arrow" }, "→"),
              ]),
            ]),
          ),
        ),
      )
    : el("div", { class: "needs-empty" }, [
        icon("check"),
        "All clear — nothing is waiting on you.",
      ]);

  return el("div", { class: "card panel needs-hero" }, [
    panelHead("Treatment table", items.length ? `${items.length} at risk` : "all clear", null, {
      kit: items.length ? "red" : "sky",
    }),
    body,
  ]);
}

/** Progress by repository. Repo names are real; per-repo progress is illustrative
 *  demo data until the control plane exposes per-repo completion. */
/** Progress by repository — real per-repo completion from the control plane
 *  (DashboardSummary.repoProgress): a done-share bar + in-flight/blocked hint. */
function repoProgressPanel(rows) {
  const list = rows.slice(0, 6);
  return el("div", { class: "card panel" }, [
    panelHead("Progress by repository", `${rows.length} ${rows.length === 1 ? "repo" : "repos"}`),
    list.length
      ? el(
          "div",
          { class: "repo-prog" },
          list.map((r) => {
            const warn = r.blocked > 0 || r.pct < 35;
            const note = r.blocked
              ? `${r.blocked} blocked`
              : r.inFlight
                ? `${r.inFlight} in flight`
                : `${r.done}/${r.total} done`;
            return el("div", { class: "rp-row", title: `${r.done}/${r.total} tickets done` }, [
              el("span", { class: `rp-dot ${warn ? "warn" : "ok"}` }),
              el("span", { class: "rp-name" }, [
                el("span", { class: "rp-repo" }, repoTag(r.repo, 18)),
                el("span", { class: "rp-note" }, note),
              ]),
              el(
                "span",
                { class: "rp-bar" },
                el("i", { class: warn ? "warn" : "", style: `width:${Math.max(3, r.pct)}%` }),
              ),
              el("span", { class: "rp-pct tabnum" }, `${r.pct}%`),
            ]);
          }),
        )
      : el("p", { class: "dim" }, "No repositories linked to tickets yet."),
  ]);
}

/** One reverse-chronological activity row: time · ticket · event · actor. */
/**
 * Turn a machine event_type ("ticket.acceptance_criteria_reset") into a human
 * label ("Acceptance criteria reset"). A few cases read better with a bespoke
 * verb; everything else is derived by dropping the entity prefix and
 * sentence-casing the remainder, so new event types degrade gracefully.
 */
const EVENT_LABELS = {
  "ticket.created": "Ticket created",
  "ticket.transitioned": "Ticket moved",
  "ticket.claimed": "Ticket claimed",
  "ticket.evidence_recorded": "Evidence recorded",
  "ticket.acceptance_criteria_reset": "Acceptance criteria reset",
  "ticket.reopened_for_review": "Reopened for review",
};
function humanizeEvent(type) {
  if (!type) return "Event";
  if (EVENT_LABELS[type]) return EVENT_LABELS[type];
  const tail = type.includes(".") ? type.slice(type.indexOf(".") + 1) : type;
  const words = tail.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Event";
}

/** "from_status" -> "From status" — a readable label for a payload key. */
function humanizeKey(key) {
  const words = String(key).replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/**
 * Render an event's JSON payload as readable key·value pairs rather than a raw
 * JSON dump. Only primitive values are shown (nested objects are omitted to keep
 * the timeline scannable); returns null when there is nothing worth showing.
 */
function formatPayload(jsonStr) {
  let obj;
  try {
    obj = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const pairs = Object.entries(obj).filter(
    ([, v]) => v != null && v !== "" && typeof v !== "object",
  );
  if (!pairs.length) return null;
  return el(
    "div",
    { class: "ev-payload" },
    pairs.map(([k, v]) =>
      el("span", { class: "ev-pair" }, [
        el("span", { class: "ev-key" }, humanizeKey(k)),
        el("span", { class: "ev-val" }, String(v)),
      ]),
    ),
  );
}

function renderFeedRow(ev) {
  const ticketRef =
    ev.ticket_number != null
      ? el(
          "a",
          { class: "feed-ticket", href: `#/ticket/${ev.entity_id}`, title: ev.ticket_title || "" },
          `#${ev.ticket_number}`,
        )
      : el("span", { class: "feed-ticket dim" }, ev.entity_type);
  return el("li", { class: "feed-row" }, [
    el("time", { class: "feed-time tabnum", datetime: ev.created_at }, fmtTime(ev.created_at)),
    ticketRef,
    el(
      "span",
      { class: `feed-event ev-${ev.event_type.split(".")[0]}` },
      humanizeEvent(ev.event_type),
    ),
    el("span", { class: "feed-actor dim" }, actorName(ev.actor_type, ev.actor_id)),
  ]);
}

// ===========================================================================
//  View: Work — one ticket surface, board ⇄ list, filters persist in URL
//  Replaces Board + Backlog + Claims. Claims surface as a folded panel.
// ===========================================================================

const TICKET_STATUSES = [
  "draft",
  "refining",
  "ready",
  "claimed",
  "in_progress",
  "blocked",
  "in_review",
  "in_testing",
  "ready_for_merge",
  "done",
  "failed",
  "cancelled",
  "paused",
];
const RISK_LEVELS = ["low", "medium", "high", "critical"];
const BOARD_COLUMN_LABELS = {
  draft: "Draft",
  ready: "Ready",
  in_progress: "In progress",
  blocked: "Blocked",
  in_review: "In review",
  in_testing: "In testing",
  ready_for_merge: "Approved · merging",
  done: "Done",
};

// Work-view state, seeded from the URL query so filters/mode are shareable.
const workState = { mode: "board", status: "", repo: "", risk: "" };

function readWorkStateFromUrl() {
  const { query } = parseHash();
  workState.mode = query.get("mode") === "list" ? "list" : "board";
  workState.status = query.get("status") || "";
  workState.repo = query.get("repo") || "";
  workState.risk = query.get("risk") || "";
}
function writeWorkStateToUrl() {
  const qs = new URLSearchParams();
  if (workState.mode === "list") qs.set("mode", "list");
  if (workState.status) qs.set("status", workState.status);
  if (workState.repo) qs.set("repo", workState.repo);
  if (workState.risk) qs.set("risk", workState.risk);
  const q = qs.toString();
  navigate(`#/work${q ? `?${q}` : ""}`);
}

/**
 * "Suggest work" — opens a target picker (Feature B) so the operator chooses a
 * single repo (repo-level) OR a scope node (node-level, fanned out server-side
 * to the node's repos), then kicks off the headless product-owner run.
 */
function suggestWorkButton(repos, nodes) {
  return el(
    "button",
    {
      class: "btn",
      type: "button",
      title: "Run the product-owner skill to propose new draft tickets",
      onclick: () => openSuggestWorkPicker(repos, nodes),
    },
    "Suggest work",
  );
}

/**
 * "Poll for work" — nudge the factory to run one tick now (POST /poll-work)
 * instead of waiting for its next scheduled cycle. Fire-and-gaffert: the tick runs
 * async, so we show an immediate running state, then refresh the board so any
 * freshly-claimed work surfaces. A NOT_CONFIGURED (no DISPATCH_TICK_CMD) toasts
 * its message via the shared guard.
 */
function pollWorkButton() {
  const btn = el(
    "button",
    {
      class: "btn",
      type: "button",
      title: "Trigger one factory tick now so claimable work gets picked up",
      onclick: () =>
        runAsyncAction(btn, "Polling…", async () => {
          const res = await api("POST", "/poll-work");
          if (res && res.polled === false) {
            toast(
              "No ready work to deliver — ready a ticket first, or turn on maintenance when idle in Settings → Idle loops.",
              {},
            );
            return;
          }
          if (res && res.idle === "maintenance") {
            toast("No ready work — running the idle maintenance lane…", { ok: true });
          } else toast("Factory tick fired — refreshing the board…", { ok: true });
          router();
        }),
    },
    [icon("activity"), el("span", {}, "Poll for work")],
  );
  return btn;
}

/** The repo-level / node-level target picker for "Suggest work" (Feature B). */
function openSuggestWorkPicker(repos, nodes) {
  const state = { level: "repo" };

  const repoSel = el("select", {}, [
    el("option", { value: "" }, repos.length ? "Select a repo…" : "No repos yet"),
    ...repos.map((r) => el("option", { value: r.name }, r.name)),
  ]);
  const nodeSel = el("select", {}, [
    el("option", { value: "" }, nodes.length ? "Select a scope node…" : "No scope nodes yet"),
    ...nodes.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  ]);

  const repoBlock = el("div", { class: "where-block" }, [field("Repository", repoSel)]);
  const nodeBlock = el("div", { class: "where-block" }, [
    field("Scope node", nodeSel),
    el(
      "p",
      { class: "mode-note dim" },
      "Runs the product-owner once per repo mapped to this node (bounded).",
    ),
  ]);

  const repoMode = el("input", { type: "radio", name: "po-level", value: "repo", checked: "" });
  const nodeMode = el("input", { type: "radio", name: "po-level", value: "node" });
  const applyMode = () => {
    repoBlock.hidden = state.level !== "repo";
    nodeBlock.hidden = state.level !== "node";
  };
  repoMode.addEventListener("change", () => {
    if (repoMode.checked) {
      state.level = "repo";
      applyMode();
    }
  });
  nodeMode.addEventListener("change", () => {
    if (nodeMode.checked) {
      state.level = "node";
      applyMode();
    }
  });
  applyMode();

  const runBtn = el("button", { class: "btn primary", type: "submit" }, "Run product-owner");
  const form = el(
    "form",
    {
      class: "form-grid",
      onsubmit: (e) => {
        e.preventDefault();
        let body;
        if (state.level === "repo") {
          if (!repoSel.value) {
            toast("Pick a repo to target.");
            return;
          }
          body = { repo: repoSel.value };
        } else {
          if (!nodeSel.value) {
            toast("Pick a scope node to target.");
            return;
          }
          body = { scopeNodeId: nodeSel.value };
        }
        // RUN-ACTIVITY: keep the button "running" until the REAL product-owner
        // run finishes (not just the millisecond spawn-ack, which is the bug this
        // fixes). `fn` returns the tracked run id(s); runAsyncActionUntilDone keeps
        // the button disabled + spinning while any of them is active (polling
        // GET /api/runs), then restores it. The "Running now" panel reflects the
        // same run live in parallel.
        runAsyncActionUntilDone(runBtn, "Suggesting work…", async () => {
          const res = await api("POST", "/product-owner/runs", body);
          const t = res.target || {};
          const msg =
            t.level === "node"
              ? `Node run started for '${t.scope_node_name || ""}' — ${res.ran ?? 0} repo${res.ran === 1 ? "" : "s"}${res.truncated ? " (truncated)" : ""}.`
              : `Repo run started for '${t.repo || repoSel.value}'.`;
          toast(msg, { ok: true });
          // Surface the live run in the Overview panel immediately, but keep this
          // sheet open so the button itself stays in its true running state until
          // the run flips (the whole point of the fix).
          // Collect the tracked run id(s) to wait on: node-level fans out to
          // res.runs[].run.runId; repo-level is res.run.runId.
          if (t.level === "node") {
            return (res.runs || []).map((r) => r.run && r.run.runId).filter(Boolean);
          }
          return res.run && res.run.runId ? [res.run.runId] : [];
        }).then(() => {
          // Run finished (or the safety cap elapsed) — close the sheet and refresh.
          closeSheet();
          router();
        });
      },
    },
    [
      el("div", { class: "mode-toggle" }, [
        el("label", { class: "mode-option" }, [
          repoMode,
          el("span", {}, [
            el("strong", {}, "Repo-level"),
            el("span", { class: "dim" }, " — one repo"),
          ]),
        ]),
        el("label", { class: "mode-option" }, [
          nodeMode,
          el("span", {}, [
            el("strong", {}, "Node-level"),
            el("span", { class: "dim" }, " — a scope's repos"),
          ]),
        ]),
      ]),
      repoBlock,
      nodeBlock,
      el("div", { class: "btn-row" }, [runBtn]),
    ],
  );

  openSheet("Suggest work", form);
}

// --- "Running now" panel (RUN-ACTIVITY) -------------------------------------

/** Human label for a run kind (the backend's snake_case → a readable noun). */
const RUN_KIND_LABELS = {
  product_owner: "Suggest work",
  onboard: "Onboard repo",
  poll_work: "Poll for work",
  merge: "Merge",
  other: "Run",
};
function runKindLabel(kind) {
  return RUN_KIND_LABELS[kind] || kind || "Run";
}

/** Badge tone for a finished run's status. */
function runStatusBadge(status) {
  const tone =
    status === "succeeded"
      ? "ok"
      : status === "failed"
        ? "danger"
        : status === "unknown"
          ? "warn"
          : "";
  return badge(status, tone);
}

/** Elapsed/duration text for a run row, from its start (+ end when finished). */
function runDuration(run) {
  const start = Date.parse(run.started_at);
  if (Number.isNaN(start)) return "—";
  const end = run.ended_at ? Date.parse(run.ended_at) : Date.now();
  return fmtDuration(end - start);
}

/** Open the captured log for a finished run in a sheet (best-effort fetch). */
async function viewRunLog(run) {
  const body = el("div", { class: "run-log" }, [el("p", { class: "dim" }, "Loading log…")]);
  openSheet(`${runKindLabel(run.kind)} log`, body);
  try {
    const tok = authToken();
    const res = await fetch(`/api/runs/${encodeURIComponent(run.id)}/log`, {
      headers: tok ? { authorization: "Bearer " + tok } : {},
    });
    clear(body);
    if (!res.ok) {
      body.appendChild(
        el(
          "p",
          { class: "dim" },
          res.status === 404 ? "No log captured for this run." : "Could not load the log.",
        ),
      );
      return;
    }
    const text = await res.text();
    body.appendChild(
      el("pre", { class: "run-log-pre" }, text && text.trim() ? text : "(log is empty)"),
    );
  } catch {
    clear(body);
    body.appendChild(el("p", { class: "dim" }, "Could not load the log."));
  }
}

/**
 * Open the run-detail drawer for a run. Fetches GET /api/runs/:id and renders
 * phase · turns · spend + a streaming factory-log tail. For active runs it polls
 * every 3s until the run settles; the timer is cleared when the sheet closes.
 *
 * Zero-state safe: missing detail fields render as "—".
 */
function viewRunDetail(runId, kindLabel) {
  const POLL_MS = 3000;
  let detailTimer = null;

  const metaBar = el("div", { class: "run-detail-meta" });
  const logSection = el("div", { class: "run-detail-log" });
  const body = el("div", { class: "run-detail" }, [metaBar, logSection]);

  // Intercept sheet close to cancel polling.
  const origClose = closeSheet;
  const cleanup = () => {
    if (detailTimer !== null) {
      clearInterval(detailTimer);
      detailTimer = null;
    }
  };

  openSheet(`${kindLabel} · detail`, body);

  // Patch the sheet close button to also clear the timer (one-shot: the next
  // openSheet call will rebuild the head, so this is safe).
  const closeBtn = document.querySelector(".sheet-head .icon-btn");
  if (closeBtn) {
    const orig = closeBtn.onclick;
    closeBtn.onclick = () => {
      cleanup();
      if (orig) orig();
      else origClose();
    };
  }

  const fmtCost = (usd) => (usd > 0 ? money(usd) : null);
  const fmtTurns = (n) => (n > 0 ? `${n} turn${n === 1 ? "" : "s"}` : null);

  const renderDetail = (detail) => {
    clear(metaBar);
    clear(logSection);

    const chips = [];
    if (detail.phase) chips.push(el("span", { class: "run-detail-chip" }, detail.phase));
    const turns = fmtTurns(detail.num_turns);
    if (turns) chips.push(el("span", { class: "run-detail-chip dim" }, turns));
    const cost = fmtCost(detail.cost_usd);
    if (cost) chips.push(el("span", { class: "run-detail-chip tabnum" }, cost));
    // Honest cost: an estimate is labelled, an unmeasured call is counted, an
    // unreadable ledger is "unknown" — never a silent $0.
    if (detail.estimated_usd > 0) {
      chips.push(
        el(
          "span",
          {
            class: "run-detail-chip dim",
            title: "includes the runner's estimate for killed / timed-out calls",
          },
          `incl. ${money(detail.estimated_usd)} est.`,
        ),
      );
    }
    if (detail.unknown_calls > 0) {
      chips.push(
        el(
          "span",
          { class: "run-detail-chip warn", title: "calls whose usage the CLI did not report" },
          `${detail.unknown_calls} call${detail.unknown_calls === 1 ? "" : "s"} unmeasured`,
        ),
      );
    }
    if (detail.cost_status === "unreadable") {
      chips.push(el("span", { class: "run-detail-chip warn" }, "cost unknown (ledger unreadable)"));
    }
    if (detail.outcome) {
      const tone =
        detail.outcome === "in_review"
          ? "ok"
          : detail.outcome === "FAILED" || detail.outcome === "FLAGGED"
            ? "danger"
            : "warn";
      chips.push(badge(detail.outcome, tone));
    } else if (detail.run.status === "running") {
      chips.push(el("span", { class: "run-spinner run-spinner--sm", "aria-hidden": "true" }));
    }
    if (chips.length) metaBar.appendChild(el("div", { class: "run-detail-chips" }, chips));
    if (detail.ticket_number !== null) {
      metaBar.appendChild(
        el("p", { class: "run-detail-ticket dim" }, `Ticket #${detail.ticket_number}`),
      );
    }

    if (detail.log_tail) {
      logSection.appendChild(
        el("pre", { class: "run-log-pre run-detail-log-pre" }, detail.log_tail),
      );
    } else if (detail.run.status !== "running") {
      logSection.appendChild(el("p", { class: "dim" }, "No log captured for this run."));
    } else {
      logSection.appendChild(el("p", { class: "dim" }, "Waiting for log output…"));
    }
  };

  const fetchDetail = async () => {
    try {
      const data = await api("GET", `/api/runs/${encodeURIComponent(runId)}`);
      if (!document.querySelector(".sheet.open")) {
        cleanup();
        return;
      }
      renderDetail(data.detail);
      // Stop polling once the run has settled (no longer running).
      if (data.detail.run.status !== "running") {
        cleanup();
      }
    } catch {
      // Leave the last paint on transient errors.
    }
  };

  // Initial paint: show a loading placeholder, then fetch.
  metaBar.appendChild(el("p", { class: "dim" }, "Loading…"));
  fetchDetail();

  detailTimer = setInterval(() => {
    if (!document.querySelector(".sheet.open")) {
      cleanup();
      return;
    }
    fetchDetail();
  }, POLL_MS);
}

/**
 * Format a USD cost for inline display in a run row.
 * Returns null when cost is zero/unknown (so no chip is rendered).
 */
function runCostChip(costUsd) {
  if (!costUsd || costUsd <= 0) return null;
  return el("span", { class: "run-cost-chip tabnum dim" }, money(costUsd));
}

/** One active run row: kind · repo · phase · elapsed · spinner · detail button. */
function activeRunRow(run) {
  // `run._phase` and `run._cost_usd` are injected by the enriched list render.
  const phaseChip = run._phase ? el("span", { class: "run-phase-chip dim" }, run._phase) : null;
  const costChip = runCostChip(run._cost_usd);
  return el(
    "li",
    {
      class: "run-row run-active run-row--clickable",
      onclick: () => viewRunDetail(run.id, runKindLabel(run.kind)),
      title: "Click to view live detail",
    },
    [
      el("span", { class: "run-spinner", "aria-hidden": "true" }),
      el("span", { class: "run-kind" }, runKindLabel(run.kind)),
      run.repo
        ? el(
            "span",
            { class: "run-repo dim", title: run.repo },
            String(run.repo).split("/").filter(Boolean).pop() || run.repo,
          )
        : null,
      phaseChip,
      costChip,
      el(
        "span",
        { class: "run-elapsed dim tabnum", title: `started ${fmtTime(run.started_at)}` },
        runDuration(run),
      ),
    ],
  );
}

/** One finished run row: kind · repo · phase · status · cost · duration · view-log. */
function finishedRunRow(run) {
  const phaseChip = run._phase ? el("span", { class: "run-phase-chip dim" }, run._phase) : null;
  const costChip = runCostChip(run._cost_usd);
  return el("li", { class: "run-row run-done" }, [
    el("span", { class: "run-kind" }, runKindLabel(run.kind)),
    run.repo
      ? el(
          "span",
          { class: "run-repo dim", title: run.repo },
          String(run.repo).split("/").filter(Boolean).pop() || run.repo,
        )
      : null,
    phaseChip,
    runStatusBadge(run.status),
    costChip,
    el(
      "span",
      { class: "run-elapsed dim tabnum", title: `ended ${fmtTime(run.ended_at)}` },
      runDuration(run),
    ),
    run.log_path
      ? el(
          "button",
          { class: "btn small run-viewlog", type: "button", onclick: () => viewRunLog(run) },
          "view log",
        )
      : null,
  ]);
}

/**
 * The "Running now" panel: a compact card that polls GET /api/runs?active=1
 * every ~3s, showing each in-flight run (kind · repo · elapsed · spinner) and
 * the most-recent finished runs (status · duration · view-log). When there are
 * zero active and zero recent it renders a quiet empty state instead of clutter.
 *
 * Lifecycle: the poll self-terminates once the panel node is detached from the
 * DOM (a view change rebuilds Overview from scratch), so no global teardown hook
 * is needed. The first paint is synchronous-ish (an immediate fetch) so the card
 * never flashes empty before the first interval.
 */
function runActivityPanel() {
  const POLL_MS = 3000;
  const card = el("div", { class: "card panel run-activity", id: "running-now" }, [
    panelHead("Running now", "background runs"),
  ]);
  const listWrap = el("div", { class: "run-activity-body" }, [
    el("p", { class: "dim" }, "Loading runs…"),
  ]);
  card.appendChild(listWrap);

  let stopped = false;

  const render = (active, recent) => {
    clear(listWrap);
    if ((!active || active.length === 0) && (!recent || recent.length === 0)) {
      listWrap.appendChild(
        emptyState("Nothing running.", "Polls, suggestions and merges you start show up here."),
      );
      return;
    }
    if (active && active.length) {
      listWrap.appendChild(el("ul", { class: "run-list" }, active.map(activeRunRow)));
    }
    if (recent && recent.length) {
      listWrap.appendChild(el("div", { class: "run-recent-title dim" }, "Recently finished"));
      // The last eight; the rest fold away (a busy day lists dozens).
      listWrap.appendChild(el("ul", { class: "run-list" }, recent.slice(0, 8).map(finishedRunRow)));
      if (recent.length > 8)
        listWrap.appendChild(
          el("details", { class: "run-more" }, [
            el("summary", {}, `${recent.length - 8} more finished`),
            el("ul", { class: "run-list" }, recent.slice(8).map(finishedRunRow)),
          ]),
        );
    }
  };

  /**
   * Fetch the enriched detail for a run (best-effort). Returns the detail
   * object on success, null on any error. Used to inject phase + cost_usd into
   * run rows without blocking the main list render.
   */
  const fetchRunDetail = async (runId) => {
    try {
      const data = await api("GET", `/api/runs/${encodeURIComponent(runId)}`);
      return data.detail || null;
    } catch {
      return null;
    }
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const data = await api("GET", "/api/runs?active=1");
      // Don't paint into a panel that's been detached mid-flight (view changed).
      if (stopped) return;
      const active = data.active || [];
      const recent = data.recent || [];

      // Enrich active runs with phase + cost_usd via parallel detail fetches
      // (best-effort: failures leave the fields unset, rows still render).
      if (active.length > 0) {
        const details = await Promise.all(active.map((r) => fetchRunDetail(r.id)));
        if (!stopped) {
          for (let i = 0; i < active.length; i++) {
            const d = details[i];
            if (d) {
              active[i]._phase = d.phase || null;
              active[i]._cost_usd = d.cost_usd || 0;
            }
          }
        }
      }

      if (!stopped) render(active, recent);
    } catch {
      // A transient read failure shouldn't blank the panel; leave the last paint.
    }
  };

  // Immediate first paint (the card is still being assembled into the view, so we
  // do NOT gate this on attachment — only the recurring interval self-terminates
  // on detach, once the card has actually been mounted).
  poll();
  const timer = setInterval(() => {
    if (stopped || !document.body.contains(card)) {
      clearInterval(timer);
      stopped = true;
      return;
    }
    poll();
  }, POLL_MS);

  return card;
}

// Repos + scope nodes change rarely; the 9s refresh reuses them for a minute
// instead of re-fetching both on every tick (board-unbounded-render).
const WORK_REF_TTL_MS = 60000;
let workRefCache = null;
async function workReference() {
  if (workRefCache && Date.now() - workRefCache.at < WORK_REF_TTL_MS) return workRefCache;
  const [reposRes, nodesRes] = await Promise.all([
    api("GET", "/repositories"),
    api("GET", "/scope/nodes"),
  ]);
  workRefCache = {
    at: Date.now(),
    repos: reposRes.repositories || [],
    nodes: nodesRes.nodes || [],
  };
  return workRefCache;
}

async function renderWork() {
  readWorkStateFromUrl();

  // Board endpoint powers the board; the filtered /tickets list powers list mode
  // (list mode does not fetch the board at all). Repos + scope nodes feed the
  // "Suggest work" target picker (Feature B) and the repo filter.
  const boardQs = workState.repo ? `?repo=${encodeURIComponent(workState.repo)}` : "";
  const [board, ref] = await Promise.all([
    workState.mode === "list" ? null : api("GET", `/api/board${boardQs}`),
    workReference(),
  ]);
  const { repos, nodes } = ref;
  const columns = (board && board.columns) || [];
  const closed = (board && board.closed) || [];
  const wontDo = (board && board.wontDo) || [];
  const counts = boardCounts(columns, closed, wontDo);

  const wrap = el("div", { class: "view view-work" });

  const modeToggle = el("div", { class: "segmented", role: "tablist", "aria-label": "View mode" }, [
    el(
      "button",
      {
        class: workState.mode === "board" ? "active" : "",
        type: "button",
        role: "tab",
        "aria-selected": String(workState.mode === "board"),
        onclick: () => {
          workState.mode = "board";
          writeWorkStateToUrl();
        },
      },
      "Board",
    ),
    el(
      "button",
      {
        class: workState.mode === "list" ? "active" : "",
        type: "button",
        role: "tab",
        "aria-selected": String(workState.mode === "list"),
        onclick: () => {
          workState.mode = "list";
          writeWorkStateToUrl();
        },
      },
      "List",
    ),
  ]);

  wrap.appendChild(
    viewHead(
      "Work board",
      board ? workSummaryLine(columns, counts) : "Every ticket, one row each.",
      [pollWorkButton(), suggestWorkButton(repos, nodes)],
    ),
  );
  wrap.appendChild(el("div", { class: "view-toolbar" }, [renderWorkFilters(repos), modeToggle]));
  if (workState.mode === "board")
    wrap.appendChild(workFlowHeader(columns, { failed: closed.length }));

  if (workState.mode === "list") {
    wrap.appendChild(await renderWorkList());
  } else {
    wrap.appendChild(renderBoard(columns, closed, wontDo));
  }

  // Active claims — folded in as a collapsible panel (replaces the Claims tab).
  const claimsPanel = await renderClaimsPanel();
  wrap.appendChild(claimsPanel);

  // Change signature: an unchanged board (same payload, same filters) is not
  // re-rendered by the background refresh, so nothing on it moves.
  if (board)
    wrap.dataset.sig = `${hashText(JSON.stringify(board))}:${location.hash}:${claimsPanel.dataset.sig || ""}`;

  return wrap;
}

/** A short, stable hash of a string (djb2) for change signatures. */
function hashText(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * One set of board counts, used by the header line, the flow strip and the lane
 * heads alike, so they can never disagree (work-shipped-count-wrong):
 *   live    = every lane except Done (draft … ready for merge)
 *   shipped = the Done lane
 *   failed  = the closed area (the board puts only `failed` tickets there)
 *   wontDo  = cancelled
 */
function boardCounts(columns, closed = [], wontDo = []) {
  const by = {};
  for (const c of columns) by[c.column] = c.total ?? (c.cards || []).length;
  const live = Object.entries(by)
    .filter(([k]) => k !== "done")
    .reduce((n, [, v]) => n + v, 0);
  return { by, live, shipped: by.done || 0, failed: closed.length, wontDo: wontDo.length };
}

/** "25 tickets in lanes: 6 draft · 4 ready … 6 done. 2 failed, listed under Done." */
function workSummaryLine(columns, counts) {
  const parts = columns
    .filter((c) => counts.by[c.column] > 0)
    .map(
      (c) => `${counts.by[c.column]} ${(BOARD_COLUMN_LABELS[c.column] || c.column).toLowerCase()}`,
    );
  const inLanes = counts.live + counts.shipped;
  const extra = [];
  if (counts.failed) extra.push(`${counts.failed} failed`);
  if (counts.wontDo) extra.push(`${counts.wontDo} won't do`);
  return (
    `${inLanes} ${inLanes === 1 ? "ticket" : "tickets"} in lanes${parts.length ? ": " + parts.join(" · ") : ""}.` +
    (extra.length ? ` ${extra.join(", ")}, listed under the board.` : "")
  );
}

/** A flow-summary strip above the board: one cell per lane (built from the
 *  board's own columns, so none is ever left out) plus Failed, and a single
 *  distribution bar so the shape of the board reads before you scan the lanes.
 *  Shipped is the Done lane; failed tickets are counted as failed, never shipped. */
function workFlowHeader(columns, { failed = 0 } = {}) {
  const { by } = boardCounts(columns);
  const cells = columns.map((c) => ({
    key: c.column,
    label: c.column === "done" ? "Shipped" : BOARD_COLUMN_LABELS[c.column] || c.column,
    v: by[c.column] || 0,
  }));
  cells.push({ key: "failed", label: "Failed", v: failed });
  const flowTotal = Math.max(
    1,
    cells.reduce((n, c) => n + c.v, 0),
  );
  const seg = cells
    .filter((c) => c.v > 0)
    .map((c) =>
      el("span", {
        class: `wf-seg wf-${c.key}`,
        style: `width:${(c.v / flowTotal) * 100}%`,
        title: `${c.label}: ${c.v}`,
      }),
    );
  // The lane heads already carry each count, so this is one slim distribution
  // bar (the shape of the board before you scan it), its numbers in its name.
  const label = cells.map((c) => `${c.label} ${c.v}`).join(", ");
  return el(
    "div",
    { class: "work-flow", role: "img", "aria-label": `Tickets per lane: ${label}` },
    [el("div", { class: "wf-bar" }, seg)],
  );
}

function renderWorkFilters(repos) {
  const statusSel = el(
    "select",
    {
      "aria-label": "Filter by status",
      onchange: (e) => {
        workState.status = e.target.value;
        writeWorkStateToUrl();
      },
    },
    [
      el("option", { value: "" }, "All statuses"),
      ...TICKET_STATUSES.map((s) =>
        el("option", { value: s, selected: workState.status === s }, statusLabel(s)),
      ),
    ],
  );
  const repoSel = el(
    "select",
    {
      "aria-label": "Filter by repo",
      onchange: (e) => {
        workState.repo = e.target.value;
        writeWorkStateToUrl();
      },
    },
    [
      el("option", { value: "" }, "All repos"),
      ...repos.map((r) =>
        el("option", { value: r.name, selected: workState.repo === r.name }, r.name),
      ),
    ],
  );
  const riskSel = el(
    "select",
    {
      "aria-label": "Filter by risk",
      onchange: (e) => {
        workState.risk = e.target.value;
        writeWorkStateToUrl();
      },
    },
    [
      el("option", { value: "" }, "All risk"),
      ...RISK_LEVELS.map((r) => el("option", { value: r, selected: workState.risk === r }, r)),
    ],
  );
  const reset = el(
    "button",
    {
      class: "btn small",
      type: "button",
      onclick: () => {
        workState.status = "";
        workState.repo = "";
        workState.risk = "";
        writeWorkStateToUrl();
      },
    },
    "Reset",
  );
  return el("div", { class: "filters" }, [
    field("Status", statusSel),
    field("Repo", repoSel),
    field("Risk", riskSel),
    el("div", { class: "field", style: "flex:0 0 auto" }, [el("label", { html: "&nbsp;" }), reset]),
  ]);
}

// --- Board moves (drag-to-move + touch status menu) -------------------------
//
// The board lets a human re-organise work by dragging a card into another status
// column — the headline case being un-readying a ticket (Ready → Draft), which
// has no other path. The legal target columns per status MIRROR the backend
// state machine (src/services/transitionService.ts ALLOWED). This map is only a
// UX hint (it drives the not-allowed cue + the touch menu); the server is the
// source of truth and an illegal move is rolled back with an error toast.
//
// Column key → canonical status it represents. (claimed/in_progress collapse.)
const MOVE_TARGETS_BY_STATUS = {
  draft: ["ready"],
  refining: ["ready", "draft"],
  ready: ["draft"],
  blocked: ["ready"],
  // in_review can be un-readied back to `ready`. It does NOT drag to `done`
  // anymore — approval goes through Review (in_review -> ready_for_merge) and the
  // merge runner confirms the merge (ready_for_merge -> done), so `done` can never
  // be conjured by a board-drag.
  in_review: ["ready"],
  // ready_for_merge / claimed / in_progress / done / failed / cancelled: no safe
  // human board move — a card in these states is not draggable. ready_for_merge in
  // particular has NO board target: marking merged is a guarded system action and
  // rework/reopen go through the review surface, never a drag.
};
function legalTargetColumns(status) {
  return MOVE_TARGETS_BY_STATUS[status] || [];
}
function cardIsMovable(card) {
  return legalTargetColumns(card.status).length > 0 && !card.claim;
}

// --- State-aware action sets (single source of truth) -----------------------
//
// Every ticket/review action set is DRIVEN OFF THIS ONE MAP so the options can
// never drift between the detail page and the review surface. The headline bug
// this fixes: "Mark ready" used to appear in `in_review` (and would throw the
// ticket back to the start). It is now offered ONLY where it is legal — never for
// `in_review`, `ready_for_merge`, or `done`.
//
// Each action is a stable key; the renderers map a key to a concrete button. The
// backend remains the source of truth (an illegal call still comes back as an
// error); this map only decides what to OFFER.
const TICKET_ACTION_KEYS = {
  draft: ["mark_ready", "wont_do"],
  refining: ["mark_ready", "wont_do"],
  // Live/claimed states have no human button here — work is owned by an agent.
  ready: [],
  claimed: [],
  in_progress: [],
  blocked: ["unblock", "wont_do"],
  // Review surface: approve takes the ticket to `ready_for_merge` (merging).
  in_review: ["approve", "rework", "wont_do"],
  // BBT-001: independent testing lane. The tester agent owns the verdict (pass →
  // ready_for_merge, fail → refining); a human can also record it from here when the
  // lane is off, held (no verdict token) or the operator tested by hand.
  in_testing: ["tester_pass", "tester_fail"],
  // Approved-and-merging: the merge runner is working. A human can mark it merged
  // (admin override) or send it back for rework — but NOT "mark ready".
  ready_for_merge: ["merge_now", "mark_merged", "rework"],
  // Terminal: reopen only where allowed (cancelled is reopenable; done is not).
  done: [],
  failed: ["unblock"],
  cancelled: ["reopen"],
  // PAUSE-ON-CAP: a paused (cap-hit) delivery offers one-click Continue (re-enter
  // the existing worktree) or Stop (tear down + abandon). The banner above the bar
  // surfaces the reason + spend-so-far.
  paused: ["pause_continue", "pause_stop"],
};
function ticketActionKeys(status) {
  return TICKET_ACTION_KEYS[status] || [];
}
function hasTicketAction(status, key) {
  return ticketActionKeys(status).includes(key);
}

/**
 * Move a card to a target column with an optimistic UI update + rollback. The
 * DOM card is moved into the destination column immediately; on a backend
 * rejection (illegal transition, policy, concurrency) it snaps back and an error
 * toast surfaces the API code. On success the board re-renders so counts, claim
 * state and pipeline dots stay truthful.
 */
async function performBoardMove(cardEl, card, toColumn) {
  if (card.status === toColumn) return; // dropped on its own column — no-op.
  const fromBody = cardEl.parentElement;
  const placeholder = document.createComment("wg-move");
  fromBody.insertBefore(placeholder, cardEl);
  const destBody = document.querySelector(`.board-col.col-${toColumn} .board-col-body`);
  if (destBody) {
    const dash = destBody.querySelector(".board-empty");
    if (dash) dash.remove();
    destBody.appendChild(cardEl);
  }
  cardEl.classList.add("is-moving");
  try {
    await api("POST", `/tickets/${card.id}/move`, { to: toColumn });
    toast(`Moved to ${BOARD_COLUMN_LABELS[toColumn] || toColumn}`, { ok: true });
    router(); // refresh truthfully (counts/claim/dots) once the move landed.
  } catch (e) {
    // Rollback: restore the card to where the drag started.
    if (placeholder.parentElement) placeholder.parentElement.insertBefore(cardEl, placeholder);
    cardEl.classList.remove("is-moving");
    toast(e.message || "Move rejected", { code: e.code });
  } finally {
    if (placeholder.parentElement) placeholder.remove();
  }
}

/** Open the touch/keyboard status menu for a card (drag-free fallback). */
function openMoveMenu(card, anchorEl) {
  const targets = legalTargetColumns(card.status);
  if (!targets.length) return;
  const items = targets.map((col) =>
    el(
      "button",
      {
        class: "movemenu-item",
        type: "button",
        role: "menuitem",
        onclick: () => {
          closeMoveMenu();
          const node = anchorEl.closest(".board-card");
          if (node) guard(() => performBoardMove(node, card, col));
        },
      },
      [
        el("span", { class: `movemenu-dot col-${col}` }),
        `Move to ${BOARD_COLUMN_LABELS[col] || col}`,
      ],
    ),
  );
  const menu = el("div", { class: "movemenu", role: "menu", "aria-label": "Move ticket to" }, [
    el("div", { class: "movemenu-head" }, card.number != null ? `#${card.number}` : "Move ticket"),
    ...items,
  ]);
  const scrim = el("div", { class: "movemenu-scrim", onclick: closeMoveMenu });
  scrim.appendChild(menu);
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.body.appendChild(scrim);
  moveMenuScrim = scrim;
  document.addEventListener("keydown", moveMenuKeydown);
}
let moveMenuScrim = null;
function closeMoveMenu() {
  if (moveMenuScrim) {
    moveMenuScrim.remove();
    moveMenuScrim = null;
  }
  document.removeEventListener("keydown", moveMenuKeydown);
}
function moveMenuKeydown(e) {
  if (e.key === "Escape") closeMoveMenu();
}

/**
 * The board renders a bounded number of cards per lane: the whole Done history
 * (and a runaway live lane) would otherwise grow the DOM forever and jank every
 * 9s refresh (board-unbounded-render). Done shows the newest BOARD_DONE_CAP;
 * live lanes show BOARD_LANE_CAP. The lane head always shows the TRUE count, and
 * the remainder is one link away in the List view, filtered to that status.
 */
const BOARD_DONE_CAP = 25;
const BOARD_LANE_CAP = 60;
const BOARD_CLOSED_CAP = 25;
function capLane(column, cards) {
  if (column === "done") {
    const newest = [...cards].sort((a, b) =>
      String(b.updated_at || "").localeCompare(String(a.updated_at || "")),
    );
    return newest.slice(0, BOARD_DONE_CAP);
  }
  return cards.slice(0, BOARD_LANE_CAP);
}
function laneMoreLink(column, shown, total) {
  if (total <= shown) return null;
  return el(
    "a",
    { class: "lane-more", href: `#/work?mode=list&status=${encodeURIComponent(column)}` },
    `Showing ${shown} of ${total} — see all in the list`,
  );
}

/** Board (kanban) — columns by status; filters dim non-matching cards client-side. */
function renderBoard(columns, closed, wontDo = []) {
  const wrap = el("div", { class: "board-wrap" });
  // repo is filtered server-side via ?repo= on /api/board; only status and
  // risk need client-side filtering here (no repo field on BoardCard).
  const matches = (card) =>
    (!workState.status || card.status === workState.status) &&
    (!workState.risk || card.risk_level === workState.risk);

  const cols = el(
    "div",
    { class: "board" },
    columns.map((c, laneIdx) => {
      const all = (c.cards || []).filter(matches);
      const cards = capLane(c.column, all);
      const body = el(
        "div",
        { class: "board-col-body" },
        cards.length
          ? [...cards.map(renderBoardCard), laneMoreLink(c.column, cards.length, all.length)]
          : el("div", { class: "board-empty" }, "Nothing here."),
      );
      const label = BOARD_COLUMN_LABELS[c.column] || c.column;
      const section = el(
        "section",
        {
          class: `board-col col-${c.column} ${laneIdx % 2 ? "lane-b" : "lane-a"}`,
          dataset: { column: c.column },
          "aria-label": `${label}: ${all.length}`,
        },
        [
          el("div", { class: "board-col-head" }, [
            glyph(c.column === "ready_for_merge" ? "ready_for_merge" : c.column, 16),
            el("h2", { class: "board-col-title" }, label),
            el("span", { class: "board-col-count tabnum" }, String(all.length)),
          ]),
          body,
        ],
      );
      wireColumnDropZone(section, c.column);
      return section;
    }),
  );
  wrap.appendChild(cols);

  // Won't-do bucket: terminal "will NOT be built" tickets, distinct from rework
  // and from the failed/closed area. Each card carries a discreet "Reopen" action
  // (-> refining) so an abandoned ticket is reversible. Cards are built only when
  // the disclosure is opened.
  const lazyArea = (cls, summary, list, renderOne, open = false) => {
    const details = el("details", { class: cls, open: open ? "" : null });
    details.appendChild(el("summary", {}, summary));
    const body = el("div", { class: "closed-cards" });
    details.appendChild(body);
    const fill = () => {
      if (body.childElementCount) return;
      const shown = list.slice(0, BOARD_CLOSED_CAP);
      shown.forEach((c) => body.appendChild(renderOne(c)));
      if (list.length > shown.length)
        body.appendChild(
          el("p", { class: "section-note" }, `Showing ${shown.length} of ${list.length}.`),
        );
    };
    if (open) fill();
    details.addEventListener("toggle", () => details.open && fill());
    return details;
  };
  const wontDoVisible = wontDo.filter(matches);
  if (wontDoVisible.length) {
    wrap.appendChild(
      lazyArea(
        "closed-area wont-do-area",
        `Won't do (${wontDoVisible.length})`,
        wontDoVisible,
        renderWontDoCard,
        true,
      ),
    );
  }
  if (closed.length) {
    wrap.appendChild(lazyArea("closed-area", `Failed (${closed.length})`, closed, renderBoardCard));
  }
  return wrap;
}

/** A won't-do bucket card: the board card plus a discreet reopen-to-refining action. */
function renderWontDoCard(card) {
  const reopen = el(
    "button",
    {
      class: "btn small",
      type: "button",
      title: "Reopen this ticket into refining",
      onclick: (e) => {
        e.stopPropagation();
        guard(async () => {
          await api("POST", `/tickets/${card.id}/reopen`, { to: "refining" });
          toast("Reopened to refining", { ok: true });
          router();
        });
      },
    },
    "Reopen",
  );
  const wrap = el("div", { class: "wont-do-card" }, [
    renderBoardCard(card),
    el("div", { class: "btn-row" }, [reopen]),
  ]);
  return wrap;
}

/**
 * Make a column a HTML5 drop target. While a movable card is dragging, columns
 * that can legally accept it light up (cyan accent); columns that can't show a
 * not-allowed cursor and never accept the drop.
 */
function wireColumnDropZone(section, column) {
  section.addEventListener("dragover", (e) => {
    if (!draggingCard) return;
    if (legalTargetColumns(draggingCard.status).includes(column)) {
      e.preventDefault(); // allow the drop
      e.dataTransfer.dropEffect = "move";
      section.classList.add("drop-ok");
    } else {
      e.dataTransfer.dropEffect = "none";
      section.classList.add("drop-no");
    }
  });
  section.addEventListener("dragleave", (e) => {
    // Only clear when actually leaving the column (not crossing a child boundary).
    if (e.target === section || !section.contains(e.relatedTarget)) {
      section.classList.remove("drop-ok", "drop-no");
    }
  });
  section.addEventListener("drop", (e) => {
    section.classList.remove("drop-ok", "drop-no");
    if (!draggingCard || !draggingEl) return;
    if (!legalTargetColumns(draggingCard.status).includes(column)) return;
    e.preventDefault();
    const cardEl = draggingEl,
      card = draggingCard;
    guard(() => performBoardMove(cardEl, card, column));
  });
}

// The card currently being dragged (set on dragstart, cleared on dragend) so
// drop zones can decide legality without serialising state into dataTransfer.
let draggingCard = null;
let draggingEl = null;

/** A keyboard-reachable kanban card → ticket detail; carries pipeline-dots. */
/**
 * TRACK-2b: the human WIP lane's per-card action. A `ready` card gets an "I'll do
 * this by hand" button (human-claim → in_progress owned by you, so the agent loop
 * skips it); a human-owned in_progress card gets a "Hand back" button (release →
 * ready). Both POST the dedicated endpoints and re-render on success. Returns null
 * for cards with no human-lane action (agent-claimed / other states).
 */
function humanLaneAction(card) {
  const post = async (path, verb) => {
    try {
      await api("POST", `/tickets/${card.id}/${path}`, {});
      toast(verb, { ok: true });
      router();
    } catch (e) {
      toast(e.message || "Action rejected", { code: e.code });
    }
  };
  if (card.humanOwner) {
    return el(
      "button",
      {
        class: "card-human-btn hand-back",
        type: "button",
        title: "Hand this ticket back to the queue so an agent can pick it up",
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          guard(() => post("human-release", "Handed back to the queue"));
        },
      },
      "Hand back",
    );
  }
  // Only a genuinely-claimable ready ticket (no agent claim) can be taken by hand.
  if (card.status === "ready" && !card.claim) {
    return el(
      "button",
      {
        class: "card-human-btn take-myself",
        type: "button",
        title: "Take this ticket by hand — the agent will stay out of it",
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          guard(() => post("human-claim", "You're on it — taken by hand"));
        },
      },
      "I'll do this by hand",
    );
  }
  return null;
}

function renderBoardCard(card) {
  const chips = el("div", { class: "card-chips" }, [
    riskBadge(card.risk_level),
    el("span", { class: "tabnum dim", title: "priority" }, `P${card.priority}`),
    card.blockingCount ? badge(`${card.blockingCount} blocking`, "status-blocked") : null,
  ]);

  let acText = null;
  if (card.acEvidenceRequired > 0)
    acText = `${card.acEvidenced}/${card.acEvidenceRequired} evidenced`;
  else if (card.acTotal > 0) acText = `${card.acSatisfied}/${card.acTotal} satisfied`;

  // TRACK-2b: a ticket the operator took "by hand" is THEIR in-flight work, not the
  // agent's. Render it distinctly (a "By hand" marker with the human-owner) so the
  // human WIP lane reads apart from an agent claim. This branch wins over the agent
  // claim/pipeline-dots — a human-owned ticket never carries an agent claim.
  const ownerMarker = card.humanOwner
    ? el(
        "span",
        { class: "card-human-owned", title: `You're working this by hand (${card.humanOwner})` },
        [el("span", { class: "human-dot" }), "By hand", ` · ${card.humanOwner}`],
      )
    : card.claim
      ? el(
          "span",
          {
            class: `card-claim${card.claim.stale ? " stale" : ""}`,
            title: card.claim.stale ? "Lease past expiry" : "Lease active",
          },
          [
            agentTag(card.claim.agentDisplayName || card.claim.agentId.slice(0, 8), 20),
            card.claim.stale ? " · stale" : "",
          ],
        )
      : pipelineDots(card.status);

  const meta = el("div", { class: "card-meta" }, [
    acText ? el("span", { class: "ac-progress" }, acText) : el("span", { class: "dim" }, "no AC"),
    ownerMarker,
  ]);

  // Repo cross-link (audit: "no path from a card to its repo"). A card is an
  // <a> to its ticket, so the repo chips are buttons that stopPropagation and
  // navigate to #/repo/:id — one hop to the repo, no ticket-open side effect.
  const cardRepos = card.repos || [];
  const repoChips = cardRepos.length
    ? el("div", { class: "card-repos" }, [
        ...cardRepos.slice(0, 2).map((r) =>
          el(
            "button",
            {
              class: "card-repo-chip",
              type: "button",
              title: `Open ${r.name}`,
              onclick: (e) => {
                e.preventDefault();
                e.stopPropagation();
                navigate(`#/repo/${encodeURIComponent(r.id || r.name)}`);
              },
            },
            [kitShirt(r.name, 16), el("span", {}, r.name)],
          ),
        ),
        cardRepos.length > 2
          ? el("span", { class: "card-repo-more dim" }, `+${cardRepos.length - 2}`)
          : null,
      ])
    : null;

  const go = () => navigate(`#/ticket/${card.id}`);
  const movable = cardIsMovable(card);

  // TRACK-2b dashboard actions: a READY card offers "I'll do this by hand" (human-
  // claim); a human-owned in_progress card offers "Hand back" (release to the queue).
  // Both POST the dedicated endpoints and re-render the board on success.
  const humanLaneBtn = humanLaneAction(card);

  // Touch/keyboard fallback: a small "move" affordance opens a status menu, so
  // the same moves work one-handed on phones where drag is unreliable.
  const moveBtn = movable
    ? el(
        "button",
        {
          class: "card-move-btn",
          type: "button",
          "aria-label": "Move ticket to another status",
          title: "Move to another status",
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            openMoveMenu(card, e.currentTarget);
          },
        },
        el("span", { class: "card-move-grip", "aria-hidden": "true" }, "⋮⋮"),
      )
    : null;

  // WG-049 + rework loop: a ticket bounced back from review OR being reworked in
  // place carries a reason, so a human triaging the board sees WHAT is happening
  // without opening the ticket. Three shapes, keyed off the structured feedback code:
  //   • reworking        → the runner is re-invoking the agent right now (in_progress):
  //                        "Reworking · attempt N/M" so the ticket never looks "gone".
  //   • rework_exhausted → the rework loop hit its attempt/cost ceiling and parked to
  //                        the VISIBLE blocked column: "Rework exhausted".
  //   • (none)           → an ordinary human review rejection: "Rejected".
  const reject = (() => {
    const fb = card.lastReviewFeedback;
    if (!fb) return null;
    const attemptSuffix =
      typeof fb.attempt === "number" && typeof fb.maxAttempts === "number"
        ? ` · attempt ${fb.attempt}/${fb.maxAttempts}`
        : "";
    let label = "Rejected:";
    let cls = "card-reject";
    let title = `Rejected by ${fb.reviewer || "reviewer"}`;
    if (fb.code === "reworking") {
      label = `Reworking${attemptSuffix}:`;
      cls = "card-reject card-reworking";
      title = "Runner is re-invoking the agent";
    } else if (fb.code === "rework_exhausted") {
      label = `Rework exhausted${attemptSuffix}:`;
      cls = "card-reject card-rework-exhausted";
      title = "Rework loop hit its attempt/cost ceiling — needs a human";
    }
    return el("div", { class: cls, title }, [
      el("span", { class: "card-reject-label" }, label),
      " ",
      fb.reason,
    ]);
  })();

  const node = el(
    "a",
    {
      class: `board-card bc-${card.status}${movable ? " is-movable" : ""}`,
      href: `#/ticket/${card.id}`,
      draggable: movable ? "true" : null,
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      },
    },
    [
      el("div", { class: "card-top" }, [
        el("span", { class: "num" }, card.number != null ? `#${card.number}` : card.id.slice(0, 8)),
        // A yellow card: this one waits on you (sign-off, or an approved merge).
        card.status === "in_review" ||
        card.status === "ready_for_merge" ||
        card.status === "blocked"
          ? el(
              "span",
              { class: "card-needs", title: "Needs you", role: "img", "aria-label": "Needs you" },
              ycard(16),
            )
          : null,
      ]),
      el("div", { class: "card-title" }, card.title),
      chips,
      repoChips,
      reject,
      meta,
      humanLaneBtn,
      moveBtn,
    ],
  );

  if (movable) {
    node.addEventListener("dragstart", (e) => {
      draggingCard = card;
      draggingEl = node;
      node.classList.add("dragging");
      document.querySelector(".board")?.classList.add("is-dragging");
      // Some browsers require data to be set for the drag to start.
      try {
        e.dataTransfer.setData("text/plain", card.id);
        e.dataTransfer.effectAllowed = "move";
      } catch {
        /* ignore */
      }
    });
    node.addEventListener("dragend", () => {
      node.classList.remove("dragging");
      document.querySelector(".board")?.classList.remove("is-dragging");
      document
        .querySelectorAll(".drop-ok, .drop-no")
        .forEach((n) => n.classList.remove("drop-ok", "drop-no"));
      draggingCard = null;
      draggingEl = null;
    });
  }
  return node;
}

/** List mode — full-width ticket-rows from the filtered /tickets endpoint. */
async function renderWorkList() {
  const qs = new URLSearchParams();
  if (workState.status) qs.set("status", workState.status);
  if (workState.repo) qs.set("repo", workState.repo);
  if (workState.risk) qs.set("risk", workState.risk);
  const path = "/tickets" + (qs.toString() ? `?${qs}` : "");
  const tickets = (await api("GET", path)).tickets || [];

  if (tickets.length === 0) {
    // A day-one empty factory must not be told its (nonexistent) filter is hiding
    // work. Only show "No tickets match" when a filter is actually active.
    const filtered = Boolean(workState.status || workState.repo || workState.risk);
    if (filtered) {
      return emptyState(
        "No tickets match",
        "Adjust the filters above, or suggest fresh work.",
        "work",
      );
    }
    const panel = emptyState(
      "No tickets yet",
      "Create your first ticket, or let the product-owner suggest work.",
      "work",
    );
    panel.appendChild(
      el(
        "button",
        { class: "btn primary", type: "button", onclick: () => navigate("#/create") },
        "Create a ticket",
      ),
    );
    return panel;
  }
  return el(
    "div",
    { class: "ticket-list" },
    tickets.map((t) => {
      const go = () => navigate(`#/ticket/${t.id}`);
      return el(
        "a",
        {
          class: "ticket-row",
          href: `#/ticket/${t.id}`,
          onkeydown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              go();
            }
          },
        },
        [
          el("span", { class: "tr-num" }, t.number != null ? `#${t.number}` : "—"),
          el("span", { class: "tr-main" }, [
            el("div", { class: "tr-title" }, t.title),
            el("div", { class: "tr-chips" }, [
              statusBadge(t.status),
              riskBadge(t.risk_level),
              el("span", { class: "dim tabnum" }, `P${t.priority}`),
            ]),
          ]),
          pipelineDots(t.status),
          el("span", { class: "tr-time tabnum" }, fmtTime(t.updated_at)),
        ],
      );
    }),
  );
}

/** Active claims, folded into Work as a collapsible panel (was the Claims tab). */
async function renderClaimsPanel() {
  const claims = (await api("GET", "/claims")).claims || [];
  const details = el("details", { class: "card claims-panel" });
  details.dataset.sig = hashText(JSON.stringify(claims));
  details.appendChild(
    el("summary", { style: "cursor:pointer;font-weight:650" }, `Active claims (${claims.length})`),
  );
  if (claims.length === 0) {
    details.appendChild(
      el("p", { class: "dim", style: "margin-top:12px" }, "No agents are working right now."),
    );
    return details;
  }
  const rows = claims.map((c) =>
    el("tr", {}, [
      el(
        "td",
        { class: "num clickable", onclick: () => navigate(`#/ticket/${c.ticket_id}`) },
        c.ticket_number != null ? `#${c.ticket_number}` : c.ticket_id.slice(0, 8),
      ),
      el("td", { class: "title-cell" }, c.ticket_title),
      el("td", {}, statusBadge(c.ticket_status)),
      el("td", {}, c.agent_display_name || c.agent_id.slice(0, 8)),
      el("td", { class: "dim tabnum" }, fmtTime(c.expires_at)),
      el("td", { class: "dim tabnum" }, fmtTime(c.heartbeat_at)),
      el(
        "td",
        {},
        c.branch_name
          ? el("code", { class: "mono" }, c.branch_name)
          : el("span", { class: "dim" }, "—"),
      ),
      el(
        "td",
        {},
        el(
          "button",
          {
            class: "btn danger small",
            type: "button",
            onclick: () =>
              guard(async () => {
                await api("POST", `/claims/${c.claim_id}/revoke`);
                toast("Claim revoked", { ok: true });
                router();
              }),
          },
          "Revoke",
        ),
      ),
    ]),
  );
  const table = el("table", {}, [
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        ["Ticket", "Title", "Status", "Agent", "Lease expiry", "Heartbeat", "Branch", ""].map((h) =>
          el("th", {}, h),
        ),
      ),
    ),
    el("tbody", {}, rows),
  ]);
  details.appendChild(el("div", { class: "table-wrap", style: "margin-top:12px" }, table));
  return details;
}

// ===========================================================================
//  View: Ticket detail
// ===========================================================================

/**
 * Read a distilled test failure (vitest / jest / node:test / pytest shapes) into
 * the parts the page draws: file, test name, expected, received, where, counts.
 * Anything it cannot read stays null and the raw text is shown instead.
 */
function parseFailure(text) {
  const s = String(text || "");
  const out = { file: null, name: null, expected: null, received: null, at: null, counts: null };
  const fail = s.match(/^\s*(?:FAIL|✗|×|FAILED)\s+(\S+?)\s+(?:>|›|::)\s+(.+)$/m);
  if (fail) {
    out.file = fail[1];
    out.name = fail[2].replace(/\s+>\s+/g, " › ").trim();
  }
  const exp = s.match(/^\s*-\s*Expected:?\s*(.+)$/m);
  const rec = s.match(/^\s*\+\s*Received:?\s*(.+)$/m);
  const unq = (v) => v && v.trim().replace(/^["'`](.*)["'`]$/, "$1");
  if (exp && rec) {
    out.expected = unq(exp[1]);
    out.received = unq(rec[1]);
  } else {
    const m = s.match(
      /expected\s+(.+?)\s+to (?:be|equal|deeply equal|strictly equal)\s+(.+?)(?:\s*\/\/|$)/im,
    );
    if (m) {
      out.received = unq(m[1]);
      out.expected = unq(m[2]);
    }
  }
  const at = s.match(/(?:❯|at)\s+((?:[\w./-]+\/)?[\w.-]+\.\w+:\d+(?::\d+)?)/);
  if (at) out.at = at[1];
  const counts = s.match(/^\s*Tests\s+(.+?)(?:\s+\[attempt[^\]]*\])?\s*$/m);
  if (counts) out.counts = counts[1].replace(/\s{2,}/g, " ").trim();
  return out;
}

/** The referee's card at the head of a ticket that is out: red (blocked/failed) or yellow (needs you). */
function refCard(kind) {
  return svgEl(
    "svg",
    {
      viewBox: "0 0 120 150",
      width: 120,
      height: 150,
      class: `ref-card ref-${kind}`,
      "aria-hidden": "true",
      focusable: "false",
    },
    [
      svgEl("rect", { x: 10, y: 8, width: 100, height: 134, rx: 6, class: "ref-card-shadow" }),
      svgEl("rect", { x: 4, y: 2, width: 100, height: 134, rx: 6, class: "ref-card-face" }),
      kind === "red"
        ? svgEl("rect", { x: 40, y: 55, width: 28, height: 28, rx: 2, class: "ref-card-glyph" })
        : null,
    ],
  );
}

/** The sentence under a ticket's title: where it stands, in plain words, from its data. */
function ticketLede(t, trail, events) {
  const last = trail[trail.length - 1];
  const f = last ? parseFailure(last.distilled_failure) : null;
  const max = last && last.max_attempts ? last.max_attempts : null;
  switch (t.status) {
    case "blocked": {
      const why = last
        ? f && f.name
          ? [
              `The test “${f.name.split(" › ").pop()}” still fails after ${trail.length}${max ? ` of ${max}` : ""} delivery attempts, so the runner parked it.`,
            ]
          : [
              `It failed the ${last.gate} gate on ${trail.length}${max ? ` of ${max}` : ""} attempts, so the runner parked it.`,
            ]
        : ["The runner parked it."];
      return [el("b", { class: "is-red" }, "Blocked. "), ...why, " It needs you."];
    }
    case "failed":
      return [
        el("b", { class: "is-red" }, "Failed. "),
        last ? `It failed the ${last.gate} gate.` : "It failed its gates.",
        " Send it back, or mark it won't do.",
      ];
    case "paused": {
      const p = pausedInfo(events);
      return [
        el("b", {}, "Paused. "),
        p.reason === "budget_cap"
          ? `It hit its budget cap${p.spend ? ` at ${p.spend}` : ""}.`
          : "It hit a cap mid-delivery.",
        " Continue it in place, or stop it.",
      ];
    }
    case "in_review":
      return [el("b", {}, "In review. "), "It waits for your sign-off."];
    case "ready_for_merge":
      return [el("b", {}, "Approved. "), "It waits for the merge."];
    case "done":
      return [el("b", {}, "Done. "), "Merged and delivered."];
    case "ready":
      return [el("b", {}, "Ready. "), "The next free agent can claim it."];
    case "draft":
    case "refining":
      return [
        el("b", {}, `${statusLabel(t.status)}. `),
        "Mark it ready when its criteria are right.",
      ];
    case "cancelled":
      return [el("b", {}, "Won't do. "), "It will not be built."];
    default:
      return [el("b", {}, `${statusLabel(t.status)}. `), "An agent is on it."];
  }
}

/** The failing test as a scoreline: Expected v Received, and where it broke. */
function failingTestCard(trail) {
  const last = trail[trail.length - 1];
  if (!last || !last.distilled_failure) return null;
  const f = parseFailure(last.distilled_failure);
  const head = panelHead(
    last.gate === "tests" || f.name ? "The failing test" : `The failing gate: ${last.gate}`,
  );
  const body = [];
  if (f.file || f.name)
    body.push(
      el("p", { class: "ft-name" }, [
        f.file ? el("code", { class: "mono" }, f.file) : null,
        f.file && f.name ? " › " : null,
        f.name || "",
      ]),
    );
  if (f.expected != null && f.received != null) {
    body.push(
      el(
        "div",
        {
          class: "scoreline",
          role: "group",
          "aria-label": `Expected ${f.expected}, received ${f.received}`,
        },
        [
          el("div", { class: "sl-side sl-exp" }, [
            el("span", { class: "sl-l" }, "Expected"),
            el("code", { class: "sl-v" }, f.expected),
          ]),
          el("span", { class: "sl-v-sep", "aria-hidden": "true" }, "v"),
          el("div", { class: "sl-side sl-rec" }, [
            el("span", { class: "sl-l" }, "Received"),
            el("code", { class: "sl-v" }, f.received),
          ]),
        ],
      ),
    );
  }
  const bits = [f.at ? ["at ", el("code", { class: "mono" }, f.at)] : null, f.counts].filter(
    Boolean,
  );
  if (bits.length)
    body.push(
      el(
        "p",
        { class: "ft-where" },
        bits.flatMap((b, i) => (i ? [" · ", b] : [b])),
      ),
    );
  if (f.expected == null)
    body.push(
      el(
        "pre",
        {
          class: "failure-detail",
          tabindex: "0",
          role: "region",
          "aria-label": "The failure, as captured",
        },
        last.distilled_failure,
      ),
    );
  return el("section", { class: "card panel failing-test" }, [head, ...body]);
}

/**
 * Attempts as a penalty shootout: one goal per attempt, the ball marked where the
 * delivery went wide, then the captured failure for each (collapsed: identical
 * failures are shown once above as the scoreline).
 */
function renderFailureHistory(trail) {
  if (!Array.isArray(trail) || trail.length === 0) return null;
  const max = trail[trail.length - 1].max_attempts;
  const attemptsLabel = trail.length === 1 ? "1 attempt" : `${trail.length} attempts`;
  const goal = (i) =>
    svgEl(
      "svg",
      { viewBox: "0 0 180 100", class: "shoot", "aria-hidden": "true", focusable: "false" },
      [
        svgEl("rect", { x: 0, y: 0, width: 180, height: 100, class: "shoot-grass" }),
        svgEl("path", { d: "M20 100 V20 H160 V100", class: "shoot-post" }),
        ...Array.from({ length: 7 }, (_, k) =>
          svgEl("line", { x1: 20 + k * 20, y1: 20, x2: 20 + k * 20, y2: 100, class: "shoot-net" }),
        ),
        ...Array.from({ length: 4 }, (_, k) =>
          svgEl("line", { x1: 20, y1: 36 + k * 16, x2: 160, y2: 36 + k * 16, class: "shoot-net" }),
        ),
        // A miss: the ball off the frame, a cross beside it (position varies by attempt).
        svgEl("g", { transform: `translate(${[150, 30, 160][i % 3]} ${[16, 14, 70][i % 3]})` }, [
          svgEl("circle", { r: 11, class: "shoot-ball" }),
          svgEl("path", { d: "M-9 -9 L9 9 M9 -9 L-9 9", class: "shoot-x" }),
        ]),
      ],
    );
  return el("section", { class: "card failure-history" }, [
    el("div", { class: "panel-head" }, [
      el("h2", { class: "panel-title" }, [
        "Attempts",
        el("span", { class: "panel-aux" }, max ? `${trail.length} of ${max} used` : attemptsLabel),
      ]),
    ]),
    el(
      "p",
      { class: "dim failure-history-sub" },
      `Failure history (${attemptsLabel}), oldest first: what the runner recorded on each go.`,
    ),
    el(
      "ol",
      { class: "failure-trail" },
      trail.map((a, i) => {
        const mx =
          typeof a.max_attempts === "number" && a.max_attempts > 0 ? `/${a.max_attempts}` : "";
        return el("li", { class: "failure-attempt" }, [
          goal(i),
          el("div", { class: "failure-attempt-head" }, [
            el("span", { class: "failure-attempt-num" }, `Attempt ${a.attempt}${mx}`),
            a.gate ? el("span", { class: "failure-gate" }, `${a.gate} failed`) : null,
            el("span", { class: "failure-attempt-time" }, fmtTime(a.created_at)),
          ]),
          el("details", { class: "failure-more" }, [
            el("summary", {}, "What it said"),
            // Untrusted captured tool output: a text node in a focusable, named <pre>.
            el(
              "pre",
              {
                class: "failure-detail",
                tabindex: "0",
                role: "region",
                "aria-label": `Attempt ${a.attempt} failure output`,
              },
              a.distilled_failure || "(no detail captured)",
            ),
          ]),
        ]);
      }),
    ),
  ]);
}

/** The ticket's epic as a cup run: rounds, this ticket highlighted, who waits on it. */
async function ticketEpicCard(t, scopes) {
  const epic = (scopes || []).find((s) => s.type === "epic");
  if (!epic) return null;
  const all =
    (
      await api("GET", "/tickets", undefined, { signal: routeSignal() }).catch(() => ({
        tickets: [],
      }))
    ).tickets || [];
  const details = await ticketDetails(
    all.filter((x) => x.status !== "cancelled"),
    routeSignal(),
  );
  const members = all.filter((x) =>
    (details.get(x.id)?.scopes || []).some((s) => s.id === epic.id),
  );
  if (!members.length) return null;
  const deps = new Map(
    members.map((m) => [
      m.id,
      (details.get(m.id)?.dependencies || []).map((d) => d.depends_on_ticket_id),
    ]),
  );
  const byPhase = computePhases(members, deps);
  const phases = [...byPhase.keys()].sort((a, b) => a - b);
  const waiting = members.filter(
    (m) => (deps.get(m.id) || []).includes(t.id) && m.status !== "done",
  );
  return el("section", { class: "card panel tk-epic" }, [
    panelHead(epic.name, null, { text: "Campaign", href: `#/epics/${epic.id}` }, { kit: "sky" }),
    el(
      "ol",
      { class: "tk-rounds" },
      phases.map((p, i) => {
        const ph = byPhase
          .get(p)
          .slice()
          .sort((a, b) => a.number - b.number);
        const final =
          i === phases.length - 1 &&
          phases.length > 1 &&
          ph.some((x) => /^Acceptance/i.test(x.title));
        return el("li", {}, [
          el("span", { class: "round-name" }, final ? "Final" : `Round ${i + 1}`),
          el(
            "ul",
            {},
            ph.map((x) =>
              el("li", { class: `tie st-${x.status}${x.id === t.id ? " is-here" : ""}` }, [
                el(
                  "a",
                  {
                    href: `#/ticket/${x.id}`,
                    "aria-current": x.id === t.id ? "page" : null,
                    "aria-label": `#${x.number} ${statusLabel(x.status)}: ${x.title}`,
                  },
                  [
                    glyph(x.status, 16),
                    el("b", {}, `#${x.number}`),
                    el("span", { class: "tie-t" }, x.title),
                  ],
                ),
              ]),
            ),
          ),
        ]);
      }),
    ),
    waiting.length
      ? el("p", { class: OFF_PITCH.has(t.status) ? "tk-waits is-red" : "tk-waits" }, [
          OFF_PITCH.has(t.status) ? glyph("blocked", 14) : null,
          `${waiting.map((w) => "#" + w.number).join(", ")} ${waiting.length === 1 ? "waits" : "wait"} on #${t.number}.`,
        ])
      : null,
  ]);
}

async function renderTicket(id) {
  if (!id) return renderWork();
  let view;
  try {
    view = await api("GET", `/tickets/${id}`);
  } catch (e) {
    // A missing ticket is not worth a retry: say so, and point back to the board.
    if (e && (e.status === 404 || e.code === "NOT_FOUND" || /not found/i.test(e.message || ""))) {
      return el("div", { class: "view" }, [
        viewHead("No such ticket", null),
        emptyState(
          "There is no ticket at this address.",
          "It may have been a mistyped link. Every ticket is on the Work board.",
          null,
          el("a", { class: "btn primary", href: "#/work" }, "Open the Work board"),
        ),
      ]);
    }
    throw e;
  }
  await ensureAgents();
  const t = view.ticket;
  const acList = view.acceptance_criteria || [];
  const blockers = view.blocking_decisions || [];
  const events = view.events || [];

  const wrap = el("div", { class: "view" });
  wrap.appendChild(
    el(
      "button",
      { class: "back-link", type: "button", onclick: () => navigate(detailBackHash) },
      detailBackHash === "#/review" ? "← Back to Review" : "← Back to Work",
    ),
  );

  // Live-delivery log surface: when the factory is actively delivering this
  // ticket, link straight to the streaming run log so a stuck/hung agent is never
  // invisible (exactly what was missing when #88 deadlocked on a permission
  // prompt). Best-effort — never blocks the ticket render.
  const DELIVERING_STATUSES = new Set(["in_progress", "claimed", "in_testing"]);
  if (DELIVERING_STATUSES.has(t.status)) {
    const deliveringBanner = el("div", { class: "delivering-banner" }, [
      el("span", { class: "delivering-dot" }),
      el("span", {}, "Delivering…"),
    ]);
    wrap.appendChild(deliveringBanner);
    (async () => {
      try {
        const runs = await api("GET", "/api/runs?active=1");
        const run = (runs.active || []).find((r) => r.ticket_number === t.number);
        clear(deliveringBanner);
        if (run) {
          deliveringBanner.append(
            el("span", { class: "delivering-dot" }),
            el("span", {}, `Delivering — ${runKindLabel(run.kind)}`),
            el(
              "button",
              {
                class: "btn small run-viewlog",
                type: "button",
                onclick: () => viewRunDetail(run.id, runKindLabel(run.kind)),
              },
              "View live log →",
            ),
          );
        } else {
          // Marked delivering but no live run attached ⇒ likely a hung/orphaned
          // claim (the #88 case). Say so plainly instead of a silent "in progress".
          deliveringBanner.classList.add("is-warn");
          deliveringBanner.append(
            el("span", { class: "delivering-dot is-warn" }),
            el(
              "span",
              {},
              "Marked delivering, but no live run is attached — it may be stuck or already ended.",
            ),
          );
        }
      } catch {
        clear(deliveringBanner);
      }
    })();
  }

  const policyBox = el("div");

  // The action bar is driven OFF the single TICKET_ACTION_KEYS map (same map the
  // review surface uses), so "Mark ready" can never resurface where it shouldn't
  // (in_review / ready_for_merge / done). Each key maps to its concrete button.
  const actionButtons = {
    unblock: () =>
      el(
        "button",
        {
          class: "btn primary big",
          type: "button",
          onclick: () => {
            const ev = events.filter((e) => e.event_type === "ticket.blocked").pop();
            const reason = ev ? parseJsonSafe(ev.payload_json)?.reason || null : null;
            unblockSheet(t, { reason });
          },
        },
        t.status === "failed" ? "Send back…" : "Unblock…",
      ),
    mark_ready: () =>
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () =>
            guard(async () => {
              try {
                const r = await api("POST", `/tickets/${t.id}/ready`);
                clear(policyBox);
                policyBox.appendChild(
                  el(
                    "div",
                    { class: "policy-result ok" },
                    `Policy passed — ticket is now ${statusLabel(r.ticket.status)}.`,
                  ),
                );
                toast("Ticket marked ready", { ok: true });
                router();
              } catch (e) {
                clear(policyBox);
                const box = el("div", { class: "policy-result fail" }, [
                  `Mark-ready failed: ${e.message}`,
                ]);
                if (e.code) box.appendChild(el("div", { class: "toast-code" }, e.code));
                policyBox.appendChild(box);
                throw e;
              }
            }),
        },
        "Mark ready",
      ),
    // Send an approved-and-merging ticket back for rework (-> refining); resets ACs.
    rework: () =>
      el(
        "button",
        {
          class: "btn",
          type: "button",
          title: "Send this ticket back for rework",
          onclick: () =>
            guard(async () => {
              const reason = window.prompt("Reason for sending back to rework?");
              if (reason == null || reason.trim() === "") {
                toast("Rework cancelled — a reason is required", {});
                return;
              }
              await api("POST", `/tickets/${t.id}/review/reject`, {
                to: "refining",
                reason: reason.trim(),
              });
              toast("Sent back to rework", { ok: true });
              router();
            }),
        },
        "Send back to rework",
      ),
    // Merge an approved ticket whose branch has not landed (the runner held the merge
    // gate, lite mode, or a merge attempt hit a conflict). Fires the merge runner —
    // the same one the Approve path uses — instead of marking done without code.
    tester_pass: () =>
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          title:
            "Record a tester PASS for this in_testing ticket (→ ready_for_merge). Use when you verified the acceptance criteria yourself or the tester lane is held.",
          onclick: () =>
            guard(async () => {
              const summary = window.prompt(
                "Tester PASS — what was verified? (recorded as test evidence)",
                "Verified by hand against the acceptance criteria",
              );
              if (summary == null || summary.trim() === "") {
                toast("Tester verdict cancelled — a summary is required", {});
                return;
              }
              await api("POST", `/tickets/${t.id}/tester`, {
                verdict: "pass",
                summary: summary.trim(),
              });
              toast("Tester PASS recorded — ready to merge", { ok: true });
              router();
            }),
        },
        "Record tester PASS",
      ),
    tester_fail: () =>
      el(
        "button",
        {
          class: "btn",
          type: "button",
          title:
            "Record a tester FAIL for this in_testing ticket (→ refining; the failing observation becomes the rework feedback)",
          onclick: () =>
            openRejectDialog({
              verb: "recording a tester FAIL",
              onConfirm: (reason) =>
                guard(async () => {
                  await api("POST", `/tickets/${t.id}/tester`, {
                    verdict: "fail",
                    summary: reason,
                  });
                  toast("Tester FAIL recorded — sent back for rework", { ok: true });
                  router();
                }),
            }),
        },
        "Record tester FAIL",
      ),
    merge_now: () =>
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          title: "Merge the approved delivery branch now (runs the merge runner)",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/merge`);
              toast("Merge started — the board updates when it lands", { ok: true });
              router();
            }),
        },
        "Merge now",
      ),
    // Admin override: mark the ticket actually merged (ready_for_merge -> done).
    mark_merged: () =>
      el(
        "button",
        {
          class: "btn ok",
          type: "button",
          title: "Mark this ticket merged (admin override)",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/mark-merged`);
              toast("Marked merged — ticket done", { ok: true });
              router();
            }),
        },
        "Mark merged",
      ),
    wont_do: () =>
      el(
        "button",
        {
          class: "btn danger",
          type: "button",
          title: "Mark this ticket won't do (won't be built)",
          onclick: () =>
            guard(async () => {
              const reason = window.prompt("Reason for marking won't do?");
              if (reason == null || reason.trim() === "") {
                toast("Won't do cancelled — a reason is required", {});
                return;
              }
              await api("POST", `/tickets/${t.id}/wont-do`, { reason: reason.trim() });
              toast("Marked won't do", { ok: true });
              router();
            }),
        },
        "Won't do",
      ),
    reopen: () =>
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          title: "Reopen this won't-do ticket into refining",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/reopen`, { to: "refining" });
              toast("Reopened to refining", { ok: true });
              router();
            }),
        },
        "Reopen → refining",
      ),
    // PAUSE-ON-CAP: re-enter delivery in the existing worktree. The factory loop
    // picks up resume-requested paused tickets and continues them in place.
    pause_continue: () =>
      el(
        "button",
        {
          class: "btn ok",
          type: "button",
          title: "Continue this paused delivery — the factory resumes it in its existing worktree",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/continue`, {});
              toast("Continue requested — the factory will resume this ticket", { ok: true });
              router();
            }),
        },
        "Continue",
      ),
    // PAUSE-ON-CAP: abandon the paused delivery (tear down + cancel).
    pause_stop: () =>
      el(
        "button",
        {
          class: "btn danger",
          type: "button",
          title: "Stop this paused delivery — abandon it and tear down its worktree",
          onclick: () =>
            guard(async () => {
              const reason = window.prompt("Reason for stopping this paused delivery? (optional)");
              if (reason === null) return; // cancelled the prompt
              const body = reason.trim() === "" ? {} : { reason: reason.trim() };
              await api("POST", `/tickets/${t.id}/stop`, body);
              toast("Stopped — paused delivery abandoned", { ok: true });
              router();
            }),
        },
        "Stop",
      ),
  };

  // "Merging…" — a passive indicator on the approved-and-merging state, shown
  // alongside the admin/rework actions so the human sees the runner is working.
  const mergingPill =
    t.status === "ready_for_merge"
      ? el(
          "span",
          { class: "badge no-dot", title: "The merge runner is merging the delivery branch" },
          "merging…",
        )
      : null;

  const headActions = [
    mergingPill,
    ...ticketActionKeys(t.status).map((key) => (actionButtons[key] ? actionButtons[key]() : null)),
  ].filter(Boolean);

  // PAUSE-ON-CAP banner: when a delivery is paused on a turn/budget cap, surface WHY
  // (reason + spend-so-far, read from the latest ticket.paused event) above the
  // Continue / Stop actions so the human can decide at a glance.
  const pausedBanner =
    t.status === "paused"
      ? (() => {
          const p = pausedInfo(events);
          const reasonLabel =
            p.reason === "budget_cap"
              ? "budget cap reached"
              : p.reason === "timeout"
                ? "hit the wall-clock timeout"
                : "hit the turn cap";
          const bits = [
            p.spend ? `spend so far ${p.spend}` : null,
            p.turns != null ? `${p.turns} turns` : null,
          ].filter(Boolean);
          return el("div", { class: "reopen-banner paused-banner" }, [
            icon("alert"),
            el("div", {}, [
              el("strong", {}, "Delivery paused — "),
              `${reasonLabel} mid-delivery. The worktree + branch are kept alive` +
                (bits.length ? ` (${bits.join(", ")})` : "") +
                ". Continue to resume in place, or Stop to abandon it.",
            ]),
          ]);
        })()
      : null;

  const trail = view.rework_trail || [];
  const repoW =
    (view.repositories || []).find((r) => r.access === "write") || view.repositories?.[0];
  const epicScope = (view.scopes || []).find((s) => s.type === "epic");
  const out = t.status === "blocked" || t.status === "failed";
  const head = el("header", { class: `card tk-head tk-${t.status}${out ? " is-out" : ""}` }, [
    out ? refCard("red") : null,
    el("div", { class: "tk-head-main" }, [
      el("p", { class: "tk-meta" }, [
        statusBadge(t.status),
        repoW ? repoTag(repoW.name, 20) : null,
        riskBadge(t.risk_level),
        // The acceptance ticket is its campaign's Final: say so where it is named.
        epicScope && isAcceptanceTicket(t) ? el("span", { class: "tk-final" }, "Final") : null,
        epicScope
          ? el("a", { class: "tk-epic-link", href: `#/epics/${epicScope.id}` }, epicScope.name)
          : null,
        badge(t.policy_pack, "no-dot"),
        badge(`priority ${t.priority}`, "no-dot"),
        // TRACK-3a: the per-ticket delivery-budget ceiling, when set.
        t.delivery_budget_usd != null
          ? badge(`budget ${money(Number(t.delivery_budget_usd))}`, "no-dot")
          : null,
      ]),
      el("h1", { class: "detail-title" }, [
        el("span", { class: "tk-no" }, t.number != null ? `#${t.number}` : ""),
        t.number != null ? " " : "",
        t.title,
      ]),
      el("p", { class: "tk-lede" }, ticketLede(t, trail, events)),
      el("div", { class: "tk-dots" }, pipelineDots(t.status)),
    ]),
  ]);

  // Claimability only means something before a claim: never "Ready to claim" on a
  // blocked, done or in-flight ticket (the endpoint answers for the dependency gate).
  const claimable = ["ready", "draft", "refining"].includes(t.status);
  const claimBox = el("div", { class: "claim-box", dataset: claimable ? undefined : { off: "1" } });
  if (claimable) loadClaimability(t.id, claimBox);

  // Your move: what the gaffer can do with this ticket now, in words, then the buttons.
  const moveWords = {
    blocked: `Unblock sends #${t.number} back to Ready so an agent can try again, or to Refining so you can rewrite it first. To brief the next attempt, sharpen an acceptance criterion below.`,
    failed: `Send #${t.number} back to Ready for another go, or to Refining to rewrite it first.`,
    paused: "Continue resumes the delivery in its worktree; Stop abandons it.",
    in_review: "The sign-off is on the Review page: the diff, the flags and Approve.",
    ready_for_merge: "Merge runs the merge runner on the approved branch.",
    in_testing: "The tester owns the verdict. Record it by hand only if you tested it yourself.",
    draft: "Mark it ready when its acceptance criteria say what done means.",
    refining: "Mark it ready when its acceptance criteria say what done means.",
    cancelled: "Reopen it to bring it back to Refining.",
  };
  const moveActions = [
    t.status === "in_review"
      ? el("a", { class: "btn primary big", href: `#/review/${t.id}` }, "Review")
      : null,
    ...headActions,
  ].filter(Boolean);
  const yourMove =
    moveActions.length || moveWords[t.status]
      ? el("section", { class: "card panel tk-move" }, [
          panelHead("Your move", null, null, {
            kit: out || t.status === "paused" ? "claret" : "ink",
          }),
          moveWords[t.status] ? el("p", { class: "tk-move-t" }, moveWords[t.status]) : null,
          pausedBanner,
          moveActions.length
            ? el("div", { class: "btn-row" }, [
                ...moveActions,
                el("a", { class: "btn", href: `#/work?status=${t.status}` }, "See it on the board"),
              ])
            : null,
          policyBox,
          claimBox,
        ])
      : el("div", {}, [policyBox, claimBox]);

  const acCard = el("div", { class: "card tk-ac" }, [
    panelHead(
      "Acceptance criteria",
      `${acList.filter((a) => a.status === "satisfied").length} of ${acList.length} satisfied`,
    ),
    acList.length
      ? el(
          "ul",
          { class: "clean" },
          acList.map((ac) =>
            el(
              "li",
              {},
              el("div", { class: "ac-item" }, [
                el("div", { class: "ac-text" }, [
                  el("div", {}, ac.text),
                  el(
                    "div",
                    { class: "ac-meta" },
                    [
                      ac.check_command
                        ? `check: ${ac.check_command}`
                        : ac.verification_method
                          ? `verify: ${ac.verification_method}`
                          : "no verification method",
                      ac.evidence_required ? " · evidence required" : "",
                      ac.check_command && ac.verified_by === "runner:check"
                        ? " · runner-verified"
                        : "",
                    ].join(""),
                  ),
                ]),
                badge(ac.status, `ac-${ac.status}`),
              ]),
            ),
          ),
        )
      : el("p", { class: "dim" }, "No acceptance criteria yet."),
    renderAddAcForm(t.id),
  ]);

  const sideRepos = renderRepoPanel(t.id, claimBox);

  // Diff-in-review: show the real per-repo git diff inline for tickets that are
  // in review (incl. a reopened-for-review re-approval). Hidden for early-lifecycle
  // tickets with nothing delivered yet.
  const showDiff =
    t.status === "in_review" ||
    t.status === "ready_for_merge" ||
    t.status === "done" ||
    reopenedForReview(events);
  const diffCard = showDiff
    ? el("div", { class: "card" }, [
        el("h2", {}, "Delivery diff"),
        reopenedForReview(events)
          ? el("div", { class: "reopen-banner" }, [
              icon("alert"),
              "Merge conflict resolved on the branch — re-review the resolved diff before re-approving.",
            ])
          : null,
        renderTicketDiff(t.id),
      ])
    : null;

  const sideBlockers = el("div", { class: "card" }, [
    el("h2", {}, `Blocking decisions (${blockers.length})`),
    blockers.length
      ? el(
          "ul",
          { class: "clean" },
          blockers.map((d) =>
            el("li", {}, [
              el("div", {}, el("strong", {}, d.title)),
              el("div", { class: "ac-meta" }, `${d.severity} · ${d.status}`),
            ]),
          ),
        )
      : el("p", { class: "dim" }, "Nothing blocking."),
  ]);

  const sideFields = el("div", { class: "card" }, [
    el("h2", {}, "Fields"),
    el("dl", { class: "kv" }, [
      el("dt", {}, "Branch"),
      el("dd", {}, t.branch_name || "—"),
      el("dt", {}, "PR"),
      el(
        "dd",
        {},
        t.pr_url
          ? el(
              "a",
              { href: safeHttpUrl(t.pr_url) || "#", target: "_blank", rel: "noopener" },
              "open",
            )
          : "—",
      ),
      el("dt", {}, "Attempts"),
      // The rework trail is the record of delivery attempts; attempt_count only
      // counts claims, so a parked ticket read "0" beside "3 attempts".
      el("dd", {}, String(Math.max(trail.length, t.attempt_count || 0))),
      el("dt", {}, "Source"),
      el("dd", {}, t.source || "—"),
      el("dt", {}, "Created"),
      el("dd", {}, fmtTime(t.created_at)),
      el("dt", {}, "Updated"),
      el("dd", {}, fmtTime(t.updated_at)),
    ]),
  ]);

  const timeline = el("div", { class: "card" }, [
    el("h2", {}, ["Match report ", el("span", { class: "count" }, `${events.length} events`)]),
    events.length
      ? el(
          "ul",
          { class: "timeline" },
          events.map((ev) =>
            el("li", {}, [
              el("div", { class: "ev-type" }, humanizeEvent(ev.event_type)),
              el("div", { class: "ev-time" }, fmtTime(ev.created_at)),
              el("div", { class: "ev-actor" }, actorName(ev.actor_type, ev.actor_id)),
              // TRACE: the runner tick that wrote this event (work_events.correlation_id).
              // Every event one tick produced — the runner's own calls and the agent's
              // MCP writes — carries the same id, so the chip shows which events belong
              // together; `dispatch events list --correlation <id>` prints the whole trail.
              ev.correlation_id
                ? el(
                    "div",
                    {
                      class: "ev-tick mono",
                      title: `Written during tick ${ev.correlation_id} — dispatch events list --correlation ${ev.correlation_id}`,
                    },
                    `tick ${ev.correlation_id}`,
                  )
                : null,
              ev.payload_json && ev.payload_json !== "{}" ? formatPayload(ev.payload_json) : null,
            ]),
          ),
        )
      : el("p", { class: "dim" }, "No events recorded."),
  ]);

  // BBT-001: the independent black-box testing card — the testability toggle, the
  // test_contract (surfaces / deps / env / run / harness), and the tester's verdict
  // evidence. Rendered on every ticket so a PO can mark it testable + fill the
  // contract ahead of time; the contract surfaces/render the same way in_testing.
  const testingCard = renderTestingCard(t, view.evidence || []);

  // FAILURE-DIAGNOSIS: the "why did #N fail" history — the full ordered rework
  // trail (attempt 1 → 2 → …) with the distilled failing test + assertion for each.
  // Distinct from the board's latest-only rework chip: this is the trail an
  // operator returns to when triaging why a ticket kept bouncing.
  const failureHistory = renderFailureHistory(trail);
  const failingTest =
    OFF_PITCH.has(t.status) || t.status === "refining" ? failingTestCard(trail) : null;
  const epicCard = el("div", { class: "tk-epic-slot" });
  ticketEpicCard(t, view.scopes)
    .then((c) => c && epicCard.replaceChildren(c))
    .catch(() => {});

  // PO-r2 #2: per-delivery memory attribution — what memory was primed into the agent
  // for this delivery, paired with the outcome (shipped clean vs needed rework), so the
  // learn-loop is visible. Distinct "no memory primed" state vs "primed" (AC3).
  const memoryPrimed = memoryPrimedPanel(t, view.evidence || [], view.rework_trail || []);

  wrap.appendChild(head);
  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("div", {}, [
        yourMove,
        failingTest,
        failureHistory,
        diffCard,
        sideRepos,
        memoryPrimed,
        testingCard,
        timeline,
      ]),
      el("div", {}, [epicCard, acCard, sideFields, sideBlockers]),
    ]),
  );
  return wrap;
}

/**
 * Per-delivery memory attribution (PO-r2 #2). Shows the memory context the runner primed
 * into the delivery agent (recorded as `memory_primed` evidence) + the delivery outcome,
 * so an operator can see the learn-loop working. Renders NOTHING before a delivery (a
 * draft/ready/claimed ticket has no delivery to attribute); once delivered it shows either
 * the primed set or a DISTINCT "no memory primed" state.
 *
 * HONESTY: the per-item "which primed items were actually RECALLED/used" signal is the
 * memory engine's own recall log (write-only via the CLI today) — not fabricated here.
 * What's shown is what was PRIMED (deterministic) + the outcome (the "did it help?" pair).
 */
function memoryPrimedPanel(t, evidence, reworkTrail) {
  const delivered = ["in_review", "in_testing", "ready_for_merge", "done", "refining", "blocked"];
  if (!delivered.includes(t.status)) return null;
  const primed = (evidence || []).filter((e) => e.evidence_type === "memory_primed");
  const reworks = (reworkTrail || []).length;
  const outcome =
    t.status === "done"
      ? reworks > 0
        ? { txt: `shipped after ${reworks} rework${reworks === 1 ? "" : "s"}`, cls: "warn" }
        : { txt: "shipped clean — no rework", cls: "ok" }
      : reworks > 0
        ? { txt: `needed ${reworks} rework${reworks === 1 ? "" : "s"}`, cls: "warn" }
        : { txt: "in review", cls: "dim" };

  const head = el("div", { class: "mem-primed-head" }, [
    el("span", { class: "mem-primed-title" }, "Memory primed for this delivery"),
    el("span", { class: "mem-primed-outcome " + outcome.cls }, outcome.txt),
  ]);

  let bodyNode;
  if (primed.length === 0) {
    bodyNode = el(
      "div",
      { class: "mem-primed-none" },
      "No memory primed for this delivery — the agent ran without a lore/file-card context packet.",
    );
  } else {
    bodyNode = el(
      "ul",
      { class: "mem-primed-list" },
      primed.map((e) =>
        el("li", { class: "mem-primed-item" }, [
          el("span", { class: "mem-primed-summary" }, String(e.summary || "").trim() || "(empty)"),
          e.created_at
            ? el("span", { class: "mem-primed-at dim" }, fmtRelative(e.created_at))
            : null,
        ]),
      ),
    );
  }
  return el("div", { class: "card mem-primed-card" }, [head, bodyNode]);
}

/**
 * FAILURE-DIAGNOSIS: render a ticket's full ordered rework failure trail (the "why
 * did #N fail" history). Each attempt shows its gate + the DISTILLED failing test +
 * assertion/stack the runner captured — not a one-line summary. Returns null when
 * the ticket never bounced, so a clean ticket shows no card.
 */
/**
 * BBT-001 testing card: the `can_be_tested` toggle, the test_contract (the
 * handover the independent tester reads to stand the system up — never the diff),
 * and the tester's recorded test_output evidence. The toggle POSTs /testable; the
 * contract is read-only here (filled by the implementer/reviewer via CLI/MCP).
 */
function renderTestingCard(t, evidence) {
  const contract = parseTicketTestContract(t.test_contract);
  const testable = t.can_be_tested === 1;

  const toggle = el("input", { type: "checkbox", role: "switch", "aria-label": "Testable" });
  toggle.checked = testable;
  toggle.addEventListener("change", () =>
    guard(async () => {
      await api("POST", `/tickets/${t.id}/testable`, { can_be_tested: toggle.checked });
      toast(toggle.checked ? "Marked testable" : "Marked not testable", { ok: true });
      router();
    }),
  );

  const contractRows = contract
    ? el("dl", { class: "kv" }, [
        el("dt", {}, "Changed surfaces"),
        el("dd", {}, contract.changed_surfaces.length ? contract.changed_surfaces.join(", ") : "—"),
        el("dt", {}, "Runtime deps"),
        el("dd", {}, contract.runtime_deps.length ? contract.runtime_deps.join(", ") : "—"),
        el("dt", {}, "Env vars"),
        el("dd", {}, contract.env_vars.length ? contract.env_vars.join(", ") : "—"),
        el("dt", {}, "Run command"),
        el("dd", {}, contract.run_command || "—"),
        el("dt", {}, "Harness"),
        el(
          "dd",
          {},
          contract.harness_ready ? "ready (black-box mode)" : "not ready (harness mode)",
        ),
      ])
    : el(
        "p",
        { class: "dim" },
        "No test contract recorded. Add one with `wg ticket test-contract` or the Dispatch MCP.",
      );

  // The tester's verdict evidence: ONLY test_output rows whose payload carries a BBT
  // tester verdict (pass/fail). Plain implementation / AC test_output must NOT show
  // under "Tester results" — that would mislabel ordinary evidence as tester output.
  const testerEvidence = (evidence || []).filter(
    (e) => e.evidence_type === "test_output" && parseTesterVerdict(e.payload_json) !== null,
  );
  const evidenceList = testerEvidence.length
    ? el(
        "ul",
        { class: "clean" },
        testerEvidence.map((e) => {
          const prov = parseTesterProvenance(e.payload_json);
          return el("li", {}, [
            el("div", {}, [
              e.summary,
              // BBT-001 provenance badge: who produced this verdict (derived from the
              // recording actor's type), so a reviewer sees "by <agent|human|system>".
              prov
                ? el("span", { class: "badge no-dot", style: "margin-left:8px" }, `by ${prov}`)
                : null,
            ]),
            el("div", { class: "ac-meta" }, `${e.created_by} · ${fmtTime(e.created_at)}`),
          ]);
        }),
      )
    : el("p", { class: "dim" }, "No tester results recorded yet.");

  return el("div", { class: "card" }, [
    el("h2", {}, "Independent testing"),
    el("div", { class: "setting-row" }, [
      el("div", { class: "setting-meta" }, [
        el("div", { class: "setting-label" }, [
          el("span", {}, "Eligible for black-box testing"),
          t.status === "in_testing" ? el("span", { class: "badge no-dot" }, "in testing") : null,
        ]),
        el(
          "p",
          { class: "setting-help dim" },
          "When on (and GAFFER_TESTING is enabled), review approval routes this ticket through an independent tester before merge.",
        ),
      ]),
      el("label", { class: "switch" }, [
        toggle,
        el("span", { class: "switch-track" }, el("span", { class: "switch-thumb" })),
      ]),
    ]),
    el("h3", { style: "margin-top:14px" }, "Test contract"),
    contractRows,
    el("h3", { style: "margin-top:14px" }, "Tester results"),
    evidenceList,
  ]);
}

/**
 * BBT-001: pull the tester-verdict provenance ("agent" | "human" | "system") out of
 * a test_output evidence row's payload_json, tolerant of legacy rows with no payload.
 */
function parseTesterProvenance(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    const p = o && typeof o === "object" ? o.provenance : null;
    return p === "agent" || p === "human" || p === "system" ? p : null;
  } catch {
    return null;
  }
}

/**
 * The BBT tester verdict ("pass" | "fail") from a test_output row's payload_json, or
 * null when the row is not a tester verdict. This is the marker that distinguishes a
 * tester result from ordinary implementation/AC test_output evidence.
 */
function parseTesterVerdict(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    const v = o && typeof o === "object" ? o.verdict : null;
    return v === "pass" || v === "fail" ? v : null;
  } catch {
    return null;
  }
}

/** Parse the raw test_contract JSON column for the detail card (tolerant). */
function parseTicketTestContract(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!o || typeof o !== "object") return null;
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    return {
      changed_surfaces: list(o.changed_surfaces),
      runtime_deps: list(o.runtime_deps),
      env_vars: list(o.env_vars),
      run_command: typeof o.run_command === "string" ? o.run_command : "",
      harness_ready: o.harness_ready === true,
    };
  } catch {
    return null;
  }
}

function renderAddAcForm(ticketId) {
  const text = el("input", {
    type: "text",
    placeholder: "New acceptance criterion…",
    required: "",
  });
  const verify = el("input", { type: "text", placeholder: "verification method (optional)" });
  // MACHINE-CHECKABLE AC: a shell command the RUNNER executes in the delivery
  // worktree; exit 0 ⇒ satisfied (runner-verified), else rework. Optional.
  const check = el("input", {
    type: "text",
    name: "check_command",
    placeholder: "check command, e.g. npm test (optional — runner-executed)",
  });
  const evidence = el("input", { type: "checkbox" });
  const form = el(
    "form",
    {
      class: "inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        const body = { text: text.value.trim() };
        if (!body.text) return;
        if (verify.value.trim()) body.verification_method = verify.value.trim();
        if (check.value.trim()) body.check_command = check.value.trim();
        if (evidence.checked) body.evidence_required = true;
        guard(async () => {
          await api("POST", `/tickets/${ticketId}/acceptance-criteria`, body);
          toast("Acceptance criterion added", { ok: true });
          router();
        });
      },
    },
    [
      field("Criterion", text),
      field("Verification", verify),
      field("Check command", check),
      el("div", { class: "field", style: "flex:0 0 auto" }, [
        el("label", {}, "Evidence"),
        el("label", { class: "checkbox-line" }, [evidence, "required"]),
      ]),
      el("button", { class: "btn", type: "submit" }, "Add AC"),
    ],
  );
  return form;
}

// --- UI-005: repo suggestion + confirmation panel ---------------------------

const TICKET_REPO_ACCESS = ["write", "read", "test"];
const REPO_GROUPS = [
  { key: "writeRepos", title: "Write", note: "agents may deliver code here", tone: "write" },
  { key: "readOnlyRepos", title: "Read-only", note: "context only — no writes", tone: "read" },
  { key: "testRepos", title: "Test", note: "test execution only", tone: "test" },
  {
    key: "suggestedRepos",
    title: "Suggested",
    note: "not a boundary until confirmed",
    tone: "suggested",
  },
  { key: "rejectedRepos", title: "Rejected", note: "retained for audit", tone: "rejected" },
];

function renderRepoPanel(ticketId, claimBox) {
  const body = el("div", { class: "repo-panel-body" }, el("p", { class: "dim" }, "Loading repos…"));
  const card = el("div", { class: "card repo-panel" }, [
    el("h2", {}, "Execution boundary"),
    el(
      "p",
      { class: "section-note dim" },
      "Confirm which repos this ticket may write, read or test before it can go ready. Suggestions are not a boundary until you confirm them.",
    ),
    body,
  ]);
  const reload = () =>
    guard(async () => {
      await refreshRepoPanel(ticketId, body, claimBox, reload);
      if (claimBox) loadClaimability(ticketId, claimBox);
    });
  reload();
  return card;
}

async function refreshRepoPanel(ticketId, body, claimBox, reload) {
  const work = (await api("GET", `/tickets/${ticketId}/work-repos`)).work_repos || {};
  let suggestions = null;
  let suggestionsError = false;
  try {
    const res = await api("GET", `/tickets/${ticketId}/repo-suggestions`);
    suggestions = res.suggestions || res.repos || [];
  } catch (e) {
    suggestionsError = true;
    if (e.code && !["404", "NOT_FOUND"].includes(String(e.code))) throw e;
  }
  const suggMeta = new Map();
  for (const s of suggestions || []) {
    const rid = s.repoId || s.repo_id || s.id;
    if (rid) suggMeta.set(rid, s);
  }

  clear(body);

  const write = work.writeRepos || [];
  const monoRepo = write.find(
    (r) => r.source === "mono_fallback" || r.relation === "implicit_single_repo",
  );
  if (monoRepo) {
    body.appendChild(
      el("div", { class: "mono-banner" }, [
        el("strong", {}, "Single-repo mode (mono-fallback). "),
        "This ticket targets one unmapped repo, ",
        el("code", { class: "mono" }, monoRepo.name || monoRepo.id),
        ", confirmed as the sole write target.",
      ]),
    );
  }

  let anyRepo = false;
  for (const group of REPO_GROUPS) {
    const links = work[group.key] || [];
    if (!links.length) continue;
    anyRepo = true;
    body.appendChild(renderRepoGroup(ticketId, group, links, suggMeta, reload));
  }
  const denied = work.deniedRepos || [];
  if (denied.length) {
    anyRepo = true;
    body.appendChild(
      renderRepoGroup(
        ticketId,
        { key: "deniedRepos", title: "Denied", note: "explicitly no access", tone: "rejected" },
        denied,
        suggMeta,
        reload,
      ),
    );
  }

  const linkedIds = new Set();
  for (const group of [...REPO_GROUPS, { key: "deniedRepos" }]) {
    for (const r of work[group.key] || []) linkedIds.add(r.id);
  }
  const freshSuggestions = (suggestions || []).filter(
    (s) => !linkedIds.has(s.repoId || s.repo_id || s.id),
  );
  if (freshSuggestions.length) {
    anyRepo = true;
    body.appendChild(renderSuggestionGroup(ticketId, freshSuggestions, reload));
  }

  if (!anyRepo) {
    body.appendChild(
      el(
        "p",
        { class: "dim" },
        "No repos on this ticket yet. Link a scope or repo on the create flow, or add one below.",
      ),
    );
  }
  if (suggestionsError) {
    body.appendChild(
      el(
        "p",
        { class: "dim suggestions-off" },
        "Repo suggestions unavailable — confirm the boundary manually.",
      ),
    );
  }
  body.appendChild(renderAddRepoForm(ticketId, reload));
}

function renderRepoGroup(ticketId, group, links, suggMeta, reload) {
  const isRejected = group.tone === "rejected";
  const isSuggested = group.tone === "suggested";
  const rows = links.map((r) => {
    const meta = suggMeta.get(r.id);
    const reasons = parseReasons(r.reasons_json) ?? (meta ? meta.reasons : null);
    const confidence = r.confidence ?? (meta ? meta.confidence : null);
    const controls = [];
    if (!isRejected) {
      controls.push(renderAccessControl(ticketId, r, reload));
      controls.push(
        el(
          "button",
          {
            class: "btn danger small",
            type: "button",
            onclick: () => rejectRepo(ticketId, r, reload),
          },
          "Reject",
        ),
      );
    } else {
      controls.push(
        el(
          "button",
          {
            class: "btn small",
            type: "button",
            onclick: () => setRepoAccess(ticketId, r.id, "write", "confirmed", reload),
          },
          "Restore → write",
        ),
      );
    }
    return el(
      "li",
      {},
      el("div", { class: "repo-row" }, [
        el("div", { class: "repo-row-main" }, [
          el("div", { class: "repo-row-head" }, [
            repoLink(r, { className: "assoc-name" }),
            isSuggested
              ? badge("suggested", "relation-suggested")
              : badge("confirmed", "relation-confirmed"),
            confidence != null ? confidenceMeter(confidence) : null,
          ]),
          reasons && reasons.length
            ? el(
                "ul",
                { class: "reason-list" },
                reasons.map((why) => el("li", {}, why)),
              )
            : null,
        ]),
        el("div", { class: "repo-row-controls" }, controls),
      ]),
    );
  });
  return el("div", { class: `repo-group repo-group-${group.tone}` }, [
    el("div", { class: "repo-group-head" }, [
      el("span", { class: "repo-group-title" }, `${group.title} (${links.length})`),
      el("span", { class: "repo-group-note dim" }, group.note),
    ]),
    el("ul", { class: "clean" }, rows),
  ]);
}

function renderSuggestionGroup(ticketId, suggestions, reload) {
  const rows = suggestions.map((s) => {
    const rid = s.repoId || s.repo_id || s.id;
    const name = s.repoName || s.name || rid;
    const access = s.suggestedAccess || s.access || "read";
    const lowConfidence = s.lowConfidence === true;
    return el(
      "li",
      {},
      el("div", { class: "repo-row" }, [
        el("div", { class: "repo-row-main" }, [
          el("div", { class: "repo-row-head" }, [
            el("span", { class: "assoc-name plain" }, name),
            badge("suggested", "relation-suggested"),
            accessBadge(access),
            s.monoFallback ? badge("mono-fallback", "multi-home") : null,
            s.confidence != null ? confidenceMeter(s.confidence) : null,
            lowConfidence ? badge("low confidence", "risk-medium") : null,
          ]),
          Array.isArray(s.reasons) && s.reasons.length
            ? el(
                "ul",
                { class: "reason-list" },
                s.reasons.map((why) => el("li", {}, why)),
              )
            : null,
        ]),
        el("div", { class: "repo-row-controls" }, [
          el(
            "button",
            {
              class: "btn ok small",
              type: "button",
              onclick: () =>
                setRepoAccess(
                  ticketId,
                  rid,
                  access === "none" ? "read" : access,
                  "confirmed",
                  reload,
                ),
            },
            "Confirm",
          ),
          el(
            "button",
            {
              class: "btn danger small",
              type: "button",
              onclick: () => rejectRepo(ticketId, { id: rid, name }, reload),
            },
            "Reject",
          ),
        ]),
      ]),
    );
  });
  return el("div", { class: "repo-group repo-group-suggested" }, [
    el("div", { class: "repo-group-head" }, [
      el("span", { class: "repo-group-title" }, `Suggested by engine (${suggestions.length})`),
      el("span", { class: "repo-group-note dim" }, "confirm to make a boundary"),
    ]),
    el("ul", { class: "clean" }, rows),
  ]);
}

function renderAccessControl(ticketId, repo, reload) {
  const sel = el(
    "select",
    { class: "access-select", "aria-label": `Access for ${repo.name || repo.id}` },
    TICKET_REPO_ACCESS.map((a) => el("option", { value: a, selected: repo.access === a }, a)),
  );
  sel.addEventListener("change", () =>
    setRepoAccess(ticketId, repo.id, sel.value, "confirmed", reload),
  );
  return sel;
}

function confidenceMeter(value) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const tone = pct >= 70 ? "high" : pct >= 40 ? "mid" : "low";
  return el("span", { class: `confidence conf-${tone}`, title: `Confidence ${pct}%` }, [
    el("span", { class: "conf-bar" }, el("span", { class: "conf-fill", style: `width:${pct}%` })),
    el("span", { class: "conf-pct tabnum" }, `${pct}%`),
  ]);
}

function setRepoAccess(ticketId, repoId, access, relation, reload) {
  guard(async () => {
    await api("PUT", `/tickets/${ticketId}/repo-access`, { repo_id: repoId, access, relation });
    toast(`Repo set to ${access}`, { ok: true });
    reload();
  });
}

function rejectRepo(ticketId, repo, reload) {
  guard(async () => {
    const reason = window.prompt(`Reason for rejecting ${repo.name || repo.id}?`);
    if (reason == null || reason.trim() === "") {
      toast("Reject cancelled — a reason is required");
      return;
    }
    await api("PUT", `/tickets/${ticketId}/repo-access`, {
      repo_id: repo.id,
      access: "none",
      relation: "rejected",
      reasons: [reason.trim()],
    });
    toast("Repo rejected", { ok: true });
    reload();
  });
}

function renderAddRepoForm(ticketId, reload) {
  const repoSel = el("select", { required: "" }, [el("option", { value: "" }, "Loading repos…")]);
  guard(async () => {
    const repos = (await api("GET", "/repositories")).repositories || [];
    clear(repoSel);
    repoSel.appendChild(el("option", { value: "" }, "Add a repo…"));
    repos.forEach((r) => repoSel.appendChild(el("option", { value: r.id }, r.name)));
  });
  const access = el(
    "select",
    {},
    TICKET_REPO_ACCESS.map((a) => el("option", { value: a, selected: a === "read" }, a)),
  );
  return el(
    "form",
    {
      class: "inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        if (!repoSel.value) {
          toast("Pick a repo first");
          return;
        }
        setRepoAccess(ticketId, repoSel.value, access.value, "confirmed", reload);
        repoSel.value = "";
      },
    },
    [
      field("Repo", repoSel),
      field("Access", access),
      el("button", { class: "btn", type: "submit" }, "Add repo"),
    ],
  );
}

function loadClaimability(ticketId, box) {
  if (box.dataset.off) return; // only a ticket that can still be claimed asks
  clear(box);
  box.appendChild(el("span", { class: "dim" }, "Checking claimability…"));
  (async () => {
    let data;
    try {
      data = await api("GET", `/tickets/${ticketId}/claimability`);
    } catch (e) {
      clear(box);
      if (!e.code || ["404", "NOT_FOUND"].includes(String(e.code))) {
        box.appendChild(el("span", { class: "dim claim-off" }, "Claimability status unavailable."));
        return;
      }
      box.appendChild(
        el("span", { class: "dim claim-off" }, `Claimability check failed: ${e.message}`),
      );
      return;
    }
    clear(box);
    const ready = data.ready === true;
    const blockers = data.blockers || [];
    box.appendChild(
      el("div", { class: `claim-status ${ready ? "ready" : "blocked"}` }, [
        el("span", { class: "claim-dot" }),
        el("strong", {}, ready ? "Ready to claim" : "Not ready to claim"),
      ]),
    );
    if (!ready && blockers.length) {
      box.appendChild(
        el(
          "ul",
          { class: "claim-blockers" },
          blockers.map((b) => {
            // Unmet dependencies mean the ticket waits its turn, not that it is
            // blocked: say "waits on", without the red-card mark.
            if (b && b.code === "DEPENDENCY_BLOCKED") {
              const m = /^Blocked by (.+?) \(must be done first\)\.?$/.exec(b.message || "");
              return el(
                "li",
                { class: "is-wait" },
                m ? `Waits on ${m[1]}: they must be done first.` : b.message,
              );
            }
            return el(
              "li",
              {},
              typeof b === "string"
                ? b
                : b.message || b.reason || b.label || "Blocked by an unmet condition",
            );
          }),
        ),
      );
    } else if (!ready) {
      box.appendChild(el("p", { class: "dim" }, "Blocked, but no specific blockers reported."));
    }
  })();
}

function parseReasons(json) {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : null;
  } catch {
    return null;
  }
}

// ===========================================================================
//  View: Create ticket
// ===========================================================================

// --- Settings (UI-editable factory config, env-override semantics) ----------
//
// GET /api/settings reports every known setting (file value + envLocked + group);
// the panel groups them into sections of toggles / number / text inputs.
// env-locked settings (set in the process env, which always wins over the file)
// render read-only with a "set by env" badge. Save POSTs the changed,
// non-locked values back and reflects the server's fresh state.

const SETTINGS_GROUPS = [
  {
    id: "autonomy",
    label: "Autonomy",
    note: "How much the factory may do without a human in the loop.",
  },
  {
    id: "delivery",
    label: "Delivery",
    note: "What happens once a ticket is approved — merge, push, PR, CI.",
  },
  {
    id: "execution",
    label: "Execution",
    note: "How the loop schedules and paces work — concurrency, cadence, ceilings.",
  },
  {
    id: "idle-loops",
    label: "Idle loops",
    note: "Background loops that run between real work, and how far they go.",
  },
  {
    id: "budget",
    label: "Budget & caps",
    note: "Hard limits on a run — ticks, timeouts, turns, retries, spend.",
  },
  {
    id: "planning-debate",
    label: "Planning debate",
    note: "Multi-model plan critique before decomposing.",
  },
  {
    id: "quality",
    label: "Quality gates",
    note: "The runner's definition-of-done guards on every delivery.",
  },
  { id: "sandbox", label: "Sandbox", note: "Optional OS-level execution confinement." },
  {
    id: "notifications",
    label: "Notifications",
    note: "Opt-in pings when the factory needs a human.",
  },
];

// --- Health / ROI view ------------------------------------------------------

/** One labelled figure in the recall-effectiveness panel. */
function recallStat(label, value) {
  return el("div", { class: "recall-stat" }, [
    el("span", { class: "recall-stat-val tabnum" }, value),
    el("span", { class: "recall-stat-label" }, label),
  ]);
}

/** A generic name · value · progress-bar row (reused for kinds + skills). */
function healthBarRow(name, valueText, ratio, tone) {
  const pct = Math.max(2, Math.min(100, (Number.isFinite(ratio) ? ratio : 0) * 100));
  return el("div", { class: `hrow tone-${tone || "accent"}` }, [
    el("span", { class: "hrow-name", title: name }, name),
    el("span", { class: "hrow-val tabnum" }, valueText),
    el("span", { class: "df-bar" }, el("i", { style: `width:${pct}%` })),
  ]);
}

/**
 * Factory Health / ROI surface. Reads the ONE authoritative /api/health envelope
 * and renders the ROI KPI row (cost/feature, skill hit-rate, spend-by-kind,
 * rework-cost share, measured-coverage %) plus the two newly-wired dead sources:
 * the skill selected-vs-applied hit-rate detail and the recall-effectiveness
 * trend. Every source degrades gracefully — a missing one renders a clean "—" /
 * "not wired" cell rather than a broken card.
 */
async function renderHealth() {
  const health = await api("GET", "/api/health").catch(() => null);

  const wrap = el("div", { class: "view health-view" });

  if (!health) {
    wrap.appendChild(viewHead("Health", "The physio room"));
    // The flow panels read their own endpoints, so they still stand without it.
    const panels = await fitnessRoomPanels(null).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return [];
    });
    wrap.appendChild(
      emptyState(
        "Health data unavailable",
        "The health API did not respond. The usage ledger may be unconfigured.",
        "alert",
      ),
    );
    for (const p of panels) wrap.appendChild(p);
    return wrap;
  }

  const fmtUsd = money;
  const skills = health.skills || {};
  const recall = health.recall || { available: false };
  const byKind = Array.isArray(health.by_kind) ? health.by_kind : [];
  const skillList = Array.isArray(skills.by_skill) ? skills.by_skill : [];
  const dailySpend = Array.isArray(health.daily_spend) ? health.daily_spend : [];
  const totalUsd = typeof health.total_usd === "number" ? health.total_usd : 0;
  const eventLog =
    health.event_log && typeof health.event_log.chain_ok === "boolean" ? health.event_log : null;

  // --- ROI KPI row ----------------------------------------------------------
  const costPerFeature = health.cost_per_shipped_usd; // ticket-level (epic deferred)
  const hitRate =
    typeof skills.overall_hit_rate_pct === "number" ? skills.overall_hit_rate_pct : null;
  const topKind = byKind[0] || null;
  const kindShare =
    topKind && totalUsd > 0 ? Math.round(((topKind.total_cost_usd || 0) / totalUsd) * 100) : 0;
  const reworkShare =
    health.rework && typeof health.rework.rework_cost_share_pct === "number"
      ? health.rework.rework_cost_share_pct
      : 0;
  const coveragePct =
    health.coverage && typeof health.coverage.coverage_pct === "number"
      ? health.coverage.coverage_pct
      : 0;

  const spendSeries = dailySpend.map((d) => d.total_cost_usd || 0);
  const skillSeries = skillList.map((s) => s.hit_rate_pct || 0);
  const kindSeries = byKind.map((k) => k.total_cost_usd || 0);
  const recallSeries =
    recall.available && Array.isArray(recall.by_day)
      ? recall.by_day.map((d) => d.effectiveness_pct || 0)
      : [];

  const kpis = el("div", { class: "sb-cells kpi-row", role: "group", "aria-label": "Fitness" }, [
    kpiCard({
      label: "Cost / feature",
      value: costPerFeature == null ? "—" : money(costPerFeature),
      unit: "per shipped",
      tone: "accent",
      delta: 0,
      goodWhenDown: true,
      series: spendSeries.length ? spendSeries : [0],
    }),
    kpiCard({
      label: "Skill hit-rate",
      value: hitRate == null ? "—" : String(hitRate),
      unit: hitRate == null ? "not wired" : "%",
      tone: "ok",
      delta: 0,
      series: skillSeries.length ? skillSeries : [0],
    }),
    kpiCard({
      label: "Spend by kind",
      value: topKind ? String(kindShare) : "—",
      unit: topKind ? `% ${topKind.kind}` : "no spend",
      tone: "amber",
      delta: 0,
      series: kindSeries.length ? kindSeries : [0],
    }),
    kpiCard({
      label: "Rework cost",
      value: String(reworkShare),
      unit: "% of spend",
      tone: "danger",
      delta: 0,
      goodWhenDown: true,
      series: [reworkShare],
    }),
    kpiCard({
      label: "Measured coverage",
      value: String(coveragePct),
      unit: "%",
      tone: "accent",
      delta: 0,
      series: [coveragePct],
    }),
    // TAMPER-EVIDENT LOG: the work_events hash chain, re-derived server-side.
    // A break means an event was rewritten, deleted or re-ordered after the fact —
    // every rollup on this page is derived from that log, so it is shown first-class.
    eventLog
      ? kpiCard({
          label: "Event log",
          value: eventLog.chain_ok ? "intact" : "BROKEN",
          unit: eventLog.chain_ok
            ? `${eventLog.events} events chained`
            : `at seq ${eventLog.broken_at_seq} (${eventLog.reason})`,
          tone: eventLog.chain_ok ? "ok" : "danger",
          delta: 0,
          series: [eventLog.chain_ok ? 1 : 0],
        })
      : null,
  ]);

  // --- Detail panels: spend-by-kind · skill hit-rate · recall trend ---------
  const maxKind = Math.max(1, ...kindSeries);
  const kindPanel = el("div", { class: "card panel" }, [
    panelHead("Spend by kind", "usage ledger"),
    byKind.length
      ? el(
          "div",
          { class: "hlist" },
          byKind.map((k) =>
            healthBarRow(
              k.kind,
              fmtUsd(k.total_cost_usd),
              (k.total_cost_usd || 0) / maxKind,
              "amber",
            ),
          ),
        )
      : el("p", { class: "section-note dim" }, "No spend recorded yet."),
  ]);

  const skillPanel = el("div", { class: "card panel" }, [
    panelHead(
      "Skill hit-rate",
      skills.total_records ? `${skills.total_records} deliveries` : "no telemetry",
    ),
    skillList.length
      ? el(
          "div",
          { class: "hlist" },
          skillList.map((s) =>
            healthBarRow(
              s.skill,
              `${s.applied}/${s.selected} · ${s.hit_rate_pct}%`,
              (s.hit_rate_pct || 0) / 100,
              s.hit_rate_pct >= 50 ? "ok" : "amber",
            ),
          ),
        )
      : el(
          "p",
          { class: "section-note dim" },
          "No skill telemetry yet — selected-vs-applied hit-rate appears once deliveries mount skills.",
        ),
  ]);

  const recallPanel = el(
    "div",
    { class: "card panel" },
    recall.available
      ? [
          panelHead("Recall effectiveness", "memory feedback"),
          el("div", { class: "recall-figures" }, [
            recallStat(
              "Effectiveness",
              recall.effectiveness_pct == null ? "—" : `${recall.effectiveness_pct}%`,
            ),
            recallStat("Clean", String(recall.clean || 0)),
            recallStat("Reworked", String(recall.reworked || 0)),
            recallStat("Blocked", String(recall.blocked || 0)),
          ]),
          recallSeries.length
            ? el("div", { class: "health-spark", html: svgSpark(recallSeries) })
            : el("p", { class: "section-note dim" }, "No recall outcomes recorded yet."),
        ]
      : [
          panelHead("Recall effectiveness", "not wired"),
          el(
            "div",
            { class: "health-degraded" },
            el(
              "p",
              { class: "section-note dim" },
              recall.reason || "Memory is not wired — recall effectiveness is unavailable.",
            ),
          ),
        ],
  );

  // The flow panels (form guide, governance, development flow, treatment table,
  // running now, bouncing) — the physio's charts, read from their own endpoints.
  const panels = await fitnessRoomPanels(health).catch((e) => {
    if (e && e.code === "ABORTED") throw e;
    return [];
  });
  const flat = panels.flatMap((p) => (p.classList.contains("ov-grid") ? [...p.children] : [p]));
  const pick = (cls) => flat.find((p) => p.classList.contains(cls)) || null;
  const formGuide = pick("form-guide");
  const treatment = pick("needs-hero");
  const devFlow = pick("pipeline-panel");
  const gov = pick("gov-panel");
  const running = pick("run-activity");
  const bouncing = pick("bouncing-panel");
  const costLine = pick("cost-banner");
  const rest = flat.filter(
    (p) => ![formGuide, treatment, devFlow, gov, running, bouncing, costLine].includes(p),
  );

  // The verdict, in one sentence: the ledger first, then who is on the table.
  const onTable = treatment ? treatment.querySelectorAll(".needs-item").length : 0;
  const bounce = bouncing ? bouncing.querySelectorAll("li").length : 0;
  const verdict =
    eventLog && !eventLog.chain_ok
      ? "The ledger has been altered."
      : onTable + bounce
        ? `${plural(onTable + bounce, "thing")} on the treatment table.`
        : "Fit to play.";
  const facts = [
    eventLog
      ? eventLog.chain_ok
        ? `event log intact (${eventLog.events} events)`
        : `event log broken at seq ${eventLog.broken_at_seq}`
      : null,
    costPerFeature == null ? null : `${money(costPerFeature)} per shipped ticket`,
    `rework ${reworkShare}% of spend`,
    `${coveragePct}% of calls measured`,
  ].filter(Boolean);
  wrap.appendChild(
    el("section", { class: "scoreboard bleed physio-board", "aria-label": "Fitness" }, [
      el("div", { class: "scoreboard-in" }, [
        el("div", { class: "sb-main" }, [
          el("h1", { class: "hl" }, verdict),
          el("p", { class: "hl-sub" }, `Health, the physio room · ${facts.join(" · ")}`),
        ]),
        kpis,
      ]),
    ]),
  );
  const span = (n, node) => (node ? el("div", { class: `hx-span hx-${n}` }, node) : null);
  wrap.appendChild(
    el("div", { class: "hx-grid" }, [
      span(8, formGuide),
      treatment ? el("div", { class: "hx-span hx-4 hx-tall" }, treatment) : null,
      span(8, devFlow),
      span(bouncing ? 6 : 12, gov),
      span(6, bouncing),
      span(12, running),
      span(4, kindPanel),
      span(4, skillPanel),
      span(4, recallPanel),
      ...rest.map((r) => span(4, r)),
      span(12, costLine),
    ]),
  );

  return wrap;
}

async function renderSettings() {
  // Load the env-override settings plus the crew idle-loop config + the repos and
  // scope nodes the idle-loop target picker needs. Best-effort on the extras: a
  // failure there must not blank the whole Settings page.
  const [
    { settings },
    idleLoopsRes,
    reposRes,
    nodesRes,
    autonomyRecRes,
    autonomyPolRes,
    whoamiRes,
    principalsRes,
  ] = await Promise.all([
    api("GET", "/api/settings"),
    api("GET", "/api/idle-loops").catch(() => null),
    api("GET", "/repositories").catch(() => ({ repositories: [] })),
    api("GET", "/scope/nodes").catch(() => ({ nodes: [] })),
    // GRADUATED-AUTONOMY (Spec 2): advisory recommendations — best-effort, must never
    // blank the page if the endpoint is unavailable.
    api("GET", "/api/autonomy/recommendations").catch(() => null),
    // GRADUATED-AUTONOMY (Spec 2, Phase 3): the currently-enabled policies.
    api("GET", "/api/autonomy/policies").catch(() => null),
    // PER-PRINCIPAL CREDENTIALS: who this session is + the named credentials.
    api("GET", "/api/whoami").catch(() => null),
    api("GET", "/api/principals").catch(() => null),
  ]);
  const all = Array.isArray(settings) ? settings : [];
  const idleLoops = idleLoopsRes && idleLoopsRes.idle_loops ? idleLoopsRes.idle_loops : null;
  const repos = reposRes.repositories || [];
  const nodes = nodesRes.nodes || [];
  const autonomyRecs =
    autonomyRecRes && Array.isArray(autonomyRecRes.recommendations)
      ? autonomyRecRes.recommendations
      : [];
  const autonomyPolicies =
    autonomyPolRes && Array.isArray(autonomyPolRes.policies) ? autonomyPolRes.policies : [];

  const wrap = el("div", { class: "view settings-view" });
  const groupsUsed = SETTINGS_GROUPS.filter((g) => all.some((s) => s.group === g.id));
  const fromFile = all.filter(
    (s) => s.source === "file" || (s.value !== "" && s.value != null && !s.envLocked),
  ).length;
  const locked = all.filter((s) => s.envLocked).length;
  wrap.appendChild(
    viewHead(
      "The boot room",
      all.length
        ? `${plural(all.length, "setting")} in ${plural(groupsUsed.length, "group")} · ${fromFile} set in settings.json · ${locked} set by the environment`
        : null,
    ),
  );

  // Standing note: edits land in settings.json; the runner reads it on its NEXT
  // tick, so nothing restarts live.
  const note = el("div", { class: "settings-note" }, [
    icon("clock", "settings-note-ico"),
    el("span", {}, "Changes apply on the next tick — no live restart."),
  ]);

  // Empty/abnormal state: the allow-list is static server-side, so an empty list
  // means the API answered oddly. Surface it rather than render a blank page.
  if (all.length === 0) {
    wrap.appendChild(note);
    wrap.appendChild(
      emptyState("No settings available", "The config API returned no known settings.", "alert"),
    );
    return wrap;
  }

  // Two columns: a sticky index (search, sections, unsaved count) and the room.
  const main = el("div", { class: "boot-main" });
  const index = el("nav", { class: "boot-index", "aria-label": "Boot room sections" });
  const layout = el("div", { class: "boot-room" }, [index, main]);
  wrap.appendChild(layout);
  main.appendChild(note);

  // Autonomy dial — the headline: the formation, how many gates the squad plays.
  main.appendChild(autonomyDial(all));

  // GRADUATED-AUTONOMY (Spec 2, Phase 3): the currently-enabled policies, each with a
  // one-click reversible OFF. Rendered above the suggestions so the active posture is
  // the first thing an operator sees.
  // B17: those policies are consulted ONLY by the agent review pass. Under
  // REVIEW_MODE=human (supervised, the default) no reviewer agent runs, so an enabled
  // grant showed "Enabled" here and never acted. Say so wherever a grant is shown.
  const inertCount = autonomyPoliciesInert(autonomyPolicies, all);
  if (inertCount > 0) main.appendChild(inertPoliciesNote(inertCount));
  const polPanel = autonomyPoliciesPanel(autonomyPolicies, { inert: inertCount > 0 });
  if (polPanel) main.appendChild(polPanel);

  // GRADUATED-AUTONOMY (Spec 2, Phase 3): advisory recommendations backed by the review
  // track record — each is now an ENABLE action (evidence + explicit confirm → POST).
  const recPanel = autonomyRecommendationsPanel(autonomyRecs, autonomyPolicies, {
    inert: inertCount > 0,
  });
  if (recPanel) main.appendChild(recPanel);

  // PER-PRINCIPAL CREDENTIALS: who is signed in, the named credentials, mint/revoke.
  main.appendChild(
    accessPanel(
      whoamiRes,
      principalsRes && Array.isArray(principalsRes.principals) ? principalsRes.principals : [],
    ),
  );

  // edit registry: key → { def, read() } for non-locked inputs, so Save collects
  // only the values the operator can actually change.
  const editors = new Map();

  const form = el("form", { class: "settings-form" });

  for (const grp of SETTINGS_GROUPS) {
    const inGroup = all.filter((s) => s.group === grp.id);
    if (inGroup.length === 0) continue;
    // Each group folds (the room ran 12,000px): the first opens, the index jumps.
    const changed = inGroup.filter((x) => x.value !== "" && x.value != null && !x.envLocked).length;
    const card = el("details", {
      class: "card settings-group",
      id: `grp-${grp.id}`,
      open: grp.id === SETTINGS_GROUPS[0].id ? "" : null,
    });
    card.appendChild(
      el("summary", { class: "panel-head" }, [
        el("h2", { class: "panel-title" }, grp.label),
        el(
          "span",
          { class: "panel-aux" },
          `${plural(inGroup.length, "setting")}${changed ? ` · ${changed} set in settings.json` : ""}`,
        ),
      ]),
    );
    card.appendChild(el("p", { class: "section-note dim" }, grp.note));
    const rows = el("div", { class: "settings-rows" });
    for (const s of inGroup) rows.appendChild(renderSettingRow(s, editors));
    card.appendChild(rows);
    form.appendChild(card);
  }

  const saveBtn = el("button", { class: "btn primary", type: "submit" }, [
    icon("check"),
    el("span", {}, "Save changes"),
  ]);
  const dirtyNote = el("span", { class: "boot-dirty", role: "status" }, "No unsaved changes.");
  form.appendChild(el("div", { class: "btn-row settings-actions" }, [dirtyNote, saveBtn]));
  // How many switches differ from what was loaded (the same test Save uses).
  const dirtyCount = () => {
    let n = 0;
    for (const [, ed] of editors) {
      if (ed.initial !== undefined && ed.read() !== ed.initial) n++;
    }
    return n;
  };
  const paintDirty = () => {
    const n = dirtyCount();
    dirtyNote.textContent = n ? `${plural(n, "unsaved change")}.` : "No unsaved changes.";
    dirtyNote.classList.toggle("is-dirty", n > 0);
    idxDirty.textContent = n ? String(n) : "none";
    idxDirty.className = n ? "nav-count urgent" : "boot-n";
  };
  form.addEventListener("input", paintDirty);
  form.addEventListener("change", paintDirty);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    // Collect only editable (non-locked) values the user actually CHANGED. Sending
    // every editor used to persist an explicit "0" for each untouched switch, which
    // then out-ranked the GAFFER_MODE presets in the runner (a save silently turned
    // autonomy off). The server is the final gate: it re-checks env-lock and drops
    // unknown keys, so this is just the payload.
    const payload = {};
    for (const [key, ed] of editors) {
      const v = ed.read();
      if (ed.initial === undefined || v !== ed.initial) payload[key] = v;
    }
    runAsyncAction(saveBtn, "Saving…", async () => {
      const res = await api("POST", "/api/settings", { settings: payload });
      const written = (res.written || []).length;
      const rejected = (res.rejected || []).length;
      const invalid = (res.invalid || []).length;
      const skips = [
        rejected ? `${rejected} skipped (set by env)` : null,
        invalid ? `${invalid} rejected (invalid value)` : null,
      ].filter(Boolean);
      toast(
        skips.length
          ? `Saved ${written} setting${written === 1 ? "" : "s"} — ${skips.join(", ")}.`
          : `Saved ${written} setting${written === 1 ? "" : "s"}.`,
        { ok: !invalid },
      );
      // Re-render from the server's fresh state so values + locks reflect reality.
      router();
    });
  });

  main.appendChild(form);

  // Crew idle-loop scan loops — enable + repo/scope scoping. These live in
  // crew.yaml (not settings.json), so they save through their own endpoint.
  if (idleLoops) {
    const loops = renderIdleLoopsPanel(idleLoops, repos, nodes);
    const fold = el("details", { class: "boot-fold", id: "idle-loops" }, [
      el("summary", {}, [
        el("span", { class: "boot-fold-t" }, "Idle-loop scans"),
        el(
          "span",
          { class: "panel-aux" },
          "what the squad does when no ticket is ready · crew.yaml",
        ),
      ]),
      loops,
    ]);
    main.appendChild(fold);
  }

  // The index: find a setting by name, key or help; jump to any section.
  const find = el("input", {
    type: "search",
    class: "boot-find",
    placeholder: "Find a setting…",
    "aria-label": "Find a setting",
    oninput: (e) => {
      const q = e.target.value.trim().toLowerCase();
      let shown = 0;
      for (const row of form.querySelectorAll(".setting-row")) {
        const hit = !q || (row.dataset.find || "").includes(q);
        row.hidden = !hit;
        if (hit) shown++;
      }
      for (const g of form.querySelectorAll(".settings-group")) {
        g.hidden = !!q && !g.querySelector(".setting-row:not([hidden])");
        if (q && !g.hidden) g.open = true;
      }
      findCount.textContent = q ? `${plural(shown, "match", "matches")}` : "";
    },
  });
  const findCount = el("span", { class: "boot-find-n", role: "status" });
  const idxDirty = el("span", { class: "boot-n" }, "none");
  const link = (id, label, n) =>
    el("a", { href: `#${id}` }, [
      el("span", {}, label),
      n != null ? el("span", { class: "boot-n" }, String(n)) : null,
    ]);
  index.append(
    field("Find a setting", find, { class: "boot-find-f" }),
    findCount,
    el("ul", {}, [
      el("li", {}, link("formation", "Formation")),
      polPanel ? el("li", {}, link(polPanel.id || "autonomy-policies", "Active autonomy")) : null,
      recPanel ? el("li", {}, link(recPanel.id || "autonomy-recs", "Suggested autonomy")) : null,
      el("li", {}, link("access", "Access")),
      ...SETTINGS_GROUPS.filter((g) => all.some((x) => x.group === g.id)).map((g) =>
        el("li", {}, link(`grp-${g.id}`, g.label, all.filter((x) => x.group === g.id).length)),
      ),
      idleLoops ? el("li", {}, link("idle-loops", "Idle-loop scans")) : null,
    ]),
    el("p", { class: "boot-unsaved" }, ["Unsaved changes: ", idxDirty]),
  );
  if (polPanel && !polPanel.id) polPanel.id = "autonomy-policies";
  if (recPanel && !recPanel.id) recPanel.id = "autonomy-recs";
  const acc = main.querySelector(".access-panel") || main.children[main.children.length - 2];
  if (acc && !acc.id) acc.id = "access";

  return wrap;
}

/**
 * The autonomy dial as the team's formation: every autonomy gate is a position
 * on a drawn pitch. A claret shirt stands where the squad plays it on its own;
 * a yellow card marks where the gaffer still makes the call. Each position jumps
 * to its switch below. Reads the EFFECTIVE posture (env → file → GAFFER_MODE).
 */
function autonomyDial(all) {
  const isOn = (v) => v === true || v === "true" || v === "1" || v === "on";
  const bools = all.filter((s) => s.group === "autonomy" && s.type === "boolean");
  const total = Math.max(1, bools.length);
  const onOf = (s) => isOn(s.effective !== undefined ? s.effective : s.value);
  const on = bools.filter(onOf).length;
  const pct = Math.round((on / total) * 100);
  const level = on === 0 ? "Supervised" : on >= total ? "Hands-off" : "Assisted";
  const tone = on === 0 ? "ok" : on >= total ? "danger" : "amber";
  const blurb =
    on === 0
      ? "You make every call: a human approves every merge, and the squad cannot ship its own work."
      : on >= total
        ? "The squad plays every position: it can plan, build, review and ship without you."
        : `The squad plays ${on} of ${total} positions on its own (the shirts); you make the call on the rest (the cards).`;
  const W = 760,
    H = 200,
    step = W / (bools.length + 1);
  const pitch = svgEl(
    "svg",
    {
      viewBox: `0 0 ${W} ${H}`,
      class: "formation-pitch",
      preserveAspectRatio: "none",
      "aria-hidden": "true",
      focusable: "false",
    },
    [
      svgEl("rect", { x: 0, y: 0, width: W, height: H, class: "fp-grass" }),
      ...Array.from({ length: 6 }, (_, i) =>
        svgEl("rect", { x: (i * W) / 6, y: 0, width: W / 12, height: H, class: "fp-mow" }),
      ),
      svgEl("rect", { x: 8, y: 8, width: W - 16, height: H - 16, class: "fp-line" }),
      svgEl("line", { x1: W / 2, y1: 8, x2: W / 2, y2: H - 8, class: "fp-line" }),
      svgEl("circle", { cx: W / 2, cy: H / 2, r: 40, class: "fp-line" }),
    ],
  );
  const positions = el(
    "ol",
    { class: "formation-pos" },
    bools.map((s, i) => {
      const playing = onOf(s);
      return el("li", { style: { "--x": `${(((i + 1) * step) / W) * 100}%` } }, [
        el(
          "a",
          {
            class: `fp-spot ${playing ? "on" : "off"}`,
            href: `#set-${s.key}`,
            "aria-label": `${s.label || s.key}: ${playing ? "the squad plays it" : "you make the call"}`,
          },
          [
            playing ? agentShirt("squad", 46) : ycard(40, "fp-card"),
            el("span", { class: "fp-label" }, s.label || s.key),
            el("span", { class: "fp-who" }, playing ? "squad" : "you"),
          ],
        ),
      ]);
    }),
  );
  return el(
    "section",
    {
      class: `card panel autonomy-dial formation tone-${tone}`,
      id: "formation",
      "aria-label": "Formation",
    },
    [
      panelHead(`Formation: ${level}`, `${on} of ${total} positions to the squad`, null, {
        kit: "claret",
      }),
      el("p", { class: "ad-note" }, blurb),
      el("div", { class: "formation-board" }, [pitch, positions]),
      el("div", { class: "ad-gauge" }, [
        el("span", { class: "ad-frac tabnum" }, `${on}/${total}`),
        el("span", { class: "ad-cap" }, "gates open"),
        band(on, total, `${on} of ${total} autonomy gates open (${pct}%)`),
      ]),
    ],
  );
}

/** Human label for an autonomy gate. */
function autonomyGateLabel(g) {
  if (g === "merge") return "Auto-merge";
  if (g === "memory") return "Auto-memory";
  return "Auto-approve";
}

/** Is (repo × risk × gate) already enabled as auto? Used to hide a redundant Enable. */
function isPolicyActive(policies, repoId, riskLevel, gate) {
  return (
    Array.isArray(policies) &&
    policies.some(
      (p) =>
        p.repo_id === repoId && p.risk_level === riskLevel && p.gate === gate && p.mode === "auto",
    )
  );
}

/**
 * POST an autonomy policy change and re-render the Settings view from the server's
 * fresh state (so the active-policies list + suggestions reflect reality). Security:
 * the server re-checks the explicit confirm on enable; this is just the transport.
 */
function submitAutonomyPolicy(btn, busyLabel, body, okMsg) {
  runAsyncAction(btn, busyLabel, async () => {
    await api("POST", "/api/autonomy/policy", body);
    toast(okMsg, { ok: true });
    router();
  });
}

/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 3): advisory recommendations panel — now with an
 * ENABLE action per item.
 *
 * Each suggestion surfaces "you've approved N of M low-risk deliveries in api-repo
 * unchanged — consider auto-merge for risk=low" backed by the real review track
 * record. Clicking Enable reveals the evidence (already shown) + an EXPLICIT CONFIRM
 * step (the LOCKED trust-boundary posture), then POSTs the policy with confirm:true.
 * An item already enabled as auto shows an "Enabled" chip instead of the action.
 * Returns null when there's nothing to recommend, so the panel simply doesn't appear.
 */
/** The REVIEW_MODE the tick will use, from the settings views ('human' when unset). */
function effectiveReviewMode(all) {
  const s = (Array.isArray(all) ? all : []).find((x) => x.key === "REVIEW_MODE");
  const v = s ? String(s.effective !== undefined ? s.effective : s.value || "").trim() : "";
  return v || "human";
}

/**
 * B17: how many active (mode=auto) per-repo grants can never act — the runner consults
 * them only inside the agent review pass (REVIEW_MODE=agent|both); under `human` no
 * reviewer runs, so the grants are inert. 0 when there are none or they are live.
 */
function autonomyPoliciesInert(policies, all) {
  const active = (Array.isArray(policies) ? policies : []).filter((p) => p.mode === "auto");
  if (active.length === 0) return 0;
  return effectiveReviewMode(all) === "human" ? active.length : 0;
}

/** The Settings banner for inert grants (see autonomyPoliciesInert). */
function inertPoliciesNote(n) {
  return el("div", { class: "warn-box autonomy-inert-note", role: "status" }, [
    icon("alert", "settings-note-ico"),
    el("span", {}, [
      el("strong", {}, `${n} autonomy grant${n === 1 ? " is" : "s are"} inert. `),
      "Review mode is human, so no reviewer agent runs and the per-repo policies are never " +
        "consulted. Set Review mode to agent or both (or Autonomy mode to graduated) for them " +
        "to act, or turn them off below.",
    ]),
  ]);
}

function autonomyRecommendationsPanel(recs, policies, { inert = false } = {}) {
  if (!Array.isArray(recs) || recs.length === 0) return null;
  return el("div", { class: "card panel autonomy-recs" }, [
    el("div", { class: "ar-head" }, [
      icon("spark", "ar-ico"),
      el("div", {}, [
        el("h2", { class: "ar-title" }, "Autonomy suggestions"),
        el(
          "p",
          { class: "section-note dim" },
          "Based on your review track record. Advisory only — nothing changes until you explicitly enable it.",
        ),
      ]),
    ]),
    el(
      "ul",
      { class: "ar-list" },
      recs.map((r) => autonomyRecItem(r, policies, { inert })),
    ),
  ]);
}

/** One recommendation row with its inline evidence + explicit enable/confirm flow. */
function autonomyRecItem(r, policies, { inert = false } = {}) {
  const confPct = Math.round((Number(r.confidence) || 0) * 100);
  const reasons = Array.isArray(r.reasons) ? r.reasons : [];
  const active = isPolicyActive(policies, r.repoId, r.riskLevel, r.gate);

  // The action zone toggles between [Enable] and an inline confirm panel so the
  // operator must take a deliberate second step, with the evidence still on screen.
  const action = el("div", { class: "ar-action" });
  const renderEnable = () => {
    action.textContent = "";
    const enableBtn = el("button", { class: "btn small", type: "button" }, [
      icon("check"),
      el("span", {}, `Enable ${autonomyGateLabel(r.gate).toLowerCase()}`),
    ]);
    enableBtn.addEventListener("click", renderConfirm);
    action.appendChild(enableBtn);
  };
  const renderConfirm = () => {
    action.textContent = "";
    const confirmBtn = el("button", { class: "btn small primary", type: "button" }, [
      icon("check"),
      el("span", {}, "Confirm — I've reviewed the evidence"),
    ]);
    const cancelBtn = el("button", { class: "btn small ghost", type: "button" }, "Cancel");
    cancelBtn.addEventListener("click", renderEnable);
    confirmBtn.addEventListener("click", () =>
      submitAutonomyPolicy(
        confirmBtn,
        "Enabling…",
        {
          repo_id: r.repoId,
          risk_level: r.riskLevel,
          gate: r.gate,
          mode: "auto",
          confirm: true,
        },
        `Enabled ${autonomyGateLabel(r.gate).toLowerCase()} for risk=${r.riskLevel} in ${r.repoName || "repo"}.`,
      ),
    );
    action.appendChild(
      el("div", { class: "ar-confirm" }, [
        el(
          "p",
          { class: "ar-confirm-note" },
          `This grants ${autonomyGateLabel(r.gate).toLowerCase()} for risk=${r.riskLevel} in ${r.repoName || "this repo"}. Reversible any time.`,
        ),
        el("div", { class: "btn-row" }, [confirmBtn, cancelBtn]),
      ]),
    );
  };
  if (active && inert) {
    action.appendChild(
      el(
        "span",
        {
          class: "ar-enabled-chip inert",
          title: "Review mode is human: no reviewer agent runs, so this grant never acts.",
        },
        [icon("alert"), "Enabled · inert"],
      ),
    );
  } else if (active) {
    action.appendChild(el("span", { class: "ar-enabled-chip" }, [icon("check"), "Enabled"]));
  } else {
    renderEnable();
  }

  return el("li", { class: "ar-item" }, [
    el("div", { class: "ar-item-head" }, [
      el("span", { class: `ar-gate ar-gate-${r.gate}` }, autonomyGateLabel(r.gate)),
      el("span", { class: "ar-risk" }, `risk=${r.riskLevel}`),
      el("span", { class: "ar-repo" }, r.repoName || ""),
      el("span", { class: "ar-conf dim tabnum", title: "confidence" }, `${confPct}%`),
    ]),
    el("p", { class: "ar-headline" }, r.headline || ""),
    reasons.length
      ? el(
          "ul",
          { class: "ar-reasons dim" },
          reasons.map((reason) => el("li", {}, reason)),
        )
      : null,
    action,
  ]);
}

/**
 * GRADUATED-AUTONOMY (Spec 2, Phase 3): the active-policies panel — every enabled
 * (mode=auto) autonomy policy with a one-click, reversible OFF. Returns null when
 * nothing is enabled, so the panel only appears once the operator has opted in.
 */
function autonomyPoliciesPanel(policies, { inert = false } = {}) {
  const active = (Array.isArray(policies) ? policies : []).filter((p) => p.mode === "auto");
  if (active.length === 0) return null;
  return el("div", { class: `card panel autonomy-policies${inert ? " is-inert" : ""}` }, [
    el("div", { class: "ar-head" }, [
      icon(inert ? "alert" : "lock", "ar-ico"),
      el("div", {}, [
        el("h2", { class: "ar-title" }, inert ? "Active autonomy (inert)" : "Active autonomy"),
        el(
          "p",
          { class: "section-note dim" },
          inert
            ? "These grants are never consulted while Review mode is human — no reviewer agent runs. Switch Review mode to agent or both for them to act, or turn them off."
            : "The factory acts without you at these chokepoints. Turn any off to re-gate it immediately.",
        ),
      ]),
    ]),
    el(
      "ul",
      { class: "ar-list" },
      active.map((p) => {
        const offBtn = el(
          "button",
          { class: "btn small ghost", type: "button" },
          el("span", {}, "Turn off"),
        );
        offBtn.addEventListener("click", () =>
          submitAutonomyPolicy(
            offBtn,
            "Turning off…",
            { repo_id: p.repo_id, risk_level: p.risk_level, gate: p.gate, mode: "off" },
            `Turned off ${autonomyGateLabel(p.gate).toLowerCase()} for risk=${p.risk_level} in ${p.repo_name || "repo"}.`,
          ),
        );
        return el("li", { class: "ar-item ap-item" }, [
          el("div", { class: "ar-item-head" }, [
            el("span", { class: `ar-gate ar-gate-${p.gate}` }, autonomyGateLabel(p.gate)),
            el("span", { class: "ar-risk" }, `risk=${p.risk_level}`),
            el("span", { class: "ar-repo" }, p.repo_name || ""),
            inert
              ? el(
                  "span",
                  {
                    class: "ap-mode inert",
                    title:
                      "Review mode is human: no reviewer agent runs, so this grant never acts.",
                  },
                  "auto · inert",
                )
              : el("span", { class: "ap-mode" }, "auto"),
          ]),
          p.enabled_by
            ? el(
                "p",
                { class: "ar-reasons dim" },
                `enabled by ${p.enabled_by}${p.enabled_at ? ` · ${p.enabled_at.slice(0, 10)}` : ""}`,
              )
            : null,
          el("div", { class: "ar-action" }, [offBtn]),
        ]);
      }),
    ),
  ]);
}

/**
 * Access panel (Settings): how this session authenticated, the named API
 * credentials (principals) and, for a full-capability session, the mint and
 * revoke actions. A minted token is shown ONCE in a read-only field; only its
 * hash exists server-side, so it cannot be shown again.
 */
function accessPanel(whoami, principals) {
  const cap = whoami && whoami.capability ? whoami.capability : "full";
  const canManage = cap === "full";
  const actorId = whoami && whoami.actor ? whoami.actor.id || whoami.actor.type : "—";
  const via =
    whoami && whoami.principal
      ? `principal “${whoami.principal.name}”`
      : whoami
        ? "the shared token"
        : "unknown";
  const card = el("div", { class: "card panel access-panel" }, [
    el("div", { class: "ar-head" }, [
      icon("lock", "ar-ico"),
      el("div", {}, [
        el("h2", { class: "ar-title" }, "Access"),
        el(
          "p",
          { class: "section-note dim" },
          "Named credentials for the API. Every write a principal makes is attributed to its actor in the event log.",
        ),
      ]),
    ]),
    el("p", { class: "access-whoami", "data-testid": "access-whoami" }, [
      "Signed in as ",
      el("strong", {}, actorId),
      ` (${cap}) via ${via}.`,
    ]),
  ]);

  const list = el("ul", { class: "ar-list access-list", "aria-label": "API principals" });
  if (principals.length === 0) {
    list.appendChild(
      el("li", { class: "ar-item dim" }, "No principals yet — every caller uses the shared token."),
    );
  }
  for (const p of principals) {
    const revoked = Boolean(p.revoked_at);
    const item = el("li", { class: `ar-item access-item${revoked ? " is-revoked" : ""}` }, [
      el("div", { class: "ar-item-head" }, [
        el("span", { class: "access-name" }, p.name),
        el("span", { class: "ap-mode" }, p.capability),
        el("span", { class: "ar-repo" }, actorName(p.actor_type, p.actor_id)),
        revoked ? el("span", { class: "access-status" }, "revoked") : null,
      ]),
      el(
        "p",
        { class: "ar-reasons dim" },
        `created ${String(p.created_at || "").slice(0, 10)}${p.created_by ? ` by ${p.created_by}` : ""}` +
          (p.last_used_at
            ? ` · last used ${String(p.last_used_at).slice(0, 16).replace("T", " ")}`
            : " · never used") +
          (revoked ? ` · revoked ${String(p.revoked_at).slice(0, 10)}` : ""),
      ),
    ]);
    if (canManage && !revoked) {
      // Two-step revoke: the first click arms, the second confirms (no modal).
      const btn = el(
        "button",
        { class: "btn small ghost", type: "button" },
        el("span", {}, "Revoke"),
      );
      let armed = false;
      btn.addEventListener("click", () => {
        if (!armed) {
          armed = true;
          clear(btn);
          btn.appendChild(el("span", {}, "Confirm revoke"));
          btn.classList.add("danger");
          setTimeout(() => {
            if (!armed) return;
            armed = false;
            clear(btn);
            btn.appendChild(el("span", {}, "Revoke"));
            btn.classList.remove("danger");
          }, 6000);
          return;
        }
        runAsyncAction(btn, "Revoking…", async () => {
          await api("DELETE", `/api/principals/${encodeURIComponent(p.id)}`);
          toast(`Revoked “${p.name}”.`, { ok: true });
          router();
        });
      });
      item.appendChild(el("div", { class: "ar-action" }, [btn]));
    }
    list.appendChild(item);
  }
  card.appendChild(list);

  if (canManage) {
    const nameInput = el("input", {
      type: "text",
      name: "principal-name",
      placeholder: "e.g. alice or ci-reviewer",
      required: "required",
      maxlength: "64",
      // The HTML pattern attribute compiles with the `v` flag: `-` in a class must be escaped.
      pattern: "[A-Za-z0-9][A-Za-z0-9._@\\-]{0,63}",
      autocomplete: "off",
    });
    const capSelect = el("select", { name: "principal-capability" }, [
      el("option", { value: "full" }, "full — read and write"),
      el("option", { value: "read" }, "read — GET routes only"),
    ]);
    const actorInput = el("input", {
      type: "text",
      name: "principal-actor-id",
      placeholder: "defaults to the name",
      maxlength: "200",
      autocomplete: "off",
    });
    const submit = el("button", { class: "btn primary small", type: "submit" }, [
      icon("plus"),
      el("span", {}, "Create credential"),
    ]);
    const tokenOut = el("div", { class: "access-token-out", hidden: true });
    const form = el("form", { class: "access-form" }, [
      el("h3", {}, "New credential"),
      el("div", { class: "access-form-row" }, [
        field("Name", nameInput),
        field("Capability", capSelect),
        field("Actor id", actorInput),
      ]),
      el("div", { class: "btn-row" }, [submit]),
      tokenOut,
    ]);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      runAsyncAction(submit, "Creating…", async () => {
        const body = { name, capability: capSelect.value };
        if (actorInput.value.trim()) body.actor_id = actorInput.value.trim();
        const res = await api("POST", "/api/principals", body);
        const tok = el("input", {
          type: "text",
          readonly: "readonly",
          class: "access-token",
          "data-testid": "access-token",
          value: res.token,
          "aria-label": "New token (shown once)",
        });
        tok.addEventListener("focus", () => tok.select());
        clear(tokenOut);
        tokenOut.hidden = false;
        tokenOut.append(
          el("p", { class: "access-token-note" }, [
            el("strong", {}, `Token for “${res.principal.name}” — shown once. `),
            "Copy it now; only its hash is stored.",
          ]),
          tok,
        );
        toast(`Created “${res.principal.name}”. The token is shown once below.`, { ok: true });
        nameInput.value = "";
        actorInput.value = "";
        // Refresh the list without dropping the one-time token from view.
        const fresh = await api("GET", "/api/principals").catch(() => null);
        if (fresh && Array.isArray(fresh.principals)) {
          const rebuilt = accessPanel(whoami, fresh.principals);
          const freshList = rebuilt.querySelector(".access-list");
          if (freshList) list.replaceWith(freshList);
        }
      });
    });
    card.appendChild(form);
  } else {
    card.appendChild(
      el(
        "p",
        { class: "section-note dim" },
        "This session is read-scoped: it can see principals but not mint or revoke them.",
      ),
    );
  }
  return card;
}

/** The known idle scan loops, in display order, with copy for the panel. */
const IDLE_LOOP_LABELS = {
  idle_security_hotspot: "Security hotspots",
  idle_coverage: "Coverage",
  idle_test_quality: "Test quality",
  idle_type_quality: "Type quality",
  idle_tech_debt: "Tech debt",
  idle_documentation: "Documentation",
  idle_dependencies: "Dependencies",
  idle_feature_backlog: "Feature backlog",
};

/**
 * Idle-loops control panel. For each scan loop: an enable toggle + a multi-select
 * target picker (repos + scopes). On save, node selections are resolved to repo
 * NAMES so the crew loop backend stays repo-name-based, and the whole set is PUT
 * to /api/idle-loops. An empty selection means "all repos" (schema semantics).
 */
/** The lanes "Use recommended set" turns on (mirrors the API's RECOMMENDED_LANE_KEYS). */
const IDLE_RECOMMENDED_LANES = [
  "idle_security_hotspot",
  "idle_coverage",
  "idle_tech_debt",
  "idle_documentation",
];

function renderIdleLoopsPanel(view, repos, nodes) {
  const card = el("div", { class: "card settings-group idle-loops-group" });
  card.appendChild(el("h2", {}, "Idle loops"));
  card.appendChild(
    el(
      "p",
      { class: "section-note dim" },
      "When the queue is empty the factory can spend the tick on maintenance: one scan lane per idle tick, " +
        "chosen by priority and rotation, drafting a ticket per finding with a behaviour-preserving acceptance " +
        "criterion the runner checks with the repo's own test command. Empty scope = all repos.",
    ),
  );
  card.appendChild(
    el("div", { class: "settings-note idle-loops-note" }, [
      icon("clock", "settings-note-ico"),
      el("span", {}, "Stored in crew.yaml; changes apply on the next tick — no live restart."),
    ]),
  );

  if (!view.configured) {
    card.appendChild(
      emptyState(
        "Crew config not found",
        "No crew.yaml is configured for this factory yet, so the scan loops can't be edited here.",
        "alert",
      ),
    );
    return card;
  }

  const makeSwitch = (label, checked, testid) => {
    const input = el("input", {
      type: "checkbox",
      role: "switch",
      "aria-label": label,
      "data-testid": testid,
    });
    input.checked = checked === true;
    const wrap = el("label", { class: "switch" }, [
      input,
      el("span", { class: "switch-track" }, el("span", { class: "switch-thumb" })),
    ]);
    return { input, wrap };
  };

  // ── Maintenance lane master switch ────────────────────────────────────────
  const maint = makeSwitch(
    "Maintenance when idle",
    view.maintenance && view.maintenance.enabled,
    "maintenance-toggle",
  );
  const recommendBtn = el(
    "button",
    { class: "btn", type: "button", "data-testid": "idle-recommended" },
    [icon("spark"), el("span", {}, "Use recommended set")],
  );
  card.appendChild(
    el("div", { class: "idle-loop-row idle-lane-master" }, [
      el("div", { class: "idle-loop-head" }, [
        el("div", { class: "idle-loop-label" }, [
          el("span", {}, "Maintenance when idle"),
          el("code", { class: "mono setting-key" }, "loops.maintenance.enabled"),
        ]),
        maint.wrap,
      ]),
      el(
        "p",
        { class: "dim" },
        "The master switch. Off: an idle factory polls and stops. On: each idle tick runs the one enabled lane " +
          "below that is most due (security first, then tests, types, tech debt, docs, dependencies). " +
          "GAFFER_MAINTENANCE=0 in the runner's env is the emergency kill switch.",
      ),
      el("div", { class: "btn-row" }, [recommendBtn]),
    ]),
  );

  // ── Per-loop editors ──────────────────────────────────────────────────────
  const editors = new Map();
  const rows = el("div", { class: "idle-loops-rows" });

  for (const loop of view.loops || []) {
    const label = IDLE_LOOP_LABELS[loop.key] || loop.label || loop.key;
    const initial = (loop.repos || []).map((name) => ({ kind: "repo", id: name, name }));
    const picker = targetPicker({
      repos,
      nodes,
      value: initial,
      multiple: true,
      onChange: () => {},
    });
    const sw = makeSwitch(`Enable ${label}`, loop.enabled === true, `idle-loop-${loop.key}`);
    sw.input.addEventListener("change", () => refreshStatus());

    editors.set(loop.key, {
      key: loop.key,
      lane: loop.maintenanceLane === true,
      toggle: sw.input,
      enabled: () => sw.input.checked,
      targets: () => (typeof picker.getTargets === "function" ? picker.getTargets() : []),
    });

    const head = el("div", { class: "idle-loop-head" }, [
      el("div", { class: "idle-loop-label" }, [
        el("span", {}, label),
        el("code", { class: "mono setting-key" }, loop.key),
        loop.maintenanceLane ? el("span", { class: "dim" }, "· maintenance lane") : null,
      ]),
      sw.wrap,
    ]);

    rows.appendChild(
      el("div", { class: "idle-loop-row" }, [
        head,
        el("div", { class: "idle-loop-targets field" }, [
          el("label", {}, "Scope to repos / scopes"),
          picker,
        ]),
      ]),
    );
  }
  card.appendChild(rows);

  // ── Self-improve: promote the lane's own drafts to ready ──────────────────
  const si = view.selfImprove || { enabled: false, repos: [], maxRisk: "low", maxReadyPerRun: 1 };
  const siSwitch = makeSwitch("Promote drafts to ready", si.enabled, "self-improve-toggle");
  const siPicker = targetPicker({
    repos,
    nodes,
    value: (si.repos || []).map((name) => ({ kind: "repo", id: name, name })),
    multiple: true,
    onChange: () => {},
  });
  const riskSel = el(
    "select",
    { name: "self-improve-max-risk", "aria-label": "Maximum repo risk to auto-promote" },
    ["low", "medium", "high", "critical"].map((r) =>
      el("option", { value: r, selected: r === si.maxRisk ? "" : undefined }, r),
    ),
  );
  const capInput = el("input", {
    type: "number",
    name: "self-improve-max-ready",
    min: "1",
    max: "20",
    step: "1",
    "aria-label": "Maximum promotions per idle tick",
  });
  capInput.value = String(si.maxReadyPerRun || 1);
  siSwitch.input.addEventListener("change", () => refreshStatus());

  card.appendChild(
    el("div", { class: "idle-loop-row idle-self-improve" }, [
      el("div", { class: "idle-loop-head" }, [
        el("div", { class: "idle-loop-label" }, [
          el("span", {}, "Promote drafts to ready"),
          el("code", { class: "mono setting-key" }, "loops.self_improve"),
        ]),
        siSwitch.wrap,
      ]),
      el(
        "p",
        { class: "dim" },
        "Closes the loop: an idle tick may mark its own drafts ready so the delivery loop claims and fixes " +
          "them without a human in the promote step. Strict opt-in — only the repos named here, only at or " +
          "below the risk ceiling, and at most this many per tick. Every promoted ticket carries the " +
          "behaviour-preserving criterion, machine-checked by the repo's test command.",
      ),
      el("div", { class: "idle-loop-targets field" }, [
        el("label", {}, "Repos allowed to self-improve (empty = none)"),
        siPicker,
      ]),
      el("div", { class: "form-grid" }, [
        el("div", { class: "field" }, [el("label", {}, "Max repo risk"), riskSel]),
        el("div", { class: "field" }, [el("label", {}, "Max promotions per tick"), capInput]),
      ]),
    ]),
  );

  // ── Live status: what the next idle tick will actually do ─────────────────
  const statusText = el("span", {});
  const statusIcon = el("span", { class: "settings-note-ico" });
  const status = el("div", { class: "settings-note", "data-testid": "idle-status" }, [
    statusIcon,
    statusText,
  ]);
  card.appendChild(status);

  function refreshStatus() {
    const lanesOn = [...editors.values()].filter((e) => e.lane && e.enabled()).length;
    const maintOn = maint.input.checked;
    const siOn = siSwitch.input.checked;
    let tone = "ok";
    let text;
    if (!maintOn && lanesOn === 0) {
      text =
        "Idle ticks poll and stop. Turn on maintenance and at least one lane to work the backlog while idle.";
      tone = "dim";
    } else if (maintOn && lanesOn === 0) {
      text =
        "Maintenance is on but no lane is enabled — idle ticks will do nothing. Enable a lane or use the recommended set.";
      tone = "warn";
    } else if (!maintOn) {
      text = `${lanesOn} lane${lanesOn === 1 ? "" : "s"} enabled but maintenance is off — they will not run until you turn it on.`;
      tone = "warn";
    } else if (siOn) {
      text = `Idle ticks will run ${lanesOn} lane${lanesOn === 1 ? "" : "s"} and may promote drafts to ready for the opted-in repos (risk ≤ ${riskSel.value}, ≤ ${capInput.value || 1} per tick).`;
    } else {
      text = `Idle ticks will run ${lanesOn} lane${lanesOn === 1 ? "" : "s"}; findings are filed as drafts for you to promote.`;
    }
    statusText.textContent = text;
    status.dataset.tone = tone;
    statusIcon.innerHTML = "";
    statusIcon.appendChild(icon(tone === "warn" ? "alert" : tone === "ok" ? "check" : "clock"));
  }
  maint.input.addEventListener("change", refreshStatus);
  riskSel.addEventListener("change", refreshStatus);
  capInput.addEventListener("input", refreshStatus);
  recommendBtn.addEventListener("click", () => {
    maint.input.checked = true;
    for (const ed of editors.values()) {
      if (IDLE_RECOMMENDED_LANES.includes(ed.key)) ed.toggle.checked = true;
    }
    refreshStatus();
    toast("Recommended lanes selected — save to apply.", { ok: true });
  });
  refreshStatus();

  // ── Save ──────────────────────────────────────────────────────────────────
  const saveBtn = el("button", { class: "btn primary", type: "button" }, [
    icon("check"),
    el("span", {}, "Save idle loops"),
  ]);
  card.appendChild(el("div", { class: "btn-row settings-actions" }, [saveBtn]));

  saveBtn.addEventListener("click", () => {
    runAsyncAction(saveBtn, "Saving…", async () => {
      // Resolve every selection to repo NAMES (nodes expand to their repos),
      // de-duplicating so a repo named twice (directly + via a scope) collapses.
      const namesOf = async (targets) => {
        const names = new Set();
        for (const target of targets) {
          const resolved = await resolveTargetRepos(target);
          for (const name of resolved) names.add(name);
        }
        return [...names];
      };
      const loops = [];
      for (const ed of editors.values()) {
        loops.push({ key: ed.key, enabled: ed.enabled(), repos: await namesOf(ed.targets()) });
      }
      const cap = Math.min(20, Math.max(1, Math.trunc(Number(capInput.value) || 1)));
      await api("PUT", "/api/idle-loops", {
        loops,
        maintenance: { enabled: maint.input.checked },
        self_improve: {
          enabled: siSwitch.input.checked,
          repos: await namesOf(
            typeof siPicker.getTargets === "function" ? siPicker.getTargets() : [],
          ),
          max_risk: riskSel.value,
          max_ready_per_run: cap,
        },
      });
      toast(
        `Saved idle loops (${loops.length} loops, maintenance ${maint.input.checked ? "on" : "off"}).`,
        {
          ok: true,
        },
      );
      router();
    });
  });

  return card;
}

/**
 * One setting row: a label + help on the left, a control on the right. Locked
 * settings render their value read-only with a "set by env" badge; editable ones
 * get a toggle (boolean), number input (int) or text input (csv/string), and
 * register a reader into `editors` so Save can collect the value.
 */
/** A setting's help: the first sentence, the rest folded behind "More" (pages ran 12,000px). */
function settingHelp(text) {
  const t = String(text);
  const m = t.match(/^(.{40,180}?[.!?])\s+(.+)$/s);
  if (!m) return el("p", { class: "setting-help dim" }, t);
  return el("div", { class: "setting-help dim" }, [
    el("p", {}, m[1]),
    el("details", { class: "setting-more" }, [el("summary", {}, "More"), el("p", {}, m[2])]),
  ]);
}
function renderSettingRow(s, editors) {
  const meta = el("div", { class: "setting-meta" }, [
    el("div", { class: "setting-label" }, [
      el("span", {}, s.label || s.key),
      s.envLocked
        ? el("span", { class: "badge env-locked no-dot" }, [icon("lock", "lock-ico"), "set by env"])
        : null,
    ]),
    el("code", { class: "mono setting-key" }, s.key),
    s.help ? settingHelp(s.help) : null,
  ]);

  const control = el("div", { class: "setting-control" }, renderSettingInput(s, editors));

  return el(
    "div",
    {
      class: `setting-row${s.envLocked ? " is-locked" : ""}`,
      id: `set-${s.key}`,
      dataset: { find: `${s.label || ""} ${s.key} ${s.help || ""}`.toLowerCase() },
    },
    [meta, control],
  );
}

/** Build the right-hand control for a setting (or a read-only value when locked). */
function renderSettingInput(s, editors) {
  if (s.envLocked) {
    // Read-only: show the env-driven value if known, else a muted placeholder.
    // The actual env value isn't exposed by the API (it could be a secret), so we
    // only confirm it's locked; the file value (if any) is shown for context.
    const shown = s.value !== "" ? s.value : "—";
    return el("input", {
      type: "text",
      class: "setting-locked-input",
      value: shown,
      readonly: "",
      disabled: "",
      "aria-label": `${s.label} (read-only, set by env)`,
    });
  }

  if (s.type === "boolean") {
    // Show the value the factory will USE (env → file → GAFFER_MODE preset), not
    // only what settings.json stores; an autonomous mode's presets read as on.
    const eff = s.effective !== undefined ? s.effective : s.value;
    const checked = eff === "1" || eff === "true" || eff === "yes" || eff === "on";
    const input = el("input", { type: "checkbox", role: "switch", "aria-label": s.label });
    input.checked = checked;
    // `initial` lets Save send only what the user changed: an untouched switch
    // that merely reflects a mode preset must not be written as an explicit "0".
    editors.set(s.key, { read: () => (input.checked ? "1" : "0"), initial: checked ? "1" : "0" });
    return el("label", { class: "switch" }, [
      input,
      el("span", { class: "switch-track" }, el("span", { class: "switch-thumb" })),
    ]);
  }

  if (s.type === "int") {
    const input = el("input", {
      type: "number",
      inputmode: "numeric",
      step: "1",
      min: "0",
      value: s.value,
      "aria-label": s.label,
    });
    editors.set(s.key, { read: () => input.value.trim(), initial: s.value });
    return input;
  }

  // Enum string → a dropdown of the allowed choices. A leading empty option
  // clears the override back to the built-in default.
  if (Array.isArray(s.choices) && s.choices.length > 0) {
    const select = el("select", { class: "setting-select", "aria-label": s.label });
    const optDefault = el("option", { value: "" }, "— default —");
    if (s.value === "") optDefault.selected = true;
    select.appendChild(optDefault);
    for (const choice of s.choices) {
      const opt = el("option", { value: choice }, choice);
      if (s.value === choice) opt.selected = true;
      select.appendChild(opt);
    }
    editors.set(s.key, { read: () => select.value, initial: s.value });
    return select;
  }

  // csv / free string → a plain text input.
  const input = el("input", {
    type: "text",
    value: s.value,
    placeholder: s.type === "csv" ? "comma,separated,values" : "",
    "aria-label": s.label,
  });
  editors.set(s.key, { read: () => input.value.trim() });
  return input;
}

const POLICY_PACKS = ["solo_loose", "team_light", "factory_strict", "regulated"];

async function renderCreate(param) {
  const [nodesRes, reposRes] = await Promise.all([
    api("GET", "/scope/nodes", undefined, { signal: routeSignal() }),
    api("GET", "/repositories", undefined, { signal: routeSignal() }),
  ]);
  const nodes = nodesRes.nodes || [];
  const allRepos = reposRes.repositories || [];

  const title = el("input", {
    type: "text",
    required: "",
    placeholder: "Short, action-oriented title",
  });
  const desc = el("textarea", { placeholder: "Context, user value, constraints…" });
  const policy = el(
    "select",
    {},
    POLICY_PACKS.map((p, i) => el("option", { value: p, selected: i === 0 }, p)),
  );
  const risk = el("select", {}, [
    el("option", { value: "" }, "default (low)"),
    ...RISK_LEVELS.map((r) => el("option", { value: r }, r)),
  ]);

  // Feature A: the shared repo + scope selector. Suggestions re-populate when the
  // title/description/scope change (debounced), so the picker reflects the draft.
  const selector = renderRepoScopeSelector({
    nodes,
    allRepos,
    getDraft: () => ({ title: title.value.trim(), description: desc.value.trim() }),
  });
  const debouncedSuggest = debounce(() => selector.refreshSuggestions(), 500);
  title.addEventListener("input", debouncedSuggest);
  desc.addEventListener("input", debouncedSuggest);

  const validationMsg = el("p", { class: "form-error", role: "alert", hidden: "" });

  const form = el(
    "form",
    {
      class: "form-grid",
      onsubmit: (e) => {
        e.preventDefault();
        const t = title.value.trim();
        if (!t) return;
        const sel = selector.getSelection();
        // Require at least one write repo — without it the ticket has nowhere to
        // deliver and is un-claimable. Surface the gate inline rather than letting
        // the create through.
        if (!selector.hasWriteRepo()) {
          validationMsg.textContent =
            "Attach at least one repo with write access — the factory needs somewhere to deliver.";
          validationMsg.hidden = false;
          selector.node.scrollIntoView({ behavior: "smooth", block: "center" });
          return;
        }
        validationMsg.hidden = true;
        const body = { title: t, policy_pack: policy.value };
        if (desc.value.trim()) body.description = desc.value.trim();
        if (risk.value) body.risk_level = risk.value;
        if (sel.repoIds.length) body.repoIds = sel.repoIds;
        if (sel.scopeNodeIds.length) body.scopeNodeIds = sel.scopeNodeIds;
        guard(async () => {
          const created = await api("POST", "/tickets", body);
          const ticket = created.ticket;
          toast(`Created ticket #${ticket.number ?? ""}`, { ok: true });
          navigate(`#/ticket/${ticket.id}`);
        });
      },
    },
    [
      field("Title", title),
      field("Description", desc),
      el("div", { class: "form-grid cols-2" }, [
        field("Policy pack", policy),
        field("Risk level", risk),
      ]),
      selector.node,
      validationMsg,
      el("div", { class: "btn-row" }, [
        el("button", { class: "btn", type: "submit" }, "Create ticket"),
      ]),
    ],
  );

  // The page: Plan a build (the team talk, the same panel as the sheet) leads;
  // one ticket on its own (a friendly, outside any campaign) sits beside it.
  const epicsN = nodes.filter((n) => n.type === "epic").length;
  const wrap = el("div", { class: "view view-create" });
  wrap.appendChild(
    viewHead(
      "Plan a build",
      `${plural(allRepos.length, "repo")} to build on · ${plural(epicsN, "campaign")} this season`,
      el("a", { class: "btn", href: "#one-ticket" }, "Or add one ticket"),
    ),
  );
  const planHost = el("div", { class: "cr-plan" });
  const ticketPage = el(
    "section",
    { class: "card prog cr-ticket", id: "one-ticket", "aria-labelledby": "one-ticket-h" },
    [
      (() => {
        const h = panelHead("One ticket", "a friendly: outside any campaign", null, { kit: "sky" });
        h.querySelector(".panel-title").id = "one-ticket-h";
        return h;
      })(),
      el("div", { class: "cr-ticket-body" }, form),
    ],
  );
  wrap.appendChild(el("div", { class: "cr-grid" }, [planHost, ticketPage]));
  wrap._dispose = mountPlanBuildInline(planHost);
  // After the router's scroll-to-top, not before it.
  if (param === "ticket") wrap._mounted = () => setTimeout(() => jumpTo("one-ticket"), 0);
  // Initial suggestion pass once the form is in the DOM (empty draft → likely
  // empty, but a pre-selected scope or single repo can still surface a candidate).
  selector.refreshSuggestions();
  return wrap;
}

/**
 * Shared repo + scope selector (Features A & B). Lets the operator attach one or
 * more repos — each with a write/read/test access level — plus optional scope
 * node(s). Pre-populates from the FG-005 suggestion engine and lets the user
 * accept, edit or drop each suggestion.
 *
 * Returns:
 *   node                — the section element to mount
 *   getSelection()      — { repoIds: [{repo_id, access}], scopeNodeIds: [] }
 *   hasWriteRepo()      — true iff ≥1 attached repo has write access
 *   refreshSuggestions()— re-query suggestions from the current draft + scopes
 */
function renderRepoScopeSelector({ nodes, allRepos, getDraft }) {
  // repo id → access ("write"|"read"|"test"). Insertion order is render order.
  const attached = new Map();
  const scopeNodeIds = new Set();
  const repoById = new Map(allRepos.map((r) => [r.id, r]));
  const repoByName = new Map(allRepos.map((r) => [r.name, r]));

  const scopeList = el("div", { class: "selector-chips" });
  const repoList = el("div", { class: "selector-repos" });
  const suggestBox = el("div", { class: "selector-suggestions" });
  const writeHint = el("p", { class: "selector-hint dim" });

  // --- scope node picker ---------------------------------------------------
  const scopeSel = el("select", {}, [
    el("option", { value: "" }, nodes.length ? "Add a scope node…" : "No scope nodes yet"),
    ...nodes.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  ]);
  scopeSel.addEventListener("change", () => {
    if (!scopeSel.value) return;
    scopeNodeIds.add(scopeSel.value);
    scopeSel.value = "";
    renderScopes();
    refreshSuggestions();
  });

  function renderScopes() {
    clear(scopeList);
    for (const id of scopeNodeIds) {
      const node = nodes.find((n) => n.id === id);
      const name = node ? node.name : id;
      scopeList.appendChild(
        el("span", { class: "chip" }, [
          el("span", {}, name),
          el(
            "button",
            {
              class: "chip-x",
              type: "button",
              "aria-label": `Remove ${name}`,
              onclick: () => {
                scopeNodeIds.delete(id);
                renderScopes();
                refreshSuggestions();
              },
            },
            "✕",
          ),
        ]),
      );
    }
    if (!scopeNodeIds.size)
      scopeList.appendChild(el("span", { class: "dim" }, "No scope linked (optional)."));
  }

  // --- manual repo picker --------------------------------------------------
  const repoSel = el("select", {}, [
    el("option", { value: "" }, "Add a repo…"),
    ...allRepos.map((r) => el("option", { value: r.id }, r.name)),
  ]);
  const accessSel = el(
    "select",
    {},
    TICKET_REPO_ACCESS.map((a, i) => el("option", { value: a, selected: i === 0 }, a)),
  );
  const addRepoBtn = el(
    "button",
    {
      class: "btn small",
      type: "button",
      onclick: () => {
        if (!repoSel.value) return;
        attached.set(repoSel.value, accessSel.value);
        repoSel.value = "";
        renderRepos();
      },
    },
    "Add",
  );

  function setAccess(repoId, access) {
    attached.set(repoId, access);
    renderRepos();
  }

  function renderRepos() {
    clear(repoList);
    for (const [repoId, access] of attached) {
      const repo = repoById.get(repoId) || repoByName.get(repoId);
      const name = repo ? repo.name : repoId;
      const accessControl = el(
        "div",
        { class: "segmented small" },
        TICKET_REPO_ACCESS.map((a) =>
          el(
            "button",
            {
              class: access === a ? "active" : "",
              type: "button",
              onclick: () => setAccess(repoId, a),
            },
            a,
          ),
        ),
      );
      repoList.appendChild(
        el("div", { class: "selector-repo-row" }, [
          el("span", { class: "assoc-name plain" }, name),
          el("div", { class: "selector-repo-controls" }, [
            accessControl,
            el(
              "button",
              {
                class: "chip-x",
                type: "button",
                "aria-label": `Remove ${name}`,
                onclick: () => {
                  attached.delete(repoId);
                  renderRepos();
                },
              },
              "✕",
            ),
          ]),
        ]),
      );
    }
    if (!attached.size) repoList.appendChild(el("p", { class: "dim" }, "No repos attached yet."));
    renderWriteHint();
  }

  function renderWriteHint() {
    const hasWrite = [...attached.values()].includes("write");
    writeHint.className = `selector-hint ${hasWrite ? "ok" : "warn"}`;
    writeHint.textContent = hasWrite
      ? "✓ This ticket has a write target — it can be delivered."
      : "Needs at least one write repo, so the factory has somewhere to deliver.";
  }

  // --- suggestion population ------------------------------------------------
  async function refreshSuggestions() {
    const draft = getDraft ? getDraft() : {};
    const reqBody = {
      ...(draft.title ? { title: draft.title } : {}),
      ...(draft.description ? { description: draft.description } : {}),
      ...(scopeNodeIds.size ? { scopeNodeIds: [...scopeNodeIds] } : {}),
      ...(attached.size ? { repoIds: [...attached.keys()] } : {}),
    };
    clear(suggestBox);
    try {
      const res = await api("POST", "/scope/repo-suggestions", reqBody);
      const suggestions = (res.suggestions || []).filter((s) => !attached.has(s.repoId));
      if (!suggestions.length) return;
      suggestBox.appendChild(
        el(
          "p",
          { class: "selector-sub dim" },
          "Suggested repos — accept to attach with the suggested access:",
        ),
      );
      for (const s of suggestions) {
        const acc = s.suggestedAccess || "read";
        suggestBox.appendChild(
          el("div", { class: "selector-suggestion" }, [
            el("div", { class: "suggestion-main" }, [
              el("span", { class: "assoc-name plain" }, s.repoName || s.repoId),
              accessBadge(acc),
              s.lowConfidence ? badge("low confidence", "no-dot") : null,
            ]),
            el(
              "button",
              {
                class: "btn small primary",
                type: "button",
                onclick: () => {
                  attached.set(s.repoId, acc);
                  renderRepos();
                  refreshSuggestions();
                },
              },
              "Accept",
            ),
          ]),
        );
      }
    } catch (e) {
      if (e.code === "UNAUTHORIZED") return;
      suggestBox.appendChild(
        el("p", { class: "dim" }, "Suggestions unavailable — attach repos manually."),
      );
    }
  }

  const section = el(
    "section",
    { class: "where-section selector-section", "aria-labelledby": "selector-heading" },
    [
      el("h2", { id: "selector-heading", class: "where-heading" }, "Repos & scope"),
      el(
        "p",
        { class: "where-intro dim" },
        "Attach the repos this ticket may write, read or test, and optionally the scope node it lives under.",
      ),
      field("Scope node", scopeSel),
      scopeList,
      el("div", { class: "selector-add-repo" }, [
        field("Repository", repoSel, { class: "grow" }),
        field("Access", accessSel),
        addRepoBtn,
      ]),
      repoList,
      writeHint,
      suggestBox,
    ],
  );

  renderScopes();
  renderRepos();

  return {
    node: section,
    getSelection: () => ({
      repoIds: [...attached.entries()].map(([repo_id, access]) => ({ repo_id, access })),
      scopeNodeIds: [...scopeNodeIds],
    }),
    hasWriteRepo: () => [...attached.values()].includes("write"),
    refreshSuggestions,
  };
}

/** Trailing-edge debounce — coalesces rapid input events into one call. */
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ===========================================================================
//  Decisions — folded into Overview, card reused
// ===========================================================================

// ===========================================================================
//  View: Review queue
// ===========================================================================

function safeHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Render a slice of unified-diff lines as monospace rows, colouring +/- with the
 * existing success/danger tokens. Each line is inserted as its OWN text node
 * (never innerHTML), so a hostile diff line can never inject markup. Returns the
 * scrollable `<pre>` well.
 */
/**
 * One diff as a keyboard-scrollable region: a wide diff scrolls sideways inside
 * its <pre>, so the <pre> is focusable and named (axe scrollable-region-focusable).
 */
function diffPre(lines, label = "Diff", { trimHeader = false } = {}) {
  // A per-file block already names its file: drop git's preamble (diff --git,
  // index, ---/+++) up to the first hunk, when there is one.
  let body = lines;
  if (trimHeader) {
    const h = lines.findIndex((l) => l.startsWith("@@"));
    if (h > 0) body = lines.slice(h);
  }
  // The gutter carries the new file's line numbers (from each @@ header), via a
  // data attribute so the copied text of a line is only the line.
  let ln = null;
  const rows = body.map((line) => {
    let cls = "diff-line";
    const first = line.charAt(0);
    let n = null;
    if (line.startsWith("+++") || line.startsWith("---")) cls += " diff-file";
    else if (line.startsWith("@@")) {
      cls += " diff-hunk";
      const m = line.match(/\+(\d+)/);
      ln = m ? Number(m[1]) : null;
    } else if (first === "+") {
      cls += " diff-add";
      n = ln != null ? ln++ : null;
    } else if (first === "-") cls += " diff-del";
    else if (ln != null && first !== "\\") n = ln++;
    // Render an empty line as a non-breaking space so the row keeps its height.
    return el(
      "div",
      { class: cls, dataset: n != null ? { ln: String(n) } : undefined },
      line === "" ? " " : line,
    );
  });
  return el("pre", { class: "diff-pre", tabindex: "0", role: "region", "aria-label": label }, rows);
}

/** Back-compat: render a whole unified diff as one `<pre>`. */
function diffBody(diffText, label) {
  return diffPre(String(diffText || "").split("\n"), label);
}

/**
 * Split a unified `git diff` into per-file chunks. Each chunk starts at a
 * `diff --git ` line; any preamble before the first such line is dropped.
 *
 * The display PATH is derived from the chunk's `+++ ` line (strip the `b/`
 * prefix), falling back to the `--- ` source (strip `a/`) for a pure deletion
 * (`+++ /dev/null`), and finally to the `diff --git` line. It is used ONLY as a
 * text-node child / attribute value downstream, so a hostile path (spaces,
 * quotes, markup, escaped bytes) is inert — never a DOM id or selector.
 *
 * Per-file +/- counts are best-effort: with a truncated diff the last chunk may
 * be cut mid-line, so these are advisory (the aggregate `truncated` badge stays
 * on the section head).
 */
function splitDiffFiles(diffText) {
  const lines = String(diffText || "").split("\n");
  const files = [];
  let cur = null;
  const flush = () => {
    if (cur) files.push(cur);
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      cur = { header: line, lines: [], additions: 0, deletions: 0 };
    }
    if (!cur) continue; // drop any preamble before the first `diff --git`
    cur.lines.push(line);
    if (line.startsWith("+++ ")) cur.plus = line.slice(4).trim();
    else if (line.startsWith("--- ")) cur.minus = line.slice(4).trim();
    else if (line.charAt(0) === "+") cur.additions += 1;
    else if (line.charAt(0) === "-") cur.deletions += 1;
  }
  flush();
  const stripPrefix = (p, pfx) => (p && p.startsWith(pfx) ? p.slice(pfx.length) : p);
  for (const f of files) {
    let p;
    if (f.plus && f.plus !== "/dev/null") p = stripPrefix(f.plus, "b/");
    else if (f.minus && f.minus !== "/dev/null") p = stripPrefix(f.minus, "a/");
    else p = f.header.replace(/^diff --git\s+/, "");
    f.path = p || "(unknown file)";
  }
  return files;
}

/** A single repo's diff section: header (repo/branch/stats) + per-file file
 *  strip (jumper) + one collapsible `<details>` per file. `repoIdx` scopes the
 *  DOM ids to indices — a path is NEVER used to build an id or selector. */
function repoDiffSection(rd, repoIdx = 0) {
  const statBits = [];
  if (rd.unavailable) {
    statBits.push(el("span", { class: "diff-stat dim" }, rd.message || rd.unavailable));
  } else {
    statBits.push(
      el("span", { class: "diff-stat" }, `${rd.files} file${rd.files === 1 ? "" : "s"}`),
    );
    statBits.push(el("span", { class: "diff-stat diff-add-stat" }, `+${rd.additions}`));
    statBits.push(el("span", { class: "diff-stat diff-del-stat" }, `−${rd.deletions}`));
    if (rd.truncated) statBits.push(el("span", { class: "diff-stat warn" }, "truncated"));
  }
  const header = el("div", { class: "diff-head" }, [
    el("code", { class: "mono diff-repo" }, rd.repo),
    rd.branch
      ? el("span", { class: "diff-branch" }, [
          el("code", { class: "mono" }, `${rd.baseBranch}…${rd.branch}`),
        ])
      : null,
    el("span", { class: "diff-stats" }, statBits),
  ]);
  const risk = rd.unavailable ? null : riskOverlay(rd.riskAnnotations || []);

  if (rd.unavailable) {
    return el("div", { class: "diff-section" }, [header, risk]);
  }

  // Set of risk paths, so a file can carry an ADVISORY marker when its path
  // matches a riskAnnotations entry. Tolerant match survives rename (`old => new`)
  // strings and a/b-prefix / sub-path differences; drives presentation only.
  const riskAnns = rd.riskAnnotations || [];
  const riskInfo = (fp) => {
    for (const a of riskAnns) {
      const paths = a.paths || [];
      const hit = paths.some((p) => p === fp || (p && fp && (p.includes(fp) || fp.includes(p))));
      if (hit) return a;
    }
    return null;
  };

  const files = splitDiffFiles(rd.diff);
  if (files.length === 0) {
    // No parseable `diff --git` chunk (e.g. a plain textual diff): fall back to
    // the single-pre rendering so nothing is lost.
    return el("div", { class: "diff-section" }, [header, risk, diffBody(rd.diff)]);
  }

  // The file list: one row per file, flagged files carry a yellow card, and a
  // goal-difference bar shows lines added (green) against lines removed (red).
  const strip = el("nav", { class: "diff-filestrip", "aria-label": "Files in this diff" });
  const filesBox = el("div", { class: "diff-files" });
  const maxLines = Math.max(1, ...files.map((f) => f.additions + f.deletions));
  const GD_BLOCKS = 16;

  files.forEach((f, fileIdx) => {
    const targetId = `diff-file-${repoIdx}-${fileIdx}`;
    const ann = riskInfo(f.path);
    const riskTitle = ann ? `${String(ann.kind).replace(/-/g, " ")}: ${ann.detail}` : null;
    const isNew = f.minus === "/dev/null";
    const isGone = f.plus === "/dev/null";
    const total = f.additions + f.deletions;
    const blocks = total ? Math.max(1, Math.round((total / maxLines) * GD_BLOCKS)) : 0;
    const addBlocks = total ? Math.round((f.additions / total) * blocks) : 0;
    const gd = el(
      "span",
      { class: "gd", "aria-hidden": "true" },
      Array.from({ length: blocks }, (_, i) => el("i", { class: i < addBlocks ? "gd-a" : "gd-d" })),
    );

    // Jumper row — path is a text node; target id is index-derived, never the path.
    const jump = el(
      "button",
      {
        type: "button",
        class: "diff-filejump" + (ann ? " has-risk" : ""),
        dataset: { fileTarget: targetId },
        title: riskTitle || f.path,
        "aria-label": `${f.path}: ${f.additions} added, ${f.deletions} removed${ann ? `, flagged (${riskTitle})` : ""}`,
        onclick: () => {
          const target = document.getElementById(targetId);
          if (!target) return;
          target.open = true;
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        },
      },
      [
        el("span", { class: "dfj-flag" }, ann ? ycard(14, "diff-file-risk") : null),
        el("code", { class: "mono diff-filejump-path" }, f.path),
        el("span", { class: "diff-filejump-stat" }, [
          el("span", { class: "diff-add-stat" }, `+${f.additions}`),
          el("span", { class: "diff-del-stat" }, `−${f.deletions}`),
        ]),
        gd,
      ],
    );
    strip.appendChild(jump);

    // Collapsible per-file block — native <details>, so collapse hides ONLY this
    // file's lines. The id is index-scoped, never derived from the path.
    const summaryChildren = [
      icon("chevron", "diff-file-chev"),
      el("code", { class: "mono diff-file-path" }, f.path),
      isNew ? el("span", { class: "diff-file-tag" }, "new file") : null,
      isGone ? el("span", { class: "diff-file-tag" }, "deleted") : null,
      el("span", { class: "diff-filejump-stat" }, [
        el("span", { class: "diff-add-stat" }, `+${f.additions}`),
        " ",
        el("span", { class: "diff-del-stat" }, `−${f.deletions}`),
      ]),
    ];
    if (ann) {
      const marker = ycard(14, "diff-file-risk");
      marker.setAttribute("title", riskTitle);
      summaryChildren.push(marker);
    }
    filesBox.appendChild(
      el(
        "details",
        { class: `diff-file-block${ann ? " is-flagged" : ""}`, open: "", id: targetId },
        [
          el("summary", { class: "diff-file-summary" }, summaryChildren),
          ann
            ? el("p", { class: "diff-file-flag" }, [
                ycard(14),
                `${String(ann.kind)
                  .replace(/-/g, " ")
                  .replace(/^./, (c) => c.toUpperCase())}: ${ann.detail}`,
              ])
            : null,
          diffPre(f.lines, `Diff of ${f.path}`, { trimHeader: true }),
        ],
      ),
    );
  });

  return el("div", { class: "diff-section" }, [header, risk, strip, filesBox]);
}

/**
 * ADVISORY risk overlay on the review diff — flags where the reviewer's scarce
 * attention should go FIRST (sensitive paths, dependency changes, large deletions),
 * computed server-side from the real diff (src/services/riskAnnotations.ts). It NEVER
 * gates approval — the authoritative diff + the Approve-gated-on-real-diff check are
 * unchanged. An empty scan shows an explicit "clear" state, not a blank region.
 */
function riskOverlay(anns) {
  if (!anns.length) {
    return el(
      "div",
      { class: "risk-overlay risk-none" },
      "No elevated-risk signals — advisory scan clear.",
    );
  }
  const sevOrder = { high: 0, medium: 1 };
  const badges = [...anns]
    .sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9))
    .map((a) =>
      el(
        "span",
        {
          class: "risk-badge risk-" + (a.severity === "high" ? "high" : "medium"),
          // Full path list on hover; the badge text stays a short summary.
          title: (a.paths || []).join("\n") || a.detail,
        },
        `${String(a.kind).replace(/-/g, " ")}: ${a.detail}`,
      ),
    );
  return el("div", { class: "risk-overlay" }, [
    el("span", { class: "risk-lead" }, "Review first"),
    ...badges,
  ]);
}

/**
 * Decide whether a loaded diff payload is safe to APPROVE off (fix 4, the human
 * backstop to the P0 done-gate). A human must not approve a change they could not
 * actually see, so approval is allowed ONLY when at least one WRITE repo returned
 * a REAL, non-empty diff (no `unavailable` reason). Any repo that came back as
 * `repo_not_on_disk` / `no_branch` / `git_error` / `empty` is surfaced as the
 * blocking reason. Mirrors the backend `hasRealDeliveryDiff` so the UI never
 * offers an approve the server would (rightly) reject.
 */
function diffApprovability(repos) {
  if (!repos || repos.length === 0) {
    return { approvable: false, reason: "No write repos to diff — nothing to review." };
  }
  const hasRealDiff = repos.some(
    (rd) => !rd.unavailable && rd.diff && String(rd.diff).trim() !== "",
  );
  if (hasRealDiff) return { approvable: true, reason: null };
  const blocked = repos.find((rd) => rd.unavailable);
  const reason = blocked
    ? `The diff could not be loaded (${blocked.message || blocked.unavailable}). You can't approve a change you can't see.`
    : "The diff loaded empty — there is no change to review.";
  return { approvable: false, reason };
}

/**
 * Fetch + render the diff-in-review for a ticket (one section per WRITE repo).
 * Returns a placeholder that fills in asynchronously, so the review card / ticket
 * sheet render immediately and the (possibly slow) git diff streams in after.
 *
 * `onState` (optional) is called once the diff load settles with the
 * {@link diffApprovability} verdict, so a caller (the review card) can gate its
 * Approve button on a diff the human could actually see. Until it fires, callers
 * should treat the ticket as NOT approvable (fail-closed).
 */
function renderTicketDiff(ticketId, onState) {
  const box = el("div", { class: "diff-box" }, [el("div", { class: "ac-meta" }, "Loading diff…")]);
  const report = (state, repos = []) => {
    if (typeof onState === "function") onState(state, repos);
  };
  // `_settled` resolves once the diff (or its error) is on screen, so a background
  // refresh can hold the page height until then (review-scroll-jumps-to-top).
  box._settled = api("GET", `/tickets/${ticketId}/diff`, undefined, { signal: routeSignal() })
    .then((res) => {
      clear(box);
      const repos = (res && res.repos) || [];
      if (repos.length === 0) {
        box.appendChild(el("p", { class: "section-note" }, "No write repos to diff."));
        report(diffApprovability(repos));
        return;
      }
      if (repos.length > 1)
        box.appendChild(el("div", { class: "ac-meta" }, `Diff (${repos.length} repos)`));
      repos.forEach((rd, i) => box.appendChild(repoDiffSection(rd, i)));
      report(diffApprovability(repos), repos);
    })
    .catch((e) => {
      clear(box);
      box.appendChild(
        el("p", { class: "policy-result fail" }, `Could not load diff: ${e.message}`),
      );
      report({
        approvable: false,
        reason: `The diff endpoint errored (${e.message}). You can't approve a change you can't see.`,
      });
    });
  return box;
}

/** True when the ticket's events show a merge-conflict-resolved reopen pending re-review. */
function reopenedForReview(events) {
  return (events || []).some((ev) => ev.event_type === "ticket.reopened_for_review");
}

// PAUSE-ON-CAP: pull the latest pause reason/spend/turns/branch off the events so the
// detail view's paused banner can explain WHY the delivery paused. Returns an empty
// shape when there is no pause event (defensive — the banner only renders for
// status === 'paused' anyway).
function pausedInfo(events) {
  const out = { reason: "cap_hit", spend: null, turns: null, branch: null };
  const paused = (events || []).filter((ev) => ev.event_type === "ticket.paused");
  const last = paused[paused.length - 1];
  if (!last) return out;
  let payload;
  try {
    payload = JSON.parse(last.payload_json || "{}");
  } catch {
    // Malformed payload — fall back to the defaults already in `out`.
    return out;
  }
  if (payload.reason) out.reason = payload.reason;
  if (payload.spend != null) out.spend = payload.spend;
  if (payload.turns != null) out.turns = payload.turns;
  if (payload.branch_name != null) out.branch = payload.branch_name;
  return out;
}

/**
 * Definition-of-Done checklist (I3). The runner records the enforced DoD verdict
 * as a `test_output` evidence row whose summary opens with `DoD: PASS|FAIL` and a
 * machine-parseable JSON line: {"dod","gates":[{gate,repo,status,rc,note}…]}.
 * Render the latest such row as a compact ✓/✗ checklist so the reviewer sees a
 * pre-verified board — and, for a failing gate, the captured `note`. A FAIL row
 * here means the delivery was AUTO-REJECTED before review; it lingers only as
 * history, but surfacing it keeps the gate honest. All text goes through text
 * nodes (el coerces strings) — never innerHTML — so it stays XSS-safe.
 */
function parseDodEvidence(evidence) {
  const rows = (evidence || []).filter(
    (ev) =>
      ev.evidence_type === "test_output" &&
      typeof ev.summary === "string" &&
      ev.summary.startsWith("DoD: "),
  );
  if (rows.length === 0) return null;
  // Newest wins: the last attached DoD row reflects the current verdict.
  const summary = rows[rows.length - 1].summary;
  const jsonLine = summary.split("\n")[1] || "";
  try {
    const parsed = JSON.parse(jsonLine);
    if (!parsed || !Array.isArray(parsed.gates)) return null;
    return parsed;
  } catch {
    // A malformed/legacy row must never break the Review view — just skip it.
    return null;
  }
}

function dodChecklist(evidence) {
  const dod = parseDodEvidence(evidence);
  if (!dod) return null;
  const overall = dod.dod === "PASS" ? "PASS" : "FAIL";
  const items = dod.gates.map((g) => {
    const status = g.status === "PASS" ? "pass" : g.status === "FAIL" ? "fail" : "skip";
    const mark = status === "pass" ? "✓" : status === "fail" ? "✗" : "–";
    const children = [
      el("span", { class: `dod-mark dod-${status}` }, mark),
      el("span", { class: "dod-gate" }, String(g.gate || "gate")),
      el("span", { class: "dod-repo ac-meta" }, String(g.repo || "")),
    ];
    // Only surface the note on a failing gate (it carries the captured tail/why).
    if (status === "fail" && g.note) {
      children.push(el("span", { class: "dod-note ac-meta" }, String(g.note)));
    }
    return el("li", { class: "dod-item" }, children);
  });
  return el("div", { class: `review-dod dod-${overall === "PASS" ? "ok" : "bad"}` }, [
    el("div", { class: "ac-meta" }, [
      "Definition of Done ",
      badge(overall === "PASS" ? "all gates green" : "gate failed", "no-dot"),
    ]),
    el("ul", { class: "clean dod-list" }, items),
  ]);
}

function reviewEvidenceList(evidence, acList) {
  if (!evidence || evidence.length === 0) return null;
  const acText = new Map((acList || []).map((a) => [a.id, a.text]));
  const rows = evidence.map((ev) => {
    const link = safeHttpUrl(ev.uri);
    const acLabel = ev.ac_id && acText.has(ev.ac_id) ? acText.get(ev.ac_id) : null;
    // Provenance line — who recorded this evidence and when, plus an explicit flag
    // when it was SELF-REPORTED by a delivery agent so the reviewer weighs it with
    // due skepticism. `recorded_by_agent` is set server-side ONLY when the recording
    // actor is a KNOWN registered agent (a reliable positive signal — agent ids are
    // distinct and never collide with a human/system principal); it is never inferred
    // from an absence. We therefore surface the amber "agent-reported" chip only on a
    // confident match and otherwise show who/when WITHOUT asserting a trust class —
    // no fabricated "trusted" label. `created_by` renders through el() as a text node,
    // so it can never inject markup regardless of its content.
    const who = ev.created_by ? String(ev.created_by) : "—";
    const provBadge =
      ev.recorded_by_agent === true ? badge("agent-reported", "no-dot prov-agent") : null;
    return el("li", { class: "review-evi" }, [
      badge(ev.evidence_type, "no-dot"),
      el("span", { class: "evi-summary" }, ev.summary),
      link ? el("a", { href: link, target: "_blank", rel: "noopener" }, "open") : null,
      acLabel ? el("span", { class: "ac-meta evi-ac" }, `for AC: ${acLabel}`) : null,
      el("div", { class: "ac-meta evi-prov" }, [
        provBadge,
        el("span", { class: "evi-who" }, `${who} · ${fmtTime(ev.created_at)}`),
      ]),
    ]);
  });
  return el("div", { class: "review-evidence" }, [
    el("div", { class: "ac-meta" }, `Evidence (${evidence.length})`),
    el("ul", { class: "clean" }, rows),
  ]);
}

// Preset quick-reject reasons. Tapping a chip fills the reason so an operator
// can reject one-handed on a phone without summoning a keyboard; the free-text
// field stays as a fallback for anything the chips don't cover.
const REJECT_REASON_PRESETS = [
  "Doesn't meet the spec",
  "Tests missing or failing",
  "Wrong approach",
  "Scope creep",
  "Needs cleanup first",
];

/**
 * Modal reject-reason picker that replaces `window.prompt` (a blocking dialog
 * footgun in automation, and a keyboard-only flow on mobile). Presents preset
 * reason chips + a free-text fallback and resolves the trimmed reason via
 * `onConfirm`. The submit control is HELD DISABLED until a reason exists (chip
 * tapped or text typed) and the confirm handler re-checks — preserving the
 * invariant that a reject reason is REQUIRED. Resolves nothing (dialog just
 * closes) on cancel/escape/scrim.
 */
function openRejectDialog({ verb, onConfirm }) {
  const input = el("input", {
    class: "reject-reason-input",
    type: "text",
    placeholder: "Reason…",
    "aria-label": "Reject reason",
  });

  const chipRow = el(
    "div",
    { class: "reject-chips" },
    REJECT_REASON_PRESETS.map((reason) =>
      el(
        "button",
        {
          class: "chip reject-chip",
          type: "button",
          onclick: () => selectChip(reason),
        },
        reason,
      ),
    ),
  );

  const submitBtn = el(
    "button",
    { class: "btn danger", type: "button", disabled: "", onclick: confirm },
    "Reject",
  );

  // Opt-in: capture this rejection reason as a lore DRAFT — the highest-signal human
  // correction the factory ever gets. Human-gated (lands in the memory review queue,
  // never auto-approved). Off by default.
  const captureCheckbox = el("input", {
    type: "checkbox",
    class: "reject-capture-cb",
    id: "reject-capture-lore",
  });
  const captureRow = el(
    "label",
    {
      class: "reject-capture",
      for: "reject-capture-lore",
      title:
        "Files your reason as a DRAFT lore record in the memory review queue — human-gated, never auto-approved. Compounds your correction into the factory's memory.",
    },
    [captureCheckbox, el("span", {}, "Also capture as a lore draft for the team")],
  );

  const dialog = el(
    "div",
    { class: "reject-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Reject reason" },
    [
      el("h2", { class: "reject-dialog-title" }, `Reason for ${verb}`),
      el("p", { class: "reject-dialog-hint" }, "Tap a reason or type your own."),
      chipRow,
      input,
      captureRow,
      el("div", { class: "reject-dialog-actions btn-row" }, [
        el("button", { class: "btn", type: "button", onclick: close }, "Cancel"),
        submitBtn,
      ]),
    ],
  );

  const scrim = el("div", { class: "reject-scrim open" }, [dialog]);
  dialog.addEventListener("click", (e) => e.stopPropagation());
  scrim.addEventListener("click", close);

  function reason() {
    return input.value.trim();
  }
  function syncSubmit() {
    if (reason()) submitBtn.removeAttribute("disabled");
    else submitBtn.setAttribute("disabled", "");
  }
  function selectChip(text) {
    input.value = text;
    chipRow.querySelectorAll(".reject-chip").forEach((c) => {
      c.classList.toggle("chip-active", c.textContent === text);
    });
    syncSubmit();
  }
  function close() {
    document.removeEventListener("keydown", onKey);
    scrim.remove();
  }
  function confirm() {
    const value = reason();
    // Backstop the invariant even if the disabled state were bypassed.
    if (!value) {
      toast("A reason is required", {});
      return;
    }
    const captureLore = captureCheckbox.checked;
    close();
    onConfirm(value, captureLore);
  }
  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter" && document.activeElement === input) {
      e.preventDefault();
      confirm();
    }
  }

  input.addEventListener("input", syncSubmit);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(scrim);
  input.focus();
}

/**
 * Single source of truth for "is a blocking modal open right now?".
 *
 * The review gate's global j/k/a/r shortcuts (and any future global key
 * shortcut) MUST bail when this is true. Without it, a keystroke aimed at an
 * open dialog leaks through to the review queue underneath — the reject-reason
 * dialog is appended to `document.body` (NOT the app/view container the review
 * MutationObserver watches), so the gate's key handler never detaches while a
 * reject is in progress. Pressing `a` after tapping a reason chip would then
 * approve+merge `cards[cursor]` — potentially a DIFFERENT ticket than the one
 * being rejected. That is a reject-to-approve path through the exact human gate
 * this product exists to protect.
 *
 * Keyed on each modal's real open-signal so it can't leak or go stale:
 *   - reject dialog + move-menu are removed from the DOM on close → presence == open;
 *   - command palette + detail sheet persist and toggle an `.open` class.
 * Any modal added later should follow one of those two conventions (or be added
 * to this selector) so global shortcuts stay suppressed underneath it.
 */
function isModalOpen() {
  // Single source of truth for "a modal owns the keyboard" — must list EVERY modal scrim,
  // or the review hotkeys (a = approve+merge) leak through the ones it omits. `.pb-scrim`
  // covers both the Plan-a-build and Author-a-spec panels (they share the class).
  return Boolean(
    document.querySelector(
      ".reject-scrim, .movemenu-scrim, .palette-scrim.open, .sheet-scrim.open, .pb-scrim.open",
    ),
  );
}

/** Who delivered a ticket: the agent on its latest claim. */
function deliveredBy(events) {
  const c = (events || []).filter((e) => e.event_type === "claim.created" && e.actor_id).pop();
  return c ? agentNames.get(c.actor_id) || null : null;
}
/** When the ticket last moved into its current status (the wait starts there). */
function sinceStatus(events, status) {
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event_type !== "ticket.transitioned") continue;
    try {
      if (JSON.parse(e.payload_json || "{}").to === status) return e.created_at;
    } catch {
      /* skip a malformed payload */
    }
  }
  return null;
}
/** The safety hook's blocked writes, from the FG-007 evidence note. */
function blockedWrites(evidence) {
  const out = [];
  for (const ev of evidence || []) {
    const s = String(ev.summary || "");
    if (!/^FG-007/.test(s)) continue;
    for (const line of s.split("\n").slice(1)) {
      const m = line.match(/^BLOCKED[^:]*:\s*(.*):\s*(\/\S+)\s*$/);
      if (m) out.push({ why: m[1].trim(), path: m[2] });
      else if (line.trim()) out.push({ why: line.trim(), path: null });
    }
  }
  return out;
}
/** A long absolute path, shortened to its last three parts. */
function shortPath(p) {
  const parts = String(p || "")
    .split("/")
    .filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : String(p || "");
}
/** One flag: a yellow card, a caps title, what it means, who raised it. */
function reviewFlag(title, body, source) {
  return el("li", { class: "flag" }, [
    ycard(22, "flag-card"),
    el("div", { class: "flag-body" }, [
      el("h3", { class: "flag-title" }, title),
      el("p", { class: "flag-text" }, body),
      source ? el("p", { class: "flag-src" }, source) : null,
    ]),
  ]);
}

/**
 * Review: the gaffer's sign-off, one change per page. The queue runs across the
 * top as tabs (#/review/<id>; #/review opens the first). The sign-off block —
 * Approve, Send back, Won't do — sits above the fold beside the diff, with the
 * flags (yellow cards) under it and a goal-difference file list over the diff.
 * Keys: j / k next / previous change, a arm → a approve, r send back.
 */
async function renderReview(param) {
  const tickets = (await api("GET", "/tickets?status=in_review")).tickets || [];
  const wrap = el("div", { class: "view view-review" });
  // The refresh compares this before re-reading anything (see VIEW_SIGNATURES).
  wrap.dataset.sig = reviewSignature(tickets);
  await ensureAgents();

  const idx = Math.max(0, param ? tickets.findIndex((t) => t.id === param) : 0);
  const gone = param && !tickets.some((t) => t.id === param);

  if (tickets.length === 0 && !gone) {
    wrap.appendChild(viewHead("The gaffer's sign-off", null));
    wrap.appendChild(
      emptyState(
        "Nothing waits for your sign-off.",
        "When an agent delivers, its diff lands here for you to approve or send back.",
      ),
    );
    return wrap;
  }

  const signal = routeSignal();
  // The queue: one tab per change waiting, the current one marked.
  const queue = el(
    "nav",
    {
      class: "rv-queue",
      "aria-label": `Review queue: ${plural(tickets.length, "change")} waiting`,
    },
    tickets.map((q, i) =>
      el(
        "a",
        {
          class: "rv-tab",
          href: `#/review/${q.id}`,
          "aria-current": !gone && i === idx ? "page" : null,
          "aria-label": `#${q.number} ${q.title}`,
        },
        [
          glyph("in_review", 16),
          el("b", {}, q.number != null ? `#${q.number}` : "—"),
          el("span", { class: "rv-tab-t", title: q.title }, q.title),
        ],
      ),
    ),
  );
  if (tickets.length) wrap.appendChild(queue);

  if (gone) {
    // The change was signed off (or moved) since this link was made: say where it is.
    const v = await api("GET", `/tickets/${param}`, undefined, { signal }).catch(() => null);
    const t = v && v.ticket;
    wrap.appendChild(
      el("div", { class: "card rv-gone", role: "status" }, [
        el(
          "h1",
          { class: "rv-gone-h" },
          t
            ? `#${t.number} is ${statusLabel(t.status).toLowerCase()} now.`
            : "That change is not in review.",
        ),
        el("p", {}, [
          t ? el("a", { href: `#/ticket/${t.id}` }, "Open the ticket") : null,
          t && tickets.length ? " · " : null,
          tickets.length
            ? el(
                "a",
                { href: `#/review/${tickets[0].id}` },
                `Next in review: #${tickets[0].number}`,
              )
            : "Nothing else waits for your sign-off.",
        ]),
      ]),
    );
    return wrap;
  }

  const t = tickets[idx];
  const next = tickets[idx + 1] || (idx > 0 ? tickets[0] : null);
  const detail = await api("GET", `/tickets/${t.id}`, undefined, { signal });
  const ac = detail.acceptance_criteria || [];
  const evidence = detail.evidence || [];
  const ticketEvents = detail.events || [];
  const isReopened = reopenedForReview(ticketEvents);
  const satisfied = ac.filter((a) => a.status === "satisfied").length;
  const repo =
    (detail.repositories || []).find((r) => r.access === "write") || detail.repositories?.[0];
  const by = deliveredBy(ticketEvents);
  const since = sinceStatus(ticketEvents, "in_review");
  const dod = parseDodEvidence(evidence);
  const writes = blockedWrites(evidence);
  const prUrl = safeHttpUrl(t.pr_url);

  // Fix 4: a human must not approve a change they couldn't see. Approve starts
  // DISABLED and only enables once the diff loads with a real, non-empty change.
  let diffState = { approvable: false, reason: "Loading the delivery diff…" };
  const doneLine = el("p", { class: "rv-done", role: "status", tabindex: "-1", hidden: "" });
  const approve = () =>
    guard(async () => {
      if (!diffState.approvable) {
        toast(`Can't approve — ${diffState.reason}`, {});
        return;
      }
      const r = await api("POST", `/tickets/${t.id}/review/approve`);
      const to = r && r.ticket && r.ticket.status;
      // Stay on the diff: the button says it is done, and moving on is its own link.
      if (approveBtn) {
        approveBtn.setAttribute("disabled", "");
        approveLabel.textContent = "Approved";
      }
      clear(doneLine);
      doneLine.append(
        `Approved #${t.number}. ${to === "in_testing" ? "It goes to the tester next." : "It is with the merge runner now."} `,
        next
          ? el("a", { href: `#/review/${next.id}` }, `Next in review: #${next.number}`)
          : "Nothing else waits for your sign-off.",
      );
      doneLine.hidden = false;
      doneLine.focus();
      // Pin the address to this change, so a later refresh says where it went
      // instead of silently swapping the next change in under the reader.
      if (!param && typeof history !== "undefined" && history.replaceState)
        history.replaceState(null, "", `#/review/${t.id}`);
      toast("Approved — merging", { ok: true });
      updateNavBadges();
    });
  const reject = (to) => {
    const verb = to === "cancelled" ? "abandoning (won't do)" : `rejecting to ${to}`;
    openRejectDialog({
      verb,
      onConfirm: (reason, captureLore) =>
        guard(async () => {
          const resp = await api("POST", `/tickets/${t.id}/review/reject`, {
            to,
            reason,
            captureLore,
          });
          toast(to === "cancelled" ? "Marked won't do" : `Rejected to ${to}`, { ok: true });
          if (captureLore) {
            const cap = resp && resp.lore_capture;
            if (cap && cap.captured)
              toast("Captured as a lore draft — approve it in memory review", { ok: true });
            else if (cap)
              toast("Rejected, but the lore draft could not be filed (memory unavailable)", {});
          }
          router();
        }),
    });
  };

  const canApprove = hasTicketAction(t.status, "approve");
  // Mouse Approve is a two-step arm→confirm, matching the keyboard path.
  const BTN_ARM_MS = 3000;
  const approveLabel = el("span", {}, "Approve");
  const approveBtn = canApprove
    ? el(
        "button",
        {
          class: "btn primary big signoff-btn",
          type: "button",
          disabled: "",
          "aria-label": "Approve and merge",
        },
        [approveLabel],
      )
    : null;
  let btnArmed = false;
  let btnArmTimer = null;
  const disarmApproveBtn = () => {
    btnArmed = false;
    if (btnArmTimer) {
      clearTimeout(btnArmTimer);
      btnArmTimer = null;
    }
    if (approveBtn) approveBtn.classList.remove("btn-armed");
    if (approveLabel.textContent !== "Approved") approveLabel.textContent = "Approve";
  };
  const onApproveClick = () => {
    if (!diffState.approvable) {
      toast(`Can't approve — ${diffState.reason}`, {});
      return;
    }
    if (btnArmed) {
      disarmApproveBtn();
      approve();
      return;
    }
    btnArmed = true;
    if (approveBtn) approveBtn.classList.add("btn-armed");
    approveLabel.textContent = "Confirm merge";
    btnArmTimer = setTimeout(disarmApproveBtn, BTN_ARM_MS);
  };
  if (approveBtn) {
    approveBtn.addEventListener("click", onApproveClick);
    approveBtn.addEventListener("blur", disarmApproveBtn);
  }
  const diffBlockBanner = el(
    "div",
    { class: "reopen-banner diff-block-banner", style: "display:none" },
    [icon("alert"), ""],
  );

  // Flags: what to look at before signing. Evidence flags now; the diff's risk
  // annotations join them once the diff loads.
  const flagList = el("ul", { class: "flag-list" });
  const flagCount = el("span", { class: "panel-aux" });
  const summary = el("p", { class: "signoff-sum" });
  const flagsNow = [];
  if (isReopened)
    flagsNow.push([
      "Merge conflict resolved",
      "The branch had a conflict that an agent resolved. Re-read the resolved diff before you sign.",
      "Raised by the merge runner",
    ]);
  for (const w of writes)
    flagsNow.push([
      "Blocked write",
      w.path
        ? `The safety hook stopped a write to ${shortPath(w.path)} (${w.why}). Check the change does not depend on it.`
        : w.why,
      "Raised by the safety hook (FG-007)",
    ]);
  if (dod && dod.dod !== "PASS")
    flagsNow.push([
      "Gate failed",
      `The Definition of Done failed: ${dod.gates
        .filter((g) => g.status === "FAIL")
        .map((g) => g.gate)
        .join(", ")}.`,
      "Raised by the runner",
    ]);
  if (ac.length && satisfied < ac.length)
    flagsNow.push([
      "Criteria not met",
      `${ac.length - satisfied} of ${ac.length} acceptance criteria are not satisfied yet.`,
      "From the ticket's criteria",
    ]);
  const paintFlags = (riskAnns) => {
    const all = [
      ...riskAnns.map((a) => [
        String(a.kind)
          .replace(/-/g, " ")
          .replace(/^./, (c) => c.toUpperCase()),
        a.detail +
          (a.kind === "sensitive-path"
            ? ". Check it is safe to ship, and that a migration has a way back."
            : "."),
        "Raised by the server's risk check",
      ]),
      ...flagsNow,
    ];
    clear(flagList);
    for (const [h, b, src] of all) flagList.appendChild(reviewFlag(h, b, src));
    if (!all.length)
      flagList.appendChild(
        el(
          "li",
          { class: "flag-none" },
          "No flags: the risk check, the gates and the safety hook raised nothing.",
        ),
      );
    flagCount.textContent = String(all.length);
    const gates = !dod
      ? "No gate report yet"
      : dod.dod === "PASS"
        ? "Gates passed"
        : "A gate failed";
    const crit = ac.length
      ? ` and ${satisfied} of ${ac.length} acceptance criteria are satisfied`
      : "";
    summary.textContent = all.length
      ? `${plural(all.length, "thing")} to check before you sign: ${all.map((x) => x[0].toLowerCase()).join(", ")}. ${gates}${crit}.`
      : `Nothing flagged. ${gates}${crit}.`;
  };
  paintFlags([]);

  const branchLine = el("p", { class: "rv-branch" }, [
    t.branch_name ? el("code", { class: "mono" }, t.branch_name) : null,
    prUrl ? [" · ", el("a", { href: prUrl, target: "_blank", rel: "noopener" }, "PR")] : null,
  ]);
  const diffAux = el("span", { class: "panel-aux" });
  const applyDiffState = (state, repos = []) => {
    diffState = state || { approvable: false, reason: "The diff state is unknown." };
    if (diffState.approvable) {
      diffBlockBanner.style.display = "none";
      if (approveBtn && approveLabel.textContent !== "Approved")
        approveBtn.removeAttribute("disabled");
    } else {
      diffBlockBanner.style.display = "";
      clear(diffBlockBanner);
      diffBlockBanner.appendChild(icon("alert"));
      diffBlockBanner.appendChild(document.createTextNode(`Approve blocked — ${diffState.reason}`));
      if (approveBtn) approveBtn.setAttribute("disabled", "");
    }
    const live = repos.filter((r) => !r.unavailable);
    paintFlags(live.flatMap((r) => r.riskAnnotations || []));
    if (live.length) {
      const files = live.reduce((n, r) => n + (r.files || 0), 0);
      const add = live.reduce((n, r) => n + (r.additions || 0), 0);
      const del = live.reduce((n, r) => n + (r.deletions || 0), 0);
      diffAux.textContent = plural(files, "file");
      branchLine.append(
        live[0].baseBranch ? ` → ${live[0].baseBranch}` : "",
        ` · ${plural(files, "file")}, `,
        el("span", { class: "diff-add-stat" }, `+${add}`),
        " ",
        el("span", { class: "diff-del-stat" }, `−${del}`),
      );
    }
  };
  const diffBox = renderTicketDiff(
    t.id,
    canApprove ? applyDiffState : (s, r) => applyDiffState(s, r),
  );

  // Header: the yellow card, the number, the title; then the facts in one line.
  wrap.appendChild(
    el("header", { class: "rv-head" }, [
      el("h1", { class: "rv-title" }, [
        ycard(40, "rv-card"),
        el("span", { class: "rv-no" }, t.number != null ? `#${t.number}` : ""),
        " ",
        t.title,
      ]),
      el("p", { class: "rv-meta" }, [
        statusBadge(t.status),
        repo ? repoTag(repo.name, 20) : null,
        riskBadge(t.risk_level),
        by ? el("span", { class: "rv-by" }, ["delivered by ", agentTag(by, 22)]) : null,
        since
          ? el(
              "span",
              { class: "rv-wait" },
              `waiting ${fmtDuration(Date.now() - Date.parse(since))}`,
            )
          : null,
      ]),
      branchLine,
    ]),
  );

  const signoff = el(
    "section",
    {
      class: "card signoff",
      dataset: { reviewIdx: "0" },
      tabindex: "-1",
      "aria-label": "The gaffer's sign-off",
    },
    [
      panelHead("The gaffer's sign-off", null, null, { kit: "claret" }),
      summary,
      canApprove ? diffBlockBanner : null,
      el(
        "div",
        { class: "btn-row review-card-actions" },
        [
          approveBtn,
          hasTicketAction(t.status, "rework")
            ? el(
                "button",
                { class: "btn", type: "button", onclick: () => reject("refining") },
                "Send back…",
              )
            : null,
          hasTicketAction(t.status, "wont_do")
            ? el(
                "button",
                { class: "btn danger", type: "button", onclick: () => reject("cancelled") },
                "Won't do…",
              )
            : null,
        ].filter(Boolean),
      ),
      doneLine,
      next
        ? el(
            "p",
            { class: "rv-next" },
            el(
              "a",
              { href: `#/review/${next.id}` },
              `Next in review: #${next.number} ${next.title}`,
            ),
          )
        : null,
      el("p", { class: "rv-keys" }, [
        el("span", { class: "kbd" }, "a"),
        " twice to approve · ",
        el("span", { class: "kbd" }, "r"),
        " send back · ",
        el("span", { class: "kbd" }, "j"),
        el("span", { class: "kbd" }, "k"),
        " next / previous",
      ]),
    ],
  );
  signoff._actions = { approve, reject };

  const acCard = ac.length
    ? el("section", { class: "card panel rv-ac" }, [
        panelHead("Acceptance criteria", `${satisfied} of ${ac.length}`),
        el(
          "ul",
          { class: "ac-list" },
          ac.map((a) =>
            el("li", { class: `ac-row ac-${a.status}` }, [
              glyph(
                a.status === "satisfied" ? "done" : a.status === "failed" ? "failed" : "draft",
                16,
              ),
              el("span", { class: "ac-row-t" }, a.text),
              el("span", { class: "ac-state" }, a.status.replace(/_/g, " ")),
            ]),
          ),
        ),
      ])
    : null;

  wrap.appendChild(
    el("div", { class: "rv-grid" }, [
      el("div", { class: "rv-left" }, [
        signoff,
        el("section", { class: "rv-flags", "aria-label": "Flags" }, [
          el("h2", { class: "rv-h2" }, ["Flags ", flagCount]),
          flagList,
        ]),
        dodChecklist(evidence),
        acCard,
        el("details", { class: "card rv-evidence" }, [
          el("summary", {}, `The evidence (${evidence.length})`),
          reviewEvidenceList(evidence, ac) || el("p", { class: "dim" }, "No evidence recorded."),
        ]),
      ]),
      el("div", { class: "rv-right" }, [
        el("h2", { class: "rv-h2" }, ["The diff ", diffAux]),
        diffBox,
      ]),
    ]),
  );

  // Keys: j/k move along the queue, a arms → a approves, r sends back, Esc disarms.
  const cards = [signoff];
  const ARM_WINDOW_MS = 3000;
  let armed = false;
  let armTimer = null;
  const disarm = () => {
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    armed = false;
    signoff.classList.remove("card-armed");
  };
  const arm = () => {
    disarm();
    armed = true;
    signoff.classList.add("card-armed");
    armTimer = setTimeout(disarm, ARM_WINDOW_MS);
  };
  // The one change on screen carries the queue cursor.
  signoff.classList.add("card-accent");
  const onKey = (e) => {
    if (!wrap.isConnected) return; // never act on a queue that is not on screen
    if (isModalOpen()) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      disarm();
      const to = tickets[idx + (e.key === "j" ? 1 : -1)];
      if (to) navigate(`#/review/${to.id}`);
    } else if (e.key === "a") {
      e.preventDefault();
      if (armed) {
        disarm();
        cards[0]._actions.approve();
      } else arm();
    } else if (e.key === "Escape") {
      disarm();
    } else if (e.key === "r") {
      e.preventDefault();
      cards[0]._actions.reject("refining");
    }
  };
  document.addEventListener("keydown", onKey);
  let observer = null;
  const teardown = () => {
    document.removeEventListener("keydown", onKey);
    if (armTimer) clearTimeout(armTimer);
    if (btnArmTimer) clearTimeout(btnArmTimer);
    if (observer) observer.disconnect();
  };
  wrap._dispose = teardown;
  observer = new MutationObserver(() => {
    if (!document.body.contains(wrap)) teardown();
  });
  observer.observe(app, { childList: true });
  wrap._settled = diffBox._settled ? Promise.allSettled([diffBox._settled]) : Promise.resolve();
  return wrap;
}

// ===========================================================================
//  Map (UI-000 / UI-001 / UI-002 / UI-003)
// ===========================================================================

const SCOPE_NODE_TYPES = [
  "factory",
  "domain",
  "product",
  "capability",
  "system",
  "service",
  "library",
  "external_dependency",
];
const SCOPE_EDGE_RELATIONS_V1 = ["contains", "depends_on"];
const SCOPE_EDGE_RELATIONS_ADVANCED = [
  "calls",
  "publishes_to",
  "consumes_from",
  "shares_library",
  "deployed_with",
];
const SCOPE_REPO_RELATIONS = [
  "owns",
  "contains",
  "uses",
  "depends_on",
  "shared_by",
  "deployed_with",
  "read_context",
  "write_target",
  "test_target",
];
const SCOPE_REPO_ACCESS = ["write", "read", "test", "none"];

const factoryState = { query: "" };

function parseTags(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}
function typeLabel(type) {
  return String(type || "").replace(/_/g, " ");
}
async function renderFactory() {
  const [nodesRes, edgesRes, unmappedRes] = await Promise.all([
    api("GET", "/scope/nodes"),
    api("GET", "/scope/edges"),
    api("GET", "/scope/unmapped-repos"),
  ]);
  const nodes = nodesRes.nodes || [];
  const edges = edgesRes.edges || [];
  const unmapped = unmappedRes.repositories || [];

  const wrap = el("div", { class: "view" });
  wrap.appendChild(
    viewHead(
      "The scouting map",
      `${plural(nodes.length, "ground")} on the map · ${nodes.filter((n) => n.type === "epic").length} campaigns · ${unmapped.length} unmapped repo${unmapped.length === 1 ? "" : "s"}`,
      el("button", { class: "btn primary", type: "button", onclick: () => navigate("#/node") }, [
        icon("plus"),
        "New scope node",
      ]),
    ),
  );

  wrap.appendChild(
    el("div", { class: "banner" }, [
      el("strong", {}, "How the Map works. "),
      "Scope nodes group products, systems and capabilities into a graph using ",
      el("code", { class: "mono" }, "contains"),
      " and ",
      el("code", { class: "mono" }, "depends_on"),
      " relations. Repos link to one or more nodes, each with its own access level. ",
      el("strong", {}, "Unmapped repos behave as standalone single-repo scopes"),
      " — they work without any mapping, and can be promoted into the graph later without breaking existing tickets.",
    ]),
  );

  const search = el("input", {
    type: "search",
    placeholder: "Search nodes, repos, tags, owners…",
    value: factoryState.query,
    "aria-label": "Search the Map",
    oninput: (e) => {
      factoryState.query = e.target.value;
      applyFactoryFilter(wrap, e.target.value.trim().toLowerCase());
    },
  });
  wrap.appendChild(el("div", { class: "filters" }, [field("Search", search, { style: "flex:1" })]));

  wrap.appendChild(renderScopeGraph(nodes, edges));
  wrap.appendChild(renderUnmappedSection(unmapped));
  wrap.appendChild(renderFactoryFooter());
  applyFactoryFilter(wrap, factoryState.query.trim().toLowerCase());
  return wrap;
}

// Low-key entry point to the (deliberately unadvertised) "Hidden repos" page.
// Not a nav tab — a small footer link under the Map, so a hidden repo
// can be brought back without surfacing the capability prominently.
function renderFactoryFooter() {
  return el("div", { class: "factory-footer dim" }, [
    el(
      "a",
      {
        class: "hidden-repos-link",
        href: "#/hidden",
        title: "Repos hidden from the dashboard",
      },
      "Hidden repos",
    ),
  ]);
}

function renderScopeGraph(nodes, edges) {
  const card = el("div", { class: "card panel scope-graph" }, [
    panelHead("The grounds", "who contains whom · who depends on whom", null, { kit: "ink" }),
  ]);
  if (nodes.length === 0) {
    card.appendChild(
      el("p", { class: "dim" }, "No scope nodes yet. Create one to start mapping your factory."),
    );
    return card;
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // containment depth → graph columns (a node sits one column right of its parent)
  const parents = new Map();
  for (const e of edges) {
    if (e.relation !== "contains") continue;
    if (byId.has(e.from_node_id) && byId.has(e.to_node_id))
      parents.set(e.to_node_id, e.from_node_id);
  }
  const depthOf = (id, seen = new Set()) => {
    const p = parents.get(id);
    if (!p || seen.has(id)) return 0;
    seen.add(id);
    return 1 + depthOf(p, seen);
  };
  const NODE_W = 188,
    NODE_H = 66,
    COLG = 76,
    ROWG = 20,
    PADX = 12,
    PADT = 38,
    PADB = 14;
  // A node nobody contains but something depends on (Stripe, an outside service)
  // sits one column past the deepest node that depends on it, so its dashed line
  // runs forward instead of back across the ground.
  const depOnly = new Map();
  for (const e of edges) {
    if (e.relation === "contains" || parents.has(e.to_node_id)) continue;
    if (!byId.has(e.from_node_id) || !byId.has(e.to_node_id)) continue;
    const isParent = edges.some(
      (x) => x.relation === "contains" && x.from_node_id === e.to_node_id,
    );
    if (!isParent)
      depOnly.set(
        e.to_node_id,
        Math.max(depOnly.get(e.to_node_id) || 0, depthOf(e.from_node_id) + 1),
      );
  }
  const colOf = (id) => (depOnly.has(id) ? depOnly.get(id) : depthOf(id));
  const cols = [];
  for (const n of nodes) {
    const d = colOf(n.id);
    (cols[d] = cols[d] || []).push(n);
  }
  for (let i = 0; i < cols.length; i++) cols[i] = cols[i] || [];
  // Order each column by where its parents sit (a barycentre pass), so contains
  // lines run straight instead of crossing; the factory leads the first column.
  const rowOf = new Map();
  const typeRank = (n) => (n.type === "factory" ? 0 : n.type === "epic" ? 2 : 1);
  cols.forEach((list, ci) => {
    const key = (n) => {
      const ups = edges
        .filter((e) => e.to_node_id === n.id && rowOf.has(e.from_node_id))
        .map((e) => rowOf.get(e.from_node_id));
      return ups.length
        ? ups.reduce((x, y) => x + y, 0) / ups.length
        : ci === 0
          ? typeRank(n) * 100
          : 999;
    };
    list.sort((a, b) => key(a) - key(b) || a.name.localeCompare(b.name));
    list.forEach((n, ri) => rowOf.set(n.id, ri));
  });
  const pos = new Map();
  cols.forEach((list, ci) => {
    list.forEach((n, ri) =>
      pos.set(n.id, { x: PADX + ci * (NODE_W + COLG), y: PADT + ri * (NODE_H + ROWG), n }),
    );
  });
  // Column names from what stands in them (the club, its products, its services…).
  const COL_WORD = {
    factory: "The club",
    domain: "Domains",
    product: "Products",
    capability: "Capabilities",
    service: "Services",
    component: "Components",
    external_dependency: "Outside the ground",
    epic: "Campaigns",
  };
  const colName = (list, ci) => {
    const types = [...new Set(list.map((n) => n.type))];
    if (types.length === 1) return COL_WORD[types[0]] || typeLabel(types[0]);
    if (ci === 0) return "The club and its campaigns";
    return types.map((t) => COL_WORD[t] || typeLabel(t)).join(" · ");
  };
  const maxRows = Math.max(1, ...cols.map((c) => (c ? c.length : 0)));
  const width = PADX * 2 + cols.length * NODE_W + Math.max(0, cols.length - 1) * COLG;
  const height = PADT + maxRows * (NODE_H + ROWG) - ROWG + PADB;

  let paths = "";
  for (const e of edges) {
    const a = pos.get(e.from_node_id),
      b = pos.get(e.to_node_id);
    if (!a || !b) continue;
    const fwd = b.x >= a.x;
    const x1 = fwd ? a.x + NODE_W : a.x,
      y1 = a.y + NODE_H / 2;
    const x2 = fwd ? b.x : b.x + NODE_W,
      y2 = b.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    const cls = e.relation === "contains" ? "contains" : "dep";
    paths += `<path class="gedge ${cls}" d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"/>`;
  }
  const svg = el("div", {
    class: "graph-edges",
    html: `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none">${paths}</svg>`,
  });
  const colLabels = cols.map((_, ci) =>
    el(
      "div",
      { class: "graph-collabel", style: `left:${PADX + ci * (NODE_W + COLG)}px;width:${NODE_W}px` },
      colName(cols[ci], ci),
    ),
  );
  const gnodes = [];
  for (const [id, { x, y, n }] of pos) {
    gnodes.push(
      el(
        "a",
        {
          class: `scope-gnode type-${n.type}`,
          href: `#/node/${id}`,
          dataset: { name: (n.name || "").toLowerCase() },
          style: `left:${x}px;top:${y}px;width:${NODE_W}px;height:${NODE_H}px`,
        },
        [
          el("span", { class: "sg-name" }, n.name),
          el("span", { class: "sg-meta" }, [
            badge(typeLabel(n.type), `type-${n.type}`),
            n.risk_level ? riskBadge(n.risk_level) : null,
          ]),
        ],
      ),
    );
  }
  const legend = el("div", { class: "graph-legend" }, [
    el("span", { class: "gl-item" }, [el("span", { class: "gl-line contains" }), "contains"]),
    el("span", { class: "gl-item" }, [el("span", { class: "gl-line dep" }), "depends on"]),
  ]);
  card.appendChild(
    el("div", { class: "graph-scroll" }, [
      el("div", { class: "graph", style: `width:${width}px;height:${height}px` }, [
        svg,
        ...colLabels,
        ...gnodes,
      ]),
    ]),
  );
  card.appendChild(legend);
  return card;
}

function renderUnmappedSection(unmapped) {
  const card = el("div", { class: "card", dataset: { section: "unmapped" } }, [
    el("h2", {}, `Unmapped repos (${unmapped.length})`),
    el("p", { class: "dim section-note" }, [
      el("strong", {}, "Single-repo mode. "),
      "These repos have no scope mapping, so Dispatch treats each as an implicit single-repo scope — agents work directly against the one repo. ",
      el("strong", {}, "Mapped factory mode"),
      " (above) coordinates work across multiple repos with explicit write / read / test boundaries.",
    ]),
  ]);
  if (unmapped.length === 0) {
    card.appendChild(el("p", { class: "dim" }, "Every known repo is mapped into the graph."));
    return card;
  }
  const rows = unmapped.map((r) =>
    el(
      "tr",
      {
        class: "clickable repo-row",
        dataset: { kind: "repo", repoId: r.id },
        onclick: () => navigate(`#/repo/${r.id}`),
      },
      [
        el("td", { class: "title-cell" }, r.name),
        el(
          "td",
          {},
          r.local_path
            ? el("code", { class: "mono" }, r.local_path)
            : el("span", { class: "dim" }, "—"),
        ),
        el("td", { class: "dim" }, r.stack || "—"),
        el("td", { class: "dim" }, r.default_branch || "—"),
        el("td", {}, renderRepoCommands(r)),
        el("td", { class: "row-actions" }, hideRepoBtn(r)),
      ],
    ),
  );
  const table = el("table", {}, [
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        ["Repo", "Path", "Stack", "Branch", "Commands", ""].map((h) => el("th", {}, h)),
      ),
    ),
    el("tbody", {}, rows),
  ]);
  card.appendChild(el("div", { class: "table-wrap" }, table));
  return card;
}

function renderRepoCommands(repo) {
  const cmds = [
    repo.test_command ? ["test", repo.test_command] : null,
    repo.lint_command ? ["lint", repo.lint_command] : null,
    repo.coverage_command ? ["coverage", repo.coverage_command] : null,
  ].filter(Boolean);
  if (cmds.length === 0) return el("span", { class: "dim" }, "—");
  return el(
    "div",
    { class: "cmd-list" },
    cmds.map(([label, cmd]) =>
      el("div", { class: "cmd-row" }, [
        el("span", { class: "cmd-label" }, label),
        el("code", { class: "mono" }, cmd),
      ]),
    ),
  );
}

/**
 * Repo detail: the Definition-of-Done gate commands, EDITABLE. Onboarding
 * auto-detects them from the manifest; a wrong or missing command is the top
 * reason a delivery bounces (tests gate FAIL) or ships unverified (all gates
 * SKIP), so the operator can correct them here. Empty clears a gate (skipped).
 */
function renderRepoCommandsEditor(repo) {
  // Named distinctly from the global `field()` labelled-control helper it calls.
  const commandField = (name, label, value, ph) => {
    const input = el("input", {
      type: "text",
      name,
      value: value || "",
      placeholder: ph,
      class: "mono",
    });
    return { input, row: field(label, input) };
  };
  const test = commandField("test_command", "Test command", repo.test_command, "e.g. npm test");
  const lint = commandField("lint_command", "Lint command", repo.lint_command, "e.g. npm run lint");
  const cov = commandField(
    "coverage_command",
    "Coverage command",
    repo.coverage_command,
    "optional — e.g. npm run coverage",
  );
  const form = el(
    "form",
    {
      class: "cmd-editor",
      onsubmit: (e) => {
        e.preventDefault();
        guard(async () => {
          await api("POST", `/repos/${repo.id}/commands`, {
            test_command: test.input.value.trim(),
            lint_command: lint.input.value.trim(),
            coverage_command: cov.input.value.trim(),
          });
          toast("Gate commands saved", { ok: true });
          router();
        });
      },
    },
    [
      el("div", { class: "cmd-fields" }, [test.row, lint.row, cov.row]),
      el("div", { class: "cmd-save" }, el("button", { class: "btn", type: "submit" }, "Save")),
    ],
  );
  return el("div", { class: "cmd-block" }, [
    el(
      "p",
      { class: "gr-note" },
      "The runner runs these on every delivery, in its worktree. A failing check sends the delivery back; an empty one is skipped.",
    ),
    form,
  ]);
}

// A discreet "Hide" button for a repo row (WG-006). Stops the row's navigate
// click, confirms, then hides the repo and refreshes — it drops off the list and
// reappears on the "Hidden repos" page.
function hideRepoBtn(repo) {
  return el(
    "button",
    {
      class: "btn small repo-hide-btn",
      type: "button",
      "aria-label": `Hide ${repo.name} from the dashboard`,
      title: "Hide this repo from the dashboard (reversible)",
      onclick: (e) => {
        e.stopPropagation();
        guard(async () => {
          if (
            !window.confirm(
              `Hide “${repo.name}” from the dashboard? It stays registered and can be un-hidden from the Hidden repos page.`,
            )
          )
            return;
          await api("POST", `/repos/${repo.id}/hidden`, { hidden: true });
          toast(`${repo.name} hidden`, { ok: true });
          router();
        });
      },
    },
    "Hide",
  );
}

/** The way back from a ground or repo page to the Map. */
function backToMap() {
  return el(
    "button",
    { class: "back-link", type: "button", onclick: () => navigate("#/factory") },
    "← Back to Map",
  );
}

// View: Hidden repos (WG-006). A deliberately low-key surface — reached only via
// the small footer link on the Map — listing every hidden repo with an
// "Unhide" button that returns it to its normal place.
async function renderHidden() {
  const repos = (await api("GET", "/repositories?hidden=only")).repositories || [];
  const wrap = el("div", { class: "view" });
  wrap.appendChild(
    el(
      "button",
      { class: "back-link", type: "button", onclick: () => navigate("#/factory") },
      "← Back to Map",
    ),
  );
  wrap.appendChild(viewHead("Hidden repos", `${repos.length} hidden`));
  wrap.appendChild(
    el("div", { class: "banner" }, [
      el("strong", {}, "These repos are hidden from the dashboard. "),
      "They stay registered and keep their links and scope mappings, but are excluded from the repo list, the Map unmapped list and repo pickers. Un-hide one to return it to its normal place.",
    ]),
  );

  if (!repos.length) {
    wrap.appendChild(emptyState("No hidden repos", "Nothing is hidden right now.", "map"));
    return wrap;
  }

  const rows = repos.map((r) =>
    el("tr", { class: "repo-row", dataset: { kind: "repo", repoId: r.id } }, [
      el("td", { class: "title-cell" }, r.name),
      el(
        "td",
        {},
        r.local_path
          ? el("code", { class: "mono" }, r.local_path)
          : el("span", { class: "dim" }, "—"),
      ),
      el("td", { class: "dim" }, r.stack || "—"),
      el(
        "td",
        { class: "row-actions" },
        el(
          "button",
          {
            class: "btn primary small",
            type: "button",
            "aria-label": `Unhide ${r.name}`,
            onclick: () =>
              guard(async () => {
                await api("POST", `/repos/${r.id}/hidden`, { hidden: false });
                toast(`${r.name} un-hidden`, { ok: true });
                router();
              }),
          },
          "Unhide",
        ),
      ),
    ]),
  );
  const table = el("table", {}, [
    el(
      "thead",
      {},
      el(
        "tr",
        {},
        ["Repo", "Path", "Stack", ""].map((h) => el("th", {}, h)),
      ),
    ),
    el("tbody", {}, rows),
  ]);
  wrap.appendChild(el("div", { class: "card" }, el("div", { class: "table-wrap" }, table)));
  return wrap;
}

function applyFactoryFilter(wrap, q) {
  wrap.querySelectorAll(".tree-branch").forEach((branch) => {
    const own = branch.querySelector(":scope > .tree-node");
    const text = own ? own.textContent.toLowerCase() : "";
    branch.dataset.self = !q || text.includes(q) ? "1" : "0";
  });
  wrap.querySelectorAll(".tree-branch").forEach((branch) => {
    const selfMatch = branch.dataset.self === "1";
    const childMatch = Array.from(branch.querySelectorAll(".tree-branch")).some(
      (b) => b.dataset.self === "1",
    );
    branch.hidden = !(selfMatch || childMatch);
  });
  wrap.querySelectorAll(".repo-row").forEach((row) => {
    const text = row.textContent.toLowerCase();
    row.hidden = !!q && !text.includes(q);
  });
  // dim scope-graph nodes that don't match (keeps the graph layout stable)
  wrap.querySelectorAll(".scope-gnode").forEach((node) => {
    const text = (node.dataset.name || node.textContent || "").toLowerCase();
    node.classList.toggle("is-dim", !!q && !text.includes(q));
  });
}

// --- View: Scope node editor + detail (UI-001) ------------------------------

async function renderNode(id) {
  const [nodesRes, edgesRes] = await Promise.all([
    api("GET", "/scope/nodes"),
    api("GET", "/scope/edges"),
  ]);
  const allNodes = nodesRes.nodes || [];
  const allEdges = edgesRes.edges || [];

  if (!id) {
    const wrap = el("div", { class: "view" });
    wrap.appendChild(
      el(
        "button",
        { class: "back-link", type: "button", onclick: () => navigate("#/factory") },
        "← Back to Map",
      ),
    );
    wrap.appendChild(viewHead("New scope node"));
    wrap.appendChild(el("div", { class: "card" }, renderNodeForm(null)));
    return wrap;
  }

  const view = await api("GET", `/scope/nodes/${id}`);
  const node = view.node;
  const repos = view.repos || [];

  // The ground's fixtures: the tickets of every repo that plays here (best-effort).
  let tickets = null;
  try {
    const lists = await Promise.all(
      repos
        .filter((r) => r.name)
        .map((r) =>
          api("GET", `/tickets?repo=${encodeURIComponent(r.name)}`).then((x) => x.tickets || []),
        ),
    );
    const seen = new Set();
    tickets = lists.flat().filter((t) => (seen.has(t.id) ? false : seen.add(t.id)));
  } catch {
    tickets = null;
  }

  const wrap = el("div", { class: "view view-ground" });
  wrap.appendChild(backToMap());

  const tags = parseTags(node.tags_json);
  const loreTags = parseTags(node.lore_tags_json);
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const outgoing = allEdges.filter((e) => e.from_node_id === node.id);
  const incoming = allEdges.filter((e) => e.to_node_id === node.id);
  const parent = incoming.find((e) => e.relation === "contains");
  const parentNode = parent ? byId.get(parent.from_node_id) : null;

  const editDetails = el("details", { class: "edit-panel gr-edit" }, [
    el("summary", { class: "btn small" }, "Edit node"),
    el("div", { class: "card gr-edit-body" }, renderNodeForm(node)),
  ]);
  const deleteBtn = el(
    "button",
    {
      class: "btn danger small",
      type: "button",
      onclick: () =>
        guard(async () => {
          if (!window.confirm(`Delete scope node “${node.name}”? This cannot be undone.`)) return;
          await api("DELETE", `/scope/nodes/${node.id}`);
          toast("Scope node deleted", { ok: true });
          navigate("#/factory");
        }),
    },
    "Delete node",
  );

  wrap.appendChild(
    el("header", { class: "gr-head is-node" }, [
      el("div", { class: "gr-head-main" }, [
        el("div", { class: "tk-meta" }, [
          el("span", { class: "gr-type" }, typeLabel(node.type)),
          riskBadge(node.risk_level),
          node.owner ? el("span", { class: "gr-owner" }, `Run by @${node.owner}`) : null,
          parentNode
            ? el("span", {}, [
                "Part of ",
                el(
                  "a",
                  { class: "tk-epic-link", href: `#/node/${parentNode.id}` },
                  parentNode.name,
                ),
              ])
            : null,
        ]),
        el("h1", { class: "detail-title" }, node.name),
        node.description
          ? el("p", { class: "gr-lede desc" }, node.description)
          : el("p", { class: "gr-lede dim" }, "No description yet."),
        tags.length || loreTags.length
          ? el("div", { class: "tag-row" }, [
              ...tags.map((t) => el("span", { class: "tag-chip" }, t)),
              ...loreTags.map((t) => el("span", { class: "tag-chip lore" }, `lore:${t}`)),
            ])
          : null,
        el("div", { class: "gr-actions" }, [editDetails, deleteBtn]),
      ]),
    ]),
  );

  const count = (pred) => (tickets ? tickets.filter(pred).length : 0);
  wrap.appendChild(
    el("div", { class: "kpi-row gr-stats" }, [
      statCell({
        label: "Repos",
        value: String(repos.length),
        sub: `${repos.filter((r) => r.default_access === "write").length} with write access`,
      }),
      statCell({
        label: "Connections",
        value: String(outgoing.length + incoming.length),
        sub: `${outgoing.length} out · ${incoming.length} in`,
      }),
      tickets
        ? statCell({ label: "In play", value: String(count((t) => ON_PITCH.has(t.status))) })
        : null,
      tickets
        ? statCell({ label: "Done", value: String(count((t) => t.status === "done")) })
        : null,
    ]),
  );

  const repoCard = el("section", { class: "card gr-card", "aria-label": "Who plays here" }, [
    panelHead("Who plays here", `${repos.length} repo${repos.length === 1 ? "" : "s"}`, null, {
      kit: "claret",
    }),
    repos.length
      ? el(
          "ul",
          { class: "clean gr-rows" },
          repos.map((r) =>
            el(
              "li",
              {},
              el("div", { class: "assoc-row" }, [
                el("a", { class: "assoc-name gr-repo", href: `#/repo/${r.id}` }, [
                  kitShirt(r.name || r.id, 22),
                  el("span", {}, r.name || r.id),
                ]),
                el("div", { class: "assoc-meta" }, [
                  el("span", { class: "gr-rel" }, r.relation),
                  accessBadge(r.default_access),
                ]),
              ]),
            ),
          ),
        )
      : el("p", { class: "quiet" }, "No repos play here yet. Link one below."),
    el("h3", { class: "gr-sub" }, "Link a repo"),
    renderLinkRepoForm(node.id),
  ]);

  const ticketCard = tickets
    ? el("section", { class: "card gr-card", "aria-label": "Results and fixtures" }, [
        panelHead(
          "Results & fixtures",
          tickets.length ? `latest ${Math.min(8, tickets.length)} of ${tickets.length}` : "",
          null,
          { kit: "ink" },
        ),
        renderRepoTickets(null, tickets),
      ])
    : null;

  const connCard = renderConnectionsCard(node, allNodes, allEdges);

  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("div", { class: "stack" }, [repoCard, ticketCard]),
      el("div", { class: "stack" }, [connCard]),
    ]),
  );
  return wrap;
}

function renderNodeForm(node) {
  const isEdit = !!node;
  const name = el("input", {
    type: "text",
    required: "",
    value: node?.name || "",
    placeholder: "e.g. Trading Platform",
  });
  const type = el(
    "select",
    {},
    SCOPE_NODE_TYPES.map((t) =>
      el("option", { value: t, selected: node?.type === t }, typeLabel(t)),
    ),
  );
  const owner = el("input", {
    type: "text",
    value: node?.owner || "",
    placeholder: "team or person",
  });
  const risk = el(
    "select",
    {},
    RISK_LEVELS.map((r) =>
      el("option", { value: r, selected: (node?.risk_level || "low") === r }, r),
    ),
  );
  const desc = el("textarea", { placeholder: "What is this node, and what does it own?" });
  desc.value = node?.description || "";
  const tags = el("input", {
    type: "text",
    value: parseTags(node?.tags_json).join(", "),
    placeholder: "comma,separated,tags",
  });
  const loreTags = el("input", {
    type: "text",
    value: parseTags(node?.lore_tags_json).join(", "),
    placeholder: "comma,separated,lore tags",
  });
  const splitTags = (v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const form = el(
    "form",
    {
      class: "form-grid",
      onsubmit: (e) => {
        e.preventDefault();
        const body = { name: name.value.trim(), type: type.value, risk_level: risk.value };
        if (!body.name) return;
        if (owner.value.trim()) body.owner = owner.value.trim();
        if (desc.value.trim()) body.description = desc.value.trim();
        body.tags = splitTags(tags.value);
        body.lore_tags = splitTags(loreTags.value);
        guard(async () => {
          if (isEdit) {
            await api("PATCH", `/scope/nodes/${node.id}`, body);
            toast("Scope node updated", { ok: true });
            router();
          } else {
            const r = await api("POST", "/scope/nodes", body);
            toast("Scope node created", { ok: true });
            navigate(`#/node/${r.node.id}`);
          }
        });
      },
    },
    [
      el("div", { class: "form-grid cols-2" }, [
        field("Name", name),
        field("Type", type),
        field("Owner", owner),
        field("Risk level", risk),
      ]),
      field("Description", desc),
      el("div", { class: "form-grid cols-2" }, [field("Tags", tags), field("Lore tags", loreTags)]),
      el("div", { class: "btn-row" }, [
        el(
          "button",
          { class: "btn primary", type: "submit" },
          isEdit ? "Save changes" : "Create node",
        ),
      ]),
    ],
  );
  return form;
}

function renderConnectionsCard(node, allNodes, allEdges) {
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const outgoing = allEdges.filter((e) => e.from_node_id === node.id);
  const incoming = allEdges.filter((e) => e.to_node_id === node.id);
  const edgeRow = (e, dir) => {
    const otherId = dir === "out" ? e.to_node_id : e.from_node_id;
    const other = byId.get(otherId);
    return el(
      "li",
      {},
      el("div", { class: "assoc-row" }, [
        el("span", { class: "edge-text" }, [
          el("span", { class: "gr-rel" }, edgePhrase(e.relation, dir)),
          other
            ? el("a", { class: "assoc-name", href: `#/node/${otherId}` }, other.name)
            : el("span", { class: "dim" }, otherId.slice(0, 8)),
        ]),
        el(
          "button",
          {
            class: "btn danger small",
            type: "button",
            "aria-label": `Remove ${e.relation} edge`,
            onclick: () =>
              guard(async () => {
                await api("DELETE", `/scope/edges/${e.id}`);
                toast("Edge removed", { ok: true });
                router();
              }),
          },
          "✕",
        ),
      ]),
    );
  };
  const list =
    outgoing.length || incoming.length
      ? el("ul", { class: "clean" }, [
          ...outgoing.map((e) => edgeRow(e, "out")),
          ...incoming.map((e) => edgeRow(e, "in")),
        ])
      : el("p", { class: "quiet" }, "No connections yet: this ground stands alone on the map.");
  return el("section", { class: "card gr-card", "aria-label": "Neighbours" }, [
    panelHead("Neighbours", `${outgoing.length + incoming.length} on the map`, null, {
      kit: "sky",
    }),
    list,
    el("h3", { class: "gr-sub" }, "Add a connection"),
    renderAddEdgeForm(node, allNodes),
  ]);
}
/** An edge read from this node's side: "Contains", "Depends on", "Part of", "Needed by". */
function edgePhrase(relation, dir) {
  const words = String(relation || "").replace(/_/g, " ");
  if (dir === "out") return words.charAt(0).toUpperCase() + words.slice(1);
  if (relation === "contains") return "Part of";
  if (relation === "depends_on") return "Needed by";
  return `${words.charAt(0).toUpperCase() + words.slice(1)} (from)`;
}

function renderAddEdgeForm(node, allNodes) {
  const others = allNodes.filter((n) => n.id !== node.id);
  const target = el("select", {}, [
    el("option", { value: "" }, others.length ? "Select target node…" : "No other nodes"),
    ...others.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  ]);
  const relation = el(
    "select",
    {},
    SCOPE_EDGE_RELATIONS_V1.map((r, i) => el("option", { value: r, selected: i === 0 }, r)),
  );
  const advancedToggle = el("input", { type: "checkbox" });
  const advancedWrap = el("label", { class: "checkbox-line" }, [
    advancedToggle,
    " Advanced relations",
  ]);
  advancedToggle.addEventListener("change", () => {
    clear(relation);
    const rels = advancedToggle.checked
      ? [...SCOPE_EDGE_RELATIONS_V1, ...SCOPE_EDGE_RELATIONS_ADVANCED]
      : SCOPE_EDGE_RELATIONS_V1;
    rels.forEach((r, i) => relation.appendChild(el("option", { value: r, selected: i === 0 }, r)));
  });
  const form = el(
    "form",
    {
      class: "inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        if (!target.value) {
          toast("Pick a target node first");
          return;
        }
        const body = { from_node_id: node.id, to_node_id: target.value, relation: relation.value };
        if (advancedToggle.checked && !SCOPE_EDGE_RELATIONS_V1.includes(relation.value))
          body.advanced = true;
        guard(async () => {
          await api("POST", "/scope/edges", body);
          toast("Connection added", { ok: true });
          router();
        });
      },
    },
    [
      field("Connect to", target),
      field("Relation", relation),
      el("div", { class: "field", style: "flex:0 0 auto" }, [
        el("label", { html: "&nbsp;" }),
        advancedWrap,
      ]),
      el("button", { class: "btn", type: "submit" }, "Add connection"),
    ],
  );
  return form;
}

function renderLinkRepoForm(nodeId) {
  const repoSel = el("select", { required: "" }, [el("option", { value: "" }, "Loading repos…")]);
  guard(async () => {
    const repos = (await api("GET", "/repositories")).repositories || [];
    clear(repoSel);
    repoSel.appendChild(el("option", { value: "" }, "Select a repo…"));
    repos.forEach((r) => repoSel.appendChild(el("option", { value: r.id }, r.name)));
  });
  const relation = el(
    "select",
    {},
    SCOPE_REPO_RELATIONS.map((r) => el("option", { value: r, selected: r === "owns" }, r)),
  );
  const access = el(
    "select",
    {},
    SCOPE_REPO_ACCESS.map((a) => el("option", { value: a, selected: a === "write" }, a)),
  );
  const form = el(
    "form",
    {
      class: "inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        if (!repoSel.value) {
          toast("Pick a repo first");
          return;
        }
        guard(async () => {
          await api("POST", "/scope/repos", {
            scope_node_id: nodeId,
            repo_id: repoSel.value,
            relation: relation.value,
            default_access: access.value,
          });
          toast("Repo linked", { ok: true });
          router();
        });
      },
    },
    [
      field("Repo", repoSel),
      field("Relation", relation),
      field("Access", access),
      el("button", { class: "btn", type: "submit" }, "Link repo"),
    ],
  );
  return form;
}

// --- View: Repo profile (UI-002 / UI-003 / UI-006) --------------------------

async function renderRepo(id) {
  if (!id) return renderFactory();
  const [repos, scopesRes, nodesRes] = await Promise.all([
    // include hidden so a hidden repo's detail page still resolves (and can be un-hidden).
    api("GET", "/repositories?hidden=1"),
    api("GET", `/repos/${id}/scopes`),
    api("GET", "/scope/nodes"),
  ]);
  const repo = (repos.repositories || []).find((r) => r.id === id || r.name === id);
  const scopes = scopesRes.scopes || [];
  const allNodes = nodesRes.nodes || [];

  const wrap = el("div", { class: "view view-ground" });
  wrap.appendChild(backToMap());
  if (!repo) {
    wrap.appendChild(
      emptyState("Repository not found", "It may have been removed or renamed.", "map"),
    );
    return wrap;
  }
  // The repo's fixtures: every ticket whose boundary includes it (best-effort).
  let tickets = null;
  let ticketErr = null;
  try {
    tickets = (await api("GET", `/tickets?repo=${encodeURIComponent(repo.name)}`)).tickets || [];
  } catch (e) {
    ticketErr = e;
  }

  const isMapped = scopes.length > 0;
  const hasWrite = scopes.some((s) => s.default_access === "write");
  const count = (pred) => (tickets ? tickets.filter(pred).length : null);
  const inPlay = count((t) => ON_PITCH.has(t.status));
  const done = count((t) => t.status === "done");
  const held = count((t) => OFF_PITCH.has(t.status));

  const hideBtn = repo.hidden
    ? el(
        "button",
        {
          class: "btn small",
          type: "button",
          "aria-label": `Unhide ${repo.name}`,
          onclick: () =>
            guard(async () => {
              await api("POST", `/repos/${repo.id}/hidden`, { hidden: false });
              toast(`${repo.name} un-hidden`, { ok: true });
              router();
            }),
        },
        "Unhide repo",
      )
    : el(
        "button",
        {
          class: "btn small",
          type: "button",
          "aria-label": `Hide ${repo.name} from the dashboard`,
          title: "Hide this repo from the dashboard (reversible)",
          onclick: () =>
            guard(async () => {
              if (
                !window.confirm(
                  `Hide “${repo.name}” from the dashboard? It stays registered and can be un-hidden from the Hidden repos page.`,
                )
              )
                return;
              await api("POST", `/repos/${repo.id}/hidden`, { hidden: true });
              toast(`${repo.name} hidden`, { ok: true });
              navigate("#/factory");
            }),
        },
        "Hide repo",
      );

  const lede = tickets
    ? tickets.length
      ? [
          el("b", {}, `${tickets.length} ticket${tickets.length === 1 ? "" : "s"}`),
          ` ${tickets.length === 1 ? "has" : "have"} played here: ${inPlay} in play, ${done} done`,
          held ? el("span", { class: "is-red" }, `, ${held} off the pitch`) : null,
          ".",
        ]
      : "No ticket has played here yet."
    : null;

  wrap.appendChild(
    el("header", { class: "gr-head" }, [
      el("div", { class: "gr-kit" }, kitShirt(repo.name, 96)),
      el("div", { class: "gr-head-main" }, [
        el("div", { class: "tk-meta" }, [
          el("span", { class: `gr-mapped${isMapped ? "" : " is-off"}` }, [
            glyph(isMapped ? "done" : "draft", 16),
            el(
              "span",
              {},
              isMapped
                ? `On the map · ${scopes.length} ground${scopes.length === 1 ? "" : "s"}`
                : "Not on the map",
            ),
          ]),
          riskBadge(repo.risk_level),
          repo.stack ? el("span", { class: "gr-owner" }, `Stack: ${repo.stack}`) : null,
          repo.hidden ? badge("hidden") : null,
        ]),
        el("h1", { class: "detail-title" }, repo.name),
        lede ? el("p", { class: "gr-lede" }, lede) : null,
        el("div", { class: "gr-actions" }, [hideBtn]),
      ]),
    ]),
  );
  if (tickets && tickets.length) {
    wrap.appendChild(
      el("div", { class: "kpi-row gr-stats" }, [
        statCell({ label: "Tickets", value: String(tickets.length) }),
        statCell({ label: "In play", value: String(inPlay) }),
        statCell({
          label: "Done",
          value: String(done),
          sub: `${Math.round((done / tickets.length) * 100)}% of all`,
        }),
        statCell({ label: "Off the pitch", value: String(held), sub: "blocked, paused or failed" }),
      ]),
    );
  }

  const branchBtn = el(
    "button",
    {
      class: "btn small",
      type: "button",
      "aria-label": `Edit default branch for ${repo.name}`,
      title:
        "The base branch every delivery worktree branches off. A wrong value fails delivery at worktree setup.",
      onclick: () =>
        guard(async () => {
          const next = window.prompt(
            `Default branch for “${repo.name}” — the base every delivery branches off:`,
            repo.default_branch || "main",
          );
          if (next == null) return;
          const branch = next.trim();
          if (!branch || branch === repo.default_branch) return;
          await api("POST", `/repos/${repo.id}/default-branch`, { default_branch: branch });
          toast(`${repo.name} default branch → ${branch}`, { ok: true });
          router();
        }),
    },
    "Edit",
  );
  const kvRow = (k, v) => [el("dt", {}, k), el("dd", {}, v)];
  const groundCard = el("section", { class: "card gr-card", "aria-label": "The ground" }, [
    panelHead("The ground", "where the work is done", null, { kit: "claret" }),
    el("dl", { class: "kv gr-kv" }, [
      ...kvRow(
        "Path",
        repo.local_path
          ? el("code", { class: "mono" }, repo.local_path)
          : el("span", { class: "dim" }, "Not set"),
      ),
      ...kvRow(
        "Default branch",
        el("span", { class: "gr-kv-act" }, [
          el("code", { class: "mono" }, repo.default_branch || "main"),
          branchBtn,
        ]),
      ),
      ...kvRow(
        "Remote",
        repo.remote_url
          ? el("code", { class: "mono" }, repo.remote_url)
          : el("span", { class: "dim" }, "None: local only"),
      ),
    ]),
    !isMapped ? renderMapRepoBox(repo, allNodes) : null,
    !hasWrite
      ? el("div", { class: "warn-box gr-warn" }, [
          ycard(22),
          el("p", {}, [
            el("strong", {}, "No write access. "),
            isMapped
              ? "This repo is on the map, but no link grants write access, so agents cannot deliver code to it."
              : "This repo plays on its own (single-repo mode). Put it on the map with write access to use it in factory mode.",
          ]),
        ])
      : null,
  ]);

  const checksCard = el("section", { class: "card gr-card", "aria-label": "Referee's checks" }, [
    panelHead("Referee's checks", "the Definition of Done", null, { kit: "sky" }),
    renderRepoCommandsEditor(repo),
  ]);

  const scopeCard = el("section", { class: "card gr-card", "aria-label": "On the map" }, [
    panelHead("On the map", `${scopes.length} ground${scopes.length === 1 ? "" : "s"}`, null, {
      kit: "ink",
    }),
    el(
      "p",
      { class: "gr-note" },
      "Each ground on the Map this repo plays for, with its relation and the access agents inherit. Change access in place; change the relation by re-linking.",
    ),
    scopes.length
      ? el(
          "ul",
          { class: "clean gr-rows" },
          scopes.map((s) => renderRepoScopeRow(repo, s)),
        )
      : el("p", { class: "quiet" }, "Not on the map: this repo is its own single-repo scope."),
    el("h3", { class: "gr-sub" }, "Link to a ground"),
    renderAddAssociationForm(repo, allNodes, scopes),
  ]);

  const ticketCard = el(
    "section",
    { class: "card gr-card", "aria-label": "Results and fixtures" },
    [
      panelHead(
        "Results & fixtures",
        tickets && tickets.length
          ? `latest ${Math.min(8, tickets.length)} of ${tickets.length}`
          : "",
        null,
        { kit: "ink" },
      ),
      renderRepoTickets(repo, tickets, ticketErr),
    ],
  );

  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("div", { class: "stack" }, [groundCard, checksCard, scopeCard]),
      el("div", { class: "stack" }, [ticketCard]),
    ]),
  );
  return wrap;
}

function renderRepoScopeRow(repo, s) {
  const accessSel = el(
    "select",
    { class: "access-select", "aria-label": `Default access for ${s.name}` },
    SCOPE_REPO_ACCESS.map((a) => el("option", { value: a, selected: s.default_access === a }, a)),
  );
  accessSel.addEventListener("change", () =>
    guard(async () => {
      await api("PATCH", `/scope/repos/${s.association_id}`, { default_access: accessSel.value });
      toast(`Access set to ${accessSel.value}`, { ok: true });
      router();
    }),
  );
  const relationSel = el(
    "select",
    { class: "access-select", "aria-label": `Relation to ${s.name}` },
    SCOPE_REPO_RELATIONS.map((r) => el("option", { value: r, selected: s.relation === r }, r)),
  );
  relationSel.addEventListener("change", () =>
    guard(async () => {
      await api("DELETE", `/scope/repos/${s.association_id}`);
      await api("POST", "/scope/repos", {
        scope_node_id: s.id,
        repo_id: repo.id,
        relation: relationSel.value,
        default_access: s.default_access,
      });
      toast(`Relation set to ${relationSel.value}`, { ok: true });
      router();
    }),
  );
  return el(
    "li",
    {},
    el("div", { class: "assoc-row assoc-row-edit" }, [
      el("div", { class: "assoc-edit-main" }, [
        el("a", { class: "assoc-name", href: `#/node/${s.id}` }, s.name),
        badge(typeLabel(s.type), `type-${s.type}`),
      ]),
      el("div", { class: "assoc-edit-controls" }, [
        el("label", { class: "assoc-edit-field" }, [
          el("span", { class: "assoc-edit-label" }, "relation"),
          relationSel,
        ]),
        el("label", { class: "assoc-edit-field" }, [
          el("span", { class: "assoc-edit-label" }, "access"),
          accessSel,
        ]),
        el(
          "button",
          {
            class: "btn danger small",
            type: "button",
            "aria-label": `Unlink from ${s.name}`,
            onclick: () =>
              guard(async () => {
                if (
                  !window.confirm(
                    `Unlink ${repo.name} from “${s.name}”? Existing tickets are unaffected.`,
                  )
                )
                  return;
                await api("DELETE", `/scope/repos/${s.association_id}`);
                toast("Association removed", { ok: true });
                router();
              }),
          },
          "Unlink",
        ),
      ]),
    ]),
  );
}

function renderMapRepoBox(repo, allNodes) {
  if (!allNodes.length)
    return el("div", { class: "map-repo-box" }, [
      el("strong", {}, "Unmapped. "),
      "Create a scope node on the Map first, then map this repo into it.",
    ]);
  const nodeSel = el(
    "select",
    { "aria-label": "Scope node to map into" },
    allNodes.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  );
  const accessSel = el(
    "select",
    { "aria-label": "Default access" },
    SCOPE_REPO_ACCESS.filter((a) => a !== "none").map((a) =>
      el("option", { value: a, selected: a === "write" }, a),
    ),
  );
  const mapBtn = el(
    "button",
    {
      class: "btn primary small",
      type: "button",
      onclick: () =>
        guard(async () => {
          await api("POST", "/scope/repos", {
            scope_node_id: nodeSel.value,
            repo_id: repo.id,
            relation: "owns",
            default_access: accessSel.value,
          });
          toast("Repo mapped into the Map", { ok: true });
          router();
        }),
    },
    "Map this repo",
  );
  return el("div", { class: "map-repo-box" }, [
    el("div", { class: "map-repo-lead" }, [
      el("strong", {}, "This repo is unmapped. "),
      "Map it into a scope node to coordinate it in factory mode. Existing tickets are not affected.",
    ]),
    el("div", { class: "map-repo-controls" }, [
      el("label", { class: "assoc-edit-field" }, [
        el("span", { class: "assoc-edit-label" }, "into node"),
        nodeSel,
      ]),
      el("label", { class: "assoc-edit-field" }, [
        el("span", { class: "assoc-edit-label" }, "access"),
        accessSel,
      ]),
      mapBtn,
    ]),
  ]);
}

function renderRepoTickets(repo, tickets, err) {
  const box = el("div", { class: "repo-tickets" });
  if (!tickets) {
    box.appendChild(
      el(
        "p",
        { class: "quiet" },
        `Recent tickets unavailable${err && err.code ? ` (${err.code})` : ""}.`,
      ),
    );
    return box;
  }
  if (!tickets.length) {
    box.appendChild(el("p", { class: "quiet" }, "No tickets reference this repo yet."));
    return box;
  }
  const recent = [...tickets]
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, 8);
  box.appendChild(
    el(
      "ul",
      { class: "clean repo-ticket-list" },
      recent.map((t) =>
        el(
          "li",
          {},
          el("a", { class: "repo-ticket-row", href: `#/ticket/${t.id}` }, [
            el("span", { class: "num" }, t.number != null ? `#${t.number}` : t.id.slice(0, 8)),
            el("span", { class: "repo-ticket-title" }, t.title),
            el("span", { class: "repo-ticket-side" }, [
              statusBadge(t.status),
              el(
                "time",
                { class: "repo-ticket-time", datetime: t.updated_at },
                fmtTime(t.updated_at),
              ),
            ]),
          ]),
        ),
      ),
    ),
  );
  if (tickets.length > recent.length) {
    box.appendChild(
      el("p", { class: "repo-ticket-more" }, [
        `${tickets.length - recent.length} more on the `,
        el("a", { href: "#/work" }, "Work board"),
        ".",
      ]),
    );
  }
  return box;
}

function renderAddAssociationForm(repo, allNodes, existing) {
  const nodeSel = el("select", { required: "" }, [
    el("option", { value: "" }, allNodes.length ? "Select a scope node…" : "No scope nodes yet"),
    ...allNodes.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  ]);
  const relation = el(
    "select",
    {},
    SCOPE_REPO_RELATIONS.map((r) => el("option", { value: r, selected: r === "owns" }, r)),
  );
  const access = el(
    "select",
    {},
    SCOPE_REPO_ACCESS.map((a) => el("option", { value: a, selected: a === "write" }, a)),
  );
  const form = el(
    "form",
    {
      class: "inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        if (!nodeSel.value) {
          toast("Pick a scope node first");
          return;
        }
        const dup = existing.some((s) => s.id === nodeSel.value && s.relation === relation.value);
        if (dup) {
          toast(`Already linked to that node with relation “${relation.value}”.`);
          return;
        }
        guard(async () => {
          await api("POST", "/scope/repos", {
            scope_node_id: nodeSel.value,
            repo_id: repo.id,
            relation: relation.value,
            default_access: access.value,
          });
          toast("Linked to scope node", { ok: true });
          router();
        });
      },
    },
    [
      field("Scope node", nodeSel),
      field("Relation", relation),
      field("Access", access),
      el("button", { class: "btn", type: "submit" }, "Add association"),
    ],
  );
  return form;
}

// ===========================================================================
//  Epics — epic scope nodes + their tickets as a phased, dependency-aware board
// ===========================================================================
//
// An epic is a scope node of type "epic" that `contains` its tickets. There is
// no "tickets-for-epic" endpoint, so the view stitches the tree from the
// existing surfaces: GET /scope/nodes (the epics), GET /tickets (the universe),
// and GET /tickets/:id (each ticket's `scopes` → epic membership, plus its
// `dependencies` → the "blocked by #N" edges). Tickets are grouped into phases
// by their dependency depth so the build order reads top-to-bottom.

/** Cap concurrent ticket-detail fetches so a big backlog doesn't flood the API. */
const EPIC_DETAIL_CONCURRENCY = 6;

/**
 * Assign each ticket a phase = longest dependency chain to a root, computed over
 * the epic's own tickets only. Phase 0 = no in-epic dependencies (e.g. the
 * bootstrap ticket); each subsequent phase hard-waits on the one before it.
 */
function computePhases(tickets, depsById) {
  const inEpic = new Set(tickets.map((t) => t.id));
  const memo = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0; // defensive: cycles are rejected server-side
    visiting.add(id);
    const deps = (depsById.get(id) || []).filter((d) => inEpic.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  const byPhase = new Map();
  for (const t of tickets) {
    const p = depth(t.id);
    if (!byPhase.has(p)) byPhase.set(p, []);
    byPhase.get(p).push(t);
  }
  return byPhase;
}

/** The epic's acceptance ticket (its Final): flagged by the server, or named so. */
function isAcceptanceTicket(t) {
  return !!(
    t &&
    (t.acceptance === 1 || t.acceptance === true || /^Acceptance/i.test(t.title || ""))
  );
}

/**
 * The acceptance ticket is always the Final: it takes a round of its own after
 * every other round, whatever its dependency depth says (an acceptance ticket
 * whose edges were never drawn would otherwise share a round with the work).
 */
function pinAcceptanceLast(byPhase) {
  const keys = [...byPhase.keys()].sort((a, b) => a - b);
  if (keys.length === 0) return byPhase;
  const moved = [];
  for (const k of keys) {
    const list = byPhase.get(k);
    moved.push(...list.filter(isAcceptanceTicket));
    const rest = list.filter((t) => !isAcceptanceTicket(t));
    if (rest.length) byPhase.set(k, rest);
    else byPhase.delete(k);
  }
  if (moved.length) {
    const left = [...byPhase.keys()];
    byPhase.set(left.length ? Math.max(...left) + 1 : 0, moved);
  }
  return byPhase;
}

/** Why a held ticket is held, in the ticket page's own words (its lede, minus the status word). */
function heldReason(t, detail) {
  if (!detail) return [];
  const parts = ticketLede(t, detail.rework_trail || [], detail.events || []);
  return parts.slice(1).filter((p) => typeof p === "string");
}

/** A small red card (held) for a block heading or a table cell: always next to words. */
function redCard(size = 16) {
  return svgEl(
    "svg",
    {
      viewBox: "0 0 12 16",
      width: (size * 0.75).toFixed(1),
      height: size,
      class: "rcard",
      "aria-hidden": "true",
      focusable: "false",
    },
    svgEl("rect", {
      x: 1,
      y: 1,
      width: 10,
      height: 14,
      rx: 1.4,
      fill: "var(--red)",
      stroke: "var(--ycard-edge)",
      "stroke-width": 1.2,
    }),
  );
}

const NEEDS_SIGN_OFF = new Set(["in_review", "ready_for_merge"]);

async function renderEpics(param) {
  // A deep link (#/epics/:nodeId) scrolls to that campaign.
  const focusId = param || null;
  const signal = routeSignal();
  // Claims (who wears which ticket) and specs (what a campaign is played to) are
  // extras: the season still reads without them.
  const extra = (p, fallback) =>
    api("GET", p, undefined, { signal }).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return fallback;
    });
  const [nodesRes, ticketsRes, claimsRes, specsRes] = await Promise.all([
    api("GET", "/scope/nodes", undefined, { signal }),
    api("GET", "/tickets", undefined, { signal }),
    extra("/claims", { claims: [] }),
    extra("/specs", { specs: [] }),
  ]);
  const epics = (nodesRes.nodes || []).filter((n) => n.type === "epic");
  const tickets = ticketsRes.tickets || [];
  const planBtn = el(
    "button",
    { class: "btn primary", type: "button", onclick: () => openPlanBuild() },
    [icon("spark"), el("span", {}, "Plan a build")],
  );
  // Authoring a spec lives on Specs; the season links there.
  const specsLink = el("a", { class: "btn", href: "#/specs" }, "Specs");
  const wrap = el("div", { class: "view view-epics" });

  if (epics.length === 0) {
    wrap.dataset.sig = "empty";
    wrap.appendChild(viewHead("The season", "No campaigns yet", [specsLink, planBtn]));
    wrap.appendChild(
      emptyState(
        "No campaigns on the fixture list.",
        "Describe what to build in plain words: Plan a build proposes the draw (draft tickets, round by round), and the campaign lands here once you confirm it.",
        null,
        el("button", { class: "btn primary", type: "button", onclick: () => openPlanBuild() }, [
          icon("spark"),
          el("span", {}, "Plan a build"),
        ]),
      ),
    );
    return wrap;
  }

  // Membership + dependencies come from each ticket's detail (cached by updated_at).
  const detailById = await ticketDetails(
    tickets.filter((t) => t.status !== "cancelled"),
    signal,
  );
  const membersByEpic = new Map(epics.map((e) => [e.id, []]));
  const depsById = new Map();
  const depViewById = new Map();
  const repoByTicket = new Map();
  for (const t of tickets) {
    const detail = detailById.get(t.id);
    if (!detail) continue;
    const deps = detail.dependencies || [];
    depsById.set(
      t.id,
      deps.map((d) => d.depends_on_ticket_id),
    );
    depViewById.set(t.id, deps);
    const repos = detail.repositories || [];
    const repoW = repos.find((r) => r.access === "write") || repos[0];
    if (repoW) repoByTicket.set(t.id, repoW.name);
    for (const sc of detail.scopes || []) {
      if (membersByEpic.has(sc.id)) membersByEpic.get(sc.id).push({ ...t, ...detail.ticket });
    }
  }
  const agentByTicket = new Map();
  for (const c of (claimsRes && claimsRes.claims) || []) {
    if (c.status && c.status !== "active") continue;
    agentByTicket.set(c.ticket_id, c.agent_display_name || actorName("agent", c.agent_id));
  }

  // A campaign played to a spec: the spec names the epic as its scope node.
  const specByEpic = new Map();
  for (const s of (specsRes && specsRes.specs) || []) {
    if (s.scope_node_id && membersByEpic.has(s.scope_node_id) && !specByEpic.has(s.scope_node_id))
      specByEpic.set(s.scope_node_id, { spec: s, rollup: null });
  }
  await Promise.all(
    [...specByEpic.values()].map((v) =>
      extra(`/specs/${encodeURIComponent(v.spec.id)}/coverage`, null).then((r) => {
        v.rollup = specCoverageRollup(r && r.coverage);
        v.gaps = specGapCount(r && r.coverage, v.spec.status);
      }),
    ),
  );

  const ctx = { depsById, depViewById, detailById, repoByTicket, agentByTicket };
  const seasons = epics.map((epic) => campaignFacts(epic, membersByEpic.get(epic.id) || [], ctx));

  // Same data → same signature → the refresh leaves the page (and its open folds) alone.
  wrap.dataset.sig = hashText(
    JSON.stringify([
      epics.map((e) => [e.id, e.name, e.description || ""]),
      seasons.map((s) =>
        s.members.map((m) => [
          m.id,
          m.status,
          m.title,
          agentByTicket.get(m.id) || "",
          (depViewById.get(m.id) || []).map((d) => `${d.depends_on_ticket_id}:${d.satisfied}`),
        ]),
      ),
      [...specByEpic.entries()].map(([k, v]) => [k, v.spec.id, v.spec.status, v.rollup, v.gaps]),
    ]),
  );

  const allMembers = seasons.flatMap((s) => s.members);
  const heldN = seasons.filter((s) => s.held.length).length;
  const doneN = allMembers.filter((m) => m.status === "done").length;
  wrap.appendChild(
    viewHead(
      "The season",
      `${plural(epics.length, "campaign")} · ${heldN ? `${heldN} held` : "none held"} · ${doneN} of ${plural(allMembers.length, "ticket")} done`,
      [specsLink, planBtn],
    ),
  );
  if (seasons.length > 1) wrap.appendChild(seasonTable(seasons));

  const list = el("div", { class: "epic-list" });
  for (const s of seasons)
    list.appendChild(renderEpicCard(s, ctx, specByEpic.get(s.epic.id), focusId === s.epic.id));
  wrap.appendChild(list);

  // The draw's bracket lines are measured once the page is laid out, and again
  // whenever a draw changes size (fonts landing, a resize, a fold opening).
  let ro = null;
  wrap._mounted = () => {
    const draws = [...wrap.querySelectorAll(".ep-draw")];
    draws.forEach(drawEpicLines);
    if (typeof window.ResizeObserver === "function") {
      ro = new window.ResizeObserver((entries) => {
        for (const e of entries) drawEpicLines(e.target);
      });
      draws.forEach((d) => ro.observe(d));
    }
    if (document.fonts && document.fonts.ready)
      document.fonts.ready.then(() => draws.forEach(drawEpicLines)).catch(() => {});
    // After the router's scroll-to-top, not before it.
    if (focusId) setTimeout(() => jumpTo(`epic-${focusId}`), 0);
  };
  wrap._dispose = () => {
    if (ro) ro.disconnect();
    ro = null;
  };
  return wrap;
}

/** Everything one campaign's page and its table row say, computed once. */
function campaignFacts(epic, members, ctx) {
  const byPhase = pinAcceptanceLast(computePhases(members, ctx.depsById));
  const phases = [...byPhase.keys()].sort((a, b) => a - b);
  const done = members.filter((m) => m.status === "done").length;
  const held = members
    .filter((m) => OFF_PITCH.has(m.status))
    .sort((a, b) => (a.number || 0) - (b.number || 0));
  const heldIds = new Set(held.map((m) => m.id));
  const waits = members.filter(
    (m) => m.status !== "done" && (ctx.depsById.get(m.id) || []).some((d) => heldIds.has(d)),
  );
  const needs = members.filter((m) => NEEDS_SIGN_OFF.has(m.status));
  // Next fixture: a ready ticket that can actually be claimed, i.e. every ticket
  // it waits on is done (the server refuses a claim with DEPENDENCY_BLOCKED otherwise).
  const nextUp = members.filter(
    (m) => m.status === "ready" && (ctx.depViewById.get(m.id) || []).every((d) => d.satisfied),
  );
  const liveIdx = phases.findIndex((p) => (byPhase.get(p) || []).some((t) => t.status !== "done"));
  const won = members.length > 0 && done === members.length;
  return {
    epic,
    members,
    byPhase,
    phases,
    done,
    held,
    heldIds,
    waits,
    needs,
    nextUp,
    liveIdx,
    won,
  };
}

/** "#8, #9 and #10" */
function ticketList(ts) {
  const ns = ts.map((t) => `#${t.number}`);
  return ns.length > 1 ? `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}` : ns[0] || "";
}

/** The table: one line per campaign — its rounds, how far it has got, what holds it. */
function seasonTable(seasons) {
  const rows = seasons.map((s) => {
    const name = s.epic.name;
    const where = s.held.length
      ? el("span", { class: "ep-where is-red" }, [
          redCard(16),
          el("span", {}, [
            "Held at ",
            el(
              "a",
              { href: `#/ticket/${s.held[0].id}`, title: s.held[0].title },
              `#${s.held[0].number}`,
            ),
            s.waits.length
              ? ` · ${ticketList(s.waits)} ${s.waits.length === 1 ? "waits" : "wait"}`
              : "",
          ]),
        ])
      : s.needs.length
        ? el("span", { class: "ep-where" }, [
            ycard(16),
            el("span", {}, [
              el("a", { href: `#/review/${s.needs[0].id}` }, `#${s.needs[0].number}`),
              s.needs[0].status === "in_review"
                ? " waits for your sign-off"
                : " waits for the merge",
            ]),
          ])
        : el(
            "span",
            { class: "ep-where" },
            s.won
              ? [glyph("done", 16), el("span", {}, "Won")]
              : !s.members.length
                ? "No tickets yet"
                : s.nextUp.length
                  ? [
                      glyph("ready", 16),
                      el("span", {}, [
                        "Next: ",
                        el(
                          "a",
                          { href: `#/ticket/${s.nextUp[0].id}`, title: s.nextUp[0].title },
                          `#${s.nextUp[0].number}`,
                        ),
                      ]),
                    ]
                  : [glyph("in_progress", 16), el("span", {}, "In play")],
          );
    const roundsLabel = s.phases.length
      ? s.won
        ? `All ${s.phases.length} rounds won`
        : `Round ${s.liveIdx + 1} of ${s.phases.length}`
      : "No rounds";
    return el("tr", { class: s.held.length ? "is-held" : "" }, [
      el(
        "th",
        { scope: "row", class: "ep-t-name" },
        el("a", { href: `#epic-${s.epic.id}`, title: name }, name),
      ),
      el("td", { class: "ep-t-rounds" }, [
        el(
          "span",
          { class: "ep-mini", role: "img", "aria-label": roundsLabel },
          s.phases.map((p, i) => {
            const tix = s.byPhase.get(p) || [];
            const d = tix.filter((t) => t.status === "done").length;
            const isHeld = tix.some((t) => s.heldIds.has(t.id));
            return el("i", {
              class: isHeld
                ? "is-held"
                : d === tix.length
                  ? "is-won"
                  : i === s.liveIdx
                    ? "is-live"
                    : "",
              style: { "--p": `${tix.length ? Math.round((d / tix.length) * 100) : 0}%` },
            });
          }),
        ),
        el("span", { class: "ep-t-sub", "aria-hidden": "true" }, roundsLabel),
      ]),
      el("td", { class: "ep-t-num tabnum" }, `${s.done}/${s.members.length}`),
      el("td", { class: "ep-t-where" }, where),
    ]);
  });
  return progPage("ep-table", "claret", "The table", `${plural(seasons.length, "campaign")}`, [
    el("div", { class: "ep-table-scroll" }, [
      el("table", { class: "ep-season" }, [
        el(
          "caption",
          { class: "sr-only" },
          "Every campaign: its rounds, tickets done and what holds it",
        ),
        el("thead", {}, [
          el("tr", {}, [
            el("th", { scope: "col" }, "Campaign"),
            el("th", { scope: "col" }, "Rounds"),
            el("th", { scope: "col", class: "ep-t-num" }, "Done"),
            el("th", { scope: "col" }, "Where it stands"),
          ]),
        ]),
        el("tbody", {}, rows),
      ]),
    ]),
  ]);
}

/**
 * One campaign: a programme page. The sky block carries its name and how far it
 * has got (a red card when a ticket holds it); then what holds it and the one
 * thing to do about it, the brief, the spec it is played to, the draw (every
 * ticket, round by round, joined by bracket lines), and the next fixture.
 */
function renderEpicCard(s, ctx, specLink, focused) {
  const { epic, members, byPhase, phases, done, held, waits, needs, nextUp, liveIdx, won } = s;
  const aux = members.length
    ? `${won ? "all rounds won" : `round ${liveIdx + 1} of ${phases.length}`} · ${done} of ${members.length} done`
    : "no tickets";
  const head = panelHead(
    epic.name,
    aux,
    { text: "On the map", href: `#/node/${epic.id}` },
    { kit: "sky", level: "h2" },
  );
  if (held.length)
    head.appendChild(el("span", { class: "ep-flag" }, [redCard(22), el("span", {}, "Held")]));
  else if (needs.length)
    head.appendChild(el("span", { class: "ep-flag" }, [ycard(22), el("span", {}, "Needs you")]));
  else if (won) head.appendChild(el("span", { class: "ep-flag" }, [glyph("done", 20), "Won"]));

  const card = el("article", {
    class: `card epic-card campaign${held.length ? " is-held" : ""}${focused ? " card-accent" : ""}`,
    id: `epic-${epic.id}`,
    "aria-labelledby": `epic-h-${epic.id}`,
  });
  head.querySelector(".panel-title").id = `epic-h-${epic.id}`;
  card.appendChild(head);

  if (members.length === 0) {
    if (epic.description) card.appendChild(el("p", { class: "epic-desc" }, epic.description));
    card.appendChild(el("p", { class: "ep-lede" }, "This campaign has no tickets yet."));
    return card;
  }

  // Where it stands, in one sentence from the data, with the one thing to do.
  const h = held[0];
  const lede = held.length
    ? el("div", { class: "ep-stands is-held" }, [
        el("p", { class: "ep-lede" }, [
          el("b", { class: "is-red" }, [
            glyph("blocked", 18),
            " Held at ",
            el("a", { href: `#/ticket/${h.id}` }, `#${h.number}`),
            ".",
          ]),
          " ",
          el("span", { class: "ep-held-t" }, `“${h.title}”`),
          " ",
          ...heldReason(h, ctx.detailById.get(h.id)),
          waits.length
            ? ` ${ticketList(waits)} ${waits.length === 1 ? "waits" : "wait"} on it.`
            : "",
          held.length > 1
            ? ` ${held.length - 1} more ${held.length === 2 ? "is" : "are"} off the pitch.`
            : "",
        ]),
        el("div", { class: "btn-row" }, [
          h.status === "blocked"
            ? el(
                "button",
                {
                  class: "btn",
                  type: "button",
                  onclick: () =>
                    unblockSheet(h, {
                      reason: heldReason(h, ctx.detailById.get(h.id)).join("").trim(),
                    }),
                },
                `Unblock #${h.number}…`,
              )
            : null,
          el("a", { class: "btn quiet", href: `#/ticket/${h.id}` }, `Open #${h.number}`),
        ]),
      ])
    : el(
        "p",
        { class: "ep-lede" },
        needs.length
          ? [
              ycard(16),
              " ",
              el("a", { href: `#/review/${needs[0].id}` }, `#${needs[0].number}`),
              needs[0].status === "in_review"
                ? " waits for your sign-off."
                : " is approved and waits for the merge.",
              needs.length > 1 ? ` ${needs.length - 1} more after it.` : "",
              " Nothing is holding the campaign.",
            ]
          : won
            ? "Won: every ticket is done, the Final included."
            : `Round ${liveIdx + 1} of ${phases.length} is being played. Nothing is holding it.`,
      );
  card.appendChild(lede);
  if (epic.description) card.appendChild(el("p", { class: "epic-desc" }, epic.description));
  if (specLink) {
    const { spec, rollup, gaps } = specLink;
    card.appendChild(
      el("p", { class: "ep-spec" }, [
        "Played to the spec ",
        el("a", { href: `#/specs/${encodeURIComponent(spec.id)}` }, `“${spec.title}”`),
        ` (${(SPEC_STATUS_LABEL[spec.status] || spec.status || "").toLowerCase()})`,
        rollup && rollup.total
          ? `: ${rollup.covered} of ${plural(rollup.total, "clause")} covered${gaps ? `, ${plural(gaps, "gap")}` : ""}.`
          : ".",
      ]),
    );
  }

  const draw = renderEpicDag(byPhase, phases, { ...ctx, heldIds: s.heldIds, epicName: epic.name });
  const next = el("p", { class: "epic-next" }, [
    el("b", {}, "Next fixture: "),
    nextUp.length
      ? nextUp.flatMap((t, i) => [
          i ? ", " : "",
          el("a", { href: `#/ticket/${t.id}` }, `#${t.number} ${t.title}`),
        ])
      : held.length
        ? "nothing can be claimed until the hold is cleared."
        : won
          ? "none: the campaign is won."
          : (() => {
              // Ready, but waiting on unfinished work: say who, not "nothing is ready".
              const waiting = members.filter((m) => m.status === "ready");
              return waiting.length
                ? `nothing can be claimed yet: ${ticketList(waiting)} ${waiting.length === 1 ? "waits" : "wait"} on unfinished work.`
                : "nothing is ready to claim.";
            })(),
  ]);
  if (won) {
    // A won campaign keeps its page short: the draw folds away.
    card.appendChild(
      el("details", { class: "ep-fold" }, [
        el("summary", {}, `Show the draw (${plural(members.length, "ticket")})`),
        draw,
      ]),
    );
  } else {
    card.appendChild(draw);
    card.appendChild(next);
  }
  return card;
}

/** A round's name: the last round is the Final when it holds the acceptance ticket. */
function epicRoundName(byPhase, phases, i) {
  const p = phases[i];
  return i === phases.length - 1 && i > 0 && (byPhase.get(p) || []).some(isAcceptanceTicket)
    ? "Final"
    : `Round ${i + 1}`;
}

/**
 * The draw: one mown lane per round (a column at desktop, stacked on a phone),
 * every ticket a fixture card in its round, ordered so the bracket lines cross
 * as little as they can. The lines (drawn by drawEpicLines once laid out) join
 * each ticket to what it waits on: solid when met, dashed when not, red dashed
 * out of a held ticket.
 */
function renderEpicDag(byPhase, phases, ctx) {
  const { depViewById, agentByTicket, repoByTicket, heldIds } = ctx;
  const rowOf = new Map();
  const cols = phases.map((p, ci) => {
    const tix = (byPhase.get(p) || []).slice();
    const bary = (t) => {
      const ys = (depViewById.get(t.id) || [])
        .map((d) => rowOf.get(d.depends_on_ticket_id))
        .filter((y) => y != null);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity;
    };
    tix.sort((a, b) =>
      ci === 0
        ? (a.number || 0) - (b.number || 0)
        : bary(a) - bary(b) || (a.number || 0) - (b.number || 0),
    );
    tix.forEach((t, i) => rowOf.set(t.id, i));
    return tix;
  });

  const edges = [];
  const tie = (t) => {
    const deps = depViewById.get(t.id) || [];
    const blockers = deps.filter((d) => !d.satisfied);
    for (const d of deps) {
      if (!rowOf.has(d.depends_on_ticket_id)) continue;
      edges.push({
        from: d.depends_on_ticket_id,
        to: t.id,
        cls: heldIds.has(d.depends_on_ticket_id) ? "held" : d.satisfied ? "sat" : "pend",
      });
    }
    const agent = agentByTicket.get(t.id);
    const repo = repoByTicket.get(t.id);
    const needs = NEEDS_SIGN_OFF.has(t.status);
    const waitsOnHeld = blockers.some((b) => heldIds.has(b.depends_on_ticket_id));
    const label = [
      `#${t.number} ${statusLabel(t.status)}: ${t.title}`,
      repo ? `in ${repo}` : "",
      agent ? `${agent} on it` : "",
      needs ? (t.status === "in_review" ? "waits for your sign-off" : "waits for the merge") : "",
      blockers.length ? `waiting on ${blockers.map((b) => "#" + b.number).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return el(
      "a",
      {
        class: `dag-node status-${t.status}${isAcceptanceTicket(t) ? " is-final" : ""}`,
        href: `#/ticket/${t.id}`,
        title: t.title,
        "aria-label": label,
        dataset: { id: t.id },
      },
      [
        el("span", { class: "dn-top" }, [
          el("span", { class: "dn-num" }, t.number != null ? `#${t.number}` : "—"),
          needs ? ycard(16) : null,
          statusBadge(t.status),
        ]),
        el("span", { class: "dn-title" }, t.title),
        el("span", { class: "dn-foot" }, [
          repo
            ? el("span", { class: "dn-repo" }, [kitShirt(repo, 16), el("span", {}, repo)])
            : null,
          agent
            ? el("span", { class: "dn-agent" }, [
                agentShirt(agent, 22),
                el("span", {}, agentNo(agent)),
              ])
            : null,
          blockers.length
            ? el("span", { class: `dn-block${waitsOnHeld ? " is-red" : ""}` }, [
                waitsOnHeld ? glyph("blocked", 12) : icon("clock", "dn-block-ico", 12),
                `waits on ${blockers.map((b) => (b.number != null ? "#" + b.number : "?")).join(", ")}`,
              ])
            : null,
        ]),
      ],
    );
  };

  const rounds = phases.map((p, ci) => {
    const tix = cols[ci];
    const name = epicRoundName(byPhase, phases, ci);
    const done = tix.filter((t) => t.status === "done").length;
    const isHeld = tix.some((t) => heldIds.has(t.id));
    return el(
      "section",
      {
        class: `ep-round${name === "Final" ? " is-final" : ""}${isHeld ? " is-held" : ""}`,
        "aria-label": `${name}: ${done} of ${tix.length} done`,
      },
      [
        el("header", { class: "ep-round-head" }, [
          el("h3", { class: "ep-round-name" }, name),
          el(
            "span",
            { class: "ep-round-frac tabnum", "aria-hidden": "true" },
            `${done}/${tix.length}`,
          ),
          el(
            "span",
            { class: "ep-round-bar", "aria-hidden": "true" },
            el("i", {
              style: { width: `${tix.length ? Math.round((done / tix.length) * 100) : 0}%` },
            }),
          ),
        ]),
        el(
          "ol",
          { class: "ep-ties" },
          tix.map((t) => el("li", {}, tie(t))),
        ),
      ],
    );
  });

  const lines = svgEl("svg", { class: "ep-lines", "aria-hidden": "true", focusable: "false" });
  const draw = el("div", { class: "ep-draw", style: { "--rounds": String(phases.length) } }, [
    lines,
    ...rounds,
  ]);
  draw._edges = edges;
  return el(
    "div",
    {
      class: "ep-draw-scroll",
      role: "region",
      "aria-label": `${ctx.epicName || "Campaign"}: the draw`,
      tabindex: phases.length >= 6 ? "0" : undefined,
    },
    draw,
  );
}

/**
 * Draw the bracket lines of one draw from where its cards actually are. Each
 * line leaves the right edge of the ticket waited on, turns at the lane edge of
 * the waiting ticket's round, and enters its left edge. Rounds that stack (a
 * phone) carry "waits on #N" on the cards instead, and no lines.
 */
function drawEpicLines(draw) {
  const svg = draw && draw.querySelector(".ep-lines");
  if (!svg || !draw.isConnected) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const rounds = [...draw.querySelectorAll(".ep-round")];
  const box = draw.getBoundingClientRect();
  const side =
    rounds.length > 1 &&
    Math.abs(rounds[0].getBoundingClientRect().top - rounds[1].getBoundingClientRect().top) < 2 &&
    box.width > 0;
  svg.style.display = side ? "" : "none";
  if (!side) return;
  const w = Math.round(draw.scrollWidth),
    h = Math.round(draw.scrollHeight);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  const nodeOf = new Map([...draw.querySelectorAll(".dag-node")].map((n) => [n.dataset.id, n]));
  const roundOf = (n) => n.closest(".ep-round");
  const order = { sat: 0, pend: 1, held: 2 };
  const edges = (draw._edges || []).filter((e) => nodeOf.has(e.from) && nodeOf.has(e.to));
  const midY = (n) => {
    const r = n.getBoundingClientRect();
    return r.top + Math.min(r.height / 2, 28) - box.top;
  };
  // Lines that leave one card, or enter one, fan out a few pixels apart (ordered
  // by where the other end is), so two lines never share a segment: a met line
  // under an unmet one would read as met.
  const FAN = 6;
  const fan = (key, other) => {
    const groups = new Map();
    for (const e of edges) {
      const k = e[key];
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const off = new Map();
    for (const list of groups.values()) {
      list.sort((p, q) => midY(nodeOf.get(p[other])) - midY(nodeOf.get(q[other])));
      list.forEach((e, i) => off.set(e, (i - (list.length - 1) / 2) * FAN));
    }
    return off;
  };
  const outOff = fan("from", "to");
  const inOff = fan("to", "from");
  // Each straight run is its own path whose dashes are phased to the page, not to
  // the path, so where two dashed runs still overlap their dashes coincide.
  const period = { pend: 8, held: 12 };
  const seg = (cls, xa, ya, xb, yb) => {
    const horiz = Math.abs(ya - yb) < 0.5;
    const lo = horiz ? Math.min(xa, xb) : Math.min(ya, yb);
    const hi = horiz ? Math.max(xa, xb) : Math.max(ya, yb);
    if (hi - lo < 0.5) return;
    const d = horiz
      ? `M${lo.toFixed(1)} ${ya.toFixed(1)} H${hi.toFixed(1)}`
      : `M${xa.toFixed(1)} ${lo.toFixed(1)} V${hi.toFixed(1)}`;
    const attrs = { class: `edge ${cls}`, d };
    if (period[cls]) attrs["stroke-dashoffset"] = (lo % period[cls]).toFixed(1);
    svg.appendChild(svgEl("path", attrs));
  };
  for (const e of edges.slice().sort((a, b) => order[a.cls] - order[b.cls])) {
    const a = nodeOf.get(e.from),
      b = nodeOf.get(e.to);
    const ra = a.getBoundingClientRect(),
      rb = b.getBoundingClientRect(),
      lane = roundOf(b).getBoundingClientRect();
    const x1 = ra.right - box.left,
      y1 = midY(a) + (outOff.get(e) || 0),
      x2 = rb.left - box.left,
      y2 = midY(b) + (inOff.get(e) || 0);
    if (x2 <= x1) continue;
    const xm = Math.max(x1 + 6, Math.min(x2 - 6, lane.left - box.left));
    seg(e.cls, x1, y1, xm, y1);
    seg(e.cls, xm, y1, xm, y2);
    seg(e.cls, xm, y2, x2, y2);
  }
}

// ===========================================================================
//  Plan a build — the decompose chat panel (a docked, mobile-first sheet)
// ===========================================================================
//
// One-line brief → POST /plan-build → the backend spawns the decompose helper →
// it answers with a clarify turn (questions), a plan (proposed epic + tickets),
// or an error. The FRONTEND accumulates the conversation `history` and replays
// it each turn. A plan is PROPOSED ONLY — "Create these tickets" is the human's
// explicit confirm, which POSTs the plan to /epics and lands DRAFT tickets.

// The conversation no longer dead-ends client-side: a long chat is never blocked.
// "Build the tickets" (forcePlan) is always available so the user can break out at
// any point, and the decomposer's own advisory turn ceiling force-plans rather than
// rejecting — see PLAN_BUILD_FORCE_EMPHASIS_TURNS for when the escape is emphasised.

// H9 — DURABLE SESSIONS: the panel persists its conversation to the server via
// /plan-sessions so a reload or navigation-away restores the exact history +
// proposed plan. Each turn calls POST /plan-sessions/:id/turns to append both
// the user message and the assistant reply. On first open the panel fetches
// GET /plan-sessions/active to restore any in-progress session. "Start new plan"
// archives the current session (POST /plan-sessions/:id/archive, status:abandoned)
// and creates a fresh one. Confirming a plan archives with status:confirmed.
//
// GRACEFUL DEGRADATION: every session API call is best-effort. If the endpoint
// is unreachable (older server, network blip) the panel continues with in-memory
// state exactly as before H9 — `planBuildState.sessionId` stays null and no
// persistence calls are attempted for that session.

let planBuildEls = null;
let planBuildState = null;

function ensurePlanBuild() {
  if (planBuildEls) return planBuildEls;
  const scrim = el("div", { class: "pb-scrim", onclick: closePlanBuild });
  const log = el("div", { class: "pb-log", role: "log", "aria-live": "polite" });
  const input = el("textarea", {
    class: "pb-input",
    rows: "1",
    placeholder: "Describe the app you want to build…",
    "aria-label": "Your message",
  });
  const sendBtn = el(
    "button",
    { class: "btn pb-send", type: "submit", "aria-label": "Send" },
    icon("send"),
  );
  // "Build the tickets now" escape: forces the decomposer to emit a plan from the
  // brief + answers so far. Always visible so the user is NEVER stuck clarifying;
  // it gets emphasised once the conversation runs several turns deep (see render).
  const forceBtn = el(
    "button",
    {
      class: "btn primary pb-force",
      type: "button",
      "aria-label": "Build the tickets now from what you've told me",
      onclick: () => submitPlanBuildTurn({ forcePlan: true }),
    },
    [icon("check"), el("span", {}, "Build the tickets")],
  );
  const actions = el("div", { class: "pb-actions" }, [
    forceBtn,
    el("span", { class: "pb-keys" }, "Enter sends · Shift+Enter for a new line"),
    sendBtn,
  ]);
  const form = el("form", { class: "pb-composer" }, [input, actions]);
  const titleEl = el("div", { class: "pb-title" }, "Plan a build");
  const subEl = el("div", { class: "pb-sub" }, "Your brief → the planner's questions → the draw");
  const closeBtn = el(
    "button",
    { class: "icon-btn pb-close", type: "button", "aria-label": "Close", onclick: closePlanBuild },
    icon("close", "", 20),
  );
  const panel = el(
    "aside",
    { class: "pb-panel", role: "dialog", "aria-modal": "true", "aria-label": "Plan a build" },
    [
      el("header", { class: "pb-head" }, [
        el("div", { class: "pb-head-main" }, [titleEl, subEl]),
        el("div", { class: "pb-head-actions" }, [
          el(
            "button",
            {
              class: "btn pb-new-plan",
              type: "button",
              "aria-label": "Start a new plan (archives current conversation)",
              onclick: startNewPlanBuild,
            },
            "New plan",
          ),
          closeBtn,
        ]),
      ]),
      el("p", { class: "pb-guardrail" }, [
        el("b", {}, "Proposes only. "),
        "Nothing runs until you confirm, and confirmed tickets land as draft (or ready, if you say so).",
      ]),
      log,
      form,
    ],
  );
  panel.addEventListener("click", (e) => e.stopPropagation());

  // Auto-grow the composer; Enter sends, Shift+Enter is a newline.
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitPlanBuildTurn();
  });
  scrim.appendChild(panel); // the panel must live inside the scrim (click-outside closes; panel stops propagation)
  document.body.appendChild(scrim);

  planBuildEls = {
    scrim,
    panel,
    log,
    input,
    sendBtn,
    forceBtn,
    form,
    titleEl,
    subEl,
    closeBtn,
    inline: null,
  };
  return planBuildEls;
}

// ---------------------------------------------------------------------------
//  Session helpers — best-effort; never throw to the caller.
// ---------------------------------------------------------------------------

/**
 * Restore the in-progress session state from a server session row.
 * Parses messages_json and populates planBuildState.history + plan.
 * The server stores assistant turns as JSON-stringified decompose envelopes;
 * user turns store the raw text in `content`.
 */
function restorePlanBuildSession(session) {
  if (!planBuildState || !session) return;
  planBuildState.sessionId = session.id;
  planBuildState.brief = session.brief || null;

  let messages;
  try {
    messages = JSON.parse(session.messages_json || "[]");
  } catch {
    messages = [];
  }

  const history = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      // First user message is the brief; subsequent ones are answers.
      const isFirst = history.filter((t) => t.role === "user").length === 0;
      history.push(
        isFirst ? { role: "user", brief: msg.content } : { role: "user", answer: msg.content },
      );
    } else if (msg.role === "assistant") {
      try {
        const envelope = JSON.parse(msg.content);
        if (envelope && envelope.phase === "clarify") {
          history.push({ role: "assistant", questions: envelope.questions || [] });
        }
        // plan turns are restored via plan_json below, not via history
      } catch {
        // Malformed assistant message — skip.
      }
    }
  }
  planBuildState.history = history;

  if (session.plan_json) {
    try {
      planBuildState.plan = JSON.parse(session.plan_json);
    } catch {
      planBuildState.plan = null;
    }
  }
}

/**
 * Create a new server-side session. Best-effort: if the API is unreachable,
 * sessionId stays null and the panel works in pure in-memory mode.
 */
async function createPlanBuildSession() {
  try {
    const res = await api("POST", "/plan-sessions");
    if (res && res.session && res.session.id) {
      planBuildState.sessionId = res.session.id;
    }
  } catch {
    // Degrade gracefully — session persistence unavailable.
  }
}

/**
 * Append a message to the current session. Called after each user turn and
 * after each assistant reply. Best-effort — never interrupts the chat.
 */
async function persistPlanBuildTurn(role, content, opts) {
  const id = planBuildState && planBuildState.sessionId;
  if (!id) return;
  try {
    await api("POST", `/plan-sessions/${id}/turns`, { role, content, ...opts });
  } catch {
    // Session persistence unavailable — continue in-memory.
  }
}

/**
 * Archive the current session (if any). Called on "Start new plan" (abandoned)
 * and on confirmPlanBuild (confirmed). Best-effort.
 */
async function archivePlanBuildSession(status) {
  const id = planBuildState && planBuildState.sessionId;
  if (!id) return;
  try {
    await api("POST", `/plan-sessions/${id}/archive`, { status });
  } catch {
    // Ignore — the session may not exist on an older server.
  }
}

function openPlanBuild(opts = {}) {
  const els = ensurePlanBuild();
  // On the Plan-a-build page the panel is part of the page: (re)start it there.
  if (els.inline && els.inline.isConnected && els.inline.contains(els.panel)) {
    startPlanBuild(opts);
    els.panel.scrollIntoView?.({
      block: "start",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    return;
  }
  startPlanBuild(opts);
  els.scrim.classList.add("open");
  document.addEventListener("keydown", planBuildKeydown);
}

/**
 * The Plan-a-build page (#/create) hosts the same panel inline: the conversation
 * state, the session persistence and the tests' hooks are shared with the sheet.
 * Returns the undo, which hands the panel back to its scrim — but only while this
 * host still holds it (a newer render of the page may have taken it already).
 */
function mountPlanBuildInline(host) {
  const els = ensurePlanBuild();
  closePlanBuild();
  host.appendChild(els.panel);
  els.inline = host;
  els.panel.classList.add("pb-inline");
  els.panel.setAttribute("role", "region");
  els.panel.removeAttribute("aria-modal");
  els.closeBtn.hidden = true;
  els.titleEl.textContent = "The team talk";
  els.subEl.textContent =
    "You give the brief. The planner asks what it needs, then proposes the draw.";
  startPlanBuild({ focus: false });
  return () => {
    if (!host.contains(els.panel)) return;
    els.scrim.appendChild(els.panel);
    els.inline = null;
    els.panel.classList.remove("pb-inline");
    els.panel.setAttribute("role", "dialog");
    els.panel.setAttribute("aria-modal", "true");
    els.closeBtn.hidden = false;
    els.titleEl.textContent = "Plan a build";
    els.subEl.textContent = "Your brief → the planner's questions → the draw";
  };
}

function startPlanBuild(opts = {}) {
  const { input } = ensurePlanBuild();
  // `mode` is the start toggle: "new" (greenfield app) vs "extend" (add tickets
  // to an existing scope node / epic). `target` holds the chosen extend node and
  // becomes the `context` sent to the decomposer on the first turn. `nodes` is
  // loaded lazily for the extend picker; an empty list just hides the option.
  // `sessionId` is the server-side session id (null when persistence unavailable).
  // `spec` (SPEC-DRIVEN): when opened from a FROZEN spec via buildFromFrozenSpec(),
  // its clauses ride along on every plan-build POST so the decomposer satisfies each
  // clause and stamps spec_clause_id provenance on the ACs — without this the whole
  // spec→plan→coverage traceability chain is dead (the spec never reaches decompose).
  // `repo` (from a spec's target_repo): start in "extend" mode targeting that repo
  // so the first turn's context carries it and decompose takes the brownfield path.
  const seededRepo = typeof opts.repo === "string" && opts.repo.trim() ? opts.repo.trim() : null;
  planBuildState = {
    history: [],
    plan: null,
    busy: false,
    brief: opts.brief || null,
    mode: seededRepo ? "extend" : "new",
    target: seededRepo ? { kind: "repo", id: seededRepo, name: seededRepo } : null,
    nodes: [],
    repos: [],
    sessionId: null,
    spec: Array.isArray(opts.spec) && opts.spec.length ? opts.spec : null,
  };
  renderPlanBuildLog();
  // Seeded from a spec: pre-fill the brief so the user can immediately "Build the tickets".
  if (planBuildState.brief && input) input.value = planBuildState.brief;
  if (opts.focus !== false) setTimeout(() => input.focus(), 50);
  // Best-effort: restore the in-progress session from the server, and populate
  // the "Extend existing" picker. Both are non-blocking; the panel works without them.
  guard(async () => {
    const [sessionRes, nodesRes, reposRes] = await Promise.all([
      api("GET", "/plan-sessions/active").catch(() => null),
      api("GET", "/scope/nodes"),
      api("GET", "/repositories"),
    ]);
    if (!planBuildState) return; // panel was closed during the fetch
    // A spec-driven open is ALWAYS a fresh session — never restore an unrelated
    // in-progress plan over the frozen-spec intent.
    if (planBuildState.spec) {
      await createPlanBuildSession();
    } else if (sessionRes && sessionRes.session && planBuildState.history.length === 0) {
      // Restore server session (if one exists and the panel hasn't been interacted with).
      restorePlanBuildSession(sessionRes.session);
    } else if (!sessionRes || !sessionRes.session) {
      // No active session on the server — create one (best-effort).
      await createPlanBuildSession();
    }
    planBuildState.nodes = nodesRes.nodes || [];
    planBuildState.repos = reposRes.repositories || [];
    // Only repaint while still on the empty intro (no turns sent yet) OR if we
    // just restored a session with history.
    renderPlanBuildLog();
  });
}

/**
 * Archive the current session as 'abandoned' and open a fresh one.
 * The "New plan" button in the panel header calls this.
 */
async function startNewPlanBuild() {
  if (!planBuildState || planBuildState.busy) return;
  await archivePlanBuildSession("abandoned");
  // Reset in-memory state.
  planBuildState = {
    history: [],
    plan: null,
    busy: false,
    brief: null,
    mode: "new",
    target: null,
    nodes: planBuildState ? planBuildState.nodes : [],
    repos: planBuildState ? planBuildState.repos : [],
    sessionId: null,
    spec: null, // "New plan" starts clean — any frozen-spec attachment is dropped
  };
  renderPlanBuildLog();
  // Create a fresh server-side session.
  await createPlanBuildSession();
  if (planBuildEls) planBuildEls.input.focus();
}
function closePlanBuild() {
  if (!planBuildEls) return;
  planBuildEls.scrim.classList.remove("open");
  document.removeEventListener("keydown", planBuildKeydown);
}
function planBuildKeydown(e) {
  if (e.key === "Escape") closePlanBuild();
}

/** Repaint the conversation log from state (turns + the live proposal). */
function renderPlanBuildLog() {
  const { log } = planBuildEls;
  clear(log);

  if (planBuildState.history.length === 0) {
    log.appendChild(
      el("div", { class: "pb-intro" }, [
        renderPlanBuildModeToggle(),
        planBuildState.spec
          ? el(
              "p",
              { class: "pb-spec-note" },
              `Built to a frozen spec: its ${plural(planBuildState.spec.length, "clause")} ride along, so every criterion names the clause it proves.`,
            )
          : null,
        planBuildState.spec
          ? el(
              "p",
              { class: "pb-ask" },
              "The spec's brief is in the box below. Edit it if you like, then send it to the planner.",
            )
          : planBuildState.mode === "extend"
            ? el(
                "p",
                { class: "pb-ask" },
                planBuildState.target
                  ? `Say what to add to “${planBuildState.target.name}” in a line or two. For example:`
                  : "Pick what to extend, then say what to add in a line or two. For example:",
              )
            : el("p", { class: "pb-ask" }, "Say what to build in a line or two. For example:"),
        // From a frozen spec the brief is already written: no stock examples then.
        planBuildState.spec
          ? null
          : el(
              "ul",
              { class: "pb-examples" },
              (planBuildState.mode === "extend"
                ? ["add CSV export to the reports", "add a settings page with dark mode"]
                : ["a web app that tracks gym workouts", "an API that summarises PDFs"]
              ).map((ex) =>
                el(
                  "li",
                  {},
                  el(
                    "button",
                    {
                      class: "pb-example",
                      type: "button",
                      onclick: () => {
                        planBuildEls.input.value = ex;
                        planBuildEls.input.focus();
                      },
                    },
                    ex,
                  ),
                ),
              ),
            ),
      ]),
    );
  }

  let userTurn = 0;
  for (const turn of planBuildState.history) {
    if (turn.role === "user") {
      log.appendChild(
        el("div", { class: "pb-msg pb-user" }, [
          el("div", { class: "pb-bot-label" }, userTurn++ === 0 ? "Your brief" : "You"),
          el("div", { class: "pb-msg-t" }, turn.answer || turn.brief || ""),
        ]),
      );
    } else if (turn.role === "assistant" && turn.questions) {
      log.appendChild(
        el("div", { class: "pb-msg pb-bot" }, [
          el(
            "div",
            { class: "pb-bot-label" },
            `The planner asks ${turn.questions.length === 1 ? "one question" : `${turn.questions.length} questions`}`,
          ),
          el(
            "ol",
            { class: "pb-questions" },
            turn.questions.map((q) => el("li", {}, q)),
          ),
          el(
            "p",
            { class: "pb-hint" },
            "Answer below in your own words, or build the tickets now.",
          ),
        ]),
      );
    } else if (turn.role === "assistant" && turn.error) {
      log.appendChild(
        el("div", { class: "pb-msg pb-bot pb-error-msg" }, [
          el("div", { class: "pb-bot-label" }, "Couldn't build the plan"),
          el("div", {}, turn.error),
          el(
            "div",
            { class: "pb-error-hint dim" },
            'Edit your brief and try again, or press "Build the tickets".',
          ),
        ]),
      );
    }
  }

  if (planBuildState.plan) {
    log.appendChild(renderPlanProposal(planBuildState.plan));
  }

  if (planBuildState.notice) {
    log.appendChild(el("p", { class: "pb-notice", role: "alert" }, planBuildState.notice));
  }

  if (planBuildState.busy) {
    log.appendChild(
      el("div", { class: "pb-msg pb-bot pb-thinking", role: "status" }, [
        el("span", { class: "btn-spinner", "aria-hidden": "true" }),
        el("span", {}, "The planner is working on it…"),
      ]),
    );
  }

  updatePlanBuildActions();
  log.scrollTop = log.scrollHeight;
}

/** Turn depth (number of user messages sent) at which "Build the tickets" emphasises. */
const PLAN_BUILD_FORCE_EMPHASIS_TURNS = 3;

/**
 * Keep the composer actions honest about where the conversation is:
 *  - "Build the tickets" (forcePlan) is ALWAYS available so the user is never
 *    stuck clarifying — it forces the decomposer to emit a plan from what it has.
 *  - It gets EMPHASISED once several turns deep (the point where endless clarify
 *    stops earning its keep).
 *  - Once a plan is on screen the conversation's job is done — review/create takes
 *    over — so both the composer and the force button are hidden.
 * The "Send"/Continue button stays secondary: it keeps refining.
 */
function updatePlanBuildActions() {
  if (!planBuildEls) return;
  const { forceBtn, form } = planBuildEls;
  const turns = planBuildState.history.filter((t) => t.role === "user").length;
  const hasPlan = !!planBuildState.plan;
  // Hide the whole composer once a plan is proposed — the create path owns it now.
  form.hidden = hasPlan;
  if (hasPlan) return;
  planBuildEls.input.placeholder = turns
    ? "Answer the planner, or add anything it should know…"
    : "Describe what to build…";
  // A bare first turn has no brief yet — force-plan with nothing to go on is a no-op.
  forceBtn.disabled = planBuildState.busy || turns === 0;
  forceBtn.classList.toggle("pb-force-strong", turns >= PLAN_BUILD_FORCE_EMPHASIS_TURNS);
}

// ── Shared target selector ──────────────────────────────────────────────────
// One control for "pick a repo OR a scope node, and assign it as a target".
// A target is { kind: "repo" | "node", id, name }. A node resolves to its linked
// repo NAME(s) via resolveTargetRepos() so every consumer (plan-build extend,
// idle-loop scoping) ends up repo-name-based — the loop/decompose backends never
// learn about nodes. Two variants: single-select (a <select> with Repos/Scopes
// optgroups, plus a repo disambiguator when a multi-repo node is chosen) and
// multi-select (grouped checkboxes). Self-contained + styled to match the
// existing form controls.

/** Cache of node id → repo NAMES, so a node only fetches its repos once per session. */
const nodeReposCache = new Map();

/**
 * Resolve a node's linked repo NAMES. Uses the already-loaded `scopeRepos` map
 * (node id → repo objects) when present, else fetches `GET /scope/repos?node=<id>`
 * once and caches it. A repo target resolves to its own single name. Best-effort:
 * returns [] on any error so a save never hard-fails on a transient fetch.
 */
async function resolveTargetRepos(target, scopeRepos) {
  if (!target) return [];
  if (target.kind === "repo") return target.name ? [target.name] : [];
  const id = target.id;
  if (scopeRepos && Array.isArray(scopeRepos[id])) {
    return scopeRepos[id].map((r) => r.name).filter(Boolean);
  }
  if (nodeReposCache.has(id)) return nodeReposCache.get(id);
  try {
    const { repos } = await api("GET", `/scope/repos?node=${encodeURIComponent(id)}`);
    const names = (Array.isArray(repos) ? repos : []).map((r) => r.name).filter(Boolean);
    nodeReposCache.set(id, names);
    return names;
  } catch {
    return [];
  }
}

/**
 * Single-select target picker. Renders a labelled <select> grouping repos
 * ("Repos") and scope nodes ("Scopes"). On choosing a repo the value becomes
 * { kind:"repo", id, name }; on a node it becomes { kind:"node", id, name } and,
 * when the node links more than one repo, a second <select> appears so the user
 * disambiguates which repo to target (a node with exactly one repo auto-resolves).
 * Calls `onChange(target)` with the current selection (or null when cleared).
 */
function targetPickerSingle({ repos, nodes, value, allowRepo = true, allowNode = true, onChange }) {
  const wrap = el("div", { class: "target-picker" });
  const repoList = allowRepo ? repos || [] : [];
  const nodeList = allowNode ? nodes || [] : [];

  // Slot for the per-node repo disambiguator (filled when a multi-repo node is chosen).
  const repoSlot = el("div", { class: "target-picker-reposlot" });

  const optionValue = (kind, id) => `${kind}:${id}`;
  const selected =
    value && value.kind
      ? optionValue(value.kind, value.kind === "repo" ? value.name : value.id)
      : "";

  const sel = el(
    "select",
    { class: "target-picker-select", "aria-label": "Target repo or scope" },
    [
      el("option", { value: "" }, "Select a target…"),
      repoList.length
        ? el(
            "optgroup",
            { label: "Repos" },
            repoList.map((r) =>
              el(
                "option",
                {
                  value: optionValue("repo", r.name),
                  selected: selected === optionValue("repo", r.name) ? "" : undefined,
                },
                r.name,
              ),
            ),
          )
        : null,
      nodeList.length
        ? el(
            "optgroup",
            { label: "Scopes" },
            nodeList.map((n) =>
              el(
                "option",
                {
                  value: optionValue("node", n.id),
                  selected: selected === optionValue("node", n.id) ? "" : undefined,
                },
                `${n.name} (${typeLabel(n.type)})`,
              ),
            ),
          )
        : null,
    ],
  );

  // Build the per-node repo disambiguator into the slot from a list of repo names.
  // Idempotent: clears the slot first, so it survives consumer re-renders that
  // remount the whole picker with the same node `value`.
  function renderRepoSlot(target, names) {
    clear(repoSlot);
    if (names.length <= 1) {
      // 0 → greenfield-style (no repo); 1 → use it directly. No disambiguation.
      target.repo = names[0] || null;
      return;
    }
    const repoSel = el(
      "select",
      { class: "target-picker-select", "aria-label": "Which repo in this scope" },
      [
        el("option", { value: "" }, "Pick a repo in this scope…"),
        ...names.map((name) =>
          el("option", { value: name, selected: target.repo === name ? "" : undefined }, name),
        ),
      ],
    );
    repoSel.addEventListener("change", () => {
      target.repo = repoSel.value || null;
      onChange(target);
    });
    repoSlot.appendChild(el("label", { class: "target-picker-sublabel" }, "Repo in scope"));
    repoSlot.appendChild(repoSel);
  }

  // For a node target: render the disambiguator. Uses the repo-name cache when
  // present (so a remount paints synchronously); otherwise fetches, then repaints
  // just the slot — without notifying the consumer (no re-render churn).
  function hydrateRepoSlot(target) {
    clear(repoSlot);
    if (!target || target.kind !== "node") return;
    if (nodeReposCache.has(target.id)) {
      renderRepoSlot(target, nodeReposCache.get(target.id));
      return;
    }
    // The slot belongs to this picker instance; paint into it when the resolve
    // lands. A remount supersedes us with its own slot, so this is always safe.
    resolveTargetRepos(target).then((names) => renderRepoSlot(target, names));
  }

  sel.addEventListener("change", () => {
    clear(repoSlot);
    const raw = sel.value;
    if (!raw) {
      onChange(null);
      return;
    }
    const sep = raw.indexOf(":");
    const kind = raw.slice(0, sep);
    const key = raw.slice(sep + 1);
    if (kind === "repo") {
      onChange({ kind: "repo", id: key, name: key, repo: key });
      return;
    }
    const node = nodeList.find((n) => n.id === key);
    const target = node
      ? { kind: "node", id: node.id, name: node.name, type: node.type, repo: null }
      : null;
    if (!target) {
      onChange(null);
      return;
    }
    // Notify first (the consumer may re-render and remount this picker — the new
    // mount's hydrateRepoSlot then paints the disambiguator), then paint here too
    // for consumers that don't re-render. A detached paint is harmless.
    onChange(target);
    hydrateRepoSlot(target);
  });

  wrap.appendChild(sel);
  wrap.appendChild(repoSlot);
  // Restore the disambiguator when remounted with a node already selected (the
  // consumer re-renders the picker on every change, so this keeps it in sync).
  if (value && value.kind === "node") hydrateRepoSlot(value);
  return wrap;
}

/**
 * Multi-select target picker. Renders grouped checkboxes (Repos / Scopes) and
 * keeps a live Set of selected targets. `getTargets()` returns the current
 * selection as `{ kind, id, name }[]`; consumers resolve nodes to repo NAMES via
 * resolveTargetRepos() on save. An empty selection means "all" — the caller owns
 * that copy. Used for the idle loops (repos + nodes, node expands to repo names).
 */
function targetPickerMulti({ repos, nodes, value, onChange }) {
  const wrap = el("div", { class: "target-picker target-picker-multi" });
  const repoList = repos || [];
  const nodeList = nodes || [];

  // Selection keyed by "kind:id" so repos and nodes can't collide.
  const selected = new Map();
  for (const t of value || []) selected.set(`${t.kind}:${t.id}`, t);

  const emit = () => onChange(getTargets());
  function getTargets() {
    return [...selected.values()];
  }

  function checkboxRow(target, label) {
    const key = `${target.kind}:${target.id}`;
    const input = el("input", { type: "checkbox", "aria-label": label });
    input.checked = selected.has(key);
    input.addEventListener("change", () => {
      if (input.checked) selected.set(key, target);
      else selected.delete(key);
      emit();
    });
    return el("label", { class: "target-picker-check" }, [input, el("span", {}, label)]);
  }

  if (repoList.length) {
    wrap.appendChild(el("div", { class: "target-picker-grouplabel" }, "Repos"));
    const group = el("div", { class: "target-picker-group" });
    for (const r of repoList) {
      group.appendChild(checkboxRow({ kind: "repo", id: r.name, name: r.name }, r.name));
    }
    wrap.appendChild(group);
  }
  if (nodeList.length) {
    wrap.appendChild(el("div", { class: "target-picker-grouplabel" }, "Scopes"));
    const group = el("div", { class: "target-picker-group" });
    for (const n of nodeList) {
      group.appendChild(
        checkboxRow(
          { kind: "node", id: n.id, name: n.name, type: n.type },
          `${n.name} (${typeLabel(n.type)})`,
        ),
      );
    }
    wrap.appendChild(group);
  }
  if (!repoList.length && !nodeList.length) {
    wrap.appendChild(el("div", { class: "target-picker-empty dim" }, "No repos or scopes yet."));
  }

  // Expose the live reader so the caller can collect on save.
  wrap.getTargets = getTargets;
  return wrap;
}

/**
 * Shared entry point. `multiple` chooses the variant; both share the repos/nodes
 * inputs and the { kind, id, name } target shape. Kept as one function so the two
 * consumers (plan-build extend, idle loops) reach for the same abstraction.
 */
function targetPicker(opts) {
  return opts.multiple ? targetPickerMulti(opts) : targetPickerSingle(opts);
}

/**
 * Start toggle: "New app" vs "Extend existing". In extend mode a repo/scope
 * picker appears; the chosen target becomes the `context` the decomposer uses
 * to propose EXTENDING tickets rather than rebuilding. The toggle only shows on
 * the empty intro (before any turn) — once the conversation starts the target is
 * locked so history stays coherent.
 */
function renderPlanBuildModeToggle() {
  const nodes = planBuildState.nodes || [];
  const newRadio = el("input", {
    type: "radio",
    name: "pb-mode",
    value: "new",
    checked: planBuildState.mode === "new" ? "" : undefined,
  });
  const extendRadio = el("input", {
    type: "radio",
    name: "pb-mode",
    value: "extend",
    checked: planBuildState.mode === "extend" ? "" : undefined,
  });
  newRadio.addEventListener("change", () => {
    if (newRadio.checked) {
      planBuildState.mode = "new";
      planBuildState.target = null;
      renderPlanBuildLog();
      planBuildEls.input.focus();
    }
  });
  extendRadio.addEventListener("change", () => {
    if (extendRadio.checked) {
      planBuildState.mode = "extend";
      renderPlanBuildLog();
      planBuildEls.input.focus();
    }
  });

  const children = [
    el("div", { class: "mode-toggle" }, [
      el("label", { class: "mode-option" }, [
        newRadio,
        el("span", {}, [
          el("strong", {}, "New app"),
          el("span", { class: "mode-sub" }, "a new repo, from scratch"),
        ]),
      ]),
      el("label", { class: "mode-option" }, [
        extendRadio,
        el("span", {}, [
          el("strong", {}, "Extend existing"),
          el("span", { class: "mode-sub" }, "add to a repo or scope we have"),
        ]),
      ]),
    ]),
  ];

  if (planBuildState.mode === "extend") {
    const repos = planBuildState.repos || [];
    // Shared selector: offers BOTH repos and scope nodes. Choosing a repo sets the
    // target directly (the first-turn context carries that `repo`, no guessing);
    // choosing a multi-repo node expands to a repo disambiguator; a single-repo
    // node resolves to its one repo. The picker keeps target.repo current.
    const picker = targetPicker({
      repos,
      nodes,
      value: planBuildState.target,
      multiple: false,
      onChange: (target) => {
        planBuildState.target = target;
        planBuildState.notice = null;
        renderPlanBuildLog();
        planBuildEls.input.focus();
      },
    });
    children.push(field("Extend", picker, { class: "pb-extend-field" }));
  }

  return el("div", { class: "pb-mode" }, children);
}

/**
 * The proposal as the draw: the epic's name and brief, then its tickets round by
 * round (a ticket's round is its dependency depth in the plan), then the Final
 * the factory adds on confirm, then the two ways to confirm.
 */
function renderPlanProposal(plan) {
  const epic = plan.epic || {};
  const tickets = plan.tickets || [];
  const depthMemo = new Map();
  const depth = (i, seen = new Set()) => {
    if (depthMemo.has(i)) return depthMemo.get(i);
    if (seen.has(i)) return 0;
    seen.add(i);
    const deps = (Array.isArray(tickets[i]?.dependsOn) ? tickets[i].dependsOn : []).filter(
      (d) => Number.isInteger(d) && d >= 0 && d < tickets.length && d !== i,
    );
    const v = deps.length ? 1 + Math.max(...deps.map((d) => depth(d, seen))) : 0;
    depthMemo.set(i, v);
    return v;
  };
  const rounds = [];
  tickets.forEach((t, i) => {
    const d = depth(i);
    (rounds[d] = rounds[d] || []).push(i);
  });
  const filled = rounds.filter(Boolean);
  const known = new Set(((planBuildState && planBuildState.repos) || []).map((r) => r.name));
  const withFinal = epic.acceptance !== false;

  const ticketRow = (i) => {
    const t = tickets[i];
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    const acs = Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : [];
    const acText = (ac) => (typeof ac === "string" ? ac : (ac && ac.text) || "");
    return el("li", { class: "pb-ticket" }, [
      el("div", { class: "pb-ticket-top" }, [
        // A proposal index, never a ticket number: the server numbers the tickets
        // only when you confirm, so "#1" here would name a ticket that exists.
        el(
          "span",
          { class: "pb-ticket-idx tabnum", title: `Proposed ticket ${i + 1}: not created yet` },
          `T${i + 1}`,
        ),
        el("span", { class: "pb-ticket-title" }, t.title),
      ]),
      el("div", { class: "pb-ticket-meta" }, [
        t.repo
          ? known.has(t.repo)
            ? repoTag(t.repo, 16)
            : el("span", { class: "pb-repo-new" }, [kitShirt(t.repo, 16), `new repo: ${t.repo}`])
          : el("span", {}, "no repo named"),
        t.bootstrap ? badge("bootstrap") : null,
        typeof t.priority === "number"
          ? el("span", { class: "tabnum" }, `priority ${t.priority}`)
          : null,
        deps.length
          ? el(
              "span",
              { class: "pb-ticket-deps" },
              `after ${deps.map((d) => `T${d + 1}`).join(", ")}`,
            )
          : null,
      ]),
      t.description ? el("p", { class: "pb-ticket-desc" }, t.description) : null,
      acs.length
        ? el("details", { class: "pb-acs-fold" }, [
            el("summary", {}, plural(acs.length, "acceptance criterion", "acceptance criteria")),
            el(
              "ul",
              { class: "pb-acs" },
              acs.map((ac) => el("li", {}, acText(ac))),
            ),
          ])
        : el(
            "p",
            { class: "pb-ticket-noac" },
            "No acceptance criterion: it stays draft until one is added.",
          ),
    ]);
  };

  const wrap = el(
    "section",
    { class: "pb-proposal", "aria-label": `Proposed campaign: ${epic.name || "epic"}` },
    [
      el("header", { class: "pb-proposal-head" }, [
        el("h3", { class: "pb-proposal-name" }, epic.name || "Proposed epic"),
        el(
          "p",
          { class: "pb-proposal-aux" },
          `The draw, proposed · ${plural(tickets.length, "ticket")} in ${plural(filled.length, "round")}${withFinal ? " + the Final" : ""}`,
        ),
      ]),
      epic.description ? el("p", { class: "pb-proposal-desc" }, epic.description) : null,
      el("ol", { class: "pb-rounds" }, [
        ...filled.map((idxs, ri) =>
          el("li", { class: "pb-round" }, [
            el("h4", { class: "pb-round-name" }, `Round ${ri + 1}`),
            el("ol", { class: "pb-tickets" }, idxs.map(ticketRow)),
          ]),
        ),
        withFinal
          ? el("li", { class: "pb-round is-final" }, [
              el("h4", { class: "pb-round-name" }, "Final"),
              el("div", { class: "pb-final" }, [
                el("span", { class: "pb-ticket-title" }, `Acceptance: ${epic.name || "the build"}`),
                el(
                  "p",
                  { class: "pb-ticket-desc" },
                  "Added by the factory when you confirm. Your brief is its contract; it runs last, against the whole build, and the independent tester decides it.",
                ),
              ]),
            ])
          : null,
      ]),
    ],
  );

  wrap.appendChild(
    el("div", { class: "pb-confirm-row" }, [
      el(
        "p",
        { class: "pb-confirm-note" },
        `Create as draft to look them over first, or create and ready them for the squad now. Readying asks each ticket's gate: one with no acceptance criterion stays draft.`,
      ),
      el("div", { class: "pb-confirm-actions" }, [
        el(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => confirmPlanBuild(plan),
          },
          el("span", {}, "Create as draft"),
        ),
        el(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: () => confirmPlanBuild(plan, { ready: true }),
          },
          [icon("check"), el("span", {}, "Create & ready")],
        ),
      ]),
    ]),
  );
  return wrap;
}

/**
 * Send the next turn: append the user message, POST /plan-build, fold the reply.
 *
 * `forcePlan` is the "Build the tickets now" escape — it fires WITHOUT requiring
 * new input (it builds from the brief + answers so far) and asks the decomposer to
 * stop clarifying and return a plan. The normal (Continue/Send) path keeps refining.
 */
async function submitPlanBuildTurn(opts = {}) {
  const forcePlan = opts.forcePlan === true;
  const { input, sendBtn } = planBuildEls;
  const text = input.value.trim();
  // Continue/Send needs text; "Build the tickets" does not — it forces a plan from
  // whatever has been said so far. Either way, never fire while a turn is in flight.
  if (planBuildState.busy) return;
  if (!forcePlan && !text) return;

  const isFirst = planBuildState.history.length === 0;
  // Extend mode requires a target before the first turn, otherwise "extend" has
  // nothing to extend. Later turns inherit the locked target, so only gate the first.
  // Both refusals are said inline, next to the composer, not in a toast.
  if (isFirst && planBuildState.mode === "extend" && !planBuildState.target) {
    planBuildState.notice = "Pick the repo or scope to extend first.";
    renderPlanBuildLog();
    return;
  }
  // Force-plan with nothing said yet has nothing to plan from — ask for the brief.
  if (forcePlan && isFirst && !text) {
    planBuildState.notice = "Write the brief first: the tickets are built from it.";
    renderPlanBuildLog();
    input.focus();
    return;
  }
  planBuildState.notice = null;

  // Record the user's message. On a force-plan turn the input may be empty (the
  // user just pressed "Build the tickets"), so only push a message when there is text.
  if (text) {
    if (isFirst) planBuildState.brief = text;
    planBuildState.history.push(
      isFirst ? { role: "user", brief: text } : { role: "user", answer: text },
    );
    // Persist the user turn server-side (best-effort; never awaited before the render).
    persistPlanBuildTurn("user", text, isFirst ? { brief: text } : {}).catch(() => {});
    input.value = "";
    input.style.height = "auto";
  }

  // Build the extend-existing context once (locked for the whole conversation).
  // The target is either a direct repo ({kind:"repo"}) — its name flows straight
  // through as `repo` — or a scope node ({kind:"node"}) — its id/name/type plus
  // the resolved/disambiguated repo NAME (when one was chosen).
  const target = planBuildState.target;
  const context =
    planBuildState.mode === "extend" && target
      ? target.kind === "repo"
        ? { mode: "extend", repo: target.name }
        : {
            mode: "extend",
            scopeNodeId: target.id,
            scopeNodeName: target.name,
            scopeNodeType: target.type,
            // Brownfield: forward the resolved/disambiguated target repo NAME so
            // decompose takes the existing-repo path. Only included when resolved.
            ...(target.repo ? { repo: target.repo } : {}),
          }
      : undefined;

  planBuildState.busy = true;
  // Immediate running state: disable + relabel the send button to "Planning…"
  // (the inline "thinking" dots render from `busy` in renderPlanBuildLog), so the
  // turn visibly "took" rather than firing silently.
  sendBtn.disabled = true;
  sendBtn.classList.add("is-running");
  sendBtn.setAttribute("aria-busy", "true");
  clear(sendBtn);
  sendBtn.appendChild(el("span", { class: "btn-spinner", "aria-hidden": "true" }));
  sendBtn.appendChild(el("span", { class: "pb-send-label" }, "Planning…"));
  renderPlanBuildLog();

  // Send the brief + the answered turns; the helper treats answered Qs as settled.
  // On a force-plan turn the decomposer is told to stop clarifying and return a
  // plan now from what it has — so the user is never trapped in an endless chat.
  // NOTE: we handle errors explicitly (not via guard) so a failed turn leaves a
  // PERSISTENT error message in the chat + clears the thinking bubble, rather than
  // hanging on the typing dots with only a transient toast.
  let failure = null;
  try {
    const res = await api("POST", "/plan-build", {
      brief: planBuildState.brief,
      history: planBuildState.history
        .filter((t) => !(t.role === "assistant" && t.error)) // never resend a failed turn
        .map((t) => (t.role === "user" && t.brief ? { role: "user", answer: t.brief } : t)),
      ...(context !== undefined ? { context } : {}),
      ...(forcePlan ? { forcePlan: true } : {}),
      // SPEC-DRIVEN: thread the frozen spec's clauses so the decomposer satisfies each
      // and stamps spec_clause_id provenance on the ACs (drives the coverage read model).
      ...(Array.isArray(planBuildState.spec) && planBuildState.spec.length
        ? { spec: planBuildState.spec }
        : {}),
    });
    if (res.phase === "clarify") {
      planBuildState.history.push({ role: "assistant", questions: res.questions || [] });
      persistPlanBuildTurn("assistant", JSON.stringify(res)).catch(() => {});
    } else if (res.phase === "plan") {
      planBuildState.plan = res.plan || null;
      persistPlanBuildTurn("assistant", JSON.stringify(res), { plan: res.plan || null }).catch(
        () => {},
      );
    } else {
      failure = res.error || "The planner returned no result.";
      persistPlanBuildTurn("assistant", JSON.stringify(res)).catch(() => {});
    }
  } catch (e) {
    failure = e && e.message ? e.message : "The request errored before a plan came back.";
  }

  // Always land the UI in a resolved state — bubble cleared, composer usable.
  planBuildState.busy = false;
  if (failure) {
    planBuildState.history.push({ role: "assistant", error: failure });
    toast(failure, { code: "PLAN_BUILD" });
  }
  sendBtn.disabled = false;
  sendBtn.classList.remove("is-running");
  sendBtn.removeAttribute("aria-busy");
  clear(sendBtn);
  sendBtn.appendChild(icon("send"));
  renderPlanBuildLog();
}

/**
 * Human confirm → create_epic. Tickets land draft; toast + jump to the epic.
 *
 * Greenfield seam: a bootstrap plan names a repo that does NOT exist yet (the
 * runner greenfield mode registers it when the bootstrap ticket runs).
 * Shipped create_epic requires a named repo to already exist, so before posting
 * we drop `repo`/`access` for any ticket whose repo isn't registered yet. The
 * repo name stayed visible in the proposal for review; the link is established
 * later when the repo is onboarded. Everything else (ACs, deps, bootstrap,
 * priority) is preserved, so the draft epic still lands intact.
 */
// `opts.ready` (the "Create & ready" button) readies the created tickets in the
// same step so the human doesn't have to draft→ready each one by hand. It is
// GATE-AWARE, never a blind status flip: it POSTs /ready per ticket and lets the
// server's intake gate decide — a ticket with no acceptance criterion is refused
// and simply stays draft, so "Create & ready" can never push slop past the AC gate.
async function confirmPlanBuild(plan, opts = {}) {
  await guard(async () => {
    const known = new Set(
      ((await api("GET", "/repositories")).repositories || []).map((r) => r.name),
    );
    let deferred = 0;
    const tickets = (plan.tickets || []).map((t) => {
      if (t.repo && !known.has(t.repo)) {
        deferred++;
        const { repo, access, ...rest } = t;
        // Carry the intended repo NAME onto `source` so the runner bootstraps a
        // cleanly-named repo instead of falling back to a slug of the ticket title.
        // Only when the plan didn't already set `source`; the link itself stays
        // deferred until the repo is onboarded.
        return rest.source ? rest : { ...rest, source: repo };
      }
      return t;
    });
    // ACCEPTANCE GATE: the brief this plan came from rides on the epic so the
    // factory-created acceptance ticket carries it as its contract. The session's
    // recorded brief wins; else the first user turn of this chat.
    const firstTurn = ((planBuildState && planBuildState.history) || []).find(
      (h) => h && h.role === "user" && typeof h.brief === "string" && h.brief.trim(),
    );
    const brief =
      (planBuildState && planBuildState.brief) || (firstTurn ? firstTurn.brief : null) || null;
    const epic = brief ? { ...plan.epic, brief: String(brief).slice(0, 20000) } : plan.epic;
    const res = await api("POST", "/epics", { epic, tickets });
    // Archive the session as confirmed now that the epic has been created.
    await archivePlanBuildSession("confirmed");
    const numbers = res.ticket_numbers || [];
    const count = numbers.length;
    const note = deferred
      ? ` (${deferred} repo link${deferred === 1 ? "" : "s"} deferred to bootstrap)`
      : "";

    let readied = 0;
    let heldDraft = 0;
    if (opts.ready && count) {
      // Resolve the just-created tickets by number, then let the server's ready
      // gate decide per ticket. A refusal (missing AC, unmet precondition) is
      // expected for some tickets — they stay draft, counted, never surfaced as an
      // error. Bootstrap-gated tickets are readied too; the loop honours deps.
      const all = (await api("GET", "/tickets")).tickets || [];
      const mine = all.filter((t) => numbers.includes(t.number));
      for (const t of mine) {
        try {
          await api("POST", `/tickets/${t.id}/ready`, {});
          readied++;
        } catch {
          heldDraft++;
        }
      }
    }

    const msg = opts.ready
      ? `Created ${count} ticket${count === 1 ? "" : "s"} — ${readied} readied` +
        (heldDraft ? `, ${heldDraft} held as draft (add an acceptance criterion)` : "") +
        note
      : `Created ${count} draft ticket${count === 1 ? "" : "s"} — ready them when set${note}`;
    toast(msg, { ok: true });
    closePlanBuild();
    navigate(`#/epics/${res.epic_node_id}`);
    // If already on the epics view, navigate() with the same view won't re-fire
    // the hashchange when the param differs only — force a refresh to be safe.
    router();
  });
}

// ---------------------------------------------------------------------------
//  Author a spec — the spec-author chat step (Spec-Driven Development, Phase 1c)
// ---------------------------------------------------------------------------
//
// A sibling to "Plan a build": a one-line brief becomes an AI-drafted, EDITABLE
// spec (clauses), which the human refines, then CREATES (POST /specs) and FREEZES
// (POST /specs/:id/freeze). It PROPOSES ONLY — nothing is created until the human
// presses "Create spec", and nothing is immutable until "Freeze". This flow is
// entirely additive: the one-liner plan-build path above is untouched. It reuses
// the pb-* panel styling (the spec panel is a second pb-panel instance) plus a few
// spec-specific classes (sb-*) for the editable clause list.
//
// The chat half mirrors submitPlanBuildTurn: clarify turns show questions and let
// the user continue; a "spec" turn hands its clauses to the editable draft. The
// "Draft the spec now" (forcePlan) escape is always available so the user is never
// stuck clarifying — exactly like plan-build's "Build the tickets".
//
// The three clause kinds match the dispatch/spec-author contract exactly.
const SPEC_CLAUSE_KINDS = ["requirement", "non-goal", "decision"];

let specBuildEls = null;
let specBuildState = null;

function ensureSpecBuild() {
  if (specBuildEls) return specBuildEls;
  const scrim = el("div", { class: "pb-scrim", onclick: closeSpecBuild });
  const log = el("div", { class: "pb-log", role: "log", "aria-live": "polite" });
  const input = el("textarea", {
    class: "pb-input",
    rows: "1",
    placeholder: "Describe what the product must do, in one line…",
    "aria-label": "Your message",
  });
  const sendBtn = el(
    "button",
    { class: "btn pb-send", type: "submit", "aria-label": "Send" },
    icon("send"),
  );
  // "Draft the spec now" escape: forces the author to emit a spec from the brief +
  // answers so far. Always visible so the user is NEVER stuck clarifying.
  const forceBtn = el(
    "button",
    {
      class: "btn primary pb-force",
      type: "button",
      "aria-label": "Draft the spec now from what you've told me",
      onclick: () => submitSpecBuildTurn({ forcePlan: true }),
    },
    [icon("check"), el("span", {}, "Draft the spec")],
  );
  const actions = el("div", { class: "pb-actions" }, [forceBtn, sendBtn]);
  const form = el("form", { class: "pb-composer" }, [input, actions]);
  const panel = el(
    "aside",
    { class: "pb-panel", role: "dialog", "aria-modal": "true", "aria-label": "Author a spec" },
    [
      el("header", { class: "pb-head" }, [
        el("div", { class: "pb-head-main" }, [
          el("div", { class: "pb-title" }, "Author a spec"),
          el(
            "div",
            { class: "pb-sub" },
            "Your brief → clauses you edit → frozen into the playbook",
          ),
        ]),
        el("div", { class: "pb-head-actions" }, [
          el(
            "button",
            {
              class: "btn pb-new-plan",
              type: "button",
              "aria-label": "Start a new spec (clears this conversation)",
              onclick: startNewSpecBuild,
            },
            "New spec",
          ),
          el(
            "button",
            {
              class: "icon-btn pb-close",
              type: "button",
              "aria-label": "Close",
              onclick: closeSpecBuild,
            },
            icon("close", "", 20),
          ),
        ]),
      ]),
      el("p", { class: "pb-guardrail" }, [
        el("b", {}, "Proposes only. "),
        "Nothing is created until you press Create spec, and nothing is locked until you freeze it.",
      ]),
      log,
      form,
    ],
  );
  panel.addEventListener("click", (e) => e.stopPropagation());

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitSpecBuildTurn();
  });
  scrim.appendChild(panel);
  document.body.appendChild(scrim);

  specBuildEls = { scrim, panel, log, input, sendBtn, forceBtn, form };
  return specBuildEls;
}

function openSpecBuild() {
  const { scrim, input } = ensureSpecBuild();
  // `history` accumulates clarify turns; `draft` is the editable clause set once
  // the author returns a spec; `createdSpec` is the persisted spec (with id) after
  // Create; once `createdSpec` exists the flow shows the Freeze action.
  // `targetRepo` is the repo the spec is FOR: it rides on POST /specs as
  // `target_repo`, so the lore the freeze seeds is tagged with that repo and the
  // delivery primer's per-repo `memory search --repo <name>` can surface it —
  // untagged clauses never reached a delivery agent. `repos` feeds its picker.
  specBuildState = {
    history: [],
    draft: null,
    createdSpec: null,
    busy: false,
    brief: null,
    title: "",
    targetRepo: "",
    repos: [],
  };
  renderSpecBuildLog();
  scrim.classList.add("open");
  document.addEventListener("keydown", specBuildKeydown);
  setTimeout(() => input.focus(), 50);
  loadSpecBuildRepos();
}

/** Best-effort: populate the target-repo picker. The panel works without it. */
function loadSpecBuildRepos() {
  guard(async () => {
    const res = await api("GET", "/repositories").catch(() => null);
    if (!specBuildState || !res) return; // panel closed / repos unavailable
    specBuildState.repos = res.repositories || [];
    if (specBuildState.draft) renderSpecBuildLog();
  });
}

function startNewSpecBuild() {
  if (!specBuildState || specBuildState.busy) return;
  specBuildState = {
    history: [],
    draft: null,
    createdSpec: null,
    busy: false,
    brief: null,
    title: "",
    targetRepo: "",
    repos: specBuildState.repos || [],
  };
  renderSpecBuildLog();
  if (specBuildEls) specBuildEls.input.focus();
}

function closeSpecBuild() {
  if (!specBuildEls) return;
  specBuildEls.scrim.classList.remove("open");
  document.removeEventListener("keydown", specBuildKeydown);
}
function specBuildKeydown(e) {
  if (e.key === "Escape") closeSpecBuild();
}

/** Repaint the spec conversation log from state (turns + the editable draft). */
function renderSpecBuildLog() {
  const { log } = specBuildEls;
  clear(log);

  if (specBuildState.history.length === 0 && !specBuildState.draft) {
    log.appendChild(
      el("div", { class: "pb-intro" }, [
        el("p", {}, "Describe the product in one line and I'll draft a spec. For example:"),
        el(
          "ul",
          { class: "pb-examples" },
          ["a web app that tracks gym workouts", "an API that summarises PDFs"].map((ex) =>
            el(
              "li",
              {},
              el(
                "button",
                {
                  class: "pb-example",
                  type: "button",
                  onclick: () => {
                    specBuildEls.input.value = ex;
                    specBuildEls.input.focus();
                  },
                },
                ex,
              ),
            ),
          ),
        ),
      ]),
    );
  }

  for (const turn of specBuildState.history) {
    if (turn.role === "user") {
      log.appendChild(el("div", { class: "pb-msg pb-user" }, turn.answer || turn.brief || ""));
    } else if (turn.role === "assistant" && turn.questions) {
      log.appendChild(
        el("div", { class: "pb-msg pb-bot" }, [
          el("div", { class: "pb-bot-label dim" }, "Clarifying questions"),
          el(
            "ul",
            { class: "pb-questions" },
            turn.questions.map((q) => el("li", {}, q)),
          ),
        ]),
      );
    } else if (turn.role === "assistant" && turn.error) {
      log.appendChild(
        el("div", { class: "pb-msg pb-bot pb-error-msg" }, [
          el("div", { class: "pb-bot-label" }, "Couldn't draft the spec"),
          el("div", {}, turn.error),
          el(
            "div",
            { class: "pb-error-hint dim" },
            'Edit your brief and try again, or press "Draft the spec".',
          ),
        ]),
      );
    }
  }

  if (specBuildState.draft) {
    log.appendChild(renderSpecDraft(specBuildState.draft));
  }

  if (specBuildState.busy) {
    log.appendChild(
      el("div", { class: "pb-msg pb-bot pb-thinking" }, [
        el("span", { class: "pb-dot" }),
        el("span", { class: "pb-dot" }),
        el("span", { class: "pb-dot" }),
      ]),
    );
  }

  updateSpecBuildActions();
  log.scrollTop = log.scrollHeight;
}

/**
 * Composer state: the "Draft the spec" force button is always available so the
 * user is never stuck clarifying. Once a draft is on screen the chat's job is done
 * (edit/create takes over), so the whole composer is hidden.
 */
function updateSpecBuildActions() {
  if (!specBuildEls) return;
  const { forceBtn, form } = specBuildEls;
  const turns = specBuildState.history.filter((t) => t.role === "user").length;
  form.hidden = !!specBuildState.draft;
  if (specBuildState.draft) return;
  forceBtn.disabled = specBuildState.busy || turns === 0;
}

/**
 * Render the editable clause draft. Each clause is a kind chip (select) + editable
 * text + editable rationale, with a remove button; a footer allows adding a clause
 * and — once at least one clause exists — Create spec. After Create, the row swaps
 * to a Freeze action. All edits mutate the in-memory draft (the panel's UI state);
 * the persisted spec is only written on Create / Freeze.
 */
function renderSpecDraft(draft) {
  const clauses = draft.clauses || [];
  const created = specBuildState.createdSpec;
  const frozen = created && created.status === "frozen";
  const wrap = el("section", { class: "pb-proposal sb-draft", "aria-label": "Proposed spec" });

  wrap.appendChild(
    el("header", { class: "pb-proposal-head" }, [
      el("h3", { class: "pb-proposal-name" }, "Proposed spec"),
      el(
        "p",
        { class: "pb-proposal-aux" },
        `${frozen ? "Frozen: in the playbook" : created ? "Created as a draft spec" : "A draft: edit any clause"} · ${plural(clauses.length, "clause")}`,
      ),
    ]),
  );

  // Title field — required by create_spec; defaults to the brief. Editable until
  // the spec is created (immutable server-side after that).
  const titleInput = el("input", {
    class: "sb-title",
    type: "text",
    value: specBuildState.title || "",
    placeholder: "Spec title",
    "aria-label": "Spec title",
    maxlength: "300",
    disabled: created ? "" : undefined,
  });
  titleInput.addEventListener("input", () => {
    specBuildState.title = titleInput.value;
    updateSpecCreateEnabled();
  });
  wrap.appendChild(field("Title", titleInput, { class: "sb-title-field" }));

  // Target repo — which repo this spec is FOR. Sent as `target_repo` on Create so
  // the clauses the freeze seeds into Memory carry that repo tag; the delivery
  // primer searches lore per repo, so an untagged clause never reaches an agent.
  // Optional (an org-wide spec may span repos), locked once the spec is created.
  const repos = specBuildState.repos || [];
  const repoSel = el(
    "select",
    {
      class: "select sb-target-repo",
      "aria-label": "Target repo",
      disabled: created ? "" : undefined,
    },
    [
      el("option", { value: "" }, repos.length ? "No target repo (org-wide)" : "No repos known"),
      ...repos.map((r) =>
        el(
          "option",
          { value: r.name, selected: specBuildState.targetRepo === r.name ? "" : undefined },
          r.name,
        ),
      ),
    ],
  );
  if (created && created.target_repo && !repos.some((r) => r.name === created.target_repo)) {
    repoSel.appendChild(
      el("option", { value: created.target_repo, selected: "" }, created.target_repo),
    );
  }
  repoSel.addEventListener("change", () => {
    specBuildState.targetRepo = repoSel.value;
  });
  repoSel.title = "Tags the lore seeded at freeze so this repo's delivery agents see it.";
  wrap.appendChild(field("Target repo", repoSel, { class: "sb-target-repo-field" }));

  const list = el("ol", { class: "pb-tickets sb-clauses" });
  clauses.forEach((clause, i) => list.appendChild(renderSpecClauseRow(clause, i, !!created)));
  wrap.appendChild(list);

  if (!created) {
    wrap.appendChild(
      el("div", { class: "sb-add-row" }, [
        el(
          "button",
          {
            class: "btn sb-add",
            type: "button",
            onclick: () => {
              specBuildState.draft.clauses.push({ kind: "requirement", text: "", rationale: "" });
              renderSpecBuildLog();
            },
          },
          [icon("plus"), el("span", {}, "Add clause")],
        ),
      ]),
    );
  }

  // Persistent error slot (not just a toast) — mirrors pb-error-msg styling.
  if (specBuildState.actionError) {
    wrap.appendChild(
      el("div", { class: "pb-msg pb-bot pb-error-msg sb-action-error" }, [
        el("div", { class: "pb-bot-label" }, "Action failed"),
        el("div", {}, specBuildState.actionError),
      ]),
    );
  }

  const confirmRow = el("div", { class: "pb-confirm-row" });
  if (!created) {
    const createBtn = el(
      "button",
      {
        class: "btn primary sb-create",
        type: "button",
        onclick: () => createSpecFromDraft(),
      },
      [icon("check"), el("span", {}, "Create spec")],
    );
    confirmRow.appendChild(
      el(
        "p",
        { class: "pb-confirm-note dim" },
        `${clauses.length} clause${clauses.length === 1 ? "" : "s"}, created as a draft spec you can freeze when ready.`,
      ),
    );
    confirmRow.appendChild(createBtn);
  } else if (!frozen) {
    confirmRow.appendChild(
      el(
        "p",
        { class: "pb-confirm-note dim" },
        "Spec created as draft. Freeze to lock the clauses and seed product-intent lore.",
      ),
    );
    confirmRow.appendChild(
      el(
        "button",
        { class: "btn primary sb-freeze", type: "button", onclick: () => freezeCreatedSpec() },
        [icon("check"), el("span", {}, "Freeze spec")],
      ),
    );
  } else {
    confirmRow.appendChild(
      el(
        "p",
        { class: "pb-confirm-note dim" },
        "Spec frozen: its clauses can no longer change. Plan a build from it, and each ticket carries the clauses it proves.",
      ),
    );
    confirmRow.appendChild(
      el(
        "button",
        { class: "btn primary sb-build", type: "button", onclick: () => buildFromFrozenSpec() },
        [icon("check"), el("span", {}, "Build the tickets from this spec")],
      ),
    );
  }
  wrap.appendChild(confirmRow);
  return wrap;
}

/** One editable clause row: kind chip + text + rationale + remove. */
function renderSpecClauseRow(clause, i, locked) {
  const kindSel = el(
    "select",
    {
      class: "select sb-kind",
      "aria-label": `Clause ${i + 1} kind`,
      disabled: locked ? "" : undefined,
    },
    SPEC_CLAUSE_KINDS.map((k) =>
      el("option", { value: k, selected: clause.kind === k ? "" : undefined }, k),
    ),
  );
  kindSel.addEventListener("change", () => {
    specBuildState.draft.clauses[i].kind = kindSel.value;
  });

  const textArea = el("textarea", {
    class: "pb-input sb-clause-text",
    rows: "2",
    value: clause.text || "",
    placeholder: "One testable statement…",
    "aria-label": `Clause ${i + 1} text`,
    disabled: locked ? "" : undefined,
  });
  textArea.value = clause.text || "";
  textArea.addEventListener("input", () => {
    specBuildState.draft.clauses[i].text = textArea.value;
    updateSpecCreateEnabled();
  });

  const rationaleInput = el("input", {
    class: "sb-clause-rationale",
    type: "text",
    value: clause.rationale || "",
    placeholder: "Rationale (optional)",
    "aria-label": `Clause ${i + 1} rationale`,
    disabled: locked ? "" : undefined,
  });
  rationaleInput.addEventListener("input", () => {
    specBuildState.draft.clauses[i].rationale = rationaleInput.value;
  });

  const top = el("div", { class: "pb-ticket-top sb-clause-top" }, [
    el("span", { class: "sb-clause-no tabnum", "aria-hidden": "true" }, String(i + 1)),
    kindSel,
    !locked
      ? el(
          "button",
          {
            class: "icon-btn sb-remove",
            type: "button",
            "aria-label": `Remove clause ${i + 1}`,
            onclick: () => {
              specBuildState.draft.clauses.splice(i, 1);
              renderSpecBuildLog();
            },
          },
          el("span", { html: "✕" }),
        )
      : null,
  ]);

  return el("li", { class: "pb-ticket sb-clause" }, [top, textArea, rationaleInput]);
}

/** Enable/disable the Create button live from title + at-least-one-non-empty-clause. */
function updateSpecCreateEnabled() {
  if (!specBuildEls) return;
  const btn = specBuildEls.panel.querySelector(".sb-create");
  if (!btn) return;
  const clauses = (specBuildState.draft && specBuildState.draft.clauses) || [];
  const ok =
    (specBuildState.title || "").trim().length > 0 && clauses.some((c) => (c.text || "").trim());
  btn.disabled = !ok || specBuildState.busy;
}

/**
 * Send the next spec-author turn. Mirrors submitPlanBuildTurn: append the user
 * message, POST /spec-build, fold the reply (clarify → questions; spec → editable
 * draft; error → persistent in-chat error + toast). `forcePlan` drafts the spec now.
 */
async function submitSpecBuildTurn(opts = {}) {
  const forcePlan = opts.forcePlan === true;
  const { input, sendBtn } = specBuildEls;
  const text = input.value.trim();
  if (specBuildState.busy) return;
  if (!forcePlan && !text) return;

  const isFirst = specBuildState.history.length === 0;
  if (forcePlan && isFirst && !text) {
    toast("Tell me what to build first, then I can draft the spec.");
    return;
  }

  if (text) {
    if (isFirst) {
      specBuildState.brief = text;
      // Seed a sensible default title from the brief (editable in the draft view).
      specBuildState.title = text.slice(0, 120);
    }
    specBuildState.history.push(
      isFirst ? { role: "user", brief: text } : { role: "user", answer: text },
    );
    input.value = "";
    input.style.height = "auto";
  }

  specBuildState.busy = true;
  sendBtn.disabled = true;
  sendBtn.classList.add("is-running");
  sendBtn.setAttribute("aria-busy", "true");
  clear(sendBtn);
  sendBtn.appendChild(el("span", { class: "btn-spinner", "aria-hidden": "true" }));
  sendBtn.appendChild(el("span", { class: "pb-send-label" }, "Drafting…"));
  renderSpecBuildLog();

  let failure = null;
  try {
    const res = await api("POST", "/spec-build", {
      brief: specBuildState.brief,
      history: specBuildState.history
        .filter((t) => !(t.role === "assistant" && t.error))
        .map((t) => (t.role === "user" && t.brief ? { role: "user", answer: t.brief } : t)),
      ...(forcePlan ? { forcePlan: true } : {}),
    });
    if (res.phase === "clarify") {
      specBuildState.history.push({ role: "assistant", questions: res.questions || [] });
    } else if (res.phase === "spec") {
      const clauses = (res.spec && Array.isArray(res.spec.clauses) ? res.spec.clauses : []).map(
        (c) => ({
          clause_id: c.clause_id,
          kind: SPEC_CLAUSE_KINDS.includes(c.kind) ? c.kind : "requirement",
          text: c.text || "",
          rationale: c.rationale || "",
        }),
      );
      specBuildState.draft = { clauses };
    } else {
      failure = res.error || "The spec author returned no result.";
    }
  } catch (e) {
    failure = e && e.message ? e.message : "The request errored before a spec came back.";
  }

  specBuildState.busy = false;
  if (failure) {
    specBuildState.history.push({ role: "assistant", error: failure });
    toast(failure, { code: "SPEC_BUILD" });
  }
  sendBtn.disabled = false;
  sendBtn.classList.remove("is-running");
  sendBtn.removeAttribute("aria-busy");
  clear(sendBtn);
  sendBtn.appendChild(icon("send"));
  renderSpecBuildLog();
}

/** Human confirm → POST /specs. Clauses land as a draft spec, then Freeze appears. */
async function createSpecFromDraft() {
  if (!specBuildState || !specBuildState.draft || specBuildState.busy) return;
  const title = (specBuildState.title || "").trim();
  if (!title) {
    toast("Give the spec a title first.");
    return;
  }
  // Only send non-empty clauses; the server rejects blank text at its boundary.
  const clauses = specBuildState.draft.clauses
    .filter((c) => (c.text || "").trim())
    .map((c) => ({
      ...(c.clause_id ? { clause_id: c.clause_id } : {}),
      kind: c.kind,
      text: c.text.trim(),
      ...(c.rationale && c.rationale.trim() ? { rationale: c.rationale.trim() } : {}),
    }));
  if (clauses.length === 0) {
    toast("Add at least one clause with text before creating the spec.");
    return;
  }

  specBuildState.busy = true;
  specBuildState.actionError = null;
  renderSpecBuildLog();
  try {
    const res = await api("POST", "/specs", {
      title,
      ...(specBuildState.brief ? { brief: specBuildState.brief } : {}),
      clauses,
      // The repo this spec is for. The freeze tags every seeded clause with it so the
      // delivery primer's per-repo lore search surfaces the clauses to that repo's
      // agents; omitted (org-wide) when none was picked.
      ...(specBuildState.targetRepo ? { target_repo: specBuildState.targetRepo } : {}),
    });
    specBuildState.createdSpec = res.spec || null;
    // Reflect the server-assigned clause ids/order back into the editable draft.
    if (res.spec && Array.isArray(res.spec.clauses)) {
      specBuildState.draft = {
        clauses: res.spec.clauses.map((c) => ({
          clause_id: c.clause_id,
          kind: c.kind,
          text: c.text,
          rationale: c.rationale || "",
        })),
      };
    }
    toast("Spec created as a draft. Freeze it when it is ready.", { ok: true });
  } catch (e) {
    // Persistent error (rendered in the draft card), plus a toast for immediacy.
    specBuildState.actionError = e && e.message ? e.message : "Could not create the spec.";
    toast(specBuildState.actionError, { code: e && e.code });
  } finally {
    specBuildState.busy = false;
    renderSpecBuildLog();
  }
}

/** Freeze the created spec → immutable clauses + seeded product-intent lore. */
async function freezeCreatedSpec() {
  if (!specBuildState || !specBuildState.createdSpec || specBuildState.busy) return;
  const id = specBuildState.createdSpec.id;
  specBuildState.busy = true;
  specBuildState.actionError = null;
  renderSpecBuildLog();
  try {
    const res = await api("POST", `/specs/${id}/freeze`);
    specBuildState.createdSpec = res.spec || specBuildState.createdSpec;
    toast("Spec frozen: its clauses can no longer change.", { ok: true });
  } catch (e) {
    specBuildState.actionError = e && e.message ? e.message : "Could not freeze the spec.";
    toast(specBuildState.actionError, { code: e && e.code });
  } finally {
    specBuildState.busy = false;
    renderSpecBuildLog();
  }
}

/**
 * Hand a FROZEN spec off to the "Plan a build" decomposer. Its clauses ride along on the
 * plan-build POST so the decomposer satisfies each clause and stamps spec_clause_id
 * provenance on the ACs — the coverage/traceability read model depends on this. Closes the
 * spec panel and opens plan-build seeded with the clauses + a brief; the user then presses
 * "Build the tickets". Without this handoff the frozen spec never reaches decompose and the
 * Specs coverage view reads 0% for every spec even when the work fully delivers.
 */
function buildFromFrozenSpec() {
  const spec = specBuildState && specBuildState.createdSpec;
  if (!spec || spec.status !== "frozen") return;
  const clauses = (Array.isArray(spec.clauses) ? spec.clauses : [])
    .filter((c) => c && c.clause_id && c.kind && c.text)
    .map((c) => ({
      clause_id: c.clause_id,
      kind: c.kind,
      text: c.text,
      ...(c.rationale ? { rationale: c.rationale } : {}),
    }));
  if (!clauses.length) return;
  const brief =
    (specBuildState && specBuildState.brief) ||
    spec.brief ||
    spec.title ||
    "Build from the frozen spec.";
  closeSpecBuild();
  // Carry the spec's target repo into the plan: the decomposer then takes the
  // existing-repo (brownfield) path for that repo instead of scaffolding a new one.
  openPlanBuild({ spec: clauses, brief, ...(spec.target_repo ? { repo: spec.target_repo } : {}) });
}

// --- View: Memory (Repo Digest · Feature ledger · Lore) ---------------------
//
// The unified control room reads the SEPARATE memory product (memory) through
// the Dispatch API's server-side read endpoints — ONE origin, one process. This
// view surfaces three read-only memory artefacts and never mutates anything:
//   • Repo Digest   — the repo's understanding (overview/structure/conventions/
//                     stack) with its freshness line + honesty caveat.
//   • Features      — the ledger split Current (shipped) / Building / Backlog,
//                     filterable by scope node.
//   • Lore          — the team's recorded lore (read-only).
//
// Memory is OPTIONAL: each endpoint answers `{ available:false, reason }` when
// the memory store isn't configured/built, and this view renders a clean
// "memory unavailable" panel from that — it never errors the dashboard.

const FEATURE_GROUPS = [
  { status: "shipped", label: "Current", note: "Shipped — live in the repo." },
  { status: "building", label: "Building", note: "In flight right now." },
  { status: "backlog", label: "Backlog", note: "Proposed, not yet started." },
];

// Hash-driven so links + the router re-render cleanly:
//   #/memory                      → repo picker, nothing selected
//   #/memory/<repo>               → digest + features + lore for <repo>
//   #/memory/<repo>?node=<n>      → features narrowed to one scope node
const memoryState = { repo: "", node: "" };

function writeMemoryStateToUrl() {
  const repo = memoryState.repo;
  if (!repo) {
    navigate("#/memory");
    return;
  }
  const qs = memoryState.node ? `?node=${encodeURIComponent(memoryState.node)}` : "";
  navigate(`#/memory/${encodeURIComponent(repo)}${qs}`);
}

/** Render the structured "memory unavailable" panel from an unavailable result. */
function memoryUnavailable(reason) {
  return el("div", { class: "card memory-unavailable", dataset: { state: "unavailable" } }, [
    el("div", { class: "es-icon" }, icon("alert")),
    el("div", { class: "es-title" }, "Memory unavailable"),
    el("p", { class: "dim es-sub" }, reason || "The memory product is not reachable right now."),
    el("p", { class: "dim section-note" }, [
      "The dashboard keeps working without it. Configure the memory CLI (",
      el("code", { class: "mono" }, "MEMORY_CLI_BIN"),
      " + ",
      el("code", { class: "mono" }, "MEMORY_DB"),
      ") on the Dispatch server to light these surfaces up.",
    ]),
  ]);
}

/**
 * "Onboard a repo" — POST /repos/onboard to scan a repo, register it in Dispatch,
 * and build its Memory digest + feature inventory (the data the Repo Digest +
 * Feature ledger below read). The endpoint spawns the configured DISPATCH_ONBOARD_CMD
 * detached, so the scan + digest build run async; we show an immediate running state
 * (via the shared runAsyncAction helper the other spawn buttons use), then re-read the
 * Memory view so the freshly-built digest + features surface. A NOT_CONFIGURED (no
 * DISPATCH_ONBOARD_CMD) toasts its message via the shared guard. `presetRepo` (when
 * given) pre-selects the repo so the digest empty-state can offer "onboard THIS repo".
 */
function openOnboardPicker(repos, presetRepo) {
  const repoSel = el("select", {}, [
    el("option", { value: "" }, repos.length ? "Pick a registered repo…" : "No registered repos"),
    ...repos.map((r) => el("option", { value: r.name, selected: presetRepo === r.name }, r.name)),
  ]);
  const pathInput = el("input", {
    type: "text",
    name: "onboard-path",
    placeholder: "/path/to/a/local/repo",
    autocomplete: "off",
    spellcheck: "false",
  });
  if (presetRepo) repoSel.value = presetRepo;

  const runBtn = el("button", { class: "btn primary", type: "submit" }, "Onboard");
  const form = el(
    "form",
    {
      class: "form-grid",
      onsubmit: (e) => {
        e.preventDefault();
        // Either a registered repo (selector) OR a typed path; the selector wins when
        // both are set. The endpoint resolves which kind the target is.
        const repo = (repoSel.value || pathInput.value).trim();
        if (!repo) {
          toast("Pick a registered repo or type a path to onboard.");
          return;
        }
        runAsyncAction(runBtn, "Onboarding…", async () => {
          await api("POST", "/repos/onboard", { repo });
          toast(`Onboarding '${repo}' — its digest + features will appear shortly.`, { ok: true });
          closeSheet();
          // Re-read the Memory view focused on the onboarded repo so the digest +
          // feature ledger refresh once the producer lands them.
          memoryState.repo = repos.some((r) => r.name === repo) ? repo : memoryState.repo;
          memoryState.node = "";
          writeMemoryStateToUrl();
          router();
        });
      },
    },
    [
      el(
        "p",
        { class: "mode-note dim" },
        "Scans the repo, registers it in Dispatch, and builds its Memory digest + feature inventory.",
      ),
      el(
        "p",
        { class: "mode-note dim" },
        "Cards the whole repo — a sizeable one-off (several minutes + model calls for larger repos). " +
          "Memory then refreshes itself incrementally as agents deliver, so you don't need to re-run it.",
      ),
      field("Registered repo", repoSel),
      el("div", { class: "or-divider dim" }, "or"),
      field("Local path", pathInput),
      el("div", { class: "btn-row" }, [runBtn]),
    ],
  );

  openSheet("Onboard a repo", form);
}

/** The Memory view's "Onboard a repo" trigger (header + empty-state share it). */
function onboardButton(repos, presetRepo, opts) {
  const o = opts || {};
  const btn = el(
    "button",
    {
      class: o.primary ? "btn primary" : "btn",
      type: "button",
      title: "Scan a repo and build its Memory digest + feature inventory",
      onclick: () => openOnboardPicker(repos, presetRepo),
    },
    [icon("plus"), el("span", {}, "Onboard a repo")],
  );
  return btn;
}

// --- Specs (Spec-Driven Development, Phase 3: coverage & traceability) -------

const SPEC_STATUS_LABEL = { draft: "Draft", frozen: "Frozen", superseded: "Superseded" };
const CLAUSE_KIND_LABEL = {
  requirement: "Requirement",
  "non-goal": "Non-goal",
  decision: "Decision",
};
const LORE_STATUS_LABEL = {
  active: "reaching agents",
  draft: "unratified",
  absent: "not seeded",
  unknown: "",
};

/** Count clauses on a spec row without throwing on a malformed clauses_json. */
function specClauseCount(spec) {
  try {
    const parsed = JSON.parse(spec.clauses_json || "[]");
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Specs view. Two surfaces on one route: a list of specs (#/specs) and, for a
 * given spec (#/specs/:id), the coverage TRACE — each clause → its covering ACs
 * (satisfied vs open), the coverage gaps (orphan clauses) called out, per-clause
 * bounce counts, and the seeded-lore ratification status. Modelled on renderEpics.
 */
async function renderSpecs(param) {
  const specId = param ? decodeURIComponent(param) : "";
  return specId ? renderSpecDetail(specId) : renderSpecList();
}

/** A spec's status: its mark + its word (a lock when frozen: the clauses cannot change). */
function specStatusMark(status) {
  const word = SPEC_STATUS_LABEL[status] || status || "—";
  const mark =
    status === "frozen"
      ? icon("lock", "spec-lock", 16)
      : glyph(status === "superseded" ? "cancelled" : "draft", 16);
  return el("span", { class: `spec-card-status status-${status}` }, [mark, el("span", {}, word)]);
}

/** How many of a clause's covering criteria are met, of how many. */
function clauseMet(c) {
  const acs = Array.isArray(c.covering_acs) ? c.covering_acs : [];
  return { met: acs.filter((ac) => ac.satisfied).length, of: acs.length };
}

/**
 * One clause's coverage state (the data-state hook). The server's `satisfied`
 * flag is true when ANY covering criterion is met, so the state is read from the
 * criteria themselves: satisfied only when every one is met, partly met when
 * some are, open when none are. A clause is proven only when all of it is.
 */
function clauseState(c) {
  if (c.orphan) return "orphan";
  const { met, of } = clauseMet(c);
  if (!of) return c.satisfied ? "satisfied" : "open";
  return met === of ? "satisfied" : met > 0 ? "partial" : "open";
}

/** Clause kinds that record intent rather than behaviour: no criterion is not a gap. */
const INTENT_KINDS = new Set(["non-goal", "decision"]);

/**
 * A spec not built yet: a draft, or a frozen spec with no campaign playing it and
 * no criterion naming any clause (the state between "Freeze spec" and "Plan a
 * build from it"). Its clauses read "not covered yet" everywhere (the squares,
 * the board line, the lede and the list), never as gaps: nothing has failed.
 */
function specUnbuilt(status, clauses, scopeNodeId) {
  if (status === "draft") return true;
  return !scopeNodeId && !(clauses || []).some((c) => c.covered);
}

/**
 * A gap is a clause that should be proven and is not: a requirement of a spec
 * whose build is under way with no criterion covering it. A spec not built yet
 * (specUnbuilt) has no gaps by design, and a non-goal or a decision with no
 * criterion is not a failure; those read quietly, never red.
 */
function clauseIsGap(c, status, unbuilt = false) {
  return !!c.orphan && !unbuilt && status !== "draft" && !INTENT_KINDS.has(c.kind);
}

/** How many of a coverage payload's clauses are gaps (see clauseIsGap). */
function specGapCount(coverage, status) {
  const clauses = coverage && Array.isArray(coverage.clauses) ? coverage.clauses : null;
  if (clauses) {
    const unbuilt = specUnbuilt(status, clauses, coverage.scope_node_id);
    return clauses.filter((c) => clauseIsGap(c, status, unbuilt)).length;
  }
  const r = specCoverageRollup(coverage);
  return r && status !== "draft" && (r.covered || coverage.scope_node_id) ? r.orphans : 0;
}

/**
 * The form guide: one square per clause, in the order written — filled when
 * every criterion is met, outlined with a filled corner when some are, outlined
 * when covered but none is met yet, red when it is a gap, dashed when it has no
 * criterion and is not a gap (a spec not built yet, a non-goal, a decision).
 * Decorative next to the sentence that states the same counts.
 */
function specFormGuide(clauses, status, scopeNodeId) {
  const unbuilt = specUnbuilt(status, clauses, scopeNodeId);
  return el(
    "span",
    { class: "spec-form", "aria-hidden": "true" },
    clauses.map((c, i) => {
      const state = clauseState(c);
      const cls =
        state === "orphan" ? (clauseIsGap(c, status, unbuilt) ? "orphan" : "none") : state;
      return el(
        "i",
        {
          class: `fg fg-${cls}`,
          title: `Clause ${i + 1} (${CLAUSE_KIND_LABEL[c.kind] || c.kind}): ${c.text}`,
        },
        String(i + 1),
      );
    }),
  );
}

/**
 * "6 of 8 covered · 1 satisfied · 2 partly met · 1 gap" — the counts the form
 * guide draws. Satisfied means every criterion on the clause is met.
 */
function specCoverageWords(r, gaps) {
  if (!r) return "Coverage unavailable";
  if (!r.total) return "No clauses yet";
  if (!r.covered)
    return gaps
      ? `Nothing covered: ${plural(gaps, "gap")}`
      : `Not covered yet: no criterion names ${r.total === 1 ? "it" : "them"}`;
  return [
    `${r.covered} of ${r.total} covered`,
    r.satisfied != null ? `${r.satisfied} satisfied` : null,
    r.partial ? `${r.partial} partly met` : null,
    gaps ? plural(gaps, "gap") : "no gaps",
  ]
    .filter(Boolean)
    .join(" · ");
}

async function renderSpecList() {
  const signal = routeSignal();
  const res = await api("GET", "/specs", undefined, { signal });
  const specs = res.specs || [];

  const wrap = el("div", { class: "view view-specs", dataset: { view: "specs" } });
  const author = el(
    "button",
    { class: "btn primary", type: "button", onclick: () => openSpecBuild() },
    [icon("spark"), el("span", {}, "Author a spec")],
  );
  const by = (st) => specs.filter((s) => s.status === st).length;
  wrap.appendChild(
    viewHead(
      "The playbook",
      specs.length
        ? [
            plural(specs.length, "spec"),
            by("frozen") ? `${by("frozen")} frozen` : null,
            by("draft") ? `${by("draft")} draft` : null,
            by("superseded") ? `${by("superseded")} superseded` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "No specs written yet.",
      author,
    ),
  );

  if (specs.length === 0) {
    // What is on the pitch without a written play: the campaigns and live tickets,
    // so the empty page still says something true about this club.
    const [nodesRes, ticketsRes] = await Promise.all([
      api("GET", "/scope/nodes", undefined, { signal }).catch(() => ({ nodes: [] })),
      api("GET", "/tickets", undefined, { signal }).catch(() => ({ tickets: [] })),
    ]);
    const epics = (nodesRes.nodes || []).filter((n) => n.type === "epic");
    const live = (ticketsRes.tickets || []).filter((t) => !TERMINAL.has(t.status));
    wrap.appendChild(
      el("section", { class: "card playbook-empty" }, [
        panelHead("No specs yet", null, null, { kit: "ink" }),
        el(
          "div",
          { class: "pb-steps", role: "list" },
          [
            ["1", "The brief", "Say what to build in a paragraph."],
            ["2", "The clauses", "Gaffer drafts testable clauses; you edit them."],
            ["3", "Frozen", "Each clause is traced to the acceptance criteria that prove it."],
          ].map(([n, h, t]) =>
            el("div", { class: "pb-step", role: "listitem" }, [
              el("span", { class: "pb-n", "aria-hidden": "true" }, n),
              el("h3", {}, h),
              el("p", {}, t),
            ]),
          ),
        ),
        el(
          "p",
          { class: "pb-now" },
          epics.length || live.length
            ? [
                `Playing without a written spec right now: ${plural(epics.length, "campaign")}${epics.length ? ` (${epics.map((e) => e.name).join(", ")})` : ""} and ${plural(live.length, "live ticket")}. `,
                el("a", { href: "#/epics" }, "See the season"),
                ".",
              ]
            : "Nothing is on the pitch yet: a spec is a good first play.",
        ),
        el("div", { class: "btn-row" }, [
          el("button", { class: "btn primary", type: "button", onclick: () => openSpecBuild() }, [
            icon("spark"),
            el("span", {}, "Write the first play"),
          ]),
        ]),
      ]),
    );
    return wrap;
  }

  // Coverage per spec (best-effort: a failed read shows "Coverage unavailable" on
  // that row, never a broken page) and the campaign names the specs are played in.
  const [coverages, nodesRes] = await Promise.all([
    Promise.all(
      specs.map((s) =>
        api("GET", `/specs/${encodeURIComponent(s.id)}/coverage`, undefined, { signal })
          .then((r) => (r && r.coverage) || null)
          .catch(() => null),
      ),
    ),
    api("GET", "/scope/nodes", undefined, { signal }).catch(() => ({ nodes: [] })),
  ]);
  const covById = new Map(specs.map((s, i) => [s.id, coverages[i]]));
  const nodeName = new Map(((nodesRes && nodesRes.nodes) || []).map((n) => [n.id, n.name]));

  // The newest spec (by when it was written, the order the server lists them in)
  // is marked: it is the one most likely in play.
  const stamp = (x) => Date.parse(x.created_at || x.updated_at || 0) || 0;
  const newestId = specs.slice().sort((a, b) => stamp(b) - stamp(a))[0]?.id;

  const list = el("div", { class: "spec-list", role: "list" });
  for (const spec of specs)
    list.appendChild(
      el(
        "div",
        { role: "listitem" },
        renderSpecCard(spec, {
          coverage: covById.get(spec.id),
          isPrimary: spec.id === newestId,
          campaign: spec.scope_node_id ? nodeName.get(spec.scope_node_id) : null,
        }),
      ),
    );
  wrap.appendChild(
    el("section", { class: "card prog spec-plays", "aria-labelledby": "spec-plays-h" }, [
      (() => {
        const h = panelHead("The plays", `${plural(specs.length, "spec")}, as written`, null, {
          kit: "claret",
        });
        h.querySelector(".panel-title").id = "spec-plays-h";
        return h;
      })(),
      list,
      el("p", { class: "spec-key" }, [
        ...[
          ["satisfied", "1", "satisfied: every criterion met"],
          ["partial", "2", "partly met: some criteria met"],
          ["open", "3", "covered, none met yet"],
          ["orphan", "4", "a gap: a requirement nothing covers while it is built"],
          [
            "none",
            "5",
            "no criterion yet, not a gap (a spec not built yet, a non-goal, a decision)",
          ],
        ].map(([cls, n, words]) =>
          el("span", { class: "spec-key-item" }, [
            el("span", { class: "spec-form", "aria-hidden": "true" }, [
              el("i", { class: `fg fg-${cls}` }, n),
            ]),
            el("span", {}, words),
          ]),
        ),
        el("span", {}, "Each square is a clause, in the order written."),
      ]),
    ]),
  );
  return wrap;
}

/**
 * A rollup {total,covered,satisfied,partial,orphans} from a coverage payload,
 * defensively read. Satisfied and partly met are counted from the clauses when
 * they are there (clauseState): the server's own `satisfied` counts a clause
 * with any criterion met, which is not the same as proven.
 */
function specCoverageRollup(coverage) {
  const src =
    coverage && coverage.rollup && typeof coverage.rollup === "object" ? coverage.rollup : null;
  if (!src) return null;
  const total = Number(src.total) || 0;
  const covered = Number(src.covered) || 0;
  const orphans = Array.isArray(src.orphans) ? src.orphans.length : Number(src.orphans) || 0;
  const clauses = Array.isArray(coverage.clauses) ? coverage.clauses : null;
  if (clauses && clauses.length) {
    const states = clauses.map(clauseState);
    const n = (st) => states.filter((x) => x === st).length;
    return { total, covered, satisfied: n("satisfied"), partial: n("partial"), orphans };
  }
  const satisfied = src.satisfied != null ? Number(src.satisfied) || 0 : null;
  return { total, covered, satisfied, partial: 0, orphans };
}

/** One spec = one line of the playbook, linking to its clause-by-clause trace. */
function renderSpecCard(spec, { coverage, isPrimary = false, campaign = null } = {}) {
  const count = specClauseCount(spec);
  const rollup = specCoverageRollup(coverage);
  const clauses = coverage && Array.isArray(coverage.clauses) ? coverage.clauses : [];
  const statusLabel = SPEC_STATUS_LABEL[spec.status] || spec.status;
  const gaps = coverage ? specGapCount(coverage, spec.status) : 0;
  const words = specCoverageWords(rollup, gaps);
  return el(
    "a",
    {
      class: `spec-card${isPrimary ? " spec-card--primary" : ""}${gaps ? " has-gaps" : ""}`,
      href: `#/specs/${encodeURIComponent(spec.id)}`,
      dataset: { specId: spec.id, status: spec.status },
      "aria-label": `${spec.title}: ${statusLabel}, ${plural(count, "clause")}, ${words}${campaign ? `, played in ${campaign}` : ""}`,
    },
    [
      el("span", { class: "spec-card-lead" }, [
        specStatusMark(spec.status),
        isPrimary ? el("span", { class: "spec-card-new" }, "newest") : null,
      ]),
      el("span", { class: "spec-card-body" }, [
        el("span", { class: "spec-card-title" }, spec.title),
        spec.brief ? el("span", { class: "spec-card-brief" }, spec.brief) : null,
        el("span", { class: "spec-card-meta" }, [
          el("span", {}, plural(count, "clause")),
          spec.target_repo ? repoTag(spec.target_repo, 16) : null,
          campaign ? el("span", {}, `Campaign: ${campaign}`) : null,
          spec.updated_at ? el("span", {}, `updated ${fmtRelative(spec.updated_at)}`) : null,
        ]),
      ]),
      el("span", { class: "spec-card-cov" }, [
        clauses.length ? specFormGuide(clauses, spec.status, coverage.scope_node_id) : null,
        el("span", { class: `spec-card-words${gaps ? " is-red" : ""}` }, words),
      ]),
    ],
  );
}

async function renderSpecDetail(specId) {
  const signal = routeSignal();
  const [res, specRes, nodesRes] = await Promise.all([
    api("GET", `/specs/${encodeURIComponent(specId)}/coverage`, undefined, { signal }),
    api("GET", `/specs/${encodeURIComponent(specId)}`, undefined, { signal }).catch(() => null),
    api("GET", "/scope/nodes", undefined, { signal }).catch(() => ({ nodes: [] })),
  ]);
  const cov = res && res.coverage;
  // GET /specs/:id answers { spec }; tolerate a list-shaped answer too.
  const spec =
    (specRes && specRes.spec) ||
    ((specRes && specRes.specs) || []).find((s) => s.id === specId) ||
    null;

  const wrap = el("div", { class: "view view-spec", dataset: { view: "specs" } });
  const back = el("a", { class: "back-link", href: "#/specs" }, [
    icon("back", "", 16),
    "The playbook",
  ]);
  wrap.appendChild(back);

  // Defensive: a missing / empty / malformed coverage payload must render a
  // clean empty state, not blank the whole spec view.
  if (!cov || typeof cov !== "object") {
    wrap.appendChild(viewHead((spec && spec.title) || "Spec", "Coverage"));
    wrap.appendChild(
      emptyState(
        "Coverage unavailable",
        "This spec's coverage report could not be loaded. It may have been removed, or the report is still being built.",
        null,
        el("a", { class: "btn", href: "#/specs" }, "Back to the playbook"),
      ),
    );
    return wrap;
  }

  const clauses = Array.isArray(cov.clauses) ? cov.clauses : [];
  const r = specCoverageRollup(cov.rollup ? cov : { ...cov, rollup: {} });
  r.satisfied = r.satisfied || 0;
  const status = cov.status || (spec && spec.status) || "";
  const targetRepo = (spec && spec.target_repo) || cov.target_repo || null;
  const campaign = cov.scope_node_id
    ? ((nodesRes && nodesRes.nodes) || []).find((n) => n.id === cov.scope_node_id)
    : null;
  const brief = (spec && spec.brief) || cov.brief || null;

  // The lede: where the spec stands, from its coverage. A gap is a requirement
  // nothing proves while it is built (clauseIsGap); a spec not built yet (a draft,
  // or frozen with no campaign and nothing covering it) reads as one calm "not
  // covered yet" in the squares, the board, the lede and the list, never as red.
  const unbuilt = specUnbuilt(status, clauses, cov.scope_node_id);
  const gapClauses = clauses.filter((c) => clauseIsGap(c, status, unbuilt));
  const gapsN = gapClauses.length;
  const quietN = clauses.filter((c) => c.orphan && !clauseIsGap(c, status, unbuilt)).length;
  const uncovered = unbuilt && r.total > 0 && r.covered === 0;
  // "1 already satisfied and 2 partly met": satisfied means every criterion is met.
  const metWords =
    r.satisfied && r.partial
      ? `, ${r.satisfied} already satisfied and ${r.partial} partly met`
      : r.satisfied
        ? `, ${r.satisfied} already satisfied`
        : r.partial
          ? `, none fully proven yet: ${r.partial} partly met`
          : "";
  const quietOf = (k) => clauses.filter((c) => c.orphan && c.kind === k).length;
  const quietWords = [
    quietOf("non-goal") ? plural(quietOf("non-goal"), "non-goal") : null,
    quietOf("decision") ? plural(quietOf("decision"), "decision") : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const total = plural(r.total, "clause");
  let lede;
  if (!r.total)
    lede = [el("b", {}, `${SPEC_STATUS_LABEL[status] || "Spec"}. `), "It has no clauses yet."];
  else if (uncovered)
    lede = [
      el("b", {}, `${SPEC_STATUS_LABEL[status] || "Spec"}. `),
      // Not built yet: said the same way here, on the board, and in the list.
      status === "draft"
        ? `Not covered yet, and no gaps: freeze it to lock its ${total} and seed them as lore for the agents; the criteria that prove them come with the build you plan from it.`
        : status === "frozen"
          ? `Not covered yet, and no gaps until it is built: plan a build from it, and each ticket's criteria will name the ${r.total === 1 ? "clause it proves" : "clauses they prove"}.`
          : `None of its ${total} is covered.`,
    ];
  else
    lede = [
      el("b", {}, `${SPEC_STATUS_LABEL[status] || "Spec"}. `),
      `${r.covered} of its ${total} ${r.covered === 1 ? "is" : "are"} covered by acceptance criteria${metWords}.`,
      gapsN
        ? [
            " ",
            el(
              "span",
              { class: "is-red" },
              `${gapsN === 1 ? "1 requirement has" : `${gapsN} requirements have`} no criterion, so nothing proves ${gapsN === 1 ? "it" : "them"} yet.`,
            ),
          ]
        : "",
      quietN
        ? status === "draft"
          ? ` ${quietN} ${quietN === 1 ? "is" : "are"} not covered yet.`
          : ` ${quietWords} ${quietN === 1 ? "has" : "have"} none, which is not counted as a gap.`
        : !gapsN
          ? " Every clause has a criterion."
          : "",
      status === "draft"
        ? " Freeze it to lock the clauses and seed them as lore for the agents."
        : "",
    ];

  const actions = [];
  if (cov.scope_node_id) {
    actions.push(
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => navigate(`#/epics/${encodeURIComponent(cov.scope_node_id)}`),
        },
        [icon("epics"), el("span", {}, "Open campaign")],
      ),
    );
  }
  if (status === "draft") {
    actions.unshift(
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: (e) =>
            runAsyncAction(e.currentTarget, "Freezing…", async () => {
              await api("POST", `/specs/${encodeURIComponent(specId)}/freeze`);
              toast("Spec frozen: its clauses are locked and seeded as lore.", { ok: true });
              router();
            }),
        },
        [icon("lock", "", 18), el("span", {}, "Freeze spec")],
      ),
    );
  } else if (status === "frozen" && !cov.scope_node_id && clauses.length) {
    // A frozen spec with no campaign yet: build one from it, clause provenance and all.
    actions.unshift(
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () =>
            openPlanBuild({
              spec: clauses
                .filter((c) => c.clause_id && c.kind && c.text)
                .map((c) => ({
                  clause_id: c.clause_id,
                  kind: c.kind,
                  text: c.text,
                  ...(c.rationale ? { rationale: c.rationale } : {}),
                })),
              brief: brief || cov.title || "Build from the frozen spec.",
              ...(targetRepo ? { repo: targetRepo } : {}),
            }),
        },
        [icon("spark"), el("span", {}, "Plan a build from it")],
      ),
    );
  }

  wrap.appendChild(
    el("header", { class: "spec-head" }, [
      el("p", { class: "spec-meta" }, [
        specStatusMark(status),
        targetRepo ? repoTag(targetRepo, 20) : el("span", {}, "Every repo"),
        campaign
          ? el(
              "a",
              { href: `#/epics/${encodeURIComponent(campaign.id)}` },
              `Campaign: ${campaign.name}`,
            )
          : null,
        el("span", {}, plural(r.total, "clause")),
        spec && spec.updated_at ? el("span", {}, `updated ${fmtRelative(spec.updated_at)}`) : null,
      ]),
      el("h1", { class: "detail-title" }, cov.title || (spec && spec.title) || "Spec"),
      el("p", { class: "spec-lede" }, lede),
      brief ? el("p", { class: "spec-brief" }, [el("b", {}, "The brief: "), `“${brief}”`]) : null,
      actions.length ? el("div", { class: "btn-row" }, actions) : null,
    ]),
  );

  const indexOf = new Map(clauses.map((c, i) => [c.clause_id, i + 1]));
  // Coverage gaps: requirements nothing proves, called out first. Only when some
  // clauses are covered: a spec nothing covers yet says so once, on the board.
  if (gapsN > 0 && !uncovered) {
    wrap.appendChild(
      el(
        "section",
        {
          class: "card coverage-gaps",
          dataset: { count: String(gapsN) },
          "aria-label": "Coverage gaps",
        },
        [
          panelHead(
            `${gapsN} coverage gap${gapsN === 1 ? "" : "s"}`,
            `${gapsN === 1 ? "a requirement" : "requirements"} with no acceptance criterion covering ${gapsN === 1 ? "it" : "them"}`,
            null,
            { kit: "red" },
          ),
          el(
            "ul",
            { class: "coverage-gaps-list" },
            gapClauses.map((c) =>
              el("li", { dataset: { clauseId: c.clause_id } }, [
                el(
                  "a",
                  {
                    class: "sc-no",
                    href: `#clause-${indexOf.get(c.clause_id) || ""}`,
                    "aria-label": `Clause ${indexOf.get(c.clause_id) || ""}, in the trace below`,
                  },
                  String(indexOf.get(c.clause_id) || ""),
                ),
                el("span", { class: "cg-text" }, c.text),
              ]),
            ),
          ),
          el(
            "p",
            { class: "cg-hint" },
            "Cover a gap with an acceptance criterion that names the clause, on the ticket that delivers it.",
          ),
        ],
      ),
    );
  }

  // Lore and bounces are said once for the spec when every clause shares them,
  // and per clause only where they differ.
  const loreSet = new Set(clauses.map((c) => c.lore_status || "unknown"));
  const loreOnce = loreSet.size === 1 ? [...loreSet][0] : null;
  const anyBounce = clauses.some((c) => c.bounce_count > 0);
  const notes = [];
  const uncoveredNote = !uncovered
    ? null
    : el("p", { class: "spec-board-note spec-uncovered" }, [
        glyph("draft", 16),
        el(
          "span",
          {},
          `Not covered yet: none of the ${total} has an acceptance criterion naming it. That is not a gap until a build is under way.`,
        ),
      ]);
  if (loreOnce && loreOnce !== "unknown")
    notes.push(
      el(
        "p",
        { class: "spec-board-note" },
        loreOnce === "active"
          ? "Lore: every clause is seeded and reaching the agents."
          : loreOnce === "draft"
            ? [
                "Lore: every clause is seeded as draft lore, unratified, so it is not reaching the agents yet. ",
                el("a", { href: "#/memory" }, "Ratify it in Memory"),
                ".",
              ]
            : `Lore: no clause is seeded yet.${status === "draft" ? " Freezing the spec seeds them." : ""}`,
      ),
    );
  if (anyBounce)
    notes.push(
      el(
        "p",
        { class: "spec-board-note" },
        "Bounced: how many times work on the tickets covering a clause was sent back.",
      ),
    );

  // The trace: one row per clause → its covering ACs → satisfied / open.
  const opts = { status, uncovered, unbuilt, loreOnce };
  const trace = el(
    "ol",
    { class: "spec-trace" },
    clauses.map((c, i) => el("li", { id: `clause-${i + 1}` }, renderClauseTrace(c, i + 1, opts))),
  );
  wrap.appendChild(
    progPage(
      "spec-clauses",
      "ink",
      "The clauses",
      `${plural(clauses.length, "clause")}, in the order written`,
      [
        specFormGuide(clauses, status, cov.scope_node_id),
        uncoveredNote,
        trace,
        notes.length ? el("div", { class: "spec-board-notes" }, notes) : null,
      ],
    ),
  );

  if (cov.gate_enabled) {
    wrap.appendChild(
      el(
        "p",
        { class: "section-note" },
        "The spec-coverage gate is on (advisory): a clause with no met criterion is flagged at the Definition of Done.",
      ),
    );
  }
  return wrap;
}

/**
 * One clause's trace row: its number, kind and text, its state, and the criteria
 * that prove it. A gap is red; a clause with no criterion that is not a gap is
 * quiet; when nothing in the spec is covered yet the board says so once and the
 * rows carry no state of their own.
 */
function renderClauseTrace(
  clause,
  n,
  { status, uncovered = false, unbuilt = false, loreOnce = null } = {},
) {
  const state = clauseState(clause);
  const isGap = clauseIsGap(clause, status, unbuilt);
  const acs = Array.isArray(clause.covering_acs) ? clause.covering_acs : [];
  const { met } = clauseMet(clause);
  const block = el("div", {
    class: `spec-clause${isGap ? " is-gap" : ""}`,
    dataset: {
      clauseId: clause.clause_id,
      state,
      covered: String(clause.covered),
      orphan: String(clause.orphan),
      // Proven: every covering criterion met (the server's flag means "any").
      satisfied: String(state === "satisfied"),
      met: String(met),
    },
  });
  const ofMet = acs.length > 1 ? ` · ${met} of ${acs.length} met` : "";
  const stateMark =
    state === "orphan"
      ? uncovered
        ? null
        : isGap
          ? el("span", { class: "sc-state is-red" }, [
              glyph("failed", 16),
              el("span", {}, "Gap: nothing proves it"),
            ])
          : el("span", { class: "sc-state is-quiet" }, [
              glyph("draft", 16),
              el("span", {}, status === "draft" ? "Not covered yet" : "No criterion"),
            ])
      : state === "satisfied"
        ? el("span", { class: "sc-state is-ok" }, [
            glyph("done", 16),
            el("span", {}, acs.length > 1 ? `Satisfied · all ${acs.length} met` : "Satisfied"),
          ])
        : state === "partial"
          ? el("span", { class: "sc-state is-part" }, [
              glyph("in_progress", 16),
              el("span", {}, `Partly met · ${met} of ${acs.length}`),
            ])
          : el("span", { class: "sc-state" }, [glyph("ready", 16), el("span", {}, `Open${ofMet}`)]);

  const tags = el("div", { class: "spec-clause-tags" }, [stateMark]);
  if (clause.bounce_count > 0) {
    const b = badge(`bounced ${clause.bounce_count}×`, "clause-bounce");
    b.title = `Work covering this clause was sent back ${plural(clause.bounce_count, "time")}`;
    tags.appendChild(b);
  }
  if (!loreOnce && clause.lore_status && clause.lore_status !== "unknown") {
    const label = LORE_STATUS_LABEL[clause.lore_status] || clause.lore_status;
    tags.appendChild(
      badge(
        `lore: ${clause.lore_status}${label ? ` (${label})` : ""}`,
        `lore-${clause.lore_status === "active" ? "active" : "draft"}`,
      ),
    );
  }

  const main = el("div", { class: "spec-clause-main" }, [
    el("div", { class: "spec-clause-head" }, [
      badge(CLAUSE_KIND_LABEL[clause.kind] || clause.kind, `clause-kind kind-${clause.kind}`),
      el("span", { class: "spec-clause-text" }, clause.text),
    ]),
    clause.rationale ? el("p", { class: "spec-clause-rationale" }, clause.rationale) : null,
  ]);
  if (acs.length) {
    main.appendChild(
      el(
        "ul",
        { class: "spec-clause-acs" },
        acs.map((ac) =>
          el("li", { class: "spec-ac", dataset: { satisfied: String(ac.satisfied) } }, [
            glyph(ac.satisfied ? "done" : "ready", 14, ac.satisfied ? "satisfied" : ac.ac_status),
            el("span", { class: "spec-ac-text" }, ac.ac_text),
            // The ticket and its status are one unit: they never wrap apart.
            el("span", { class: "spec-ac-tk" }, [
              el(
                "a",
                {
                  class: "spec-ac-ticket",
                  href: `#/ticket/${encodeURIComponent(ac.ticket_id)}`,
                  title: ac.ticket_title || "",
                },
                ac.ticket_number != null ? `#${ac.ticket_number}` : ac.ticket_title,
              ),
              ac.ticket_status
                ? el("span", { class: "spec-ac-st" }, statusLabel(ac.ticket_status))
                : null,
            ]),
          ]),
        ),
      ),
    );
  }
  block.appendChild(el("span", { class: "sc-no", "aria-hidden": "true" }, String(n)));
  block.appendChild(main);
  block.appendChild(tags);
  return block;
}

async function renderMemory(param) {
  const { query } = parseHash();
  memoryState.repo = param ? decodeURIComponent(param) : "";
  memoryState.node = query.get("node") || "";

  const reposRes = await api("GET", "/repositories");
  const repos = reposRes.repositories || [];

  // With no repo in the address, open the first one's report (a blank page asks
  // a question the operator should not have to answer to read anything).
  if (!memoryState.repo && repos.length) memoryState.repo = repos[0].name;

  const wrap = el("div", { class: "view view-memory", dataset: { view: "memory" } });
  wrap.appendChild(
    viewHead(
      "Club history",
      `Memory: scouting reports on ${plural(repos.length, "repo")}, the honours board, and the club's lore`,
      onboardButton(repos, memoryState.repo, { primary: true }),
    ),
  );
  // The squad of repos: one kit per repo, the one being read marked.
  if (repos.length > 1) {
    wrap.appendChild(
      el(
        "nav",
        { class: "mem-repos", "aria-label": "Repos" },
        repos.map((r) =>
          el(
            "a",
            {
              class: "mem-repo",
              href: `#/memory/${encodeURIComponent(r.name)}`,
              "aria-current": r.name === memoryState.repo ? "page" : null,
            },
            [kitShirt(r.name, 22), el("span", {}, r.name)],
          ),
        ),
      ),
    );
  }
  wrap.appendChild(
    el("p", { class: "mem-lede" }, [
      "The ",
      el("strong", {}, "scouting report"),
      " (Repo Digest) is the factory's read of a repo; the ",
      el("strong", {}, "honours board"),
      " (Feature ledger) is what has shipped, is building and is backlogged; ",
      el("strong", {}, "lore"),
      " is what the club has learned. Lore drafts wait here for you to approve or reject.",
    ]),
  );

  // Repo picker — drives the digest + feature ledger below.
  const repoSel = el(
    "select",
    {
      "aria-label": "Select a repo",
      onchange: (e) => {
        memoryState.repo = e.target.value;
        memoryState.node = "";
        writeMemoryStateToUrl();
      },
    },
    [
      el("option", { value: "" }, repos.length ? "Select a repo…" : "No repos known"),
      ...repos.map((r) =>
        el("option", { value: r.name, selected: memoryState.repo === r.name }, r.name),
      ),
    ],
  );
  wrap.appendChild(el("div", { class: "filters" }, [field("Repo", repoSel, { style: "flex:1" })]));

  if (memoryState.repo) {
    const [digestRes, featuresRes] = await Promise.all([
      api("GET", `/api/memory/digest/${encodeURIComponent(memoryState.repo)}`),
      api(
        "GET",
        `/api/memory/features/${encodeURIComponent(memoryState.repo)}${memoryState.node ? `?node=${encodeURIComponent(memoryState.node)}` : ""}`,
      ),
    ]);
    wrap.appendChild(renderDigestCard(memoryState.repo, digestRes, repos));
    wrap.appendChild(renderFeatureLedger(memoryState.repo, featuresRes));
  } else {
    wrap.appendChild(
      emptyState(
        "Pick a repo to read its memory",
        "The digest and feature ledger are per-repo. Choose one above.",
        "ticket",
      ),
    );
  }

  // Lore: a filtered, paged read of the memory store (status / repo / kind) with
  // approve / reject on drafts. Mounted into a slot so a filter change or a
  // ratification re-fetches ONLY this card, not the whole view.
  const loreSlot = el("div", { class: "lore-slot" });
  wrap.appendChild(loreSlot);
  await mountLoreCard(loreSlot, repos);
  return wrap;
}

// Lore card filters. They persist across the live re-render (the SSE refresh
// re-runs renderMemory every few seconds, and a reviewer mid-queue must not lose
// their "drafts only" view); the repo filter follows the page's repo whenever
// that changes. `limit` is a page, not a cap — the pager walks `total`.
const LORE_STATUSES = ["draft", "active", "deprecated", "superseded"];
const LORE_KINDS = ["decision", "requirement", "non-goal", "convention", "gotcha", "other"];
const loreFilter = { status: "", kind: "", repo: "", pageRepo: null, offset: 0, limit: 50 };

/** The lore read for the current filters: GET /api/memory/lore?repo&status&kind&limit&offset. */
function loreQueryPath() {
  const q = new URLSearchParams();
  if (loreFilter.repo) q.set("repo", loreFilter.repo);
  if (loreFilter.status) q.set("status", loreFilter.status);
  if (loreFilter.kind) q.set("kind", loreFilter.kind);
  q.set("limit", String(loreFilter.limit));
  if (loreFilter.offset > 0) q.set("offset", String(loreFilter.offset));
  return `/api/memory/lore?${q.toString()}`;
}

/** Fetch the current lore page and (re)render the card into `slot`. */
async function mountLoreCard(slot, repos) {
  if (loreFilter.pageRepo !== memoryState.repo) {
    loreFilter.pageRepo = memoryState.repo;
    loreFilter.repo = memoryState.repo;
    loreFilter.offset = 0;
  }
  let res;
  try {
    res = await api("GET", loreQueryPath());
  } catch (e) {
    res = { available: false, reason: e && e.message ? e.message : "The lore request failed." };
  }
  if (!slot.isConnected && slot.childNodes.length) return; // view was torn down mid-fetch
  clear(slot);
  slot.appendChild(
    renderLoreList(res, loreFilter.repo, { repos, refresh: () => mountLoreCard(slot, repos) }),
  );
}

/**
 * Ratify a draft from the dashboard: POST /api/memory/lore/:id/approve|reject. The
 * server calls the memory CLI (its write boundary); success re-fetches the page so
 * the row shows its new state (or disappears from a drafts-only filter). A refused
 * decision (already ratified elsewhere, unknown id) surfaces as a toast, never a
 * silent no-op.
 */
async function ratifyLore(l, action, refresh) {
  try {
    await api(
      "POST",
      `/api/memory/lore/${encodeURIComponent(l.id)}/${action}`,
      action === "reject" ? {} : undefined,
    );
    toast(
      action === "approve"
        ? `Approved "${l.title}" — active for delivery agents from the next tick.`
        : `Rejected "${l.title}".`,
      { ok: true },
    );
  } catch (e) {
    toast(e && e.message ? e.message : `Could not ${action} the draft.`, { code: e && e.code });
  }
  if (refresh) await refresh();
}

function renderDigestCard(repo, res, repos = []) {
  if (!res || res.available === false) {
    const card = el("div", { class: "card" }, [
      el("h2", {}, ["Scouting report ", el("span", { class: "count" }, "Repo Digest")]),
    ]);
    card.appendChild(memoryUnavailable(res ? res.reason : ""));
    return card;
  }
  const digest = res.digest;
  const card = el("div", { class: "card", dataset: { section: "digest" } }, [
    el("h2", {}, [
      kitShirt(repo, 26),
      " Scouting report ",
      el("span", { class: "count" }, `Repo Digest · ${repo}`),
    ]),
  ]);
  if (!digest) {
    // No digest yet — onboard this repo to populate it. The button POSTs to
    // /repos/onboard pre-targeting THIS repo, so it's a one-click action here.
    const es = emptyState(
      `No digest for ${repo} yet`,
      "Onboard this repo to scan it and build its Memory digest + feature inventory.",
      "question",
    );
    es.appendChild(
      el("div", { class: "es-actions" }, [onboardButton(repos, repo, { primary: true })]),
    );
    card.appendChild(es);
    return card;
  }
  const SECTIONS = [
    ["Overview", digest.overview],
    ["Structure", digest.structure],
    ["Conventions", digest.conventions],
    ["Stack", digest.stack],
  ];
  const grid = el(
    "div",
    { class: "digest-grid" },
    SECTIONS.map(([label, body]) =>
      el("div", { class: "digest-section" }, [
        el("div", { class: "section-title" }, label),
        el("p", { class: body ? "" : "dim" }, body || "—"),
      ]),
    ),
  );
  card.appendChild(grid);
  // Freshness line ("updated_at · source") — the load-bearing provenance.
  const meta = digest.meta || {};
  card.appendChild(
    el("div", { class: "digest-fresh dim" }, [
      icon("clock", "fresh-ico"),
      el("span", {}, `updated ${fmtTime(meta.updatedAt)}`),
      el("span", { class: "fresh-dot" }, "·"),
      el("span", {}, `source: ${meta.source || "—"}`),
    ]),
  );
  // The honesty caveat — surfaced verbatim so nobody over-trusts the summary.
  if (digest.caveat) {
    card.appendChild(el("p", { class: "digest-caveat dim" }, digest.caveat));
  }
  return card;
}

function renderFeatureLedger(repo, res) {
  const card = el("div", { class: "card", dataset: { section: "features" } }, [
    el("h2", {}, [
      "Honours board",
      res && res.available !== false
        ? el("span", { class: "count" }, String((res.features || []).length))
        : null,
    ]),
  ]);
  if (!res || res.available === false) {
    card.appendChild(memoryUnavailable(res ? res.reason : ""));
    return card;
  }
  const features = res.features || [];

  // Scope-node filter — group/filter by `scope_node`. Built from the features
  // actually present so the options reflect reality.
  const nodes = Array.from(new Set(features.map((f) => f.scopeNode).filter(Boolean))).sort();
  if (nodes.length || memoryState.node) {
    const nodeSel = el(
      "select",
      {
        "aria-label": "Filter features by scope node",
        onchange: (e) => {
          memoryState.node = e.target.value;
          writeMemoryStateToUrl();
        },
      },
      [
        el("option", { value: "" }, "All scope nodes"),
        ...nodes.map((n) => el("option", { value: n, selected: memoryState.node === n }, `@${n}`)),
      ],
    );
    card.appendChild(
      el("div", { class: "filters" }, [field("Scope node", nodeSel, { style: "flex:1" })]),
    );
  }

  if (features.length === 0) {
    card.appendChild(
      emptyState(
        `No features recorded for ${repo}${memoryState.node ? ` @${memoryState.node}` : ""}`,
        "The merge pipeline ships features into this ledger as work lands.",
        "check",
      ),
    );
    return card;
  }

  // Current (shipped) / Building / Backlog split, each grouped by scope node.
  const lanes = el("div", { class: "ledger" });
  for (const group of FEATURE_GROUPS) {
    const inGroup = features.filter((f) => f.status === group.status);
    const lane = el("div", { class: "ledger-lane", dataset: { status: group.status } }, [
      el("div", { class: "ledger-head" }, [
        el("span", { class: "ledger-label" }, group.label),
        badge(String(inGroup.length), `feat-${group.status}`),
      ]),
      el("p", { class: "dim ledger-note" }, group.note),
    ]);
    if (inGroup.length === 0) {
      lane.appendChild(el("p", { class: "dim ledger-empty" }, "Nothing here."));
    } else {
      // Group features within a lane by their scope node for a scannable read.
      const byNode = new Map();
      for (const f of inGroup) {
        const key = f.scopeNode || "";
        if (!byNode.has(key)) byNode.set(key, []);
        byNode.get(key).push(f);
      }
      for (const [node, list] of byNode) {
        if (node) lane.appendChild(el("div", { class: "ledger-node dim" }, `@${node}`));
        for (const f of list) lane.appendChild(renderFeatureCard(f));
      }
    }
    lanes.appendChild(lane);
  }
  card.appendChild(lanes);
  return card;
}

function renderFeatureCard(f) {
  return el("div", { class: "feature-card", dataset: { status: f.status } }, [
    el("div", { class: "feature-top" }, [
      el("span", { class: "feature-name" }, f.name),
      f.scopeNode ? el("span", { class: "tag-chip" }, `@${f.scopeNode}`) : null,
      f.area ? el("span", { class: "dim feature-area" }, f.area) : null,
    ]),
    f.summary ? el("p", { class: "feature-summary dim" }, f.summary) : null,
    f.provenance
      ? el("div", { class: "feature-prov dim" }, [icon("link", "prov-ico"), f.provenance])
      : null,
  ]);
}

/**
 * The Lore card: a repo / status / kind filter row, the current page of records
 * (the SERVER filters and pages — `total` is the true count), approve / reject on
 * every draft, and a pager. `repo` is the lore-card repo filter (tagged records
 * only; "All repos" shows everything, org-wide lore included).
 */
function renderLoreList(res, repo, opts = {}) {
  const lore = (res && res.lore) || [];
  const refresh = opts.refresh || null;
  const total = res && typeof res.total === "number" ? res.total : lore.length;
  const flaggedCount = lore.filter((l) => l && l.flagged).length;
  const draftCount = lore.filter((l) => l && l.status === "draft").length;
  const card = el("div", { class: "card", dataset: { section: "lore" } }, [
    el("h2", {}, [
      "Club lore",
      res && res.available !== false ? el("span", { class: "count" }, String(total)) : null,
      // Ratification queue at a glance: drafts on this page awaiting a decision.
      draftCount > 0
        ? badge(`${draftCount} draft${draftCount === 1 ? "" : "s"}`, "lore-draft")
        : null,
      // Learn-loop signal at a glance: how many conventions the loop flagged for review.
      flaggedCount > 0 ? badge(`${flaggedCount} flagged`, "lore-flagged") : null,
    ]),
    el(
      "p",
      { class: "dim section-note" },
      repo
        ? `Knowledge tagged ${repo}. Drafts wait here for ratification — approve or reject them (the CLI's \`memory review\` does the same).`
        : "The team's recorded knowledge across every repo. Drafts wait here for ratification — approve or reject them (the CLI's `memory review` does the same).",
    ),
  ]);

  // Filter row — each change re-fetches from the first page.
  const onFilter = (patch) => {
    Object.assign(loreFilter, patch, { offset: 0 });
    if (refresh) refresh();
  };
  const repoSel = el(
    "select",
    { class: "select lore-filter-repo", "aria-label": "Lore repo filter" },
    [
      el("option", { value: "", selected: !repo ? "" : undefined }, "All repos"),
      ...(opts.repos || []).map((r) =>
        el("option", { value: r.name, selected: repo === r.name ? "" : undefined }, r.name),
      ),
    ],
  );
  if (repo && !(opts.repos || []).some((r) => r.name === repo)) {
    repoSel.appendChild(el("option", { value: repo, selected: "" }, repo));
  }
  repoSel.addEventListener("change", () => onFilter({ repo: repoSel.value }));
  const statusSel = el(
    "select",
    { class: "select lore-filter-status", "aria-label": "Lore status filter" },
    [
      el("option", { value: "" }, "Any status"),
      ...LORE_STATUSES.map((s) =>
        el(
          "option",
          { value: s, selected: loreFilter.status === s ? "" : undefined },
          s === "draft" ? "draft — awaiting ratification" : s,
        ),
      ),
    ],
  );
  statusSel.addEventListener("change", () => onFilter({ status: statusSel.value }));
  const kindSel = el(
    "select",
    { class: "select lore-filter-kind", "aria-label": "Lore kind filter" },
    [
      el("option", { value: "" }, "Any kind"),
      ...LORE_KINDS.map((k) =>
        el("option", { value: k, selected: loreFilter.kind === k ? "" : undefined }, k),
      ),
    ],
  );
  kindSel.addEventListener("change", () => onFilter({ kind: kindSel.value }));
  card.appendChild(
    el("div", { class: "filters lore-filters" }, [
      field("Repo", repoSel),
      field("Status", statusSel),
      field("Kind", kindSel),
    ]),
  );

  if (!res || res.available === false) {
    card.appendChild(memoryUnavailable(res ? res.reason : ""));
    return card;
  }
  if (lore.length === 0) {
    card.appendChild(
      emptyState(
        loreFilter.status === "draft"
          ? repo
            ? `No drafts awaiting review for ${repo}`
            : "No drafts awaiting review"
          : repo
            ? `No lore tagged ${repo} yet`
            : "No lore recorded yet",
        loreFilter.status === "draft"
          ? "Agents, onboarding and the distiller file drafts here; approving one makes it active for delivery agents."
          : "Lore captures the conventions and decisions agents should respect.",
        "check",
      ),
    );
    return card;
  }
  const list = el(
    "div",
    { class: "lore-list" },
    lore.map((l) =>
      el("div", { class: "lore-row", dataset: { loreId: l.id || "", status: l.status || "" } }, [
        el("div", { class: "lore-head" }, [
          el("span", { class: "lore-title" }, l.title),
          l.status ? badge(l.status, `lore-${l.status}`) : null,
          l.kind ? el("span", { class: "dim lore-kind" }, l.kind) : null,
          l.confidence ? el("span", { class: "dim lore-conf" }, `conf=${l.confidence}`) : null,
          l.stale ? badge("stale", "lore-stale") : null,
          // Learn-loop signal: this convention was served into a ticket that then
          // reworked/blocked. Badge it so the operator can spot conventions dragging
          // delivery down and curate them via the CLI review gate.
          l.flagged ? badge("flagged", "lore-flagged") : null,
        ]),
        el("p", { class: "lore-summary dim" }, l.summary),
        el("div", { class: "lore-meta dim" }, [
          l.source ? el("span", {}, l.source) : null,
          ...(l.repos || []).map((r) => el("span", { class: "tag-chip" }, r)),
          ...(l.tags || []).map((t) => el("span", { class: "tag-chip subtle" }, t)),
          l.flagged
            ? el(
                "span",
                { class: "lore-flag-hint", title: "The learn loop flagged this record for review" },
                "⚑ served into rework/blocked — curate via `memory review`",
              )
            : null,
        ]),
        // Ratification: only a DRAFT can be approved or rejected (an active record is
        // deprecated/superseded through the CLI's lifecycle verbs, not from here).
        l.status === "draft" && l.id
          ? el("div", { class: "lore-actions" }, [
              el(
                "button",
                {
                  class: "btn primary small lore-approve",
                  type: "button",
                  onclick: () => ratifyLore(l, "approve", refresh),
                },
                [icon("check"), el("span", {}, "Approve")],
              ),
              el(
                "button",
                {
                  class: "btn small lore-reject",
                  type: "button",
                  onclick: () => ratifyLore(l, "reject", refresh),
                },
                "Reject",
              ),
            ])
          : null,
      ]),
    ),
  );
  card.appendChild(list);

  // Pager — the server pages; show where this page sits in `total`.
  const from = loreFilter.offset + 1;
  const to = loreFilter.offset + lore.length;
  if (total > lore.length || loreFilter.offset > 0) {
    const page = (delta) => {
      loreFilter.offset = Math.max(0, loreFilter.offset + delta);
      if (refresh) refresh();
    };
    card.appendChild(
      el("div", { class: "lore-pager" }, [
        el("span", { class: "dim tabnum" }, `Showing ${from}–${to} of ${total}`),
        el(
          "button",
          {
            class: "btn small lore-prev",
            type: "button",
            disabled: loreFilter.offset === 0 ? "" : undefined,
            onclick: () => page(-loreFilter.limit),
          },
          "Previous",
        ),
        el(
          "button",
          {
            class: "btn small lore-next",
            type: "button",
            disabled: to >= total ? "" : undefined,
            onclick: () => page(loreFilter.limit),
          },
          "Next",
        ),
      ]),
    );
  }
  return card;
}

// --- Wiring -----------------------------------------------------------------

/**
 * In-page jumps ("#what-i-own", "#tactics"): scroll to and focus the section
 * instead of letting the hash router read the fragment as an unknown view (which
 * re-rendered the Overview at the top, so the jump never arrived).
 */
function jumpTo(id) {
  const target = id && document.getElementById(id);
  if (!target) return false;
  // A folded section (or a row inside one) opens on the way in.
  for (let n = target; n; n = n.parentElement) if (n.tagName === "DETAILS") n.open = true;
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  target.focus?.({ preventScroll: true });
  return true;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest?.('a[href^="#"]');
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const href = a.getAttribute("href");
  if (href.startsWith("#/") || href === "#") return;
  if (jumpTo(href.slice(1))) e.preventDefault();
});

adoptTokenFromUrl(); // one-scan token pickup (QR) before the first authed call
buildChrome();
window.addEventListener("hashchange", () => {
  // A bare fragment that names a section on this page is a jump, not a route.
  const h = location.hash || "";
  if (h.length > 1 && !h.startsWith("#/") && jumpTo(h.slice(1))) return;
  router();
});
router();
