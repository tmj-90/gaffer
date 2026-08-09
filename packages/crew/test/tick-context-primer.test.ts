import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatFileCardsBlock,
  formatProductContextBlock,
  primeFileCards,
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
