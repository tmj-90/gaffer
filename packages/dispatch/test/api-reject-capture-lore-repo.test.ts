/**
 * Send back with "also capture as a lore draft" scopes the draft to the ticket's
 * write repo. The Memory view lists lore per repo, so the repo-less draft it used to
 * file appeared on no page (the toast sent the reviewer to a queue that never showed
 * it). Found by the browser scenario suite S9.
 */
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import type { MemoryReader } from "../src/api/memoryReader.js";
import { createMemoryReader } from "../src/api/memoryReader.js";
import { createApiServer } from "../src/api/server.js";
import { createPlanBuildRunner } from "../src/api/planBuild.js";
import { TestClock } from "../src/util/clock.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

const human: Actor = { type: "human", id: "tom" };

async function call(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe("POST /tickets/:id/review/reject with captureLore", () => {
  it("files the lore draft under the ticket's write repo", async () => {
    const wg = Dispatch.open(":memory:", new TestClock(), nonEmptyDiffRunner);
    const captured: Array<{ repo?: string; title: string }> = [];
    const memoryReader: MemoryReader = {
      ...createMemoryReader({} as NodeJS.ProcessEnv),
      captureLoreDraft: (input) => {
        captured.push(input);
        return { available: true, id: "draft1" };
      },
    };
    const noop = { run: () => ({ started: true }) } as never;
    const server = createApiServer(
      wg,
      noop,
      createPlanBuildRunner(),
      noop,
      noop,
      "127.0.0.1",
      memoryReader,
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      wg.registerRepository({ name: "svc", default_branch: "main" }, human);
      const t = wg.createTicket({ title: "Capture me", description: "d" }, human);
      wg.linkRepository(t.id, "svc", "primary", human);
      wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
      wg.markReady(t.id, human);
      const agent = wg.registerAgent({ display_name: "a" }, human);
      const claim = wg.claimNextTicket({ agentId: agent.id, ttlSeconds: 600 }, human);
      wg.submitForReview({ claimToken: claim!.claimToken, ticket_id: t.id }, human);
      const res = await call(base, "POST", `/tickets/${t.id}/review/reject`, {
        to: "refining",
        reason: "prefer pure helpers",
        captureLore: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.lore_capture).toMatchObject({ captured: true });
      expect(captured).toHaveLength(1);
      expect(captured[0]!.repo).toBe("svc");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      wg.db.close();
    }
  });
});
