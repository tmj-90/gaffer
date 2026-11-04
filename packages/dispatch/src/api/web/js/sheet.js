// Detail sheet (mobile bottom-sheet / desktop side-panel).
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { clear, el } from "./dom.js";

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
function openSheet(title, contentNode, { focus } = {}) {
  const { scrim, sheet, head, body } = ensureSheet();
  // A sheet opened from inside an open sheet keeps the ORIGINAL trigger to return to.
  if (!sheet.classList.contains("open")) sheetReturnFocus = document.activeElement;
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
  trackKeyboardInset(true);
  // Move focus INTO the dialog so keyboard/AT users aren't stranded behind it:
  // to the field the sheet is for when it names one, else its first control.
  const first = focus || focusableIn(sheet)[0];
  (first || sheet).focus();
}
/**
 * Close the sheet. Focus goes back to the control that opened it; `restore: false`
 * (a route change) leaves focus to the new page. A click handler passes its event
 * here, which has no `restore`, so a Close or Cancel button restores focus.
 */
function closeSheet({ restore = true } = {}) {
  if (!sheetEls) return;
  const wasOpen = sheetEls.sheet.classList.contains("open");
  sheetEls.scrim.classList.remove("open");
  sheetEls.sheet.classList.remove("open");
  document.removeEventListener("keydown", sheetKeydown);
  trackKeyboardInset(false);
  // Restore focus to whatever opened the sheet (the trigger), not the body.
  const back = sheetReturnFocus;
  sheetReturnFocus = null;
  if (!restore || !wasOpen) return;
  if (back && back.isConnected && typeof back.focus === "function") back.focus();
}
/**
 * While a sheet is open on a phone, keep it above the soft keyboard: the
 * keyboard's height (layout viewport minus the visual one) goes into --kb,
 * which the phone sheet sits on, so its sticky confirm row stays in view.
 */
function onViewportInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  document.documentElement.style.setProperty("--kb", `${kb}px`);
}
function trackKeyboardInset(on) {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv) return;
  if (on) {
    vv.addEventListener("resize", onViewportInset);
    vv.addEventListener("scroll", onViewportInset);
    onViewportInset();
  } else {
    vv.removeEventListener("resize", onViewportInset);
    vv.removeEventListener("scroll", onViewportInset);
    document.documentElement.style.removeProperty("--kb");
  }
}
/** Is the shared sheet showing? */
function sheetOpen() {
  return Boolean(sheetEls && sheetEls.sheet.classList.contains("open"));
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

export { openSheet, closeSheet, sheetOpen };
