// One colour vocabulary in the dashboard's stylesheets (src/api/web/css).
//
// tokens.css keeps four vocabularies apart: the club kit is identity, the referee's
// cards are status, chart marks are data, the factory floor's stations are stages.
// This reads the stylesheets as text and holds them to that:
//   - chart marks wear --viz-* tokens (light, dark and board steps), never the kit,
//     and the steps pass the dataviz palette checks on the surfaces they sit on
//     (mark and accent as a two-colour set: normal-vision OKLab >= 15, CVD >= 8
//     under protanopia and deuteranopia, 3:1 against each surface);
//   - dark mode is chosen, not flipped: sky blocks, card frames and the board's
//     outline have their own floodlit values;
//   - status yellow is only status: unsaved markers, the no-go row and the
//     review strip's "worth a look" cell do not wear it;
//   - the stations of the floor pass the same checks in drawing order;
//   - no stray hex colours outside tokens.css, and the off-scale sizes are gone.
// OKLab and the Machado-Oliveira-Fernandes (2009) CVD transforms are the ones the
// dataviz validator uses (scripts/validate_palette.js in the dataviz skill).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const CSS = path.resolve(process.cwd(), "src/api/web/css");
const read = (f: string) => readFileSync(path.join(CSS, f), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const TOKENS = strip(read("tokens.css"));
const VIEW_FILES = readdirSync(path.join(CSS, "views"))
  .filter((f) => f.endsWith(".css"))
  .map((f) => `views/${f}`);
const ALL_FILES = [
  "base.css",
  "layout.css",
  "components.css",
  "utilities.css",
  "shell.css",
  ...VIEW_FILES,
];

/** The value a token is declared with in tokens.css. */
function token(name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(TOKENS);
  if (!m) throw new Error(`${name} is not declared in tokens.css`);
  return m[1]!.trim();
}
/** [light, dark] hexes of a `light-dark(#a, #b)` token (a constant gives it twice). */
function pair(name: string): [string, string] {
  const v = token(name);
  const ld = /^light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)$/i.exec(v);
  if (ld) return [ld[1]!, ld[2]!];
  if (/^#[0-9a-f]{6}$/i.test(v)) return [v, v];
  throw new Error(`${name}: ${v} is not a hex or light-dark pair`);
}
/** The declarations of every rule whose selector list contains `sel` exactly. */
function decls(file: string, sel: string): string {
  const css = strip(read(file));
  let out = "";
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1]!.split(",").some((s) => s.trim() === sel)) out += m[2];
  }
  return out;
}

// -- colour maths (as validate_palette.js) ------------------------------------
const lin = (h: string) =>
  [1, 3, 5].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
function oklabLin([r, g, b]: number[]): number[] {
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!);
  const m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!);
  const s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const MACHADO: Record<string, number[][]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};
function sim(h: string, kind?: string): number[] {
  const c = lin(h);
  if (!kind) return c;
  return MACHADO[kind]!.map((row) =>
    Math.min(1, Math.max(0, row[0]! * c[0]! + row[1]! * c[1]! + row[2]! * c[2]!)),
  );
}
function dE(a: string, b: string, kind?: string): number {
  const p = oklabLin(sim(a, kind));
  const q = oklabLin(sim(b, kind));
  return 100 * Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!);
}
const cvd = (a: string, b: string) => Math.min(dE(a, b, "protan"), dE(a, b, "deutan"));
const okL = (h: string) => oklabLin(lin(h))[0]!;
/** The OKLCH hue angle between two colours, in degrees (0 to 180). */
function hueGap(a: string, b: string): number {
  const hue = (h: string) => {
    const [, x, y] = oklabLin(lin(h));
    return (Math.atan2(y!, x!) * 180) / Math.PI;
  };
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return d > 180 ? 360 - d : d;
}
function contrast(a: string, b: string): number {
  const y = (h: string) => {
    const [r, g, bl] = lin(h);
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [y(a), y(b)].sort((x, z) => z - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const VIZ = ["--viz-mark", "--viz-accent", "--viz-muted", "--viz-grid", "--viz-track"];
const SURFACES = {
  light: ["--paper", "--paper-2", "--ground"].map((t) => pair(t)[0]),
  dark: ["--paper", "--paper-2", "--ground"].map((t) => pair(t)[1]),
  board: [...pair("--board"), ...pair("--board-2")],
};
const CARDS = {
  light: [pair("--yellow")[0], pair("--red")[0], pair("--ok")[0]],
  dark: [pair("--yellow")[1], pair("--red")[1], pair("--ok")[1]],
  board: [pair("--yellow")[1], token("--board-red"), token("--board-ok")],
};

describe("web: chart marks have their own tokens", () => {
  it("every --viz-* token has a light, a dark and a board step", () => {
    for (const t of VIZ) {
      expect(token(t), t).toMatch(/^light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)$/i);
      expect(token(t.replace("--viz-", "--viz-board-")), t).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("the marks are not the kit and not a referee's card", () => {
    const kit = [...pair("--claret"), ...pair("--claret-ink"), token("--sky")].map((h) =>
      h.toLowerCase(),
    );
    const steps: Array<[keyof typeof CARDS, string]> = [
      ["light", pair("--viz-mark")[0]],
      ["light", pair("--viz-accent")[0]],
      ["dark", pair("--viz-mark")[1]],
      ["dark", pair("--viz-accent")[1]],
      ["board", token("--viz-board-mark")],
      ["board", token("--viz-board-accent")],
    ];
    for (const [mode, hex] of steps) {
      expect(kit, `${hex} is a kit colour`).not.toContain(hex.toLowerCase());
      for (const card of CARDS[mode])
        expect(dE(hex, card), `${mode} ${hex} vs card ${card}`).toBeGreaterThanOrEqual(15);
    }
  });

  it("mark and accent pass the palette checks on every surface they sit on", () => {
    const sets: Array<[keyof typeof SURFACES, string, string, [number, number]]> = [
      ["light", pair("--viz-mark")[0], pair("--viz-accent")[0], [0.43, 0.77]],
      ["dark", pair("--viz-mark")[1], pair("--viz-accent")[1], [0.48, 0.67]],
      ["board", token("--viz-board-mark"), token("--viz-board-accent"), [0.48, 0.67]],
    ];
    for (const [mode, mark, accent, band] of sets) {
      expect(dE(mark, accent), `${mode} normal vision`).toBeGreaterThanOrEqual(15);
      expect(cvd(mark, accent), `${mode} CVD`).toBeGreaterThanOrEqual(8);
      for (const hex of [mark, accent]) {
        expect(okL(hex), `${mode} ${hex} lightness band`).toBeGreaterThanOrEqual(band[0]);
        expect(okL(hex), `${mode} ${hex} lightness band`).toBeLessThanOrEqual(band[1]);
        for (const s of SURFACES[mode])
          expect(contrast(hex, s), `${mode} ${hex} on ${s}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("a meter's fill reads against its own track, in every kit and on the board", () => {
    const fills: Array<[string, string]> = [
      [pair("--viz-mark")[0], pair("--viz-track")[0]],
      [pair("--viz-mark")[1], pair("--viz-track")[1]],
      [token("--viz-board-mark"), token("--viz-board-track")],
    ];
    for (const [fill, track] of fills) expect(contrast(fill, track)).toBeGreaterThanOrEqual(3);
  });

  it("the scoreboard swaps in the board steps", () => {
    const board = decls("components.css", ".scoreboard");
    for (const t of VIZ)
      expect(board).toContain(`${t}: var(${t.replace("--viz-", "--viz-board-")})`);
  });

  it("chart marks point at --viz-* and never at the kit or plain ink", () => {
    const marks: Array<[string, string, RegExp]> = [
      ["components.css", ".kpi-spark", /color:\s*var\(--viz-mark\)/],
      ["components.css", ".band", /background:\s*var\(--viz-track\)/],
      ["components.css", ".band-fill", /background:\s*var\(--viz-mark\)/],
      ["components.css", ".chart-bar", /fill:\s*var\(--viz-mark\)/],
      ["components.css", ".chart-bar.is-today", /fill:\s*var\(--viz-accent\)/],
      ["components.css", ".chart-bar.is-zero", /fill:\s*var\(--viz-muted\)/],
      ["components.css", ".chart .cg", /stroke:\s*var\(--viz-grid\)/],
      // Health's ROI sparklines (categories drawn as time) and bar rows are gone (V1);
      // its diverging lane bar takes the two opposite marks.
      ["views/health.css", ".dv-left i", /background:\s*var\(--viz-accent\)/],
      ["views/health.css", ".dv-right i", /background:\s*var\(--viz-mark\)/],
      ["components.css", ".seg-3", /background:\s*var\(--viz-part-3\)/],
      ["views/overview.css", ".wage-chart .bar", /fill:\s*var\(--viz-mark\)/],
      ["views/overview.css", ".wage-chart .bar-today", /fill:\s*var\(--viz-accent\)/],
      ["views/overview.css", ".kb-1", /background:\s*var\(--viz-accent\)/],
      ["views/overview.css", ".kb-2", /background:\s*var\(--viz-muted\)/],
      // The League table's share bar is the shared meter now (.band-fill above).
      ["views/ticket.css", ".conf-fill", /background:\s*var\(--viz-mark\)/],
      // The Epics round bar is the shared meter now (.band-fill above), not its own build.
    ];
    for (const [file, sel, want] of marks) {
      const d = decls(file, sel);
      expect(d, `${file} ${sel}`).toMatch(want);
      expect(d, `${file} ${sel}`).not.toMatch(/var\(--(sky|claret|claret-ink|kit-\d)\)/);
    }
    // No chart rule anywhere reaches for the kit.
    for (const f of ALL_FILES) {
      const css = strip(read(f));
      for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/(spark|chart|band-fill|df-bar|kb-\d|pct-bar|conf-fill)/.test(m[1]!)) continue;
        expect(m[2], `${f} ${m[1]!.trim()}`).not.toMatch(/var\(--(sky|claret|claret-ink)\)/);
      }
    }
  });
});

describe("web: dark mode is chosen, not flipped", () => {
  it("the house claret as text reads at 4.5:1 on paper, paper-2 and the sky wash in each kit", () => {
    // The club's own kit is guarded in kit.js (web-kit-colours); this holds the house values.
    const ink = pair("--claret-ink");
    for (const i of [0, 1])
      for (const ground of ["--paper", "--paper-2", "--sky-wash"])
        expect(
          contrast(ink[i]!, pair(ground)[i]!),
          `${ground} ${i ? "dark" : "light"}`,
        ).toBeGreaterThanOrEqual(4.5);
  });
  it("a sky block has a deep floodlit ground with its own text", () => {
    const [light, dark] = pair("--sky-block");
    expect(light.toLowerCase()).toBe(token("--sky").toLowerCase());
    expect(okL(dark)).toBeLessThan(0.5);
    expect(contrast(pair("--on-sky-block")[1], dark)).toBeGreaterThanOrEqual(7);
    expect(contrast(pair("--on-sky-block-2")[1], dark)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(pair("--on-sky-block-2")[0], light)).toBeGreaterThanOrEqual(4.5);
    expect(decls("components.css", ".block-sky")).toMatch(/background:\s*var\(--sky-block\)/);
  });

  it("card frames are a mid grey under floodlights, not a near-white line", () => {
    expect(token("--frame")).toBe("2px solid var(--frame-ink)");
    expect(token("--frame-ink")).toMatch(/^light-dark\(var\(--ink\), #[0-9a-f]{6}\)$/i);
    const dark = /#[0-9a-f]{6}/i.exec(token("--frame-ink"))![0];
    expect(okL(dark)).toBeLessThan(0.65);
    for (const s of [pair("--ground")[1], pair("--paper")[1]])
      expect(contrast(dark, s), `frame on ${s}`).toBeGreaterThanOrEqual(3);
  });

  it("the board keeps a lit outline on the floodlit page", () => {
    expect(token("--board-frame")).toMatch(/^light-dark\(var\(--board\), #[0-9a-f]{6}\)$/i);
    const dark = /#[0-9a-f]{6}/i.exec(token("--board-frame"))![0];
    expect(contrast(dark, pair("--ground")[1])).toBeGreaterThanOrEqual(3);
    expect(decls("views/work.css", ".board")).toMatch(/border:\s*2px solid var\(--board-frame\)/);
  });
});

describe("web: status yellow is only status", () => {
  it("unsaved markers are an ink outline badge, never the yellow card", () => {
    for (const sel of [
      ".unsaved-tag",
      ".grp-dirty",
      ".setting-unsaved",
      ".boot-dirty.is-dirty strong",
    ]) {
      const d = decls("views/settings.css", sel);
      expect(d, sel).toMatch(/border:\s*1\.5px solid var\(--ink\)/);
      expect(d, sel).not.toMatch(/--yellow/);
    }
    expect(strip(read("views/settings.css"))).not.toMatch(/\.boot-n\.is-dirty/);
  });

  it("the no-go row and the review strip's warn cell do not wear yellow", () => {
    expect(decls("views/settings.css", ".gng-list .is-nogo .vmark")).not.toMatch(/--yellow/);
    expect(decls("views/review.css", ".vd-cell.vd-warn")).not.toMatch(/--yellow/);
  });
});

describe("web: the factory floor's stations", () => {
  const ORDER = ["draft", "ready", "build", "inspect", "test", "inspect", "done"]; // loading bay = inspect hue
  for (const [mode, i, band] of [
    ["light", 0, [0.43, 0.77]],
    ["dark", 1, [0.48, 0.67]],
  ] as const) {
    it(`pass the palette checks in drawing order (${mode})`, () => {
      const hues = ORDER.map((s) => pair(`--fl-${s}`)[i]);
      for (const h of hues) {
        expect(okL(h), `${h} lightness band`).toBeGreaterThanOrEqual(band[0]);
        expect(okL(h), `${h} lightness band`).toBeLessThanOrEqual(band[1]);
      }
      for (let k = 1; k < hues.length; k++) {
        const [a, b] = [hues[k - 1]!, hues[k]!];
        expect(dE(a, b), `${ORDER[k - 1]} / ${ORDER[k]} normal vision`).toBeGreaterThanOrEqual(15);
        expect(cvd(a, b), `${ORDER[k - 1]} / ${ORDER[k]} CVD`).toBeGreaterThanOrEqual(8);
      }
      // Inspection is clearly apart from the status red of its kit.
      expect(dE(pair("--fl-inspect")[i], pair("--red")[i])).toBeGreaterThanOrEqual(22);
      // Assembly (and the robots' hard hats, which wear it) stays orange: its hue is
      // at least 20 degrees from the red card's, so a hat beside the jam bay never
      // reads as blocked. (A rust step at 11 degrees off the floodlit red did.)
      expect(hueGap(pair("--fl-build")[i], pair("--red")[i])).toBeGreaterThanOrEqual(20);
    });
  }
});

describe("web: stray values", () => {
  it("no hex colour outside tokens.css (print stays on white paper)", () => {
    for (const f of ALL_FILES) {
      let css = strip(read(f));
      if (f === "utilities.css") css = css.replace(/@media print\s*\{[\s\S]*$/, "");
      expect(css.match(/#[0-9a-f]{3,8}\b/gi), f).toBeNull();
    }
  });

  it("the off-scale sizes snap to the type scale (15px is the one named step)", () => {
    expect(token("--t15")).toBe("15px");
    for (const f of ALL_FILES) {
      const css = strip(read(f));
      expect(css, f).not.toMatch(/\b(15|17|18|12\.5)px\s+(\/[^;]*)?var\(--f-/);
      expect(css, f).not.toMatch(/0\.62em/);
    }
    // The pitch's counters and tallies (Audit A, A-08).
    expect(strip(read("views/overview.css"))).not.toMatch(/\b22px\s+var\(--f-/);
  });
});
