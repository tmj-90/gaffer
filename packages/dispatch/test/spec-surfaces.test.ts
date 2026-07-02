import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { makeHandlers } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "tom" };

function structured(result: {
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}): Record<string, unknown> {
  return result.structuredContent;
}

// --- MCP tool surface ------------------------------------------------------

describe("Spec-Driven Development (Phase 1a): MCP tools", () => {
  it("create_spec -> get_spec -> freeze_spec through the handlers", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    const h = makeHandlers(wg, human);

    const created = structured(
      h.create_spec({
        title: "Auth revamp",
        brief: "Rework auth",
        clauses: [
          { kind: "requirement", text: "Support passkeys" },
          { kind: "non-goal", text: "No SMS OTP" },
        ],
      }),
    );
    const specId = created.spec_id as string;
    expect(created.status).toBe("draft");
    // Clauses come back structured (not a JSON-in-JSON string), each with an id.
    const clauses = created.clauses as Array<{ clause_id: string; kind: string }>;
    expect(clauses).toHaveLength(2);
    expect(clauses[0]?.clause_id.length).toBeGreaterThan(0);

    const fetched = structured(h.get_spec({ spec_id: specId }));
    expect(fetched.title).toBe("Auth revamp");

    const frozen = structured(h.freeze_spec({ spec_id: specId }));
    expect(frozen.status).toBe("frozen");
    expect(frozen.frozen_at).not.toBeNull();

    // NEGATIVE CONTROL: freezing again is a tool-level error, not a silent success.
    const again = h.freeze_spec({ spec_id: specId });
    expect(again.isError).toBe(true);
    expect((again.structuredContent as { error: { code: string } }).error.code).toBe(
      "STATE_CONFLICT",
    );
  });
});

// --- REST surface ----------------------------------------------------------

interface Harness {
  wg: Dispatch;
  baseUrl: string;
  close: () => Promise<void>;
}

async function startHarness(): Promise<Harness> {
  process.env.DISPATCH_AUDIT_OFF = "1";
  const wg = Dispatch.open(":memory:", new TestClock());
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wg,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          wg.db.close();
          resolve();
        });
      }),
  };
}

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

describe("Spec-Driven Development (Phase 1a): REST /specs", () => {
  let h: Harness;
  afterEach(async () => {
    if (h) await h.close();
  });

  it("POST/GET/PATCH/freeze walk the whole lifecycle", async () => {
    h = await startHarness();

    // POST /specs → 201, draft.
    const created = await call(h.baseUrl, "POST", "/specs", {
      title: "Billing",
      clauses: [{ kind: "requirement", text: "Prorate upgrades" }],
    });
    expect(created.status).toBe(201);
    const spec = created.body.spec as { id: string; status: string };
    expect(spec.status).toBe("draft");

    // GET /specs/:id → 200.
    const got = await call(h.baseUrl, "GET", `/specs/${spec.id}`);
    expect(got.status).toBe(200);
    expect((got.body.spec as { title: string }).title).toBe("Billing");

    // PATCH /specs/:id → 200, clauses replaced (still draft).
    const patched = await call(h.baseUrl, "PATCH", `/specs/${spec.id}`, {
      clauses: [
        { kind: "requirement", text: "Prorate upgrades" },
        { kind: "decision", text: "Bill in arrears" },
      ],
    });
    expect(patched.status).toBe(200);

    // GET /specs → 200, lists it.
    const listed = await call(h.baseUrl, "GET", "/specs");
    expect(listed.status).toBe(200);
    expect((listed.body.specs as unknown[]).length).toBe(1);

    // POST /specs/:id/freeze → 200, frozen.
    const frozen = await call(h.baseUrl, "POST", `/specs/${spec.id}/freeze`);
    expect(frozen.status).toBe(200);
    expect((frozen.body.spec as { status: string }).status).toBe("frozen");

    // NEGATIVE CONTROL: PATCH a frozen spec → 409 STATE_CONFLICT (immutable).
    const rejected = await call(h.baseUrl, "PATCH", `/specs/${spec.id}`, {
      clauses: [{ kind: "requirement", text: "sneaky edit" }],
    });
    expect(rejected.status).toBe(409);
    expect((rejected.body.error as { code: string }).code).toBe("STATE_CONFLICT");

    // GET a missing spec → 404.
    const missing = await call(h.baseUrl, "GET", "/specs/nope");
    expect(missing.status).toBe(404);
  });
});
