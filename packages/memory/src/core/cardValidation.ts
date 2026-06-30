/**
 * Card Validation — deterministic gates for file card trust levels.
 *
 * Two independent gates (see plan §card-validation):
 *
 *   validateMechanical — sets card_status. Checks facts about the file on
 *     disk: path exists, content_hash matches, loc within tolerance, source
 *     inside allowed read roots, no secret/generated patterns (with an
 *     escape hatch for central contracts like GraphQL schemas and Prisma
 *     clients). Mechanical fields are served whenever card_status = 'active'.
 *
 *   validateModel — sets model_status. Language-aware symbol verification
 *     (NOT naive substring). Per-file-type extractors for TS/JS, Python,
 *     SQL migrations; unsupported types are accepted but flagged at lower
 *     confidence. Also checks tldr length cap and no secret-looking text.
 *     Model fields (tldr / role_*) are served ONLY when model_status = 'active'.
 *
 * Failure in either gate is NOT a reason to discard the card — it sets the
 * appropriate status field and records validation_error so the caller can
 * surface a warning. The trust-split serving rule (in fileCards.ts) handles
 * what gets returned to the agent.
 *
 * ISOLATION: no imports from dispatch or crew.
 */
import { createHash } from "node:crypto";

import type { CardStatus, ModelStatus } from "../db/types.js";

// ── Constants ─────────────────────────────────────────────────────────

const LOC_TOLERANCE_FRACTION = 0.1; // 10% tolerance for line-count drift
const LOC_TOLERANCE_MIN_DELTA = 5; // always allow ≤ 5 line diff
const TLDR_MAX_CHARS = 500;

/**
 * Path fragments that indicate a file contains secrets or credentials.
 * Cards for these paths are excluded by default (card_status = 'shadow').
 * Callers can pass generated_include_patterns to re-include specific paths
 * that look like secrets but are actually central contracts.
 */
const SECRET_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\.env(\.|$)/i,
  /\bsecrets?\b/i,
  /\bcredentials?\b/i,
  /\bpassword/i,
  /\bprivate[-_]key/i,
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
];

/**
 * Patterns that indicate a file is generated code — excluded by default
 * to avoid cards that go stale immediately after a regen.
 * The generated_include_patterns escape hatch lets callers re-include
 * specific paths (e.g. Prisma client, GraphQL schema, OpenAPI bindings,
 * protobuf output, route manifests).
 */
const GENERATED_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\.generated\./i,
  /\bgenerated\b/i,
  // Match node_modules / dist / build / .next / out whether the path is
  // absolute (/repo/node_modules/…) or relative (node_modules/…).
  /(?:^|\/)node_modules\//,
  /(?:^|\/)dist\//,
  /(?:^|\/)build\//,
  /(?:^|\/)\.next\//,
  /(?:^|\/)out\//,
];

/**
 * Escape-hatch patterns: generated-looking paths that are actually central
 * contracts we WANT to card. These override GENERATED_PATH_PATTERNS when
 * the caller has not provided custom generated_include_patterns.
 */
const DEFAULT_GENERATED_INCLUDE_PATTERNS: ReadonlyArray<RegExp> = [
  /prisma\/.*\.ts$/i,
  /schema\.graphql$/i,
  /openapi\.(ya?ml|json)$/i,
  /\.proto$/i,
  /route[-_]manifest/i,
];

// ── Mechanical validation ─────────────────────────────────────────────

export interface MechanicalValidationInput {
  readonly path: string;
  readonly contentHash: string;
  readonly loc: number;
  readonly source: string;
  readonly fileContent: string | null;
  /** Allowed source root paths. If empty, source check is skipped. */
  readonly readRoots?: ReadonlyArray<string>;
  /**
   * Optional escape-hatch patterns for generated files that represent
   * central contracts (GraphQL schemas, Prisma clients, OpenAPI specs,
   * protobuf output, route manifests). Paths matching any of these are
   * NOT excluded by the generated-file filter even if they match
   * GENERATED_PATH_PATTERNS. Falls back to DEFAULT_GENERATED_INCLUDE_PATTERNS
   * when not provided.
   */
  readonly generatedIncludePatterns?: ReadonlyArray<RegExp>;
}

export interface MechanicalValidationResult {
  readonly cardStatus: CardStatus;
  readonly reasons: ReadonlyArray<string>;
}

/**
 * Validate the mechanical (factual) fields of a card. Returns the
 * card_status that should be written back to the row, plus a list of
 * reasons so the caller knows which checks failed.
 *
 * A card is 'active' only when ALL checks pass. Any single failure →
 * 'shadow'. The only exception is content_hash mismatch, which sets
 * 'stale' (the file exists and is readable, just changed since the card
 * was written — worth keeping for search but marked stale).
 *
 * fileContent being null means the caller could not read the file (e.g.
 * permission error or the path doesn't exist). That maps directly to a
 * 'shadow' status with a "path not readable" reason.
 */
export function validateMechanical(card: MechanicalValidationInput): MechanicalValidationResult {
  const reasons: string[] = [];
  let cardStatus: CardStatus = "active";

  const includePatterns = card.generatedIncludePatterns ?? DEFAULT_GENERATED_INCLUDE_PATTERNS;

  // 1. Secret path check — always shadow, no escape hatch.
  const isSecretPath = SECRET_PATH_PATTERNS.some((re) => re.test(card.path));
  if (isSecretPath) {
    reasons.push("path matches secret/credential pattern");
    return { cardStatus: "shadow", reasons };
  }

  // 2. Generated file check — shadow unless covered by include patterns.
  const isGeneratedPath = GENERATED_PATH_PATTERNS.some((re) => re.test(card.path));
  if (isGeneratedPath) {
    const isIncluded = includePatterns.some((re) => re.test(card.path));
    if (!isIncluded) {
      reasons.push(
        "path matches generated-code pattern (add to generatedIncludePatterns to override)",
      );
      return { cardStatus: "shadow", reasons };
    }
    // Included → treat as a normal file; continue other checks.
  }

  // 3. Path/content readability.
  if (card.fileContent === null) {
    reasons.push("file content not readable (path may not exist or permission denied)");
    return { cardStatus: "shadow", reasons };
  }

  // 4. source inside readRoots (skip when readRoots is empty — callers opt in).
  const readRoots = card.readRoots ?? [];
  if (readRoots.length > 0) {
    const inRoot = readRoots.some(
      (root) => card.source.startsWith(root) || card.path.startsWith(root),
    );
    if (!inRoot) {
      reasons.push(
        `source '${card.source}' is outside allowed read roots [${readRoots.join(", ")}]`,
      );
      cardStatus = "shadow";
    }
  }

  // 5. content_hash check — mismatch → stale (not shadow; the file is
  //    still valid, just different from when the card was written).
  const actualHash = sha256(card.fileContent);
  if (actualHash !== card.contentHash) {
    reasons.push(
      `content_hash mismatch: card has ${card.contentHash.slice(0, 8)}…, file is ${actualHash.slice(0, 8)}…`,
    );
    // Stale overrides active but doesn't override shadow.
    if (cardStatus === "active") cardStatus = "stale";
  }

  // 6. loc tolerance check.
  const actualLoc = countLines(card.fileContent);
  const delta = Math.abs(actualLoc - card.loc);
  const tolerance = Math.max(
    LOC_TOLERANCE_MIN_DELTA,
    Math.floor(card.loc * LOC_TOLERANCE_FRACTION),
  );
  if (delta > tolerance) {
    reasons.push(
      `loc mismatch: card claims ${card.loc} lines, file has ${actualLoc} (delta ${delta} > tolerance ${tolerance})`,
    );
    if (cardStatus === "active") cardStatus = "stale";
  }

  return { cardStatus, reasons };
}

// ── Model validation ──────────────────────────────────────────────────

export interface ModelValidationInput {
  readonly path: string;
  readonly tldr: string | null | undefined;
  readonly rolePrimary: string | null | undefined;
  readonly roleTags: ReadonlyArray<string> | null | undefined;
  /** The claimed exported symbols from the card row. */
  readonly symbols: ReadonlyArray<string>;
  /** The actual file content to extract symbols from. */
  readonly fileContent: string;
}

export interface ModelValidationResult {
  readonly modelStatus: ModelStatus;
  readonly validationError: string | null;
}

/**
 * Validate the model-generated summary fields. Returns the model_status
 * that should be written back to the row, plus validation_error text.
 *
 * Gates (all must pass for model_status = 'active'):
 *   1. tldr within character cap.
 *   2. tldr contains no secret-looking text.
 *   3. Language-aware symbol verification: claimed symbols actually appear
 *      in the extracted symbol set for the file type (TS/JS, Python, SQL
 *      migrations). Unsupported file types pass with lower confidence
 *      (model_status stays active but a note is added).
 *
 * The symbol check uses per-file-type extractors — NOT naive substring —
 * to handle aliased exports, anonymous handlers, and default-export
 * component names. A missing symbol drops the card to 'failed_validation'.
 */
export function validateModel(card: ModelValidationInput): ModelValidationResult {
  // 1. tldr length cap.
  if (card.tldr && card.tldr.length > TLDR_MAX_CHARS) {
    return {
      modelStatus: "failed_validation",
      validationError: `tldr exceeds ${TLDR_MAX_CHARS} character cap (got ${card.tldr.length})`,
    };
  }

  // 2. Secret-looking text in tldr.
  if (card.tldr && containsSecretLookingText(card.tldr)) {
    return {
      modelStatus: "failed_validation",
      validationError: "tldr contains secret-looking text (token matching a key/secret pattern)",
    };
  }

  // 3. Language-aware symbol verification.
  if (card.symbols.length > 0) {
    const fileType = detectFileType(card.path);
    const symbolCheck = verifySymbols(card.symbols, card.fileContent, fileType);
    if (!symbolCheck.pass) {
      return {
        modelStatus: "failed_validation",
        validationError: symbolCheck.error,
      };
    }
  }

  return { modelStatus: "active", validationError: null };
}

// ── Internal helpers ──────────────────────────────────────────────────

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Mechanically extract the structural symbol set for a file (exports, classes,
 * functions, SQL schema objects, …) using the same per-file-type extractors
 * the model-validation gate uses. Exposed so the card WRITER (onboard) and the
 * VALIDATOR agree on exactly the same symbol set — there is then no
 * cross-extractor mismatch that could spuriously fail a card's symbol check.
 * Returns a sorted, de-duplicated array. Unsupported file types yield [].
 */
export function extractFileSymbols(path: string, content: string): string[] {
  return [...extractSymbols(content, detectFileType(path))].sort();
}

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") count++;
  }
  return count;
}

/**
 * Heuristic: does the string contain what looks like a secret?
 * Checks for high-entropy base64 blobs, API key prefixes, and common
 * credential patterns. Deliberately conservative — false positives are
 * acceptable (the card is just flagged, not deleted).
 */
function containsSecretLookingText(text: string): boolean {
  // Known API key prefixes (common providers).
  const keyPrefixes =
    /\b(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|xox[bpoas]-[0-9a-zA-Z-]{20,}|AIza[0-9A-Za-z_-]{30,})\b/;
  if (keyPrefixes.test(text)) return true;

  // High-entropy alphanumeric strings (≥ 32 chars, mixed case + digits).
  // Avoids flagging normal English prose.
  const highEntropy = /[A-Za-z0-9+/]{32,}={0,2}/;
  if (highEntropy.test(text)) {
    // Extra heuristic: real secrets are usually long and contain digits.
    const match = text.match(/[A-Za-z0-9+/]{32,}/);
    if (match) {
      const s = match[0]!;
      const hasDigits = /\d/.test(s);
      const hasLower = /[a-z]/.test(s);
      const hasUpper = /[A-Z]/.test(s);
      if (hasDigits && hasLower && hasUpper) return true;
    }
  }

  return false;
}

type FileType = "typescript" | "javascript" | "python" | "sql-migration" | "other";

function detectFileType(path: string): FileType {
  const p = path.toLowerCase();
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript";
  if (p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".mjs") || p.endsWith(".cjs"))
    return "javascript";
  if (p.endsWith(".py")) return "python";
  // SQL migration heuristic: ends in .sql and path contains a migration marker.
  if (p.endsWith(".sql") && /migrations?/i.test(path)) return "sql-migration";
  return "other";
}

interface SymbolCheckResult {
  readonly pass: boolean;
  readonly error: string;
}

/**
 * Language-aware symbol verification. Extracts the set of defined names
 * from the file content using a per-type extractor, then checks that each
 * claimed symbol either appears in the extracted set OR is plausibly an
 * aliased export / default-export component / anonymous handler that the
 * simple extractor wouldn't catch.
 *
 * A missing symbol drops the entire card to 'failed_validation' so the
 * model can't claim a function exists that doesn't. For unsupported file
 * types we accept the symbols with a pass (no evidence to falsify).
 */
function verifySymbols(
  claimed: ReadonlyArray<string>,
  content: string,
  fileType: FileType,
): SymbolCheckResult {
  if (fileType === "other") {
    // No extractor — accept but can't verify.
    return { pass: true, error: "" };
  }

  const extracted = extractSymbols(content, fileType);
  const missing: string[] = [];

  for (const sym of claimed) {
    if (sym.trim() === "") continue;
    if (isSymbolPresent(sym, extracted, content)) continue;
    missing.push(sym);
  }

  if (missing.length > 0) {
    return {
      pass: false,
      error: `symbol(s) not found in file: ${missing.join(", ")} (extractor: ${fileType})`,
    };
  }

  return { pass: true, error: "" };
}

/**
 * Check if a claimed symbol is "present" in the file. We use the extracted
 * set as the primary signal, but also accept symbols that appear as aliased
 * re-exports, default export component names, or anonymous handler labels
 * that the regex extractor misses.
 *
 * The fallback to content.includes() is deliberately narrow: we only use
 * it after the extracted-set check fails, and only for the exact symbol
 * string (quoted, preceded by boundary chars). This avoids false positives
 * from comments or string literals.
 */
function isSymbolPresent(sym: string, extracted: ReadonlySet<string>, content: string): boolean {
  if (extracted.has(sym)) return true;

  // Aliased re-export: `export { foo as Bar }` — Bar is the public name.
  const aliasRe = new RegExp(`\\bas\\s+${escapeRegex(sym)}\\b`);
  if (aliasRe.test(content)) return true;

  // Default export component: `export default function ComponentName` or
  // `export default class ClassName`.
  const defaultRe = new RegExp(`export\\s+default\\s+(?:function|class)\\s+${escapeRegex(sym)}\\b`);
  if (defaultRe.test(content)) return true;

  // Route/handler label: `app.get('/foo', handlerName)` style.
  // Accept symbols that appear as an identifier followed by a ( or , or ).
  const handlerRe = new RegExp(`\\b${escapeRegex(sym)}\\s*[,(]`);
  if (handlerRe.test(content)) return true;

  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract defined symbol names from file content. Returns a Set so
 * lookups are O(1). Each extractor is purposefully narrow — it catches the
 * common structural patterns, not every edge case. The isSymbolPresent
 * fallbacks handle the edge cases (aliases, default exports, etc.).
 */
function extractSymbols(content: string, fileType: FileType): ReadonlySet<string> {
  switch (fileType) {
    case "typescript":
    case "javascript":
      return extractTsJsSymbols(content);
    case "python":
      return extractPythonSymbols(content);
    case "sql-migration":
      return extractSqlMigrationSymbols(content);
    default:
      return new Set<string>();
  }
}

/**
 * TypeScript / JavaScript symbol extractor. Captures:
 *   - `export function foo` / `export async function foo`
 *   - `export class Foo`
 *   - `export const foo` / `export let foo` / `export var foo`
 *   - `export type Foo` / `export interface Foo` / `export enum Foo`
 *   - `function foo` (top-level, not exported — for internal reference)
 *   - `class Foo` (top-level, not exported)
 *   - `const foo =` / `let foo =` (simple assignments at top level)
 *   - Named route identifiers in Express-style: `router.get`, `app.post`, etc.
 */
function extractTsJsSymbols(content: string): ReadonlySet<string> {
  const syms = new Set<string>();

  // Named exports: function, async function, class, const, let, var, type,
  // interface, enum. Capture the identifier after the keyword.
  const exportPattern =
    /export\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+|const\s+|let\s+|var\s+|type\s+|interface\s+|enum\s+)([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let m: RegExpExecArray | null;
  while ((m = exportPattern.exec(content)) !== null) {
    if (m[1]) syms.add(m[1]);
  }

  // Re-exports: `export { foo, bar as Baz }` — add the local names and
  // the aliased public names.
  const reExportPattern = /export\s*\{([^}]+)\}/g;
  while ((m = reExportPattern.exec(content)) !== null) {
    const inner = m[1] ?? "";
    for (const part of inner.split(",")) {
      const trimmed = part.trim();
      // Either `name` or `name as alias` — add both.
      const asParts = trimmed.split(/\s+as\s+/);
      for (const p of asParts) {
        const name = p.trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) syms.add(name);
      }
    }
  }

  // Top-level function/class (not necessarily exported).
  const funcClassPattern =
    /^(?:async\s+)?(?:function\s*\*?\s*|class\s+)([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  while ((m = funcClassPattern.exec(content)) !== null) {
    if (m[1]) syms.add(m[1]);
  }

  // Simple top-level const/let/var assignments.
  const varPattern = /^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  while ((m = varPattern.exec(content)) !== null) {
    if (m[1]) syms.add(m[1]);
  }

  return syms;
}

/**
 * Python symbol extractor. Captures:
 *   - `def foo(` — top-level function definitions
 *   - `class Foo(` or `class Foo:` — class definitions
 *   - `async def foo(` — async functions
 */
function extractPythonSymbols(content: string): ReadonlySet<string> {
  const syms = new Set<string>();
  const pattern = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    if (m[1]) syms.add(m[1]);
  }
  return syms;
}

/**
 * SQL migration symbol extractor. Captures:
 *   - `CREATE TABLE foo` / `CREATE TABLE IF NOT EXISTS foo`
 *   - `ALTER TABLE foo`
 *   - `CREATE INDEX foo` / `CREATE UNIQUE INDEX foo`
 *   - `CREATE VIEW foo`
 *   - `CREATE FUNCTION foo` / `CREATE PROCEDURE foo`
 *
 * These become the "symbols" for a migration file — the schema objects
 * the migration touches.
 */
function extractSqlMigrationSymbols(content: string): ReadonlySet<string> {
  const syms = new Set<string>();
  const pattern =
    /(?:CREATE(?:\s+(?:UNIQUE|OR\s+REPLACE|TEMP(?:ORARY)?))?\s+(?:TABLE(?:\s+IF\s+NOT\s+EXISTS)?|INDEX(?:\s+IF\s+NOT\s+EXISTS)?|VIEW|FUNCTION|PROCEDURE)|ALTER\s+TABLE)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    if (m[1]) syms.add(m[1].toLowerCase());
  }
  return syms;
}
