/**
 * Ticket → lore distillation at close (Track 1c).
 *
 * A closed ticket's title / AC / decisions / reject-reasons carry the product
 * intent that otherwise evaporates. distillTicketIntent harvests it into DRAFT
 * lore (decision / requirement) — never auto-promoted.
 *
 * Asserts:
 *   - a ticket with AC distills a REQUIREMENT draft carrying the AC + kind;
 *   - decisions / reject-reasons distill a DECISION draft;
 *   - a ticket with neither yields nothing (no noise);
 *   - drafts stay under Memory's title/summary caps.
 */
import { describe, expect, it } from "vitest";

import { distillTicketIntent } from "../src/context/ticketIntent.js";

describe("distillTicketIntent", () => {
  it("distills a requirement draft from a ticket's AC", () => {
    const drafts = distillTicketIntent("web-app", {
      number: 42,
      title: "Add password reset",
      acceptanceCriteria: [
        { text: "Reset email is sent", status: "passed" },
        { text: "Token expires after 1 hour", status: "passed" },
      ],
      outcomeSummary: "Implemented reset flow with a 1h TTL token.",
    });

    const requirement = drafts.find((d) => d.kind === "requirement");
    expect(requirement).toBeDefined();
    expect(requirement!.summary).toContain("Token expires after 1 hour");
    expect(requirement!.summary).toContain("Implemented reset flow");
    expect(requirement!.tags).toContain("ticket-intent");
    expect(requirement!.tags).toContain("ticket-42");
  });

  it("distills a decision draft from decisions + reject-reasons", () => {
    const drafts = distillTicketIntent("web-app", {
      number: 7,
      title: "Choose email reset",
      acceptanceCriteria: [],
      decisions: ["Use email, not SMS, for reset delivery."],
      rejectReasons: ["SMS rejected: cost + deliverability."],
    });

    const decision = drafts.find((d) => d.kind === "decision");
    expect(decision).toBeDefined();
    expect(decision!.summary).toContain("Use email, not SMS");
    expect(decision!.summary).toContain("SMS rejected");
    expect(decision!.tags).toContain("decision");
  });

  it("produces both a requirement AND a decision when both signals exist", () => {
    const drafts = distillTicketIntent("web-app", {
      number: 9,
      title: "Ship X",
      acceptanceCriteria: [{ text: "X works", status: "passed" }],
      decisions: ["Chose approach A."],
    });
    expect(drafts.map((d) => d.kind).sort()).toEqual(["decision", "requirement"]);
  });

  it("harvests nothing when there is no durable intent (no AC, no decisions)", () => {
    expect(
      distillTicketIntent("web-app", { number: 1, title: "Tidy up", acceptanceCriteria: [] }),
    ).toEqual([]);
  });

  it("keeps drafts within Memory's title (200) and summary (800) caps", () => {
    const drafts = distillTicketIntent("web-app", {
      number: 100,
      title: "X".repeat(400),
      acceptanceCriteria: Array.from({ length: 50 }, (_, i) => ({
        text: `criterion ${i} `.repeat(20),
        status: "passed",
      })),
    });
    for (const d of drafts) {
      expect(d.title.length).toBeLessThanOrEqual(200);
      expect(d.summary.length).toBeLessThanOrEqual(800);
    }
  });
});
