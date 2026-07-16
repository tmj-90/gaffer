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

/** Reduced-motion check that is safe when matchMedia is absent (tests/SSR). */
function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

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
  paused: "Paused",
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
  // Instrument header: a mono kicker line over a confident display title, all
  // riding on a hairline baseline — like the label plate on a console section.
  return el("div", { class: "view-head" }, [
    el("div", { class: "view-head-main" }, [
      el("div", { class: "view-kicker" }, [
        el("span", { class: "view-kicker-tick" }),
        el("span", {}, countText ? String(countText).toUpperCase() : "GAFFER FACTORY"),
      ]),
      el("h1", {}, title),
    ]),
    actions ? el("div", { class: "view-head-actions" }, [].concat(actions)) : null,
  ]);
}

/**
 * Atmospheric hero band that sits at the very TOP of a view, below the nav.
 * A dark sci-fi image carries the amber focal on its RIGHT; a two-axis scrim
 * (see `.view-hero` in styles.css) darkens the LEFT and fades the band into the
 * OLED content below, so real headline text stays legible at AAA contrast.
 *
 * The image is purely decorative background; all copy is live DOM text (screen
 * readers get the eyebrow/title/subtitle/status verbatim). The leading ◆ / ●
 * marks are rendered as decorative, aria-hidden spans — do not bake them into
 * the passed strings.
 *
 * @param {object}  o
 * @param {string}  o.image        asset path, e.g. "assets/bg/hero-city.jpg"
 * @param {string} [o.eyebrow]     small mono caps line (amber ◆ prepended)
 * @param {string}  o.title        editorial headline (Space Grotesk)
 * @param {string} [o.subtitle]    muted supporting line(s)
 * @param {string} [o.status]      status line text (● dot prepended)
 * @param {boolean}[o.statusOk]    green dot + text when healthy (default true)
 */
function viewHero({ image, eyebrow, title, subtitle, status, statusOk = true }) {
  return el("header", { class: "view-hero", style: `background-image:url("${image}")` }, [
    el("div", { class: "view-hero-inner" }, [
      eyebrow
        ? el("div", { class: "view-hero-eyebrow mono" }, [
            el("span", { class: "view-hero-diamond", "aria-hidden": "true" }, "◆"),
            el("span", {}, eyebrow),
          ])
        : null,
      el("h1", { class: "view-hero-title" }, title),
      subtitle ? el("p", { class: "view-hero-sub" }, subtitle) : null,
      status
        ? el("div", { class: `view-hero-status${statusOk ? " ok" : ""}` }, [
            el("span", { class: "view-hero-dot", "aria-hidden": "true" }),
            el("span", {}, status),
          ])
        : null,
    ]),
  ]);
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

// Primary nav entries (order = bottom-nav + desktop rail order).
const NAV = [
  { id: "overview", label: "Overview", icon: "overview" },
  { id: "health", label: "Health", icon: "health" },
  { id: "work", label: "Work", icon: "work" },
  { id: "review", label: "Review", icon: "review" },
  { id: "epics", label: "Epics", icon: "epics" },
  { id: "specs", label: "Specs", icon: "specs" },
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

// Navigation order — used to decide which way the "camera" steps so a forward
// move (Overview → Settings) and a back move read differently. This is what
// makes navigating feel like walking through a plan rather than a page reload.
const NAV_ORDER = [
  "overview",
  "health",
  "work",
  "review",
  "epics",
  "specs",
  "factory",
  "memory",
  "settings",
];
let lastAreaIndex = 0;

let activeArea = "overview";
async function router() {
  const { view, param } = parseHash();
  // Unknown views fall through to Overview; aliases are resolved in parseHash.
  const render = VIEWS[view] || renderOverview;
  activeArea = AREA_FOR_VIEW[view] || (VIEWS[view] ? view : "overview");

  // Decide the step direction (forward = deeper into the plan, back = out).
  const idx = NAV_ORDER.indexOf(activeArea);
  const dir = idx === -1 || idx === lastAreaIndex ? "none" : idx > lastAreaIndex ? "fwd" : "back";
  if (idx !== -1) lastAreaIndex = idx;
  document.documentElement.dataset.step = dir;

  app.dataset.area = activeArea; // lets CSS give width-hungry views (work/map/epics) the full screen
  syncNav();
  updateNavBadges();
  app.classList.remove("login-shell");

  // The actual DOM swap: skeleton in, awaited content in. Wrapped in a View
  // Transition so the browser tweens the old frame to the new one — the nav
  // marker glides between rail items and the content does a depth "camera step".
  const swap = async () => {
    clear(app);
    app.appendChild(
      skeleton(view === "overview" ? "overview" : view === "work" ? "board" : "list"),
    );
    await guard(async () => {
      const content = await render(param);
      clear(app);
      app.appendChild(content);
      app.scrollTop = 0;
      stagger(content);
      animateReadouts(content);
    });
  };

  const reduce = prefersReducedMotion();
  if (document.startViewTransition && !reduce) {
    // Snapshot synchronously, then run the marker-glide; the awaited content
    // resolves inside the transition's update callback. A rapid navigation aborts
    // the in-flight transition, rejecting its .ready/.finished with
    // InvalidStateError — the DOM update still runs, so swallow those rejections (and
    // any synchronous throw) to keep an unguarded exception off every interrupted
    // view change.
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

/** Stagger the entrance of a freshly-mounted view's top-level blocks so the
 *  screen assembles itself, top-down, like instruments coming online. */
function stagger(root) {
  const blocks = root.querySelectorAll(":scope > *");
  blocks.forEach((b, i) => {
    b.style.setProperty("--stagger", `${Math.min(i, 9) * 60}ms`);
    b.classList.add("rise-in");
  });
}

/** The instruments "come up": telemetry numbers spin from 0 to their value and
 *  fill gauges sweep out. Honest — the target is the real number; we only
 *  animate the approach. Skipped under reduced-motion. */
function animateReadouts(root) {
  if (prefersReducedMotion()) return;

  // Silos fill up from empty, left to right — the line charging.
  root.querySelectorAll(".silo-fill").forEach((bar, i) => {
    const target = bar.style.height || "0%";
    bar.style.height = "0%";
    setTimeout(
      () => requestAnimationFrame(() => (bar.style.height = target)),
      200 + Math.min(i, 9) * 90,
    );
  });

  // Fill gauges (other views): start collapsed, then transition to width.
  root.querySelectorAll(".gauge-track i").forEach((bar, i) => {
    const target = bar.style.width || "0%";
    bar.style.width = "0%";
    setTimeout(
      () => requestAnimationFrame(() => (bar.style.width = target)),
      220 + Math.min(i, 9) * 60,
    );
  });

  // Count-up on big numeric readouts (silo values + any gauge values).
  root.querySelectorAll(".silo-val, .gauge-value").forEach((node, i) => {
    const target = parseInt(node.textContent, 10);
    if (!Number.isFinite(target) || target === 0) return;
    const dur = 620;
    const start = performance.now() + 180 + Math.min(i, 9) * 60;
    node.textContent = "0";
    const tick = (now) => {
      const t = (now - start) / dur;
      if (t < 0) {
        requestAnimationFrame(tick);
        return;
      }
      if (t >= 1) {
        node.textContent = String(target);
        return;
      }
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      node.textContent = String(Math.round(eased * target));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// --- App chrome (app bar + bottom nav) --------------------------------------

function buildChrome() {
  // App bar.
  clear(appbar);
  const brand = el("a", { class: "brand", href: "#/overview", "aria-label": "Gaffer — Overview" }, [
    el("img", { class: "brand-icon", src: "/gaffer-icon.svg", alt: "" }),
    el("span", { class: "brand-text" }, [
      el("span", { class: "brand-name" }, "Gaffer"),
      el("span", { class: "brand-sub" }, "CONTROL ROOM"),
    ]),
  ]);

  // LIVE lamp — a breathing amber status light. The single most "alive" pixel
  // in the room; it tells you the factory is on watch.
  const live = el("div", { class: "rail-status", title: "Factory online" }, [
    el("span", { class: "live-lamp" }),
    el("span", { class: "rail-status-text" }, "LIVE"),
    el("span", { class: "rail-status-meta mono", id: "live-tick" }, "tick 001"),
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
        [
          el("span", { class: "nav-rule" }),
          icon(n.icon, "nav-ico"),
          el("span", { class: "nav-label" }, n.label),
          el("span", { class: "nav-count", dataset: { count: n.id }, hidden: true }),
        ],
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

  appbar.append(brand, live, rail, el("div", { class: "appbar-spacer" }), cmdk, newBtn);
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

  startLiveTick();
  startAutoRefresh();
}

// Hot-refresh: read-mostly views quietly re-fetch on an interval so the board,
// overview and review reflect what the factory is doing without a manual reload
// (fixes the stale-board bug — there was no polling or server push). It never
// fights the operator: skipped while typing, while dragging, when the tab is
// hidden, or if the route changed mid-fetch — and it preserves scroll so a
// background refresh is invisible. Forms (create/settings) and ticket detail are
// deliberately excluded so in-flight input is never clobbered.
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
function startAutoRefresh() {
  if (autoRefreshTimer) return;
  autoRefreshTimer = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (busyEditing()) return;
    // don't yank a card mid-drag or a menu/sheet out from under a click. Match `.sheet.open`
    // (an OPEN sheet), not `.sheet` — the latter is the always-present container, so it would
    // pause auto-refresh permanently after the first sheet ever opens.
    if (document.querySelector(".dragging, .is-dragging, .sheet.open, .menu-open")) return;
    const { view, param } = parseHash();
    if (!AUTO_REFRESHABLE.has(view)) return;
    const render = VIEWS[view];
    if (!render) return;
    const y = app.scrollTop;
    guard(async () => {
      const content = await render(param);
      // bail if the operator navigated or started interacting during the fetch
      if (parseHash().view !== view || busyEditing()) return;
      clear(app);
      app.appendChild(content);
      app.scrollTop = y;
    });
  }, AUTO_REFRESH_MS);
}

// Live heartbeat — the tick counter breathes in the bar so the room reads
// "on watch". Purely cosmetic; the number is a monotonic tick, not real data.
let liveTickTimer;
function startLiveTick() {
  if (liveTickTimer) return;
  let n = 0;
  liveTickTimer = setInterval(() => {
    n++;
    const t = document.getElementById("live-tick");
    if (!t) return;
    t.textContent = "tick " + String(n).padStart(3, "0");
    if (prefersReducedMotion()) return;
    t.classList.add("tick-flash");
    setTimeout(() => t.classList.remove("tick-flash"), 200);
  }, 6000);
}

function syncNav() {
  document.querySelectorAll("[data-area]").forEach((n) => {
    n.classList.toggle("active", n.dataset.area === activeArea);
  });
}

/** Live, data-driven nav badges: Work shows open (in-flight) tickets, Review
 *  shows the gate queue. Best-effort; the rail works fine without them. */
let navBadgeBusy = false;
async function updateNavBadges() {
  if (navBadgeBusy) return;
  navBadgeBusy = true;
  try {
    const { summary } = await api("GET", "/api/dashboard");
    const s = summary.ticketsByStatus || {};
    const open =
      (s.ready || 0) +
      (s.in_progress || 0) +
      (s.claimed || 0) +
      (s.in_review || 0) +
      (s.in_testing || 0) +
      (s.ready_for_merge || 0) +
      (s.blocked || 0);
    const counts = { work: open, review: summary.openDecisions != null ? s.in_review || 0 : 0 };
    counts.review = s.in_review || 0;
    document.querySelectorAll(".nav-count[data-count]").forEach((el) => {
      const v = counts[el.dataset.count];
      if (v > 0) {
        el.textContent = String(v);
        el.hidden = false;
        el.classList.toggle("urgent", el.dataset.count === "review");
      } else {
        el.hidden = true;
      }
    });
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
      label: "Factory Map",
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
  const [
    { summary },
    activity,
    ticketsRes,
    decisionsRes,
    costRes,
    bouncingRes,
    humanQueueRes,
    healthRes,
  ] = await Promise.all([
    api("GET", "/api/dashboard"),
    api("GET", "/api/activity?limit=200"),
    api("GET", "/tickets").catch(() => ({ tickets: [] })),
    api("GET", "/decisions").catch(() => ({ decisions: [] })),
    api("GET", "/api/cost").catch(() => null),
    api("GET", "/api/rework/bouncing").catch(() => ({ bouncing: [] })),
    api("GET", "/api/human-queue").catch(() => ({ items: [], counts: { total: 0 } })),
    api("GET", "/api/health").catch(() => null),
  ]);

  const byStatus = summary.ticketsByStatus || {};
  const tickets = ticketsRes.tickets || [];
  const events = activity.events || [];
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
  const actByDay = bucket(events, (e) => e.created_at);

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
  const flowEff = Math.round(
    ((byStatus.done || 0) /
      Math.max(1, (byStatus.done || 0) + inReview + blocked + inProgress + (byStatus.ready || 0))) *
      100,
  );
  // honest deltas: second-half avg vs first-half avg of the relevant series
  const half = (s) => {
    const h = Math.floor(s.length / 2);
    const a = s.slice(0, h).reduce((x, y) => x + y, 0) / Math.max(1, h);
    const b = s.slice(h).reduce((x, y) => x + y, 0) / Math.max(1, s.length - h);
    return a === 0 ? (b > 0 ? 100 : 0) : Math.round(((b - a) / a) * 100);
  };

  const wrap = el("div", { class: "view" });
  wrap.appendChild(
    viewHero({
      image: "assets/bg/hero-city.jpg",
      title: "Ship better software, faster.",
      subtitle:
        "Real-time insight into your factory. Track flow, focus on what matters, and keep everything moving.",
      status: "Factory online", // honest: the dashboard is up. 'All systems nominal' was a hardcoded literal, not a health signal.
      statusOk: true,
    }),
  );

  // Queue-first: what needs YOU leads the room, sitting above the metrics.
  wrap.appendChild(whatIOwnPanel(humanQueueRes));

  // --- KPI row --------------------------------------------------------------
  wrap.appendChild(
    el("div", { class: "kpi-row" }, [
      kpiCard({
        label: "Cycle time",
        value: cycleTime.toFixed(1),
        unit: "days",
        tone: "accent",
        delta: half(cycleLine),
        goodWhenDown: true,
        series: cycleLine,
      }),
      kpiCard({
        label: "Throughput",
        value: String(last7),
        unit: "shipped / 7d",
        tone: "ok",
        delta: prev7 === 0 ? (last7 > 0 ? 100 : 0) : Math.round(((last7 - prev7) / prev7) * 100),
        series: doneByDay,
      }),
      kpiCard({
        label: "Flow efficiency",
        value: String(flowEff),
        unit: "%",
        tone: "accent",
        delta: half(actByDay),
        series: flowEffSeries,
      }),
      kpiCard({
        label: "Deployments",
        value: String(doneTickets.length),
        unit: "all-time",
        tone: "amber",
        delta: half(doneByDay),
        series: deploySeries,
      }),
      kpiCard({
        label: "Lead time",
        value: leadTime.toFixed(1),
        unit: "days",
        tone: "accent",
        delta: half(cycleLine),
        goodWhenDown: true,
        series: leadSeries,
      }),
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
            (r) => `${r.numerator} of ${r.denominator} agent-approved merges stayed shipped`,
          ),
        ]),
      );
    };
    paint(health.governance);
    wrap.appendChild(govPanel);
  }

  // --- Cost banner (H1) -------------------------------------------------------
  // One small row: total spend all-time + today. Reads from /api/cost which
  // reads the usage-ledger. Hidden when the ledger is absent / not configured.
  if (costRes && (costRes.total_usd > 0 || costRes.today_usd > 0 || costRes.ticket_count > 0)) {
    const fmtUsd = (v) => (typeof v === "number" ? `$${v.toFixed(4)}` : "—");
    wrap.appendChild(
      el(
        "div",
        {
          class: "cost-banner",
          // HONESTY: this is an API-EQUIVALENT estimate from Claude Code usage, not real
          // money — on a Max/Pro subscription the marginal cost is the flat fee, and a
          // timed-out/killed call reports "unknown" and contributes $0. Labelled so the
          // number is never read as a real bill.
          title:
            "API-equivalent estimate from Claude Code usage — NOT real charges on a Max/Pro subscription (there the marginal cost is the flat fee). Killed/timed-out calls report as unknown and count as $0.",
        },
        [
          el("span", { class: "cost-item" }, [
            el("span", { class: "cost-label" }, "All-time (API-equiv)"),
            el("span", { class: "cost-val tabnum" }, fmtUsd(costRes.total_usd)),
          ]),
          el("span", { class: "cost-sep" }, "·"),
          el("span", { class: "cost-item" }, [
            el("span", { class: "cost-label" }, "Today"),
            el("span", { class: "cost-val tabnum" }, fmtUsd(costRes.today_usd)),
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
  wrap.appendChild(
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
  wrap.appendChild(
    el("div", { class: "ov-grid ov-3" }, [
      repoProgressPanel(summary.repoProgress || []),
      el("div", { class: "card panel" }, [
        panelHead("Cycle time", "days"),
        el("div", { class: "chart", html: svgLine(cycleLine, days) }),
      ]),
      el("div", { class: "card panel" }, [
        panelHead("Flow efficiency", "value-add"),
        el("div", { class: "donut-wrap tone-violet" }, [
          el("div", { class: "donut", html: svgDonut(flowEff) }),
          el("div", { class: "donut-center" }, [
            el("span", { class: "donut-pct tabnum" }, `${flowEff}%`),
            el("span", { class: "donut-cap" }, "efficient"),
          ]),
        ]),
      ]),
    ]),
  );

  // --- "Running now" — what's in flight right now (RUN-ACTIVITY) -----------
  // Polls GET /api/runs every ~3s so a triggered background run (Suggest work /
  // onboard / poll-work / merge) is visible while it churns, with its captured
  // log a click away when it finishes. Quiet empty state when nothing's running.
  wrap.appendChild(runActivityPanel());

  // --- Decisions (inline, when present) ------------------------------------
  if (decisions.length) {
    const decCard = el("div", { class: "card decisions-card", id: "decisions" }, [
      panelHead("Decisions awaiting you", `${decisions.length}`),
    ]);
    const well = el("div", { class: "decisions-well" });
    decisions.forEach((d) => well.appendChild(renderDecisionCard(d)));
    decCard.appendChild(well);
    wrap.appendChild(decCard);
  }

  // --- FAILURE-DIAGNOSIS: "these keep bouncing" quality signal --------------
  // Cross-ticket read model: tickets whose rework trail keeps growing, ranked so
  // the ones repeatedly failing the SAME gate lead. Only shown when something is
  // actually bouncing (a quiet factory shows no panel).
  const bouncing = (bouncingRes && bouncingRes.bouncing) || [];
  if (bouncing.length) {
    wrap.appendChild(renderBouncingPanel(bouncing));
  }

  // --- Live activity --------------------------------------------------------
  wrap.appendChild(
    el("div", { class: "card panel" }, [
      panelHead("Live activity", `${activity.total ?? events.length}`),
      events.length
        ? el("ul", { class: "feed" }, events.slice(0, 12).map(renderFeedRow))
        : el("p", { class: "dim" }, "No activity recorded yet."),
    ]),
  );

  return wrap;
}

/**
 * Track 2a "What I own": the operator's first-class lane. Surfaces the HUMAN's
 * queue — the decisions/approvals the agent delegated to them — so the operator
 * sees at a glance what is waiting on THEM, distinct from the board (what the
 * agent is churning). Each row: what it is, the reason, its ticket, how long it
 * has waited. A quiet, reassuring empty state when nothing is owed.
 */
function whatIOwnPanel(queue) {
  const items = (queue && queue.items) || [];
  const total = (queue && queue.counts && queue.counts.total) || items.length;
  const card = el("div", { class: "card what-i-own", id: "what-i-own" }, [
    el("div", { class: "panel-head" }, [
      el("span", { class: "panel-title" }, [icon("lock"), "What I own"]),
      el("span", { class: "panel-aux mono" }, String(total)),
    ]),
    el(
      "p",
      { class: "dim what-i-own-sub" },
      "Decisions and approvals waiting on you — distinct from what the agent is churning.",
    ),
  ]);
  if (!items.length) {
    card.appendChild(el("div", { class: "empty-state" }, "Nothing is waiting on you right now."));
    return card;
  }
  const well = el("div", { class: "own-well" });
  items.forEach((it) => well.appendChild(renderOwnedItem(it)));
  card.appendChild(well);
  return card;
}

/** One "What I own" row: kind chip · reason · ticket ref · how long it waited. */
function renderOwnedItem(it) {
  const t = it.ticket;
  const ref = t ? (t.number != null ? `#${t.number}` : t.id.slice(0, 8)) : "—";
  // Link each item to its ticket; a decision with no ticket links to the
  // decisions well on the overview so it can still be actioned.
  const href = t ? `#/ticket/${t.id}` : "#/overview";
  return el("a", { class: `own-row own-row--${it.kind}`, href }, [
    el("span", { class: `own-kind own-kind--${it.kind}` }, it.label),
    el("span", { class: "own-body" }, [
      el("span", { class: "own-reason" }, it.reason || "(no reason given)"),
      el("span", { class: "own-meta" }, [
        el("span", { class: "own-ref mono" }, ref),
        el(
          "span",
          { class: "own-age dim tabnum", title: `Waiting since ${it.since}` },
          `waited ${fmtDuration(it.waitedMs)}`,
        ),
      ]),
    ]),
  ]);
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

/** A panel header: a title with an optional trailing meta/aux label. */
function panelHead(title, aux, link) {
  return el("div", { class: "panel-head" }, [
    el("span", { class: "panel-title" }, title),
    link
      ? el("a", { class: "panel-link", href: link.href }, link.text)
      : aux
        ? el("span", { class: "panel-aux mono" }, aux)
        : null,
  ]);
}

/** A KPI card: label, big value + unit, a signed delta chip, and a sparkline. */
function kpiCard({ label, value, unit, tone, delta, series, goodWhenDown = false }) {
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const good = delta === 0 ? "flat" : delta > 0 !== goodWhenDown ? "good" : "bad";
  return el("a", { class: `kpi tone-${tone}`, href: "#/work" }, [
    el("div", { class: "kpi-top" }, [
      el("span", { class: "kpi-label" }, label),
      el("span", { class: `kpi-delta ${good}` }, [
        el("span", { class: "kpi-arrow" }, dir === "up" ? "▲" : dir === "down" ? "▼" : "—"),
        `${Math.abs(delta)}%`,
      ]),
    ]),
    el("div", { class: "kpi-figure" }, [
      el("span", { class: "kpi-val tabnum" }, value),
      unit ? el("span", { class: "kpi-unit" }, unit) : null,
    ]),
    el("div", { class: "kpi-spark", html: svgSpark(series) }),
  ]);
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
      el("span", { class: "pl-live" }, [el("span", { class: "pl-live-dot" }), "LIVE"]),
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
    panelHead(
      "Needs your attention",
      null,
      items.length ? { text: "View all", href: "#/work" } : null,
    ),
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
                el("span", { class: "rp-repo" }, r.repo),
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

// --- tiny hand-rolled SVG charts (no libraries) -----------------------------

/** A compact sparkline; uses currentColor so the KPI tone drives the colour. */
function svgSpark(series) {
  const vals = series.map((v) => (v == null ? 0 : v));
  if (vals.length < 2) vals.push(vals[0] ?? 0);
  const w = 132,
    h = 38,
    p = 4;
  const max = Math.max(...vals),
    min = Math.min(...vals);
  const X = (i) => p + (i / (vals.length - 1)) * (w - 2 * p);
  const Y = (v) => h - p - ((v - min) / (max - min || 1)) * (h - 2 * p);
  let line = "";
  vals.forEach((v, i) => (line += `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `));
  const area = `${line}L${X(vals.length - 1).toFixed(1)} ${h - p} L${X(0).toFixed(1)} ${h - p} Z`;
  const gid = "sp" + Math.random().toString(36).slice(2, 8);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark-svg">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="currentColor" stop-opacity="0.30"/>
      <stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${line}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${X(vals.length - 1).toFixed(1)}" cy="${Y(vals[vals.length - 1]).toFixed(1)}" r="2.4" fill="currentColor"/>
  </svg>`;
}

/** A line chart with a soft area fill, dots and a few x-axis ticks. */
function svgLine(series, days) {
  const vals = series.map((v) => (v == null ? 0 : v));
  const w = 340,
    h = 150,
    pl = 6,
    pr = 6,
    pt = 12,
    pb = 22;
  const max = Math.max(1, ...vals),
    min = Math.min(...vals, 0);
  const X = (i) => pl + (i / (vals.length - 1)) * (w - pl - pr);
  const Y = (v) => h - pb - ((v - min) / (max - min || 1)) * (h - pt - pb);
  let line = "";
  vals.forEach((v, i) => (line += `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(v).toFixed(1)} `));
  const area = `${line}L${X(vals.length - 1).toFixed(1)} ${h - pb} L${X(0).toFixed(1)} ${h - pb} Z`;
  const grid = [0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = (pt + (h - pt - pb) * (1 - f)).toFixed(1);
      return `<line x1="${pl}" y1="${y}" x2="${w - pr}" y2="${y}" class="cg"/>`;
    })
    .join("");
  const ticks = days
    .map((d, i) =>
      i % 3 === 0 ? `<text x="${X(i).toFixed(1)}" y="${h - 6}" class="cx">${d.lbl}</text>` : "",
    )
    .join("");
  const dots = vals
    .map((v, i) =>
      i % 3 === 0 || i === vals.length - 1
        ? `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2.4" class="cd"/>`
        : "",
    )
    .join("");
  const gid = "ln" + Math.random().toString(36).slice(2, 8);
  return `<svg viewBox="0 0 ${w} ${h}" class="chart-svg" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="currentColor" stop-opacity="0.22"/>
      <stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>
    ${grid}
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${line}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    ${dots}${ticks}
  </svg>`;
}

/** A donut gauge; the filled arc uses currentColor (tone-driven). */
function svgDonut(pct) {
  const r = 46,
    cx = 60,
    cy = 60,
    c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return `<svg viewBox="0 0 120 120" class="donut-svg">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="11"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="currentColor" stroke-width="11"
      stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"
      transform="rotate(-90 ${cx} ${cy})"/>
  </svg>`;
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
    el(
      "span",
      { class: "feed-actor dim" },
      `${ev.actor_type}${ev.actor_id ? ` · ${ev.actor_id}` : ""}`,
    ),
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

  const fmtCost = (usd) => (usd > 0 ? `$${usd.toFixed(4)}` : null);
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
  return el("span", { class: "run-cost-chip tabnum dim" }, `$${costUsd.toFixed(4)}`);
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
      run.repo ? el("span", { class: "run-repo dim" }, run.repo) : null,
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
    run.repo ? el("span", { class: "run-repo dim" }, run.repo) : null,
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
  const card = el("div", { class: "card run-activity", id: "running-now" }, [
    el("h2", {}, [icon("activity"), "Running now"]),
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
        emptyState("Nothing running", "Background runs you trigger show up here.", "activity"),
      );
      return;
    }
    if (active && active.length) {
      listWrap.appendChild(el("ul", { class: "run-list" }, active.map(activeRunRow)));
    }
    if (recent && recent.length) {
      listWrap.appendChild(el("div", { class: "run-recent-title dim" }, "Recently finished"));
      listWrap.appendChild(el("ul", { class: "run-list" }, recent.map(finishedRunRow)));
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

async function renderWork() {
  readWorkStateFromUrl();

  // Board endpoint powers the board; the filtered /tickets list powers list mode.
  // Repos + scope nodes feed the "Suggest work" target picker (Feature B).
  const boardQs = workState.repo ? `?repo=${encodeURIComponent(workState.repo)}` : "";
  const [board, reposRes, nodesRes] = await Promise.all([
    api("GET", `/api/board${boardQs}`),
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
    viewHero({
      image: "assets/bg/hero-factory.jpg",
      eyebrow: `${live} LIVE · ${wontDo.length} WON'T DO · ${closed.length} CLOSED`,
      title: "Work",
      subtitle: "Plan, prioritize and ship with confidence.",
    }),
  );
  wrap.appendChild(
    el("div", { class: "view-toolbar" }, [
      modeToggle,
      el("div", { class: "view-toolbar-actions" }, [
        pollWorkButton(),
        suggestWorkButton(repos, nodes),
      ]),
    ]),
  );
  if (workState.mode === "board") wrap.appendChild(workFlowHeader(columns, closed.length));
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

/** A flow-summary header above the board: per-stage WIP counts and a single
 *  distribution bar so the shape of the board reads before you scan the lanes. */
function workFlowHeader(columns, shippedCount) {
  const by = {};
  for (const c of columns) by[c.column] = (c.cards || []).length;
  const cells = [
    { label: "Draft", v: by.draft || 0, tone: "idle" },
    { label: "Ready", v: by.ready || 0, tone: "accent" },
    { label: "In progress", v: by.in_progress || 0, tone: "accent" },
    { label: "In review", v: by.in_review || 0, tone: "amber" },
    { label: "Blocked", v: by.blocked || 0, tone: "danger" },
    { label: "Shipped", v: shippedCount, tone: "ok" },
  ];
  const flowTotal = Math.max(
    1,
    cells.reduce((n, c) => n + c.v, 0),
  );
  const seg = cells
    .filter((c) => c.v > 0)
    .map((c) =>
      el("span", {
        class: `wf-seg tone-${c.tone}`,
        style: `width:${(c.v / flowTotal) * 100}%`,
        title: `${c.label}: ${c.v}`,
      }),
    );
  return el("div", { class: "card panel work-flow" }, [
    el(
      "div",
      { class: "wf-cells" },
      cells.map((c) =>
        el("div", { class: `wf-cell tone-${c.tone}` }, [
          el("span", { class: "wf-val tabnum" }, String(c.v)),
          el("span", { class: "wf-label" }, c.label),
        ]),
      ),
    ),
    el("div", { class: "wf-bar" }, seg),
  ]);
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

/** Board (kanban) — columns by status; filters dim non-matching cards client-side. */
function renderBoard(columns, closed, wontDo = []) {
  const wrap = el("div");
  // repo is filtered server-side via ?repo= on /api/board; only status and
  // risk need client-side dimming here (no repo field on BoardCard).
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
            el("span", { class: "claim-dot" }),
            card.claim.agentDisplayName || card.claim.agentId.slice(0, 8),
            card.claim.stale ? " · stale" : "",
          ],
        )
      : pipelineDots(card.status);

  const meta = el("div", { class: "card-meta" }, [
    acText ? el("span", { class: "ac-progress" }, acText) : el("span", { class: "dim" }, "no AC"),
    ownerMarker,
  ]);

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
          const reasonLabel = p.reason === "budget_cap" ? "budget cap reached" : "hit the turn cap";
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

  const head = el("div", { class: "card card-accent" }, [
    el("div", { class: "num" }, t.number != null ? `#${t.number}` : t.id),
    el("h1", { class: "detail-title" }, t.title),
    el("div", { class: "meta-row" }, [
      statusBadge(t.status),
      riskBadge(t.risk_level),
      badge(t.policy_pack, "no-dot"),
      badge(`priority ${t.priority}`, "no-dot"),
      // TRACK-3a: the per-ticket delivery-budget ceiling, when set.
      t.delivery_budget_usd != null
        ? badge(`budget $${Number(t.delivery_budget_usd).toFixed(2)}`, "no-dot")
        : null,
    ]),
    el("div", { style: "margin:10px 0 14px" }, pipelineDots(t.status)),
    t.description
      ? el("p", { class: "desc" }, t.description)
      : el("p", { class: "desc dim" }, "No description."),
    pausedBanner,
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
              el("div", { class: "ev-type" }, humanizeEvent(ev.event_type)),
              el("div", { class: "ev-time" }, fmtTime(ev.created_at)),
              el(
                "div",
                { class: "ev-actor" },
                `${ev.actor_type}${ev.actor_id ? ` · ${ev.actor_id}` : ""}`,
              ),
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
  const failureHistory = renderFailureHistory(view.rework_trail || []);

  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("div", {}, [head, sideRepos, diffCard, failureHistory, acCard, testingCard, timeline]),
      el("div", {}, [sideFields, sideBlockers]),
    ]),
  );
  return wrap;
}

/**
 * FAILURE-DIAGNOSIS: render a ticket's full ordered rework failure trail (the "why
 * did #N fail" history). Each attempt shows its gate + the DISTILLED failing test +
 * assertion/stack the runner captured — not a one-line summary. Returns null when
 * the ticket never bounced, so a clean ticket shows no card.
 */
function renderFailureHistory(trail) {
  if (!Array.isArray(trail) || trail.length === 0) return null;
  const attemptsLabel = trail.length === 1 ? "1 attempt" : `${trail.length} attempts`;
  return el("div", { class: "card failure-history" }, [
    el("h2", {}, [icon("alert"), `Failure history (${attemptsLabel})`]),
    el(
      "p",
      { class: "dim failure-history-sub" },
      "Every rework attempt the runner recorded, oldest first — the real failing test + assertion for each.",
    ),
    el(
      "ol",
      { class: "failure-trail" },
      trail.map((a) => {
        const max =
          typeof a.max_attempts === "number" && a.max_attempts > 0 ? `/${a.max_attempts}` : "";
        return el("li", { class: "failure-attempt" }, [
          el("div", { class: "failure-attempt-head" }, [
            el("span", { class: "failure-attempt-num" }, `Attempt ${a.attempt}${max}`),
            a.gate ? el("span", { class: "failure-gate" }, a.gate) : null,
            el("span", { class: "failure-attempt-time" }, fmtTime(a.created_at)),
          ]),
          // The distilled failure is untrusted captured tool output — render it as a
          // text node inside <pre> (never innerHTML) so it can't inject markup.
          el("pre", { class: "failure-detail" }, a.distilled_failure || "(no detail captured)"),
        ]);
      }),
    ),
  ]);
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
            el(
              "li",
              {},
              typeof b === "string"
                ? b
                : b.message || b.reason || b.label || "Blocked by an unmet condition",
            ),
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
  wrap.appendChild(viewHead("Health", "ROI & factory honesty"));

  if (!health) {
    wrap.appendChild(
      emptyState(
        "Health data unavailable",
        "The health API did not respond. The usage ledger may be unconfigured.",
        "alert",
      ),
    );
    return wrap;
  }

  const fmtUsd = (v) => (typeof v === "number" && Number.isFinite(v) ? `$${v.toFixed(4)}` : "—");
  const skills = health.skills || {};
  const recall = health.recall || { available: false };
  const byKind = Array.isArray(health.by_kind) ? health.by_kind : [];
  const skillList = Array.isArray(skills.by_skill) ? skills.by_skill : [];
  const dailySpend = Array.isArray(health.daily_spend) ? health.daily_spend : [];
  const totalUsd = typeof health.total_usd === "number" ? health.total_usd : 0;

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

  wrap.appendChild(
    el("div", { class: "kpi-row" }, [
      kpiCard({
        label: "Cost / feature",
        value: costPerFeature == null ? "—" : `$${costPerFeature.toFixed(3)}`,
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
    ]),
  );

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

  wrap.appendChild(el("div", { class: "ov-grid ov-3" }, [kindPanel, skillPanel, recallPanel]));

  return wrap;
}

async function renderSettings() {
  // Load the env-override settings plus the crew idle-loop config + the repos and
  // scope nodes the idle-loop target picker needs. Best-effort on the extras: a
  // failure there must not blank the whole Settings page.
  const [{ settings }, idleLoopsRes, reposRes, nodesRes, autonomyRecRes, autonomyPolRes] =
    await Promise.all([
      api("GET", "/api/settings"),
      api("GET", "/api/idle-loops").catch(() => null),
      api("GET", "/repositories").catch(() => ({ repositories: [] })),
      api("GET", "/scope/nodes").catch(() => ({ nodes: [] })),
      // GRADUATED-AUTONOMY (Spec 2): advisory recommendations — best-effort, must never
      // blank the page if the endpoint is unavailable.
      api("GET", "/api/autonomy/recommendations").catch(() => null),
      // GRADUATED-AUTONOMY (Spec 2, Phase 3): the currently-enabled policies.
      api("GET", "/api/autonomy/policies").catch(() => null),
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

  // Autonomy dial — the headline: how many human gates are open right now.
  wrap.appendChild(autonomyDial(all));

  // GRADUATED-AUTONOMY (Spec 2, Phase 3): the currently-enabled policies, each with a
  // one-click reversible OFF. Rendered above the suggestions so the active posture is
  // the first thing an operator sees.
  const polPanel = autonomyPoliciesPanel(autonomyPolicies);
  if (polPanel) wrap.appendChild(polPanel);

  // GRADUATED-AUTONOMY (Spec 2, Phase 3): advisory recommendations backed by the review
  // track record — each is now an ENABLE action (evidence + explicit confirm → POST).
  const recPanel = autonomyRecommendationsPanel(autonomyRecs, autonomyPolicies);
  if (recPanel) wrap.appendChild(recPanel);

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

  wrap.appendChild(form);

  // Crew idle-loop scan loops — enable + repo/scope scoping. These live in
  // crew.yaml (not settings.json), so they save through their own endpoint.
  if (idleLoops) {
    wrap.appendChild(renderIdleLoopsPanel(idleLoops, repos, nodes));
  }

  return wrap;
}

/** The autonomy dial — a gauge of how much the factory may do without you.
 *  Reads the boolean autonomy settings: each one ON is one human gate opened. */
function autonomyDial(all) {
  const isOn = (v) => v === true || v === "true" || v === "1" || v === "on";
  const bools = all.filter((s) => s.group === "autonomy" && s.type === "boolean");
  const total = Math.max(1, bools.length);
  const on = bools.filter((s) => isOn(s.value)).length;
  const pct = Math.round((on / total) * 100);
  const level = on === 0 ? "Supervised" : on >= total ? "Hands-off" : "Assisted";
  const tone = on === 0 ? "ok" : on >= total ? "danger" : "amber";
  const blurb =
    on === 0
      ? "A human approves every merge. The factory structurally cannot ship its own work."
      : on >= total
        ? "Every gate is open — the factory can plan, build, review and ship without you."
        : `${on} of ${total} gates are open. The factory acts on its own for the toggles marked below.`;
  return el("div", { class: `card panel autonomy-dial tone-${tone}` }, [
    el("div", { class: "ad-gauge" }, [
      el("div", { class: "ad-donut", html: svgDonut(pct) }),
      el("div", { class: "ad-center" }, [
        el("span", { class: "ad-frac tabnum" }, `${on}/${total}`),
        el("span", { class: "ad-cap" }, "gates open"),
      ]),
    ]),
    el("div", { class: "ad-body" }, [
      el("div", { class: "ad-level-row" }, [
        el("span", { class: "ad-level" }, level),
        el("span", { class: "ad-badge" }, on === 0 ? "fully gated" : `${on} open`),
      ]),
      el("p", { class: "ad-note" }, blurb),
      el(
        "div",
        { class: "ad-gates" },
        bools.map((s) =>
          el("span", { class: `ad-gate ${isOn(s.value) ? "on" : "off"}` }, [
            el("span", { class: "ad-gate-dot" }),
            s.label || s.key,
          ]),
        ),
      ),
    ]),
  ]);
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
function autonomyRecommendationsPanel(recs, policies) {
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
      recs.map((r) => autonomyRecItem(r, policies)),
    ),
  ]);
}

/** One recommendation row with its inline evidence + explicit enable/confirm flow. */
function autonomyRecItem(r, policies) {
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
  if (active) {
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
function autonomyPoliciesPanel(policies) {
  const active = (Array.isArray(policies) ? policies : []).filter((p) => p.mode === "auto");
  if (active.length === 0) return null;
  return el("div", { class: "card panel autonomy-policies" }, [
    el("div", { class: "ar-head" }, [
      icon("lock", "ar-ico"),
      el("div", {}, [
        el("h2", { class: "ar-title" }, "Active autonomy"),
        el(
          "p",
          { class: "section-note dim" },
          "The factory acts without you at these chokepoints. Turn any off to re-gate it immediately.",
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
            el("span", { class: "ap-mode" }, "auto"),
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

/** The known idle scan loops, in display order, with copy for the panel. */
const IDLE_LOOP_LABELS = {
  idle_coverage: "Coverage",
  idle_test_quality: "Test quality",
  idle_documentation: "Documentation",
  idle_dependencies: "Dependencies",
  idle_security_hotspot: "Security hotspots",
  idle_feature_backlog: "Feature backlog",
};

/**
 * Idle-loops control panel. For each scan loop: an enable toggle + a multi-select
 * target picker (repos + scopes). On save, node selections are resolved to repo
 * NAMES so the crew loop backend stays repo-name-based, and the whole set is PUT
 * to /api/idle-loops. An empty selection means "all repos" (schema semantics).
 */
function renderIdleLoopsPanel(view, repos, nodes) {
  const card = el("div", { class: "card settings-group idle-loops-group" });
  card.appendChild(el("h2", {}, "Idle loops"));
  card.appendChild(
    el(
      "p",
      { class: "section-note dim" },
      "Background scan loops that run when the queue is empty — enable each and scope it to repos or scopes. Empty selection = all repos.",
    ),
  );
  card.appendChild(
    el("div", { class: "settings-note idle-loops-note" }, [
      icon("clock", "settings-note-ico"),
      el("span", {}, "Changes apply on the next tick — no live restart."),
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

  // Per-loop editor registry: key → { read() } collecting enabled + targets.
  const editors = new Map();
  const rows = el("div", { class: "idle-loops-rows" });

  for (const loop of view.loops || []) {
    const label = IDLE_LOOP_LABELS[loop.key] || loop.label || loop.key;

    // Seed the picker's selection from the saved repo NAMES (each becomes a repo
    // target). Node selections aren't persisted server-side — they're resolved to
    // repo names on save — so the round-trip shows them as their repos.
    const initial = (loop.repos || []).map((name) => ({ kind: "repo", id: name, name }));
    const picker = targetPicker({
      repos,
      nodes,
      value: initial,
      multiple: true,
      onChange: () => {},
    });

    const toggle = el("input", {
      type: "checkbox",
      role: "switch",
      "aria-label": `Enable ${label}`,
    });
    toggle.checked = loop.enabled === true;

    editors.set(loop.key, {
      key: loop.key,
      enabled: () => toggle.checked,
      targets: () => (typeof picker.getTargets === "function" ? picker.getTargets() : []),
    });

    const head = el("div", { class: "idle-loop-head" }, [
      el("div", { class: "idle-loop-label" }, [
        el("span", {}, label),
        el("code", { class: "mono setting-key" }, loop.key),
      ]),
      el("label", { class: "switch" }, [
        toggle,
        el("span", { class: "switch-track" }, el("span", { class: "switch-thumb" })),
      ]),
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

  const saveBtn = el("button", { class: "btn primary", type: "button" }, [
    icon("check"),
    el("span", {}, "Save idle loops"),
  ]);
  card.appendChild(el("div", { class: "btn-row settings-actions" }, [saveBtn]));

  saveBtn.addEventListener("click", () => {
    runAsyncAction(saveBtn, "Saving…", async () => {
      // Resolve every loop's selection to repo NAMES (nodes expand to their repos),
      // de-duplicating so a repo named twice (directly + via a scope) collapses.
      const loops = [];
      for (const ed of editors.values()) {
        const names = new Set();
        for (const target of ed.targets()) {
          const resolved = await resolveTargetRepos(target);
          for (const name of resolved) names.add(name);
        }
        loops.push({ key: ed.key, enabled: ed.enabled(), repos: [...names] });
      }
      await api("PUT", "/api/idle-loops", { loops });
      toast(`Saved ${loops.length} idle loop${loops.length === 1 ? "" : "s"}.`, { ok: true });
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
    editors.set(s.key, { read: () => select.value });
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

  const dialog = el(
    "div",
    { class: "reject-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Reject reason" },
    [
      el("h2", { class: "reject-dialog-title" }, `Reason for ${verb}`),
      el("p", { class: "reject-dialog-hint" }, "Tap a reason or type your own."),
      chipRow,
      input,
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
    close();
    onConfirm(value);
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

  // Gate console header — frames the human gate and the decision controls.
  const riskCount = (lvl) => tickets.filter((t) => t.risk_level === lvl).length;
  wrap.appendChild(
    el("div", { class: "card panel gate-console" }, [
      el("div", { class: "gate-main" }, [
        el("span", { class: "gate-lamp" }),
        el("div", {}, [
          el("div", { class: "gate-title" }, "You hold the gate"),
          el(
            "div",
            { class: "gate-sub" },
            `${tickets.length} ${tickets.length === 1 ? "change is" : "changes are"} waiting on your sign-off. Nothing merges until you approve it.`,
          ),
        ]),
      ]),
      el("div", { class: "gate-aside" }, [
        el("div", { class: "gate-risk" }, [
          riskCount("critical")
            ? el("span", { class: "gr critical" }, `${riskCount("critical")} critical`)
            : null,
          riskCount("high") ? el("span", { class: "gr high" }, `${riskCount("high")} high`) : null,
          riskCount("medium")
            ? el("span", { class: "gr medium" }, `${riskCount("medium")} medium`)
            : null,
          riskCount("low") ? el("span", { class: "gr low" }, `${riskCount("low")} low`) : null,
        ]),
        el("div", { class: "gate-keys" }, [
          el("span", { class: "kbd" }, "j"),
          el("span", { class: "kbd" }, "k"),
          el("span", { class: "gate-keys-label" }, "move"),
          el("span", { class: "kbd" }, "a"),
          el("span", { class: "gate-keys-label" }, "approve"),
          el("span", { class: "kbd" }, "r"),
          el("span", { class: "gate-keys-label" }, "rework"),
        ]),
      ]),
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
    const reject = (to) => {
      const verb = to === "cancelled" ? "abandoning (won't do)" : `rejecting to ${to}`;
      openRejectDialog({
        verb,
        onConfirm: (reason) =>
          guard(async () => {
            await api("POST", `/tickets/${t.id}/review/reject`, { to, reason });
            toast(to === "cancelled" ? "Marked won't do" : `Rejected to ${to}`, { ok: true });
            router();
          }),
      });
    };

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
      dodChecklist(evidence),
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
    // A modal (reject dialog, command palette, detail sheet, move-menu) owns the
    // keyboard while open — never let a queue shortcut fire underneath it. The
    // reject dialog in particular lives on document.body, so this observer's
    // detach never runs for it; without this guard `a`/`r` on a focused reject
    // chip would approve/reject the wrong ticket. Must precede the j/k/a/r branch.
    if (isModalOpen()) return;
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

  wrap.appendChild(renderScopeGraph(nodes, edges));
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

function renderScopeGraph(nodes, edges) {
  const card = el("div", { class: "card panel" }, [
    panelHead("Scope graph", "contains \u00b7 depends on"),
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
  const cols = [];
  for (const n of nodes) {
    const d = depthOf(n.id);
    (cols[d] = cols[d] || []).push(n);
  }
  const pos = new Map();
  cols.forEach((list, ci) => {
    (list || []).sort((a, b) => a.name.localeCompare(b.name));
    (list || []).forEach((n, ri) =>
      pos.set(n.id, { x: PADX + ci * (NODE_W + COLG), y: PADT + ri * (NODE_H + ROWG), n }),
    );
  });
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
      ci === 0 ? "Roots" : `Depth ${ci}`,
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
          class: "btn",
          type: "button",
          onclick: () => openSpecBuild(),
        },
        [icon("spark"), el("span", {}, "Author a spec")],
      ),
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
        focusId === epic.id || epics.length === 1,
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
    body.appendChild(phaseProgress(byPhase, phases));
    body.appendChild(renderEpicDag(byPhase, phases, depViewById));
  }
  details.appendChild(body);
  return details;
}

/** Phase progress strip — one segment per phase, filled by its done-ratio, so
 *  you can see the gate front advancing through the plan at a glance. */
function phaseProgress(byPhase, phases) {
  const active = new Set(["in_progress", "claimed", "in_review", "in_testing", "ready_for_merge"]);
  return el(
    "div",
    { class: "phase-strip" },
    phases.map((p) => {
      const tix = byPhase.get(p) || [];
      const done = tix.filter((t) => t.status === "done").length;
      const pct = tix.length ? Math.round((done / tix.length) * 100) : 0;
      const state =
        tix.length && done === tix.length
          ? "done"
          : tix.some((t) => active.has(t.status))
            ? "active"
            : "idle";
      return el("div", { class: `phase-seg is-${state}` }, [
        el("div", { class: "ps-top" }, [
          el("span", { class: "ps-label" }, `Phase ${p + 1}`),
          el("span", { class: "ps-frac mono" }, `${done}/${tix.length}`),
        ]),
        el("div", { class: "ps-bar" }, el("i", { style: `width:${pct}%` })),
      ]);
    }),
  );
}

/** The dependency DAG — phases laid out as columns (topological layers), tickets
 *  as nodes, and dependsOn edges drawn between them. Satisfied edges are solid
 *  cyan; unmet edges are dashed amber (the live gate front). */
function renderEpicDag(byPhase, phases, depViewById) {
  const NODE_W = 208,
    NODE_H = 84,
    COLG = 70,
    ROWG = 18,
    PADX = 12,
    PADT = 42,
    PADB = 14;
  const cols = phases.map((p) =>
    (byPhase.get(p) || []).slice().sort((a, b) => (a.number || 0) - (b.number || 0)),
  );
  const pos = new Map();
  cols.forEach((tix, ci) => {
    const x = PADX + ci * (NODE_W + COLG);
    tix.forEach((t, ri) => pos.set(t.id, { x, y: PADT + ri * (NODE_H + ROWG), t }));
  });
  const maxRows = Math.max(1, ...cols.map((c) => c.length));
  const width = PADX * 2 + phases.length * NODE_W + Math.max(0, phases.length - 1) * COLG;
  const height = PADT + maxRows * (NODE_H + ROWG) - ROWG + PADB;

  // edges (drawn behind the nodes)
  let paths = "";
  for (const [id, { x, y }] of pos) {
    for (const d of depViewById.get(id) || []) {
      const from = pos.get(d.depends_on_ticket_id);
      if (!from) continue;
      const x1 = from.x + NODE_W,
        y1 = from.y + NODE_H / 2,
        x2 = x,
        y2 = y + NODE_H / 2;
      const mx = (x1 + x2) / 2;
      paths += `<path class="edge ${d.satisfied ? "sat" : "pend"}" d="M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}"/>`;
    }
  }
  const svg = el("div", {
    class: "dag-edges",
    html: `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="none">${paths}</svg>`,
  });

  const labels = phases.map((p, ci) =>
    el(
      "div",
      { class: "dag-collabel", style: `left:${PADX + ci * (NODE_W + COLG)}px;width:${NODE_W}px` },
      [
        el("span", { class: "dcl-num" }, `Phase ${p + 1}`),
        ci > 0 ? el("span", { class: "dcl-gate" }, "gated") : null,
      ],
    ),
  );

  const nodes = [];
  for (const [id, { x, y, t }] of pos) {
    const blockers = (depViewById.get(id) || []).filter((d) => !d.satisfied);
    nodes.push(
      el(
        "a",
        {
          class: `dag-node status-${t.status}`,
          href: `#/ticket/${t.id}`,
          style: `left:${x}px;top:${y}px;width:${NODE_W}px;height:${NODE_H}px`,
        },
        [
          el("div", { class: "dn-top" }, [
            el("span", { class: "dn-num mono" }, t.number != null ? `#${t.number}` : "—"),
            statusBadge(t.status),
          ]),
          el("div", { class: "dn-title" }, t.title),
          blockers.length
            ? el("div", { class: "dn-block" }, [
                icon("clock", "dn-block-ico"),
                `waiting on ${blockers.map((b) => (b.number != null ? "#" + b.number : "?")).join(", ")}`,
              ])
            : null,
        ],
      ),
    );
  }

  return el("div", { class: "dag-scroll" }, [
    el("div", { class: "dag", style: `width:${width}px;height:${height}px` }, [
      svg,
      ...labels,
      ...nodes,
    ]),
  ]);
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
          el(
            "button",
            { class: "icon-btn", type: "button", "aria-label": "Close", onclick: closePlanBuild },
            el("span", { html: "✕" }),
          ),
        ]),
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
  const { scrim, input } = ensurePlanBuild();
  // `mode` is the start toggle: "new" (greenfield app) vs "extend" (add tickets
  // to an existing scope node / epic). `target` holds the chosen extend node and
  // becomes the `context` sent to the decomposer on the first turn. `nodes` is
  // loaded lazily for the extend picker; an empty list just hides the option.
  // `sessionId` is the server-side session id (null when persistence unavailable).
  // `spec` (SPEC-DRIVEN): when opened from a FROZEN spec via buildFromFrozenSpec(),
  // its clauses ride along on every plan-build POST so the decomposer satisfies each
  // clause and stamps spec_clause_id provenance on the ACs — without this the whole
  // spec→plan→coverage traceability chain is dead (the spec never reaches decompose).
  planBuildState = {
    history: [],
    plan: null,
    busy: false,
    brief: opts.brief || null,
    mode: "new",
    target: null,
    nodes: [],
    repos: [],
    sessionId: null,
    spec: Array.isArray(opts.spec) && opts.spec.length ? opts.spec : null,
  };
  renderPlanBuildLog();
  scrim.classList.add("open");
  document.addEventListener("keydown", planBuildKeydown);
  // Seeded from a spec: pre-fill the brief so the user can immediately "Build the tickets".
  if (planBuildState.brief && input) input.value = planBuildState.brief;
  setTimeout(() => input.focus(), 50);
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
        renderPlanBuildLog();
        planBuildEls.input.focus();
      },
    });
    children.push(
      el("div", { class: "field pb-extend-field" }, [el("label", {}, "Extend"), picker]),
    );
  }

  return el("div", { class: "pb-mode" }, children);
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
        `${tickets.length} ticket${tickets.length === 1 ? "" : "s"} — create as draft to review first, or create & ready to queue them for delivery now (the AC gate still applies per ticket).`,
      ),
      el("div", { class: "pb-confirm-actions" }, [
        el(
          "button",
          {
            class: "btn ghost",
            type: "button",
            onclick: () => confirmPlanBuild(plan),
          },
          [icon("check"), el("span", {}, "Create as draft")],
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
        return rest;
      }
      return t;
    });
    const res = await api("POST", "/epics", { epic: plan.epic, tickets });
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
          icon("spark", "pb-head-ico"),
          el("div", {}, [
            el("div", { class: "pb-title" }, "Author a spec"),
            el("div", { class: "pb-sub dim" }, "Brief → editable clauses → freeze"),
          ]),
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
            { class: "icon-btn", type: "button", "aria-label": "Close", onclick: closeSpecBuild },
            el("span", { html: "✕" }),
          ),
        ]),
      ]),
      el("div", { class: "pb-guardrail" }, [
        icon("alert", "pb-guard-ico"),
        el(
          "span",
          {},
          "Proposes only. Nothing is created until you press Create spec — and nothing is locked until you Freeze.",
        ),
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
  specBuildState = {
    history: [],
    draft: null,
    createdSpec: null,
    busy: false,
    brief: null,
    title: "",
  };
  renderSpecBuildLog();
  scrim.classList.add("open");
  document.addEventListener("keydown", specBuildKeydown);
  setTimeout(() => input.focus(), 50);
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
        el("p", {}, "Describe the product in one line and I'll draft a spec — for example:"),
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
  const wrap = el("div", { class: "pb-proposal sb-draft card card-amber" });

  wrap.appendChild(
    el("div", { class: "pb-proposal-head" }, [
      badge(frozen ? "frozen" : created ? "created" : "draft", "no-dot"),
      el("h3", { class: "pb-proposal-name" }, "Proposed spec"),
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
  wrap.appendChild(
    el("div", { class: "field sb-title-field" }, [el("label", {}, "Title"), titleInput]),
  );

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
        `${clauses.length} clause${clauses.length === 1 ? "" : "s"} — created as a draft spec you can freeze when ready.`,
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
        "Spec frozen — clauses are immutable. Build the tickets from it to carry clause provenance into the plan.",
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
    el("span", { class: "pb-ticket-idx tabnum" }, `#${i + 1}`),
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
    toast("Spec created as draft — freeze it when ready.", { ok: true });
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
    toast("Spec frozen — clauses are now immutable.", { ok: true });
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
  openPlanBuild({ spec: clauses, brief });
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

async function renderSpecList() {
  const res = await api("GET", "/specs");
  const specs = res.specs || [];

  const wrap = el("div", { class: "view", dataset: { view: "specs" } });
  wrap.appendChild(
    viewHero({
      image: "assets/bg/hero-spec.jpg",
      eyebrow: "SPEC LIBRARY",
      title: "Specs define intent. Code delivers it.",
      subtitle:
        "Each spec is a frozen statement of product intent. Trace every clause through to acceptance criteria and see the coverage gaps.",
    }),
  );
  wrap.appendChild(
    el("div", { class: "view-toolbar" }, [
      el("div", { class: "view-toolbar-actions" }, [
        el("button", { class: "btn primary", type: "button", onclick: () => openSpecBuild() }, [
          icon("spark"),
          el("span", {}, "Author a spec"),
        ]),
      ]),
    ]),
  );

  if (specs.length === 0) {
    wrap.appendChild(
      emptyState(
        "No specs yet",
        "Author a spec from a brief — Dispatch drafts testable clauses you edit, then freeze.",
        "specs",
      ),
    );
    return wrap;
  }

  // Best-effort coverage: fetch each spec's coverage rollup in parallel so the
  // stats row can report real covered% / gaps. A failed fetch just drops that
  // spec from the coverage maths (the stat degrades to "—", never crashes).
  const coverages = await Promise.all(
    specs.map((s) =>
      api("GET", `/specs/${encodeURIComponent(s.id)}/coverage`)
        .then((r) => (r && r.coverage) || null)
        .catch(() => null),
    ),
  );
  const covById = new Map(specs.map((s, i) => [s.id, coverages[i]]));

  wrap.appendChild(specStatsRow(specs, coverages));

  // Newest spec (by updated_at) is the primary card — it gets the amber rail.
  const newestId = specs
    .slice()
    .sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))[0]?.id;

  const list = el("div", { class: "spec-list" });
  for (const spec of specs)
    list.appendChild(
      renderSpecCard(spec, { coverage: covById.get(spec.id), isPrimary: spec.id === newestId }),
    );
  wrap.appendChild(list);
  return wrap;
}

/** A rollup {total,covered,orphans} from a coverage payload, defensively read. */
function specCoverageRollup(coverage) {
  const src =
    coverage && coverage.rollup && typeof coverage.rollup === "object" ? coverage.rollup : null;
  if (!src) return null;
  const total = Number(src.total) || 0;
  const covered = Number(src.covered) || 0;
  const orphans = Array.isArray(src.orphans) ? src.orphans.length : Number(src.orphans) || 0;
  return { total, covered, orphans };
}

/** Stats row for the spec library: total specs · avg coverage · gaps · updated. */
function specStatsRow(specs, coverages) {
  const rollups = coverages.map(specCoverageRollup).filter(Boolean);
  const withClauses = rollups.filter((r) => r.total > 0);
  const covPcts = withClauses.map((r) => Math.round((r.covered / r.total) * 100));
  const avgCoverage = covPcts.length
    ? Math.round(covPcts.reduce((a, b) => a + b, 0) / covPcts.length)
    : null;
  const gaps = rollups.length ? rollups.reduce((a, r) => a + r.orphans, 0) : null;

  const newest = specs
    .slice()
    .filter((s) => s.updated_at)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];

  return el("div", { class: "spec-stats kpi-row" }, [
    specStatCard({ label: "Total specs", value: String(specs.length), unit: "in library" }),
    specStatCard({
      label: "Coverage",
      value: avgCoverage == null ? "—" : String(avgCoverage),
      unit: avgCoverage == null ? "no data" : "% avg covered",
      tone: "ok",
      series: covPcts.length > 1 ? covPcts : null,
    }),
    specStatCard({
      label: "Gaps",
      value: gaps == null ? "—" : String(gaps),
      unit: gaps == null ? "no data" : "orphan clauses",
      tone: gaps ? "danger" : "ok",
    }),
    specStatCard({
      label: "Last updated",
      value: newest ? fmtRelative(newest.updated_at) : "—",
      unit: newest && newest.target_repo ? newest.target_repo : "—",
      tone: "amber",
      small: true,
    }),
  ]);
}

/**
 * A stat tile reusing the KPI card's visual language (label · big value · unit ·
 * optional sparkline) but rendered as a non-navigating div — the spec library
 * has no single "drill" target for an aggregate stat.
 */
function specStatCard({ label, value, unit, tone = "accent", series, small = false }) {
  return el("div", { class: `kpi tone-${tone}${small ? " kpi-sm" : ""}` }, [
    el("div", { class: "kpi-top" }, [el("span", { class: "kpi-label" }, label)]),
    el("div", { class: "kpi-figure" }, [
      el("span", { class: "kpi-val tabnum" }, value),
      unit ? el("span", { class: "kpi-unit" }, unit) : null,
    ]),
    series && series.length > 1 ? el("div", { class: "kpi-spark", html: svgSpark(series) }) : null,
  ]);
}

/** Keyword-match a spec title to a scanner-frame line icon. */
function specThumbIcon(title) {
  const t = (title || "").toLowerCase();
  if (/\b(auth|password|login|sign[- ]?in|sign[- ]?up|credential|token|oauth|secur)/.test(t))
    return "lock";
  if (/\b(data|residency|storage|region|geo|locale|country|tenant|migrat)/.test(t)) return "globe";
  if (/\b(rate|throttle|limit|quota|budget|throughput|latency|perf|speed)/.test(t)) return "gauge";
  return "doc";
}

/** Four amber L-shaped corner brackets framing a spec thumbnail icon. */
function specThumb(title) {
  return el("span", { class: "spec-thumb" }, [
    el("i", { class: "tc tl" }),
    el("i", { class: "tc tr" }),
    el("i", { class: "tc bl" }),
    el("i", { class: "tc br" }),
    icon(specThumbIcon(title), "spec-thumb-icon"),
  ]);
}

/** One spec = a card linking to its coverage trace, with a scanner-frame thumb. */
function renderSpecCard(spec, { coverage, isPrimary = false } = {}) {
  const count = specClauseCount(spec);
  // Status dot: frozen (reaching agents) = amber, draft (live/authoring) = green.
  const statusLabel = SPEC_STATUS_LABEL[spec.status] || spec.status;
  const rollup = specCoverageRollup(coverage);
  return el(
    "button",
    {
      class: `spec-card${isPrimary ? " spec-card--primary" : ""}`,
      type: "button",
      dataset: { specId: spec.id, status: spec.status },
      onclick: () => navigate(`#/specs/${encodeURIComponent(spec.id)}`),
    },
    [
      specThumb(spec.title),
      el("div", { class: "spec-card-body" }, [
        el("div", { class: "spec-card-head" }, [
          el("span", { class: "spec-card-title" }, spec.title),
          el("span", { class: `spec-card-status status-${spec.status}` }, [
            el("span", { class: "scs-dot" }),
            statusLabel,
          ]),
        ]),
        spec.brief ? el("p", { class: "spec-card-brief dim" }, spec.brief) : null,
        el("div", { class: "spec-card-meta dim" }, [
          el("span", {}, `${count} clause${count === 1 ? "" : "s"}`),
          spec.target_repo ? el("span", { class: "tag-chip" }, spec.target_repo) : null,
          rollup && rollup.total > 0
            ? el(
                "span",
                { class: "spec-card-cov mono" },
                `${Math.round((rollup.covered / rollup.total) * 100)}% covered`,
              )
            : null,
          spec.updated_at
            ? el("span", { class: "spec-card-updated" }, fmtRelative(spec.updated_at))
            : null,
        ]),
      ]),
      icon("chevron", "spec-card-chevron"),
    ],
  );
}

async function renderSpecDetail(specId) {
  const res = await api("GET", `/specs/${encodeURIComponent(specId)}/coverage`);
  const cov = res && res.coverage;

  const wrap = el("div", { class: "view", dataset: { view: "specs" } });

  // Defensive: a missing / empty / malformed coverage payload must render a
  // clean empty state, not blank the whole spec view (an unguarded `cov.rollup`
  // would throw, leaving the router's skeleton stuck on screen). Guard on shape
  // rather than exact fields — other work may extend this payload.
  if (!cov || typeof cov !== "object") {
    wrap.appendChild(
      viewHead("Spec", "Coverage", [
        el("button", { class: "btn", type: "button", onclick: () => navigate("#/specs") }, [
          icon("arrow"),
          el("span", {}, "All specs"),
        ]),
      ]),
    );
    wrap.appendChild(
      emptyState(
        "Coverage unavailable",
        "This spec's coverage report could not be loaded. It may have been removed, or the report is still being built.",
        "specs",
      ),
    );
    return wrap;
  }

  const rollupSrc = cov.rollup && typeof cov.rollup === "object" ? cov.rollup : {};
  const orphans = Array.isArray(rollupSrc.orphans) ? rollupSrc.orphans : [];
  const r = {
    total: Number(rollupSrc.total) || 0,
    covered: Number(rollupSrc.covered) || 0,
    satisfied: Number(rollupSrc.satisfied) || 0,
    orphans,
  };
  const clauses = Array.isArray(cov.clauses) ? cov.clauses : [];
  wrap.appendChild(
    viewHead(cov.title || "Spec", `Spec · ${SPEC_STATUS_LABEL[cov.status] || cov.status || "—"}`, [
      el("button", { class: "btn", type: "button", onclick: () => navigate("#/specs") }, [
        icon("arrow"),
        el("span", {}, "All specs"),
      ]),
      cov.scope_node_id
        ? el(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: () => navigate(`#/epics/${encodeURIComponent(cov.scope_node_id)}`),
            },
            [icon("epics"), el("span", {}, "Open epic")],
          )
        : null,
    ]),
  );

  // Rollup: covered / satisfied / orphans — the at-a-glance coverage health.
  wrap.appendChild(
    el("div", { class: "spec-rollup", dataset: { total: String(r.total) } }, [
      specStat("Clauses", r.total, "total"),
      specStat("Covered", `${r.covered}/${r.total}`, "covered"),
      specStat("Satisfied", `${r.satisfied}/${r.total}`, "satisfied"),
      specStat("Gaps", r.orphans.length, r.orphans.length > 0 ? "gap" : "ok"),
    ]),
  );

  // Coverage gaps: orphan clauses (no covering AC) called out first.
  if (r.orphans.length > 0) {
    const orphanClauses = clauses.filter((c) => c.orphan);
    wrap.appendChild(
      el("div", { class: "coverage-gaps", dataset: { count: String(orphanClauses.length) } }, [
        el("div", { class: "coverage-gaps-head" }, [
          icon("alert"),
          el(
            "strong",
            {},
            `${orphanClauses.length} coverage gap${orphanClauses.length === 1 ? "" : "s"}`,
          ),
          el("span", { class: "dim" }, "— clauses with no acceptance criterion covering them"),
        ]),
        el(
          "ul",
          { class: "coverage-gaps-list" },
          orphanClauses.map((c) =>
            el("li", { dataset: { clauseId: c.clause_id } }, [
              badge(CLAUSE_KIND_LABEL[c.kind] || c.kind, `clause-kind kind-${c.kind}`),
              el("span", {}, c.text),
            ]),
          ),
        ),
      ]),
    );
  }

  // The trace: one block per clause → covering ACs → satisfied/open.
  const trace = el("div", { class: "spec-trace" });
  for (const clause of clauses) trace.appendChild(renderClauseTrace(clause));
  wrap.appendChild(trace);

  if (cov.gate_enabled) {
    wrap.appendChild(
      el(
        "p",
        { class: "dim section-note" },
        "Spec-coverage DoD gate is ARMED (advisory): a clause with no satisfied AC will be flagged.",
      ),
    );
  }
  return wrap;
}

function specStat(label, value, tone) {
  return el("div", { class: "spec-stat", dataset: { tone } }, [
    el("span", { class: "spec-stat-value" }, String(value)),
    el("span", { class: "spec-stat-label dim" }, label),
  ]);
}

/** One clause's trace row: kind + text, coverage state, bounce count, its ACs. */
function renderClauseTrace(clause) {
  const state = clause.orphan ? "orphan" : clause.satisfied ? "satisfied" : "open";
  const block = el("div", {
    class: "spec-clause",
    dataset: {
      clauseId: clause.clause_id,
      state,
      covered: String(clause.covered),
      orphan: String(clause.orphan),
      satisfied: String(clause.satisfied),
    },
  });

  const head = el("div", { class: "spec-clause-head" }, [
    badge(CLAUSE_KIND_LABEL[clause.kind] || clause.kind, `clause-kind kind-${clause.kind}`),
    el("span", { class: "spec-clause-text" }, clause.text),
  ]);
  const tags = el("div", { class: "spec-clause-tags" });
  // Coverage state chip: green satisfied / amber open / red gap.
  tags.appendChild(
    clause.orphan
      ? badge("Gap — no AC", "clause-state state-orphan")
      : clause.satisfied
        ? badge("Satisfied", "clause-state state-satisfied")
        : badge("Open", "clause-state state-open"),
  );
  if (clause.bounce_count > 0) {
    tags.appendChild(badge(`bounced ${clause.bounce_count}×`, "clause-bounce no-dot"));
  }
  if (clause.lore_status && clause.lore_status !== "unknown") {
    const label = LORE_STATUS_LABEL[clause.lore_status] || clause.lore_status;
    tags.appendChild(
      badge(
        `lore: ${clause.lore_status}${label ? ` (${label})` : ""}`,
        `lore-${clause.lore_status === "active" ? "active" : "draft"} no-dot`,
      ),
    );
  }
  head.appendChild(tags);
  block.appendChild(head);
  if (clause.rationale) {
    block.appendChild(el("p", { class: "spec-clause-rationale dim" }, clause.rationale));
  }

  if (clause.orphan) {
    block.appendChild(
      el(
        "p",
        { class: "spec-clause-empty dim" },
        "No acceptance criterion covers this clause — it is a coverage gap.",
      ),
    );
    return block;
  }

  const acs = el(
    "div",
    { class: "spec-clause-acs" },
    (Array.isArray(clause.covering_acs) ? clause.covering_acs : []).map((ac) =>
      el("div", { class: "spec-ac", dataset: { satisfied: String(ac.satisfied) } }, [
        badge(
          ac.satisfied ? "satisfied" : ac.ac_status,
          `ac-${ac.satisfied ? "satisfied" : "pending"}`,
        ),
        el("span", { class: "spec-ac-text" }, ac.ac_text),
        el(
          "a",
          { class: "spec-ac-ticket", href: `#/ticket/${encodeURIComponent(ac.ticket_id)}` },
          ac.ticket_number != null ? `#${ac.ticket_number}` : ac.ticket_title,
        ),
      ]),
    ),
  );
  block.appendChild(acs);
  return block;
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
  const flaggedCount = lore.filter((l) => l && l.flagged).length;
  const card = el("div", { class: "card", dataset: { section: "lore" } }, [
    el("h2", {}, [
      "Lore",
      res && res.available !== false ? el("span", { class: "count" }, String(lore.length)) : null,
      // Learn-loop signal at a glance: how many conventions the loop flagged for review.
      flaggedCount > 0 ? badge(`${flaggedCount} flagged`, "lore-flagged") : null,
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
      ]),
    ),
  );
  card.appendChild(list);
  return card;
}

// --- Wiring -----------------------------------------------------------------

// Power-on: the room boots once. The grid draws in, the rail items rack down
// one by one, the LIVE lamp ignites, then the first view comes up. CSS owns the
// choreography via the `.booting` flag; we just raise and lower it.
if (!prefersReducedMotion()) {
  document.documentElement.classList.add("booting");
  setTimeout(() => document.documentElement.classList.remove("booting"), 1600);
}

adoptTokenFromUrl(); // one-scan token pickup (QR) before the first authed call
buildChrome();
window.addEventListener("hashchange", router);
router();
