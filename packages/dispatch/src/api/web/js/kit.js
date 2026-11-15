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
// Every ground kit text sits on (tokens.css): --paper and --paper-2 in each kit, and
// the scoreboard's --board and --board-2 (the board is dark in both kits).
const RGB_PAPER_2 = [246, 248, 243]; // --paper-2, day
const RGB_PAPER_2_DARK = [38, 44, 57]; // --paper-2, floodlit
const RGB_BOARDS = [RGB_BOARD, [14, 16, 21], [29, 32, 41], [26, 29, 37]];
// The house --sky-wash (selected and hover rows), day and floodlit.
const RGB_HOUSE_WASH = [221, 239, 249];
const RGB_HOUSE_WASH_DARK = [30, 52, 66];
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
/** Move `c` towards `to` until it reads at `min`:1 on `bg` (one ground or several). */
function readableOn(c, bg, to, min = 4.5) {
  const grounds = Array.isArray(bg[0]) ? bg : [bg];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const m = mixRgb(c, to, t);
    if (grounds.every((g) => contrastRatio(m, g) >= min)) return m;
  }
  return to;
}
// OKLab distance (x100): the measure the dataviz palette validator uses.
function oklab(c) {
  const [r, g, b] = c.map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function okDistance(a, b) {
  const p = oklab(a);
  const q = oklab(b);
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
// The referee's cards (tokens.css --yellow, --red, --ok, day and floodlit values).
// A club colour closer than KIT_CLASH to any of them would read as a status where
// it paints a block, a hoop or a chart, so there it gives way to the house kit.
const KIT_CLASH = 15;
const CARDS = [
  { card: "yellow", words: "the referee's yellow card (needs you)", rgb: [[255, 204, 31]] },
  {
    card: "red",
    words: "the referee's red card (blocked or failed)",
    rgb: [
      [200, 16, 46],
      [255, 123, 123],
    ],
  },
  {
    card: "ok",
    words: "the green of a passed check",
    rgb: [
      [31, 107, 58],
      [127, 212, 154],
    ],
  },
];
/**
 * The card a colour is too close to ({ card, words, distance }), or null. The house
 * kit's own two colours are the fallback and never flagged (the house sky sits 12.7
 * from the floodlit pass green, where it is only a hoop and a collar; its floodlit
 * block is the deep --sky-block).
 */
function cardClash(hex) {
  const c = hexRgb(hex);
  if (!c) return null;
  const h = rgbHex(c);
  if (h === rgbHex(RGB_HOUSE_CLARET) || h === rgbHex(RGB_HOUSE_SKY)) return null;
  let near = null;
  for (const k of CARDS) {
    for (const rgb of k.rgb) {
      const d = okDistance(c, rgb);
      if (d < KIT_CLASH && (!near || d < near.distance))
        near = { card: k.card, words: k.words, distance: Math.round(d * 10) / 10 };
    }
  }
  return near;
}
/** The club's colours that clash with a card: [{ which, hex, card, words, distance }]. */
function kitClashes(primary, secondary) {
  const out = [];
  for (const [which, hex] of [
    ["primary", primary],
    ["secondary", secondary],
  ]) {
    const c = cardClash(hex);
    if (c) out.push({ which, hex, ...c });
  }
  return out;
}
/** One line for the club editor: which colour gave way, to what, and why ("" if none). */
function kitClashNote(primary, secondary) {
  const clashes = kitClashes(primary, secondary);
  if (!clashes.length) return "";
  const ord = { primary: "first", secondary: "second" };
  const house = {
    primary: "the header and blocks use the house claret",
    secondary: "blocks and hoops use the house sky",
  };
  if (clashes.length === 2) {
    const cards = [...new Set(clashes.map((c) => c.words))].join(" and ");
    return `Both colours are close to ${cards}, so the header, blocks and hoops use the house kit; shirts and the crest keep yours.`;
  }
  const c = clashes[0];
  return `Your ${ord[c.which]} colour is close to ${c.words}, so ${house[c.which]}; shirts and the crest keep it.`;
}
/** The house claret as text, day and floodlit (tokens.css --claret-ink). */
const HOUSE_INK_DAY = [122, 22, 49];
const HOUSE_INK_NIGHT = [232, 180, 196];
/** A derived text colour, or `house` when it sits within KIT_CLASH of a referee's card. */
function inkClear(c, house) {
  return CARDS.some((k) => k.rgb.some((rgb) => okDistance(c, rgb) < KIT_CLASH)) ? house : c;
}
/**
 * The crest's letters on the first colour: white when it reads at 4.5:1, else the ink
 * stepped toward black with readableOn until it does (white or black always can: a
 * mid tone that gave the plain ink only 4.24:1 now reads at 4.5).
 */
function crestInk(bg) {
  if (contrastRatio(bg, RGB_WHITE) >= 4.5) return "#ffffff";
  const ink = readableOn(RGB_INK, bg, [0, 0, 0]);
  return rgbHex(ink) === rgbHex(RGB_INK) ? "var(--counter-ink)" : rgbCss(ink);
}
/** A text colour on `bg` (white or ink, whichever reads better) and its quieter tint. */
function inkOn(bg) {
  const light = contrastRatio(bg, RGB_WHITE) >= contrastRatio(bg, RGB_INK);
  const on = light ? RGB_WHITE : RGB_INK;
  const quiet = mixRgb(on, bg, 0.18);
  return { light, on, quiet: contrastRatio(quiet, bg) >= 4.5 ? quiet : on };
}
/**
 * A block's ground for a club colour: the colour itself when white or ink reads on
 * it at 4.5:1, else the colour stepped away from its text until one does (a mid
 * tone, such as white mixed down for the floodlit block, reads at only 4.2 to 4.5).
 */
function blockGround(bg) {
  const t = inkOn(bg);
  if (contrastRatio(bg, t.on) >= 4.5) return bg;
  return readableOn(bg, t.on, t.light ? [0, 0, 0] : RGB_WHITE);
}
/**
 * The kit tokens for a club's colours: { token: value } (null = the house value).
 * Applied to :root for the whole app, or to one element for a live preview.
 * The role tokens (claret and sky: the header, blocks, hoops, washes) take a club
 * colour only when it is at least KIT_CLASH from every referee's card; a colour
 * that is too close stays on the identity tokens (--kit-1, --kit-2: shirts, the
 * crest) and the roles keep the house values. Charts never read the kit
 * (--viz-* in tokens.css).
 */
function kitTokens(primary, secondary) {
  const P0 = hexRgb(primary);
  const S0 = hexRgb(secondary);
  const P = P0 && !cardClash(primary) ? P0 : null;
  const S = S0 && !cardClash(secondary) ? S0 : null;
  const out = {
    "--kit-1": null,
    "--on-kit-1": null,
    "--kit-2": null,
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
    "--sky-block": null,
    "--on-sky-block": null,
    "--on-sky-block-2": null,
  };
  if (P0) {
    out["--kit-1"] = primary;
    out["--on-kit-1"] = crestInk(P0);
    out["--shirt-edge"] = rgbCss(mixRgb(P0, [0, 0, 0], 0.55));
  }
  if (S0) out["--kit-2"] = secondary;
  if (P) {
    const t = inkOn(P);
    out["--claret"] = primary;
    out["--on-claret"] = t.light ? null : "var(--counter-ink)";
    out["--on-claret-2"] = rgbCss(t.quiet);
    // Claret as text (ticket numbers, ranks) sits on paper, the zebra paper-2 and the
    // selected-row sky wash: it reads at 4.5:1 on every one of them, in each kit.
    const wash = S ? mixRgb(RGB_WHITE, S, 0.2) : RGB_HOUSE_WASH;
    const washDark = S ? mixRgb(RGB_PAPER_DARK, S, 0.1) : RGB_HOUSE_WASH_DARK;
    // A stepped ink can land near a referee's card although the club colour does not
    // (#009900 steps to 10.3 from the pass green): text then keeps the house ink.
    const day = inkClear(readableOn(P, [RGB_WHITE, RGB_PAPER_2, wash], RGB_INK), HOUSE_INK_DAY);
    const night = inkClear(
      readableOn(P, [RGB_PAPER_DARK, RGB_PAPER_2_DARK, washDark], RGB_WHITE),
      HOUSE_INK_NIGHT,
    );
    out["--claret-ink"] = `light-dark(${rgbCss(day)}, ${rgbCss(night)})`;
  }
  if (S) {
    const t = inkOn(S);
    out["--sky"] = secondary;
    out["--on-sky"] = t.light ? "var(--board-ink)" : null;
    out["--on-sky-2"] = rgbCss(t.quiet);
    out["--sky-wash"] =
      `light-dark(color-mix(in srgb, ${secondary} 20%, var(--paper)), color-mix(in srgb, ${secondary} 10%, var(--paper)))`;
    out["--sky-on-board"] = RGB_BOARDS.every((g) => contrastRatio(S, g) >= 4.5)
      ? "var(--sky)"
      : "var(--board-ink-2)";
    // A sky block is chosen for each kit: the club colour on the day kit, a deep
    // step of it under floodlights (as the house sky's block is), each with its text
    // at 4.5:1 or better.
    const day = blockGround(S);
    const dark = blockGround(mixRgb(S, RGB_PAPER_DARK, 0.62));
    const b = inkOn(day);
    const d = inkOn(dark);
    const dayCss = day === S ? secondary : rgbCss(day);
    out["--sky-block"] = `light-dark(${dayCss}, ${rgbCss(dark)})`;
    out["--on-sky-block"] = `light-dark(${rgbCss(b.on)}, ${rgbCss(d.on)})`;
    out["--on-sky-block-2"] = `light-dark(${rgbCss(b.quiet)}, ${rgbCss(d.quiet)})`;
  }
  if (P0 || S0) {
    // The stencil number is cut in the second colour: on a shirt of a close colour it
    // takes the shirt's text colour instead. Shirts always wear the club's colours.
    const p = P0 || RGB_HOUSE_CLARET;
    const s2 = S0 || RGB_HOUSE_SKY;
    out["--shirt-no"] =
      contrastRatio(p, s2) < 3
        ? inkOn(p).light
          ? "#ffffff"
          : "var(--counter-ink)"
        : "var(--kit-2)";
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
    // The browser's bar is the header's colour: a first colour that gives way to the
    // house claret there gives way here too.
    const own = club.kit_primary && hexRgb(club.kit_primary) && !cardClash(club.kit_primary);
    meta.setAttribute("content", own ? club.kit_primary : meta.dataset.house);
  }
  paintBrand();
}

export {
  RGB_HOUSE_CLARET,
  RGB_HOUSE_SKY,
  rgbHex,
  KIT_CLASH,
  okDistance,
  cardClash,
  crestInk,
  kitClashes,
  kitClashNote,
  kitTokens,
  readHouseKit,
  setKitTokens,
  clubName,
  clubLetters,
  applyClub,
};
