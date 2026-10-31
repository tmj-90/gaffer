import type { ZodType } from "zod";

import {
  checkDefs,
  isTransform,
  refinementCount,
  unrefined,
  zod3Description,
  zodDef,
} from "../../util/zod3Compat.js";

/**
 * zod → JSON Schema (OpenAPI 3.1 dialect), for the request bodies and query
 * schemas in `api/schemas.ts`.
 *
 * Deliberately a small, explicit walker over the constructs this codebase uses
 * rather than a dependency: every construct it does not know throws
 * {@link UnsupportedZodType}, so a new schema shape fails the OpenAPI test the
 * moment it is introduced instead of silently becoming `{}` in the published
 * contract. `.refine()` predicates are opaque to JSON Schema; they are surfaced
 * as a `description` note so the contract says a rule exists even when it cannot
 * express it.
 *
 * The walker reads zod 4's definitions (`_zod.def`). It renders exactly what the
 * zod 3 walker rendered, so docs/openapi.json did not move in the zod 4 migration:
 *  - a refinement is a `custom` check on the schema itself (zod 3 wrapped it in a
 *    `ZodEffects`); each one appends the "additional rule" note, and a description
 *    set BEFORE the first refinement is the one shown, as with the zod 3 wrapper;
 *  - wrappers (optional / nullable / default / catch / transform) fall back to the
 *    description of what they wrap, which zod 3 copied onto the wrapper's def;
 *  - `.transform()` is a pipe into a transform (rendered as its input) and
 *    `z.preprocess()` a pipe out of one (rendered as its target);
 *  - `.prefault()` (zod 3's `.default()` on an object, whose value is parsed) is a
 *    default like any other.
 */

export type JsonSchema = Record<string, unknown>;

export class UnsupportedZodType extends Error {
  constructor(typeName: string, path: string) {
    super(`zodToJsonSchema: unsupported zod type ${typeName} at ${path || "<root>"}`);
    this.name = "UnsupportedZodType";
  }
}

/** The slice of a zod 4 check definition the walker reads. */
interface CheckDefLike {
  check?: string;
  format?: string;
  pattern?: RegExp;
  minimum?: number;
  maximum?: number;
  length?: number;
  value?: number;
  inclusive?: boolean;
}

const def = zodDef;

/** zod 3's type name for an unsupported construct (`date` → `ZodDate`). */
function zod3TypeName(type: string | undefined): string {
  const t = type ?? "unknown";
  return `Zod${t.charAt(0).toUpperCase()}${t.slice(1)}`;
}

function withDescription(out: JsonSchema, description: string | undefined): JsonSchema {
  if (description && out.description === undefined) out.description = description;
  return out;
}

function appendNote(out: JsonSchema, note: string): JsonSchema {
  const existing =
    typeof out.description === "string" && out.description.length > 0 ? `${out.description} ` : "";
  out.description = `${existing}${note}`.trim();
  return out;
}

const REFINEMENT_NOTE = "Additional validation rule applies (not expressible in JSON Schema).";

/** Shared component schemas in effect for the current {@link zodToJsonSchemaWithRefs} call. */
let named: { refs: ReadonlyMap<ZodType, string>; root: ZodType; used: Set<string> } | null = null;

/**
 * Convert `schema`, rendering every NESTED occurrence of a schema in `refs` as a
 * `$ref` to `#/components/schemas/<name>` instead of inlining it (the root itself is
 * always rendered). Returns the names it referenced, so the caller can add them as
 * components (each converted the same way).
 */
export function zodToJsonSchemaWithRefs(
  schema: ZodType,
  path: string,
  refs: ReadonlyMap<ZodType, string>,
): { schema: JsonSchema; used: string[] } {
  const prev = named;
  const used = new Set<string>();
  named = { refs, root: schema, used };
  try {
    return { schema: zodToJsonSchema(schema, path), used: [...used] };
  } finally {
    named = prev;
  }
}

/** Convert one zod schema. `path` is only used for error messages. */
export function zodToJsonSchema(schema: ZodType, path = ""): JsonSchema {
  if (named && schema !== named.root) {
    const ref = named.refs.get(schema);
    if (ref !== undefined) {
      named.used.add(ref);
      return { $ref: `#/components/schemas/${ref}` };
    }
  }
  const refinements = refinementCount(schema);
  if (refinements === 0) return convert(schema, path);
  // Render the schema as it stood before its refinements, then note each rule
  // (zod's message is not recoverable from the check; `.describe()` documents one).
  const base = unrefined(schema);
  if (!base) throw new UnsupportedZodType(`refined ${zod3TypeName(def(schema).type)}`, path);
  const out = convert(base, path);
  for (let i = 0; i < refinements; i += 1) appendNote(out, REFINEMENT_NOTE);
  return out;
}

function convert(schema: ZodType, path: string): JsonSchema {
  const d = def(schema);
  const desc = (): string | undefined => zod3Description(schema);
  switch (d.type) {
    case "string": {
      const out: JsonSchema = { type: "string" };
      // `z.url()` & co. carry their format on the schema itself.
      const own: CheckDefLike[] = d.format ? [{ check: "string_format", format: d.format }] : [];
      for (const c of [...own, ...checkDefs(schema)]) {
        switch (c.check) {
          case "min_length":
            out.minLength = c.minimum;
            break;
          case "max_length":
            out.maxLength = c.maximum;
            break;
          case "length_equals":
            out.minLength = c.length;
            out.maxLength = c.length;
            break;
          case "overwrite":
            // trim / toLowerCase / toUpperCase: normalisation, not a constraint on
            // the wire value.
            break;
          case "string_format":
            switch (c.format) {
              case "regex":
                if (c.pattern) out.pattern = c.pattern.source;
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
              default:
                throw new UnsupportedZodType(`ZodString check '${c.format ?? "?"}'`, path);
            }
            break;
          default:
            throw new UnsupportedZodType(`ZodString check '${c.check}'`, path);
        }
      }
      return withDescription(out, desc());
    }
    case "number": {
      const out: JsonSchema = { type: "number" };
      const own: CheckDefLike[] = d.format ? [{ check: "number_format", format: d.format }] : [];
      for (const c of [...own, ...checkDefs(schema)]) {
        switch (c.check) {
          case "number_format":
            // `.int()` is zod 4's safe-integer format.
            if (c.format !== "safeint") {
              throw new UnsupportedZodType(`ZodNumber format '${c.format ?? "?"}'`, path);
            }
            out.type = "integer";
            break;
          case "greater_than":
            if (c.inclusive === false) out.exclusiveMinimum = c.value;
            else out.minimum = c.value;
            break;
          case "less_than":
            if (c.inclusive === false) out.exclusiveMaximum = c.value;
            else out.maximum = c.value;
            break;
          default:
            throw new UnsupportedZodType(`ZodNumber check '${c.check}'`, path);
        }
      }
      if (d.coerce) appendNote(out, "Coerced from a string.");
      return withDescription(out, desc());
    }
    case "boolean": {
      const out: JsonSchema = { type: "boolean" };
      if (d.coerce) appendNote(out, 'Coerced from a string ("1"/"true").');
      return withDescription(out, desc());
    }
    case "literal": {
      const values = d.values ?? [];
      if (values.length !== 1) throw new UnsupportedZodType("ZodLiteral (multiple values)", path);
      return withDescription({ const: values[0] }, desc());
    }
    case "enum": {
      const vals = Object.values(d.entries ?? {});
      // z.enum([...strings]) was ZodEnum; a numeric/mixed (native) enum ZodNativeEnum.
      if (vals.every((v) => typeof v === "string")) {
        return withDescription({ type: "string", enum: vals }, desc());
      }
      return withDescription({ enum: vals }, desc());
    }
    case "unknown":
    case "any":
      return withDescription({}, desc());
    case "null":
      return withDescription({ type: "null" }, desc());
    case "array": {
      const out: JsonSchema = {
        type: "array",
        items: zodToJsonSchema(d.element as ZodType, `${path}[]`),
      };
      // zod 3 kept one min / max / exact length on the def (the last call wins) and
      // the walker emitted them in that order, whatever order they were declared in.
      let min: number | undefined;
      let max: number | undefined;
      let exact: number | undefined;
      for (const c of checkDefs(schema)) {
        if (c.check === "min_length") min = c.minimum;
        else if (c.check === "max_length") max = c.maximum;
        else if (c.check === "length_equals") exact = c.length;
        else throw new UnsupportedZodType(`ZodArray check '${c.check}'`, path);
      }
      if (min !== undefined) out.minItems = min;
      if (max !== undefined) out.maxItems = max;
      if (exact !== undefined) {
        out.minItems = exact;
        out.maxItems = exact;
      }
      return withDescription(out, desc());
    }
    case "object": {
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, sub] of Object.entries(d.shape ?? {})) {
        properties[key] = zodToJsonSchema(sub, path ? `${path}.${key}` : key);
        if (!isOptionalOnWire(sub)) required.push(key);
      }
      const out: JsonSchema = { type: "object", properties };
      if (required.length > 0) out.required = required;
      // `.strict()` (a `never` catchall) refuses unknown keys; the default strips
      // them and `.loose()` / `.passthrough()` (an `unknown` catchall) keeps them. Only strict is
      // a wire-level constraint.
      const catchall = d.catchall ? def(d.catchall).type : undefined;
      if (catchall === "never") out.additionalProperties = false;
      else if (d.catchall && catchall !== "unknown") {
        out.additionalProperties = zodToJsonSchema(d.catchall, `${path}.*`);
      }
      return withDescription(out, desc());
    }
    case "record": {
      const out: JsonSchema = {
        type: "object",
        additionalProperties: zodToJsonSchema(d.valueType as ZodType, `${path}.*`),
      };
      return withDescription(out, desc());
    }
    case "union": {
      const out: JsonSchema = {
        anyOf: (d.options ?? []).map((o, i) => zodToJsonSchema(o, `${path}|${i}`)),
      };
      return withDescription(out, desc());
    }
    case "optional":
      return withDescription(zodToJsonSchema(d.innerType as ZodType, path), desc());
    case "nullable": {
      const inner = zodToJsonSchema(d.innerType as ZodType, path);
      const out: JsonSchema = Array.isArray(inner.anyOf)
        ? { anyOf: [...(inner.anyOf as JsonSchema[]), { type: "null" }] }
        : { anyOf: [inner, { type: "null" }] };
      return withDescription(out, desc());
    }
    case "default":
    case "prefault": {
      const inner = zodToJsonSchema(d.innerType as ZodType, path);
      inner.default = d.defaultValue;
      return withDescription(inner, desc());
    }
    case "catch": {
      // An invalid value is replaced by the fallback rather than rejected: the wire
      // shape is the inner type; note the forgiving behaviour.
      const inner = zodToJsonSchema(d.innerType as ZodType, path);
      return withDescription(
        appendNote(inner, "An invalid value falls back to the default instead of being rejected."),
        desc(),
      );
    }
    case "pipe": {
      // `.transform(fn)` = pipe(source, transform): the wire value is the source.
      if (isTransform(d.out)) {
        return withDescription(zodToJsonSchema(d.in as ZodType, path), desc());
      }
      // `z.preprocess(fn, target)` = pipe(transform, target): rendered as the target.
      if (isTransform(d.in)) {
        return withDescription(zodToJsonSchema(d.out as ZodType, path), desc());
      }
      throw new UnsupportedZodType("ZodPipeline", path);
    }
    default:
      throw new UnsupportedZodType(zod3TypeName(d.type), path);
  }
}

/** True when the key may be absent from the request (optional or defaulted). */
function isOptionalOnWire(schema: ZodType): boolean {
  const d = def(schema);
  switch (d.type) {
    case "optional":
    case "default":
    case "prefault":
      return true;
    case "catch":
    case "nullable":
      return isOptionalOnWire(d.innerType as ZodType);
    case "pipe":
      // A transform is optional when its source is; a preprocess when its target is.
      if (isTransform(d.out)) return isOptionalOnWire(d.in as ZodType);
      if (isTransform(d.in)) return isOptionalOnWire(d.out as ZodType);
      return schema.isOptional();
    default: {
      // A refined schema is optional when the schema it refines is.
      const base = refinementCount(schema) > 0 ? unrefined(schema) : schema;
      if (base !== undefined && base !== schema) return isOptionalOnWire(base);
      return schema.isOptional();
    }
  }
}
