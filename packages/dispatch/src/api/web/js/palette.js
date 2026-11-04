// Command palette (cmd-K).
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { readOnly } from "./access.js";
import { effectiveTheme, setTheme, storedTheme, toggleTheme } from "./chrome.js";
import { clear, el } from "./dom.js";
import { icon } from "./icons.js";
import { navigate } from "./router.js";
import { statusLabel } from "./status.js";
import { allTickets, openPlanBuild, openSpecBuild } from "../app.js";

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
      label: "Squad",
      hint: "agent names · shirt numbers · the club",
      icon: "squad",
      run: () => navigate("#/squad"),
    },
    {
      group: "Go",
      label: "Floor",
      hint: "the factory floor · parcels · robots · the jam bay",
      icon: "floor",
      run: () => navigate("#/floor"),
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
    tickets = (await allTickets()).tickets;
  } catch {
    // Palette still works for navigation if the list call fails.
  }
  // Every ticket is a "#N" lookup target; only the first 60 join the fuzzy list.
  const ticketItems = tickets.map((t, i) => ({
    group: "Tickets",
    label: `${t.number != null ? `#${t.number} ` : ""}${t.title}`,
    hint: statusLabel(t.status, t.landing_state),
    icon: "ticket",
    number: t.number != null ? String(t.number) : null,
    lookupOnly: i >= 60,
    run: () => navigate(`#/ticket/${t.id}`),
  }));
  // A read token creates nothing: the palette offers it no Create actions.
  return [...(readOnly() ? base.filter((x) => x.group !== "Create") : base), ...ticketItems];
}

function ensurePalette() {
  if (paletteEls) return paletteEls;
  const input = el("input", {
    class: "palette-input",
    type: "text",
    placeholder: "Jump to a view, ticket or action…",
    "aria-label": "Command palette",
  });
  // tabindex -1: a scrolling list is a Tab stop in Chromium, and from there Tab
  // walked on to the page behind the scrim.
  const list = el("ul", { class: "palette-list", tabindex: "-1" });
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
  // A modal keeps focus: wherever focus is inside it (the list after a click, say),
  // Esc closes it and Tab returns to the one field, never to the page behind.
  palette.addEventListener("keydown", (e) => {
    if (e.target === input) return; // the field's own handler has it
    if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    } else if (e.key === "Tab") {
      e.preventDefault();
      input.focus();
    } else paletteKeydown(e);
  });

  document.body.appendChild(scrim);
  paletteEls = { scrim, palette, input, list };
  return paletteEls;
}

let paletteAllItems = [];
let paletteReturnFocus = null;
async function openPalette() {
  const { scrim, input } = ensurePalette();
  if (!scrim.classList.contains("open")) paletteReturnFocus = document.activeElement;
  scrim.classList.add("open");
  input.value = "";
  input.focus();
  paletteAllItems = await buildPaletteSources();
  // Filter by what is in the box NOW: someone who typed while the tickets loaded
  // must not get the unfiltered list (Enter then opened Overview, not their ticket).
  renderPaletteList(input.value);
}
function closePalette() {
  if (!paletteEls || !paletteEls.scrim.classList.contains("open")) return;
  paletteEls.scrim.classList.remove("open");
  // Focus goes back where it was (the Search button, or the page) when it is still there.
  const back = paletteReturnFocus;
  paletteReturnFocus = null;
  if (back && back.isConnected && back !== document.body && typeof back.focus === "function")
    back.focus();
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
/**
 * The palette's matches for a query. A leading "#" is a ticket lookup, not a fuzzy
 * search: "#7" lists ticket #7 and then the numbers that start with 7 (#70, #71…),
 * never #17 or a label that merely holds a 7; "#login" searches ticket titles only.
 * Anything else is the loose subsequence match, with a bare "12" still ranking
 * ticket #12 first.
 */
function paletteMatches(items, query) {
  const hash = /^\s*#\s*(.*?)\s*$/.exec(query);
  if (hash) {
    const rest = hash[1];
    const tickets = items.filter((it) => it.group === "Tickets");
    if (/^\d+$/.test(rest)) {
      const hits = tickets.filter((it) => it.number != null && it.number.startsWith(rest));
      return hits.sort(
        (a, b) =>
          Number(b.number === rest) - Number(a.number === rest) ||
          Number(a.number) - Number(b.number),
      );
    }
    return tickets.filter((it) => !it.lookupOnly && fuzzyMatch(rest, it.label));
  }
  const out = items.filter(
    (it) => !it.lookupOnly && fuzzyMatch(query, it.label + " " + (it.hint || "")),
  );
  // "12" names a ticket: put that exact number first, ahead of fuzzy hits.
  const num = /^\s*(\d+)\s*$/.exec(query);
  if (num) {
    const exact = out.findIndex((it) => it.number === num[1]);
    if (exact > 0) out.unshift(...out.splice(exact, 1));
  }
  return out;
}
function renderPaletteList(query) {
  const { list } = ensurePalette();
  clear(list);
  paletteItems = paletteMatches(paletteAllItems, query);
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
  } else if (e.key === "Tab") {
    e.preventDefault(); // the field is the dialog's only Tab stop
  }
}
function scrollPaletteActive() {
  const node = paletteEls.list.querySelector(".palette-item.active");
  if (node) node.scrollIntoView({ block: "nearest" });
}

export { paletteEls, openPalette, closePalette };
