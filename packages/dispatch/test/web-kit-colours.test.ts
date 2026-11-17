// @vitest-environment jsdom
//
// The club kit never reads as a referee's card (src/api/web/js/kit.js).
// Referee yellow means "needs you", red means blocked or failed, the green means a
// passed check. A club colour closer than OKLab 15 (x100, the dataviz palette
// validator's measure) to any of them, in either kit, would turn identity into
// status wherever it paints a block, a hoop or a chart. kitTokens keeps such a
// colour on the identity tokens (--kit-1, --kit-2: shirts and the crest) and
// leaves the role tokens (claret and sky: header, blocks, hoops, washes) on the
// house values; the club editor says so in one line.

import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const KIT_JS = path.join(path.resolve(process.cwd(), "src/api/web"), "js", "kit.js");

type Tokens = Record<string, string | null>;
type Clash = { card: string; words: string; distance: number } | null;
type Kit = {
  applyClub: (club: Record<string, unknown>) => void;
  KIT_CLASH: number;
  okDistance: (a: number[], b: number[]) => number;
  cardClash: (hex: string | null) => Clash;
  kitClashes: (p: string | null, s: string | null) => Array<{ which: string; card: string }>;
  kitClashNote: (p: string | null, s: string | null) => string;
  kitTokens: (p: string | null, s: string | null) => Tokens;
  crestInk: (bg: number[]) => string;
};
let kit: Kit;

const HOUSE_CLARET = "#7a1631";
const HOUSE_SKY = "#95cdeb";
const DOCS_GOLD = "#f2c14e"; // the docs club's second colour: 4.6 from the yellow card
const RED_KIT = "#d00027";
const GREEN_KIT = "#00843d";
const SAFE_BLUE = "#1d4ed8";

const ROLE_CLARET = ["--claret", "--claret-ink", "--on-claret", "--on-claret-2"];
const ROLE_SKY = [
  "--sky",
  "--on-sky",
  "--on-sky-2",
  "--sky-wash",
  "--sky-on-board",
  "--sky-block",
  "--on-sky-block",
  "--on-sky-block-2",
];

beforeAll(async () => {
  kit = (await import(`${pathToFileURL(KIT_JS).href}?t=${Date.now()}`)) as Kit;
});

describe("web: club colours and the referee's cards", () => {
  it("measures OKLab distance as the palette validator does", () => {
    expect(kit.KIT_CLASH).toBe(15);
    // #f2c14e vs --yellow #ffcc1f: 4.6 (Audit A, A-01).
    expect(kit.okDistance([242, 193, 78], [255, 204, 31])).toBeCloseTo(4.6, 1);
    expect(kit.okDistance([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it("the docs club's gold is the yellow card: blocks and hoops keep the house sky, shirts keep the gold", () => {
    const c = kit.cardClash(DOCS_GOLD);
    expect(c?.card).toBe("yellow");
    expect(c?.distance).toBeLessThan(15);
    const t = kit.kitTokens(HOUSE_CLARET, DOCS_GOLD);
    for (const k of ROLE_SKY) expect(t[k], k).toBeNull();
    expect(t["--kit-2"]).toBe(DOCS_GOLD);
    // The shirt's stencil number is still cut in the club's own second colour.
    expect(t["--shirt-no"]).toBe("var(--kit-2)");
    // The first colour is fine and still dresses the header.
    expect(t["--claret"]).toBe(HOUSE_CLARET);
    expect(kit.kitClashNote(HOUSE_CLARET, DOCS_GOLD)).toBe(
      "Your second colour is close to the referee's yellow card (needs you), so blocks and hoops use the house sky; shirts and the crest keep it.",
    );
  });

  it("a red kit is the red card: the header and blocks keep the house claret, the crest keeps the red", () => {
    expect(kit.cardClash(RED_KIT)?.card).toBe("red");
    const t = kit.kitTokens(RED_KIT, "#ffffff");
    for (const k of ROLE_CLARET) expect(t[k], k).toBeNull();
    expect(t["--kit-1"]).toBe(RED_KIT);
    expect(t["--on-kit-1"]).toBe("#ffffff");
    expect(t["--shirt-edge"]).toMatch(/^rgb\(/);
    // White is not a card colour: it still dresses the sky role.
    expect(t["--sky"]).toBe("#ffffff");
    expect(kit.kitClashNote(RED_KIT, "#ffffff")).toMatch(
      /^Your first colour is close to the referee's red card \(blocked or failed\), so the header and blocks use the house claret/,
    );
  });

  it("a green kit is the passed-check green, as either colour", () => {
    expect(kit.cardClash(GREEN_KIT)?.card).toBe("ok");
    const asFirst = kit.kitTokens(GREEN_KIT, null);
    expect(asFirst["--claret"]).toBeNull();
    expect(asFirst["--kit-1"]).toBe(GREEN_KIT);
    const asSecond = kit.kitTokens(null, GREEN_KIT);
    expect(asSecond["--sky"]).toBeNull();
    expect(asSecond["--sky-block"]).toBeNull();
    expect(asSecond["--kit-2"]).toBe(GREEN_KIT);
    expect(kit.kitClashes(GREEN_KIT, GREEN_KIT).map((c) => c.which)).toEqual([
      "primary",
      "secondary",
    ]);
    expect(kit.kitClashNote(GREEN_KIT, DOCS_GOLD)).toMatch(
      /^Both colours are close to the green of a passed check and the referee's yellow card/,
    );
  });

  it("a safe blue is worn everywhere, and its sky block is chosen for each kit", () => {
    expect(kit.cardClash(SAFE_BLUE)).toBeNull();
    expect(kit.kitClashNote(SAFE_BLUE, HOUSE_SKY)).toBe("");
    const t = kit.kitTokens(SAFE_BLUE, "#ffffff");
    expect(t["--claret"]).toBe(SAFE_BLUE);
    expect(t["--kit-1"]).toBe(SAFE_BLUE);
    expect(t["--kit-2"]).toBe("#ffffff");
    // The floodlit block is a deep step of the club colour, not the light one flipped.
    expect(t["--sky-block"]).toMatch(/^light-dark\(#ffffff, rgb\(\d+ \d+ \d+\)\)$/);
    expect(t["--on-sky-block"]).toMatch(/^light-dark\(rgb\(14 23 38\), rgb\(255 255 255\)\)$/);
  });

  it("the house kit itself is not flagged, and no kit means house values", () => {
    expect(kit.cardClash(HOUSE_CLARET)).toBeNull();
    expect(kit.cardClash(HOUSE_SKY)).toBeNull();
    const t = kit.kitTokens(null, null);
    expect(Object.values(t).every((v) => v === null)).toBe(true);
    expect(Object.keys(t)).toEqual(expect.arrayContaining(["--kit-1", "--kit-2", "--sky-block"]));
  });

  it("a sky block's text reads at 4.5:1 on both kits, whatever the club's second colour", () => {
    // The floodlit block mixes the club colour down toward the dark page; a white
    // second colour (a common kit) landed on a mid grey where white text read 4.48:1.
    const rgb = (v: string) =>
      v.startsWith("#")
        ? [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16))
        : (/rgb\((\d+) (\d+) (\d+)\)/.exec(v) ?? []).slice(1).map(Number);
    const sides = (v: string | null | undefined) => {
      const m = /^light-dark\((.+), (rgb\(.+\)|#[0-9a-f]{6})\)$/i.exec(v ?? "");
      if (!m) throw new Error(`not a light-dark pair: ${v}`);
      return [rgb(m[1]!), rgb(m[2]!)];
    };
    const lum = (c: number[]) => {
      const f = (x: number) => {
        const v = x / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const worst: Array<[string, number]> = [];
    const hexes = ["#ffffff", "#f8f8f8", "#7a7a7a", "#808080", "#8a5cf5", "#2a9d8f", "#e0e0e0"];
    for (let r = 0; r < 256; r += 51)
      for (let g = 0; g < 256; g += 51)
        for (let b = 0; b < 256; b += 51)
          hexes.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
    for (const hex of hexes) {
      if (kit.cardClash(hex)) continue;
      const t = kit.kitTokens(SAFE_BLUE, hex);
      const ground = sides(t["--sky-block"]);
      const ink = sides(t["--on-sky-block"]);
      const ink2 = sides(t["--on-sky-block-2"]);
      for (const i of [0, 1]) {
        const a = ratio(ink[i]!, ground[i]!);
        const b = ratio(ink2[i]!, ground[i]!);
        if (a < 4.5 || b < 4.5) worst.push([`${hex} ${i ? "dark" : "light"}`, Math.min(a, b)]);
      }
    }
    expect(worst).toEqual([]);
    // A safe colour that already reads keeps its own hex on the day kit.
    expect(kit.kitTokens(SAFE_BLUE, "#ffffff")["--sky-block"]).toMatch(/^light-dark\(#ffffff, /);
  });

  it("the browser's bar follows the header: a first colour that gives way there gives way here", () => {
    document.head.innerHTML = '<meta name="theme-color" content="#7a1631" />';
    const meta = document.querySelector('meta[name="theme-color"]')!;
    kit.applyClub({ kit_primary: SAFE_BLUE, kit_secondary: null });
    expect(meta.getAttribute("content")).toBe(SAFE_BLUE);
    kit.applyClub({ kit_primary: RED_KIT, kit_secondary: "#ffffff" });
    expect(meta.getAttribute("content")).toBe(HOUSE_CLARET);
    kit.applyClub({ kit_primary: null, kit_secondary: null });
    expect(meta.getAttribute("content")).toBe(HOUSE_CLARET);
  });

  it("claret as text reads at 4.5:1 on paper, paper-2 and the sky wash, in both kits, for any first colour", () => {
    // Ticket numbers and ranks wear --claret-ink on zebra rows (--paper-2) and on the
    // selected row's --sky-wash, not only on --paper: a navy kit's floodlit step read
    // 4.97 on paper but 4.48 on paper-2 (axe serious at 14px).
    const rgb = (v: string) => (/rgb\((\d+) (\d+) (\d+)\)/.exec(v) ?? []).slice(1).map(Number);
    const sides = (v: string | null | undefined) => {
      const m = /^light-dark\((rgb\([^)]+\)), (rgb\([^)]+\))\)$/.exec(v ?? "");
      if (!m) throw new Error(`not a light-dark pair: ${v}`);
      return [rgb(m[1]!), rgb(m[2]!)];
    };
    const lum = (c: number[]) => {
      const f = (x: number) => {
        const v = x / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const ratio = (a: number[], b: number[]) => {
      const [x, y] = [lum(a), lum(b)];
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    };
    const mix = (a: number[], b: number[], t: number) =>
      a.map((v, i) => Math.round(v + (b[i]! - v) * t));
    const hx = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const PAPER = [hx("#ffffff"), hx("#1f2430")];
    const PAPER_2 = [hx("#f6f8f3"), hx("#262c39")];
    const firsts = ["#1f4e79", "#1d4ed8", "#7a1631", "#000000", "#2a9d8f", "#8a5cf5", "#be185d"];
    for (let r = 0; r < 256; r += 51)
      for (let g = 0; g < 256; g += 51)
        for (let b = 0; b < 256; b += 51)
          firsts.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
    const short: string[] = [];
    for (const second of [null, "#ffffff", "#95cdeb", "#0ea5e9", "#1d4ed8"]) {
      const S = second ? hx(second) : null;
      const wash = [
        S ? mix(hx("#ffffff"), S, 0.2) : hx("#ddeff9"),
        S ? mix(hx("#1f2430"), S, 0.1) : hx("#1e3442"),
      ];
      for (const first of firsts) {
        if (kit.cardClash(first)) continue;
        const ink = sides(kit.kitTokens(first, second)["--claret-ink"]);
        for (const i of [0, 1])
          for (const [name, ground] of [
            ["paper", PAPER[i]!],
            ["paper-2", PAPER_2[i]!],
            ["sky wash", wash[i]!],
          ] as const) {
            const c = ratio(ink[i]!, ground);
            if (c < 4.5)
              short.push(`${first}/${second} ${i ? "dark" : "light"} ${name} ${c.toFixed(2)}`);
          }
      }
    }
    expect(short).toEqual([]);
  });

  it("a second colour is text on the scoreboard only where it reads on every board ground", () => {
    // #3b82f6 reads 4.6:1 on --board but 4.4:1 on --board-2: the board's quiet ink instead.
    expect(kit.kitTokens(SAFE_BLUE, "#3b82f6")["--sky-on-board"]).toBe("var(--board-ink-2)");
    expect(kit.kitTokens(SAFE_BLUE, "#95cdeb")["--sky-on-board"]).toBe("var(--sky)");
  });
});

describe("web: kit text colours (P1 review follow-ups)", () => {
  const hx = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (c: number[]) => {
    const f = (x: number) => {
      const v = x / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
  };
  const ratio = (a: number[], b: number[]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  const parse = (v: string) => {
    if (v === "#ffffff") return [255, 255, 255];
    if (v === "var(--counter-ink)") return [14, 23, 38];
    const m = /^rgb\((\d+) (\d+) (\d+)\)$/.exec(v);
    if (!m) throw new Error(`not a colour: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };

  it("crest letters read at 4.5:1 on mid-tone first colours (white gave 4.26 to 4.30)", () => {
    for (const first of [
      "#7a7a7a",
      "#8a5cf5",
      "#6666ff",
      "#d9480f",
      "#2f7fbf",
      "#1d4ed8",
      "#f4f4f4",
    ]) {
      const on = kit.kitTokens(first, null)["--on-kit-1"]!;
      expect(ratio(parse(on), hx(first)), `${first}: ${on}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("a stepped claret ink near a status colour falls back to the house ink (#009900)", () => {
    const t = kit.kitTokens("#009900", null);
    expect(kit.cardClash("#009900")).toBeNull();
    const m = /^light-dark\((rgb\([^)]+\)), (rgb\([^)]+\))\)$/.exec(t["--claret-ink"] ?? "")!;
    expect(m).not.toBeNull();
    const day = parse(m[1]!);
    const night = parse(m[2]!);
    // Each side is the house ink (the house's own pair, never flagged) or clear of every card.
    const house = [
      [122, 22, 49],
      [232, 180, 196],
    ];
    for (const c of [day, night].filter((x) => !house.some((h) => h.join() === x.join())))
      for (const card of [
        [31, 107, 58],
        [127, 212, 154],
        [200, 16, 46],
        [255, 123, 123],
        [255, 204, 31],
      ])
        expect(kit.okDistance(c, card)).toBeGreaterThanOrEqual(15);
    expect(day).toEqual([122, 22, 49]);
  });
});
