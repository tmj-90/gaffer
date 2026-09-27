import type { ZodTypeAny } from "zod";

/**
 * zod (v3) → JSON Schema (OpenAPI 3.1 dialect), for the request bodies and query
 * schemas in `api/schemas.ts`.
 *
 * Deliberately a small, explicit walker over the constructs this codebase uses
 * rather than a dependency: every construct it does not know throws
 * {@link UnsupportedZodType}, so a new schema shape fails the OpenAPI test the
 * moment it is introduced instead of silently becoming `{}` in the published
 * contract. `.refine()` predicates are opaque to JSON Schema; they are surfaced
 * as a `description` note (the message text, when one is set) so the contract
 * says a rule exists even when it cannot express it.
 */

export type JsonSchema = Record<string, unknown>;

export class UnsupportedZodType extends Error {
  constructor(typeName: string, path: string) {
    super(`zodToJsonSchema: unsupported zod type ${typeName} at ${path || "<root>"}`);
    this.name = "UnsupportedZodType";
  }
}

interface ZodDefLike {
  typeName?: string;
  description?: string;
  coerce?: boolean;
  checks?: ReadonlyArray<{
    kind: string;
    value?: unknown;
    regex?: RegExp;
    inclusive?: boolean;
    message?: string;
  }>;
  innerType?: ZodTypeAny;
  schema?: ZodTypeAny;
  type?: ZodTypeAny;
  valueType?: ZodTypeAny;
  options?: ReadonlyArray<ZodTypeAny>;
  values?: ReadonlyArray<string> | Record<string, string | number>;
  value?: unknown;
  shape?: () => Record<string, ZodTypeAny>;
  defaultValue?: () => unknown;
  unknownKeys?: string;
  catchall?: ZodTypeAny;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  exactLength?: { value: number } | null;
  effect?: { type: string; refinement?: unknown };
  errorMap?: unknown;
}

function def(schema: ZodTypeAny): ZodDefLike {
  return (schema as unknown as { _def: ZodDefLike })._def;
}

function withDescription(out: JsonSchema, d: ZodDefLike): JsonSchema {
  if (d.description && out.description === undefined) out.description = d.description;
  return out;
}

function appendNote(out: JsonSchema, note: string): JsonSchema {
  const existing =
    typeof out.description === "string" && out.description.length > 0 ? `${out.description} ` : "";
  out.description = `${existing}${note}`.trim();
  return out;
}

/** Convert one zod schema. `path` is only used for error messages. */
export function zodToJsonSchema(schema: ZodTypeAny, path = ""): JsonSchema {
  const d = def(schema);
  const t = d.typeName ?? "<unknown>";
  switch (t) {
    case "ZodString": {
      const out: JsonSchema = { type: "string" };
      for (const c of d.checks ?? []) {
        switch (c.kind) {
          case "min":
            out.minLength = c.value;
            break;
          case "max":
            out.maxLength = c.value;
            break;
          case "length":
            out.minLength = c.value;
            out.maxLength = c.value;
            break;
          case "regex":
            if (c.regex) out.pattern = c.regex.source;
            break;
          case "uuid":
            out.format = "uuid";
            break;
          case "url":
            out.format = "uri";
            break;
          case "email":
            out.format = "email";
            break;
          case "datetime":
            out.format = "date-time";
            break;
          case "trim":
          case "toLowerCase":
          case "toUpperCase":
            // Normalisation, not a constraint on the wire value.
            break;
          default:
            throw new UnsupportedZodType(`ZodString check '${c.kind}'`, path);
        }
      }
      return withDescription(out, d);
    }
    case "ZodNumber": {
      const out: JsonSchema = { type: "number" };
      for (const c of d.checks ?? []) {
        switch (c.kind) {
          case "int":
            out.type = "integer";
            break;
          case "min":
            if (c.inclusive === false) out.exclusiveMinimum = c.value;
            else out.minimum = c.value;
            break;
          case "max":
            if (c.inclusive === false) out.exclusiveMaximum = c.value;
            else out.maximum = c.value;
            break;
          case "finite":
            break;
          default:
            throw new UnsupportedZodType(`ZodNumber check '${c.kind}'`, path);
        }
      }
      if (d.coerce) appendNote(out, "Coerced from a string.");
      return withDescription(out, d);
    }
    case "ZodBoolean": {
      const out: JsonSchema = { type: "boolean" };
      if (d.coerce) appendNote(out, 'Coerced from a string ("1"/"true").');
      return withDescription(out, d);
    }
    case "ZodLiteral":
      return withDescription({ const: d.value }, d);
    case "ZodEnum":
      return withDescription({ type: "string", enum: [...(d.values as ReadonlyArray<string>)] }, d);
    case "ZodNativeEnum": {
      const vals = Object.values(d.values as Record<string, string | number>).filter(
        (v) => typeof v === "string" || typeof v === "number",
      );
      return withDescription({ enum: vals }, d);
    }
    case "ZodUnknown":
    case "ZodAny":
      return withDescription({}, d);
    case "ZodNull":
      return withDescription({ type: "null" }, d);
    case "ZodArray": {
      const out: JsonSchema = {
        type: "array",
        items: zodToJsonSchema(d.type as ZodTypeAny, `${path}[]`),
      };
      if (d.minLength) out.minItems = d.minLength.value;
      if (d.maxLength) out.maxItems = d.maxLength.value;
      if (d.exactLength) {
        out.minItems = d.exactLength.value;
        out.maxItems = d.exactLength.value;
      }
      return withDescription(out, d);
    }
    case "ZodObject": {
      const shape = d.shape ? d.shape() : {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, sub] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(sub, path ? `${path}.${key}` : key);
        if (!isOptionalOnWire(sub)) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties };
      if (required.length > 0) out.required = required;
      // `.strict()` refuses unknown keys; `.strip()` (the zod default) drops them;
      // `.passthrough()` keeps them. Only strict is a wire-level constraint.
      if (d.unknownKeys === "strict") out.additionalProperties = false;
      else if (d.catchall && def(d.catchall).typeName !== "ZodNever") {
        out.additionalProperties = zodToJsonSchema(d.catchall, `${path}.*`);
      }
      return withDescription(out, d);
    }
    case "ZodRecord": {
      const out: JsonSchema = {
        type: "object",
        additionalProperties: zodToJsonSchema(d.valueType as ZodTypeAny, `${path}.*`),
      };
      return withDescription(out, d);
    }
    case "ZodUnion": {
      const out: JsonSchema = {
        anyOf: (d.options ?? []).map((o, i) => zodToJsonSchema(o, `${path}|${i}`)),
      };
      return withDescription(out, d);
    }
    case "ZodOptional":
      return withDescription(zodToJsonSchema(d.innerType as ZodTypeAny, path), d);
    case "ZodNullable": {
      const inner = zodToJsonSchema(d.innerType as ZodTypeAny, path);
      const out: JsonSchema = Array.isArray(inner.anyOf)
        ? { anyOf: [...(inner.anyOf as JsonSchema[]), { type: "null" }] }
        : { anyOf: [inner, { type: "null" }] };
      return withDescription(out, d);
    }
    case "ZodDefault": {
      const inner = zodToJsonSchema(d.innerType as ZodTypeAny, path);
      if (d.defaultValue) inner.default = d.defaultValue();
      return withDescription(inner, d);
    }
    case "ZodCatch": {
      // An invalid value is replaced by the fallback rather than rejected: the wire
      // shape is the inner type; note the forgiving behaviour.
      const inner = zodToJsonSchema(d.innerType as ZodTypeAny, path);
      return withDescription(
        appendNote(inner, "An invalid value falls back to the default instead of being rejected."),
        d,
      );
    }
    case "ZodEffects": {
      const inner = zodToJsonSchema(d.schema as ZodTypeAny, path);
      if (d.effect?.type === "refinement") {
        const msg = refineMessage(d);
        return withDescription(
          appendNote(
            inner,
            msg
              ? `Additional rule: ${msg}`
              : "Additional validation rule applies (not expressible in JSON Schema).",
          ),
          d,
        );
      }
      if (d.effect?.type === "transform" || d.effect?.type === "preprocess")
        return withDescription(inner, d);
      throw new UnsupportedZodType(`ZodEffects '${d.effect?.type ?? "?"}'`, path);
    }
    default:
      throw new UnsupportedZodType(t, path);
  }
}

/** True when the key may be absent from the request (optional or defaulted). */
function isOptionalOnWire(schema: ZodTypeAny): boolean {
  const d = def(schema);
  switch (d.typeName) {
    case "ZodOptional":
    case "ZodDefault":
      return true;
    case "ZodCatch":
    case "ZodNullable":
    case "ZodEffects":
      return isOptionalOnWire((d.innerType ?? d.schema) as ZodTypeAny);
    default:
      return (
        typeof (schema as { isOptional?: () => boolean }).isOptional === "function" &&
        schema.isOptional()
      );
  }
}

/** The message a `.refine(pred, { message })` / `.refine(pred, "msg")` carries, if recoverable. */
function refineMessage(d: ZodDefLike): string | undefined {
  const r = d.effect?.refinement as unknown;
  // zod stores the user's params in a closure; the message is not reachable from the
  // def, but a string `message` on the effect object is (zod ≥ 3.22 exposes none).
  // Callers that want a documented rule use `.describe()`; this stays best-effort.
  if (
    typeof r === "object" &&
    r !== null &&
    typeof (r as { message?: unknown }).message === "string"
  ) {
    return (r as { message: string }).message;
  }
  return undefined;
}
