import { describe, expect, it } from "vitest";

import { buildContextPacket } from "../src/context/packet.js";
import { estimateTokens, measurePacket, packetFingerprint } from "../src/context/tokens.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { NullMemoryClient } from "../src/memory/client.js";
import { testConfig, testRepoRegistry } from "./helpers.js";

function seededDeps() {
  const config = testConfig();
  const wg = new FakeDispatchClient();
  const ticket = wg.seedTicket({
    title: "Add password reset",
    description: "Implement reset flow.",
    riskLevel: "medium",
    acceptanceCriteria: [{ text: "Reset email is sent" }],
    repositories: [{ name: "web-app", localPath: "/tmp/test-web-app", testCommand: "pnpm test" }],
  });
  const deps = {
    config,
    policy: defaultSafetyPolicy(),
    repoRegistry: testRepoRegistry(config),
    dispatch: wg,
    memory: new NullMemoryClient(),
  };
  return { ticketId: ticket.id, deps };
}

function buildTestPacket() {
  const { ticketId, deps } = seededDeps();
  return buildContextPacket(ticketId, deps);
}

describe("estimateTokens", () => {
  it("returns 0 for empty or undefined input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens([])).toBe(1); // "[]" → 2 chars → ceil(2/4) = 1
  });

  it("scales with content length (~4 chars per token)", () => {
    expect(estimateTokens("a".repeat(4))).toBe(1);
    expect(estimateTokens("a".repeat(8))).toBe(2);
    expect(estimateTokens("a".repeat(9))).toBe(3); // ceil(9/4)
  });

  it("is deterministic for the same value", () => {
    const value = { a: 1, b: "hello", c: [1, 2, 3] };
    expect(estimateTokens(value)).toBe(estimateTokens(value));
  });

  it("a larger object costs more than a smaller one", () => {
    expect(estimateTokens({ items: Array(50).fill("x") })).toBeGreaterThan(
      estimateTokens({ items: ["x"] }),
    );
  });
});

describe("measurePacket", () => {
  it("reports a positive total and a per-section breakdown", () => {
    const packet = buildTestPacket();
    const report = measurePacket(packet);
    expect(report.total).toBeGreaterThan(0);
    expect(report.bySection.ticket).toBeGreaterThan(0);
    expect(report.bySection.acceptanceCriteria).toBeGreaterThan(0);
    // The total is the sum of all measured sections.
    const summed = Object.values(report.bySection).reduce((a, b) => a + b, 0);
    expect(report.total).toBe(summed);
  });

  it("is attached to the packet on build", () => {
    const packet = buildTestPacket();
    expect(packet.tokens.total).toBeGreaterThan(0);
    expect(packet.tokens).toEqual(measurePacket(packet));
  });
});

describe("packetFingerprint", () => {
  it("is stable across rebuilds of the same unchanged ticket", () => {
    const { ticketId, deps } = seededDeps();
    expect(buildContextPacket(ticketId, deps).fingerprint).toBe(
      buildContextPacket(ticketId, deps).fingerprint,
    );
  });

  it("changes when packet content changes", () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    const a = wg.seedTicket({
      title: "Ticket A",
      description: "x",
      acceptanceCriteria: [{ text: "AC1" }],
      repositories: [{ name: "web-app", localPath: "/tmp/test-web-app" }],
    });
    const b = wg.seedTicket({
      title: "Ticket B — different",
      description: "y",
      acceptanceCriteria: [{ text: "AC2" }],
      repositories: [{ name: "web-app", localPath: "/tmp/test-web-app" }],
    });
    const deps = {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new NullMemoryClient(),
    };
    expect(buildContextPacket(a.id, deps).fingerprint).not.toBe(
      buildContextPacket(b.id, deps).fingerprint,
    );
  });

  it("ignores the tokens/fingerprint metadata fields", () => {
    const packet = buildTestPacket();
    // Recomputing over a packet whose metadata was mutated yields the same hash.
    const mutated = {
      ...packet,
      tokens: { total: 999, bySection: packet.tokens.bySection },
      fingerprint: "zzz",
    };
    expect(packetFingerprint(mutated)).toBe(packet.fingerprint);
  });
});
