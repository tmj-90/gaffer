/**
 * productContext packet section (Track 1c).
 *
 * Recall normally surfaces code structure + generic lore. This section AIMS
 * recall at the "why" — the durable decisions / requirements / non-goals for the
 * ticket's scope — so an agent starts from intent, not just structure.
 *
 * Asserts:
 *   - the packet carries a `productContext` section holding ONLY product-intent
 *     lore (decision / requirement / non-goal), never the "how" kinds;
 *   - the section is measured as its own token budget line + fingerprinted;
 *   - it is budget-capped by `context.product_context_limit`;
 *   - it degrades to an honest empty section (with guidance) when no intent lore
 *     is in scope.
 */
import { describe, expect, it } from "vitest";

import { buildContextPacket } from "../src/context/packet.js";
import { measurePacket, packetFingerprint } from "../src/context/tokens.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { NullMemoryClient, StubMemoryClient, type LoreRecord } from "../src/memory/client.js";
import { testConfig, testRepoRegistry } from "./helpers.js";

function seedTicket(wg: FakeDispatchClient) {
  return wg.seedTicket({
    title: "Add password reset",
    description: "Implement reset flow.",
    riskLevel: "medium",
    acceptanceCriteria: [{ text: "Reset email is sent" }],
    repositories: [{ name: "web-app", localPath: "/tmp/test-web-app", testCommand: "pnpm test" }],
  });
}

const INTENT_RECORDS: LoreRecord[] = [
  {
    id: "D1",
    title: "Passwordless is a non-goal",
    summary: "We deliberately keep classic passwords for now.",
    tags: ["auth"],
    recordType: "non-goal",
  },
  {
    id: "R1",
    title: "Reset must expire in 1h",
    summary: "Compliance requirement for reset tokens.",
    tags: ["auth"],
    recordType: "requirement",
  },
  {
    id: "K1",
    title: "Use argon2id",
    summary: "Convention — the how, not the why.",
    tags: ["auth"],
    recordType: "convention",
  },
  {
    id: "DEC1",
    title: "Chose email over SMS reset",
    summary: "Decision: SMS costs + deliverability ruled it out.",
    tags: ["auth"],
    recordType: "decision",
  },
];

describe("productContext section", () => {
  it("surfaces only product-intent lore (decision/requirement/non-goal), not the how", () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedTicket(wg);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new StubMemoryClient(INTENT_RECORDS),
    });

    const ids = packet.productContext.intent.map((r) => r.id).sort();
    // The three product-intent records are present…
    expect(ids).toEqual(["D1", "DEC1", "R1"]);
    // …and the convention ("how") record is excluded.
    expect(ids).not.toContain("K1");
    // Each carries its kind + a why-included reason.
    for (const rec of packet.productContext.intent) {
      expect(["decision", "requirement", "non-goal"]).toContain(rec.kind);
      expect(rec.reason.length).toBeGreaterThan(0);
    }
    // Framing guidance is always present.
    expect(packet.productContext.guidance.join(" ")).toMatch(/why|intent/i);
  });

  it("measures productContext as its own token budget line and fingerprints it", () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedTicket(wg);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new StubMemoryClient(INTENT_RECORDS),
    });

    const report = measurePacket(packet);
    expect(report.bySection.productContext).toBeGreaterThan(0);
    expect(packet.tokens.bySection.productContext).toBe(report.bySection.productContext);
    // Section participates in the fingerprint (stable + non-empty).
    expect(packetFingerprint(packet)).toHaveLength(16);
  });

  it("caps the section at context.product_context_limit", () => {
    const base = testConfig();
    const config = testConfig({ context: { ...base.context, product_context_limit: 2 } });
    const wg = new FakeDispatchClient();
    const ticket = seedTicket(wg);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new StubMemoryClient(INTENT_RECORDS),
    });
    expect(packet.productContext.intent.length).toBeLessThanOrEqual(2);
  });

  it("degrades to an honest empty section with guidance when no intent lore is in scope", () => {
    const config = testConfig();
    const wg = new FakeDispatchClient();
    const ticket = seedTicket(wg);
    const packet = buildContextPacket(ticket.id, {
      config,
      policy: defaultSafetyPolicy(),
      repoRegistry: testRepoRegistry(config),
      dispatch: wg,
      memory: new NullMemoryClient(),
    });
    expect(packet.productContext.intent).toEqual([]);
    expect(packet.productContext.guidance.length).toBeGreaterThan(0);
  });
});
