// Dispatch human control surface — plain ES-module SPA over the REST API.
// No framework, no build step. Every view calls the JSON API via fetch().
//
// Redesign: dark "mission-control" skin. The API client + auth gate are
// UNCHANGED in behaviour — only the rendering layer was rebuilt onto a new
// token-driven design system and a 5-area information architecture
// (Overview · Work · Review · Map · ⌘K), with every previous view ported.

// --- API client ------------------------------------------------------------

// Bearer token (set when the server enforces DISPATCH_API_TOKEN). Stored in
// localStorage so it survives reloads; sent on every API call. Empty = no auth.
const TOKEN_KEY = "wg_api_token";
const authToken = () => localStorage.getItem(TOKEN_KEY) || "";
const setAuthToken = (t) => localStorage.setItem(TOKEN_KEY, t);
const clearAuthToken = () => localStorage.removeItem(TOKEN_KEY);

/**
 * Call the Dispatch REST API. Resolves to the parsed JSON body on 2xx.
 * On a non-2xx response it throws an Error carrying the API error envelope
 * ({ error: { code, message } }) so callers can surface it to the user.
 * A 401 means the server requires a token — render the login gate and stop.
 */
async function api(method, path, body) {
  const headers = body !== undefined ? { "content-type": "application/json" } : {};
  const tok = authToken();
  if (tok) headers["authorization"] = "Bearer " + tok;
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    renderLogin(Boolean(tok)); // tok present + still 401 ⇒ wrong token
    const e = new Error("Authentication required");
    e.code = "UNAUTHORIZED";
    throw e;
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const err =
      data && data.error ? data.error : { code: String(res.status), message: res.statusText };
    const e = new Error(err.message || "Request failed");
    e.code = err.code;
    throw e;
  }
  return data;
}

// --- DOM helpers -----------------------------------------------------------

const app = document.getElementById("app");
const appbar = document.getElementById("appbar");
const bottomnav = document.getElementById("bottomnav");

/** Create an element with attributes + children. Strings become text nodes. */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(
      typeof child === "string" || typeof child === "number"
        ? document.createTextNode(String(child))
        : child,
    );
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
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
};
function icon(name, cls) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (cls) svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name] || "";
  return svg;
}
/** Dispatch shield mark via the inlined <symbol>. */
function shield(cls) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  if (cls) svg.setAttribute("class", cls);
  svg.setAttribute("viewBox", "0 0 256 280");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", "#wg-shield");
  svg.appendChild(use);
  return svg;
}

function badge(text, kind) {
  return el("span", { class: `badge ${kind}` }, text);
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

/** Short, human-friendly timestamp. Falls back to the raw string. */
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
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

// --- Login gate (restyled, behaviour preserved) -----------------------------

/** Render the access-token login gate into #app and hide app chrome. */
function renderLogin(wasWrong) {
  const root = document.getElementById("app");
  if (!root) return;
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
  });
  const form = el("form", { class: "login-gate" }, [
    shield("login-mark"),
    el("h1", {}, "Dispatch"),
    el("p", {}, "This factory requires an access token."),
    wasWrong ? el("p", { class: "login-error" }, "That token was rejected — try again.") : null,
    input,
    el("button", { class: "btn primary", type: "submit" }, "Enter"),
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
};
function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}
function statusBadge(status) {
  return badge(statusLabel(status), `status-${status}`);
}
function riskBadge(risk) {
  return badge(risk, `risk-${risk}`);
}
function accessBadge(access) {
  return badge(access, `access-${access}`);
}

/**
 * Pipeline-dots lifecycle indicator (cyan → amber → cyan). The lifecycle stage
 * the ticket sits in is amber ("now"); everything before it is a filled cyan
 * dot; everything after is hollow. Terminal failure paints the active dot red.
 */
const LIFECYCLE = ["draft", "ready", "in_progress", "in_review", "done"];
const STAGE_FOR_STATUS = {
  draft: 0,
  refining: 0,
  ready: 1,
  claimed: 2,
  in_progress: 2,
  blocked: 2,
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
    class: "pipeline",
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

function viewHead(title, countText, actions) {
  return el("div", { class: "view-head" }, [
    el("div", {}, [
      el("h1", {}, [title, countText ? el("span", { class: "count" }, countText) : null]),
    ]),
    actions ? el("div", { class: "view-head-actions" }, [].concat(actions)) : null,
  ]);
}

function sectionTitle(text, trailing) {
  return el("div", { class: "section-title" }, [text, trailing || null]);
}

function emptyState(title, sub, iconName = "check") {
  return el("div", { class: "empty-state" }, [
    el("div", { class: "es-icon" }, icon(iconName)),
    el("div", { class: "es-title" }, title),
    sub ? el("div", { class: "es-sub" }, sub) : null,
  ]);
}

/** Generic loading skeleton for a view. */
function skeleton(kind = "list") {
  const wrap = el("div", { class: "skeleton-view", "aria-busy": "true" });
  wrap.appendChild(el("div", { class: "skeleton sk-bar", style: "width:40%" }));
  if (kind === "overview") {
    wrap.appendChild(el("div", { class: "skeleton sk-card" }));
    const bento = el("div", { class: "bento" });
    for (let i = 0; i < 4; i++) bento.appendChild(el("div", { class: "skeleton sk-card" }));
    wrap.appendChild(bento);
  }
  if (kind === "board") {
    const board = el("div", { class: "board" });
    for (let c = 0; c < 4; c++) {
      const col = el("div", { class: "skeleton", style: "height:260px;border-radius:14px" });
      board.appendChild(col);
    }
    wrap.appendChild(board);
  }
  for (let i = 0; i < (kind === "board" ? 0 : 5); i++) {
    wrap.appendChild(el("div", { class: "skeleton sk-row" }));
  }
  return wrap;
}

// --- Detail sheet (mobile bottom-sheet / desktop side-panel) ----------------

let sheetEls = null;
function ensureSheet() {
  if (sheetEls) return sheetEls;
  const scrim = el("div", { class: "sheet-scrim", onclick: closeSheet });
  const head = el("div", { class: "sheet-head" });
  const body = el("div", { class: "sheet-body" });
  const sheet = el("div", { class: "sheet", role: "dialog", "aria-modal": "true" }, [
    el("div", { class: "sheet-grip" }),
    head,
    body,
  ]);
  sheet.addEventListener("click", (e) => e.stopPropagation());
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  sheetEls = { scrim, sheet, head, body };
  return sheetEls;
}
function openSheet(title, contentNode) {
  const { scrim, sheet, head, body } = ensureSheet();
  clear(head);
  clear(body);
  head.appendChild(el("h2", {}, title));
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
}
function closeSheet() {
  if (!sheetEls) return;
  sheetEls.scrim.classList.remove("open");
  sheetEls.sheet.classList.remove("open");
  document.removeEventListener("keydown", sheetKeydown);
}
function sheetKeydown(e) {
  if (e.key === "Escape") closeSheet();
}

// --- Routing & IA -----------------------------------------------------------
//
// 8 tabs folded to 5 areas. Legacy hashes are aliased so deep links and the
// previous IA keep working: every prior view is still reachable.

const VIEWS = {
  overview: renderOverview,
  work: renderWork,
  review: renderReview,
  factory: renderFactory,
  memory: renderMemory,
  epics: renderEpics,
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

// Primary nav entries (order = bottom-nav + desktop rail order).
const NAV = [
  { id: "overview", label: "Overview", icon: "overview" },
  { id: "work", label: "Work", icon: "work" },
  { id: "review", label: "Review", icon: "review" },
  { id: "epics", label: "Epics", icon: "epics" },
  { id: "factory", label: "Map", icon: "map" },
  { id: "memory", label: "Memory", icon: "memory" },
  { id: "settings", label: "Settings", icon: "settings" },
];

// Sub-views highlight their parent area in the nav.
const AREA_FOR_VIEW = {
  ticket: "work",
  node: "factory",
  repo: "factory",
  create: "work",
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
  location.hash = hash;
}

let activeArea = "overview";
async function router() {
  const { view, param } = parseHash();
  // Unknown views fall through to Overview; aliases are resolved in parseHash.
  const render = VIEWS[view] || renderOverview;
  activeArea = AREA_FOR_VIEW[view] || (VIEWS[view] ? view : "overview");
  app.dataset.area = activeArea; // lets CSS give width-hungry views (work/map/epics) the full screen
  syncNav();
  app.classList.remove("login-shell");
  clear(app);
  app.appendChild(skeleton(view === "overview" ? "overview" : view === "work" ? "board" : "list"));
  await guard(async () => {
    const content = await render(param);
    clear(app);
    app.appendChild(content);
    app.scrollTop = 0;
  });
}

// --- App chrome (app bar + bottom nav) --------------------------------------

function buildChrome() {
  // App bar.
  clear(appbar);
  const brand = el("a", { class: "brand", href: "#/overview", "aria-label": "Gaffer — Overview" }, [
    el("img", { class: "brand-icon", src: "/gaffer-icon.svg", alt: "" }),
    el("span", { class: "brand-name" }, "Gaffer"),
  ]);
  const rail = el(
    "nav",
    { class: "nav-rail", "aria-label": "Primary views" },
    NAV.map((n) =>
      el(
        "button",
        {
          class: "nav-link",
          type: "button",
          dataset: { area: n.id },
          onclick: () => navigate(`#/${n.id}`),
        },
        [icon(n.icon, "nav-ico"), n.label],
      ),
    ),
  );

  const cmdk = el(
    "button",
    {
      class: "cmdk-trigger",
      type: "button",
      "aria-label": "Open command palette",
      onclick: () => openPalette(),
    },
    [
      icon("search"),
      el("span", { class: "cmdk-label" }, "Jump to…"),
      el("span", { class: "kbd" }, "⌘K"),
    ],
  );

  const newBtn = el(
    "button",
    {
      class: "btn primary small",
      type: "button",
      onclick: () => navigate("#/create"),
    },
    [icon("plus"), el("span", { class: "cmdk-label" }, "New")],
  );

  appbar.append(brand, rail, el("div", { class: "appbar-spacer" }), cmdk, newBtn);
  // Logout affordance — only when authenticating with a token.
  if (authToken()) {
    appbar.appendChild(
      el("button", { class: "logout-btn", type: "button", onclick: logout }, "Logout"),
    );
  }
  appbar.hidden = false;

  // Bottom nav (mobile): Overview · Work · Review · Map · +.
  clear(bottomnav);
  for (const n of NAV) {
    bottomnav.appendChild(
      el(
        "button",
        {
          class: "bottomnav-item",
          type: "button",
          dataset: { area: n.id },
          onclick: () => navigate(`#/${n.id}`),
        },
        [icon(n.icon), el("span", {}, n.label)],
      ),
    );
  }
  bottomnav.appendChild(
    el(
      "button",
      {
        class: "bottomnav-item is-fab",
        type: "button",
        "aria-label": "New ticket",
        onclick: () => navigate("#/create"),
      },
      [el("span", { class: "fab-disc" }, icon("plus")), el("span", {}, "New")],
    ),
  );
  bottomnav.hidden = false;
}

function syncNav() {
  document.querySelectorAll("[data-area]").forEach((n) => {
    n.classList.toggle("active", n.dataset.area === activeArea);
  });
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
      label: "Factory Map",
      hint: "scope graph",
      icon: "map",
      run: () => navigate("#/factory"),
    },
    {
      group: "Create",
      label: "New ticket",
      hint: "create",
      icon: "plus",
      run: () => navigate("#/create"),
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
      label: "New scope node",
      hint: "map",
      icon: "map",
      run: () => navigate("#/node"),
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

async function renderOverview() {
  const [{ summary }, activity, decisionsRes] = await Promise.all([
    api("GET", "/api/dashboard"),
    api("GET", "/api/activity?limit=40"),
    api("GET", "/decisions").catch(() => ({ decisions: [] })),
  ]);
  // Audit is optional and best-effort.
  let audit = null;
  try {
    audit = await api("GET", "/api/audit?limit=30");
  } catch {
    /* optional */
  }

  const byStatus = summary.ticketsByStatus || {};
  const totalTickets = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const inReview = byStatus.in_review || 0;
  const blocked = summary.blocked ?? byStatus.blocked ?? 0;
  const openDecisions = summary.openDecisions ?? (decisionsRes.decisions || []).length;
  const staleClaims = summary.staleClaims || 0;

  const wrap = el("div", { class: "view" });
  wrap.appendChild(viewHead("Overview", "live control room"));

  // --- Mission-control stat band (leads the view) ---------------------------
  // The lead band gives the operator the state of the factory at a glance,
  // before any list. Done leads (featured, wider span); the rest are equal.
  wrap.appendChild(
    sectionTitle("Throughput", el("span", { class: "count-pill tabnum" }, `${totalTickets} total`)),
  );
  wrap.appendChild(
    el("div", { class: "bento" }, [
      statCard("Done", byStatus.done || 0, {
        tone: "ok",
        sub: "shipped",
        href: "#/work?status=done",
        featured: true,
        span: 2,
        trend: summary.deliveredToday
          ? { dir: "up", text: `+${summary.deliveredToday} today` }
          : null,
      }),
      statCard("Ready", byStatus.ready || 0, {
        tone: "accent",
        sub: "claimable now",
        href: "#/work?status=ready",
      }),
      statCard("Active claims", summary.activeClaims || 0, {
        tone: "accent",
        sub: "agents working",
        href: "#/work",
      }),
    ]),
  );
  wrap.appendChild(
    el("div", { class: "bento" }, [
      statCard("In review", inReview, {
        tone: inReview ? "warn" : "",
        sub: "awaiting sign-off",
        href: "#/review",
      }),
      statCard("Blocked", blocked, {
        tone: blocked ? "danger" : "",
        sub: "need attention",
        href: "#/work?status=blocked",
      }),
      statCard("Open decisions", openDecisions, {
        tone: openDecisions ? "warn" : "",
        sub: "awaiting a human",
        href: "#/overview",
        scrollTo: "decisions",
      }),
      statCard("Stale claims", staleClaims, {
        tone: staleClaims ? "danger" : "",
        sub: "leases past expiry",
        href: "#/work",
      }),
    ]),
  );

  // --- "Needs you now" focal block ------------------------------------------
  const needs = [];
  if (inReview > 0)
    needs.push({
      tone: "review",
      icon: "review",
      count: inReview,
      title: "Awaiting your review",
      sub: "approve, reject or merge",
      href: "#/review",
    });
  if (blocked > 0)
    needs.push({
      tone: "blocked",
      icon: "alert",
      count: blocked,
      title: "Blocked tickets",
      sub: "need a human to clear the path",
      href: "#/work?status=blocked",
    });
  if (openDecisions > 0)
    needs.push({
      tone: "decision",
      icon: "question",
      count: openDecisions,
      title: "Open decisions",
      sub: "a question is waiting on you",
      href: "#/overview",
      scrollTo: "decisions",
    });
  if (staleClaims > 0)
    needs.push({
      tone: "stale",
      icon: "clock",
      count: staleClaims,
      title: "Stale claims",
      sub: "leases past expiry",
      href: "#/work",
    });

  const heroCard = el(
    "div",
    { class: needs.length ? "card card-amber needs-hero" : "card card-accent needs-hero" },
    [
      el("h2", {}, [
        el("span", { class: "needs-dot" + (needs.length ? "" : " clear") }),
        "Needs you now",
        needs.length ? el("span", { class: "count" }, String(needs.length)) : null,
      ]),
    ],
  );
  if (needs.length) {
    heroCard.appendChild(
      el(
        "ul",
        { class: "needs-list" },
        needs.map((n) =>
          el(
            "a",
            {
              class: `needs-item tone-${n.tone}`,
              href: n.href,
              onclick: n.scrollTo
                ? (e) => {
                    const t = document.getElementById(n.scrollTo);
                    if (t) {
                      e.preventDefault();
                      t.scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                  }
                : undefined,
            },
            [
              el("span", { class: "ni-icon" }, icon(n.icon)),
              el("span", { class: "ni-body" }, [
                el("span", { class: "ni-title" }, n.title),
                el("span", { class: "ni-sub" }, n.sub),
              ]),
              el("span", { class: "ni-count tabnum" }, String(n.count)),
              el("span", { class: "ni-go" }, icon("chevron")),
            ],
          ),
        ),
      ),
    );
  } else {
    heroCard.appendChild(
      el("div", { class: "needs-empty" }, [
        icon("check"),
        "All clear — nothing is waiting on a human right now.",
      ]),
    );
  }
  wrap.appendChild(heroCard);

  // --- Open decisions (inline act) — folds the old Decisions tab in here ----
  // Many open decisions used to balloon the page; cap the visible stack and put
  // the rest in a scroll well so the queue stays scannable without losing any.
  const decisions = decisionsRes.decisions || [];
  if (decisions.length) {
    const many = decisions.length > 4;
    const decCard = el(
      "div",
      {
        class: "card" + (many ? " decisions-card has-overflow" : " decisions-card"),
        id: "decisions",
      },
      [
        el("h2", {}, [
          "Decisions awaiting you",
          el("span", { class: "count" }, String(decisions.length)),
        ]),
      ],
    );
    const well = el("div", { class: "decisions-well" });
    decisions.forEach((d) => well.appendChild(renderDecisionCard(d)));
    decCard.appendChild(well);
    wrap.appendChild(decCard);
  }

  // --- Per-repo pressure row ------------------------------------------------
  const pressureCard = el("div", { class: "card" }, [el("h2", {}, "Pressure by repo")]);
  pressureCard.appendChild(renderRepoPressure(summary));
  wrap.appendChild(pressureCard);

  // --- Live activity stream -------------------------------------------------
  const events = activity.events || [];
  wrap.appendChild(
    el("div", { class: "card" }, [
      el("h2", {}, `Live activity (${activity.total ?? events.length})`),
      events.length
        ? el("ul", { class: "feed" }, events.map(renderFeedRow))
        : el("p", { class: "dim" }, "No activity recorded yet."),
    ]),
  );

  // --- Stuck tickets (held a non-terminal state beyond threshold) ----------
  const stuck = summary.stuckTickets || [];
  if (stuck.length || summary.stuckThresholdHours != null) {
    wrap.appendChild(
      el("div", { class: "card" }, [
        el("h2", {}, `Stuck tickets (${stuck.length})`),
        el(
          "p",
          { class: "section-note dim" },
          `Flagged after ${summary.stuckThresholdHours ?? 24}h in one non-terminal state.`,
        ),
        stuck.length
          ? el(
              "ul",
              { class: "feed" },
              stuck.map((s) =>
                el("li", { class: "feed-row" }, [
                  el(
                    "a",
                    { class: "feed-ticket", href: `#/ticket/${s.id}`, title: s.title || "" },
                    s.number != null ? `#${s.number}` : s.id.slice(0, 8),
                  ),
                  statusBadge(s.status),
                  el("span", { class: "feed-actor", style: "margin-left:0" }, s.title),
                  el(
                    "span",
                    { class: "dim tabnum", title: `since ${fmtTime(s.since)}` },
                    `stuck ${fmtDuration(s.stuckForMs)}`,
                  ),
                ]),
              ),
            )
          : el(
              "p",
              { class: "dim" },
              "Nothing stuck — every active ticket is within the threshold.",
            ),
      ]),
    );
  }

  // --- Median cycle time per state (analytics, kept) -----------------------
  const cycle = summary.cycleTimeByState || [];
  if (cycle.length) {
    wrap.appendChild(
      el("div", { class: "card" }, [
        el("h2", {}, "Median cycle time per state"),
        el(
          "div",
          { class: "status-strip" },
          cycle.map((c) =>
            el("div", { class: "status-chip" }, [
              statusBadge(c.status),
              el(
                "span",
                {
                  class: "status-chip-count tabnum",
                  title: `${c.samples} sample${c.samples === 1 ? "" : "s"}`,
                },
                fmtDuration(c.medianMs),
              ),
            ]),
          ),
        ),
      ]),
    );
  }

  // --- Optional tool-audit panel -------------------------------------------
  if (audit && audit.available && (audit.entries || []).length) {
    wrap.appendChild(renderAuditPanel(audit.entries));
  }

  return wrap;
}

/** A clickable bento stat card with a big tabular numeral. */
function statCard(
  label,
  value,
  { tone = "", sub, href, featured = false, span, trend, scrollTo } = {},
) {
  const subNode =
    sub || trend
      ? el("div", { class: "stat-sub" }, [
          sub || null,
          trend ? el("span", { class: `stat-trend ${trend.dir || "flat"}` }, trend.text) : null,
        ])
      : null;
  const children = [
    el("div", { class: "stat-label" }, label),
    el("div", { class: "stat-value tabnum" }, String(value)),
    subNode,
  ];
  let cls = "stat-card";
  if (tone) cls += ` tone-${tone}`;
  if (featured) cls += " featured";
  if (span === 2) cls += " span-2";
  const attrs = { class: cls };
  if (scrollTo) {
    attrs.href = href || "#/overview";
    attrs.onclick = (e) => {
      const t = document.getElementById(scrollTo);
      if (t) {
        e.preventDefault();
        t.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    return el("a", attrs, children);
  }
  if (href) {
    attrs.href = href;
    return el("a", attrs, children);
  }
  return el("div", attrs, children);
}

/** Per-repo pressure: amber=active, cyan=ready, blue=review, red=blocked. */
function renderRepoPressure(summary) {
  const repos = summary.pressureByRepo || summary.repoPressure || summary.byRepo || null;
  if (Array.isArray(repos) && repos.length) {
    return el(
      "div",
      { class: "pressure-row" },
      repos.slice(0, 8).map((r) => {
        const active = r.active ?? r.in_progress ?? 0;
        const ready = r.ready ?? 0;
        const review = r.in_review ?? r.review ?? 0;
        const blocked = r.blocked ?? 0;
        const total = Math.max(1, active + ready + review + blocked);
        const seg = (n, cls) =>
          n > 0
            ? el("span", { class: `pressure-seg ${cls}`, style: `width:${(n / total) * 100}%` })
            : null;
        return el("div", { class: "pressure-item" }, [
          el("span", { class: "pressure-name", title: r.name || r.repo }, r.name || r.repo || "—"),
          el("span", { class: "pressure-bar" }, [
            seg(active, "s-active"),
            seg(review, "s-review"),
            seg(ready, "s-ready"),
            seg(blocked, "s-blocked"),
          ]),
          el("span", { class: "pressure-count tabnum" }, `${active + ready + review + blocked}`),
        ]);
      }),
    );
  }
  // No per-repo data shape from this endpoint — synthesise a global pressure bar
  // from the status breakdown so the panel still reads as a control instrument.
  const bs = summary.ticketsByStatus || {};
  const active = (bs.in_progress || 0) + (bs.claimed || 0);
  const ready = bs.ready || 0;
  const review = bs.in_review || 0;
  const blocked = bs.blocked || 0;
  const done = bs.done || 0;
  const total = Math.max(1, active + ready + review + blocked + done);
  const seg = (n, cls) =>
    n > 0
      ? el("span", { class: `pressure-seg ${cls}`, style: `width:${(n / total) * 100}%` })
      : null;
  return el("div", { class: "pressure-row" }, [
    el("div", { class: "pressure-item" }, [
      el("span", { class: "pressure-name" }, "All repos"),
      el("span", { class: "pressure-bar" }, [
        seg(active, "s-active"),
        seg(review, "s-review"),
        seg(ready, "s-ready"),
        seg(blocked, "s-blocked"),
        seg(done, "s-done"),
      ]),
      el(
        "span",
        { class: "pressure-count tabnum" },
        String(active + ready + review + blocked + done),
      ),
    ]),
    el(
      "p",
      { class: "dim", style: "font-size:var(--step--1)" },
      "Amber active · cyan ready · blue review · red blocked · green done.",
    ),
  ]);
}

/** One reverse-chronological activity row: time · ticket · event · actor. */
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
    el("span", { class: `feed-event ev-${ev.event_type.split(".")[0]}` }, ev.event_type),
    el(
      "span",
      { class: "feed-actor dim" },
      `${ev.actor_type}${ev.actor_id ? ` · ${ev.actor_id}` : ""}`,
    ),
  ]);
}

/** Collapsed, redacted tool-audit tail. Content is already redacted server-side. */
function renderAuditPanel(entries) {
  const details = el("details", { class: "audit-panel" });
  details.appendChild(el("summary", {}, `Tool audit · last ${entries.length} (redacted)`));
  details.appendChild(
    el(
      "ul",
      { class: "feed audit-feed" },
      entries.map((e) =>
        el("li", { class: "feed-row" }, [
          el("time", { class: "feed-time tabnum", datetime: e.ts || "" }, fmtTime(e.ts)),
          el("span", { class: "feed-event" }, e.tool || "—"),
          el(
            "span",
            { class: "feed-actor dim" },
            `${e.actor?.type || "?"}${e.actor?.id ? ` · ${e.actor.id}` : ""}`,
          ),
          e.error ? badge("error", "status-failed") : null,
          e.blocked ? badge("blocked", "status-blocked") : null,
          e.resultCount != null
            ? el(
                "span",
                { class: "dim tabnum" },
                `${e.resultCount} result${e.resultCount === 1 ? "" : "s"}`,
              )
            : null,
        ]),
      ),
    ),
  );
  return el("div", { class: "card" }, details);
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
            toast("No ready work to deliver — ready a ticket first.", {});
            return;
          }
          toast("Factory tick fired — refreshing the board…", { ok: true });
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

  const repoBlock = el("div", { class: "where-block" }, [
    el("div", { class: "field" }, [el("label", {}, "Repository"), repoSel]),
  ]);
  const nodeBlock = el("div", { class: "where-block" }, [
    el("div", { class: "field" }, [el("label", {}, "Scope node"), nodeSel]),
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
        runAsyncAction(runBtn, "Suggesting work…", async () => {
          const res = await api("POST", "/product-owner/runs", body);
          const t = res.target || {};
          const msg =
            t.level === "node"
              ? `Node run started for '${t.scope_node_name || ""}' — ${res.ran ?? 0} repo${res.ran === 1 ? "" : "s"}${res.truncated ? " (truncated)" : ""}.`
              : `Repo run started for '${t.repo || repoSel.value}'.`;
          toast(msg, { ok: true });
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

async function renderWork() {
  readWorkStateFromUrl();

  // Board endpoint powers the board; the filtered /tickets list powers list mode.
  // Repos + scope nodes feed the "Suggest work" target picker (Feature B).
  const [board, reposRes, nodesRes] = await Promise.all([
    api("GET", "/api/board"),
    api("GET", "/repositories"),
    api("GET", "/scope/nodes"),
  ]);
  const repos = reposRes.repositories || [];
  const nodes = nodesRes.nodes || [];
  const columns = board.columns || [];
  const closed = board.closed || [];
  const wontDo = board.wontDo || [];
  const live = columns.reduce((n, c) => n + (c.cards || []).length, 0);

  const wrap = el("div", { class: "view" });

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
      [icon("work"), "Board"],
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
      [icon("overview"), "List"],
    ),
  ]);

  wrap.appendChild(
    viewHead("Work", `${live} live · ${wontDo.length} won't do · ${closed.length} closed`, [
      modeToggle,
      pollWorkButton(),
      suggestWorkButton(repos, nodes),
    ]),
  );
  wrap.appendChild(renderWorkFilters(repos));

  if (workState.mode === "list") {
    wrap.appendChild(await renderWorkList());
  } else {
    wrap.appendChild(renderBoard(columns, closed, wontDo));
  }

  // Active claims — folded in as a collapsible panel (replaces the Claims tab).
  wrap.appendChild(await renderClaimsPanel());

  return wrap;
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
    el("div", { class: "field" }, [el("label", {}, "Status"), statusSel]),
    el("div", { class: "field" }, [el("label", {}, "Repo"), repoSel]),
    el("div", { class: "field" }, [el("label", {}, "Risk"), riskSel]),
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
  blocked: ["wont_do"],
  // Review surface: approve takes the ticket to `ready_for_merge` (merging).
  in_review: ["approve", "rework", "wont_do"],
  // BBT-001: independent testing lane. The tester agent owns the verdict
  // (pass → ready_for_merge, fail → refining); a human has no board button here,
  // mirroring the live/claimed states.
  in_testing: [],
  // Approved-and-merging: the merge runner is working. A human can mark it merged
  // (admin override) or send it back for rework — but NOT "mark ready".
  ready_for_merge: ["mark_merged", "rework"],
  // Terminal: reopen only where allowed (cancelled is reopenable; done is not).
  done: [],
  failed: [],
  cancelled: ["reopen"],
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

/** Board (kanban) — columns by status; filters dim non-matching cards client-side. */
function renderBoard(columns, closed, wontDo = []) {
  const wrap = el("div");
  const matches = (card) =>
    (!workState.status || card.status === workState.status) &&
    (!workState.risk || card.risk_level === workState.risk);

  const cols = el(
    "div",
    { class: "board" },
    columns.map((c) => {
      const cards = (c.cards || []).filter(matches);
      const body = el(
        "div",
        { class: "board-col-body" },
        cards.length
          ? cards.map(renderBoardCard)
          : el("div", { class: "board-empty" }, [
              el("span", { class: "board-empty-dot" }),
              el("span", {}, "Empty"),
            ]),
      );
      const section = el(
        "section",
        {
          class: `board-col col-${c.column}`,
          dataset: { column: c.column },
          "aria-label": BOARD_COLUMN_LABELS[c.column] || c.column,
        },
        [
          el("div", { class: "board-col-head" }, [
            el("span", { class: "board-col-title" }, BOARD_COLUMN_LABELS[c.column] || c.column),
            el("span", { class: "board-col-count tabnum" }, String(cards.length)),
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
  // (-> refining) so an abandoned ticket is reversible.
  const wontDoVisible = wontDo.filter(matches);
  if (wontDoVisible.length) {
    const details = el("details", { class: "closed-area wont-do-area", open: "" });
    details.appendChild(el("summary", {}, `Won't do (${wontDoVisible.length})`));
    details.appendChild(el("div", { class: "closed-cards" }, wontDoVisible.map(renderWontDoCard)));
    wrap.appendChild(details);
  }

  if (closed.length) {
    const details = el("details", { class: "closed-area" });
    details.appendChild(el("summary", {}, `Closed · failed (${closed.length})`));
    details.appendChild(el("div", { class: "closed-cards" }, closed.map(renderBoardCard)));
    wrap.appendChild(details);
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

  const meta = el("div", { class: "card-meta" }, [
    acText ? el("span", { class: "ac-progress" }, acText) : el("span", { class: "dim" }, "no AC"),
    card.claim
      ? el(
          "span",
          {
            class: `card-claim${card.claim.stale ? " stale" : ""}`,
            title: card.claim.stale ? "Lease past expiry" : "Lease active",
          },
          [
            el("span", { class: "claim-dot" }),
            card.claim.agentDisplayName || card.claim.agentId.slice(0, 8),
            card.claim.stale ? " · stale" : "",
          ],
        )
      : pipelineDots(card.status),
  ]);

  const go = () => navigate(`#/ticket/${card.id}`);
  const movable = cardIsMovable(card);

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

  // WG-049: a ticket bounced back from review carries the reviewer's reason, so a
  // human triaging the board sees WHY it's in rework without opening the ticket.
  const reject = card.lastReviewFeedback
    ? el(
        "div",
        {
          class: "card-reject",
          title: `Rejected by ${card.lastReviewFeedback.reviewer || "reviewer"}`,
        },
        [
          el("span", { class: "card-reject-label" }, "Rejected:"),
          " ",
          card.lastReviewFeedback.reason,
        ],
      )
    : null;

  const node = el(
    "a",
    {
      class: `board-card${movable ? " is-movable" : ""}`,
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
        pipelineDots(card.status),
      ]),
      el("div", { class: "card-title" }, card.title),
      chips,
      reject,
      meta,
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
    return emptyState(
      "No tickets match",
      "Adjust the filters above, or suggest fresh work.",
      "work",
    );
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
  const details = el("details", { class: "card" });
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

async function renderTicket(id) {
  if (!id) return renderWork();
  const view = await api("GET", `/tickets/${id}`);
  const t = view.ticket;
  const acList = view.acceptance_criteria || [];
  const blockers = view.blocking_decisions || [];
  const events = view.events || [];

  const wrap = el("div", { class: "view" });
  wrap.appendChild(
    el(
      "button",
      { class: "back-link", type: "button", onclick: () => navigate("#/work") },
      "← Back to Work",
    ),
  );

  const policyBox = el("div");

  // The action bar is driven OFF the single TICKET_ACTION_KEYS map (same map the
  // review surface uses), so "Mark ready" can never resurface where it shouldn't
  // (in_review / ready_for_merge / done). Each key maps to its concrete button.
  const actionButtons = {
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

  const head = el("div", { class: "card card-accent" }, [
    el("div", { class: "num" }, t.number != null ? `#${t.number}` : t.id),
    el("h1", { class: "detail-title" }, t.title),
    el("div", { class: "meta-row" }, [
      statusBadge(t.status),
      riskBadge(t.risk_level),
      badge(t.policy_pack, "no-dot"),
      badge(`priority ${t.priority}`, "no-dot"),
    ]),
    el("div", { style: "margin:10px 0 14px" }, pipelineDots(t.status)),
    t.description
      ? el("p", { class: "desc" }, t.description)
      : el("p", { class: "desc dim" }, "No description."),
    headActions.length
      ? el("div", { class: "btn-row", style: "margin-top:16px" }, headActions)
      : null,
    policyBox,
  ]);

  const claimBox = el("div", { class: "claim-box" });
  loadClaimability(t.id, claimBox);
  head.appendChild(claimBox);

  const acCard = el("div", { class: "card" }, [
    el("h2", {}, `Acceptance criteria (${acList.length})`),
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
                      ac.verification_method
                        ? `verify: ${ac.verification_method}`
                        : "no verification method",
                      ac.evidence_required ? " · evidence required" : "",
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
      el("dd", {}, String(t.attempt_count)),
      el("dt", {}, "Source"),
      el("dd", {}, t.source || "—"),
      el("dt", {}, "Created"),
      el("dd", {}, fmtTime(t.created_at)),
      el("dt", {}, "Updated"),
      el("dd", {}, fmtTime(t.updated_at)),
    ]),
  ]);

  const timeline = el("div", { class: "card" }, [
    el("h2", {}, `Event timeline (${events.length})`),
    events.length
      ? el(
          "ul",
          { class: "timeline" },
          events.map((ev) =>
            el("li", {}, [
              el("div", { class: "ev-type" }, ev.event_type),
              el("div", { class: "ev-time" }, fmtTime(ev.created_at)),
              el(
                "div",
                { class: "ev-actor" },
                `${ev.actor_type}${ev.actor_id ? ` · ${ev.actor_id}` : ""}`,
              ),
              ev.payload_json && ev.payload_json !== "{}"
                ? el("div", { class: "ev-payload" }, ev.payload_json)
                : null,
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

  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("div", {}, [head, sideRepos, diffCard, acCard, testingCard, timeline]),
      el("div", {}, [sideFields, sideBlockers]),
    ]),
  );
  return wrap;
}

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

  // The tester's verdict evidence: test_output rows recorded during the testing lane.
  const testerEvidence = (evidence || []).filter((e) => e.evidence_type === "test_output");
  const evidenceList = testerEvidence.length
    ? el(
        "ul",
        { class: "clean" },
        testerEvidence.map((e) =>
          el("li", {}, [
            el("div", {}, e.summary),
            el("div", { class: "ac-meta" }, `${e.created_by} · ${fmtTime(e.created_at)}`),
          ]),
        ),
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
        if (evidence.checked) body.evidence_required = true;
        guard(async () => {
          await api("POST", `/tickets/${ticketId}/acceptance-criteria`, body);
          toast("Acceptance criterion added", { ok: true });
          router();
        });
      },
    },
    [
      el("div", { class: "field" }, [el("label", {}, "Criterion"), text]),
      el("div", { class: "field" }, [el("label", {}, "Verification"), verify]),
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
            el("span", { class: "assoc-name plain" }, r.name || r.id),
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
      el("div", { class: "field" }, [el("label", {}, "Repo"), repoSel]),
      el("div", { class: "field" }, [el("label", {}, "Access"), access]),
      el("button", { class: "btn", type: "submit" }, "Add repo"),
    ],
  );
}

function loadClaimability(ticketId, box) {
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
          blockers.map((b) =>
            el("li", {}, typeof b === "string" ? b : b.message || b.reason || JSON.stringify(b)),
          ),
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
    id: "idle-loops",
    label: "Idle loops",
    note: "Background loops that run between real work, and how far they go.",
  },
  { id: "budget", label: "Budget & caps", note: "Hard limits on a run — ticks, timeouts, turns." },
  {
    id: "planning-debate",
    label: "Planning debate",
    note: "Multi-model plan critique before decomposing.",
  },
];

async function renderSettings() {
  const { settings } = await api("GET", "/api/settings");
  const all = Array.isArray(settings) ? settings : [];

  const wrap = el("div", { class: "view settings-view" });
  wrap.appendChild(viewHead("Settings", all.length ? `${all.length}` : null));

  // Standing note: edits land in settings.json; the runner reads it on its NEXT
  // tick, so nothing restarts live.
  wrap.appendChild(
    el("div", { class: "settings-note" }, [
      icon("clock", "settings-note-ico"),
      el("span", {}, "Changes apply on the next tick — no live restart."),
    ]),
  );

  // Empty/abnormal state: the allow-list is static server-side, so an empty list
  // means the API answered oddly. Surface it rather than render a blank page.
  if (all.length === 0) {
    wrap.appendChild(
      emptyState("No settings available", "The config API returned no known settings.", "alert"),
    );
    return wrap;
  }

  // edit registry: key → { def, read() } for non-locked inputs, so Save collects
  // only the values the operator can actually change.
  const editors = new Map();

  const form = el("form", { class: "settings-form" });

  for (const grp of SETTINGS_GROUPS) {
    const inGroup = all.filter((s) => s.group === grp.id);
    if (inGroup.length === 0) continue;
    const card = el("div", { class: "card settings-group" });
    card.appendChild(el("h2", {}, grp.label));
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
  form.appendChild(el("div", { class: "btn-row settings-actions" }, [saveBtn]));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    // Collect only editable (non-locked) values. The server is the final gate:
    // it re-checks env-lock and drops unknown keys, so this is just the payload.
    const payload = {};
    for (const [key, ed] of editors) payload[key] = ed.read();
    runAsyncAction(saveBtn, "Saving…", async () => {
      const res = await api("POST", "/api/settings", { settings: payload });
      const written = (res.written || []).length;
      const rejected = (res.rejected || []).length;
      toast(
        rejected
          ? `Saved ${written} setting${written === 1 ? "" : "s"} — ${rejected} skipped (set by env).`
          : `Saved ${written} setting${written === 1 ? "" : "s"}.`,
        { ok: true },
      );
      // Re-render from the server's fresh state so values + locks reflect reality.
      router();
    });
  });

  wrap.appendChild(form);
  return wrap;
}

/**
 * One setting row: a label + help on the left, a control on the right. Locked
 * settings render their value read-only with a "set by env" badge; editable ones
 * get a toggle (boolean), number input (int) or text input (csv/string), and
 * register a reader into `editors` so Save can collect the value.
 */
function renderSettingRow(s, editors) {
  const meta = el("div", { class: "setting-meta" }, [
    el("div", { class: "setting-label" }, [
      el("span", {}, s.label || s.key),
      s.envLocked
        ? el("span", { class: "badge env-locked no-dot" }, [icon("lock", "lock-ico"), "set by env"])
        : null,
    ]),
    el("code", { class: "mono setting-key" }, s.key),
    s.help ? el("p", { class: "setting-help dim" }, s.help) : null,
  ]);

  const control = el("div", { class: "setting-control" }, renderSettingInput(s, editors));

  return el("div", { class: `setting-row${s.envLocked ? " is-locked" : ""}` }, [meta, control]);
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
    const checked = s.value === "1";
    const input = el("input", { type: "checkbox", role: "switch", "aria-label": s.label });
    input.checked = checked;
    editors.set(s.key, { read: () => (input.checked ? "1" : "0") });
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
    editors.set(s.key, { read: () => input.value.trim() });
    return input;
  }

  // csv / string → a plain text input.
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

async function renderCreate() {
  const [nodesRes, reposRes] = await Promise.all([
    api("GET", "/scope/nodes"),
    api("GET", "/repositories"),
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
      el("div", { class: "field" }, [el("label", {}, "Title"), title]),
      el("div", { class: "field" }, [el("label", {}, "Description"), desc]),
      el("div", { class: "form-grid cols-2" }, [
        el("div", { class: "field" }, [el("label", {}, "Policy pack"), policy]),
        el("div", { class: "field" }, [el("label", {}, "Risk level"), risk]),
      ]),
      selector.node,
      validationMsg,
      el("div", { class: "btn-row" }, [
        el("button", { class: "btn primary", type: "submit" }, "Create ticket"),
      ]),
    ],
  );

  const wrap = el("div", { class: "view" });
  wrap.appendChild(
    el(
      "button",
      { class: "back-link", type: "button", onclick: () => navigate("#/work") },
      "← Back to Work",
    ),
  );
  wrap.appendChild(viewHead("New ticket"));
  wrap.appendChild(el("div", { class: "card" }, form));
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
      scopeList.appendChild(el("span", { class: "dim" }, "No scope linked — optional."));
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
    if (!attached.size)
      repoList.appendChild(
        el(
          "p",
          { class: "dim" },
          "No repos attached yet. Attach at least one write repo so the factory can deliver.",
        ),
      );
    renderWriteHint();
  }

  function renderWriteHint() {
    const hasWrite = [...attached.values()].includes("write");
    writeHint.className = `selector-hint ${hasWrite ? "ok" : "warn"}`;
    writeHint.textContent = hasWrite
      ? "✓ This ticket has a write target — it can be delivered."
      : "Needs ≥1 write repo to be deliverable.";
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
        "Attach the repos this ticket may write, read or test, and optionally the scope node it lives under. At least one write repo is required.",
      ),
      el("div", { class: "field" }, [el("label", {}, "Scope node"), scopeSel]),
      scopeList,
      el("div", { class: "selector-add-repo" }, [
        el("div", { class: "field grow" }, [el("label", {}, "Repository"), repoSel]),
        el("div", { class: "field" }, [el("label", {}, "Access"), accessSel]),
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

function renderDecisionCard(d) {
  const answer = el("input", { type: "text", placeholder: "Answer (optional)" });
  const rationale = el("input", { type: "text", placeholder: "Rationale (optional)" });
  const resolve = (status) =>
    guard(async () => {
      const body = { status };
      if (answer.value.trim()) body.answer = answer.value.trim();
      if (rationale.value.trim()) body.rationale = rationale.value.trim();
      await api("POST", `/decisions/${d.id}/resolve`, body);
      toast(`Decision ${status}`, { ok: true });
      router();
    });
  return el(
    "div",
    {
      class: "ac-item",
      style: "flex-direction:column;align-items:stretch;gap:10px;margin-top:12px",
    },
    [
      el("div", { class: "meta-row", style: "margin:0" }, [
        badge(d.severity, "no-dot"),
        badge(d.status, "no-dot"),
      ]),
      el("h3", { style: "font-size:var(--step-0)" }, d.title),
      el("p", { class: "desc" }, d.question),
      el("div", { class: "inline-form", style: "margin:0;border:0;padding:0" }, [
        el("div", { class: "field" }, [el("label", {}, "Answer"), answer]),
        el("div", { class: "field" }, [el("label", {}, "Rationale"), rationale]),
        el("div", { class: "btn-row", style: "align-self:flex-end" }, [
          el(
            "button",
            { class: "btn ok", type: "button", onclick: () => resolve("accepted") },
            "Accept",
          ),
          el(
            "button",
            { class: "btn danger", type: "button", onclick: () => resolve("rejected") },
            "Reject",
          ),
        ]),
      ]),
    ],
  );
}

// ===========================================================================
//  View: Review queue
// ===========================================================================

function safeHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Render one git diff as monospace lines, colouring +/- with the existing
 * success/danger tokens. The raw diff text is inserted as text nodes (per-line),
 * never innerHTML, so a hostile diff can never inject markup.
 */
function diffBody(diffText) {
  const lines = String(diffText || "").split("\n");
  const rows = lines.map((line) => {
    let cls = "diff-line";
    const first = line.charAt(0);
    if (line.startsWith("+++") || line.startsWith("---")) cls += " diff-file";
    else if (line.startsWith("@@")) cls += " diff-hunk";
    else if (first === "+") cls += " diff-add";
    else if (first === "-") cls += " diff-del";
    // Render an empty line as a non-breaking space so the row keeps its height.
    return el("div", { class: cls }, line === "" ? " " : line);
  });
  return el("pre", { class: "diff-pre" }, rows);
}

/** A single repo's diff section: header (repo/branch/stats) + collapsible body. */
function repoDiffSection(rd) {
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
  const body = rd.unavailable ? null : diffBody(rd.diff);
  return el("div", { class: "diff-section" }, [header, body]);
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
  const report = (state) => {
    if (typeof onState === "function") onState(state);
  };
  api("GET", `/tickets/${ticketId}/diff`)
    .then((res) => {
      clear(box);
      const repos = (res && res.repos) || [];
      if (repos.length === 0) {
        box.appendChild(
          el("p", { class: "dim", style: "font-size:var(--step--1)" }, "No write repos to diff."),
        );
        report(diffApprovability(repos));
        return;
      }
      box.appendChild(
        el(
          "div",
          { class: "ac-meta" },
          `Diff (${repos.length} repo${repos.length === 1 ? "" : "s"})`,
        ),
      );
      for (const rd of repos) box.appendChild(repoDiffSection(rd));
      report(diffApprovability(repos));
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

function reviewEvidenceList(evidence, acList) {
  if (!evidence || evidence.length === 0) return null;
  const acText = new Map((acList || []).map((a) => [a.id, a.text]));
  const rows = evidence.map((ev) => {
    const link = safeHttpUrl(ev.uri);
    const acLabel = ev.ac_id && acText.has(ev.ac_id) ? acText.get(ev.ac_id) : null;
    return el("li", { class: "review-evi" }, [
      badge(ev.evidence_type, "no-dot"),
      el("span", { class: "evi-summary" }, ev.summary),
      link ? el("a", { href: link, target: "_blank", rel: "noopener" }, "open") : null,
      acLabel ? el("span", { class: "ac-meta evi-ac" }, `for AC: ${acLabel}`) : null,
    ]);
  });
  return el("div", { class: "review-evidence" }, [
    el("div", { class: "ac-meta" }, `Evidence (${evidence.length})`),
    el("ul", { class: "clean" }, rows),
  ]);
}

async function renderReview() {
  const tickets = (await api("GET", "/tickets?status=in_review")).tickets || [];
  const wrap = el("div", { class: "view" });
  wrap.appendChild(viewHead("Review", `${tickets.length} awaiting review`));

  if (tickets.length === 0) {
    wrap.appendChild(
      emptyState(
        "Nothing in review",
        "When agents deliver work it lands here for your sign-off.",
        "review",
      ),
    );
    return wrap;
  }

  wrap.appendChild(
    el("p", { class: "dim", style: "font-size:var(--step--1)" }, [
      "Keyboard: ",
      el("span", { class: "kbd" }, "j"),
      " / ",
      el("span", { class: "kbd" }, "k"),
      " move · ",
      el("span", { class: "kbd" }, "a"),
      " approve · ",
      el("span", { class: "kbd" }, "r"),
      " rework.",
    ]),
  );

  const details = await Promise.all(tickets.map((t) => api("GET", `/tickets/${t.id}`)));
  const cards = [];

  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    const ac = details[i].acceptance_criteria || [];
    const evidence = details[i].evidence || [];
    const ticketEvents = details[i].events || [];
    const isReopened = reopenedForReview(ticketEvents);
    const satisfied = ac.filter((a) => a.status === "satisfied").length;
    const prUrl = safeHttpUrl(t.pr_url);
    const deliveryChildren = [
      t.branch_name
        ? el("span", {}, ["branch ", el("code", { class: "mono" }, t.branch_name)])
        : null,
      t.branch_name && prUrl ? " · " : null,
      prUrl ? el("a", { href: prUrl, target: "_blank", rel: "noopener" }, "PR") : null,
    ].filter(Boolean);

    // Fix 4: a human must not approve a change they couldn't see. The Approve
    // button starts DISABLED and only enables once the diff loads with a real,
    // non-empty change (see `applyDiffState`). `approve()` itself fail-closes so
    // even the keyboard shortcut can't approve an unseen/unloaded diff.
    let diffState = { approvable: false, reason: "Loading the delivery diff…" };
    const approve = () =>
      guard(async () => {
        if (!diffState.approvable) {
          toast(`Can't approve — ${diffState.reason}`, {});
          return;
        }
        await api("POST", `/tickets/${t.id}/review/approve`);
        toast("Approved — merging", { ok: true });
        router();
      });
    // Reject offers a choice: send back for rework (-> refining, a human triages
    // first) or abandon to the won't-do bucket (-> cancelled). Either way the
    // backend resets the ticket's ACs to not-satisfied.
    const reject = (to) =>
      guard(async () => {
        const verb = to === "cancelled" ? "abandoning (won't do)" : `rejecting to ${to}`;
        const reason = window.prompt(`Reason for ${verb}?`);
        if (reason == null || reason.trim() === "") {
          toast("Reject cancelled — a reason is required", {});
          return;
        }
        await api("POST", `/tickets/${t.id}/review/reject`, { to, reason: reason.trim() });
        toast(to === "cancelled" ? "Marked won't do" : `Rejected to ${to}`, { ok: true });
        router();
      });

    // The diff-unavailable banner + the Approve button are held by reference so the
    // async diff load (fix 4) can toggle them once it settles.
    const canApprove = hasTicketAction(t.status, "approve");
    const approveBtn = canApprove
      ? el("button", { class: "btn ok", type: "button", disabled: "", onclick: approve }, [
          icon("check"),
          "Approve",
        ])
      : null;
    const diffBlockBanner = el(
      "div",
      { class: "reopen-banner diff-block-banner", style: "display:none" },
      [icon("alert"), ""],
    );
    const applyDiffState = (state) => {
      diffState = state || { approvable: false, reason: "The diff state is unknown." };
      if (diffState.approvable) {
        diffBlockBanner.style.display = "none";
        if (approveBtn) approveBtn.removeAttribute("disabled");
      } else {
        diffBlockBanner.style.display = "";
        clear(diffBlockBanner);
        diffBlockBanner.appendChild(icon("alert"));
        diffBlockBanner.appendChild(
          document.createTextNode(`Approve blocked — ${diffState.reason}`),
        );
        if (approveBtn) approveBtn.setAttribute("disabled", "");
      }
    };

    const card = el("div", { class: "card", dataset: { reviewIdx: String(i) }, tabindex: "-1" }, [
      el("div", { class: "meta-row" }, [
        el("span", { class: "num" }, t.number != null ? `#${t.number}` : t.id.slice(0, 8)),
        riskBadge(t.risk_level),
        badge(`AC ${satisfied}/${ac.length} satisfied`, "no-dot"),
        pipelineDots(t.status),
      ]),
      el("h2", { style: "font-size:var(--step-1);margin-bottom:6px" }, t.title),
      isReopened
        ? el("div", { class: "reopen-banner" }, [
            icon("alert"),
            "Merge conflict resolved on the branch — re-review the resolved diff and re-approve.",
          ])
        : null,
      deliveryChildren.length ? el("p", { class: "ac-meta" }, deliveryChildren) : null,
      reviewEvidenceList(evidence, ac),
      canApprove ? diffBlockBanner : null,
      renderTicketDiff(t.id, canApprove ? applyDiffState : undefined),
      // Driven off the single TICKET_ACTION_KEYS map so the review surface offers
      // exactly the in_review action set (approve / rework / won't do) and can
      // never drift from the detail page. "Open detail" is always present.
      el(
        "div",
        { class: "btn-row review-card-actions" },
        [
          approveBtn,
          hasTicketAction(t.status, "rework")
            ? el(
                "button",
                { class: "btn", type: "button", onclick: () => reject("refining") },
                "Send back to rework",
              )
            : null,
          hasTicketAction(t.status, "wont_do")
            ? el(
                "button",
                { class: "btn danger", type: "button", onclick: () => reject("cancelled") },
                "Won't do",
              )
            : null,
          el(
            "button",
            { class: "btn", type: "button", onclick: () => navigate(`#/ticket/${t.id}`) },
            "Open detail",
          ),
        ].filter(Boolean),
      ),
    ]);
    card._actions = { approve, reject };
    cards.push(card);
    wrap.appendChild(card);
  }

  // Keyboard queue navigation (j/k move, a approve, r reject-to-ready).
  let cursor = 0;
  const focusCard = (idx) => {
    cursor = Math.max(0, Math.min(cards.length - 1, idx));
    cards[cursor].focus({ preventScroll: false });
    cards.forEach((c, i) => c.classList.toggle("card-accent", i === cursor));
  };
  const onKey = (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if (e.key === "j") {
      e.preventDefault();
      focusCard(cursor + 1);
    } else if (e.key === "k") {
      e.preventDefault();
      focusCard(cursor - 1);
    } else if (e.key === "a") {
      e.preventDefault();
      cards[cursor]?._actions.approve();
    } else if (e.key === "r") {
      e.preventDefault();
      cards[cursor]?._actions.reject("refining");
    }
  };
  document.addEventListener("keydown", onKey);
  // Detach the handler when the view is replaced.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(wrap)) {
      document.removeEventListener("keydown", onKey);
      observer.disconnect();
    }
  });
  observer.observe(app, { childList: true });

  return wrap;
}

// ===========================================================================
//  Factory Map (UI-000 / UI-001 / UI-002 / UI-003)
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
      "Factory Map",
      `${nodes.length} node${nodes.length === 1 ? "" : "s"} · ${unmapped.length} unmapped repo${unmapped.length === 1 ? "" : "s"}`,
      el("button", { class: "btn primary", type: "button", onclick: () => navigate("#/node") }, [
        icon("plus"),
        "New scope node",
      ]),
    ),
  );

  wrap.appendChild(
    el("div", { class: "banner" }, [
      el("strong", {}, "How the Factory Map works. "),
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
    "aria-label": "Search the Factory Map",
    oninput: (e) => {
      factoryState.query = e.target.value;
      applyFactoryFilter(wrap, e.target.value.trim().toLowerCase());
    },
  });
  wrap.appendChild(
    el("div", { class: "filters" }, [
      el("div", { class: "field", style: "flex:1" }, [el("label", {}, "Search"), search]),
    ]),
  );

  wrap.appendChild(renderScopeTree(nodes, edges));
  wrap.appendChild(renderUnmappedSection(unmapped));
  wrap.appendChild(renderFactoryFooter());
  applyFactoryFilter(wrap, factoryState.query.trim().toLowerCase());
  return wrap;
}

// Low-key entry point to the (deliberately unadvertised) "Hidden repos" page.
// Not a nav tab — a small footer link under the Factory Map, so a hidden repo
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

function renderScopeTree(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map();
  const hasParent = new Set();
  for (const e of edges) {
    if (e.relation !== "contains") continue;
    if (!byId.has(e.from_node_id) || !byId.has(e.to_node_id)) continue;
    if (!childrenOf.has(e.from_node_id)) childrenOf.set(e.from_node_id, []);
    childrenOf.get(e.from_node_id).push(e.to_node_id);
    hasParent.add(e.to_node_id);
  }
  const roots = nodes.filter((n) => !hasParent.has(n.id));
  const card = el("div", { class: "card" }, [el("h2", {}, "Scope graph")]);
  if (nodes.length === 0) {
    card.appendChild(
      el("p", { class: "dim" }, "No scope nodes yet. Create one to start mapping your factory."),
    );
    return card;
  }
  const visited = new Set();
  const buildNode = (node) => {
    if (visited.has(node.id)) return null;
    visited.add(node.id);
    const tags = parseTags(node.tags_json);
    const row = el("div", { class: "tree-node", dataset: { kind: "node", nodeId: node.id } }, [
      el(
        "a",
        {
          class: "tree-link",
          href: `#/node/${node.id}`,
          onkeydown: (ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              navigate(`#/node/${node.id}`);
            }
          },
        },
        [
          el("span", { class: "tree-name" }, node.name),
          badge(typeLabel(node.type), `type-${node.type}`),
          riskBadge(node.risk_level),
          node.owner ? el("span", { class: "dim tree-owner" }, `@${node.owner}`) : null,
          ...tags.slice(0, 4).map((t) => el("span", { class: "tag-chip" }, t)),
        ],
      ),
    ]);
    const kids = (childrenOf.get(node.id) || []).map((id) => byId.get(id)).filter(Boolean);
    const branch = el("div", { class: "tree-branch", dataset: { kind: "branch" } }, [row]);
    if (kids.length)
      branch.appendChild(
        el("div", { class: "tree-children" }, kids.map((k) => buildNode(k)).filter(Boolean)),
      );
    return branch;
  };
  const tree = el("div", { class: "tree" }, roots.map((r) => buildNode(r)).filter(Boolean));
  const leftover = nodes.filter((n) => !visited.has(n.id));
  for (const n of leftover) {
    const branch = buildNode(n);
    if (branch) tree.appendChild(branch);
  }
  card.appendChild(tree);
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

// View: Hidden repos (WG-006). A deliberately low-key surface — reached only via
// the small footer link on the Factory Map — listing every hidden repo with an
// "Unhide" button that returns it to its normal place.
async function renderHidden() {
  const repos = (await api("GET", "/repositories?hidden=only")).repositories || [];
  const wrap = el("div", { class: "view" });
  wrap.appendChild(
    el(
      "button",
      { class: "back-link", type: "button", onclick: () => navigate("#/factory") },
      "← Back to Factory Map",
    ),
  );
  wrap.appendChild(viewHead("Hidden repos", `${repos.length} hidden`));
  wrap.appendChild(
    el("div", { class: "banner" }, [
      el("strong", {}, "These repos are hidden from the dashboard. "),
      "They stay registered and keep their links and scope mappings, but are excluded from the repo list, the Factory Map unmapped list and repo pickers. Un-hide one to return it to its normal place.",
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
        "← Back to Factory Map",
      ),
    );
    wrap.appendChild(viewHead("New scope node"));
    wrap.appendChild(el("div", { class: "card" }, renderNodeForm(null)));
    return wrap;
  }

  const view = await api("GET", `/scope/nodes/${id}`);
  const node = view.node;
  const repos = view.repos || [];
  const tickets = view.tickets || view.recent_tickets || null;

  const wrap = el("div", { class: "view" });
  wrap.appendChild(
    el(
      "button",
      { class: "back-link", type: "button", onclick: () => navigate("#/factory") },
      "← Back to Factory Map",
    ),
  );

  const tags = parseTags(node.tags_json);
  const loreTags = parseTags(node.lore_tags_json);

  const head = el("div", { class: "card card-accent" }, [
    el("h1", { class: "detail-title" }, node.name),
    el("div", { class: "meta-row" }, [
      badge(typeLabel(node.type), `type-${node.type}`),
      riskBadge(node.risk_level),
      node.owner ? badge(`@${node.owner}`, "no-dot") : null,
    ]),
    node.description
      ? el("p", { class: "desc" }, node.description)
      : el("p", { class: "desc dim" }, "No description."),
    tags.length || loreTags.length
      ? el("div", { class: "tag-row" }, [
          ...tags.map((t) => el("span", { class: "tag-chip" }, t)),
          ...loreTags.map((t) => el("span", { class: "tag-chip lore" }, `lore:${t}`)),
        ])
      : null,
  ]);
  const editDetails = el("details", { class: "edit-panel" }, [
    el("summary", {}, "Edit node"),
    renderNodeForm(node),
  ]);
  head.appendChild(editDetails);
  head.appendChild(
    el("div", { class: "btn-row", style: "margin-top:14px" }, [
      el(
        "button",
        {
          class: "btn danger",
          type: "button",
          onclick: () =>
            guard(async () => {
              if (!window.confirm(`Delete scope node “${node.name}”? This cannot be undone.`))
                return;
              await api("DELETE", `/scope/nodes/${node.id}`);
              toast("Scope node deleted", { ok: true });
              navigate("#/factory");
            }),
        },
        "Delete node",
      ),
    ]),
  );

  const repoCard = el("div", { class: "card" }, [
    el("h2", {}, `Linked repos (${repos.length})`),
    repos.length
      ? el(
          "ul",
          { class: "clean" },
          repos.map((r) =>
            el(
              "li",
              {},
              el("div", { class: "assoc-row" }, [
                el("a", { class: "assoc-name", href: `#/repo/${r.id}` }, r.name || r.id),
                el("div", { class: "assoc-meta" }, [
                  badge(r.relation, "no-dot"),
                  accessBadge(r.default_access),
                ]),
              ]),
            ),
          ),
        )
      : el("p", { class: "dim" }, "No repos linked to this node yet."),
    renderLinkRepoForm(node.id),
  ]);

  const ticketCard = el("div", { class: "card" }, [
    el("h2", {}, "Recent tickets"),
    Array.isArray(tickets) && tickets.length
      ? el(
          "ul",
          { class: "clean" },
          tickets.map((t) =>
            el("li", {}, [
              el(
                "a",
                { class: "feed-ticket", href: `#/ticket/${t.id}` },
                t.number != null ? `#${t.number}` : t.id.slice(0, 8),
              ),
              " ",
              el("span", {}, t.title || ""),
            ]),
          ),
        )
      : el(
          "p",
          { class: "dim" },
          "No ticket data yet — node→ticket links arrive in a later backend wave.",
        ),
  ]);

  const connCard = renderConnectionsCard(node, allNodes, allEdges);

  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("div", {}, [head, repoCard, ticketCard]),
      el("div", {}, [connCard]),
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
        el("div", { class: "field" }, [el("label", {}, "Name"), name]),
        el("div", { class: "field" }, [el("label", {}, "Type"), type]),
        el("div", { class: "field" }, [el("label", {}, "Owner"), owner]),
        el("div", { class: "field" }, [el("label", {}, "Risk level"), risk]),
      ]),
      el("div", { class: "field" }, [el("label", {}, "Description"), desc]),
      el("div", { class: "form-grid cols-2" }, [
        el("div", { class: "field" }, [el("label", {}, "Tags"), tags]),
        el("div", { class: "field" }, [el("label", {}, "Lore tags"), loreTags]),
      ]),
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
          dir === "out" ? "→ " : "← ",
          badge(e.relation, "no-dot"),
          " ",
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
      : el("p", { class: "dim" }, "No connections yet.");
  return el("div", { class: "card" }, [
    el("h2", {}, "Connections"),
    list,
    renderAddEdgeForm(node, allNodes),
  ]);
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
      el("div", { class: "field" }, [el("label", {}, "Connect to"), target]),
      el("div", { class: "field" }, [el("label", {}, "Relation"), relation]),
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
      el("div", { class: "field" }, [el("label", {}, "Repo"), repoSel]),
      el("div", { class: "field" }, [el("label", {}, "Relation"), relation]),
      el("div", { class: "field" }, [el("label", {}, "Access"), access]),
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

  const wrap = el("div", { class: "view" });
  wrap.appendChild(
    el(
      "button",
      { class: "back-link", type: "button", onclick: () => navigate("#/factory") },
      "← Back to Factory Map",
    ),
  );
  if (!repo) {
    wrap.appendChild(
      emptyState("Repository not found", "It may have been removed or renamed.", "map"),
    );
    return wrap;
  }

  const isMapped = scopes.length > 0;
  const hasWrite = scopes.some((s) => s.default_access === "write");

  const head = el("div", { class: "card card-accent" }, [
    el("h1", { class: "detail-title" }, repo.name),
    el("div", { class: "meta-row" }, [
      badge(isMapped ? "mapped" : "unmapped", isMapped ? "status-ready" : "no-dot"),
      riskBadge(repo.risk_level),
      repo.stack ? badge(repo.stack, "no-dot") : null,
      badge(`${scopes.length} scope${scopes.length === 1 ? "" : "s"}`, "no-dot"),
      repo.hidden ? badge("hidden", "no-dot") : null,
    ]),
    el("dl", { class: "kv" }, [
      el("dt", {}, "Path"),
      el("dd", {}, repo.local_path ? el("code", { class: "mono" }, repo.local_path) : "—"),
      el("dt", {}, "Default branch"),
      el("dd", {}, repo.default_branch || "—"),
      el("dt", {}, "Remote"),
      el("dd", {}, repo.remote_url ? el("code", { class: "mono" }, repo.remote_url) : "—"),
    ]),
    el("div", { class: "cmd-block" }, renderRepoCommands(repo)),
    el(
      "div",
      { class: "repo-visibility dim" },
      repo.hidden
        ? el(
            "button",
            {
              class: "btn primary small",
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
          ),
    ),
  ]);
  if (!isMapped) head.appendChild(renderMapRepoBox(repo, allNodes));
  if (!hasWrite) {
    head.appendChild(
      el("div", { class: "warn-box" }, [
        el("strong", {}, "⚠ No write association. "),
        isMapped
          ? "This repo is mapped but no association grants write access, so agents cannot deliver code to it."
          : "This repo is unmapped (single-repo mode). Map it to a node with write access to use it in factory mode.",
      ]),
    );
  }

  const scopeCard = el("div", { class: "card" }, [
    el("h2", {}, `Scope nodes (${scopes.length})`),
    el(
      "p",
      { class: "section-note dim" },
      "Every Factory Map node this repo is linked to, with its relation and the default access agents inherit. Change access in place; change relation by re-linking.",
    ),
    scopes.length
      ? el(
          "ul",
          { class: "clean" },
          scopes.map((s) => renderRepoScopeRow(repo, s)),
        )
      : el(
          "p",
          { class: "dim" },
          "Unmapped — this repo belongs to no scope node and behaves as a standalone single-repo scope.",
        ),
    renderAddAssociationForm(repo, allNodes, scopes),
  ]);

  const ticketCard = el("div", { class: "card" }, [
    el("h2", {}, "Recent tickets"),
    el("p", { class: "section-note dim" }, "Tickets whose execution boundary includes this repo."),
    renderRepoTickets(repo),
  ]);

  const scanCard = el("div", { class: "card" }, [
    el("h2", {}, "Context & scan status"),
    el("div", { class: "warn-box scan-status" }, [
      el("strong", {}, "Scan status not available in this view. "),
      "Repo context freshness and scan state come from Crew's context store (FG-004), which the Dispatch control surface cannot reach yet. This panel lights up in a later wave once the status is exposed here.",
    ]),
  ]);

  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("div", {}, [head, scopeCard]),
      el("div", {}, [ticketCard, scanCard]),
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
      "Create a scope node on the Factory Map first, then map this repo into it.",
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
          toast("Repo mapped into the Factory Map", { ok: true });
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

function renderRepoTickets(repo) {
  const box = el(
    "div",
    { class: "repo-tickets" },
    el("p", { class: "dim" }, "Loading recent tickets…"),
  );
  (async () => {
    let tickets;
    try {
      tickets = (await api("GET", `/tickets?repo=${encodeURIComponent(repo.name)}`)).tickets || [];
    } catch (e) {
      clear(box);
      box.appendChild(
        el("p", { class: "dim" }, `Recent tickets unavailable${e.code ? ` (${e.code})` : ""}.`),
      );
      return;
    }
    clear(box);
    if (!tickets.length) {
      box.appendChild(el("p", { class: "dim" }, "No tickets reference this repo yet."));
      return;
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
              statusBadge(t.status),
              el("span", { class: "dim tabnum repo-ticket-time" }, fmtTime(t.updated_at)),
            ]),
          ),
        ),
      ),
    );
    if (tickets.length > recent.length) {
      box.appendChild(
        el("p", { class: "dim repo-ticket-more" }, [
          `${tickets.length - recent.length} more — `,
          el("a", { href: "#/work", class: "assoc-name plain" }, "open Work"),
          ".",
        ]),
      );
    }
  })();
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
      el("div", { class: "field" }, [el("label", {}, "Scope node"), nodeSel]),
      el("div", { class: "field" }, [el("label", {}, "Relation"), relation]),
      el("div", { class: "field" }, [el("label", {}, "Access"), access]),
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

/** Resolve ticket details (scopes + deps) in bounded-parallel batches. */
async function fetchTicketDetails(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += EPIC_DETAIL_CONCURRENCY) {
    const batch = ids.slice(i, i + EPIC_DETAIL_CONCURRENCY);
    const details = await Promise.all(batch.map((id) => api("GET", `/tickets/${id}`)));
    batch.forEach((id, j) => out.set(id, details[j]));
  }
  return out;
}

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

async function renderEpics(param) {
  // A deep link (#/epics/:nodeId) auto-expands that epic.
  const focusId = param || null;

  const [nodesRes, ticketsRes] = await Promise.all([
    api("GET", "/scope/nodes"),
    api("GET", "/tickets"),
  ]);
  const epics = (nodesRes.nodes || []).filter((n) => n.type === "epic");
  const tickets = ticketsRes.tickets || [];

  const wrap = el("div", { class: "view" });
  wrap.appendChild(
    viewHead("Epics", `${epics.length} live`, [
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () => openPlanBuild(),
        },
        [icon("spark"), el("span", {}, "Plan a build")],
      ),
    ]),
  );

  wrap.appendChild(
    el(
      "p",
      { class: "epics-lede dim" },
      "Each epic is a phased, dependency-ordered plan. Tickets are gated phase by phase — a phase can't start until the one before it is done.",
    ),
  );

  if (epics.length === 0) {
    wrap.appendChild(
      emptyState(
        "No epics yet",
        "Describe an app in plain language and Dispatch will propose a phased plan of draft tickets.",
        "epics",
      ),
    );
    const cta = el("div", { style: "display:flex;justify-content:center;margin-top:18px" }, [
      el("button", { class: "btn primary", type: "button", onclick: () => openPlanBuild() }, [
        icon("spark"),
        el("span", {}, "Plan a build"),
      ]),
    ]);
    wrap.appendChild(cta);
    return wrap;
  }

  // We only need details for tickets that could belong to an epic. Without a
  // reverse index we fetch every ticket's detail once (bounded-parallel) and map
  // membership from each ticket's `scopes`.
  const detailById = await fetchTicketDetails(tickets.map((t) => t.id));

  // Build epic membership + a per-ticket dependency list from the details.
  const membersByEpic = new Map(epics.map((e) => [e.id, []]));
  const depsById = new Map();
  const depViewById = new Map();
  for (const t of tickets) {
    const detail = detailById.get(t.id);
    if (!detail) continue;
    const scopes = detail.scopes || [];
    const deps = detail.dependencies || [];
    depsById.set(
      t.id,
      deps.map((d) => d.depends_on_ticket_id),
    );
    depViewById.set(t.id, deps);
    for (const s of scopes) {
      if (membersByEpic.has(s.id)) membersByEpic.get(s.id).push({ ...t, ...detail.ticket });
    }
  }

  const list = el("div", { class: "epic-list" });
  for (const epic of epics) {
    list.appendChild(
      renderEpicCard(
        epic,
        membersByEpic.get(epic.id) || [],
        depsById,
        depViewById,
        focusId === epic.id,
      ),
    );
  }
  wrap.appendChild(list);
  return wrap;
}

/** One epic = a collapsible card whose body is its tickets grouped into phases. */
function renderEpicCard(epic, members, depsById, depViewById, expanded) {
  const byPhase = computePhases(members, depsById);
  const phases = [...byPhase.keys()].sort((a, b) => a - b);
  const draftCount = members.filter((m) => m.status === "draft").length;
  const doneCount = members.filter((m) => m.status === "done").length;

  const details = el("details", { class: "epic-card card card-accent" });
  if (expanded) details.setAttribute("open", "");

  const summary = el("summary", { class: "epic-summary" }, [
    el("div", { class: "epic-summary-main" }, [
      icon("epics", "epic-ico"),
      el("div", {}, [
        el("div", { class: "epic-name" }, epic.name),
        epic.description ? el("div", { class: "epic-desc dim" }, epic.description) : null,
      ]),
    ]),
    el("div", { class: "epic-summary-meta" }, [
      el(
        "span",
        { class: "epic-stat tabnum" },
        `${members.length} ticket${members.length === 1 ? "" : "s"}`,
      ),
      el(
        "span",
        { class: "epic-stat dim tabnum" },
        `${phases.length} phase${phases.length === 1 ? "" : "s"}`,
      ),
      draftCount ? badge(`${draftCount} draft`, "status-draft") : null,
      doneCount ? badge(`${doneCount} done`, "status-done") : null,
    ]),
  ]);
  details.appendChild(summary);

  const body = el("div", { class: "epic-body" });
  if (members.length === 0) {
    body.appendChild(
      el("p", { class: "dim", style: "padding:8px 2px" }, "This epic has no tickets."),
    );
  } else {
    for (const p of phases) {
      body.appendChild(renderEpicPhase(p, byPhase.get(p), depViewById));
    }
  }
  details.appendChild(body);
  return details;
}

/** A phase column: a labelled lane of ticket cards, with the hard-gate note. */
function renderEpicPhase(phase, tickets, depViewById) {
  // Phases are 0-indexed internally (dependency depth) but shown 1-indexed so the
  // labels read Phase 1…Phase N and match the "{N} phases" count in the summary.
  const label = phase + 1;
  const lane = el("section", { class: "epic-phase", "aria-label": `Phase ${label}` });
  lane.appendChild(
    el("div", { class: "epic-phase-head" }, [
      el("span", { class: "epic-phase-num tabnum" }, `Phase ${label}`),
      el("span", { class: "epic-phase-count dim tabnum" }, String(tickets.length)),
      phase > 0
        ? el("span", { class: "epic-phase-gate dim" }, [
            icon("clock"),
            `gated on phase ${label - 1}`,
          ])
        : null,
    ]),
  );
  const cards = tickets
    .slice()
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .map((t) => renderEpicTicket(t, depViewById.get(t.id) || []));
  lane.appendChild(el("div", { class: "epic-phase-body" }, cards));
  return lane;
}

/** A ticket card inside an epic phase — status, bootstrap, and its blockers. */
function renderEpicTicket(t, deps) {
  const blockers = deps.filter((d) => !d.satisfied);
  const go = () => navigate(`#/ticket/${t.id}`);
  return el(
    "a",
    {
      class: "epic-ticket",
      href: `#/ticket/${t.id}`,
      onkeydown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      },
    },
    [
      el("div", { class: "epic-ticket-top" }, [
        el("span", { class: "num" }, t.number != null ? `#${t.number}` : t.id.slice(0, 8)),
        t.bootstrap ? badge("bootstrap", "no-dot") : null,
        pipelineDots(t.status),
      ]),
      el("div", { class: "epic-ticket-title" }, t.title),
      el("div", { class: "epic-ticket-chips" }, [
        statusBadge(t.status),
        typeof t.priority === "number"
          ? el("span", { class: "dim tabnum", title: "priority" }, `P${t.priority}`)
          : null,
      ]),
      deps.length
        ? el("div", { class: `epic-deps${blockers.length ? " blocked" : ""}` }, [
            icon("link", "dep-ico"),
            blockers.length
              ? el("span", {}, ["blocked by ", ...joinDepRefs(blockers)])
              : el("span", { class: "dim" }, ["after ", ...joinDepRefs(deps)]),
          ])
        : null,
    ],
  );
}

/** Render dependency refs as "#3, #5" text nodes. */
function joinDepRefs(deps) {
  const out = [];
  deps.forEach((d, i) => {
    if (i > 0) out.push(", ");
    out.push(el("span", { class: "dep-ref" }, d.number != null ? `#${d.number}` : "ticket"));
  });
  return out;
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
  const actions = el("div", { class: "pb-actions" }, [forceBtn, sendBtn]);
  const form = el("form", { class: "pb-composer" }, [input, actions]);
  const panel = el(
    "aside",
    { class: "pb-panel", role: "dialog", "aria-modal": "true", "aria-label": "Plan a build" },
    [
      el("header", { class: "pb-head" }, [
        el("div", { class: "pb-head-main" }, [
          icon("spark", "pb-head-ico"),
          el("div", {}, [
            el("div", { class: "pb-title" }, "Plan a build"),
            el("div", { class: "pb-sub dim" }, "Brief → phased epic of draft tickets"),
          ]),
        ]),
        el(
          "button",
          { class: "icon-btn", type: "button", "aria-label": "Close", onclick: closePlanBuild },
          el("span", { html: "✕" }),
        ),
      ]),
      el("div", { class: "pb-guardrail" }, [
        icon("alert", "pb-guard-ico"),
        el(
          "span",
          {},
          "Proposes only. Nothing runs — confirmed tickets land as draft for you to ready.",
        ),
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

  planBuildEls = { scrim, panel, log, input, sendBtn, forceBtn, form };
  return planBuildEls;
}

function openPlanBuild() {
  const { scrim, input } = ensurePlanBuild();
  // `mode` is the start toggle: "new" (greenfield app) vs "extend" (add tickets
  // to an existing scope node / epic). `target` holds the chosen extend node and
  // becomes the `context` sent to the decomposer on the first turn. `nodes` is
  // loaded lazily for the extend picker; an empty list just hides the option.
  planBuildState = {
    history: [],
    plan: null,
    busy: false,
    brief: null,
    mode: "new",
    target: null,
    nodes: [],
  };
  renderPlanBuildLog();
  scrim.classList.add("open");
  document.addEventListener("keydown", planBuildKeydown);
  setTimeout(() => input.focus(), 50);
  // Best-effort: populate the "Extend existing" picker. The panel works without it.
  guard(async () => {
    const nodes = (await api("GET", "/scope/nodes")).nodes || [];
    if (planBuildState) {
      planBuildState.nodes = nodes;
      // Only repaint while still on the empty intro (no turns sent yet).
      if (planBuildState.history.length === 0) renderPlanBuildLog();
    }
  });
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
        planBuildState.mode === "extend"
          ? el(
              "p",
              {},
              planBuildState.target
                ? `Tell me what to add to "${planBuildState.target.name}" in one line — for example:`
                : "Pick what to extend, then tell me what to add in one line — for example:",
            )
          : el("p", {}, "Tell me what to build in one line — for example:"),
        el(
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

  for (const turn of planBuildState.history) {
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
    }
  }

  if (planBuildState.plan) {
    log.appendChild(renderPlanProposal(planBuildState.plan));
  }

  if (planBuildState.busy) {
    log.appendChild(
      el("div", { class: "pb-msg pb-bot pb-thinking" }, [
        el("span", { class: "pb-dot" }),
        el("span", { class: "pb-dot" }),
        el("span", { class: "pb-dot" }),
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
  // A bare first turn has no brief yet — force-plan with nothing to go on is a no-op.
  forceBtn.disabled = planBuildState.busy || turns === 0;
  forceBtn.classList.toggle("pb-force-strong", turns >= PLAN_BUILD_FORCE_EMPHASIS_TURNS);
}

/**
 * Start toggle: "New app" vs "Extend existing". In extend mode a scope-node /
 * epic picker appears; the chosen node becomes the `context` the decomposer uses
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
          el("span", { class: "dim" }, " — greenfield"),
        ]),
      ]),
      el("label", { class: "mode-option" }, [
        extendRadio,
        el("span", {}, [
          el("strong", {}, "Extend existing"),
          el("span", { class: "dim" }, " — add to a scope"),
        ]),
      ]),
    ]),
  ];

  if (planBuildState.mode === "extend") {
    const sel = el("select", { "aria-label": "Scope node or epic to extend" }, [
      el("option", { value: "" }, nodes.length ? "Select what to extend…" : "No scope nodes yet"),
      ...nodes.map((n) =>
        el(
          "option",
          {
            value: n.id,
            selected: planBuildState.target && planBuildState.target.id === n.id ? "" : undefined,
          },
          `${n.name} (${typeLabel(n.type)})`,
        ),
      ),
    ]);
    sel.addEventListener("change", () => {
      const node = nodes.find((n) => n.id === sel.value) || null;
      planBuildState.target = node
        ? { id: node.id, name: node.name, type: node.type, repo: null }
        : null;
      renderPlanBuildLog();
      planBuildEls.input.focus();
      // Brownfield: resolve the chosen node's target repo NAME so the extend
      // context carries `repo` (reaching the existing-repo decompose path). The
      // node's repos aren't on the list payload, so fetch them; best-effort, the
      // panel still works (greenfield-style) if it can't be resolved.
      if (node) resolveExtendRepo(node.id);
    });
    children.push(el("div", { class: "field pb-extend-field" }, [el("label", {}, "Extend"), sel]));
  }

  return el("div", { class: "pb-mode" }, children);
}

/**
 * Resolve the target repo NAME for an extend target node. Picks a write repo if
 * one is linked, else the first linked repo. Best-effort: on any error or when
 * the node has no repos the target keeps `repo: null` and the build proceeds
 * greenfield-style (no brownfield path). The result is stored on the locked
 * target so the first turn's context can carry `repo`.
 */
async function resolveExtendRepo(nodeId) {
  try {
    const { repos } = await api("GET", `/scope/nodes/${nodeId}`);
    const list = Array.isArray(repos) ? repos : [];
    const pick = list.find((r) => r.default_access === "write") || list[0] || null;
    // Guard against a race: only apply when this node is still the chosen target.
    if (planBuildState && planBuildState.target && planBuildState.target.id === nodeId) {
      planBuildState.target.repo = pick ? pick.name : null;
    }
  } catch {
    // Leave repo null — the panel still works, just without the brownfield hint.
  }
}

/** Render the proposed epic + tickets for review, with the confirm button. */
function renderPlanProposal(plan) {
  const epic = plan.epic || {};
  const tickets = plan.tickets || [];
  const wrap = el("div", { class: "pb-proposal card card-amber" });
  wrap.appendChild(
    el("div", { class: "pb-proposal-head" }, [
      badge("proposal", "no-dot"),
      el("h3", { class: "pb-proposal-name" }, epic.name || "Proposed epic"),
    ]),
  );
  if (epic.description)
    wrap.appendChild(el("p", { class: "pb-proposal-desc dim" }, epic.description));

  wrap.appendChild(
    el(
      "ol",
      { class: "pb-tickets" },
      tickets.map((t, i) => {
        const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
        return el("li", { class: "pb-ticket" }, [
          el("div", { class: "pb-ticket-top" }, [
            el("span", { class: "pb-ticket-idx tabnum" }, `#${i + 1}`),
            t.bootstrap ? badge("bootstrap", "no-dot") : null,
            typeof t.priority === "number"
              ? el("span", { class: "dim tabnum" }, `P${t.priority}`)
              : null,
            t.repo ? el("code", { class: "mono pb-repo" }, t.repo) : null,
          ]),
          el("div", { class: "pb-ticket-title" }, t.title),
          t.description ? el("p", { class: "pb-ticket-desc dim" }, t.description) : null,
          Array.isArray(t.acceptanceCriteria) && t.acceptanceCriteria.length
            ? el(
                "ul",
                { class: "pb-acs" },
                t.acceptanceCriteria.map((ac) => el("li", {}, ac)),
              )
            : null,
          deps.length
            ? el("div", { class: "pb-ticket-deps dim" }, [
                icon("link", "dep-ico"),
                `depends on ${deps.map((d) => `#${d + 1}`).join(", ")}`,
              ])
            : null,
        ]);
      }),
    ),
  );

  wrap.appendChild(
    el("div", { class: "pb-confirm-row" }, [
      el(
        "p",
        { class: "pb-confirm-note dim" },
        `${tickets.length} ticket${tickets.length === 1 ? "" : "s"} will be created as draft — nothing runs until you ready them.`,
      ),
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () => confirmPlanBuild(plan),
        },
        [icon("check"), el("span", {}, "Create these tickets")],
      ),
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
  if (isFirst && planBuildState.mode === "extend" && !planBuildState.target) {
    toast("Pick a scope node or epic to extend first.");
    return;
  }
  // Force-plan with nothing said yet has nothing to plan from — ask for the brief.
  if (forcePlan && isFirst && !text) {
    toast("Tell me what to build first, then I can build the tickets.");
    return;
  }

  // Record the user's message. On a force-plan turn the input may be empty (the
  // user just pressed "Build the tickets"), so only push a message when there is text.
  if (text) {
    if (isFirst) planBuildState.brief = text;
    planBuildState.history.push(
      isFirst ? { role: "user", brief: text } : { role: "user", answer: text },
    );
    input.value = "";
    input.style.height = "auto";
  }

  // Build the extend-existing context once (locked for the whole conversation).
  const context =
    planBuildState.mode === "extend" && planBuildState.target
      ? {
          mode: "extend",
          scopeNodeId: planBuildState.target.id,
          scopeNodeName: planBuildState.target.name,
          scopeNodeType: planBuildState.target.type,
          // Brownfield: forward the resolved target repo NAME so decompose takes
          // the existing-repo path. Only included when resolved (else greenfield).
          ...(planBuildState.target.repo ? { repo: planBuildState.target.repo } : {}),
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

  await guard(async () => {
    // Send the brief + the answered turns; the helper treats answered Qs as settled.
    // On a force-plan turn the decomposer is told to stop clarifying and return a
    // plan now from what it has — so the user is never trapped in an endless chat.
    const res = await api("POST", "/plan-build", {
      brief: planBuildState.brief,
      history: planBuildState.history.map((t) =>
        t.role === "user" && t.brief ? { role: "user", answer: t.brief } : t,
      ),
      ...(context !== undefined ? { context } : {}),
      ...(forcePlan ? { forcePlan: true } : {}),
    });
    planBuildState.busy = false;
    if (res.phase === "clarify") {
      planBuildState.history.push({ role: "assistant", questions: res.questions || [] });
    } else if (res.phase === "plan") {
      planBuildState.plan = res.plan || null;
    } else {
      toast(res.error || "Planning failed", { code: "PLAN_BUILD" });
    }
    renderPlanBuildLog();
  });
  planBuildState.busy = false;
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
async function confirmPlanBuild(plan) {
  await guard(async () => {
    const known = new Set(
      ((await api("GET", "/repositories")).repositories || []).map((r) => r.name),
    );
    let deferred = 0;
    const tickets = (plan.tickets || []).map((t) => {
      if (t.repo && !known.has(t.repo)) {
        deferred++;
        const { repo, access, ...rest } = t;
        return rest;
      }
      return t;
    });
    const res = await api("POST", "/epics", { epic: plan.epic, tickets });
    const count = (res.ticket_numbers || []).length;
    const note = deferred
      ? ` (${deferred} repo link${deferred === 1 ? "" : "s"} deferred to bootstrap)`
      : "";
    toast(`Created ${count} draft ticket${count === 1 ? "" : "s"} — ready them when set${note}`, {
      ok: true,
    });
    closePlanBuild();
    navigate(`#/epics/${res.epic_node_id}`);
    // If already on the epics view, navigate() with the same view won't re-fire
    // the hashchange when the param differs only — force a refresh to be safe.
    router();
  });
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
      el("div", { class: "field" }, [el("label", {}, "Registered repo"), repoSel]),
      el("div", { class: "or-divider dim" }, "or"),
      el("div", { class: "field" }, [el("label", {}, "Local path"), pathInput]),
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

async function renderMemory(param) {
  const { query } = parseHash();
  memoryState.repo = param ? decodeURIComponent(param) : "";
  memoryState.node = query.get("node") || "";

  const reposRes = await api("GET", "/repositories");
  const repos = reposRes.repositories || [];

  const wrap = el("div", { class: "view", dataset: { view: "memory" } });
  wrap.appendChild(
    viewHead(
      "Memory",
      memoryState.repo ? memoryState.repo : `${repos.length} repo${repos.length === 1 ? "" : "s"}`,
      onboardButton(repos, memoryState.repo, { primary: true }),
    ),
  );
  wrap.appendChild(
    el("div", { class: "banner" }, [
      el("strong", {}, "What Memory shows. "),
      "The ",
      el("strong", {}, "Repo Digest"),
      " is the factory's working understanding of each repo; the ",
      el("strong", {}, "Feature ledger"),
      " tracks what's shipped, building, and backlogged; ",
      el("strong", {}, "Lore"),
      " is the team's recorded knowledge. It all lives in the memory product and is ",
      el("strong", {}, "read-only"),
      " here.",
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
  wrap.appendChild(
    el("div", { class: "filters" }, [
      el("div", { class: "field", style: "flex:1" }, [el("label", {}, "Repo"), repoSel]),
    ]),
  );

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

  // Lore filtered to the selected repo (plus any global / un-scoped lore).
  const loreRes = await api("GET", "/api/memory/lore");
  wrap.appendChild(renderLoreList(loreRes, memoryState.repo));
  return wrap;
}

function renderDigestCard(repo, res, repos = []) {
  if (!res || res.available === false) {
    const card = el("div", { class: "card" }, [el("h2", {}, "Repo Digest")]);
    card.appendChild(memoryUnavailable(res ? res.reason : ""));
    return card;
  }
  const digest = res.digest;
  const card = el("div", { class: "card", dataset: { section: "digest" } }, [
    el("h2", {}, "Repo Digest"),
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
      "Features",
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
      el("div", { class: "filters" }, [
        el("div", { class: "field", style: "flex:1" }, [el("label", {}, "Scope node"), nodeSel]),
      ]),
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

function renderLoreList(res, repo) {
  const all = (res && res.lore) || [];
  // When viewing a repo, show only its lore plus any global (un-scoped) lore.
  const lore = repo
    ? all.filter((l) => !l.repos || l.repos.length === 0 || l.repos.includes(repo))
    : all;
  const card = el("div", { class: "card", dataset: { section: "lore" } }, [
    el("h2", {}, [
      "Lore",
      res && res.available !== false ? el("span", { class: "count" }, String(lore.length)) : null,
    ]),
    el(
      "p",
      { class: "dim section-note" },
      repo
        ? `Knowledge scoped to ${repo} (plus un-scoped lore) — read-only here. Manage it with the memory CLI.`
        : "The team's recorded knowledge — read-only here. Manage it with the memory CLI.",
    ),
  ]);
  if (!res || res.available === false) {
    card.appendChild(memoryUnavailable(res ? res.reason : ""));
    return card;
  }
  if (lore.length === 0) {
    card.appendChild(
      emptyState(
        repo ? `No lore for ${repo} yet` : "No lore recorded yet",
        "Lore captures the conventions and decisions agents should respect.",
        "check",
      ),
    );
    return card;
  }
  const list = el(
    "div",
    { class: "lore-list" },
    lore.map((l) =>
      el("div", { class: "lore-row" }, [
        el("div", { class: "lore-head" }, [
          el("span", { class: "lore-title" }, l.title),
          l.status ? badge(l.status, `lore-${l.status}`) : null,
          l.confidence ? el("span", { class: "dim lore-conf" }, `conf=${l.confidence}`) : null,
          l.stale ? badge("stale", "lore-stale") : null,
        ]),
        el("p", { class: "lore-summary dim" }, l.summary),
        el("div", { class: "lore-meta dim" }, [
          l.source ? el("span", {}, l.source) : null,
          ...(l.repos || []).map((r) => el("span", { class: "tag-chip" }, r)),
          ...(l.tags || []).map((t) => el("span", { class: "tag-chip subtle" }, t)),
        ]),
      ]),
    ),
  );
  card.appendChild(list);
  return card;
}

// --- Wiring -----------------------------------------------------------------

buildChrome();
window.addEventListener("hashchange", router);
router();
