// The shared parts' CSS where layout, not the DOM, is the contract (review of the
// dashboard visual pass, package P2). jsdom cannot lay a page out, so these read the
// stylesheets: each rule with the at-rules it sits in.

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const CSS = path.resolve(process.cwd(), "src/api/web/css");

type Rule = { at: string[]; selectors: string[]; decls: Record<string, string> };

/** Every innermost `selector { declarations }` rule, with the at-rule preludes around it. */
function rules(file: string): Rule[] {
  const css = readFileSync(path.join(CSS, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const stack: string[] = [];
  let buf = "";
  for (const ch of css) {
    if (ch === "{") {
      stack.push(buf.trim());
      buf = "";
    } else if (ch === "}") {
      const prelude = stack.pop() ?? "";
      if (!prelude.startsWith("@") && buf.includes(":")) {
        const decls: Record<string, string> = {};
        for (const d of buf.split(";")) {
          const i = d.indexOf(":");
          if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
        }
        out.push({
          at: stack.filter((s) => s.startsWith("@")),
          selectors: prelude.split(",").map((s) => s.replace(/\s+/g, " ").trim()),
          decls,
        });
      }
      buf = "";
    } else buf += ch;
  }
  return out;
}

const PHONE = "@media (max-width: 760px)";

describe("dataTable on a phone (stackOnPhone)", () => {
  it("the caption stays a full-width line, not a table-caption squeezed to one word", () => {
    const hit = rules("components.css").find(
      (r) =>
        r.at.includes(PHONE) &&
        r.selectors.includes(".dt-stack .data-table caption") &&
        r.decls.display === "block",
    );
    expect(hit, "a phone rule gives the stacked table's caption display: block").toBeTruthy();
  });
});

describe("statCell sizes keep proportional figures", () => {
  it("each sized figure restates proportional-nums after its important font shorthand", () => {
    // `font: ... !important` resets font-variant-numeric to normal with importance, which
    // outranks the plain proportional-nums on .kpi-val (seen as "normal" in a browser).
    const all = rules("components.css");
    for (const size of ["hero", "row", "inline"]) {
      const sel = `.kpi--${size} .kpi-val`;
      const fvn = all.filter(
        (r) => r.selectors.includes(sel) && r.decls["font-variant-numeric"] !== undefined,
      );
      expect(
        fvn.some((r) => /proportional-nums\s*!important/.test(r.decls["font-variant-numeric"]!)),
        `${sel} sets font-variant-numeric: proportional-nums !important`,
      ).toBe(true);
    }
  });
});

describe("Work board card", () => {
  it("a needs card's status word clears the yellow card pinned at its top right", () => {
    // The 14px ticketRef made the top row short, so "Paused" rose under the yellow card;
    // the tags already kept 14px clear of it, the status beside the number did not.
    const hit = rules("views/work.css").find(
      (r) =>
        r.selectors.includes(".board-card.needs .card-top > .badge.st") &&
        parseFloat(r.decls["margin-right"] || "0") >= 14,
    );
    expect(hit, "a rule keeps a needs card's status 14px clear of the yellow card").toBeTruthy();
  });
});

describe("the reason sheet's ticket", () => {
  it("sits on --paper, the ground the kit's claret-ink is made readable on", () => {
    // kit.js steps --claret-ink to 4.5:1 against --paper; the 14px ticketRef on the
    // --paper-2 wash read 4.48:1 in dark mode with the demo club's kit (axe, serious).
    const hit = rules("components.css").filter((r) => r.selectors.includes(".rs-ticket"));
    expect(hit.map((r) => r.decls.background).filter(Boolean)).toEqual(["var(--paper)"]);
  });
});
