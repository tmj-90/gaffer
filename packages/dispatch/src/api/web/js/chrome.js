// Theme (per-viewer kit) and the app chrome: the club header and the phone bottom nav.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { authToken } from "./api.js";
import { canEditSquad, ensureSquad, squad } from "./club.js";
import { appbar, bottomnav, clear, el } from "./dom.js";
import { paintFreshness } from "./freshness.js";
import { crest, icon } from "./icons.js";
import { clubLetters, clubName } from "./kit.js";
import { startAutoRefresh } from "./live.js";
import { logout } from "./login.js";
import { openPalette } from "./palette.js";
import { activeArea, router } from "./router.js";
import { closeSheet, openSheet } from "./sheet.js";
import { openClubSheet } from "./views/squad.js";

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
  { id: "squad", label: "Squad", icon: "squad" },
  { id: "floor", label: "Floor", icon: "floor" },
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
  // The crest and the club's name (GET /api/club, painted by paintBrand once read).
  const brand = el("div", { class: "brand" });

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
  paintBrand();
  ensureSquad().then(paintBrand);
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
 * The header crest: the club's short name on the badge and its name beside it
 * (GET /api/club; "Gaffer" until one is set). With a full token the badge is a
 * button that opens "Name your club"; a read token sees the crest, no editor.
 */
function paintBrand() {
  const brand = appbar && appbar.querySelector(".brand");
  if (!brand) return;
  const name = clubName();
  const letters = clubLetters();
  const badge = canEditSquad()
    ? el(
        "button",
        {
          class: "crest-btn",
          type: "button",
          "aria-label": `Name your club (${name})`,
          "aria-haspopup": "dialog",
          title: "Name your club",
          onclick: () => openClubSheet(),
        },
        crest("crest", 34, 40, letters),
      )
    : el("span", { class: "crest-btn is-static" }, crest("crest", 34, 40, letters));
  const sub = brand.querySelector("#brand-sub");
  const subText = sub && !(squad.club && squad.club.name) ? sub.textContent : "";
  brand.replaceChildren(
    badge,
    el("a", { class: "brand-t", href: "#/overview", "aria-label": `${name} — Overview` }, [
      el("span", { class: "brand-name" }, name),
      el("span", { class: "brand-sub", id: "brand-sub" }, subText),
    ]),
  );
  fitNav();
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
 * (Settings, Health, Floor, Squad, Memory, Specs, Map, Epics), then Work. Overview, Review —
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
  document.removeEventListener("focusin", navMenuFocus);
}
/** Focus that moved outside the menu (Tab past its last item) closes it. */
function navMenuFocus(e) {
  if (navMenuEl && !navMenuEl.contains(e.target) && !e.target.closest?.(".nav-more"))
    closeNavMenu();
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
  document.addEventListener("focusin", navMenuFocus);
  // A press inside the menu is not focus leaving it: Safari (macOS and iOS) gives a
  // clicked link or button no focus, so its mousedown blurs the item focused on open
  // with no relatedTarget, and closing then would remove the menu before the click.
  let pressing = false;
  navMenuEl.addEventListener("pointerdown", () => {
    pressing = true;
    setTimeout(() => (pressing = false), 1000);
  });
  // Tab past the last item leaves the document (the menu is the body's last child):
  // no focusin follows, so the menu's own focusout closes it.
  navMenuEl.addEventListener("focusout", (e) => {
    const to = e.relatedTarget;
    if (pressing && !to) return;
    if (!to || (!navMenuEl?.contains(to) && !to.closest?.(".nav-more"))) closeNavMenu();
  });
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

export {
  storedTheme,
  effectiveTheme,
  setTheme,
  toggleTheme,
  BOTTOM_NAV_IDS,
  navCounts,
  buildChrome,
  paintBrand,
  fitNav,
  navMenuEl,
};
