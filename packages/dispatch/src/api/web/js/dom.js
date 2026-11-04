// DOM helpers: the page's mount points, el/svgEl/clear and the labelled form field.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { appState } from "./state.js";

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
function field(labelText, control, attrs = {}) {
  if (!control.id) control.id = `field-${++appState.fieldSeq}`;
  const { class: extra, ...rest } = attrs;
  return el("div", { ...rest, class: extra ? `field ${extra}` : "field" }, [
    el("label", { for: control.id }, labelText),
    control,
  ]);
}

export { app, appbar, bottomnav, prefersReducedMotion, el, SVGNS, svgEl, clear, field };
