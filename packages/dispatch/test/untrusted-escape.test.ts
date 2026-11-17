/**
 * F3: the untrusted-text escaper (src/util/untrusted.ts) against the shared vector file
 * every implementation runs (runner/test/fixtures/quarantine-vectors.json), and the
 * MCP get_ticket door it guards. The old delimiter regex missed a soft hyphen, an
 * invisible character inside "untrusted" and a Cyrillic look-alike; now every `<` of
 * the data is escaped.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";
import { QUARANTINE_ESCAPE_NOTE, escapeUntrusted, quarantine } from "../src/util/untrusted.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const { vectors } = JSON.parse(
  readFileSync(resolve(HERE, "../../../runner/test/fixtures/quarantine-vectors.json"), "utf8"),
) as { vectors: { name: string; input: string; escaped: string }[] };

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe("untrusted escaper (shared vectors)", () => {
  it.each(vectors)("maps $name exactly and idempotently", (v) => {
    expect(escapeUntrusted(v.input)).toBe(v.escaped);
    expect(escapeUntrusted(v.escaped)).toBe(v.escaped);
    const w = quarantine("ticket-title", v.input);
    expect(
      w.slice("<untrusted-ticket-title>".length, -"</untrusted-ticket-title>".length),
    ).not.toContain("<");
    expect(count(w, "</untrusted-ticket-title>")).toBe(1);
  });

  it("null and undefined escape to the empty string; double wrapping escapes the inner tags", () => {
    expect(escapeUntrusted(null)).toBe("");
    expect(escapeUntrusted(undefined)).toBe("");
    expect(quarantine("outer", quarantine("inner", "a<b"))).toBe(
      "<untrusted-outer>&lt;untrusted-inner>a&lt;b&lt;/untrusted-inner></untrusted-outer>",
    );
    expect(QUARANTINE_ESCAPE_NOTE).toBe("&lt; inside these tags is a literal <.");
  });

  it("get_ticket leaves no raw < inside the title envelope for the bypass spellings", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const actor: Actor = { type: "agent", id: "mcp-agent" };
    const h = makeHandlers(wg, actor);
    for (const v of vectors.filter((x) => x.input.includes("SYSTEM"))) {
      const created = h.create_ticket({ title: v.input || "t" }).structuredContent;
      const got = h.get_ticket({ ticket_id: created.ticket_id as string }).structuredContent;
      const ticket = got.ticket as { title: string };
      expect(ticket.title).toBe(`<untrusted-ticket-title>${v.escaped}</untrusted-ticket-title>`);
      expect(String(got.quarantine_notice)).toContain(QUARANTINE_ESCAPE_NOTE);
    }
  });
});
