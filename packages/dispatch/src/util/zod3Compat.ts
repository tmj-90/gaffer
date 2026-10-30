import { z, globalRegistry, type ZodType } from "zod";

/**
 * zod 3 compatibility for a codebase that now runs zod 4.
 *
 * This module exists twice, byte-identical: packages/dispatch/src/util/zod3Compat.ts
 * and packages/memory/src/util/zod3Compat.ts (memory does not depend on dispatch).
 * Dispatch's test/zod3-compat.test.ts fails when the two drift.
 *
 * The zod 4 migration must not move anything a client, an agent or an operator
 * sees. Three things would have moved:
 *
 *  1. Validation errors. zod 4 rewrote the default messages ("Required" became
 *     "Invalid input: expected string, received undefined"), renamed issue codes
 *     (invalid_enum_value / invalid_literal → invalid_value, invalid_string →
 *     invalid_format) and fields (`type` → `origin`, `options` → `values`, no
 *     `received`), and a length check now also reports on a value whose type
 *     already failed (an array sent for a `.min(1)` string fails twice).
 *     {@link zod3ErrorMap} — installed as zod's global error map on import —
 *     gives every default-message issue its zod 3 code, fields and message, and
 *     {@link toZod3Issues} does the same for issues that carry their own message,
 *     drops the doubled length issue and renders unions the zod 3 way. Every
 *     place that hands `issues` to a client or prints them goes through it.
 *
 *  2. MCP tool input schemas. The SDK renders a zod 3 schema with
 *     zod-to-json-schema and a zod 4 one with zod's own `toJSONSchema()`, which
 *     differ (no `additionalProperties: false` on a stripping object, safe-integer
 *     bounds on every `.int()`, a different key order). {@link mcpToolInput}
 *     wraps a tool's argument shape so the SDK publishes exactly what it did on
 *     zod 3 ({@link zod3JsonSchema} reproduces zod-to-json-schema for the
 *     constructs the tools use) and validates with zod 3's issues, in the order
 *     zod 3's async parse (the SDK's) raised them.
 *
 *  3. Descriptions on the OpenAPI document — see api/openapi/zodJsonSchema.ts,
 *     which shares {@link zod3Description} with (2).
 */

// --- zod 4 internals this module reads ---------------------------------------

/** The slice of a zod 4 check / schema definition read here. */
interface DefLike {
  type?: string;
  check?: string;
  format?: string;
  pattern?: RegExp;
  coerce?: boolean;
  checks?: ReadonlyArray<{ _zod: { def: DefLike } }>;
  innerType?: ZodType;
  element?: ZodType;
  keyType?: ZodType;
  valueType?: ZodType;
  options?: ReadonlyArray<ZodType>;
  entries?: Record<string, string | number>;
  values?: ReadonlyArray<unknown>;
  shape?: Record<string, ZodType>;
  catchall?: ZodType;
  defaultValue?: unknown;
  in?: ZodType;
  out?: ZodType;
  minimum?: number;
  maximum?: number;
  length?: number;
  value?: number;
  inclusive?: boolean;
}

interface Internals {
  def: DefLike;
  parent?: ZodType;
  toJSONSchema?: () => unknown;
  run: (payload: { issues: unknown[] }, ctx: unknown) => unknown;
}

function internals(schema: ZodType): Internals {
  return (schema as unknown as { _zod: Internals })._zod;
}

export function zodDef(schema: ZodType): DefLike {
  return internals(schema).def;
}

export function checkDefs(schema: ZodType): DefLike[] {
  return (zodDef(schema).checks ?? []).map((c) => c._zod.def);
}

/** Refinements (`.refine()` / `.superRefine()`) are `custom` checks in zod 4. */
export function refinementCount(schema: ZodType): number {
  return checkDefs(schema).filter((c) => c.check === "custom").length;
}

export function isTransform(schema: ZodType | undefined): boolean {
  return schema !== undefined && zodDef(schema).type === "transform";
}

/** The schema before its first refinement: walk back the `.check()` clone chain. */
export function unrefined(schema: ZodType): ZodType | undefined {
  let s: ZodType | undefined = schema;
  while (s && refinementCount(s) > 0) s = internals(s).parent;
  return s;
}

/**
 * The description zod 3 kept on the equivalent schema's own def. A refined schema
 * was a `ZodEffects`, described only by a `.describe()` AFTER the last refinement
 * (the clones since the last check); the wrappers (optional / nullable / default /
 * catch / transform) copied the wrapped schema's description when they were made;
 * everything else is the registry's description.
 */
export function zod3Description(schema: ZodType): string | undefined {
  if (refinementCount(schema) > 0) {
    const checks = zodDef(schema).checks?.length ?? 0;
    for (let s: ZodType | undefined = schema; s; s = internals(s).parent) {
      if ((zodDef(s).checks?.length ?? 0) !== checks) break;
      const own = globalRegistry._map.get(s)?.description;
      if (own !== undefined) return own;
    }
    return undefined;
  }
  const own = schema.description;
  if (own !== undefined) return own;
  const d = zodDef(schema);
  switch (d.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
      return zod3Description(d.innerType as ZodType);
    case "pipe":
      // `.transform()` copied the source's description; `z.preprocess()` did not.
      return isTransform(d.out) ? zod3Description(d.in as ZodType) : undefined;
    default:
      return undefined;
  }
}

// --- 1. Validation issues ------------------------------------------------------

/** A validation issue as zod 3 reported it (`code`, the code's fields, `path`, `message`). */
export type Zod3Issue = { code: string; path: PropertyKey[]; message: string } & Record<
  string,
  unknown
>;

type Fields = Record<string, unknown>;

/** zod 3's ZodParsedType of a value — the `received` of an invalid_type issue. */
export function zod3ParsedType(data: unknown): string {
  switch (typeof data) {
    case "undefined":
      return "undefined";
    case "string":
      return "string";
    case "number":
      return Number.isNaN(data) ? "nan" : "number";
    case "boolean":
      return "boolean";
    case "function":
      return "function";
    case "bigint":
      return "bigint";
    case "symbol":
      return "symbol";
    default: {
      if (Array.isArray(data)) return "array";
      if (data === null) return "null";
      const o = data as { then?: unknown; catch?: unknown };
      if (typeof o.then === "function" && typeof o.catch === "function") return "promise";
      if (data instanceof Map) return "map";
      if (data instanceof Set) return "set";
      if (data instanceof Date) return "date";
      return "object";
    }
  }
}

function joinValues(values: readonly unknown[], separator = " | "): string {
  return values.map((v) => (typeof v === "string" ? `'${v}'` : v)).join(separator);
}

/** zod 3's default message for a zod 3 issue (zod 3's `locales/en`). */
export function zod3DefaultMessage(issue: Fields): string {
  const num = (k: string): unknown => issue[k];
  switch (issue.code) {
    case "invalid_type":
      return issue.received === "undefined"
        ? "Required"
        : `Expected ${String(issue.expected)}, received ${String(issue.received)}`;
    case "invalid_literal":
      return `Invalid literal value, expected ${JSON.stringify(issue.expected, (_k, v: unknown) =>
        typeof v === "bigint" ? v.toString() : v,
      )}`;
    case "unrecognized_keys":
      return `Unrecognized key(s) in object: ${joinValues(issue.keys as unknown[], ", ")}`;
    case "invalid_union":
      return "Invalid input";
    case "invalid_union_discriminator":
      return `Invalid discriminator value. Expected ${joinValues(issue.options as unknown[])}`;
    case "invalid_enum_value":
      return `Invalid enum value. Expected ${joinValues(issue.options as unknown[])}, received '${String(issue.received)}'`;
    case "invalid_date":
      return "Invalid date";
    case "invalid_string": {
      const v = issue.validation;
      if (typeof v === "object" && v !== null) {
        const o = v as {
          includes?: string;
          position?: number;
          startsWith?: string;
          endsWith?: string;
        };
        if ("includes" in o) {
          const m = `Invalid input: must include "${o.includes}"`;
          return typeof o.position === "number"
            ? `${m} at one or more positions greater than or equal to ${o.position}`
            : m;
        }
        if ("startsWith" in o) return `Invalid input: must start with "${o.startsWith}"`;
        if ("endsWith" in o) return `Invalid input: must end with "${o.endsWith}"`;
        return "Invalid input";
      }
      return v !== "regex" ? `Invalid ${String(v)}` : "Invalid";
    }
    case "too_small": {
      const exact = issue.exact === true;
      const incl = issue.inclusive === true;
      const min = num("minimum");
      switch (issue.type) {
        case "array":
          return `Array must contain ${exact ? "exactly" : incl ? "at least" : "more than"} ${String(min)} element(s)`;
        case "string":
          return `String must contain ${exact ? "exactly" : incl ? "at least" : "over"} ${String(min)} character(s)`;
        case "number":
        case "bigint":
          return `Number must be ${exact ? "exactly equal to " : incl ? "greater than or equal to " : "greater than "}${String(min)}`;
        case "date":
          return `Date must be ${exact ? "exactly equal to " : incl ? "greater than or equal to " : "greater than "}${String(new Date(Number(min)))}`;
        default:
          return "Invalid input";
      }
    }
    case "too_big": {
      const exact = issue.exact === true;
      const incl = issue.inclusive === true;
      const max = num("maximum");
      switch (issue.type) {
        case "array":
          return `Array must contain ${exact ? "exactly" : incl ? "at most" : "less than"} ${String(max)} element(s)`;
        case "string":
          return `String must contain ${exact ? "exactly" : incl ? "at most" : "under"} ${String(max)} character(s)`;
        case "number":
          return `Number must be ${exact ? "exactly" : incl ? "less than or equal to" : "less than"} ${String(max)}`;
        case "bigint":
          return `BigInt must be ${exact ? "exactly" : incl ? "less than or equal to" : "less than"} ${String(max)}`;
        case "date":
          return `Date must be ${exact ? "exactly" : incl ? "smaller than or equal to" : "smaller than"} ${String(new Date(Number(max)))}`;
        default:
          return "Invalid input";
      }
    }
    case "custom":
      return "Invalid input";
    case "invalid_intersection_types":
      return "Intersection results could not be merged";
    case "not_multiple_of":
      return `Number must be a multiple of ${String(issue.multipleOf)}`;
    case "not_finite":
      return "Number must be finite";
    default:
      return "Invalid input";
  }
}

/**
 * A zod 3 issue's fields in zod 3's key order. `messageFirst`: zod 3 built this
 * code's issue with a `message` key, so the message sits before `path`.
 */
interface Zod3Shape {
  fields: Fields;
  messageFirst: boolean;
}

/** zod 4 `invalid_format` formats → zod 3 `invalid_string` validations. */
const FORMAT_VALIDATION: Record<string, string> = {
  regex: "regex",
  url: "url",
  email: "email",
  uuid: "uuid",
  guid: "uuid",
  datetime: "datetime",
  date: "date",
  time: "time",
  duration: "duration",
  ipv4: "ip",
  ipv6: "ip",
  cidrv4: "cidr",
  cidrv6: "cidr",
  base64: "base64",
  base64url: "base64url",
  jwt: "jwt",
  nanoid: "nanoid",
  cuid: "cuid",
  cuid2: "cuid2",
  ulid: "ulid",
  emoji: "emoji",
};
/** zod 3 put `code` before `validation` for these; the rest had `validation` first. */
const CODE_FIRST_VALIDATIONS = new Set(["datetime", "date", "time"]);

/** zod 4's `expected` type names that zod 3 spelled differently. */
const EXPECTED_V3: Record<string, string> = { record: "object", tuple: "array", int: "integer" };

interface RawContext {
  /** The value that failed — known in the error map, not after zod finalises the issue. */
  hasInput: boolean;
  input?: unknown;
  /** The schema or check that raised the issue (error map only). */
  inst?: { _zod?: { def?: DefLike } } | undefined;
}

function sizeType(origin: unknown): unknown {
  return origin === "int" ? "number" : origin;
}

/**
 * The zod 3 form of one zod 4 issue (raw, in the error map, or finalised), or
 * `undefined` when zod 3 had no equivalent (the issue is then left as zod 4 has it).
 */
function zod3Shape(iss: Fields, ctx: RawContext): Zod3Shape | undefined {
  const received = (): unknown => {
    if (ctx.hasInput) return zod3ParsedType(ctx.input);
    if (iss.received === "NaN") return "nan";
    return iss.received;
  };
  const instDef = ctx.inst?._zod?.def;
  switch (iss.code) {
    case "invalid_type": {
      if ("received" in iss && !("origin" in iss) && !("format" in iss) && iss.received !== "NaN") {
        return undefined; // already zod 3
      }
      // `.int()` — zod 3: "Expected integer, received float".
      if (iss.expected === "int" || iss.format === "safeint") {
        return {
          fields: { code: "invalid_type", expected: "integer", received: "float" },
          messageFirst: true,
        };
      }
      // zod 4 rejects ±Infinity as a number; zod 3 took it and failed `.int()` or
      // `.finite()` on it.
      if (
        iss.expected === "number" &&
        ctx.hasInput &&
        typeof ctx.input === "number" &&
        !Number.isNaN(ctx.input) &&
        !Number.isFinite(ctx.input)
      ) {
        const intFormat = (instDef?.checks ?? []).some((c) => c._zod.def.format === "safeint");
        return intFormat
          ? {
              fields: { code: "invalid_type", expected: "integer", received: "float" },
              messageFirst: true,
            }
          : { fields: { code: "not_finite" }, messageFirst: true };
      }
      const expected = EXPECTED_V3[String(iss.expected)] ?? iss.expected;
      const fields: Fields = { code: "invalid_type", expected };
      const r = received();
      if (r !== undefined) fields.received = r;
      return { fields, messageFirst: false };
    }
    case "invalid_value": {
      const values = (iss.values as unknown[] | undefined) ?? [];
      if (instDef?.type === "literal") {
        return {
          fields: {
            received: ctx.input,
            code: "invalid_literal",
            expected: values.length === 1 ? values[0] : values,
          },
          messageFirst: false,
        };
      }
      // An enum (or an unknown source, treated as one).
      const stringEnum = values.every((v) => typeof v === "string");
      if (ctx.hasInput) {
        const t = typeof ctx.input;
        const typeOk = stringEnum ? t === "string" : t === "string" || t === "number";
        if (!typeOk) {
          return {
            fields: { expected: joinValues(values), received: received(), code: "invalid_type" },
            messageFirst: false,
          };
        }
      }
      return {
        fields: { received: ctx.input, code: "invalid_enum_value", options: values },
        messageFirst: false,
      };
    }
    case "too_small":
    case "too_big": {
      if (!("origin" in iss)) return undefined; // already zod 3
      const bound = iss.code === "too_small" ? "minimum" : "maximum";
      return {
        fields: {
          code: iss.code,
          [bound]: iss[bound],
          type: sizeType(iss.origin),
          inclusive: iss.inclusive === true,
          exact: iss.exact === true,
        },
        messageFirst: true,
      };
    }
    case "invalid_format": {
      const format = String(iss.format);
      let validation: unknown = FORMAT_VALIDATION[format];
      if (format === "starts_with") validation = { startsWith: iss.prefix };
      else if (format === "ends_with") validation = { endsWith: iss.suffix };
      else if (format === "includes") validation = { includes: iss.includes };
      if (validation === undefined) validation = format;
      const codeFirst =
        typeof validation === "object" || CODE_FIRST_VALIDATIONS.has(String(validation));
      return {
        fields: codeFirst
          ? { code: "invalid_string", validation }
          : { validation, code: "invalid_string" },
        messageFirst: true,
      };
    }
    case "unrecognized_keys":
      return { fields: { code: "unrecognized_keys", keys: iss.keys }, messageFirst: false };
    case "invalid_union": {
      if (!("errors" in iss)) return undefined; // already zod 3
      const base = (iss.path as PropertyKey[] | undefined) ?? [];
      const unionErrors = (iss.errors as Fields[][]).map((issues) => ({
        issues: toZod3Issues(issues).map((i) => ({ ...i, path: [...base, ...i.path] })),
        name: "ZodError",
      }));
      return { fields: { code: "invalid_union", unionErrors }, messageFirst: false };
    }
    case "custom": {
      const fields: Fields = { code: "custom" };
      if ("params" in iss) fields.params = iss.params;
      return { fields, messageFirst: true };
    }
    case "not_multiple_of":
      return {
        fields: { code: "not_multiple_of", multipleOf: iss.divisor ?? iss.multipleOf },
        messageFirst: true,
      };
    default:
      return undefined;
  }
}

/** Raw-issue keys zod itself owns and strips while finalising. */
const ZOD_OWNED = new Set(["inst", "input", "schema", "continue"]);

/**
 * zod's global error map (installed on import): gives a default-message issue its
 * zod 3 code, fields and message. It rewrites the raw issue in place — zod copies
 * the raw issue's keys into the reported one right after asking for the message —
 * because the failing value (zod 3's `received`) is only available here.
 */
export function zod3ErrorMap(iss: Fields): string | undefined {
  const shape = zod3Shape(iss, {
    hasInput: true,
    input: iss.input,
    inst: iss.inst as RawContext["inst"],
  });
  if (!shape) return undefined;
  const path = iss.path;
  for (const k of Object.keys(iss)) if (!ZOD_OWNED.has(k)) delete iss[k];
  Object.assign(iss, shape.fields);
  if (shape.messageFirst) iss.message = undefined; // keeps zod 3's key order; zod sets it
  if (path !== undefined) iss.path = path;
  return zod3DefaultMessage(shape.fields);
}

let installed = false;
/** Install {@link zod3ErrorMap} as zod's global error map (idempotent). */
export function installZod3ErrorMap(): void {
  if (installed) return;
  installed = true;
  z.config({ customError: zod3ErrorMap as unknown as z.core.$ZodErrorMap });
}
installZod3ErrorMap();

function pathKey(path: unknown): string {
  return JSON.stringify((Array.isArray(path) ? path : []).map((p: unknown) => String(p)));
}

/**
 * zod 3 stopped at a value whose type failed; zod 4 still runs its length checks
 * when the value has a `length` (an array for a string, a string for an array),
 * so the same path fails twice. Drop the size issue a type failure shadows.
 */
export function dropShadowedIssues<T extends { code?: unknown; path?: unknown }>(issues: T[]): T[] {
  const typeFailed = new Set<string>();
  return issues.filter((iss) => {
    const key = pathKey(iss.path);
    if (iss.code === "invalid_type") {
      typeFailed.add(key);
      return true;
    }
    return !((iss.code === "too_small" || iss.code === "too_big") && typeFailed.has(key));
  });
}

/**
 * zod 3 abandoned a value at a type-level failure ("aborted") and kept going past a
 * check failure ("dirty"). `.int()` was a check in zod 3 (a type in zod 4).
 */
function isAborting(iss: Fields): boolean {
  switch (iss.code) {
    case "invalid_type":
      return !(iss.expected === "integer" && iss.received === "float");
    case "invalid_enum_value":
    case "invalid_literal":
    case "invalid_value":
    case "invalid_union":
    case "invalid_union_discriminator":
    case "invalid_date":
      return true;
    default:
      return false;
  }
}

/**
 * zod 3 reported a failed union as the issues of its first option that was only
 * dirty, when there was one; zod 4 does so only when exactly one option is not
 * aborted (and `.int()` aborts). The option to report instead of the union issue.
 */
function dirtyOption(
  options: ReadonlyArray<ReadonlyArray<Fields>>,
): ReadonlyArray<Fields> | undefined {
  return options.find((o) => o.length > 0 && !o.some(isAborting));
}

function withPathPrefix(prefix: unknown, iss: Fields): Fields {
  const base = Array.isArray(prefix) ? (prefix as PropertyKey[]) : [];
  if (base.length === 0) return iss;
  return { ...iss, path: [...base, ...((iss.path as PropertyKey[] | undefined) ?? [])] };
}

/**
 * zod's raw issues for a whole parse, as zod 3 would have raised them: the union
 * rule above (on raw issues, whose union options — `errors` — are already
 * finalised with paths relative to the union), no doubled length issue, and — for
 * an async parse, which is how the MCP SDK validates tool arguments — zod 3's
 * async order. zod 3 resolved refinements and unions on later microtasks, so
 * their issues followed every plain one (unions after refinements); zod 4 keeps
 * them in key order.
 */
function zod3RawIssues(issues: Fields[], async: boolean): Fields[] {
  const tagged: Array<{ iss: Fields; delay: number }> = [];
  for (const iss of issues) {
    if (iss.code === "invalid_union") {
      const dirty = Array.isArray(iss.errors) ? dirtyOption(iss.errors as Fields[][]) : undefined;
      if (dirty) for (const d of dirty) tagged.push({ iss: withPathPrefix(iss.path, d), delay: 2 });
      else tagged.push({ iss, delay: 2 });
      continue;
    }
    tagged.push({ iss, delay: iss.code === "custom" ? 1 : 0 });
  }
  // Array.prototype.sort is stable: equal delays keep zod's (key) order.
  if (async) tagged.sort((a, b) => a.delay - b.delay);
  return dropShadowedIssues(tagged.map((t) => t.iss));
}

function toZod3Issue(iss: Fields): Zod3Issue {
  const shape = zod3Shape(iss, { hasInput: false });
  const path = (iss.path as PropertyKey[] | undefined) ?? [];
  const message = typeof iss.message === "string" ? iss.message : "";
  if (!shape) {
    // Already zod 3 (rewritten by the error map), or nothing zod 3 had.
    return { ...iss, path, message } as Zod3Issue;
  }
  const out: Fields = { ...shape.fields };
  if (shape.messageFirst) out.message = message;
  out.path = path;
  out.message = message;
  return out as Zod3Issue;
}

/**
 * The issues of a zod 4 error as zod 3 reported them: codes, fields, key order,
 * messages, and which issues there were. Issues the global error map already
 * rewrote pass through; issues that carry their own message (`.min(1, "…")`,
 * `.refine(fn, "…")`) are reshaped here. Use this wherever `issues` reach a client
 * or a log.
 */
export function toZod3Issues(issues: ReadonlyArray<unknown>): Zod3Issue[] {
  const out: Zod3Issue[] = [];
  for (const raw of issues as Fields[]) {
    const iss = toZod3Issue(raw);
    if (iss.code === "invalid_union" && Array.isArray(iss.unionErrors)) {
      const options = (iss.unionErrors as Array<{ issues: Fields[] }>).map((e) => e.issues);
      const dirty = dirtyOption(options);
      if (dirty) {
        out.push(...toZod3Issues(dirty));
        continue;
      }
    }
    out.push(iss);
  }
  return dropShadowedIssues(out);
}

// --- 2. MCP tool input schemas ----------------------------------------------------

type Json = Record<string, unknown>;

interface Refs {
  currentPath: string[];
  propertyPath?: string[] | undefined;
  seen: Map<ZodType, string[]>;
}

function safeIsOptional(schema: ZodType): boolean {
  try {
    return schema.isOptional();
  } catch {
    return true;
  }
}

/** zod 3 type names zod-to-json-schema squashes into a `type` list in a union / nullable. */
const PRIMITIVE: Record<string, string> = {
  string: "string",
  number: "number",
  bigint: "integer",
  boolean: "boolean",
  null: "null",
};

/** A zod 3 primitive without checks (refined schemas were ZodEffects, not primitives). */
function uncheckedPrimitive(schema: ZodType): string | undefined {
  const d = zodDef(schema);
  const t = PRIMITIVE[d.type ?? ""];
  if (!t || (d.checks?.length ?? 0) > 0 || d.format !== undefined) return undefined;
  return t;
}

const INT_FORMATS = new Set(["safeint", "int32", "uint32"]);

function addFormat(res: Json, value: string): void {
  if (res.format || (Array.isArray(res.anyOf) && (res.anyOf as Json[]).some((x) => x.format))) {
    if (!Array.isArray(res.anyOf)) res.anyOf = [];
    const anyOf = res.anyOf as Json[];
    if (res.format) {
      anyOf.push({ format: res.format });
      delete res.format;
    }
    anyOf.push({ format: value });
  } else {
    res.format = value;
  }
}

function addPattern(res: Json, source: string): void {
  if (res.pattern || (Array.isArray(res.allOf) && (res.allOf as Json[]).some((x) => x.pattern))) {
    if (!Array.isArray(res.allOf)) res.allOf = [];
    const allOf = res.allOf as Json[];
    if (res.pattern) {
      allOf.push({ pattern: res.pattern });
      delete res.pattern;
    }
    allOf.push({ pattern: source });
  } else {
    res.pattern = source;
  }
}

const STRING_FORMATS: Record<string, string> = {
  url: "uri",
  email: "email",
  uuid: "uuid",
  datetime: "date-time",
  date: "date",
  time: "time",
  duration: "duration",
};

function parseString(schema: ZodType): Json {
  const d = zodDef(schema);
  const res: Json = { type: "string" };
  const own: DefLike[] = d.format ? [{ check: "string_format", format: d.format }] : [];
  for (const c of [...own, ...checkDefs(schema)]) {
    switch (c.check) {
      case "min_length":
        res.minLength =
          typeof res.minLength === "number" ? Math.max(res.minLength, c.minimum ?? 0) : c.minimum;
        break;
      case "max_length":
        res.maxLength =
          typeof res.maxLength === "number" ? Math.min(res.maxLength, c.maximum ?? 0) : c.maximum;
        break;
      case "length_equals":
        res.minLength =
          typeof res.minLength === "number" ? Math.max(res.minLength, c.length ?? 0) : c.length;
        res.maxLength =
          typeof res.maxLength === "number" ? Math.min(res.maxLength, c.length ?? 0) : c.length;
        break;
      case "string_format": {
        if (c.format === "regex") {
          if (c.pattern) addPattern(res, c.pattern.source);
          break;
        }
        const f = STRING_FORMATS[c.format ?? ""];
        if (f) addFormat(res, f);
        break;
      }
      default:
        // trim / toLowerCase / toUpperCase (overwrite) and the rest: no keyword.
        break;
    }
  }
  return res;
}

function parseNumber(schema: ZodType): Json {
  const d = zodDef(schema);
  const res: Json = { type: "number" };
  const own: DefLike[] = d.format ? [{ check: "number_format", format: d.format }] : [];
  for (const c of [...own, ...checkDefs(schema)]) {
    switch (c.check) {
      case "number_format":
        if (INT_FORMATS.has(c.format ?? "")) res.type = "integer";
        break;
      case "greater_than":
        if (c.inclusive) res.minimum = c.value;
        else res.exclusiveMinimum = c.value;
        break;
      case "less_than":
        if (c.inclusive) res.maximum = c.value;
        else res.exclusiveMaximum = c.value;
        break;
      case "multiple_of":
        res.multipleOf = c.value;
        break;
      default:
        break;
    }
  }
  return res;
}

function parseUnion(schema: ZodType, refs: Refs): Json | undefined {
  const options = zodDef(schema).options ?? [];
  const prims = options.map(uncheckedPrimitive);
  if (prims.every((t) => t !== undefined)) {
    const types = prims.filter((t, i) => prims.indexOf(t) === i);
    return { type: types.length > 1 ? types : types[0] };
  }
  const isLiteral = (o: ZodType): boolean =>
    zodDef(o).type === "literal" && refinementCount(o) === 0 && !zod3Description(o);
  if (options.every(isLiteral)) {
    const vals = options.map((o) => (zodDef(o).values ?? [])[0]);
    const types: string[] = [];
    for (const v of vals) {
      const t = typeof v;
      if (t === "string" || t === "number" || t === "boolean") types.push(t);
      else if (t === "bigint") types.push("integer");
      else if (v === null) types.push("null");
    }
    if (types.length === options.length) {
      const unique = types.filter((t, i) => types.indexOf(t) === i);
      return {
        type: unique.length > 1 ? unique : unique[0],
        enum: vals.filter((v, i) => vals.indexOf(v) === i),
      };
    }
  } else if (options.every((o) => zodDef(o).type === "enum" && refinementCount(o) === 0)) {
    const all: unknown[] = [];
    for (const o of options) {
      for (const v of Object.values(zodDef(o).entries ?? {})) if (!all.includes(v)) all.push(v);
    }
    return { type: "string", enum: all };
  }
  const anyOf = options
    .map((o, i) => parseDef(o, { ...refs, currentPath: [...refs.currentPath, "anyOf", `${i}`] }))
    .filter((x): x is Json => !!x && Object.keys(x).length > 0);
  return anyOf.length ? { anyOf } : undefined;
}

function parseObject(schema: ZodType, refs: Refs): Json {
  const d = zodDef(schema);
  const result: Json = { type: "object", properties: {} };
  const properties = result.properties as Json;
  const required: string[] = [];
  for (const [name, prop] of Object.entries(d.shape ?? {})) {
    const path = [...refs.currentPath, "properties", name];
    const parsed = parseDef(prop, { ...refs, currentPath: path, propertyPath: path });
    if (parsed === undefined) continue;
    properties[name] = parsed;
    if (!safeIsOptional(prop)) required.push(name);
  }
  if (required.length) result.required = required;
  // zod-to-json-schema: strip and strict → false, passthrough → true, else the catchall.
  const catchall = d.catchall ? zodDef(d.catchall).type : undefined;
  if (catchall === undefined || catchall === "never") result.additionalProperties = false;
  else if (catchall === "unknown") result.additionalProperties = true;
  else {
    result.additionalProperties = parseDef(d.catchall as ZodType, {
      ...refs,
      currentPath: [...refs.currentPath, "additionalProperties"],
    });
  }
  return result;
}

function parseEnum(schema: ZodType): Json {
  const values = Object.values(zodDef(schema).entries ?? {});
  if (values.every((v) => typeof v === "string")) return { type: "string", enum: values };
  const types = Array.from(new Set(values.map((v) => typeof v)));
  return {
    type: types.length === 1 ? (types[0] === "string" ? "string" : "number") : ["string", "number"],
    enum: values,
  };
}

/** The zod-to-json-schema parser for one (unrefined) schema. */
function select(schema: ZodType, refs: Refs): Json | undefined {
  const d = zodDef(schema);
  switch (d.type) {
    case "string":
      return parseString(schema);
    case "number":
      return parseNumber(schema);
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "unknown":
    case "any":
      return {};
    case "never":
      return { not: {} };
    case "literal": {
      const values = d.values ?? [];
      if (values.length !== 1) return fallback(schema);
      const value = values[0];
      const t = typeof value;
      if (t !== "bigint" && t !== "number" && t !== "boolean" && t !== "string") {
        return { type: Array.isArray(value) ? "array" : "object" };
      }
      return { type: t === "bigint" ? "integer" : t, const: value };
    }
    case "enum":
      return parseEnum(schema);
    case "array": {
      const res: Json = { type: "array" };
      const element = d.element as ZodType;
      if (zodDef(element).type !== "any") {
        res.items = parseDef(element, { ...refs, currentPath: [...refs.currentPath, "items"] });
      }
      let min: number | undefined;
      let max: number | undefined;
      let exact: number | undefined;
      for (const c of checkDefs(schema)) {
        if (c.check === "min_length") min = c.minimum;
        else if (c.check === "max_length") max = c.maximum;
        else if (c.check === "length_equals") exact = c.length;
      }
      if (min !== undefined) res.minItems = min;
      if (max !== undefined) res.maxItems = max;
      if (exact !== undefined) {
        res.minItems = exact;
        res.maxItems = exact;
      }
      return res;
    }
    case "object":
      return parseObject(schema, refs);
    case "record": {
      const res: Json = {
        type: "object",
        additionalProperties:
          parseDef(d.valueType as ZodType, {
            ...refs,
            currentPath: [...refs.currentPath, "additionalProperties"],
          }) ?? true,
      };
      const key = d.keyType;
      if (key && zodDef(key).type === "enum") {
        return { ...res, propertyNames: { enum: Object.values(zodDef(key).entries ?? {}) } };
      }
      if (key && zodDef(key).type === "string" && (zodDef(key).checks?.length ?? 0) > 0) {
        const { type: _t, ...keyType } = parseString(key);
        return { ...res, propertyNames: keyType };
      }
      return res;
    }
    case "union":
      return parseUnion(schema, refs);
    case "optional": {
      const inner = d.innerType as ZodType;
      if (refs.currentPath.toString() === refs.propertyPath?.toString()) {
        return parseDef(inner, refs);
      }
      const innerSchema = parseDef(inner, {
        ...refs,
        currentPath: [...refs.currentPath, "anyOf", "1"],
      });
      return innerSchema ? { anyOf: [{ not: {} }, innerSchema] } : {};
    }
    case "nullable": {
      const inner = d.innerType as ZodType;
      const prim = uncheckedPrimitive(inner);
      if (prim) return { type: [prim, "null"] };
      const base = parseDef(inner, { ...refs, currentPath: [...refs.currentPath, "anyOf", "0"] });
      return base && { anyOf: [base, { type: "null" }] };
    }
    case "default":
    case "prefault":
      return { ...parseDef(d.innerType as ZodType, refs), default: d.defaultValue };
    case "catch":
    case "readonly":
      return parseDef(d.innerType as ZodType, refs);
    case "pipe":
      // `.transform()` / a pipeline: the input side; `z.preprocess()`: its target.
      return parseDef((isTransform(d.in) ? d.out : d.in) as ZodType, refs);
    default:
      return fallback(schema);
  }
}

/** A construct zod-to-json-schema-on-zod-3 never saw: zod 4's own rendering. */
function fallback(schema: ZodType): Json {
  const { $schema: _s, ...rest } = z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
  }) as Json;
  return rest;
}

function parseDef(schema: ZodType, refs: Refs): Json | undefined {
  const seen = refs.seen.get(schema);
  if (seen) return { $ref: seen.join("/") };
  refs.seen.set(schema, refs.currentPath);
  // A refinement was a ZodEffects: rendered as the schema it refines.
  const base = refinementCount(schema) > 0 ? unrefined(schema) : schema;
  let json: Json | undefined;
  if (base === undefined) json = fallback(schema);
  else if (base !== schema) json = parseDef(base, refs);
  else json = select(schema, refs);
  const description = zod3Description(schema);
  if (json && description) json.description = description;
  return json;
}

/**
 * A zod 4 schema rendered exactly as zod-to-json-schema rendered its zod 3
 * equivalent with the MCP SDK's options (draft-07, `$ref` to the first use of a
 * repeated schema, refinements and transforms as their input). Without `$schema`.
 */
export function zod3JsonSchema(schema: ZodType): Json {
  return parseDef(schema, { currentPath: ["#"], seen: new Map() }) ?? {};
}

/**
 * zod's `toJSONSchema()` starts its result with `$schema` and copies the override's
 * keys after it; zod-to-json-schema appended `$schema` last. A `toJSON` key is copied
 * along and puts `$schema` back at the end whenever the result is serialised (zod
 * itself JSON round-trips it, and so does the transport), so tools/list is
 * byte-identical to the zod 3 SDK's.
 */
function withSchemaKeyLast(json: Json): Json {
  json.toJSON = function toJSON(this: Json): Json {
    const { $schema, toJSON: _toJSON, ...rest } = this;
    return $schema === undefined ? rest : { ...rest, $schema };
  };
  return json;
}

/**
 * The `inputSchema` to register an MCP tool's argument shape with. The SDK turns a
 * raw shape into a zod 4 object and renders it with zod's `toJSONSchema()`; this
 * returns that object with zod's per-schema `toJSONSchema` override set to the zod 3
 * rendering (so tools/list is unchanged), and validating with zod 3's issues (no
 * doubled length issue, a union reported as its dirty option). An empty shape keeps zod 4's rendering: the SDK built that one
 * with zod 4 (mini) on zod 3 as well.
 */
export function mcpToolInput<S extends z.ZodRawShape>(shape: S): z.ZodObject<S> {
  const schema = z.object(shape);
  if (Object.keys(shape).length === 0) return schema;
  const zod = internals(schema);
  zod.toJSONSchema = () => withSchemaKeyLast(zod3JsonSchema(schema));
  const run = zod.run;
  zod.run = (payload, ctx) => {
    const async = (ctx as { async?: boolean } | undefined)?.async === true;
    const fix = (p: { issues: unknown[] }): { issues: unknown[] } => {
      if (p.issues.length > 0) p.issues = zod3RawIssues(p.issues as Fields[], async);
      return p;
    };
    const result = run(payload, ctx) as { issues: unknown[] } | Promise<{ issues: unknown[] }>;
    return result instanceof Promise ? result.then(fix) : fix(result);
  };
  return schema;
}
