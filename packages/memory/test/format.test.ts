/**
 * CLI renderers. Colour is disabled via env so assertions can match
 * plain text. Pins the trust-signal surface a human reads off
 * `memory search` / `memory show`: status, confidence, stale,
 * restricted, conflict flags, body presence.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderFull, renderSummary } from "../src/cli/format.js";
import type { Lore, LoreSummary } from "../src/db/types.js";

const prevNoColor = process.env["NO_COLOR"];
beforeEach(() => {
  process.env["NO_COLOR"] = "1"; // deterministic, ANSI-free output
});
afterEach(() => {
  if (prevNoColor === undefined) delete process.env["NO_COLOR"];
  else process.env["NO_COLOR"] = prevNoColor;
});

function summary(over: Partial<LoreSummary> = {}): LoreSummary {
  return {
    id: "abcd2345",
    title: "Argon2id default",
    summary: "Platform ruling",
    status: "active",
    confidence: "high",
    restricted: false,
    repos: ["payments-svc"],
    tags: ["security"],
    updatedAt: "2026-02-10T09:31:00.000Z",
    stale: false,
    ...over,
  };
}

function full(over: Partial<Lore> = {}): Lore {
  return {
    id: "abcd2345",
    title: "Argon2id default",
    summary: "Platform ruling",
    body: "Use m=64MB t=3 p=4",
    status: "active",
    confidence: "high",
    restricted: false,
    repos: ["payments-svc"],
    tags: ["security"],
    createdAt: "2026-02-10T09:31:00.000Z",
    updatedAt: "2026-02-10T09:31:00.000Z",
    ...over,
  };
}

describe("renderSummary", () => {
  it("shows title, id, summary, status, confidence — but not the body", () => {
    const s = renderSummary(summary());
    expect(s).toContain("Argon2id default");
    expect(s).toContain("(abcd2345)");
    expect(s).toContain("Platform ruling");
    expect(s).toContain("[active]");
    expect(s).toContain("conf=high");
  });

  it("flags stale and restricted records", () => {
    const s = renderSummary(summary({ stale: true, restricted: true }));
    expect(s).toContain("stale");
    expect(s).toContain("restricted");
  });

  it("renders possibleConflicts and conflictsWith hints when present", () => {
    const s = renderSummary(
      summary({ possibleConflicts: ["zzzz1111"], conflictsWith: ["yyyy2222"] }),
    );
    expect(s).toContain("zzzz1111");
    expect(s).toContain("counter-claims");
  });

  it("omits source / repos / tags lines when empty", () => {
    const s = renderSummary(summary({ repos: [], tags: [], source: undefined }));
    expect(s).not.toContain("repos=");
    expect(s).not.toContain("tags=");
  });
});

describe("renderFull", () => {
  it("includes the body and metadata", () => {
    const s = renderFull(full());
    expect(s).toContain("Use m=64MB t=3 p=4");
    expect(s).toContain("body:");
    expect(s).toContain("summary:");
    expect(s).toContain("created:");
  });

  it("marks a lapsed reviewAfter as stale", () => {
    const s = renderFull(full({ reviewAfter: "2000-01-01T00:00:00.000Z" }));
    expect(s).toContain("stale");
  });

  it("shows supersededBy and conflictsWith when set", () => {
    const s = renderFull(full({ supersededBy: "newr5678", conflictsWith: ["oldr1234"] }));
    expect(s).toContain("newr5678");
    expect(s).toContain("oldr1234");
  });
});
