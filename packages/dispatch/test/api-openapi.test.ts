/**
 * The OpenAPI contract (src/api/openapi/spec.ts + GET /api/openapi.json).
 *
 * Pins:
 *   - the document builds, is OpenAPI 3.1, and every operationId is unique;
 *   - every request-body / query schema exported from api/schemas.ts is referenced
 *     by an endpoint (a new schema must be documented; the nested createTicketRepo
 *     is the one deliberate exception);
 *   - DRIFT, both ways: every literal path segment in the spec appears as a string
 *     literal in the route source, and every route sub-path constant (TICKET_SUB)
 *     plus every top-level segment server.ts dispatches on appears in the spec;
 *   - the zod → JSON Schema walker renders the constraints (min/max/enum/int/
 *     default/required/nullable) and refuses an unknown construct loudly;
 *   - the endpoint is served behind the read gate: 200 with the read token, 401
 *     without, 405 for POST, and the served document equals the built one.
 */

import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { deriveReadToken } from "../src/api/auth.js";
import {
  buildOpenApiDocument,
  ENDPOINTS,
  operationIdFor,
  toOpenApiPath,
} from "../src/api/openapi/spec.js";
import { UnsupportedZodType, zodToJsonSchema } from "../src/api/openapi/zodJsonSchema.js";
import * as S from "../src/api/schemas.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import { TestClock } from "../src/util/clock.js";

const ROUTES_DIR = join(__dirname, "..", "src", "api", "routes");
const SERVER_TS = join(__dirname, "..", "src", "api", "server.ts");

function routeSource(): string {
  return (
    readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(join(ROUTES_DIR, f), "utf8"))
      .join("\n") +
    "\n" +
    readFileSync(SERVER_TS, "utf8")
  );
}

describe("OpenAPI document", () => {
  const doc = buildOpenApiDocument() as {
    openapi: string;
    info: { version: string };
    paths: Record<
      string,
      Record<
        string,
        { operationId: string; "x-capability": string; requestBody?: unknown; security: unknown[] }
      >
    >;
    components: { schemas: Record<string, unknown> };
  };

  it("is OpenAPI 3.1 with one operation per endpoint and unique operationIds", () => {
    expect(doc.openapi).toBe("3.1.0");
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    expect(ops).toHaveLength(ENDPOINTS.length);
    const ids = ops.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(operationIdFor({ method: "DELETE", path: "/tickets/:id/scopes/:nodeId" } as never)).toBe(
      "deleteTicketsByIdScopesByNodeId",
    );
    expect(toOpenApiPath("/tickets/:id/scopes/:nodeId")).toEqual({
      path: "/tickets/{id}/scopes/{nodeId}",
      params: ["id", "nodeId"],
    });
  });

  it("documents every zod body/query schema exported from api/schemas.ts", () => {
    const referenced = new Set<string>();
    for (const e of ENDPOINTS) {
      if (e.body) referenced.add(e.body);
      if (typeof e.query === "string") referenced.add(e.query);
    }
    const exported = Object.entries(S)
      .filter(([, v]) => typeof v === "object" && v !== null && "_def" in (v as object))
      .map(([k]) => k);
    // createTicketRepo is only ever nested inside createTicketBody.repoIds.
    const missing = exported.filter((k) => !referenced.has(k) && k !== "createTicketRepo");
    expect(missing).toEqual([]);
    // Every referenced body is a component schema; queries are inlined as parameters.
    for (const e of ENDPOINTS) if (e.body) expect(doc.components.schemas[e.body]).toBeDefined();
    expect(doc.components.schemas.ErrorBody).toBeDefined();
  });

  it("does not drift from the router: spec segments exist in the route source, route constants exist in the spec", () => {
    const src = routeSource();
    const specSegments = new Set<string>();
    for (const e of ENDPOINTS) {
      for (const seg of e.path.split("/").filter(Boolean))
        if (!seg.startsWith(":")) specSegments.add(seg);
    }
    // Every literal segment the spec names must be compared somewhere in the router.
    const unknownInRouter = [...specSegments].filter((seg) => !src.includes(`"${seg}"`));
    expect(unknownInRouter, "spec names a path segment no route compares against").toEqual([]);

    // Every TICKET_SUB constant value must be a documented /tickets/:id/<sub> segment.
    const tickets = readFileSync(join(ROUTES_DIR, "tickets.ts"), "utf8");
    const subBlock = /const TICKET_SUB = \{([\s\S]*?)\} as const;/.exec(tickets)?.[1] ?? "";
    const subs = [...subBlock.matchAll(/^\s*[A-Z_]+:\s*"([^"]+)",?\s*$/gm)].map((m) => m[1] ?? "");
    expect(subs.length).toBeGreaterThan(20);
    const undocumented = subs.filter((s) => !specSegments.has(s));
    expect(undocumented, "ticket sub-route without an OpenAPI operation").toEqual([]);

    // Every top-level resource segment server.ts dispatches on has at least one operation.
    const server = readFileSync(SERVER_TS, "utf8");
    const dispatchBlock =
      /switch \(segments\[0\]\) \{([\s\S]*?)\n\s*default:/.exec(server)?.[1] ?? "";
    const tops = [...dispatchBlock.matchAll(/case "([^"]+)":/g)].map((m) => m[1]);
    expect(tops.length).toBeGreaterThan(8);
    const firstSegments = new Set(ENDPOINTS.map((e) => e.path.split("/").filter(Boolean)[0]));
    expect(
      tops.filter((t) => !firstSegments.has(t)),
      "top-level resource without any documented operation",
    ).toEqual([]);
  });

  it("marks capability per operation consistently with the method", () => {
    for (const [p, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (op["x-capability"] === "public") {
          expect(op.security).toEqual([]);
          continue;
        }
        expect(op.security).toEqual([{ bearerAuth: [] }]);
        // GET routes are read-scoped; every mutating verb needs the full token.
        if (method !== "get")
          expect(op["x-capability"], `${method.toUpperCase()} ${p}`).toBe("full");
        if (op.requestBody)
          expect(method, `${method.toUpperCase()} ${p} carries a body`).not.toBe("get");
      }
    }
  });
});

describe("zodToJsonSchema", () => {
  it("renders the constraints the API schemas use", () => {
    const js = zodToJsonSchema(
      z.object({
        name: z.string().trim().min(1).max(200),
        count: z.number().int().min(0).max(10).default(3),
        mode: z.enum(["a", "b"]),
        tags: z.array(z.string()).max(5).optional(),
        note: z.string().nullable(),
        ok: z.coerce.boolean().catch(false).default(false),
      }),
    );
    expect(js).toMatchObject({
      type: "object",
      required: ["name", "mode", "note"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 200 },
        count: { type: "integer", minimum: 0, maximum: 10, default: 3 },
        mode: { type: "string", enum: ["a", "b"] },
        tags: { type: "array", maxItems: 5, items: { type: "string" } },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
        ok: { type: "boolean", default: false },
      },
    });
    expect(
      String((js.properties as Record<string, { description?: string }>).ok?.description),
    ).toContain("Coerced");
  });

  it("converts every exported API schema and refuses an unknown construct loudly", () => {
    for (const [k, v] of Object.entries(S)) {
      if (typeof v === "object" && v !== null && "_def" in (v as object))
        expect(() => zodToJsonSchema(v as never, k)).not.toThrow();
    }
    expect(() => zodToJsonSchema(z.map(z.string(), z.number()))).toThrow(UnsupportedZodType);
    expect(() => zodToJsonSchema(z.object({ when: z.date() }))).toThrow(/ZodDate at when/);
  });
});

describe("GET /api/openapi.json", () => {
  const saved = process.env.DISPATCH_API_TOKEN;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
    if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
    else process.env.DISPATCH_API_TOKEN = saved;
  });

  async function start(): Promise<string> {
    process.env.DISPATCH_AUDIT_OFF = "1";
    const wg = Dispatch.open(":memory:", new TestClock());
    const server = createApiServer(wg);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          wg.db.close();
          resolve();
        }),
      );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("serves the built document behind the read gate; 405 for other methods", async () => {
    const full = "full-token-for-openapi-test-0123456789abcdef";
    process.env.DISPATCH_API_TOKEN = full;
    const base = await start();
    const anon = await fetch(`${base}/api/openapi.json`);
    expect(anon.status).toBe(401);
    const read = await fetch(`${base}/api/openapi.json`, {
      headers: { Authorization: `Bearer ${deriveReadToken(full)}` },
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toContain("application/json");
    const body = (await read.json()) as Record<string, unknown>;
    expect(body).toEqual(buildOpenApiDocument());
    const post = await fetch(`${base}/api/openapi.json`, {
      method: "POST",
      headers: { Authorization: `Bearer ${full}` },
    });
    expect(post.status).toBe(405);
  });
});
