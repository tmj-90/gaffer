// Kit colours: contrast maths, the house kit and the club's kit tokens.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { paintBrand } from "./chrome.js";
import { squad } from "./club.js";

// The kit: the club's colours drive the claret/sky tokens. Contrast is guarded:
// a kit too light for white text flips the text on it to ink, the shirt number
// stays readable on the shirt, and claret-as-text is darkened (or lightened on
// the floodlit kit) until it reads on paper.
const RGB_WHITE = [255, 255, 255];
const RGB_INK = [14, 23, 38]; // --ink / --counter-ink
const RGB_PAPER_DARK = [31, 36, 48]; // --paper, floodlit
const RGB_BOARD = [17, 19, 24]; // --board
const RGB_HOUSE_CLARET = [122, 22, 49];
const RGB_HOUSE_SKY = [149, 205, 235];
function hexRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbHex(c) {
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}
function relLum(c) {
  const f = (v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}
function contrastRatio(a, b) {
  const la = relLum(a);
  const lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgbCss = (c) => `rgb(${c[0]} ${c[1]} ${c[2]})`;
/** Move `c` towards `to` until it reads at `min`:1 on `bg`. */
function readableOn(c, bg, to, min = 4.5) {
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const m = mixRgb(c, to, t);
    if (contrastRatio(m, bg) >= min) return m;
  }
  return to;
}
/** A text colour on `bg` (white or ink, whichever reads better) and its quieter tint. */
function inkOn(bg) {
  const light = contrastRatio(bg, RGB_WHITE) >= contrastRatio(bg, RGB_INK);
  const on = light ? RGB_WHITE : RGB_INK;
  const quiet = mixRgb(on, bg, 0.18);
  return { light, on, quiet: contrastRatio(quiet, bg) >= 4.5 ? quiet : on };
}
/**
 * The kit tokens for a club's colours: { token: value } (null = the house value).
 * Applied to :root for the whole app, or to one element for a live preview.
 */
function kitTokens(primary, secondary) {
  const P = hexRgb(primary);
  const S = hexRgb(secondary);
  const out = {
    "--claret": null,
    "--claret-ink": null,
    "--on-claret": null,
    "--on-claret-2": null,
    "--shirt-edge": null,
    "--sky": null,
    "--on-sky": null,
    "--on-sky-2": null,
    "--sky-wash": null,
    "--shirt-no": null,
    "--sky-on-board": null,
  };
  if (P) {
    const t = inkOn(P);
    out["--claret"] = primary;
    out["--on-claret"] = t.light ? null : "var(--counter-ink)";
    out["--on-claret-2"] = rgbCss(t.quiet);
    out["--shirt-edge"] = rgbCss(mixRgb(P, [0, 0, 0], 0.55));
    out["--claret-ink"] =
      `light-dark(${rgbCss(readableOn(P, RGB_WHITE, RGB_INK))}, ${rgbCss(readableOn(P, RGB_PAPER_DARK, RGB_WHITE))})`;
  }
  if (S) {
    const t = inkOn(S);
    out["--sky"] = secondary;
    out["--on-sky"] = t.light ? "var(--board-ink)" : null;
    out["--on-sky-2"] = rgbCss(t.quiet);
    out["--sky-wash"] =
      `light-dark(color-mix(in srgb, ${secondary} 20%, var(--paper)), color-mix(in srgb, ${secondary} 10%, var(--paper)))`;
    out["--sky-on-board"] = contrastRatio(S, RGB_BOARD) < 4.5 ? "var(--board-ink-2)" : "var(--sky)";
  }
  if (P || S) {
    // The stencil number is cut in the second colour: on a shirt of a close colour it
    // takes the shirt's text colour instead.
    const p = P || RGB_HOUSE_CLARET;
    const s2 = S || RGB_HOUSE_SKY;
    out["--shirt-no"] = contrastRatio(p, s2) < 3 ? "var(--on-claret)" : "var(--sky)";
  }
  return out;
}
/** The house kit's token values, read before the club's kit is first worn. */
let houseKit = null;
function readHouseKit() {
  if (houseKit) return houseKit;
  houseKit = {};
  try {
    const cs = window.getComputedStyle(document.documentElement);
    for (const k of Object.keys(kitTokens(null, null))) {
      const v = cs.getPropertyValue(k).trim();
      if (v) houseKit[k] = v;
    }
  } catch {
    /* no computed style (tests): the stylesheet's values stand */
  }
  return houseKit;
}
/**
 * Wear `tokens` on a node. A null token is the house value: removed from :root
 * (the stylesheet holds it), or written out on a preview inside a kitted page.
 */
function setKitTokens(node, tokens) {
  const root = node === document.documentElement;
  const house = readHouseKit();
  for (const [k, v] of Object.entries(tokens)) {
    if (v != null) node.style.setProperty(k, v);
    else if (!root && house[k]) node.style.setProperty(k, house[k]);
    else node.style.removeProperty(k);
  }
}
/** The club's name and letters, with the house fallbacks. */
function clubName() {
  return (squad.club && squad.club.name_effective) || "Gaffer";
}
function clubLetters() {
  return (squad.club && squad.club.short_name_effective) || "GAF";
}
/** Take a ClubView: repaint the crest and the header, and wear its kit. */
function applyClub(club) {
  if (!club || typeof club !== "object") return;
  squad.club = club;
  setKitTokens(document.documentElement, kitTokens(club.kit_primary, club.kit_secondary));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    if (!meta.dataset.house) meta.dataset.house = meta.getAttribute("content") || "";
    meta.setAttribute("content", club.kit_primary || meta.dataset.house);
  }
  paintBrand();
}

export {
  RGB_HOUSE_CLARET,
  RGB_HOUSE_SKY,
  rgbHex,
  kitTokens,
  readHouseKit,
  setKitTokens,
  clubName,
  clubLetters,
  applyClub,
};
