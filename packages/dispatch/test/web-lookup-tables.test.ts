// @vitest-environment jsdom
//
// Lookup tables in the dashboard are read with keys the page does not control (a status,
// a reason code, a view name from the address bar). A plain object literal answers
// "constructor", "toString" or "__proto__" through its prototype, so a label lookup with
// a `||` fallback rendered a function and the Team sheet threw on a ticket whose reason
// code was "constructor". Every such map is a table() (js/lookup.js): no prototype.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

const WEB = path.resolve(process.cwd(), "src/api/web/js");
const load = (f: string) =>
  import(`${pathToFileURL(path.join(WEB, f)).href}?t=${Date.now()}-${Math.random()}`);

const HOSTILE = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
  "isPrototypeOf",
];

let S: any;
let L: any;
beforeAll(async () => {
  S = await load("status.js");
  L = await load("lookup.js");
});

describe("table(): a map with no prototype", () => {
  it("an inherited name reads undefined; given entries and later additions read back", () => {
    const t = L.table({ a: 1 });
    for (const k of HOSTILE) expect(t[k]).toBeUndefined();
    expect(t.a).toBe(1);
    t.b = 2;
    expect(Object.keys(t)).toEqual(["a", "b"]);
    expect(Object.getPrototypeOf(t)).toBeNull();
  });
});

describe("status vocabulary with a key named like an Object method", () => {
  it("a reason code renders as words, never a function, and never throws", () => {
    for (const code of HOSTILE) {
      const words = S.reasonText(code);
      expect(typeof words).toBe("string");
      const tag = S.reasonTag(code);
      expect(tag.textContent).toBe(words);
      expect(tag.getAttribute("title")).toBe(`Server reason code: ${code}`);
    }
    expect(S.reasonText("constructor")).toBe("Constructor");
    expect(S.reasonText("constructor:detail")).toBe("Constructor");
  });

  it("a status, a verdict and an action lookup fall back the same way", () => {
    for (const k of HOSTILE) {
      expect(S.statusLabel(k)).toBe(k);
      expect(S.ticketActionKeys(k)).toEqual([]);
      expect(() => S.verdictMark(k)).not.toThrow();
      expect(() => S.statusBadge(k)).not.toThrow();
      expect(() => S.pipelineDots(k)).not.toThrow();
    }
  });
});

describe("no dashboard module reads a plain object with a computed key", () => {
  it("every ALL_CAPS map read as NAME[key] is a table() or an array", () => {
    const files: string[] = [];
    (function walk(d: string): void {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js")) files.push(p);
      }
    })(WEB);
    const all = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    const read = /\b([A-Z][A-Z0-9_]{2,})\[(?!["'`0-9])[^\]]+\]/g;
    const names = new Set<string>();
    for (const m of all.matchAll(read)) names.add(m[1]!);
    expect(names.size).toBeGreaterThan(30);
    const plain: string[] = [];
    for (const name of names) {
      const def = new RegExp(`^(?:export )?(?:const|let|var) ${name} = (.{0,6})`, "m").exec(all);
      if (!def) continue; // not a module-level binding (a word in a regex, a parameter)
      const start = def[1]!;
      if (!start.startsWith("table(") && !start.startsWith("[")) plain.push(name);
    }
    expect(plain).toEqual([]);
  });
});
