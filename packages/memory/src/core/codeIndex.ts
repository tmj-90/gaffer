/**
 * CODE INDEX: files -> top-level symbols -> imports -> tests, for one repo.
 *
 * A small, deterministic structural map built from the TEXT of each TypeScript, JavaScript
 * and Python file: no parser, no model, no new dependency. It answers "which files import
 * this symbol, and which tests import that module" for the review's Behavioural surface and
 * the delivery's file cards. Every answer is labelled "by import text (index)" and is a
 * LOWER BOUND: a dynamic import, an alias the repo does not declare, a call through an
 * object, or a language the index does not read is not seen.
 *
 * Tables (migration 016-code-index): code_index_file (path, content hash), code_symbol,
 * code_import (the raw import text), code_ref (imports resolved to repo paths, DERIVED),
 * code_test_link (DERIVED: test -> module, by import or by file name), code_index_alias
 * (workspace package names, tsconfig paths) and code_index_build (one row per repo).
 *
 * Incremental: a file whose content hash is unchanged is not re-extracted; with a known
 * previous commit only the files `git diff --name-status -M` names are looked at. The
 * derived tables are rebuilt from the stored raw imports on every build (SQL + memory,
 * no file reads), so an added or renamed file re-resolves every import that names it.
 *
 * ISOLATION: no imports from dispatch or crew.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

import type { Database } from "better-sqlite3";

export const INDEX_METHOD = "by import text (index)" as const;

/** Bounds: a repo past these is indexed partially and the build record says which cap hit. */
export const INDEX_MAX_FILES_DEFAULT = 5000;
export const INDEX_MAX_BYTES_PER_FILE_DEFAULT = 512 * 1024;
/** Re-export barrels followed when looking for a symbol's importers. */
const MAX_BARREL_DEPTH = 3;
/** Definitions of one bare symbol name reported before the rest are counted. */
const MAX_DEFINITIONS = 3;

export type IndexLang = "ts" | "js" | "py";

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "third_party",
  "generated",
  "__generated__",
  "coverage",
  "__pycache__",
  "venv",
  "site-packages",
  "bower_components",
  "jspm_packages",
]);
const GENERATED_FILE =
  /\.min\.[cm]?js$|\.generated\.[^/]+$|\.bundle\.[cm]?js$|_pb2(?:_grpc)?\.py$|\.d\.[cm]?ts$/;
const TEST_PATH =
  /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.py$|(?:^|\/)conftest\.py$/;
const JS_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];

export function indexLang(path: string): IndexLang | null {
  const p = path.toLowerCase();
  if (/\.d\.[cm]?ts$/.test(p)) return null;
  if (/\.(?:ts|tsx|mts|cts)$/.test(p)) return "ts";
  if (/\.(?:js|jsx|mjs|cjs)$/.test(p)) return "js";
  if (p.endsWith(".py")) return "py";
  return null;
}

export function isIndexTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// ── Extraction ────────────────────────────────────────────────────────

export interface ExtractedSymbol {
  name: string;
  /** function | class | const | let | var | type | interface | enum | namespace | default | reexport | def | export */
  kind: string;
  line: number;
  /** The name other modules import it by ("default" for a default export), or null. */
  exportedAs: string | null;
}

export interface ExtractedImport {
  specifier: string;
  /** import | reexport | require | dynamic | from | import_module */
  kind: string;
  /**
   * Imported source names: an identifier, "default", "*" (a namespace or whole-module
   * import), or "a as b" for a re-export alias. Empty for a side-effect import.
   */
  names: string[];
  line: number;
}

export interface Extracted {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
}

/** 1-based line of a character offset. */
function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
function lineStarts(content: string): number[] {
  const out = [0];
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** The names a `{ a, b as c, type T }` list imports (source side) or exports. */
function braceEntries(inner: string): Array<{ name: string; alias: string | null }> {
  const out: Array<{ name: string; alias: string | null }> = [];
  for (const raw of inner.split(",")) {
    const t = raw
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "")
      .trim()
      .replace(/^type\s+/, "");
    if (!t) continue;
    const parts = t.split(/\s+as\s+/);
    const name = parts[0]!.trim();
    const alias = parts[1]?.trim() ?? null;
    if (!IDENT.test(name) && name !== "default") continue;
    out.push({ name, alias: alias && (IDENT.test(alias) || alias === "default") ? alias : null });
  }
  return out;
}

/** What an ES import clause (`X`, `X, { a }`, `* as ns`, `{ a as b }`) imports. */
function importClauseNames(clause: string): string[] {
  const names: string[] = [];
  const brace = clause.match(/\{([\s\S]*)\}/);
  if (brace) for (const e of braceEntries(brace[1]!)) names.push(e.name);
  const rest = clause.replace(/\{[\s\S]*\}/, "").trim();
  for (const part of rest.split(",")) {
    const p = part.trim();
    if (!p) continue;
    if (/^\*\s*as\s+[A-Za-z_$][\w$]*$/.test(p)) names.push("*");
    else if (IDENT.test(p)) names.push("default");
  }
  return [...new Set(names)];
}

function extractJs(content: string): Extracted {
  const starts = lineStarts(content);
  const at = (i: number) => lineAt(starts, i);
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const byName = new Map<string, ExtractedSymbol>();
  const addSym = (s: ExtractedSymbol) => {
    const prev = byName.get(s.name);
    if (prev) {
      if (!prev.exportedAs && s.exportedAs) prev.exportedAs = s.exportedAs;
      return;
    }
    byName.set(s.name, s);
    symbols.push(s);
  };
  let m: RegExpExecArray | null;

  // Exported declarations (column 0, so a nested `export` in a namespace is not one).
  // A declaration keyword needs whitespace after it (so `classify(` is not `class ify`),
  // except a generator's `function*`.
  const KW =
    "(?:(function)\\s*\\*\\s*|(function|class|const|let|var|interface|type|enum|namespace)\\s+)";
  const exportDecl = new RegExp(
    `^export\\s+(?:declare\\s+)?(default\\s+)?(?:async\\s+)?(?:abstract\\s+)?${KW}([A-Za-z_$][\\w$]*)`,
    "gm",
  );
  while ((m = exportDecl.exec(content)) !== null) {
    const kind = m[2] ?? m[3]!;
    addSym({ name: m[4]!, kind, line: at(m.index), exportedAs: m[1] ? "default" : m[4]! });
  }
  // Top-level declarations that are not exported (column 0).
  const localDecl = new RegExp(
    `^(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?${KW}([A-Za-z_$][\\w$]*)`,
    "gm",
  );
  while ((m = localDecl.exec(content)) !== null)
    addSym({ name: m[3]!, kind: m[1] ?? m[2]!, line: at(m.index), exportedAs: null });
  // An anonymous default export, or `export default someName` (declared anywhere above or below).
  const exportDefault =
    /^export\s+default\s+(?!(?:async\s+)?(?:abstract\s+)?(?:function|class)\s*\*?\s*[A-Za-z_$])([A-Za-z_$][\w$]*)?/gm;
  while ((m = exportDefault.exec(content)) !== null) {
    const local = m[1] && !/^(?:function|class|async|abstract|new)$/.test(m[1]) ? m[1] : null;
    if (local && byName.has(local)) byName.get(local)!.exportedAs ??= "default";
    else addSym({ name: "default", kind: "default", line: at(m.index), exportedAs: "default" });
  }

  // ES imports (multi-line clauses allowed; a clause never holds a quote or a semicolon).
  const esImport = /^[ \t]*import\s+(?:type\s+)?([^;'"`]*?)\s*from\s*['"]([^'"\n]+)['"]/gm;
  while ((m = esImport.exec(content)) !== null)
    imports.push({
      specifier: m[2]!,
      kind: "import",
      names: importClauseNames(m[1]!),
      line: at(m.index),
    });
  const sideEffect = /^[ \t]*import\s*['"]([^'"\n]+)['"]/gm;
  while ((m = sideEffect.exec(content)) !== null)
    imports.push({ specifier: m[1]!, kind: "import", names: [], line: at(m.index) });
  // Re-exports: `export { a, b as c } from './x'`, `export * from`, `export * as ns from`.
  const reExport =
    /^export\s+(?:type\s+)?(\*(?:\s*as\s+([A-Za-z_$][\w$]*))?|\{([^}]*)\})\s*from\s*['"]([^'"\n]+)['"]/gm;
  while ((m = reExport.exec(content)) !== null) {
    const line = at(m.index);
    if (m[3] !== undefined) {
      const entries = braceEntries(m[3]);
      imports.push({
        specifier: m[4]!,
        kind: "reexport",
        names: entries.map((e) =>
          e.alias && e.alias !== e.name ? `${e.name} as ${e.alias}` : e.name,
        ),
        line,
      });
      for (const e of entries)
        addSym({ name: e.alias ?? e.name, kind: "reexport", line, exportedAs: e.alias ?? e.name });
    } else if (m[2]) {
      imports.push({ specifier: m[4]!, kind: "import", names: ["*"], line });
      addSym({ name: m[2], kind: "reexport", line, exportedAs: m[2] });
    } else {
      imports.push({ specifier: m[4]!, kind: "reexport", names: ["*"], line });
    }
  }
  // A local export list `export { a, b as c }` (no `from`) marks local declarations.
  const exportList = /^export\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/gm;
  while ((m = exportList.exec(content)) !== null) {
    const line = at(m.index);
    for (const e of braceEntries(m[1]!)) {
      const local = byName.get(e.name);
      if (local) local.exportedAs ??= e.alias ?? e.name;
      else addSym({ name: e.alias ?? e.name, kind: "export", line, exportedAs: e.alias ?? e.name });
    }
  }
  // CommonJS: require (destructured names or the whole module), exports.
  const req =
    /(?:\b(?:const|let|var)\s*(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*)?\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  while ((m = req.exec(content)) !== null) {
    const lhs = m[1];
    const names = lhs?.startsWith("{")
      ? braceEntries(lhs.slice(1, -1).replace(/:\s*[A-Za-z_$][\w$]*/g, "")).map((e) => e.name)
      : ["*"];
    imports.push({ specifier: m[2]!, kind: "require", names, line: at(m.index) });
  }
  const dyn = /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g;
  while ((m = dyn.exec(content)) !== null)
    imports.push({ specifier: m[1]!, kind: "dynamic", names: ["*"], line: at(m.index) });
  const cjsNamed = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/gm;
  while ((m = cjsNamed.exec(content)) !== null) {
    const local = byName.get(m[1]!);
    if (local) local.exportedAs ??= m[1]!;
    else addSym({ name: m[1]!, kind: "export", line: at(m.index), exportedAs: m[1]! });
  }
  const cjsObject = /^module\.exports\s*=\s*\{([^}]*)\}/gm;
  while ((m = cjsObject.exec(content)) !== null) {
    const line = at(m.index);
    for (const part of m[1]!.split(",")) {
      const key = part.split(":")[0]!.trim();
      if (!IDENT.test(key)) continue;
      const local = byName.get(key);
      if (local) local.exportedAs ??= key;
      else addSym({ name: key, kind: "export", line, exportedAs: key });
    }
  }
  const cjsWhole = /^module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?\s*$/gm;
  while ((m = cjsWhole.exec(content)) !== null) {
    const local = byName.get(m[1]!);
    if (local) local.exportedAs ??= "default";
  }
  return { symbols, imports };
}

function extractPy(content: string): Extracted {
  const starts = lineStarts(content);
  const at = (i: number) => lineAt(starts, i);
  const symbols: ExtractedSymbol[] = [];
  const imports: ExtractedImport[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const decl = /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/gm;
  while ((m = decl.exec(content)) !== null) {
    if (seen.has(m[2]!)) continue;
    seen.add(m[2]!);
    symbols.push({
      name: m[2]!,
      kind: m[1]!,
      line: at(m.index),
      exportedAs: m[2]!.startsWith("_") ? null : m[2]!,
    });
  }
  const constant = /^([A-Z][A-Z0-9_]*)\s*(?::[^=\n]+)?=(?!=)/gm;
  while ((m = constant.exec(content)) !== null) {
    if (seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    symbols.push({ name: m[1]!, kind: "const", line: at(m.index), exportedAs: m[1]! });
  }
  const fromImport = /^[ \t]*from\s+(\.+[\w.]*|[A-Za-z_][\w.]*)\s+import\s+(\([^)]*\)|[^\n#;]+)/gm;
  while ((m = fromImport.exec(content)) !== null) {
    const names = m[2]!
      .replace(/[()\\]/g, " ")
      .split(",")
      .map((x) =>
        x
          .trim()
          .split(/\s+as\s+/)[0]!
          .trim(),
      )
      .filter((x) => x === "*" || /^[A-Za-z_]\w*$/.test(x));
    imports.push({ specifier: m[1]!, kind: "from", names, line: at(m.index) });
  }
  const plainImport =
    /^[ \t]*import\s+([A-Za-z_][\w.]*(?:\s+as\s+\w+)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s+as\s+\w+)?)*)/gm;
  while ((m = plainImport.exec(content)) !== null) {
    const line = at(m.index);
    for (const part of m[1]!.split(",")) {
      const mod = part
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim();
      if (mod) imports.push({ specifier: mod, kind: "import_module", names: ["*"], line });
    }
  }
  return { symbols, imports };
}

/** Extract one file's top-level symbols and import text. Unsupported languages yield nothing. */
export function extractCodeFacts(path: string, content: string): Extracted {
  const lang = indexLang(path);
  if (lang === "ts" || lang === "js") return extractJs(content);
  if (lang === "py") return extractPy(content);
  return { symbols: [], imports: [] };
}

// ── Aliases (workspace packages, tsconfig paths) ──────────────────────

export interface IndexAlias {
  sourcePath: string;
  alias: string;
  /** A repo-relative directory (package) or path pattern with one `*` (tsconfig). */
  target: string;
  kind: "package" | "tsconfig";
}

function stripJsonComments(text: string): string {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m, str) => str ?? "");
}

/** Aliases one package.json or tsconfig*.json declares (best effort; bad JSON yields none). */
export function extractAliases(path: string, content: string): IndexAlias[] {
  const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
  const b = posix.basename(path);
  let doc: unknown;
  try {
    doc = JSON.parse(stripJsonComments(content).replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return [];
  }
  if (!doc || typeof doc !== "object") return [];
  const o = doc as Record<string, unknown>;
  if (b === "package.json") {
    const name = typeof o["name"] === "string" ? o["name"] : "";
    if (!name || !/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) return [];
    return [{ sourcePath: path, alias: name, target: dir, kind: "package" }];
  }
  if (/^tsconfig[^/]*\.json$|^jsconfig\.json$/.test(b)) {
    const co = (o["compilerOptions"] ?? {}) as Record<string, unknown>;
    const base = typeof co["baseUrl"] === "string" ? co["baseUrl"] : ".";
    const paths = (co["paths"] ?? {}) as Record<string, unknown>;
    const out: IndexAlias[] = [];
    for (const [key, val] of Object.entries(paths)) {
      const first = Array.isArray(val) ? val.find((v) => typeof v === "string") : null;
      if (typeof first !== "string") continue;
      const target = posix.normalize(posix.join(dir, base, first)).replace(/^\.\//, "");
      if (target.startsWith("..")) continue;
      out.push({ sourcePath: path, alias: key, target, kind: "tsconfig" });
    }
    return out;
  }
  return [];
}

// ── Resolution ────────────────────────────────────────────────────────

/** Resolves import specifiers against the set of indexed paths and the repo's aliases. */
export class Resolver {
  private readonly pyModules = new Map<string, string[]>();
  private readonly packages: IndexAlias[];
  private readonly tsPaths: IndexAlias[];

  constructor(
    private readonly paths: ReadonlySet<string>,
    aliases: ReadonlyArray<IndexAlias>,
  ) {
    this.packages = aliases
      .filter((a) => a.kind === "package")
      .sort((a, b) => b.alias.length - a.alias.length);
    this.tsPaths = aliases
      .filter((a) => a.kind === "tsconfig")
      .sort((a, b) => b.alias.length - a.alias.length);
    for (const p of paths) {
      if (!p.endsWith(".py")) continue;
      const mod = p
        .replace(/\.py$/, "")
        .replace(/\/__init__$/, "")
        .split("/")
        .join(".");
      const list = this.pyModules.get(mod) ?? [];
      list.push(p);
      this.pyModules.set(mod, list);
    }
  }

  /** A repo path for `base` as a module: itself, with an extension, or its index file. */
  private jsFile(base: string): string | null {
    const b = base.replace(/\/+$/, "");
    if (this.paths.has(b) && indexLang(b)) return b;
    // ESM TypeScript imports name the emitted `.js`: `./x.js` is `./x.ts`.
    const m = b.match(/^(.*)\.([cm]?)js(x?)$/);
    if (m) {
      for (const ext of [`.${m[2]}ts${m[3]}`, ".ts", ".tsx"]) {
        if (this.paths.has(m[1] + ext)) return m[1] + ext;
      }
    }
    for (const ext of JS_EXTS) if (this.paths.has(b + ext)) return b + ext;
    for (const ext of JS_EXTS) if (this.paths.has(`${b}/index${ext}`)) return `${b}/index${ext}`;
    return null;
  }

  /** How a JS/TS specifier resolves: a repo path, external (a dependency), or unresolved. */
  resolveJs(
    from: string,
    spec: string,
  ): { to: string | null; how: "relative" | "alias" | "external" | "unresolved" } {
    if (spec.startsWith(".") || spec.startsWith("/")) {
      const base = spec.startsWith("/")
        ? spec.slice(1)
        : posix.normalize(posix.join(posix.dirname(from), spec));
      if (base.startsWith("..")) return { to: null, how: "unresolved" };
      const to = this.jsFile(base === "." ? "" : base);
      return { to, how: to ? "relative" : "unresolved" };
    }
    for (const a of this.tsPaths) {
      const star = a.alias.indexOf("*");
      let rest: string | null = null;
      if (star < 0) rest = spec === a.alias ? "" : null;
      else {
        const pre = a.alias.slice(0, star);
        const post = a.alias.slice(star + 1);
        if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length)
          rest = spec.slice(pre.length, spec.length - post.length);
      }
      if (rest === null) continue;
      const to = this.jsFile(a.target.replace("*", rest));
      if (to) return { to, how: "alias" };
    }
    for (const p of this.packages) {
      if (spec !== p.alias && !spec.startsWith(`${p.alias}/`)) continue;
      const sub = spec.slice(p.alias.length).replace(/^\//, "");
      const dir = p.target;
      const join2 = (...xs: string[]) => xs.filter(Boolean).join("/");
      const candidates = sub
        ? [join2(dir, "src", sub), join2(dir, sub)]
        : [join2(dir, "src", "index"), join2(dir, "index"), join2(dir, "src")];
      for (const c of candidates) {
        const to = this.jsFile(c);
        if (to) return { to, how: "alias" };
      }
      return { to: null, how: "unresolved" };
    }
    return { to: null, how: "external" };
  }

  /** The repo path of a dotted Python module (absolute), or null. */
  private pyModule(mod: string): string | null {
    const exact = this.pyModules.get(mod);
    if (exact && exact.length === 1) return exact[0]!;
    for (const root of ["src", "lib", "app"]) {
      const r = this.pyModules.get(`${root}.${mod}`);
      if (r && r.length === 1) return r[0]!;
    }
    // A package two or more segments deep may live under any source root: a unique suffix.
    if (mod.includes(".")) {
      const hits: string[] = [];
      for (const [k, v] of this.pyModules) if (k.endsWith(`.${mod}`)) hits.push(...v);
      if (hits.length === 1) return hits[0]!;
    }
    return null;
  }

  /** The dotted package a Python file is in (its directory). */
  private static pyPackage(from: string): string[] {
    const parts = from.split("/");
    parts.pop();
    return parts;
  }

  /**
   * Resolve one Python import: `from X import a, b` may name submodules of X as well as
   * symbols in it, so it can produce more than one edge.
   */
  resolvePy(
    from: string,
    imp: ExtractedImport,
  ): {
    edges: Array<{ to: string; names: string[] }>;
    how: "relative" | "alias" | "external" | "unresolved";
  } {
    const spec = imp.specifier;
    let modParts: string[] | null;
    let relative = false;
    if (spec.startsWith(".")) {
      relative = true;
      const dots = spec.match(/^\.+/)![0].length;
      const pkg = Resolver.pyPackage(from);
      if (dots - 1 > pkg.length) return { edges: [], how: "unresolved" };
      const baseParts = pkg.slice(0, pkg.length - (dots - 1));
      const rest = spec.slice(dots);
      modParts = rest ? [...baseParts, ...rest.split(".")] : baseParts;
    } else modParts = spec.split(".");
    const path = relative ? this.pathOfParts(modParts) : this.pyModule(modParts.join("."));
    const edges: Array<{ to: string; names: string[] }> = [];
    const symbolNames: string[] = [];
    if (imp.kind === "from") {
      for (const n of imp.names) {
        if (n === "*") {
          symbolNames.push("*");
          continue;
        }
        const sub = relative
          ? this.pathOfParts([...modParts, n])
          : this.pyModule([...modParts, n].join("."));
        if (sub && sub !== path) edges.push({ to: sub, names: ["*"] });
        else symbolNames.push(n);
      }
    } else symbolNames.push("*");
    if (path && symbolNames.length > 0) edges.push({ to: path, names: symbolNames });
    if (edges.length > 0) return { edges, how: relative ? "relative" : "alias" };
    return { edges: [], how: relative ? "unresolved" : "external" };
  }

  private pathOfParts(parts: string[]): string | null {
    const base = parts.join("/");
    if (this.paths.has(`${base}.py`)) return `${base}.py`;
    const init = base ? `${base}/__init__.py` : "__init__.py";
    return this.paths.has(init) ? init : null;
  }
}

// ── Storage ───────────────────────────────────────────────────────────

export interface IndexBuildStats {
  files: number;
  testFiles: number;
  symbols: number;
  exportedSymbols: number;
  imports: number;
  refs: number;
  unresolved: number;
  external: number;
  testLinks: number;
  modulesWithTests: number;
  languages: Record<string, number>;
  capsHit: string[];
  /** Files re-read and re-extracted in this build (the rest kept their rows by hash). */
  extracted: number;
  /** Files dropped in this build (deleted, renamed away, or no longer indexable). */
  removed: number;
  skippedGenerated: number;
}

export interface IndexBuildRecord {
  repoKey: string;
  repo: string;
  canonical: string | null;
  commit: string | null;
  builtAt: string;
  mode: "full" | "incremental" | "unchanged";
  stats: IndexBuildStats;
}

export function getIndexBuild(db: Database, repoKey: string): IndexBuildRecord | null {
  const row = db
    .prepare(
      "SELECT repo_key, repo, canonical, commit_sha, built_at, mode, stats FROM code_index_build WHERE repo_key = ?",
    )
    .get(repoKey) as
    | {
        repo_key: string;
        repo: string;
        canonical: string | null;
        commit_sha: string | null;
        built_at: string;
        mode: IndexBuildRecord["mode"];
        stats: string;
      }
    | undefined;
  if (!row) return null;
  let stats: IndexBuildStats;
  try {
    stats = JSON.parse(row.stats) as IndexBuildStats;
  } catch {
    return null;
  }
  return {
    repoKey: row.repo_key,
    repo: row.repo,
    canonical: row.canonical,
    commit: row.commit_sha,
    builtAt: row.built_at,
    mode: row.mode,
    stats,
  };
}

export function listIndexBuilds(db: Database): IndexBuildRecord[] {
  const keys = db
    .prepare("SELECT repo_key FROM code_index_build ORDER BY repo, repo_key")
    .all() as Array<{ repo_key: string }>;
  return keys
    .map((k) => getIndexBuild(db, k.repo_key))
    .filter((r): r is IndexBuildRecord => r !== null);
}

function deleteFileRows(db: Database, repoKey: string, path: string): void {
  db.prepare("DELETE FROM code_index_file WHERE repo_key = ? AND path = ?").run(repoKey, path);
  db.prepare("DELETE FROM code_symbol WHERE repo_key = ? AND path = ?").run(repoKey, path);
  db.prepare("DELETE FROM code_import WHERE repo_key = ? AND from_path = ?").run(repoKey, path);
}

function writeFileRows(
  db: Database,
  repoKey: string,
  path: string,
  hash: string,
  size: number,
  facts: Extracted,
  now: string,
): void {
  deleteFileRows(db, repoKey, path);
  db.prepare(
    "INSERT INTO code_index_file (repo_key, path, content_hash, lang, size, is_test, indexed_at) VALUES (?,?,?,?,?,?,?)",
  ).run(repoKey, path, hash, indexLang(path) ?? "other", size, isIndexTestPath(path) ? 1 : 0, now);
  const sym = db.prepare(
    "INSERT INTO code_symbol (repo_key, path, name, kind, line, exported_as) VALUES (?,?,?,?,?,?)",
  );
  for (const s of facts.symbols) sym.run(repoKey, path, s.name, s.kind, s.line, s.exportedAs);
  const imp = db.prepare(
    "INSERT INTO code_import (repo_key, from_path, specifier, kind, names, line) VALUES (?,?,?,?,?,?)",
  );
  for (const i of facts.imports)
    imp.run(repoKey, path, i.specifier, i.kind, JSON.stringify(i.names), i.line);
}

/** The stem a test file names: `foo.test.ts`, `test_foo.py`, `foo_test.py` → `foo`. */
function testStem(path: string): string {
  const b = posix.basename(path);
  // `board.helpers.test.ts` names `board.helpers`, never `board`: only the test suffix
  // (or, for a Python test, the extension) comes off.
  const js = b.replace(/\.(?:test|spec)\.[cm]?[jt]sx?$/, "");
  return (js !== b ? js : b.replace(/\.[^.]+$/, "")).replace(/^test_/, "").replace(/_test$/, "");
}
function moduleStem(path: string): string {
  return posix.basename(path).replace(/\.[^.]+$/, "");
}
const TEST_DIR_SEGMENT = /^(?:test|tests|__tests__|spec|specs|e2e)$/;

/** Rebuild code_ref and code_test_link for a repo from its stored raw imports. */
function rebuildDerived(
  db: Database,
  repoKey: string,
): {
  refs: number;
  unresolved: number;
  external: number;
  testLinks: number;
  modulesWithTests: number;
} {
  const files = db
    .prepare("SELECT path, is_test FROM code_index_file WHERE repo_key = ?")
    .all(repoKey) as Array<{ path: string; is_test: number }>;
  const pathSet = new Set(files.map((f) => f.path));
  const aliases = (
    db
      .prepare("SELECT source_path, alias, target, kind FROM code_index_alias WHERE repo_key = ?")
      .all(repoKey) as Array<{
      source_path: string;
      alias: string;
      target: string;
      kind: IndexAlias["kind"];
    }>
  ).map((a) => ({ sourcePath: a.source_path, alias: a.alias, target: a.target, kind: a.kind }));
  const resolver = new Resolver(pathSet, aliases);
  db.prepare("DELETE FROM code_ref WHERE repo_key = ?").run(repoKey);
  db.prepare("DELETE FROM code_test_link WHERE repo_key = ?").run(repoKey);
  const insRef = db.prepare(
    "INSERT INTO code_ref (repo_key, from_path, to_path, kind, names, line) VALUES (?,?,?,?,?,?)",
  );
  const insLink = db.prepare(
    "INSERT OR IGNORE INTO code_test_link (repo_key, test_path, target_path, via) VALUES (?,?,?,?)",
  );
  const isTest = new Map(files.map((f) => [f.path, f.is_test === 1]));
  let refs = 0;
  let unresolved = 0;
  let external = 0;
  const rows = db
    .prepare("SELECT from_path, specifier, kind, names, line FROM code_import WHERE repo_key = ?")
    .all(repoKey) as Array<{
    from_path: string;
    specifier: string;
    kind: string;
    names: string;
    line: number;
  }>;
  for (const r of rows) {
    let names: string[];
    try {
      names = JSON.parse(r.names) as string[];
    } catch {
      names = [];
    }
    const edges: Array<{ to: string; names: string[] }> = [];
    if (r.from_path.endsWith(".py")) {
      const res = resolver.resolvePy(r.from_path, {
        specifier: r.specifier,
        kind: r.kind,
        names,
        line: r.line,
      });
      if (res.edges.length === 0) {
        if (res.how === "unresolved") unresolved++;
        else external++;
      }
      edges.push(...res.edges);
    } else {
      const res = resolver.resolveJs(r.from_path, r.specifier);
      if (res.to) edges.push({ to: res.to, names });
      else if (res.how === "unresolved") unresolved++;
      else external++;
    }
    for (const e of edges) {
      if (e.to === r.from_path) continue;
      insRef.run(repoKey, r.from_path, e.to, r.kind, JSON.stringify(e.names), r.line);
      refs++;
      if (isTest.get(r.from_path) && !isTest.get(e.to))
        insLink.run(repoKey, r.from_path, e.to, "import");
    }
  }
  // By file name: a test whose stem names exactly one module (or one in its mirrored dir).
  const modulesByStem = new Map<string, string[]>();
  for (const f of files) {
    if (f.is_test) continue;
    const stem = moduleStem(f.path);
    if (stem === "index" || stem === "__init__" || stem === "main") continue;
    const list = modulesByStem.get(stem) ?? [];
    list.push(f.path);
    modulesByStem.set(stem, list);
  }
  for (const f of files) {
    if (!f.is_test || /(?:^|\/)conftest\.py$/.test(f.path)) continue;
    const cands = modulesByStem.get(testStem(f.path)) ?? [];
    let pick: string | null = cands.length === 1 ? cands[0]! : null;
    if (!pick && cands.length > 1) {
      const testDir = posix
        .dirname(f.path)
        .split("/")
        .filter((s) => !TEST_DIR_SEGMENT.test(s))
        .join("/");
      const mirrored = cands.filter((c) => {
        const d = posix.dirname(c) === "." ? "" : posix.dirname(c);
        return (
          d === testDir ||
          d.endsWith(`/${testDir}`) ||
          (testDir !== "" && testDir.endsWith(d) && d !== "")
        );
      });
      if (mirrored.length === 1) pick = mirrored[0]!;
    }
    if (pick) insLink.run(repoKey, f.path, pick, "name");
  }
  const testLinks = (
    db.prepare("SELECT COUNT(*) AS n FROM code_test_link WHERE repo_key = ?").get(repoKey) as {
      n: number;
    }
  ).n;
  const modulesWithTests = (
    db
      .prepare("SELECT COUNT(DISTINCT target_path) AS n FROM code_test_link WHERE repo_key = ?")
      .get(repoKey) as { n: number }
  ).n;
  return { refs, unresolved, external, testLinks, modulesWithTests };
}

// ── Build ─────────────────────────────────────────────────────────────

export interface BuildIndexOptions {
  repoKey: string;
  repo: string;
  canonical?: string | null;
  /** Absolute path of the checkout to read (a throwaway worktree is fine). */
  repoRoot: string;
  /** The commit the checkout is at (recorded; also the incremental diff's end). */
  commit?: string | null;
  /** Ignore the previous build and walk the whole tree (unchanged hashes still skip). */
  full?: boolean;
  maxFiles?: number;
  maxBytesPerFile?: number;
  now?: () => string;
  /**
   * The paths changed between two commits (`git diff --name-status -M`), or null when it
   * cannot be read (then the build walks the tree). Injectable for tests.
   */
  changedPaths?: (root: string, from: string, to: string) => ChangedPaths | null;
}

export interface ChangedPaths {
  /** Added, modified, copied or renamed-to paths. */
  changed: string[];
  /** Deleted or renamed-away paths. */
  removed: string[];
}

/** `git diff --name-status -M from to` in root, parsed; null on any failure. */
export function gitChangedPaths(root: string, from: string, to: string): ChangedPaths | null {
  let out: string;
  try {
    out = execFileSync(
      "git",
      [
        "-C",
        root,
        "-c",
        "core.quotePath=false",
        "diff",
        "--name-status",
        "-M",
        "--no-ext-diff",
        from,
        to,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 },
    );
  } catch {
    return null;
  }
  const changed: string[] = [];
  const removed: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    const st = (f[0] ?? "").charAt(0);
    if (st === "D" && f[1]) removed.push(f[1]);
    else if (st === "R" && f[1] && f[2]) {
      removed.push(f[1]);
      changed.push(f[2]);
    } else if (st === "C" && f[2]) changed.push(f[2]);
    else if (f[1]) changed.push(f[1]);
  }
  return { changed, removed };
}

/** `git rev-parse HEAD` in root, or null. */
export function gitHead(root: string): string | null {
  try {
    return (
      execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/** A gitattributes pattern as a path regex (enough for linguist-generated / -vendored). */
function attrGlob(pattern: string): RegExp | null {
  let p = pattern.trim();
  if (!p || p.startsWith("#") || p.startsWith("!")) return null;
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]!;
    if (ch === "*") {
      if (p[i + 1] === "*") {
        const slash = p[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${anchored ? "^" : "(?:^|/)"}${re}${dirOnly ? "/" : "(?:/|$)"}`);
}
function generatedByAttributes(text: string): Array<{ re: RegExp; on: boolean }> {
  const out: Array<{ re: RegExp; on: boolean }> = [];
  for (const raw of text.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const re = attrGlob(parts[0]!);
    if (!re) continue;
    for (const a of parts.slice(1)) {
      if (/^linguist-(?:generated|vendored)(?:=true)?$/.test(a)) out.push({ re, on: true });
      else if (/^-linguist-(?:generated|vendored)$|^linguist-(?:generated|vendored)=false$/.test(a))
        out.push({ re, on: false });
    }
  }
  return out;
}

interface Walked {
  sources: Array<{ rel: string; size: number }>;
  configs: string[];
  capsHit: Set<string>;
  skippedGenerated: number;
}

function readUnder(root: string, rel: string): string | null {
  if (rel.startsWith("/") || rel.split("/").includes("..")) return null;
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
}

function isAliasConfig(rel: string): boolean {
  const b = posix.basename(rel);
  return b === "package.json" || /^tsconfig[^/]*\.json$/.test(b) || b === "jsconfig.json";
}

/** Should `rel` be indexed (by path)? Generated, vendored and noise paths are not. */
function indexablePath(
  rel: string,
  attrs: Array<{ re: RegExp; on: boolean }>,
): "yes" | "no" | "generated" {
  if (!indexLang(rel)) return "no";
  const segs = rel.split("/");
  for (const s of segs.slice(0, -1)) if (s.startsWith(".") || SKIP_DIRS.has(s)) return "no";
  if (GENERATED_FILE.test(rel)) return "generated";
  let on = false;
  for (const g of attrs) if (g.re.test(rel)) on = g.on;
  return on ? "generated" : "yes";
}

function walk(
  root: string,
  maxFiles: number,
  maxBytes: number,
  attrs: Array<{ re: RegExp; on: boolean }>,
): Walked {
  const out: Walked = { sources: [], configs: [], capsHit: new Set(), skippedGenerated: 0 };
  const visit = (dirRel: string) => {
    let entries;
    try {
      entries = readdirSync(dirRel ? join(root, dirRel) : root, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        visit(rel);
        continue;
      }
      if (!e.isFile()) continue;
      if (isAliasConfig(rel)) {
        out.configs.push(rel);
        continue;
      }
      const ok = indexablePath(rel, attrs);
      if (ok === "generated") out.skippedGenerated++;
      if (ok !== "yes") continue;
      if (out.sources.length >= maxFiles) {
        out.capsHit.add("maxFiles");
        continue;
      }
      let size: number;
      try {
        size = statSync(join(root, rel)).size;
      } catch {
        continue;
      }
      if (size > maxBytes) {
        out.capsHit.add("maxBytesPerFile");
        continue;
      }
      out.sources.push({ rel, size });
    }
  };
  visit("");
  return out;
}

/**
 * Build or refresh a repo's code index from the checkout at `repoRoot`. One transaction:
 * a failure leaves the previous index in place. Returns the build record written.
 */
export function buildCodeIndex(db: Database, opts: BuildIndexOptions): IndexBuildRecord {
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const maxFiles = opts.maxFiles ?? INDEX_MAX_FILES_DEFAULT;
  const maxBytes = opts.maxBytesPerFile ?? INDEX_MAX_BYTES_PER_FILE_DEFAULT;
  const root = opts.repoRoot;
  const commit = opts.commit ?? null;
  const prev = getIndexBuild(db, opts.repoKey);
  const attrs = generatedByAttributes(readUnder(root, ".gitattributes") ?? "");

  let diff: ChangedPaths | null = null;
  if (!opts.full && prev && prev.commit && commit && prev.stats.capsHit.length === 0) {
    if (prev.commit === commit) diff = { changed: [], removed: [] };
    else diff = (opts.changedPaths ?? gitChangedPaths)(root, prev.commit, commit);
  }

  const stored = new Map(
    (
      db
        .prepare("SELECT path, content_hash FROM code_index_file WHERE repo_key = ?")
        .all(opts.repoKey) as Array<{
        path: string;
        content_hash: string;
      }>
    ).map((r) => [r.path, r.content_hash]),
  );
  let extracted = 0;
  let removed = 0;
  let skippedGenerated = 0;
  const capsHit = new Set<string>();
  const mode: IndexBuildRecord["mode"] = diff
    ? diff.changed.length + diff.removed.length === 0
      ? "unchanged"
      : "incremental"
    : "full";

  const upsertOne = (rel: string, size: number | null) => {
    const content = readUnder(root, rel);
    if (content === null) {
      if (stored.has(rel)) {
        deleteFileRows(db, opts.repoKey, rel);
        removed++;
      }
      return;
    }
    const s = size ?? Buffer.byteLength(content, "utf8");
    if (s > maxBytes) {
      capsHit.add("maxBytesPerFile");
      if (stored.has(rel)) {
        deleteFileRows(db, opts.repoKey, rel);
        removed++;
      }
      return;
    }
    const hash = sha256(content);
    if (stored.get(rel) === hash) return;
    writeFileRows(db, opts.repoKey, rel, hash, s, extractCodeFacts(rel, content), now);
    extracted++;
  };
  const replaceAliases = (rel: string) => {
    db.prepare("DELETE FROM code_index_alias WHERE repo_key = ? AND source_path = ?").run(
      opts.repoKey,
      rel,
    );
    const content = readUnder(root, rel);
    if (content === null) return;
    const ins = db.prepare(
      "INSERT INTO code_index_alias (repo_key, source_path, alias, target, kind) VALUES (?,?,?,?,?)",
    );
    for (const a of extractAliases(rel, content))
      ins.run(opts.repoKey, rel, a.alias, a.target, a.kind);
  };

  const run = db.transaction(() => {
    if (diff) {
      for (const rel of diff.removed) {
        if (stored.has(rel)) {
          deleteFileRows(db, opts.repoKey, rel);
          stored.delete(rel);
          removed++;
        }
        if (isAliasConfig(rel)) replaceAliases(rel);
      }
      let count = stored.size;
      for (const rel of diff.changed) {
        if (isAliasConfig(rel)) {
          const segs = rel.split("/");
          if (!segs.slice(0, -1).some((s) => s.startsWith(".") || SKIP_DIRS.has(s)))
            replaceAliases(rel);
          continue;
        }
        const ok = indexablePath(rel, attrs);
        if (ok === "generated") skippedGenerated++;
        if (ok !== "yes") {
          if (stored.has(rel)) {
            deleteFileRows(db, opts.repoKey, rel);
            removed++;
          }
          continue;
        }
        if (!stored.has(rel) && count >= maxFiles) {
          capsHit.add("maxFiles");
          continue;
        }
        if (!stored.has(rel)) count++;
        upsertOne(rel, null);
      }
    } else {
      const w = walk(root, maxFiles, maxBytes, attrs);
      skippedGenerated = w.skippedGenerated;
      for (const c of w.capsHit) capsHit.add(c);
      const seen = new Set<string>();
      for (const f of w.sources) {
        seen.add(f.rel);
        upsertOne(f.rel, f.size);
      }
      for (const p of stored.keys())
        if (!seen.has(p)) {
          deleteFileRows(db, opts.repoKey, p);
          removed++;
        }
      db.prepare("DELETE FROM code_index_alias WHERE repo_key = ?").run(opts.repoKey);
      for (const c of w.configs) replaceAliases(c);
    }
    const derived = rebuildDerived(db, opts.repoKey);
    const count = (sql: string) => (db.prepare(sql).get(opts.repoKey) as { n: number }).n;
    const langs = db
      .prepare(
        "SELECT lang, COUNT(*) AS n FROM code_index_file WHERE repo_key = ? GROUP BY lang ORDER BY lang",
      )
      .all(opts.repoKey) as Array<{ lang: string; n: number }>;
    const stats: IndexBuildStats = {
      files: count("SELECT COUNT(*) AS n FROM code_index_file WHERE repo_key = ?"),
      testFiles: count(
        "SELECT COUNT(*) AS n FROM code_index_file WHERE repo_key = ? AND is_test = 1",
      ),
      symbols: count("SELECT COUNT(*) AS n FROM code_symbol WHERE repo_key = ?"),
      exportedSymbols: count(
        "SELECT COUNT(*) AS n FROM code_symbol WHERE repo_key = ? AND exported_as IS NOT NULL",
      ),
      imports: count("SELECT COUNT(*) AS n FROM code_import WHERE repo_key = ?"),
      refs: derived.refs,
      unresolved: derived.unresolved,
      external: derived.external,
      testLinks: derived.testLinks,
      modulesWithTests: derived.modulesWithTests,
      languages: Object.fromEntries(langs.map((l) => [l.lang, l.n])),
      // A cap hit in an earlier full walk still holds for an incremental build on top of it.
      capsHit: [...capsHit].sort(),
      extracted,
      removed,
      skippedGenerated,
    };
    const record: IndexBuildRecord = {
      repoKey: opts.repoKey,
      repo: opts.repo,
      canonical: opts.canonical ?? null,
      commit,
      builtAt: now,
      mode,
      stats,
    };
    db.prepare(
      `INSERT INTO code_index_build (repo_key, repo, canonical, commit_sha, built_at, mode, stats)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(repo_key) DO UPDATE SET repo = excluded.repo, canonical = excluded.canonical,
         commit_sha = excluded.commit_sha, built_at = excluded.built_at, mode = excluded.mode,
         stats = excluded.stats`,
    ).run(
      record.repoKey,
      record.repo,
      record.canonical,
      record.commit,
      record.builtAt,
      record.mode,
      JSON.stringify(stats),
    );
    return record;
  });
  return run.immediate();
}

// ── Query ─────────────────────────────────────────────────────────────

export type IndexStatus = "missing" | "fresh" | "stale" | "unknown";

export interface NeighbourRef {
  path: string;
  /** "imports <name>" | "imports the module" | "imports it through <barrel>" */
  via: "name" | "module" | "barrel";
  /** The barrel the import went through (via "barrel"). */
  through: string | null;
  line: number;
  /** Callers only: a test imports this caller, or names it (index). */
  tested?: boolean;
}

export interface NeighbourTest {
  path: string;
  via: "import" | "name" | "barrel";
  through: string | null;
}

export interface NeighbourItem {
  /** What was asked: a path, a symbol name, or `path#symbol`. */
  query: string;
  /** The module the answer is about (null when the name is not found). */
  path: string | null;
  symbol: string | null;
  /** The name importers use for the symbol ("default" for a default export). */
  exportedAs: string | null;
  /** Why there is no answer (not indexed, not exported, not found, ambiguous). */
  note: string | null;
  callers: NeighbourRef[];
  callersTotal: number;
  callersTested: number;
  tests: NeighbourTest[];
  testsTotal: number;
  /** Test files linked to the module at all (by import or by file name), for a symbol query. */
  moduleTestsTotal: number;
}

export interface NeighboursResult {
  status: IndexStatus;
  method: typeof INDEX_METHOD;
  /**
   * capsHit: the build stopped at a cap (maxFiles, maxBytesPerFile), so files past it were
   * not read and the counts are partial; a reader says so where it shows them.
   */
  build: { commit: string | null; builtAt: string; files: number; capsHit: string[] } | null;
  /** The commit the caller compared against (status), when given. */
  against: string | null;
  items: NeighbourItem[];
  lowerBound: true;
}

export interface NeighbourQuery {
  repoKey: string;
  paths?: ReadonlyArray<string>;
  /** `name` or `path#name`. */
  symbols?: ReadonlyArray<string>;
  /** Callers and tests listed per item (the totals count all of them). */
  perItem?: number;
  /** The commit the caller's tree is at: equal to the build's → fresh, else stale. */
  commit?: string | null;
}

interface RefRow {
  from_path: string;
  to_path: string;
  kind: string;
  names: string;
  line: number;
}

function parseNames(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Does an import's names list take `name` (exported name)? Returns the local alias for a re-export. */
function takes(
  names: string[],
  name: string | null,
): { hit: boolean; as: string | null; whole: boolean } {
  if (names.includes("*")) return { hit: true, as: name, whole: true };
  if (name === null) return { hit: true, as: null, whole: true };
  for (const n of names) {
    const [src, alias] = n.split(/\s+as\s+/);
    if (src === name) return { hit: true, as: alias ?? src ?? null, whole: false };
  }
  return { hit: false, as: null, whole: false };
}

function answerFor(
  db: Database,
  repoKey: string,
  path: string,
  exportedAs: string | null,
  perItem: number,
  testSet: ReadonlySet<string>,
): Pick<
  NeighbourItem,
  "callers" | "callersTotal" | "callersTested" | "tests" | "testsTotal" | "moduleTestsTotal"
> {
  const refsTo = db.prepare(
    "SELECT from_path, to_path, kind, names, line FROM code_ref WHERE repo_key = ? AND to_path = ?",
  );
  const found = new Map<string, NeighbourRef>();
  // Breadth-first through re-export barrels: (module, the name importers use there).
  const queue: Array<{
    module: string;
    name: string | null;
    through: string | null;
    depth: number;
  }> = [{ module: path, name: exportedAs, through: null, depth: 0 }];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const key = `${cur.module}#${cur.name ?? "*"}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const r of refsTo.all(repoKey, cur.module) as RefRow[]) {
      if (r.from_path === path) continue;
      const t = takes(parseNames(r.names), cur.name);
      if (!t.hit) continue;
      // A barrel that re-exports the symbol: its importers of that name are callers too.
      // A path query (no name) lists the barrel itself: importing a barrel is not using
      // every module behind it.
      if (r.kind === "reexport" && cur.name !== null && cur.depth < MAX_BARREL_DEPTH) {
        queue.push({
          module: r.from_path,
          name: t.whole ? cur.name : t.as,
          through: r.from_path,
          depth: cur.depth + 1,
        });
        continue;
      }
      if (found.has(r.from_path)) continue;
      found.set(r.from_path, {
        path: r.from_path,
        via: cur.through ? "barrel" : t.whole && cur.name !== null ? "module" : "name",
        through: cur.through,
        line: r.line,
      });
    }
  }
  const linkTo = db.prepare(
    "SELECT test_path, via FROM code_test_link WHERE repo_key = ? AND target_path = ? ORDER BY test_path",
  );
  const testedPaths = new Set(
    (
      db
        .prepare("SELECT DISTINCT target_path FROM code_test_link WHERE repo_key = ?")
        .all(repoKey) as Array<{
        target_path: string;
      }>
    ).map((r) => r.target_path),
  );
  const all = [...found.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const callers = all
    .filter((r) => !testSet.has(r.path))
    .map((r) => ({ ...r, tested: testedPaths.has(r.path) }));
  const tests = new Map<string, NeighbourTest>();
  for (const r of all.filter((x) => testSet.has(x.path)))
    tests.set(r.path, {
      path: r.path,
      via: r.via === "barrel" ? "barrel" : "import",
      through: r.through,
    });
  // A name-convention test of the module counts for every symbol in it; an import-linked
  // test of the module counts only when the symbol query did not already narrow it out.
  const links = linkTo.all(repoKey, path) as Array<{ test_path: string; via: "import" | "name" }>;
  for (const l of links) {
    if (tests.has(l.test_path)) continue;
    if (l.via === "name" || exportedAs === null)
      tests.set(l.test_path, { path: l.test_path, via: l.via, through: null });
  }
  const testList = [...tests.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    callers: callers.slice(0, perItem),
    callersTotal: callers.length,
    callersTested: callers.filter((c) => c.tested).length,
    tests: testList.slice(0, perItem),
    testsTotal: testList.length,
    moduleTestsTotal: new Set([...links.map((l) => l.test_path), ...testList.map((t) => t.path)])
      .size,
  };
}

/**
 * The direct callers (importers) and tests of each named path and symbol. Read-only.
 * status "missing" (no build for the repo) returns no items; "stale" still answers, and
 * the caller decides whether a stale answer is shown (the runner and Review do not).
 */
export function codeNeighbours(db: Database, q: NeighbourQuery): NeighboursResult {
  const build = getIndexBuild(db, q.repoKey);
  const perItem = Math.max(1, Math.min(50, q.perItem ?? 5));
  const against = q.commit ?? null;
  if (!build)
    return {
      status: "missing",
      method: INDEX_METHOD,
      build: null,
      against,
      items: [],
      lowerBound: true,
    };
  const status: IndexStatus =
    against === null || !build.commit ? "unknown" : against === build.commit ? "fresh" : "stale";
  const testSet = new Set(
    (
      db
        .prepare("SELECT path FROM code_index_file WHERE repo_key = ? AND is_test = 1")
        .all(q.repoKey) as Array<{
        path: string;
      }>
    ).map((r) => r.path),
  );
  const hasFile = db.prepare("SELECT 1 FROM code_index_file WHERE repo_key = ? AND path = ?");
  const symIn = db.prepare(
    "SELECT name, exported_as FROM code_symbol WHERE repo_key = ? AND path = ? AND (name = ? OR exported_as = ?) ORDER BY exported_as IS NULL LIMIT 1",
  );
  const symAnywhere = db.prepare(
    `SELECT s.path, s.name, s.kind, s.exported_as FROM code_symbol s
       JOIN code_index_file f ON f.repo_key = s.repo_key AND f.path = s.path AND f.is_test = 0
      WHERE s.repo_key = ? AND (s.name = ? OR s.exported_as = ?) AND s.exported_as IS NOT NULL
        AND s.kind NOT IN ('reexport')
      ORDER BY s.path`,
  );
  const empty = {
    callers: [],
    callersTotal: 0,
    callersTested: 0,
    tests: [],
    testsTotal: 0,
    moduleTestsTotal: 0,
  };
  const items: NeighbourItem[] = [];
  const seenPaths = new Set<string>();
  for (const raw of q.paths ?? []) {
    const p = raw.replace(/^\.\//, "").trim();
    if (!p || seenPaths.has(p)) continue;
    seenPaths.add(p);
    if (!hasFile.get(q.repoKey, p)) {
      items.push({
        query: p,
        path: p,
        symbol: null,
        exportedAs: null,
        note: indexLang(p)
          ? "not in the index (skipped, or not in the tree at the build commit)"
          : "not a file the index reads (TypeScript, JavaScript and Python only)",
        ...empty,
      });
      continue;
    }
    items.push({
      query: p,
      path: p,
      symbol: null,
      exportedAs: null,
      note: null,
      ...answerFor(db, q.repoKey, p, null, perItem, testSet),
    });
  }
  for (const raw of q.symbols ?? []) {
    const s = raw.trim();
    if (!s) continue;
    const hash = s.lastIndexOf("#");
    const inPath = hash > 0 ? s.slice(0, hash).replace(/^\.\//, "") : null;
    const name = hash > 0 ? s.slice(hash + 1) : s;
    if (!name) continue;
    if (inPath) {
      if (!hasFile.get(q.repoKey, inPath)) {
        items.push({
          query: s,
          path: inPath,
          symbol: name,
          exportedAs: null,
          note: "module not in the index",
          ...empty,
        });
        continue;
      }
      const row = symIn.get(q.repoKey, inPath, name, name) as
        { name: string; exported_as: string | null } | undefined;
      const exportedAs = row?.exported_as ?? (name === "default" ? "default" : null);
      if (!exportedAs) {
        items.push({
          query: s,
          path: inPath,
          symbol: name,
          exportedAs: null,
          note: row
            ? "not exported (no other module can import it by name)"
            : "no top-level symbol of that name in the index",
          ...empty,
        });
        continue;
      }
      items.push({
        query: s,
        path: inPath,
        symbol: name,
        exportedAs,
        note: null,
        ...answerFor(db, q.repoKey, inPath, exportedAs, perItem, testSet),
      });
      continue;
    }
    const found = symAnywhere.all(q.repoKey, name, name) as Array<{
      path: string;
      name: string;
      kind: string;
      exported_as: string;
    }>;
    // A declaration beats an export list that only passes the name on (CommonJS
    // `module.exports = { x }` of an imported x).
    const declared = found.filter((d) => d.kind !== "export");
    const defs = declared.length > 0 ? declared : found;
    if (defs.length === 0) {
      items.push({
        query: s,
        path: null,
        symbol: name,
        exportedAs: null,
        note: "no exported symbol of that name in the index",
        ...empty,
      });
      continue;
    }
    for (const d of defs.slice(0, MAX_DEFINITIONS))
      items.push({
        query: s,
        path: d.path,
        symbol: d.name,
        exportedAs: d.exported_as,
        note:
          defs.length > MAX_DEFINITIONS
            ? `${defs.length} modules export this name; the first ${MAX_DEFINITIONS} are listed`
            : null,
        ...answerFor(db, q.repoKey, d.path, d.exported_as, perItem, testSet),
      });
  }
  return {
    status,
    method: INDEX_METHOD,
    build: {
      commit: build.commit,
      builtAt: build.builtAt,
      files: build.stats.files,
      capsHit: Array.isArray(build.stats.capsHit) ? build.stats.capsHit : [],
    },
    against,
    items,
    lowerBound: true,
  };
}

/** Every repo's index coverage (the build records), for `memory index stats` and Health. */
export function codeIndexStats(db: Database, repoKey?: string): IndexBuildRecord[] {
  if (repoKey) {
    const r = getIndexBuild(db, repoKey);
    return r ? [r] : [];
  }
  return listIndexBuilds(db);
}
