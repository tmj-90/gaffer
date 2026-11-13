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
