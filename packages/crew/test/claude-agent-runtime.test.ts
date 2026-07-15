import { describe, expect, it } from "vitest";

import { buildContextPacket } from "../src/context/packet.js";
import { defaultSafetyPolicy } from "../src/safety/policySchema.js";
import { FakeDispatchClient } from "../src/dispatch/fakeClient.js";
import { NullMemoryClient } from "../src/memory/client.js";
import {
  ClaudeAgentRuntime,
  mapEnvelopeToRunResult,
  parseClaudeEnvelope,
} from "../src/runtime/claudeAgentRuntime.js";
import type { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { testConfig, testRepoRegistry } from "./helpers.js";

function packetWith(acTexts: string[]) {
  const config = testConfig();
  const wg = new FakeDispatchClient();
  const ticket = wg.seedTicket({
    title: "Add password reset",
    description: "Implement reset flow.",
    riskLevel: "medium",
    acceptanceCriteria: acTexts.map((text) => ({ text })),
    repositories: [{ name: "web-app", localPath: "/tmp/test-web-app", testCommand: "pnpm test" }],
  });
  return buildContextPacket(ticket.id, {
    config,
    policy: defaultSafetyPolicy(),
    repoRegistry: testRepoRegistry(config),
    dispatch: wg,
    memory: new NullMemoryClient(),
  });
}

// A REAL `claude -p --output-format json` success envelope (captured, trimmed of
// the large usage block). The shape is what the live runtime will feed the bridge.
const REAL_SUCCESS = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 7099,
  num_turns: 1,
  result: "DELIVERED",
  session_id: "917fef64-63fa-4cd6-9b2c-10bb7b925bb3",
  stop_reason: "end_turn",
  total_cost_usd: 0.621343,
  usage: { input_tokens: 4, output_tokens: 7 },
});

const MAX_TURNS = JSON.stringify({
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  num_turns: 30,
  result: "",
  stop_reason: "max_turns",
});

const ERRORED = JSON.stringify({
  type: "result",
  subtype: "error",
  is_error: true,
  result: "the tool crashed",
  stop_reason: "error",
});

describe("parseClaudeEnvelope", () => {
  it("parses a real success envelope into the typed subset", () => {
    const e = parseClaudeEnvelope(REAL_SUCCESS);
    expect(e.resultText).toBe("DELIVERED");
    expect(e.isError).toBe(false);
    expect(e.stopReason).toBe("end_turn");
    expect(e.stopReasonIsMaxTurns).toBe(false);
    expect(e.numTurns).toBe(1);
    expect(e.totalCostUsd).toBe(0.621343);
  });

  it("flags a max-turns envelope (never invents it)", () => {
    const e = parseClaudeEnvelope(MAX_TURNS);
    expect(e.stopReasonIsMaxTurns).toBe(true);
    expect(e.isError).toBe(true);
  });

  it("flags an errored envelope", () => {
    const e = parseClaudeEnvelope(ERRORED);
    expect(e.isError).toBe(true);
    expect(e.stopReasonIsMaxTurns).toBe(false);
  });

  it("recovers the JSON when claude prefixes log/trust noise before it", () => {
    const noisy = `Ignoring 8 permissions.allow entries: this workspace has not been trusted.\n${REAL_SUCCESS}`;
    const e = parseClaudeEnvelope(noisy);
    expect(e.resultText).toBe("DELIVERED");
    expect(e.isError).toBe(false);
  });

  it("is total on empty/garbage input (errored, no result — never throws)", () => {
    for (const junk of ["", "   ", "not json at all", "{oops"]) {
      const e = parseClaudeEnvelope(junk);
      expect(e.isError).toBe(true);
      expect(e.resultText).toBe("");
    }
  });
});

describe("mapEnvelopeToRunResult", () => {
  it("success → submitted_for_review with the agent summary + one note per AC", () => {
    const packet = packetWith(["Reset email is sent", "Token expires after 1 hour"]);
    const r = mapEnvelopeToRunResult(parseClaudeEnvelope(REAL_SUCCESS), packet);
    expect(r.status).toBe("submitted_for_review");
    expect(r.summary).toBe("DELIVERED");
    expect(r.evidence).toHaveLength(2);
    expect(r.evidence.every((e) => e.evidenceType === "note")).toBe(true);
    expect(r.evidence.map((e) => e.acId)).toEqual(packet.acceptanceCriteria.map((ac) => ac.id));
  });

  it("max-turns → blocked with a max-turns reason (checked before the error branch)", () => {
    const packet = packetWith(["x"]);
    const r = mapEnvelopeToRunResult(parseClaudeEnvelope(MAX_TURNS), packet);
    expect(r.status).toBe("blocked");
    expect(r.blockedReason).toMatch(/max turns/i);
    expect(r.evidence).toHaveLength(0);
  });

  it("error → blocked with an errored reason", () => {
    const packet = packetWith(["x"]);
    const r = mapEnvelopeToRunResult(parseClaudeEnvelope(ERRORED), packet);
    expect(r.status).toBe("blocked");
    expect(r.blockedReason).toMatch(/errored/i);
  });

  it("falls back to a deterministic summary when the envelope has no result text", () => {
    const packet = packetWith(["x"]);
    const noResult = parseClaudeEnvelope(JSON.stringify({ type: "result", is_error: false }));
    const r = mapEnvelopeToRunResult(noResult, packet);
    expect(r.status).toBe("submitted_for_review");
    expect(r.summary).toContain(`#${packet.ticket.number}`);
  });
});

describe("ClaudeAgentRuntime (drop-in for the AgentRuntime seam)", () => {
  it("maps a captured envelope through run(packet), injectable like MockAgentRuntime", async () => {
    const packet = packetWith(["Reset email is sent"]);
    const runtime: AgentRuntime = new ClaudeAgentRuntime({ stdout: REAL_SUCCESS });
    const r = await runtime.run(packet);
    expect(r.status).toBe("submitted_for_review");
    expect(r.summary).toBe("DELIVERED");
    expect(r.evidence).toHaveLength(1);
  });

  it("accepts a pre-parsed envelope too", async () => {
    const packet = packetWith(["x"]);
    const runtime = new ClaudeAgentRuntime(parseClaudeEnvelope(MAX_TURNS));
    expect((await runtime.run(packet)).status).toBe("blocked");
  });
});
