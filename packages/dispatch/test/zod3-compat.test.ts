/**
 * zod 3 compatibility on zod 4 (src/util/zod3Compat.ts).
 *
 * Pins, with the exact output zod 3 produced:
 *   - default messages, codes, fields and key order of validation issues (the
 *     global error map), for issues with and without their own message;
 *   - the issues themselves: a length check that also fails a mistyped value is
 *     not reported twice, and a failed union reports its dirty option;
 *   - MCP tool input schemas: zod-to-json-schema's rendering (`additionalProperties:
 *     false`, no safe-integer bounds, `$schema` last on the wire), and zod 3's issue
 *     order when the SDK validates asynchronously;
 *   - Dispatch's own tools/list carries exactly that rendering;
 *   - the memory package's copy of the module has not drifted.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

import { Dispatch } from "../src/core.js";
import { createDispatchServer } from "../src/mcp/server.js";
import { toolSchemas } from "../src/mcp/tools.js";

import {
  mcpToolInput,
  toZod3Issues,
  zod3JsonSchema,
  type Zod3Issue,
} from "../src/util/zod3Compat.js";

function issuesOf(schema: z.ZodType, input: unknown): Zod3Issue[] {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("expected a validation failure");
  return toZod3Issues(r.error.issues);
}

describe("zod 3 validation issues", () => {
  const body = z.object({
    title: z.string().min(1),
    count: z.number().int().min(0),
    mode: z.enum(["a", "b"]),
    url: z.url().optional(),
  });

  it("keeps zod 3's codes, fields, key order and default messages", () => {
    const issues = issuesOf(body, { count: 1.5, mode: "c", url: "nope" });
    expect(JSON.stringify(issues)).toBe(
      JSON.stringify([
        {
          code: "invalid_type",
          expected: "string",
          received: "undefined",
          path: ["title"],
          message: "Required",
        },
        {
          code: "invalid_type",
          expected: "integer",
          received: "float",
          message: "Expected integer, received float",
          path: ["count"],
        },
        {
          received: "c",
          code: "invalid_enum_value",
          options: ["a", "b"],
          path: ["mode"],
          message: "Invalid enum value. Expected 'a' | 'b', received 'c'",
        },
        { validation: "url", code: "invalid_string", message: "Invalid url", path: ["url"] },
      ]),
    );
  });

  it("renders sizes, wrong types, enum type errors and unknown keys the zod 3 way", () => {
    const strict = z
      .object({ s: z.string().max(2), n: z.number().positive(), e: z.enum(["x"]) })
      .strict();
    const issues = issuesOf(strict, { s: "abc", n: 0, e: 3, extra: 1 });
    expect(issues.map((i) => i.message)).toEqual([
      "String must contain at most 2 character(s)",
      "Number must be greater than 0",
      "Expected 'x', received number",
      "Unrecognized key(s) in object: 'extra'",
    ]);
    expect(issues[0]).toEqual({
      code: "too_big",
      maximum: 2,
      type: "string",
      inclusive: true,
      exact: false,
      message: "String must contain at most 2 character(s)",
      path: ["s"],
    });
    expect(issuesOf(z.array(z.string()).min(1), [])[0]?.message).toBe(
      "Array must contain at least 1 element(s)",
    );
    expect(issuesOf(z.string(), 5)[0]?.message).toBe("Expected string, received number");
    expect(issuesOf(z.literal("a"), "b")[0]).toEqual({
      received: "b",
      code: "invalid_literal",
      expected: "a",
      path: [],
      message: 'Invalid literal value, expected "a"',
    });
  });

  it("reshapes an issue that carries its own message without changing the message", () => {
    const s = z.object({
      name: z.string().min(1, "name is required"),
      ref: z.string().regex(/^[a-z]+$/, "lowercase only"),
      ok: z.string().refine((v) => v === "ok", { error: "must be ok" }),
    });
    expect(JSON.stringify(issuesOf(s, { name: "", ref: "A", ok: "no" }))).toBe(
      JSON.stringify([
        {
          code: "too_small",
          minimum: 1,
          type: "string",
          inclusive: true,
          exact: false,
          message: "name is required",
          path: ["name"],
        },
        { validation: "regex", code: "invalid_string", message: "lowercase only", path: ["ref"] },
        { code: "custom", message: "must be ok", path: ["ok"] },
      ]),
    );
  });

  it("does not report a length check on a value whose type already failed", () => {
    expect(issuesOf(z.object({ t: z.string().min(1) }), { t: [] })).toEqual([
      {
        code: "invalid_type",
        expected: "string",
        received: "array",
        path: ["t"],
        message: "Expected string, received array",
      },
    ]);
  });

  it("reports a failed union as zod 3 did: its dirty option, else every option", () => {
    const ticket = z.union([z.number().int().positive(), z.string().min(1)]);
    expect(issuesOf(z.object({ ticket }), { ticket: 1.5 }).map((i) => i.message)).toEqual([
      "Expected integer, received float",
    ]);
    const [union] = issuesOf(z.object({ ticket }), { ticket: true });
    expect(union).toMatchObject({
      code: "invalid_union",
      path: ["ticket"],
      message: "Invalid input",
    });
    expect(union?.unionErrors).toEqual([
      {
        issues: [
          {
            code: "invalid_type",
            expected: "number",
            received: "boolean",
            path: ["ticket"],
            message: "Expected number, received boolean",
          },
        ],
        name: "ZodError",
      },
      {
        issues: [
          {
            code: "invalid_type",
            expected: "string",
            received: "boolean",
            path: ["ticket"],
            message: "Expected string, received boolean",
          },
        ],
        name: "ZodError",
      },
    ]);
  });
});

describe("MCP tool input schemas", () => {
  const shape = {
    id: z.string().min(1).describe("The id."),
    limit: z.number().int().positive().default(20),
    tags: z.array(z.string()).optional(),
    kind: z.enum(["a", "b"]).optional(),
    note: z.string().nullable().optional(),
    url: z
      .url()
      .refine((u) => u.startsWith("https://"), "https only")
      .optional(),
  };

  it("renders a tool shape exactly as zod-to-json-schema did on zod 3", () => {
    expect(JSON.stringify(zod3JsonSchema(z.object(shape)))).toBe(
      JSON.stringify({
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, description: "The id." },
          limit: { type: "integer", exclusiveMinimum: 0, default: 20 },
          tags: { type: "array", items: { type: "string" } },
          kind: { type: "string", enum: ["a", "b"] },
          note: { type: ["string", "null"] },
          url: { type: "string", format: "uri" },
        },
        required: ["id"],
        additionalProperties: false,
      }),
    );
  });

  it("publishes that rendering through zod's toJSONSchema, with $schema last", () => {
    const wire = JSON.stringify(
      z.toJSONSchema(mcpToolInput(shape), { target: "draft-7", io: "input" }),
    );
    expect(wire).toBe(
      JSON.stringify({
        ...zod3JsonSchema(z.object(shape)),
        $schema: "http://json-schema.org/draft-07/schema#",
      }),
    );
    // An empty shape keeps zod's own rendering (as the SDK produced it on zod 3).
    expect(z.toJSONSchema(mcpToolInput({}), { target: "draft-7", io: "input" })).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {},
    });
  });

  it("validates asynchronously with zod 3's issue order and without doubled issues", async () => {
    const schema = mcpToolInput(shape);
    const r = await schema.safeParseAsync({ id: [], url: "http://x.test", limit: "x" });
    expect(r.success).toBe(false);
    // Plain issues first, the refinement after them (zod 3 resolved it later).
    expect(r.error?.issues.map((i) => [i.path.join("."), i.message])).toEqual([
      ["id", "Expected string, received array"],
      ["limit", "Expected number, received string"],
      ["url", "https only"],
    ]);
  });
});

describe("Dispatch's MCP server", () => {
  it("publishes every tool's arguments as zod-to-json-schema did", async () => {
    const server = createDispatchServer(Dispatch.open(":memory:"), { type: "agent", id: "a" });
    const client = new Client({ name: "test", version: "0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    for (const t of tools) {
      const name = t.name as keyof typeof toolSchemas;
      const shape = toolSchemas[name] as z.ZodRawShape;
      if (Object.keys(shape).length === 0) continue;
      expect(JSON.stringify(t.inputSchema), name).toBe(
        JSON.stringify({
          ...zod3JsonSchema(z.object(shape)),
          $schema: "http://json-schema.org/draft-07/schema#",
        }),
      );
    }
    await client.close();
  });
});

describe("the memory package's copy", () => {
  it("is byte-identical to this one", () => {
    const here = readFileSync(join(__dirname, "..", "src", "util", "zod3Compat.ts"), "utf8");
    const memory = readFileSync(
      join(__dirname, "..", "..", "memory", "src", "util", "zod3Compat.ts"),
      "utf8",
    );
    expect(memory).toBe(here);
  });
});
