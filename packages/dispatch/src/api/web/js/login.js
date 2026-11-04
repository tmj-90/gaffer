// Login gate (restyled, behaviour preserved) and logout.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { clearAuthToken, setAuthToken } from "./api.js";
import { appbar, bottomnav, clear, el } from "./dom.js";
import { crest, glyph } from "./icons.js";
import { authLost, goQuietForLogin } from "./live.js";
import { closeSheet } from "./sheet.js";

// --- Login gate (restyled, behaviour preserved) -----------------------------

/** Render the access-token login gate into #app and hide app chrome. */
function renderLogin(wasWrong) {
  const root = document.getElementById("app");
  if (!root) return;
  // Reads already in flight when the token stopped working each answer 401 too: the
  // gate is drawn once, so a token being typed into it is never wiped by a redraw.
  if (authLost && root.querySelector("form.login-gate")) return;
  goQuietForLogin();
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
    id: "login-token",
    placeholder: "paste the token",
    autocomplete: "off",
    autofocus: "",
    "aria-describedby": wasWrong ? "login-error login-hint" : "login-hint",
    "aria-invalid": wasWrong ? "true" : null,
  });
  // The members' entrance: a match ticket. The claret stub is the club; the
  // rest is the one field, the one button, and where the token comes from.
  const form = el("form", { class: "login-gate gate-ticket", "aria-labelledby": "login-title" }, [
    el("div", { class: "gate-stub", "aria-hidden": "true" }, [
      crest("login-mark", 64, 76),
      el("span", { class: "gate-club" }, "Gaffer"),
      el("span", { class: "gate-admit" }, "Admit one · the gaffer"),
    ]),
    el("div", { class: "gate-main" }, [
      el("h1", { id: "login-title" }, "Members’ entrance"),
      el("p", { class: "gate-lede" }, "This factory needs an access token."),
      wasWrong
        ? el("p", { class: "login-error", id: "login-error", role: "alert" }, [
            glyph("failed", 16),
            el("span", {}, "That token was rejected — try again."),
          ])
        : null,
      el("label", { class: "gate-label", for: "login-token" }, "Access token"),
      input,
      el("button", { class: "btn primary", type: "submit" }, "Enter"),
      // Tell a new operator where the token actually comes from — the hardest
      // first-run wall was a gate that never said this.
      el("p", { class: "login-hint", id: "login-hint" }, [
        "Run ",
        el("code", { class: "mono" }, "gaffer dashboard"),
        ": it prints a login URL with the token. Or paste the contents of ",
        el("code", { class: "mono" }, "$GAFFER_DATA/dashboard-token"),
        " (or your ",
        el("code", { class: "mono" }, "DISPATCH_API_TOKEN"),
        ").",
      ]),
    ]),
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

export { renderLogin, logout };
