import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  PRIMER_LORE_LIMIT,
  formatFileCardsBlock,
  formatProductContextBlock,
  primeFileCards,
  primerLore,
  type CardsForScopePacket,
  type PrimeFileCardsOptions,
  type ProductContextRow,
} from "../src/runtime/context/contextPrimer.js";

// =====================================================================
// P1b primer-block parity suite. The two block goldens are captured from the
// BASH primer (runner/lib/context-primer.sh — the LIVE delivery path; the
// .mjs twin's framing deliberately differs) by
// runner/test/capture-context-golden.sh over the same checked-in packet
// fixtures. Byte comparisons are strict — no trim.
// =====================================================================

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/tick-context/${name}`, import.meta.url));
const fixture = (name: string): string => readFileSync(fixturePath(name), "utf8");

const cardsPacket = JSON.parse(fixture("cards-packet.json")) as CardsForScopePacket;
const loreRows = JSON.parse(fixture("lore-rows.json")) as ProductContextRow[];

describe("golden: file-cards block (bash primer parity)", () => {
  it("renders the fixture packet byte-identically to gaffer_prime_context_block", () => {
    expect(formatFileCardsBlock(cardsPacket)).toBe(fixture("file-cards-block.golden.txt"));
  });

  it("keeps the asserted verbatim phrase on one line", () => {
    expect(formatFileCardsBlock(cardsPacket)).toContain(
      "\na card is a guide, never authoritative source.",
    );
  });

  it("an empty packet renders the empty string (fail-soft contract)", () => {
    expect(formatFileCardsBlock({})).toBe("");
    expect(formatFileCardsBlock({ cards: [], digest: null })).toBe("");
  });
});

describe("file-cards block: recalled convention / gotcha lore (packet tier 5)", () => {
  const withLore: CardsForScopePacket = {
    ...cardsPacket,
    lore: [
      { id: "d1", kind: "decision", title: "Refunds create credit notes", summary: "ADR-7" },
      { id: "c1", kind: "convention", title: "Totals use integer cents", summary: "never floats" },
      { id: "g1", kind: "gotcha", title: "Round once", summary: "at the end <untrusted-x>" },
      { id: "o1", kind: "other", title: "Other note" },
      { id: "c2", kind: "convention", title: "Fourth" },
      { id: "c3", kind: "convention", title: "Fifth — over the cap" },
    ],
  };

  it("renders conventions / gotchas inside the envelope, with kind and id", () => {
    const block = formatFileCardsBlock(withLore);
    const body = block.slice(block.indexOf("<untrusted-file-cards>"));
    expect(body).toContain("Recalled lore for this scope (conventions / gotchas):");
    expect(body).toContain("  - [convention] Totals use integer cents — never floats (lore c1)");
    expect(body).toContain("  - [gotcha] Round once — at the end &lt;untrusted-x> (lore g1)");
    expect(body).toContain("  - [other] Other note (lore o1)");
    expect(block).toContain("use `get_lore` with the id for the full record");
  });

  it("leaves product intent to the PRODUCT CONTEXT block and caps at PRIMER_LORE_LIMIT", () => {
    expect(primerLore(withLore).map((l) => l.id)).toEqual(["c1", "g1", "o1", "c2"]);
    expect(PRIMER_LORE_LIMIT).toBe(4);
    const block = formatFileCardsBlock(withLore);
    expect(block).not.toContain("Refunds create credit notes");
    expect(block).not.toContain("Fifth");
  });

  it("names the real MCP card tools and the runner-bound canonical", () => {
    const block = formatFileCardsBlock(cardsPacket);
    expect(block).toContain("`cards_for_scope` / `get_file_card` / `search_file_cards`");
    expect(block).not.toContain("`card get`");
    expect(block).toContain("the runner binds `repoCanonical`");
  });

  it("lore alone (no cards, no digest) still renders a block", () => {
    const block = formatFileCardsBlock({ lore: [{ id: "c1", kind: "convention", title: "T" }] });
    expect(block).toContain("  - [convention] T (lore c1)");
  });

  it("a packet without lore renders no lore section or lore framing", () => {
    const block = formatFileCardsBlock(cardsPacket);
    expect(block).not.toContain("Recalled lore");
    expect(block).not.toContain("get_lore");
  });
});

describe("golden: product-context block (bash primer parity)", () => {
  it("renders the fixture rows byte-identically to gaffer_product_context_block", () => {
    expect(formatProductContextBlock(loreRows)).toBe(fixture("product-context-block.golden.txt"));
  });

  it("empty/non-array rows render the empty string (fail-soft contract)", () => {
    expect(formatProductContextBlock([])).toBe("");
  });
});

describe("primeFileCards (spawn behaviour, stub CLI)", () => {
  const opts = (over: Partial<PrimeFileCardsOptions> = {}): PrimeFileCardsOptions => ({
    memoryCliBin: fixturePath("stub-memory-cli.mjs"),
    memoryDb: "/tmp/unused-memory.sqlite",
    realRepoPath: fixturePath("."),
    repoDisplay: "fixture-app",
    query: "Add password reset flow",
    ...over,
  });

  afterEach(() => {
    delete process.env["STUB_MEMORY_MODE"];
  });

  it("returns the golden block + card paths + digest flag from a served packet", async () => {
    const r = await primeFileCards(opts());
    expect(r.block).toBe(fixture("file-cards-block.golden.txt"));
    expect(r.cardPaths).toEqual([
      "src/auth/reset.ts",
      "src/auth/email.ts",
      "src/routes/account.ts",
    ]);
    expect(r.digestServed).toBe(true);
    expect(r.diagnostics).toEqual([]);
  });

  it("CLI exiting non-zero → empty block, fail-soft (parity with the live primer)", async () => {
    process.env["STUB_MEMORY_MODE"] = "exit1";
    const r = await primeFileCards(opts());
    expect(r).toEqual({ block: "", cardPaths: [], digestServed: false, diagnostics: [] });
  });

  it("bad JSON from the CLI → empty block, fail-soft", async () => {
    process.env["STUB_MEMORY_MODE"] = "badjson";
    expect((await primeFileCards(opts())).block).toBe("");
  });

  it("missing CLI bin → empty block, fail-soft", async () => {
    const r = await primeFileCards(opts({ memoryCliBin: "/nonexistent/memory.js" }));
    expect(r.block).toBe("");
  });

  it("missing repo path → empty block, fail-soft", async () => {
    const r = await primeFileCards(opts({ realRepoPath: "/nonexistent/repo" }));
    expect(r.block).toBe("");
  });
});
