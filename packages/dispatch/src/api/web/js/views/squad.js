// The club and the squad: Name your club (the crest) and #/squad.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { agentWho } from "../access.js";
import { api } from "../api.js";
import { paintBrand } from "../chrome.js";
import {
  ROLE_LABELS,
  applySquad,
  canEditSquad,
  ensureSquad,
  learnDisplay,
  squad,
} from "../club.js";
import { emptyState, viewHead } from "../components.js";
import { app, el, field } from "../dom.js";
import { fmtRelative, fmtTime, plural } from "../format.js";
import { agentShirt, badge, crest } from "../icons.js";
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
} from "../kit.js";
import { refreshCurrentView } from "../live.js";
import { routeSignal } from "../router.js";
import { closeSheet, openSheet } from "../sheet.js";
import { appState } from "../state.js";
import { toast } from "../toast.js";
import { progPage } from "./programme.js";
import { hashText } from "./work.js";

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

export { openClubSheet, renderSquad };
