// Gaffer dashboard — plain ES-module SPA over the Dispatch REST API.
// No framework, no build step. Every view calls the JSON API via fetch().
//
// Presentation: "Match Day". The gaffer is the manager and the factory is the
// club on match day — a claret club header, a stadium scoreboard, programme
// pages with kit-colour section blocks, referee's cards for status. The tokens,
// components and conventions are in css/ (see css/tokens.css) and the shared
// helpers below (el/field/icon/glyph, viewHead, panelHead, emptyState,
// skeleton, statCell, charts). Every mark carries data the server gave us.

import { agentTitle, agentWho, learnWhoami } from "./js/access.js";
import { adoptTokenFromUrl, api, authToken } from "./js/api.js";
import { buildChrome, paintBrand } from "./js/chrome.js";
import {
  ROLE_LABELS,
  applySquad,
  canEditSquad,
  ensureSquad,
  learnDisplay,
  squad,
} from "./js/club.js";
import { emptyState, viewHead } from "./js/components.js";
import { app, clear, el, field, prefersReducedMotion, svgEl } from "./js/dom.js";
import { fmtRelative, fmtTime, money, moneyW, plural } from "./js/format.js";
import { clockTime, freshness, paintFreshness } from "./js/freshness.js";
import { agentShirt, agentTag, badge, crest, glyph } from "./js/icons.js";
import {
  RGB_HOUSE_CLARET,
  RGB_HOUSE_SKY,
  applyClub,
  clubLetters,
  clubName,
  kitTokens,
  readHouseKit,
  rgbHex,
  setKitTokens,
} from "./js/kit.js";
import { autoRefreshTimer, refreshCurrentView, startLiveStream } from "./js/live.js";
import { logout, renderLogin } from "./js/login.js";
import { loadMatchDay } from "./js/matchday.js";
import { closePalette, openPalette, paletteEls } from "./js/palette.js";
import { jumpTo, routeSignal, router } from "./js/router.js";
import { closeSheet, openSheet, sheetOpen } from "./js/sheet.js";
import { appState } from "./js/state.js";
import { statusLabel } from "./js/status.js";
import { toast } from "./js/toast.js";
import { progPage } from "./js/views/programme.js";
import { deliveredBy, sinceStatus } from "./js/views/review-comments.js";
import { hashText } from "./js/views/work.js";

window.wgLogout = logout;
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
// A phone tab coming back to the foreground re-checks at once instead of
// trusting its old state: restart the stream and re-read the view.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !autoRefreshTimer) return;
  startLiveStream();
  refreshCurrentView();
});

// Global ⌘K / Ctrl+K hotkey.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (paletteEls && paletteEls.scrim.classList.contains("open")) closePalette();
    else openPalette();
  }
});

// ===========================================================================
//  The club and the squad: "Name your club" (the crest) and #/squad
// ===========================================================================

/** The crest letters the server would derive: initials of up to 4 words, or 3 letters. */
function deriveShortName(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "GAF";
  if (words.length === 1) return [...words[0]].slice(0, 3).join("").toUpperCase();
  return words
    .slice(0, 4)
    .map((w) => [...w][0])
    .join("")
    .toUpperCase();
}
/** The house kit's two colours as #rrggbb (the colour pickers' starting point). */
function houseColours() {
  const read = (token, fallback) => {
    const v = readHouseKit()[token];
    if (!v || typeof window.getComputedStyle !== "function") return rgbHex(fallback);
    const probe = el("span", { hidden: "" });
    probe.style.color = v;
    document.body.appendChild(probe);
    const m = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/.exec(window.getComputedStyle(probe).color || "");
    probe.remove();
    return m ? rgbHex([+m[1], +m[2], +m[3]]) : rgbHex(fallback);
  };
  return { primary: read("--claret", RGB_HOUSE_CLARET), secondary: read("--sky", RGB_HOUSE_SKY) };
}
/** Redraw the view on screen after a name or the club changed (its signature may not have). */
function redrawForSquad() {
  const cur = app.firstElementChild;
  if (cur && cur.dataset) delete cur.dataset.sig;
  refreshCurrentView();
}

/**
 * "Name your club": the club's name, the crest's short name (1–4 characters) and
 * the two kit colours, with a live preview of the header crest and a shirt. Save
 * PATCHes /api/club; a refusal (422) is shown under the form, never toasted. Only
 * a full token opens it (the crest is a plain badge for a read token).
 */
function openClubSheet() {
  if (!canEditSquad()) return;
  const club = squad.club || {};
  const house = houseColours();
  const dirty = { primary: false, secondary: false, cleared: false };
  const hintId = `club-hint-${++appState.fieldSeq}`;
  const nameIn = el("input", {
    type: "text",
    name: "club_name",
    class: "club-name-in",
    maxlength: "60",
    value: club.name || "",
    placeholder: "Gaffer",
    autocomplete: "off",
  });
  const shortIn = el("input", {
    type: "text",
    name: "short_name",
    class: "club-short-in",
    maxlength: "4",
    value: club.short_name || "",
    placeholder: deriveShortName(club.name || "Gaffer"),
    autocomplete: "off",
    "aria-describedby": hintId,
  });
  const primIn = el("input", {
    type: "color",
    name: "kit_primary",
    class: "club-kit-in",
    value: club.kit_primary || house.primary,
  });
  const secIn = el("input", {
    type: "color",
    name: "kit_secondary",
    class: "club-kit-in",
    value: club.kit_secondary || house.secondary,
  });
  const err = el("p", { class: "form-error club-err", role: "alert", hidden: "" });
  const note = el("p", { class: "club-note", "aria-live": "polite" });
  const prevName = el("span", { class: "cp-name" });
  const prevCrest = el("span", { class: "cp-crest" });
  const prevShirt = el("span", { class: "cp-shirt" });
  const preview = el("div", { class: "club-preview", "aria-hidden": "true" }, [
    el("div", { class: "cp-bar" }, [prevCrest, prevName]),
    el("div", { class: "cp-pitch" }, [prevShirt, el("span", { class: "cp-cap" }, "Delivery 1")]),
  ]);
  const kit = () => ({
    primary: dirty.cleared ? null : dirty.primary || club.kit_primary ? primIn.value : null,
    secondary: dirty.cleared ? null : dirty.secondary || club.kit_secondary ? secIn.value : null,
  });
  const paint = () => {
    const name = nameIn.value.trim() || "Gaffer";
    const letters = shortIn.value.trim() || deriveShortName(name);
    shortIn.placeholder = deriveShortName(name);
    prevName.textContent = name;
    prevCrest.replaceChildren(crest("crest", 34, 40, letters));
    prevShirt.replaceChildren(agentShirt("Delivery 1", 56, "9"));
    const k = kit();
    const tokens = kitTokens(k.primary, k.secondary);
    setKitTokens(preview, tokens);
    note.textContent = tokens["--on-claret"]
      ? "A light kit: the words on it turn dark so they stay readable."
      : "";
  };
  nameIn.addEventListener("input", paint);
  shortIn.addEventListener("input", paint);
  primIn.addEventListener("input", () => {
    dirty.primary = true;
    dirty.cleared = false;
    paint();
  });
  secIn.addEventListener("input", () => {
    dirty.secondary = true;
    dirty.cleared = false;
    paint();
  });
  const houseBtn = el(
    "button",
    {
      class: "btn club-house",
      type: "button",
      onclick: () => {
        dirty.cleared = true;
        dirty.primary = dirty.secondary = false;
        primIn.value = house.primary;
        secIn.value = house.secondary;
        paint();
      },
    },
    "House kit",
  );
  const save = el("button", { class: "btn primary club-save", type: "submit" }, "Save");
  const form = el(
    "form",
    {
      class: "act-sheet club-form",
      novalidate: "",
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        const short = shortIn.value.trim();
        if (short && !/^[\p{L}\p{N}&.]{1,4}$/u.test(short)) {
          err.textContent =
            "The short name is 1 to 4 letters or digits ('&' and '.' allowed), no spaces.";
          err.hidden = false;
          shortIn.setAttribute("aria-invalid", "true");
          shortIn.focus();
          return;
        }
        shortIn.removeAttribute("aria-invalid");
        const body = { name: nameIn.value.trim() || null, short_name: short || null };
        if (dirty.cleared) {
          body.kit_primary = null;
          body.kit_secondary = null;
        } else {
          if (dirty.primary) body.kit_primary = primIn.value;
          if (dirty.secondary) body.kit_secondary = secIn.value;
        }
        save.disabled = true;
        try {
          const res = await api("PATCH", "/api/club", body);
          if (res && res.club) applyClub(res.club);
          closeSheet();
          toast(`Saved: ${clubName()}`, { ok: true });
          redrawForSquad();
        } catch (x) {
          if (x && x.code === "UNAUTHORIZED") return;
          if (x && (x.status === 403 || x.code === "READ_ONLY_TOKEN")) {
            squad.capability = "read";
            err.textContent = "This token can only read: naming the club needs the full token.";
            paintBrand();
          } else err.textContent = (x && x.message) || "The club could not be saved.";
          err.hidden = false;
        } finally {
          save.disabled = false;
        }
      },
    },
    [
      el(
        "p",
        { class: "act-intro" },
        "The club's name and badge head every page; the kit colours dress the header, the crest and every agent's shirt.",
      ),
      preview,
      note,
      el(
        "p",
        { class: "act-hint club-hint", id: hintId },
        "The short name is 1–4 characters, shown on the crest; leave it blank to use the club's initials.",
      ),
      el("div", { class: "form-grid cols-2" }, [
        field("Club name", nameIn),
        field("Short name", shortIn),
        field("Primary kit", primIn),
        field("Secondary kit", secIn),
      ]),
      err,
      el("div", { class: "btn-row act-actions" }, [
        save,
        houseBtn,
        el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel"),
      ]),
    ],
  );
  paint();
  openSheet("Name your club", form, { focus: nameIn });
}

/** One row of the squad table; with a full token its Rename edits it in place. */
function squadRow(a, edit) {
  const tr = el("tr", { class: "sq-row", dataset: { id: a.agent_id } });
  const reg = a.registered_name || String(a.agent_id).slice(0, 8);
  let renameBtn = null;
  const view = () => {
    const w = agentWho(a.agent_id, a.registered_name);
    renameBtn = edit
      ? el(
          "button",
          {
            class: "btn small sq-rename",
            type: "button",
            "aria-label": `Rename ${w.name} (${reg})`,
            onclick: editRow,
          },
          "Rename",
        )
      : null;
    tr.classList.remove("is-editing");
    tr.replaceChildren(
      el(
        "td",
        { class: "c-shirt", "data-label": "No." },
        el("span", { class: "sq-shirt" }, [
          agentShirt(w.name, 36, w.no),
          el(
            "span",
            { class: "sq-num tabnum" },
            a.shirt_number != null ? String(a.shirt_number) : "—",
          ),
        ]),
      ),
      el("th", { scope: "row", class: "c-name", "data-label": "Name" }, [
        a.display_name
          ? el("span", { class: "sq-dn" }, a.display_name)
          : el(
              "span",
              { class: "sq-dn is-default", title: "The default name, until you rename it" },
              [a.default_display_name, el("span", { class: "sr-only" }, " (default name)")],
            ),
      ]),
      el("td", { class: "c-role", "data-label": "Role" }, ROLE_LABELS[a.role] || a.role || "—"),
      el(
        "td",
        { class: "c-reg", "data-label": "Registered as" },
        el("code", { class: "mono" }, reg),
      ),
      el("td", { class: "c-status", "data-label": "Status" }, badge(a.status || "—")),
      el(
        "td",
        { class: "c-seen tabnum", "data-label": "Last seen" },
        a.last_seen_at
          ? el(
              "time",
              { datetime: a.last_seen_at, title: fmtTime(a.last_seen_at) },
              fmtRelative(a.last_seen_at),
            )
          : "never",
      ),
      edit ? el("td", { class: "c-act" }, renameBtn) : null,
    );
  };
  function editRow() {
    const w = agentWho(a.agent_id, a.registered_name);
    const errId = `sq-err-${++appState.fieldSeq}`;
    const nameIn = el("input", {
      type: "text",
      class: "sq-name-in",
      maxlength: "40",
      value: a.display_name || "",
      placeholder: a.default_display_name || "",
      "aria-label": `Name for ${reg}`,
      "aria-describedby": errId,
      autocomplete: "off",
    });
    const noIn = el("input", {
      type: "number",
      class: "sq-no-in",
      min: "1",
      max: "99",
      step: "1",
      inputmode: "numeric",
      value: a.shirt_number != null ? String(a.shirt_number) : "",
      placeholder: "—",
      "aria-label": `Shirt number for ${reg} (1–99, or blank)`,
      "aria-describedby": errId,
    });
    const err = el("p", { class: "form-error sq-err", id: errId, role: "alert", hidden: "" });
    const fail = (msg, input) => {
      err.textContent = msg;
      err.hidden = false;
      for (const i of [nameIn, noIn]) i.removeAttribute("aria-invalid");
      if (input) {
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
    };
    const save = el("button", { class: "btn small primary sq-save", type: "button" }, "Save");
    const cancel = () => {
      view();
      if (renameBtn) renameBtn.focus();
    };
    const doSave = async () => {
      const name = nameIn.value.trim();
      const raw = String(noIn.value || "").trim();
      if (name.length > 40) return fail("A name is at most 40 characters.", nameIn);
      let no = null;
      if (raw !== "") {
        no = Number(raw);
        if (!Number.isInteger(no) || no < 1 || no > 99)
          return fail("A shirt number is a whole number from 1 to 99, or blank.", noIn);
      }
      const body = {};
      if (name !== (a.display_name || "")) body.display_name = name || null;
      if (no !== (a.shirt_number ?? null)) body.shirt_number = no;
      if (!Object.keys(body).length) return cancel();
      save.disabled = true;
      try {
        const res = await api("PATCH", `/api/squad/agents/${encodeURIComponent(a.agent_id)}`, body);
        if (res && res.agent) {
          Object.assign(a, res.agent);
          learnDisplay(res.agent);
        }
        const now = agentWho(a.agent_id, a.registered_name);
        view();
        if (renameBtn) renameBtn.focus();
        toast(
          a.shirt_number != null ? `${now.name} wears No. ${a.shirt_number}` : `Saved: ${now.name}`,
          { ok: true },
        );
      } catch (x) {
        if (x && x.code === "UNAUTHORIZED") return;
        if (x && (x.status === 409 || x.code === "DUPLICATE")) {
          const holder = x.details && x.details.agent_id;
          const hn = holder ? agentWho(holder).name : null;
          fail(hn ? `That number is taken by ${hn}.` : x.message || "That number is taken.", noIn);
        } else if (x && (x.status === 403 || x.code === "READ_ONLY_TOKEN")) {
          squad.capability = "read";
          paintBrand();
          fail("This token can only read: renaming needs the full token.");
        } else fail((x && x.message) || "The name could not be saved.", nameIn);
      } finally {
        save.disabled = false;
      }
    };
    save.addEventListener("click", doSave);
    const keys = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    nameIn.addEventListener("keydown", keys);
    noIn.addEventListener("keydown", keys);
    tr.classList.add("is-editing");
    tr.replaceChildren(
      el(
        "td",
        { class: "c-shirt", "data-label": "No." },
        el("span", { class: "sq-shirt" }, [agentShirt(w.name, 36, w.no), noIn]),
      ),
      el("th", { scope: "row", class: "c-name", "data-label": "Name" }, [nameIn, err]),
      el("td", { class: "c-role", "data-label": "Role" }, ROLE_LABELS[a.role] || a.role || "—"),
      el(
        "td",
        { class: "c-reg", "data-label": "Registered as" },
        el("code", { class: "mono" }, reg),
      ),
      el("td", { class: "c-status", "data-label": "Status" }, badge(a.status || "—")),
      el(
        "td",
        { class: "c-seen tabnum", "data-label": "Last seen" },
        a.last_seen_at ? fmtRelative(a.last_seen_at) : "never",
      ),
      el("td", { class: "c-act" }, [
        save,
        el("button", { class: "btn small sq-cancel", type: "button", onclick: cancel }, "Cancel"),
      ]),
    );
    nameIn.focus();
  }
  view();
  return tr;
}

/**
 * #/squad: the club's squad as a team sheet. Shirt number, name (the default
 * "Delivery 1" until renamed), role, the label it registered with, status and when
 * it was last seen. A full token renames in place; a read token only reads.
 */
async function renderSquad() {
  const signal = routeSignal();
  const [res] = await Promise.all([api("GET", "/api/squad", undefined, { signal }), ensureSquad()]);
  applySquad(res);
  const agents = (res && res.agents) || [];
  const edit = canEditSquad();
  const wrap = el("div", { class: "view view-squad" });
  wrap.dataset.sig = hashText(
    JSON.stringify([
      edit,
      res && res.club,
      agents.map((a) => [a.agent_id, a.display_name, a.shirt_number, a.status, a.last_seen_at]),
    ]),
  );
  const named = agents.filter((a) => a.display_name).length;
  const numbered = agents.filter((a) => a.shirt_number != null).length;
  wrap.appendChild(
    viewHead(
      "Squad",
      agents.length
        ? `${plural(agents.length, "agent")} · ${named} named · ${numbered} with a shirt number`
        : "No agents registered yet",
      edit
        ? el(
            "button",
            { class: "btn sq-club-btn", type: "button", onclick: () => openClubSheet() },
            [crest("crest sq-club-crest", 20, 24, clubLetters()), el("span", {}, "Name your club")],
          )
        : null,
    ),
  );
  if (!edit)
    wrap.appendChild(
      el(
        "p",
        { class: "section-note sq-readonly" },
        "You are signed in with a read token: you can see the squad, and renaming needs the full token.",
      ),
    );
  const th = (label, cls) => el("th", { scope: "col", class: cls }, label);
  const body = agents.length
    ? el("div", { class: "sq-table-wrap" }, [
        el("table", { class: "sq-table", "aria-label": "The squad" }, [
          el("thead", {}, [
            el("tr", {}, [
              th("No.", "c-shirt"),
              th("Name", "c-name"),
              th("Role", "c-role"),
              th("Registered as", "c-reg"),
              th("Status", "c-status"),
              th("Last seen", "c-seen"),
              edit ? th(el("span", { class: "sr-only" }, "Rename"), "c-act") : null,
            ]),
          ]),
          el(
            "tbody",
            {},
            agents.map((a) => squadRow(a, edit)),
          ),
        ]),
      ])
    : emptyState(
        "No agents in the squad yet.",
        "An agent joins the squad when it registers with the control plane; it gets a default name like “Delivery 1”.",
      );
  wrap.appendChild(progPage("squad-sheet", "claret", "The squad", clubName(), body));
  wrap.appendChild(
    el(
      "p",
      { class: "section-note sq-foot" },
      "Names and shirt numbers are labels: every claim, event and gate still records the agent by its id. A shirt number is worn by one agent at a time.",
    ),
  );
  return wrap;
}

// ===========================================================================
//  View: Floor (#/floor) — the factory floor
//    An isometric drawing of the real factory state. A conveyor bent into an L
//    runs past the stations in lifecycle order (Drawing office, Stores, Assembly,
//    Inspection, Test rig, Loading bay, Despatch); every open ticket is a parcel
//    at its station; every live claim is a robot wearing its agent's shirt
//    number (the same agentWho() the Tactics Board's shirts use); blocked,
//    paused and failed tickets sit in the hazard-taped jam bay, whose beacon is
//    lit while it holds anything; the spend tank is filled to today's wage bill
//    against the daily budget; and the lorry carries what was despatched today.
//    Everything is read through loadMatchDay(), the Overview's own reads, so the
//    floor and the scoreboard can never disagree. Drawn from one set of box and
//    prism primitives so the light falls the same way on every object: the top
//    face is the lightest, the +y face mid, the +x face the darkest.
// ===========================================================================

/** Tile size (px per tile) and the height squash of the 2:1 dimetric projection. */
const FU = 40;
const FZK = 0.9;
/** Tile (x, y, z) to the drawing's (sx, sy). */
const fP = (x, y, z = 0, u = FU) => [(x - y) * u, ((x + y) * u) / 2 - z * u * FZK];
const fPt = (p) => p[0].toFixed(1) + "," + p[1].toFixed(1);
const fShade = (c, k) => (k ? `color-mix(in oklab, ${c}, var(--fl-shade) ${k}%)` : c);
const fTint = (c, k) => `color-mix(in oklab, ${c}, var(--fl-lift) ${k}%)`;
function fFace(pts, fill, u = FU, cls = "f") {
  return svgEl("polygon", {
    points: pts.map((q) => fPt(fP(q[0], q[1], q[2], u))).join(" "),
    style: `fill:${fill};stroke:${fill}`,
    class: cls,
  });
}
/** An axis-aligned box. c = { base } or explicit { top, front, side }. */
function fBox(x, y, z, w, d, h, c, u = FU, cls) {
  return svgEl("g", cls ? { class: cls } : {}, [
    fFace(
      [
        [x, y + d, z],
        [x + w, y + d, z],
        [x + w, y + d, z + h],
        [x, y + d, z + h],
      ],
      c.front ?? fShade(c.base, 9),
      u,
    ),
    fFace(
      [
        [x + w, y, z],
        [x + w, y + d, z],
        [x + w, y + d, z + h],
        [x + w, y, z + h],
      ],
      c.side ?? fShade(c.base, 22),
      u,
    ),
    fFace(
      [
        [x, y, z + h],
        [x + w, y, z + h],
        [x + w, y + d, z + h],
        [x, y + d, z + h],
      ],
      c.top ?? c.base,
      u,
    ),
  ]);
}
/** The silhouette of a box (focus rings and hit areas). */
function fHull(x, y, z, w, d, h, u = FU) {
  return [
    [x, y, z + h],
    [x + w, y, z + h],
    [x + w, y, z],
    [x + w, y + d, z],
    [x, y + d, z],
    [x, y + d, z + h],
  ]
    .map((p) => fPt(fP(p[0], p[1], p[2], u)))
    .join(" ");
}
/** A sawtooth roof over a footprint; `along` is the direction the teeth repeat. */
function fSawtooth(x, y, w, d, z, rise, hue, glass, along) {
  const g = svgEl("g");
  const len = along === "x" ? w : d;
  const n = Math.max(1, Math.round(len / 0.75));
  const step = len / n;
  for (let i = 0; i < n; i++) {
    const a = (along === "x" ? x : y) + i * step;
    const b = a + step;
    if (along === "x")
      g.append(
        fFace(
          [
            [a, y, z],
            [b, y, z + rise],
            [b, y + d, z + rise],
            [a, y + d, z],
          ],
          fTint(hue, 8),
        ),
        fFace(
          [
            [a, y + d, z],
            [b, y + d, z],
            [b, y + d, z + rise],
          ],
          fShade(hue, 14),
        ),
        fFace(
          [
            [b, y, z],
            [b, y + d, z],
            [b, y + d, z + rise],
            [b, y, z + rise],
          ],
          glass,
          FU,
          "f glass",
        ),
      );
    else
      g.append(
        fFace(
          [
            [x, a, z],
            [x, b, z + rise],
            [x + w, b, z + rise],
            [x + w, a, z],
          ],
          fTint(hue, 8),
        ),
        fFace(
          [
            [x + w, a, z],
            [x + w, b, z],
            [x + w, b, z + rise],
          ],
          fShade(hue, 26),
        ),
        fFace(
          [
            [x, b, z],
            [x + w, b, z],
            [x + w, b, z + rise],
            [x, b, z + rise],
          ],
          glass,
          FU,
          "f glass",
        ),
      );
  }
  return g;
}
const fRect = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
/**
 * A sign painted on a wall, on its own layer above the floor (nothing on the
 * floor may cover a station's name). It registers its sheared outline so the tag
 * pass keeps clear of it. along "x": the +y face; along "y": the +x face.
 */
function fSign(C, x0, y0, z, along, widthTiles, label) {
  const [ox, oy] = fP(x0, y0, z);
  const k = along === "x" ? 0.5 : -0.5;
  const W = widthTiles * FU;
  C.signs.push(
    svgEl(
      "g",
      { transform: `matrix(1,${k},0,1,${ox.toFixed(1)},${oy.toFixed(1)})`, class: "fl-sign" },
      [
        svgEl("rect", { x: 0, y: 0, width: W, height: 21, rx: 2, class: "fl-sign-board" }),
        svgEl("text", { x: 6, y: 15, class: "fl-sign-text" }, label),
      ],
    ),
  );
  C.obstacles.push([
    [ox, oy],
    [ox + W, oy + k * W],
    [ox + W, oy + k * W + 21],
    [ox, oy + 21],
  ]);
}

/* ---- tag placement: clear of every sign, scale and other tag (SAT test) ---- */
function fOverlaps(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = q[1] - p[1];
      const ny = p[0] - q[0];
      let amin = Infinity;
      let amax = -Infinity;
      let bmin = Infinity;
      let bmax = -Infinity;
      for (const v of a) {
        const d = v[0] * nx + v[1] * ny;
        amin = Math.min(amin, d);
        amax = Math.max(amax, d);
      }
      for (const v of b) {
        const d = v[0] * nx + v[1] * ny;
        bmin = Math.min(bmin, d);
        bmax = Math.max(bmax, d);
      }
      if (amax <= bmin || bmax <= amin) return false;
    }
  }
  return true;
}
/** A leader from an anchor to the nearest point of a tag box: [x0, y0, x1, y1]. */
function fLeader(x, y, bx, by, w, h) {
  if (x < bx || x > bx + w) return [x, y - 2, x < bx ? bx : bx + w, by + h / 2];
  return [x, y - 2, Math.max(bx + 4, Math.min(bx + w - 4, x)), by > y ? by : by + h];
}
function fSegPoly([a, b, c, d]) {
  const L = Math.hypot(c - a, d - b) || 1;
  const nx = ((d - b) / L) * 1.5;
  const ny = (-(c - a) / L) * 1.5;
  const k = 4 / L;
  const a2 = a + (c - a) * k;
  const b2 = b + (d - b) * k;
  const c2 = c - (c - a) * k;
  const d2 = d - (d - b) * k;
  return [
    [a2 + nx, b2 + ny],
    [c2 + nx, d2 + ny],
    [c2 - nx, d2 - ny],
    [a2 - nx, b2 - ny],
  ];
}
function fSegCross([a, b, c, d], [e, f, g, h]) {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return (
    o(a, b, c, d, e, f) * o(a, b, c, d, g, h) < 0 && o(e, f, g, h, a, b) * o(e, f, g, h, c, d) < 0
  );
}
/**
 * Place every tag. Candidates run from straight up outward (higher, either side,
 * below), each scored by how far it strays; an overlap costs more than any
 * distance and a crossed leader costs extra. A tag that moves keeps a leader.
 */
function fPlaceTags(tags, obstacles, bounds) {
  const placed = [];
  const leaders = [];
  const prio = (t) => (t.kind === "danger" ? 0 : t.kind === "needs" ? 1 : 2);
  const order = tags.map((t, i) => [t, i]).sort((a, b) => prio(a[0]) - prio(b[0]) || a[1] - b[1]);
  for (const [t] of order) {
    const [x, y] = t.at;
    const w = t.w;
    const h = 20;
    const base = -t.lift - h;
    const cand = [];
    for (const up of [0, 14, 28, 42, 58]) cand.push([0, base - up, up * 0.6]);
    for (const side of [1, -1])
      for (const [dx, dy] of [
        [w / 2 + 18, base + 6],
        [w / 2 + 18, base - 12],
        [w / 2 + 30, base - 30],
        [w / 2 + 22, 4],
      ])
        cand.push([
          side * dx,
          dy,
          Math.abs(dx) * 0.55 + Math.abs(dy - base) * 0.3 + (side < 0 ? 2 : 0),
        ]);
    cand.push([0, 10, 40]);
    let best = null;
    for (const [dx, dy, cost] of cand) {
      const bx = x + dx - w / 2;
      const by = y + dy;
      const rect = fRect(bx - 3, by - 3, w + 6, h + 6);
      let hits = 0;
      for (const o of obstacles) if (fOverlaps(rect, o)) hits++;
      for (const p of placed) if (fOverlaps(rect, p)) hits++;
      if (bx < bounds[0] + 2 || bx + w > bounds[0] + bounds[2] - 2 || by < bounds[1] + 2) hits++;
      const lead = fLeader(x, y, bx, by, w, h);
      const lp = fSegPoly(lead);
      let cross = 0;
      for (const p of placed) if (fOverlaps(lp, p)) cross++;
      for (const l of leaders) if (fSegCross(lead, l)) cross++;
      const score = hits * 1000 + cross * 400 + cost;
      if (!best || score < best.score) best = { score, bx, by, lead };
      if (score < 1) break;
    }
    placed.push(fRect(best.bx - 2, best.by - 2, w + 4, h + 4));
    leaders.push(best.lead);
    t.box = [best.bx, best.by, w, h];
  }
}

/* ---- stations ------------------------------------------------------------ */
const FLOOR_STATIONS = {
  drawing: { name: "Drawing office", statuses: ["draft", "refining"], hue: "var(--fl-draft)" },
  stores: { name: "Stores", statuses: ["ready"], hue: "var(--fl-ready)" },
  assembly: { name: "Assembly", statuses: ["claimed", "in_progress"], hue: "var(--fl-build)" },
  inspection: { name: "Inspection", statuses: ["in_review"], hue: "var(--fl-inspect)" },
  testrig: { name: "Test rig", statuses: ["in_testing"], hue: "var(--fl-test)" },
  loading: { name: "Loading bay", statuses: ["ready_for_merge"], hue: "var(--fl-inspect)" },
  despatch: { name: "Despatch", statuses: ["done"], hue: "var(--fl-done)" },
  jam: { name: "Jam bay", statuses: ["blocked", "paused", "failed"], hue: "var(--red)" },
};
/** Lifecycle order: the stations along the line, then the bay off it. */
const FLOOR_ORDER = [
  "drawing",
  "stores",
  "assembly",
  "inspection",
  "testrig",
  "loading",
  "despatch",
  "jam",
];
const FLOOR_STATION_OF = {};
for (const [k, st] of Object.entries(FLOOR_STATIONS))
  for (const s of st.statuses) FLOOR_STATION_OF[s] = k;
/** Each ticket status as the floor says it in a sentence. */
const FLOOR_WORDS = {
  draft: "a draft",
  refining: "refining",
  ready: "ready",
  claimed: "claimed",
  in_progress: "in progress",
  in_review: "in review",
  in_testing: "in testing",
  ready_for_merge: "approved, waiting to merge",
  done: "despatched today",
  blocked: "blocked",
  paused: "paused",
  failed: "failed",
};
/** The sheds: footprint in tiles, height, and the direction the roof teeth run. */
const FLOOR_SHEDS = {
  drawing: { x: 0.3, y: 0.1, w: 2.75, d: 1.0, h: 1.05, along: "x" },
  assembly: { x: 5.6, y: 0.05, w: 2.95, d: 1.08, h: 1.25, along: "x" },
  inspection: { x: 8.8, y: 0.1, w: 2.2, d: 1.0, h: 1.1, along: "x" },
  testrig: { x: 9.75, y: 2.45, w: 1.2, d: 1.75, h: 0.95, along: "y" },
  loading: { x: 9.75, y: 4.45, w: 1.2, d: 2.55, h: 1.1, along: "y" },
  despatch: { x: 9.75, y: 7.2, w: 1.2, d: 2.45, h: 1.05, along: "y" },
};
/** The painted benches in Assembly (one per agent slot, at most four fit the bay). */
const FLOOR_MAX_BENCHES = 4;
const fBenchX = (i) => 5.8 + i * 1.02;
/** Where a station's parcels sit (tile coordinates); past the last slot is "+n". */
function floorSlots(k) {
  const out = [];
  if (k === "drawing")
    for (let i = 0; i < 6; i++) out.push({ x: 0.6 + i * 0.44, y: 1.6, z: 0.3, sz: 0.38, flat: 1 });
  if (k === "stores")
    for (const z of [0.42, 0.98])
      for (let i = 0; i < 4; i++) out.push({ x: 3.55 + i * 0.5, y: 0.62, z, sz: 0.4 });
  // claimed tickets whose robot is not on a bench wait on the belt by Assembly
  if (k === "assembly")
    for (let i = 0; i < 5; i++) out.push({ x: 5.9 + i * 0.5, y: 1.6, z: 0.3, sz: 0.4 });
  if (k === "inspection")
    for (let i = 0; i < 3; i++) out.push({ x: 9.3 + i * 0.78, y: 1.6, z: 0.3, sz: 0.46 });
  if (k === "testrig")
    for (let i = 0; i < 3; i++) out.push({ x: 11.5, y: 2.3 + i * 0.62, z: 0.3, sz: 0.44 });
  if (k === "loading")
    for (let i = 0; i < 3; i++)
      out.push({ x: 11.5, y: 4.95 + i * 0.85, z: 0.3, sz: 0.46, lift: i % 2 ? 46 : 22 });
  // the lorry's deck: what was despatched today, loaded mid-deck first (in view)
  if (k === "despatch")
    for (let l = 0; l < 2; l++)
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 2; c++)
          out.push({
            x: 11.22 + c * 0.56,
            y: [10.95, 10.35, 11.55][r],
            z: 0.54 + l * 0.38,
            sz: 0.42,
          });
  if (k === "jam")
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 3; c++)
        out.push({ x: 5.9 + c * 0.55, y: 4.45 + r * 0.6, z: 0, sz: 0.42, tilt: true });
  return out;
}
/** Where a robot stands beside a parcel it holds off the benches. */
function floorBeside(k, sl) {
  if (k === "testrig" || k === "loading") return [12.3, sl.y];
  if (k === "jam") return [sl.x, 5.75];
  if (k === "despatch") return [12.45, sl.y];
  return [sl.x, 2.45];
}

/** A kraft parcel (or a blue flat-pack: a draft). */
function floorParcel(x, y, z, sz, flat) {
  const g = svgEl("g", { class: "fl-pk" });
  if (flat) {
    g.append(
      fBox(x - sz / 2, y - sz / 2, z, sz, sz, 0.07, {
        top: "var(--fl-flat-t)",
        front: "var(--fl-flat-f)",
        side: "var(--fl-flat-s)",
      }),
    );
    const a = fP(x - sz / 4, y - sz / 2 + 0.04, z + 0.07);
    const b = fP(x - sz / 4, y + sz / 2 - 0.04, z + 0.07);
    const c = fP(x + sz / 4, y - sz / 2 + 0.04, z + 0.07);
    const d = fP(x + sz / 4, y + sz / 2 - 0.04, z + 0.07);
    g.append(
      svgEl("path", { d: `M${fPt(a)}L${fPt(b)}M${fPt(c)}L${fPt(d)}`, class: "fl-flat-line" }),
    );
    return g;
  }
  const h = sz * 0.86;
  g.append(fBox(x - sz / 2, y - sz / 2, z, sz, sz, h, FLOOR_KRAFT));
  const t = [
    fP(x - 0.05, y - sz / 2, z + h),
    fP(x + 0.05, y - sz / 2, z + h),
    fP(x + 0.05, y + sz / 2, z + h),
    fP(x - 0.05, y + sz / 2, z + h),
  ];
  g.append(svgEl("polygon", { points: t.map(fPt).join(" "), class: "fl-tape" }));
  return g;
}
const FLOOR_KRAFT = {
  top: "var(--fl-kraft-t)",
  front: "var(--fl-kraft-f)",
  side: "var(--fl-kraft-s)",
};

/**
 * A robot in a hard hat, facing down the line (+x), its agent's shirt number on
 * its chest plate in the club kit (the Tactics Board's shirt tokens). `carry`
 * puts its parcel in its arms. Returns { g, top } (top: above the parcel).
 */
function floorRobot(x0, y0, no, carry) {
  const k = 1.6;
  const u = FU * k;
  const x = x0 / k;
  const y = y0 / k;
  const g = svgEl("g", { class: "fl-bot" });
  const body = { top: "var(--fl-bot-t)", front: "var(--fl-bot-f)", side: "var(--fl-bot-s)" };
  const leg = { base: "var(--fl-bot-leg)" };
  g.append(fBox(x - 0.09, y - 0.12, 0, 0.08, 0.08, 0.2, leg, u));
  if (carry) g.append(fBox(x - 0.02, y - 0.2, 0.23, 0.44, 0.06, 0.06, body, u));
  g.append(fBox(x - 0.09, y + 0.04, 0, 0.08, 0.08, 0.2, leg, u));
  g.append(fBox(x - 0.15, y - 0.15, 0.2, 0.3, 0.3, 0.36, body, u));
  // the chest plate on the +y face: the club shirt colour with the stencil number
  g.append(
    fFace(
      [
        [x - 0.14, y + 0.15, 0.3],
        [x + 0.14, y + 0.15, 0.3],
        [x + 0.14, y + 0.15, 0.555],
        [x - 0.14, y + 0.15, 0.555],
      ],
      "var(--claret)",
      u,
      "f fl-bot-plate",
    ),
  );
  if (no) {
    const [ox, oy] = fP(x - 0.14, y + 0.15, 0.555, u);
    const pw = 0.28 * u;
    g.append(
      svgEl(
        "text",
        {
          transform: `matrix(1,0.5,0,1,${ox.toFixed(1)},${oy.toFixed(1)})`,
          x: (pw / 2).toFixed(1),
          y: 12.4,
          "text-anchor": "middle",
          class: "fl-bot-no",
        },
        String(no),
      ),
    );
  }
  g.append(fBox(x - 0.04, y - 0.04, 0.56, 0.08, 0.08, 0.05, leg, u));
  g.append(fBox(x - 0.12, y - 0.12, 0.6, 0.24, 0.24, 0.22, body, u));
  g.append(
    fFace(
      [
        [x + 0.12, y - 0.1, 0.66],
        [x + 0.12, y + 0.1, 0.66],
        [x + 0.12, y + 0.1, 0.78],
        [x + 0.12, y - 0.1, 0.78],
      ],
      "var(--fl-bot-visor)",
      u,
    ),
  );
  for (const ey of [-0.07, 0.03])
    g.append(
      fFace(
        [
          [x + 0.12, y + ey, 0.7],
          [x + 0.12, y + ey + 0.04, 0.7],
          [x + 0.12, y + ey + 0.04, 0.75],
          [x + 0.12, y + ey, 0.75],
        ],
        "var(--fl-bot-eye)",
        u,
      ),
    );
  const [hx, hy] = fP(x, y, 0.83, u);
  const r = 0.2 * u;
  g.append(
    svgEl("ellipse", { cx: hx, cy: hy + 1, rx: r * 1.35, ry: r * 0.68, class: "fl-hat-brim" }),
    svgEl("path", {
      d: `M${(hx - r).toFixed(1)},${hy.toFixed(1)} a${r.toFixed(1)},${(r * 0.95).toFixed(1)} 0 0 1 ${(2 * r).toFixed(1)},0 z`,
      class: "fl-hat",
    }),
    svgEl("path", {
      d: `M${hx.toFixed(1)},${(hy - r * 0.95).toFixed(1)} v-5`,
      class: "fl-antenna",
    }),
    svgEl("circle", { cx: hx, cy: hy - r * 0.95 - 6.5, r: 2.1, class: "fl-antenna-tip" }),
  );
  let top = fP(x, y, 1.0, u);
  if (carry) {
    g.append(fBox(x + 0.16, y - 0.16, 0.26, 0.32, 0.32, 0.28, FLOOR_KRAFT, u));
    const t = [
      fP(x + 0.28, y - 0.16, 0.54, u),
      fP(x + 0.36, y - 0.16, 0.54, u),
      fP(x + 0.36, y + 0.16, 0.54, u),
      fP(x + 0.28, y + 0.16, 0.54, u),
    ];
    g.append(svgEl("polygon", { points: t.map(fPt).join(" "), class: "fl-tape" }));
    g.append(fBox(x - 0.02, y + 0.14, 0.23, 0.44, 0.06, 0.06, body, u));
    top = fP(x + 0.32, y, 0.56, u);
  }
  return { g, top };
}
function floorCylinder(cx, cy, z0, z1, r, cls) {
  const [bx, by] = fP(cx, cy, z0);
  const [tx, ty] = fP(cx, cy, z1);
  const rx = r * FU * 1.414;
  const ry = r * FU * 0.707;
  return svgEl("g", { class: cls }, [
    svgEl("path", {
      d: `M${bx - rx},${by} L${tx - rx},${ty} A${rx},${ry} 0 0 1 ${tx + rx},${ty} L${bx + rx},${by} A${rx},${ry} 0 0 1 ${bx - rx},${by} Z`,
      class: "fl-cyl-body",
    }),
    svgEl("ellipse", { cx: tx, cy: ty, rx, ry, class: "fl-cyl-top" }),
  ]);
}
/** A tick step for the tank's scale: 3 to 6 graduations up to the budget. */
function floorTickStep(budget) {
  for (const m of [0.01, 0.1, 1, 10, 100, 1000])
    for (const k of [1, 2, 2.5, 5]) if (budget / (m * k) <= 6) return m * k;
  return Math.ceil(budget / 5);
}

/**
 * What the floor shows, from the Overview's match-day read: every open ticket as
 * a parcel at its station, the live claims (robots), today's despatches, the
 * wage bill against the budget and the decisions on the desk.
 */
function floorModel(f) {
  const now = f.now;
  // "Today" is the server's day (UTC midnight), the same day the scoreboard's
  // Delivered today counts, so the lorry and the tile never disagree.
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const needs = new Set(f.items.map((i) => i.ticket && i.ticket.id).filter(Boolean));
  const parkedWhy = new Map();
  for (const i of f.items)
    if (i.kind === "parked" && i.ticket) parkedWhy.set(i.ticket.id, i.reason);
  // A live claim: held now (a stale claim, past its heartbeat, has no robot).
  const live = new Map();
  for (const [tid, c] of f.claimByTicket) {
    if (c.expires_at && Date.parse(c.expires_at) < now) continue;
    const t = f.byId.get(tid);
    if (!t || t.status === "done" || t.status === "cancelled") continue;
    live.set(tid, { claim: c, who: agentWho(c.agent_id, c.agent_display_name) });
  }
  const parcel = (t) => {
    const ev = f.details.get(t.id)?.events;
    const hold = live.get(t.id);
    const run = t.number != null ? f.runByTicket.get(t.number) : null;
    return {
      id: t.id,
      number: t.number,
      title: t.title || "(untitled)",
      status: t.status,
      station: FLOOR_STATION_OF[t.status],
      needs: needs.has(t.id),
      why: parkedWhy.get(t.id) || null,
      who: hold ? hold.who : null,
      agentId: hold ? hold.claim.agent_id : null,
      running: Boolean(hold && run && !run.outcome),
      by:
        !hold && ["in_review", "in_testing", "ready_for_merge", "done"].includes(t.status)
          ? deliveredBy(ev)
          : null,
    };
  };
  const open = f.tickets
    .filter((t) => t.status !== "done" && t.status !== "cancelled" && FLOOR_STATION_OF[t.status])
    .map(parcel);
  const despatched = f.tickets
    .filter((t) => t.status === "done")
    .filter((t) => {
      const at = Date.parse(sinceStatus(f.details.get(t.id)?.events, "done") || t.updated_at);
      return Number.isFinite(at) && at >= dayStart.getTime();
    })
    .map(parcel);
  const all = [...open, ...despatched].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const byStation = {};
  for (const p of all) (byStation[p.station] ||= []).push(p);
  const today = f.cost && typeof f.cost.today_usd === "number" ? f.cost.today_usd : null;
  return {
    open,
    despatched,
    byStation,
    robots: all.filter((p) => p.who),
    // one bench per agent slot, and one for every robot at Assembly beyond them
    benches: Math.max(
      1,
      Math.min(
        FLOOR_MAX_BENCHES,
        Math.max(f.slots || 3, (byStation.assembly || []).filter((p) => p.who).length),
      ),
    ),
    decisions: f.items.filter((i) => i.kind === "decision").length,
    today,
    budget: f.budget,
  };
}

/** The sentence a parcel reads as: "#12 Fix the login redirect, in review, delivered by Kev (No. 9)". */
function floorSentence(p) {
  const named = (w) => `${w.name}${w.no ? ` (No. ${Number(w.no)})` : ""}`;
  let s = `#${p.number} ${p.title}, ${FLOOR_WORDS[p.status] || statusLabel(p.status, p.landing_state)}`;
  if (p.who) s += `, ${named(p.who)} on it${p.running ? ", its run in progress" : ""}`;
  else if (p.by) s += `, delivered by ${named(p.by)}`;
  if (p.needs) s += ", needs you";
  return s;
}

/** Draw the floor: one SVG, every parcel, robot and station a link. */
function floorScene(m) {
  const C = { items: [], tags: [], obstacles: [], signs: [] };
  const add = (depth, node) => C.items.push({ depth, node });
  const count = (k) => (m.byStation[k] || []).length;
  const SLAB = { w: 12.8, d: 10 };

  // the slab, its tile joints, the painted walkways and the lorry's yard
  const floor = svgEl("g", { class: "fl-floor" }, [
    fFace(
      [
        [0, SLAB.d, -0.35],
        [SLAB.w, SLAB.d, -0.35],
        [SLAB.w, SLAB.d, 0],
        [0, SLAB.d, 0],
      ],
      "var(--fl-slab-l)",
    ),
    fFace(
      [
        [SLAB.w, 0, -0.35],
        [SLAB.w, SLAB.d, -0.35],
        [SLAB.w, SLAB.d, 0],
        [SLAB.w, 0, 0],
      ],
      "var(--fl-slab-r)",
    ),
    fFace(
      [
        [0, 0, 0],
        [SLAB.w, 0, 0],
        [SLAB.w, SLAB.d, 0],
        [0, SLAB.d, 0],
      ],
      "var(--fl-ground)",
    ),
    fFace(
      [
        [10.6, SLAB.d, 0],
        [12.6, SLAB.d, 0],
        [12.6, 13.2, 0],
        [10.6, 13.2, 0],
      ],
      "var(--fl-yard)",
    ),
  ]);
  let joints = "";
  for (let i = 1; i < SLAB.w; i++) joints += `M${fPt(fP(i, 0))}L${fPt(fP(i, SLAB.d))}`;
  for (let j = 1; j < SLAB.d; j++) joints += `M${fPt(fP(0, j))}L${fPt(fP(SLAB.w, j))}`;
  floor.append(svgEl("path", { d: joints, class: "fl-joints" }));
  const walk = [
    [fP(0.3, 2.1), fP(11.0, 2.1)],
    [fP(11.0, 2.1), fP(11.0, 9.75)],
    [fP(0.3, 1.12), fP(5.55, 1.12)],
    [fP(12.0, 1.12), fP(12.0, 9.75)],
  ];
  floor.append(
    svgEl("path", { d: walk.map(([a, b]) => `M${fPt(a)}L${fPt(b)}`).join(""), class: "fl-walk" }),
  );

  // the belt, in one-tile chunks so the painter's sort stays honest
  const beltC = {
    top: "var(--fl-belt)",
    front: "var(--fl-belt-side)",
    side: fShade("var(--fl-belt-side)", 18),
  };
  for (let x = 0.3; x < 11.8 - 0.001; x += 1) {
    const w = Math.min(1, 11.8 - x);
    add(x + w / 2 + 1.1, fBox(x, 1.3, 0, w, 0.6, 0.3, beltC));
  }
  for (let y = 1.9; y < 9.75 - 0.001; y += 1) {
    const d = Math.min(1, 9.75 - y);
    add(11 + y + d / 2, fBox(11.2, y, 0, 0.6, d, 0.3, beltC));
  }
  let rollers = "";
  for (let x = 0.5; x < 11.2; x += 0.3)
    rollers += `M${fPt(fP(x, 1.32, 0.3))}L${fPt(fP(x, 1.88, 0.3))}`;
  for (let y = 2.1; y < 9.7; y += 0.3)
    rollers += `M${fPt(fP(11.22, y, 0.3))}L${fPt(fP(11.78, y, 0.3))}`;
  add(0.05, svgEl("path", { d: rollers, class: "fl-rollers" }));

  const glassFor = (k) => (count(k) ? "var(--fl-glass-lit)" : "var(--fl-glass)");
  const needsAt = (k) => (m.byStation[k] || []).some((p) => p.needs);
  // A station is a link to Work, filtered to its first status.
  const stationLink = (k, depth, node, hullPts) => {
    const st = FLOOR_STATIONS[k];
    const n = count(k);
    const what =
      k === "despatch"
        ? `${n} despatched today`
        : `${n} ${n === 1 ? "ticket" : "tickets"}${needsAt(k) ? ", needs you" : ""}`;
    const a = svgEl("a", {
      href: `#/work?status=${k === "assembly" ? "in_progress" : st.statuses[0]}`,
      class: "fl-hit fl-station",
      "aria-label": `${st.name}: ${what}. Open in Work.`,
      "data-station": k,
    });
    a.append(node, svgEl("polygon", { points: hullPts, class: "fl-ring" }));
    add(depth, a);
  };

  // the sheds: a plinth in the station hue, white walls, a sawtooth roof whose
  // glass is lit while the station holds work, the sign on the face to the belt
  const wall = { top: "var(--fl-wall)", front: "var(--fl-wall-f)", side: "var(--fl-wall-s)" };
  for (const [k, b] of Object.entries(FLOOR_SHEDS)) {
    const st = FLOOR_STATIONS[k];
    const g = svgEl("g", { class: `fl-shed fl-shed-${k}` });
    g.append(fBox(b.x, b.y, 0, b.w, b.d, 0.12, { base: st.hue }));
    g.append(fBox(b.x, b.y, 0.12, b.w, b.d, b.h - 0.12, wall));
    g.append(fSawtooth(b.x, b.y, b.w, b.d, b.h, 0.42, st.hue, glassFor(k), b.along));
    if (b.along === "x") fSign(C, b.x + 0.14, b.y + b.d, b.h - 0.04, "x", b.w - 0.28, st.name);
    else {
      if (k !== "testrig") {
        const y0 = b.y + 0.35;
        const y1 = b.y + b.d - 0.35;
        const X = b.x + b.w;
        let lines = "";
        for (let zz = 0.08; zz < 0.46; zz += 0.07)
          lines += `M${fPt(fP(X, y1, zz))}L${fPt(fP(X, y0, zz))}`;
        g.append(
          fFace(
            [
              [X, y0, 0.05],
              [X, y1, 0.05],
              [X, y1, 0.48],
              [X, y0, 0.48],
            ],
            "var(--fl-shutter)",
          ),
          svgEl("path", { d: lines, class: "fl-shutter-lines" }),
        );
      }
      fSign(C, b.x + b.w, b.y + b.d - 0.14, b.h - 0.04, "y", b.d - 0.28, st.name);
    }
    // a needs-you lamp on the roof: the referee's yellow card colour
    if (needsAt(k)) {
      const [lx, ly] = fP(b.x + b.w * 0.5, b.y + b.d * 0.5, b.h + 0.55);
      g.append(
        svgEl("path", { d: `M${lx},${ly + 2} v10`, class: "fl-lamp-post" }),
        svgEl("rect", { x: lx - 6, y: ly - 9, width: 12, height: 12, rx: 2, class: "fl-lamp" }),
      );
    }
    stationLink(k, b.x + b.w / 2 + b.y + b.d / 2, g, fHull(b.x, b.y, 0, b.w, b.d, b.h + 0.42));
  }

  // Stores: an open shelving rack
  {
    const g = svgEl("g", { class: "fl-rack" });
    const steel = { base: "var(--fl-ready)" };
    for (const [px, py] of [
      [3.25, 0.2],
      [5.3, 0.2],
      [3.25, 1.0],
      [5.3, 1.0],
    ])
      g.append(fBox(px - 0.04, py - 0.04, 0, 0.08, 0.08, 1.48, steel));
    for (const z of [0.34, 0.9, 1.44])
      g.append(
        fBox(3.2, 0.18, z, 2.15, 0.88, 0.06, {
          top: "var(--fl-shelf)",
          front: fShade("var(--fl-shelf)", 10),
          side: fShade("var(--fl-shelf)", 20),
        }),
      );
    fSign(C, 3.32, 1.04, 1.86, "x", 1.95, "Stores");
    stationLink("stores", 3.4, g, fHull(3.2, 0.16, 0, 2.15, 0.9, 1.9));
  }

  // the benches: one painted bay per agent slot
  {
    let d = "";
    for (let i = 0; i < m.benches; i++) {
      const x = fBenchX(i);
      const c = [
        [x - 0.42, 2.38],
        [x + 0.42, 2.38],
        [x + 0.42, 3.2],
        [x - 0.42, 3.2],
      ].map(([a, b]) => fP(a, b, 0.004));
      d += `M${c.map(fPt).join("L")}Z`;
    }
    add(0.06, svgEl("path", { d, class: "fl-bay" }));
  }

  // the test-rig gantry over leg 2
  {
    const frame = { base: "var(--fl-test)" };
    const GY = 2.25;
    add(11.05 + GY - 0.3, fBox(11.0, GY - 0.05, 0, 0.1, 0.1, 1.15, frame));
    const front = svgEl("g", {}, [
      fBox(11.95, GY - 0.05, 0, 0.1, 0.1, 1.15, frame),
      fBox(10.98, GY - 0.07, 1.12, 1.1, 0.14, 0.12, frame),
    ]);
    for (const xx of [11.2, 11.5, 11.8]) {
      const [lx, ly] = fP(xx, GY + 0.07, 1.06);
      front.append(svgEl("circle", { cx: lx, cy: ly, r: 2.6, class: "fl-gate-lamp" }));
    }
    add(12.0 + GY + 0.4, front);
  }

  // the jam bay: hazard tape round the floor and a beacon, lit while it holds anything
  const jam = m.byStation.jam || [];
  {
    const g = svgEl("g", { class: `fl-jam${jam.length ? " is-jammed" : ""}` });
    g.append(
      fFace(
        [
          [5.6, 4.0, 0.005],
          [7.6, 4.0, 0.005],
          [7.6, 5.55, 0.005],
          [5.6, 5.55, 0.005],
        ],
        jam.length ? "var(--fl-jam-floor)" : "var(--fl-ground)",
      ),
    );
    if (jam.length) {
      const C4 = [
        [5.6, 4.0],
        [7.6, 4.0],
        [7.6, 5.55],
        [5.6, 5.55],
      ];
      const edges = [
        [C4[0], C4[1], 12],
        [C4[1], C4[2], 10],
        [C4[2], C4[3], 12],
        [C4[3], C4[0], 10],
      ];
      const dash = (a, b, n) => {
        let d = "";
        for (let i = 0; i < n; i += 2) {
          const p0 = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
          const p1 = [a[0] + ((b[0] - a[0]) * (i + 1)) / n, a[1] + ((b[1] - a[1]) * (i + 1)) / n];
          d += `M${fPt(fP(p0[0], p0[1], 0.01))}L${fPt(fP(p1[0], p1[1], 0.01))}`;
        }
        return d;
      };
      g.append(
        svgEl("path", {
          d: edges
            .map(([a, b]) => `M${fPt(fP(a[0], a[1], 0.01))}L${fPt(fP(b[0], b[1], 0.01))}`)
            .join(""),
          class: "fl-hazard-base",
        }),
        svgEl("path", { d: edges.map(([a, b, n]) => dash(a, b, n)).join(""), class: "fl-hazard" }),
      );
    }
    g.append(fBox(5.67, 5.38, 0, 0.06, 0.06, 0.55, { base: "var(--fl-post)" }));
    fSign(C, 5.65, 5.52, 0.98, "x", 1.36, "Jam bay");
    stationLink("jam", 1.0, g, fHull(5.6, 4.0, 0, 2.0, 1.55, 0.01));
    const bg = svgEl("g", { class: "fl-beacon-wrap" });
    bg.append(fBox(7.32, 4.13, 0, 0.08, 0.08, 1.0, { base: "var(--fl-post)" }));
    const [bx, by] = fP(7.36, 4.17, 1.05);
    bg.append(
      svgEl("rect", {
        x: bx - 6,
        y: by - 12,
        width: 12,
        height: 14,
        rx: 3,
        class: jam.length ? "fl-beacon is-on" : "fl-beacon",
      }),
      svgEl("rect", { x: bx - 8, y: by + 1, width: 16, height: 3, rx: 1, class: "fl-beacon-cap" }),
    );
    add(7.36 + 4.17 + 0.3, bg);
  }

  // your desk: a glass-fronted cabin, lit while a decision waits for you
  {
    const g = svgEl("g", { class: "fl-desk" });
    const b = { x: 0.9, y: 6.4, w: 2.5, d: 2.4, h: 0.95 };
    g.append(fBox(b.x, b.y, 0, b.w, b.d, 0.12, { base: "var(--claret)" }));
    g.append(
      fBox(b.x, b.y, 0.12, b.w, b.d, b.h - 0.12, {
        top: "var(--fl-roof)",
        front: "var(--fl-wall-f)",
        side: "var(--fl-wall-s)",
      }),
    );
    const lit = m.decisions ? "var(--fl-glass-lit)" : "var(--fl-glass)";
    g.append(
      fFace(
        [
          [b.x + 0.2, b.y + b.d, 0.28],
          [b.x + b.w - 0.2, b.y + b.d, 0.28],
          [b.x + b.w - 0.2, b.y + b.d, 0.72],
          [b.x + 0.2, b.y + b.d, 0.72],
        ],
        lit,
        FU,
        "f glass",
      ),
      fFace(
        [
          [b.x + b.w, b.y + 0.2, 0.28],
          [b.x + b.w, b.y + b.d - 0.95, 0.28],
          [b.x + b.w, b.y + b.d - 0.95, 0.72],
          [b.x + b.w, b.y + 0.2, 0.72],
        ],
        lit,
        FU,
        "f glass",
      ),
    );
    fSign(C, b.x + b.w, b.y + b.d - 0.12, 1.26, "y", 0.95, "Desk");
    if (m.decisions) {
      const [lx, ly] = fP(b.x + b.w * 0.5, b.y + b.d * 0.5, b.h + 0.1);
      g.append(
        svgEl("path", { d: `M${lx},${ly + 2} v10`, class: "fl-lamp-post" }),
        svgEl("rect", { x: lx - 6, y: ly - 9, width: 12, height: 12, rx: 2, class: "fl-lamp" }),
      );
      C.tags.push({
        at: fP(b.x + b.w * 0.5, b.y + b.d * 0.5, b.h + 0.6),
        text: m.decisions === 1 ? "Decision" : `${m.decisions} decisions`,
        kind: "needs",
        lift: 10,
      });
    }
    const a = svgEl("a", {
      href: "#/overview",
      class: "fl-hit fl-station",
      "aria-label": m.decisions
        ? `Your desk: ${plural(m.decisions, "decision")} ${m.decisions === 1 ? "waits" : "wait"} for you. Answer on the Team sheet.`
        : "Your desk: no decision waits for you. Open the Overview.",
      "data-station": "desk",
    });
    a.append(g, svgEl("polygon", { points: fHull(b.x, b.y, 0, b.w, b.d, b.h), class: "fl-ring" }));
    add(b.x + b.w / 2 + b.y + b.d / 2, a);
  }

  // the spend tank: a glass cylinder filled to today's wage bill over the budget
  {
    const { today, budget } = m;
    const cx = 5.7;
    const cy = 7.5;
    const r = 0.62;
    const zMax = 2.6;
    const frac = budget && today != null ? Math.max(0, Math.min(1, today / budget)) : 0;
    const hot = budget && today != null && today / budget >= 0.9;
    const label =
      today == null
        ? "Spend tank: no spend recorded today."
        : budget
          ? `Spend tank: ${money(today)} of today's ${moneyW(budget)} budget (${Math.round((today / budget) * 100)}%).`
          : `Spend tank: ${money(today)} spent today. No daily budget is set, so the tank has no scale.`;
    const g = svgEl("g", {
      class: `fl-tank${hot ? " is-hot" : ""}`,
      role: "img",
      "aria-label": label,
    });
    g.append(floorCylinder(cx, cy, 0, 0.14, r + 0.08, "fl-tank-base"));
    g.append(floorCylinder(cx, cy, 0.14, 0.14 + zMax, r, "fl-tank-glass"));
    if (frac > 0)
      g.append(floorCylinder(cx, cy, 0.14, 0.14 + zMax * frac, r - 0.05, "fl-tank-fuel"));
    g.append(floorCylinder(cx, cy, 0.14 + zMax, 0.24 + zMax, r + 0.06, "fl-tank-cap"));
    if (budget) {
      const [bx0] = fP(cx, cy, 0);
      const rx = r * FU * 1.414;
      const ry = r * FU * 0.707;
      const step = floorTickStep(budget);
      // a graduation every step, the budget itself last; only the two ends are
      // figured, so the scale never crowds the jam bay's sign beside it
      const marks = [];
      for (let i = 0; i * step < budget - 1e-9; i++) marks.push(Math.round(i * step * 100) / 100);
      marks.push(budget);
      marks.forEach((v, i) => {
        const [, yy] = fP(cx, cy, 0.14 + (zMax * v) / budget);
        g.append(
          svgEl("path", {
            d: `M${(bx0 - rx).toFixed(1)},${yy.toFixed(1)} A${rx.toFixed(1)},${ry.toFixed(1)} 0 0 0 ${(bx0 + rx).toFixed(1)},${yy.toFixed(1)}`,
            class: "fl-grad",
          }),
          svgEl("path", {
            d: `M${(bx0 + rx - 4).toFixed(1)},${yy.toFixed(1)}h11`,
            class: "fl-tick",
          }),
        );
        if (i && i < marks.length - 1) return;
        const lab = v === 0 ? "$0" : moneyW(v);
        g.append(svgEl("text", { x: bx0 + rx + 11, y: yy + 4, class: "fl-tick-label" }, lab));
        C.obstacles.push(fRect(bx0 + rx + 9, yy - 8, lab.length * 7.6 + 4, 15));
      });
    }
    add(cx + cy, g);
    C.tags.push({
      at: fP(cx, cy, 0.3 + zMax),
      text:
        today == null
          ? "No spend today"
          : budget
            ? `${money(today)} of ${moneyW(budget)}`
            : `${money(today)} today`,
      kind: hot ? "danger" : "plain",
      lift: 16,
    });
  }

  // the lorry at the end of the line (its deck carries today's despatches)
  {
    const g = svgEl("g", { class: "fl-lorry" });
    const wheel = (wx, wy) => {
      const [ex, ey] = fP(wx, wy, 0.16);
      return svgEl("ellipse", { cx: ex, cy: ey, rx: 5.2, ry: 7, class: "fl-wheel" });
    };
    // the far wheels go under the deck, the near ones over it
    g.append(wheel(10.95, 10.35), wheel(10.95, 11.6));
    g.append(fBox(10.95, 10.0, 0.32, 1.2, 2.05, 0.22, { base: "var(--fl-lorry-deck)" }));
    g.append(wheel(12.15, 10.35), wheel(12.15, 11.6));
    add(22.1, g);
    const cab = svgEl("g", { class: "fl-lorry" });
    cab.append(wheel(10.95, 12.6));
    cab.append(fBox(10.95, 12.12, 0.24, 1.2, 0.8, 0.95, { base: "var(--fl-lorry)" }));
    cab.append(
      fFace(
        [
          [11.05, 12.92, 0.72],
          [12.05, 12.92, 0.72],
          [12.05, 12.92, 1.08],
          [11.05, 12.92, 1.08],
        ],
        "var(--fl-glass)",
        FU,
        "f glass",
      ),
    );
    cab.append(wheel(12.15, 12.6));
    add(24.1, cab);
  }

  // the parcels, station by station; a ticket held on a bench is carried by its robot
  const benchRobots = [];
  const tagKind = (p) =>
    p.status === "blocked" || p.status === "failed" ? "danger" : p.needs ? "needs" : null;
  const linkFor = (p, cls) =>
    svgEl("a", {
      href: `#/ticket/${p.id}`,
      class: `fl-hit ${cls}`,
      "aria-label": floorSentence(p),
      "data-n": p.number,
      "data-id": p.id,
      "data-status": p.status,
      "data-tip-title": p.title,
    });
  let order = 0;
  for (const k of FLOOR_ORDER) {
    let list = m.byStation[k] || [];
    if (k === "assembly") {
      const held = list.filter((p) => p.who);
      held.sort(
        (a, b) => (Number(a.who.no) || 1e3) - (Number(b.who.no) || 1e3) || a.number - b.number,
      );
      benchRobots.push(...held.slice(0, m.benches));
      list = [...held.slice(m.benches), ...list.filter((p) => !p.who)];
    }
    const slots = floorSlots(k);
    list.forEach((p, i) => {
      const sl = slots[i];
      if (!sl) return;
      const top = fP(sl.x, sl.y, sl.z + sl.sz * 0.86 + 0.02);
      const a = linkFor(p, "fl-parcel");
      const inner = svgEl("g", { class: "fl-drop", style: `--i:${order++}` });
      if (sl.tilt)
        inner.setAttribute(
          "transform",
          `rotate(${p.number % 2 ? -9 : 7} ${top[0].toFixed(1)} ${(top[1] + 10).toFixed(1)})`,
        );
      inner.append(floorParcel(sl.x, sl.y, sl.z, sl.sz, sl.flat));
      a.append(
        inner,
        svgEl("polygon", {
          points: fHull(
            sl.x - sl.sz / 2,
            sl.y - sl.sz / 2,
            sl.z,
            sl.sz,
            sl.sz,
            sl.flat ? 0.07 : sl.sz * 0.86,
          ),
          class: "fl-ring",
        }),
      );
      add(sl.x + sl.y + 0.2 + (sl.z > 0.6 ? sl.z * 0.1 : 0), a);
      const tk = tagKind(p);
      if (k === "jam")
        C.tags.push({
          at: top,
          text: p.status === "paused" ? `#${p.number} paused` : `#${p.number}`,
          kind: tk || "plain",
          lift: 6,
        });
      else if (tk) C.tags.push({ at: top, text: `#${p.number}`, kind: tk, lift: sl.lift ?? 22 });
      // a robot holding a ticket off the benches stands beside its parcel
      if (p.who) {
        const [rx, ry] = floorBeside(k, sl);
        const { g } = floorRobot(rx, ry, p.who.no, false);
        const ra = linkFor(p, "fl-robot");
        ra.setAttribute("data-agent", p.agentId);
        ra.append(
          g,
          svgEl("polygon", {
            points: fHull(rx - 0.28, ry - 0.28, 0, 0.56, 0.56, 1.55),
            class: "fl-ring",
          }),
        );
        add(rx + ry + 0.3, ra);
      }
    });
    if (list.length > slots.length) {
      const last = slots[slots.length - 1];
      C.tags.push({
        at: fP(last.x, last.y, last.z + 0.5),
        text: `+${list.length - slots.length}`,
        kind: "plain",
        lift: 8,
      });
    }
  }
  // robots on the benches, each carrying the parcel of the ticket it holds
  benchRobots.forEach((p, idx) => {
    const x = fBenchX(idx) - 0.12;
    const y = 2.8;
    const { g, top } = floorRobot(x, y, p.who.no, true);
    const a = linkFor(p, "fl-parcel fl-robot");
    a.setAttribute("data-agent", p.agentId);
    const inner = svgEl("g", { class: "fl-bot-wrap", style: `--i:${idx}` });
    inner.append(g);
    a.append(
      inner,
      svgEl("polygon", {
        points: fHull(x - 0.28, y - 0.28, 0, 1.08, 0.56, 1.55),
        class: "fl-ring",
      }),
    );
    add(x + y + 0.3, a);
    if (p.needs) C.tags.push({ at: top, text: `#${p.number}`, kind: "needs", lift: 18 });
  });

  C.items.sort((a, b) => a.depth - b.depth);
  const vb = [-410, -56, 930, 580];
  for (const t of C.tags) t.w = Math.max(34, t.text.length * 7.4 + 14);
  fPlaceTags(C.tags, C.obstacles, vb);
  const tagLayer = svgEl("g", { class: "fl-tags", "aria-hidden": "true" });
  for (const t of C.tags) {
    const [x, y] = t.at;
    const [bx, by, w, h] = t.box;
    const [x0, y0, x1, y1] = fLeader(x, y, bx, by, w, h);
    const straight = Math.abs(x1 - x0) < 1;
    tagLayer.append(
      svgEl("g", { class: `fl-tag fl-tag-${t.kind}` }, [
        svgEl("path", {
          d: `M${x0.toFixed(1)},${y0.toFixed(1)}L${x1.toFixed(1)},${y1.toFixed(1)}`,
          class: "fl-tag-stem",
        }),
        straight ? null : svgEl("circle", { cx: x, cy: y - 2, r: 2.6, class: "fl-tag-dot" }),
        svgEl("rect", { x: bx, y: by, width: w, height: h, rx: 2, class: "fl-tag-box" }),
        svgEl(
          "text",
          { x: bx + w / 2, y: by + 14.5, "text-anchor": "middle", class: "fl-tag-text" },
          t.text,
        ),
      ]),
    );
  }
  const world = svgEl("g", { class: "fl-world" }, [floor, ...C.items.map((i) => i.node)]);
  const signLayer = svgEl("g", { class: "fl-signs", "aria-hidden": "true" }, C.signs);
  const svg = svgEl(
    "svg",
    {
      viewBox: vb.join(" "),
      class: "fl-svg",
      role: "group",
      "aria-label":
        "The factory floor, drawn from live data. Every parcel, robot and station is a link.",
    },
    [world, signLayer, tagLayer],
  );
  // The drawing itself is no Tab stop (Chromium made it one); its links are.
  svg.setAttribute("tabindex", "-1");
  floorTabOrder(svg);
  return svg;
}

/**
 * The drawing is painted back to front (its DOM order is depth), so the browser's
 * Tab order wandered: Drawing office, three of its parcels, Stores, then two more
 * drawing-office parcels. Tab and Shift+Tab inside the floor follow the stations
 * instead, in lifecycle order: each station, then its parcels and robots by ticket
 * number, the desk last. Leaving the floor at either end is the browser's own Tab.
 */
function floorTabOrder(svg) {
  const rank = (a) => {
    const k = a.dataset.station || FLOOR_STATION_OF[a.dataset.status] || "desk";
    const i = FLOOR_ORDER.indexOf(k);
    return [i < 0 ? FLOOR_ORDER.length : i, a.dataset.station ? 0 : 1, Number(a.dataset.n) || 0];
  };
  const ordered = () =>
    [...svg.querySelectorAll("a.fl-hit")]
      .map((a, dom) => ({ a, dom, r: rank(a) }))
      .sort((x, y) => x.r[0] - y.r[0] || x.r[1] - y.r[1] || x.r[2] - y.r[2] || x.dom - y.dom)
      .map((x) => x.a);
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
    const list = ordered();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const next = list[i + (e.shiftKey ? -1 : 1)];
    if (next) {
      e.preventDefault();
      next.focus();
      return;
    }
    // Off the end: hand the browser the anchor at that end of the DOM, and its own
    // Tab carries on out of the floor from there.
    const all = [...svg.querySelectorAll("a.fl-hit")];
    all[e.shiftKey ? 0 : all.length - 1]?.focus();
  });
  // Tabbing IN lands on the first station going forward, the last thing going back
  // (a click focuses what was clicked: only keyboard entry is redirected).
  let pointing = false;
  svg.addEventListener("pointerdown", () => {
    pointing = true;
    setTimeout(() => (pointing = false), 0);
  });
  svg.addEventListener("focusin", (e) => {
    const from = e.relatedTarget;
    if (pointing || !from || (from !== svg && svg.contains(from))) return;
    if (!e.target.closest?.("a.fl-hit")) return;
    const list = ordered();
    const forward = Boolean(from.compareDocumentPosition(svg) & from.DOCUMENT_POSITION_FOLLOWING);
    const want = forward ? list[0] : list[list.length - 1];
    if (want && want !== e.target) want.focus();
  });
}

/**
 * The hover and focus card: the ticket number and title (and what the floor says
 * about it), kept inside the stage so it can never widen the page.
 */
function wireFloorTips(stage, tip) {
  const show = (a) => {
    clear(tip);
    const n = a.getAttribute("data-n");
    const label = a.getAttribute("aria-label") || "";
    if (n) {
      const title = a.getAttribute("data-tip-title") || "";
      const rest = label.slice(`#${n} ${title}`.length).replace(/^,\s*/, "");
      tip.append(
        el("b", {}, `#${n}`),
        " ",
        el("span", { class: "fl-tip-title" }, title),
        rest ? el("span", { class: "fl-tip-sub" }, rest) : null,
      );
    } else tip.append(el("span", { class: "fl-tip-title" }, label.replace(/ Open in Work\.$/, "")));
    tip.hidden = false;
    const sr = stage.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = r.left - sr.left + r.width / 2 - tw / 2;
    let y = r.top - sr.top - th - 8;
    if (y < 4) y = r.bottom - sr.top + 8;
    x = Math.max(4, Math.min(sr.width - tw - 4, x));
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  };
  const hide = () => {
    tip.hidden = true;
  };
  const hitOf = (e) => (e.target && e.target.closest ? e.target.closest("a.fl-hit") : null);
  stage.addEventListener("pointerover", (e) => {
    const a = hitOf(e);
    if (a) show(a);
  });
  stage.addEventListener("pointerout", (e) => {
    const a = hitOf(e);
    if (a && !a.contains(e.relatedTarget)) hide();
  });
  stage.addEventListener("focusin", (e) => {
    const a = hitOf(e);
    if (a) show(a);
  });
  stage.addEventListener("focusout", hide);
}

/** The stream's state in the floor's words (null while live or still connecting). */
function floorStreamLine() {
  const st = freshness.state();
  if (st === "offline") {
    const at = freshness.lastOkAt;
    return at
      ? `Can't reach the factory: this is the floor as it stood at ${clockTime(at)}. It moves again when the factory answers.`
      : "Can't reach the factory: the floor moves again when the factory answers.";
  }
  if (st === "polling")
    return "The live stream is down: the floor redraws every 9 seconds instead of the moment a ticket moves.";
  return null;
}

let floorArrived = false;
let floorBootAt = 0;
/** #/floor: the factory floor, live. */
async function renderFloor() {
  const f = await loadMatchDay();
  const m = floorModel(f);
  const wrap = el("div", { class: "view view-floor" });
  const robots = m.robots.length;
  const jam = (m.byStation.jam || []).length;
  const facts = [
    plural(m.open.length, "parcel") + " on the floor",
    `${plural(robots, "robot")} on ${plural(m.benches, "bench", "benches")}`,
    `${jam} in the jam bay`,
    `${m.despatched.length} despatched today`,
    m.today == null
      ? "no wage bill recorded today"
      : m.budget
        ? `${money(m.today)} of the ${moneyW(m.budget)} wage bill`
        : `${money(m.today)} wage bill today`,
  ];
  wrap.appendChild(
    viewHead(
      "Floor",
      "The factory floor: every ticket as a parcel moving station to station, every agent a robot on the one it holds.",
    ),
  );
  wrap.appendChild(el("p", { class: "fl-facts" }, facts.join(" · ")));

  // The stream line lives outside the data signature: it follows the tracker.
  const streamP = el("p", { class: "fl-stream", hidden: true });
  const paintStream = () => {
    // A page that has only just loaded is still connecting: give the stream a moment.
    const line = floorStreamLine();
    const early = Date.now() - floorBootAt < 6000 && freshness.state() === "polling";
    streamP.hidden = !line || early;
    clear(streamP);
    if (line && !early) streamP.append(glyph("blocked", 16), el("span", {}, line));
  };
  if (!floorBootAt) floorBootAt = Date.now();
  paintStream();
  freshness.listeners.add(paintStream);
  const streamTimer = setTimeout(paintStream, 6500);
  wrap.appendChild(streamP);

  // Quiet whenever no parcel is in play, not only before the first despatch: after
  // the day's last merge the floor is just as empty, so say so, with the day's count.
  if (!m.open.length)
    wrap.appendChild(
      el("div", { class: "empty-state fl-quiet" }, [
        el(
          "p",
          { class: "es-title" },
          m.despatched.length
            ? [
                `The floor is quiet: no tickets in play, ${m.despatched.length} despatched today. `,
                el("a", { href: "#/create" }, "Plan a build"),
                " to start the next one.",
              ]
            : [
                "The floor is quiet: no tickets in play. ",
                el("a", { href: "#/create" }, "Plan a build"),
                " to start the shift.",
              ],
        ),
      ]),
    );

  const svg = floorScene(m);
  if (!floorArrived && !prefersReducedMotion()) svg.classList.add("is-arriving");
  const tip = el("div", { class: "fl-tip", "aria-hidden": "true", hidden: true });
  const stage = el("div", { class: "fl-stage" }, [svg, tip]);
  wireFloorTips(stage, tip);

  // The key and the text of the floor: stations in lifecycle order with their
  // tickets, and who is on the benches (shirt, name, ticket).
  const key = el("ul", { class: "fl-key", "aria-label": "Key" }, [
    el("li", {}, [el("i", { class: "fl-sw fl-sw-needs" }), "Needs you"]),
    el("li", {}, [el("i", { class: "fl-sw fl-sw-red" }), "Blocked or failed"]),
    el("li", {}, [el("i", { class: "fl-sw fl-sw-lit" }), "Lit glass: the station holds work"]),
    el("li", {}, [
      el("i", { class: "fl-sw fl-sw-bot" }),
      "A robot: an agent (shirt number) on a live claim",
    ]),
    el("li", {}, [
      el("i", { class: "fl-sw fl-sw-tank" }),
      "Tank: today's wage bill against the daily budget",
    ]),
  ]);
  const stations = el(
    "ol",
    { class: "fl-stations", "aria-label": "Stations, in lifecycle order" },
    FLOOR_ORDER.map((k) => {
      const st = FLOOR_STATIONS[k];
      const list = m.byStation[k] || [];
      return el("li", { dataset: { station: k } }, [
        el("i", { class: `fl-sw fl-sw-${k}`, "aria-hidden": "true" }),
        el("span", { class: "fl-st-name" }, st.name),
        el(
          "span",
          { class: "fl-st-what" },
          k === "despatch"
            ? "done today"
            : st.statuses.map((s) => statusLabel(s).toLowerCase()).join(", "),
        ),
        el("span", { class: "fl-st-n tabnum" }, String(list.length)),
        list.length
          ? el(
              "span",
              { class: "fl-st-tickets" },
              list.map((p) =>
                el("a", { href: `#/ticket/${p.id}`, title: p.title }, `#${p.number}`),
              ),
            )
          : null,
      ]);
    }),
  );
  const bench = el("div", { class: "fl-bench" }, [
    el("h3", {}, "On the benches"),
    m.robots.length
      ? el(
          "ul",
          {},
          m.robots.map((p) =>
            el("li", {}, [
              agentTag(p.who.name, 22, p.who.no, agentTitle(p.who)),
              el("a", { href: `#/ticket/${p.id}` }, [el("b", {}, `#${p.number}`), " ", p.title]),
              el(
                "span",
                { class: "fl-bench-st" },
                FLOOR_WORDS[p.status] || statusLabel(p.status, p.landing_state),
              ),
            ]),
          ),
        )
      : el("p", {}, `No robot is on the floor: ${plural(m.benches, "bench", "benches")} free.`),
  ]);
  wrap.appendChild(
    el("section", { class: "fl-panel", "aria-labelledby": "fl-h" }, [
      el("div", { class: "fl-head" }, [
        el("h2", { id: "fl-h", class: "fl-title" }, [
          "The floor",
          el("span", { class: "panel-aux" }, `${m.open.length} in play`),
        ]),
        el(
          "p",
          { class: "fl-note" },
          "The line runs from the drawing office to the lorry; the jam bay is off it. Hover or focus a parcel for its ticket.",
        ),
      ]),
      stage,
      el("div", { class: "fl-legend" }, [key, el("div", { class: "fl-lists" }, [stations, bench])]),
    ]),
  );

  wrap.dataset.sig = hashText(
    JSON.stringify([
      [...m.open, ...m.despatched].map((p) => [
        p.id,
        p.status,
        p.title,
        p.needs,
        p.who && [p.who.name, p.who.no],
        p.by && [p.by.name, p.by.no],
        p.running,
      ]),
      m.benches,
      m.decisions,
      m.today,
      m.budget,
    ]),
  );
  wrap._mounted = () => {
    floorArrived = true;
  };
  wrap._dispose = () => {
    freshness.listeners.delete(paintStream);
    clearTimeout(streamTimer);
  };
  return wrap;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest?.('a[href^="#"]');
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const href = a.getAttribute("href");
  if (href.startsWith("#/") || href === "#") return;
  if (jumpTo(href.slice(1))) e.preventDefault();
});

/**
 * The members' entrance asks for nothing it cannot have. With no token, the public
 * /healthz says whether this server wants one, and if it does the gate is drawn
 * straight away (no data call that can only answer 401). With a token, ONE whoami
 * checks it first: a wrong token gets the gate from that one answer instead of a
 * page of refused reads and a live stream, and a right one tells the views at once
 * whether this token is read-only. Answers whether the dashboard may start.
 */
async function passGate() {
  if (!authToken()) {
    try {
      const res = await fetch("/healthz");
      const body = res.ok ? await res.json() : null;
      if (body && body.auth === true) {
        renderLogin(false);
        return false;
      }
    } catch {
      // An old server or a blip: start, and let the first read say if a token is needed.
    }
    return true;
  }
  try {
    const who = await api("GET", "/api/whoami");
    if (who && typeof who === "object" && who.capability) learnWhoami(who);
  } catch (e) {
    if (e && e.code === "UNAUTHORIZED") return false; // api() drew the gate already
    // Slow, failing or unreachable: start anyway (unknown counts as full; the server
    // still refuses a read token's writes), without a second wait for the same answer.
    squad.whoamiFailed = true;
  }
  return true;
}

async function start() {
  adoptTokenFromUrl(); // one-scan token pickup (QR) before the first authed call
  if (!(await passGate())) return;
  buildChrome();
  window.addEventListener("hashchange", () => {
    // A bare fragment that names a section on this page is a jump, not a route.
    const h = location.hash || "";
    if (h.length > 1 && !h.startsWith("#/") && jumpTo(h.slice(1))) return;
    // A sheet belongs to the page that opened it: a reason being written for #15 must
    // never stay over #20 (Back, a link, a typed address), where confirming it would
    // act on a ticket the reader is no longer looking at.
    if (sheetOpen()) closeSheet({ restore: false });
    router();
  });
  router();
}
start();

export { openClubSheet, renderSquad, renderFloor };
