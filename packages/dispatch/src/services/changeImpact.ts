import type { GitRunner } from "./diffService.js";

/**
 * CHANGE IMPACT (Release A, A5 M subset): the "Behavioural surface" of one repo's delivery,
 * read deterministically from the review diff's own lines and the tree at the head commit.
 * No model, no symbol graph: every fact names the method that found it ("from the diff's
 * lines", "by path", "from the manifest diff", "by .gitattributes", "by import text",
 * "pattern match", "scope graph depends_on"), because a text or path heuristic can be wrong
 * and must never read as certainty. What is not computed is said as "not analysed".
 *
 * ADVISORY ONLY: nothing gates on these facts. They are not risk annotations and do not feed
 * observedRisk (the auto-ship hold). Git work is bounded: at most two spawns per repo (the
 * head's .gitattributes and one `git grep` over test files), each under the diff runner's
 * GIT_TIMEOUT_MS, with module and fact caps.
 */

export type ImpactKind =
  | "export_added"
  | "export_removed"
  | "export_changed"
  | "migration"
  | "ddl"
  | "config"
  | "env_added"
  | "env_removed"
  | "dependency_added"
  | "dependency_removed"
  | "dependency_bumped"
  | "generated"
  | "untested_module"
  | "route"
  | "downstream_repo";

export type ImpactMethod =
  | "from the diff's lines"
  | "by path"
  | "from the manifest diff"
  | "by .gitattributes"
  | "by import text"
  | "pattern match"
  | "scope graph depends_on";

export interface ImpactFact {
  kind: ImpactKind;
  /** One plain line ("export function clearDone added"). */
  text: string;
  /** The file in this diff the fact is about (its anchor in the Review diff), or null. */
  path: string | null;
  /** The new-side line (old-side for a removal) the fact was read from, when it has one. */
  line: number | null;
  method: ImpactMethod;
}

export interface RepoImpact {
  facts: ImpactFact[];
  /** Surfaces scanned with nothing found ("migration or DDL", "config"…): a negative fact. */
  none: string[];
  /** What this scan does not cover, said plainly. */
  not_analysed: string[];
}

/** A repo that depends on this one in the scope graph (scope_edges depends_on). */
export interface DownstreamRepo {
  repo: string;
  /** "<dependent scope> depends_on <this repo's scope>". */
  via: string;
}

export interface ImpactInput {
  /** The review diff text (possibly capped). */
  diff: string;
  truncated: boolean;
  /** The head commit the diff was computed against (null: tree reads are skipped). */
  headSha: string | null;
  runGit?: GitRunner;
  localPath?: string;
  downstream?: readonly DownstreamRepo[];
  /**
   * Every changed path (the diff's `--numstat`, which is never cut): a test file past a
   * capped diff's cut is still in the change. A rename reads `old => new` there.
   */
  paths?: readonly string[];
}

/** Facts listed per kind before the rest are counted as not listed. */
const MAX_FACTS_PER_KIND = 25;
/** Changed modules checked for an importing test. */
const MAX_MODULES = 40;
/** Cap on the `git grep` output read (it is one line per import found). */
const GREP_MAX_BUFFER = 2 * 1024 * 1024;

interface DiffLine {
  n: number;
  text: string;
}
interface DiffFile {
  path: string;
  oldPath: string | null;
  added: boolean;
  deleted: boolean;
  binary: boolean;
  plus: DiffLine[];
  minus: DiffLine[];
}

/** Split a unified diff into files with their added (new-side) and removed (old-side) lines. */
export function parseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldLn = 0;
  let newLn = 0;
  let inHunk = false;
  const strip = (p: string, pfx: string) => (p.startsWith(pfx) ? p.slice(pfx.length) : p);
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      cur = {
        path: m ? m[2]! : line.slice(11),
        oldPath: m ? m[1]! : null,
        added: false,
        deleted: false,
        binary: false,
        plus: [],
        minus: [],
      };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith("new file mode")) cur.added = true;
      else if (line.startsWith("deleted file mode")) cur.deleted = true;
      else if (line.startsWith("Binary files ")) cur.binary = true;
      else if (line.startsWith("+++ ")) {
        const p = line.slice(4).trim();
        if (p === "/dev/null") cur.deleted = true;
        else cur.path = strip(p, "b/");
      } else if (line.startsWith("--- ")) {
        const p = line.slice(4).trim();
        if (p === "/dev/null") cur.added = true;
        else cur.oldPath = strip(p, "a/");
      }
    }
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLn = Number(m[1]);
        newLn = Number(m[2]);
        inHunk = true;
      }
      continue;
    }
    if (!inHunk) continue;
    const c = line.charAt(0);
    if (c === "+") cur.plus.push({ n: newLn++, text: line.slice(1) });
    else if (c === "-") cur.minus.push({ n: oldLn++, text: line.slice(1) });
    else if (c === " ") {
      oldLn++;
      newLn++;
    }
  }
  return files;
}

const JS_EXT = /\.(?:[cm]?[jt]sx?)$/;
const PY_EXT = /\.py$/;
const OTHER_SOURCE_EXT = /\.(?:go|rs|java|kt|rb|php|cs|swift|scala|c|cc|cpp|h|hpp)$/;
const DOC_EXT = /\.(?:md|mdx|txt|rst|adoc)$/i;
const TEST_PATH =
  /(?:^|\/)(?:test|tests|__tests__|spec|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.(?:py|go)$/;
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
]);
const GENERATED_PATH =
  /(?:^|\/)(?:dist|__generated__|generated)\/|\.min\.(?:js|css)$|\.generated\.[^/]+$|\.pb\.go$|_pb2\.py$/;
const MIGRATION_PATH =
  /(?:^|\/)(?:migrations?|migrate|alembic\/versions|db\/migrate|prisma\/migrations)\/|\.sql$/i;
const MANIFESTS = new Set(["package.json", "pyproject.toml", "go.mod", "Cargo.toml", "Pipfile"]);
const CONFIG_PATH =
  /(?:^|\/)(?:\.env(?:\.[^/]+)?|tsconfig[^/]*\.json|jsconfig\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|\.prettierrc[^/]*|[^/]+\.config\.[cm]?[jt]s|[^/]+\.config\.json|\.babelrc[^/]*|\.npmrc|\.nvmrc|\.node-version|\.python-version|\.editorconfig|\.gitattributes|Dockerfile[^/]*|docker-compose[^/]*|compose\.ya?ml|Makefile|Procfile|settings\.py|setup\.cfg|tox\.ini|pytest\.ini|\.github\/workflows\/[^/]+|config\/[^/]+)$|\.(?:ya?ml|toml|ini|cfg|conf|properties)$/;
const ENV_EXAMPLE = /(?:^|\/)\.env\.(?:example|sample|template|dist|defaults)$/;

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** A gitattributes / gitignore-style pattern as a path regex (enough for linguist-generated). */
function globToRegex(pattern: string): RegExp | null {
  let p = pattern.trim();
  if (p === "" || p.startsWith("#") || p.startsWith("!")) return null;
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
  const head = anchored ? "^" : "(?:^|/)";
  return new RegExp(`${head}${re}${dirOnly ? "/" : "(?:/|$)"}`);
}

/** The linguist-generated patterns of a .gitattributes text (later lines win). */
export function generatedPatterns(text: string): Array<{ re: RegExp; on: boolean }> {
  const out: Array<{ re: RegExp; on: boolean }> = [];
  for (const raw of text.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const re = globToRegex(parts[0]!);
    if (!re) continue;
    for (const a of parts.slice(1)) {
      if (a === "linguist-generated" || a === "linguist-generated=true") out.push({ re, on: true });
      else if (a === "-linguist-generated" || a === "linguist-generated=false")
        out.push({ re, on: false });
    }
  }
  return out;
}

/** Exported (module-level) declarations a JS/TS or Python line declares. */
function declaredExports(path: string, text: string): string[] {
  if (JS_EXT.test(path)) {
    let m = text.match(
      /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
    );
    if (m) return [`export ${m[1]} ${m[2]}`];
    if (/^export\s+default\b/.test(text)) return ["export default"];
    m = text.match(/^export\s*(?:type\s*)?\{([^}]*)\}/);
    if (m)
      return m[1]!
        .split(",")
        .map((x) =>
          x
            .trim()
            .split(/\s+as\s+/)
            .pop()!
            .trim(),
        )
        .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x))
        .map((x) => `export ${x}`);
    m = text.match(/^export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/);
    if (m) return [m[1] ? `export * as ${m[1]}` : `export * from ${m[2]}`];
    m = text.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/);
    if (m) return [`exports.${m[1]}`];
    if (/^module\.exports\s*=/.test(text)) return ["module.exports"];
    return [];
  }
  if (PY_EXT.test(path)) {
    const m = text.match(/^(?:async\s+)?(def|class)\s+([A-Za-z]\w*)/);
    return m ? [`${m[1]} ${m[2]}`] : [];
  }
  return [];
}

const ENV_RES = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\]/g,
  /os\.environ(?:\.get)?\s*[[(]\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  /Deno\.env\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z_][A-Z0-9_]*)"/g,
];
function envNames(path: string, text: string): string[] {
  if (ENV_EXAMPLE.test(path)) {
    const m = text.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
    return m ? [m[1]!] : [];
  }
  if (DOC_EXT.test(path)) return [];
  const out: string[] = [];
  for (const re of ENV_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

const NON_DEP_KEYS = new Set([
  "name",
  "version",
  "main",
  "module",
  "types",
  "typings",
  "license",
  "description",
  "packageManager",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "author",
  "homepage",
  "type",
  "private",
  "readme",
  "requires-python",
  "python",
  "edition",
  "rust-version",
  "build-backend",
]);
const VERSIONISH =
  /^(?:[\^~<>=!*]|\d|v\d|latest$|next$|workspace:|npm:|file:|link:|git\+|git:|github:|https?:)/;

/** A dependency entry a manifest line declares: [name, version]. */
function dependencyEntry(path: string, text: string): [string, string] | null {
  const b = base(path);
  if (b === "package.json") {
    const m = text.match(/^\s*"((?:@[\w.-]+\/)?[\w.-]+)"\s*:\s*"([^"]*)"\s*,?\s*$/);
    if (!m || NON_DEP_KEYS.has(m[1]!) || !VERSIONISH.test(m[2]!.trim())) return null;
    return [m[1]!, m[2]!.trim()];
  }
  if (b === "go.mod") {
    const m = text.match(
      /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/\S+)\s+(v\S+)(?:\s*\/\/.*)?$/,
    );
    return m ? [m[1]!, m[2]!] : null;
  }
  if (/^requirements[^/]*\.txt$/.test(b)) {
    if (/^\s*(?:-|#|$)/.test(text)) return null;
    const m = text.match(
      /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([<>=!~]=?=?\s*[^\s;#]+)?/,
    );
    return m ? [m[1]!, (m[2] ?? "").replace(/\s+/g, "") || "any"] : null;
  }
  if (b === "pyproject.toml" || b === "Cargo.toml" || b === "Pipfile") {
    // PEP 621 / poetry array entry: "requests>=2.31",
    let m = text.match(
      /^\s*"([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([<>=!~^][^";]*)?(?:;[^"]*)?"\s*,?\s*$/,
    );
    if (m && !NON_DEP_KEYS.has(m[1]!)) return [m[1]!, (m[2] ?? "").trim() || "any"];
    // key = "version" / key = { version = "…" }
    m = text.match(
      /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(?:"([^"]+)"|\{[^}]*\bversion\s*=\s*"([^"]+)")/,
    );
    if (!m || NON_DEP_KEYS.has(m[1]!)) return null;
    const v = (m[2] ?? m[3] ?? "").trim();
    return VERSIONISH.test(v) ? [m[1]!, v] : null;
  }
  return null;
}

const DDL =
  /^\s*["'`]?\s*((?:CREATE|ALTER|DROP|RENAME|TRUNCATE)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:MATERIALIZED\s+VIEW|TABLE|INDEX|VIEW|SCHEMA|TYPE|COLUMN|TRIGGER|SEQUENCE|DATABASE|EXTENSION|FUNCTION)\b.*)$/;

const ROUTE_FILE =
  /(?:^|\/)pages\/api\/|(?:^|\/)app\/(?:.*\/)?route\.[cm]?[jt]sx?$|\+(?:server|page\.server)\.[jt]s$|(?:^|\/)routes?\/[^/]+\.[cm]?[jt]sx?$|(?:^|\/)urls\.py$|(?:^|\/)config\/routes\.rb$|(?:^|\/)[^/]*(?:routes?|router)\.[cm]?[jt]sx?$|(?:^|\/)[^/]*(?:routes?|views|endpoints)\.py$/;
const ROUTE_LINES: Array<{
  re: RegExp;
  method: (m: RegExpMatchArray) => string;
  path: (m: RegExpMatchArray) => string;
}> = [
  {
    re: /\b(?:app|router|server|api|fastify|routes?|r)\.(get|post|put|patch|delete|all|head|options)\s*\(\s*(['"`])([^'"`]+)\2/i,
    method: (m) => m[1]!.toUpperCase(),
    path: (m) => m[3]!,
  },
  {
    re: /^\s*@\w+(?:\.\w+)*\.(get|post|put|patch|delete|route|api_route)\s*\(\s*['"]([^'"]+)['"]/,
    method: (m) => (["route", "api_route"].includes(m[1]!) ? "ANY" : m[1]!.toUpperCase()),
    path: (m) => m[2]!,
  },
  {
    re: /\.(?:HandleFunc|Handle)\(\s*"([^"]+)"/,
    method: () => "ANY",
    path: (m) => m[1]!,
  },
  {
    re: /\.(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"/,
    method: (m) => m[1]!,
    path: (m) => m[2]!,
  },
];

/** The text an import of this module carries: its file name, or its folder for an index. */
function moduleSpecifier(path: string): string | null {
  const b = base(path);
  const stem = b.replace(/\.[^.]+$/, "");
  if (stem === "index" || stem === "__init__") {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    const d = base(dir);
    return d || null;
  }
  return stem || null;
}

const ereEscape = (s: string) => s.replace(/[.^$*+?()[\]{}|\\]/g, "\\$&");

/** Compute one repo's impact facts. Never throws: a failed read is a "not analysed" line. */
export function computeRepoImpact(input: ImpactInput): RepoImpact {
  const files = parseDiffFiles(input.diff).filter((f) => !f.binary);
  const facts: ImpactFact[] = [];
  const notAnalysed: string[] = [];
  const counts = new Map<ImpactKind, number>();
  const push = (f: ImpactFact) => {
    const n = (counts.get(f.kind) ?? 0) + 1;
    counts.set(f.kind, n);
    if (n <= MAX_FACTS_PER_KIND) facts.push(f);
  };

  // Generated files: by path, then the head's .gitattributes (linguist-generated).
  let gattr: Array<{ re: RegExp; on: boolean }> = [];
  if (input.headSha && input.runGit && input.localPath) {
    try {
      const r = input.runGit(input.localPath, ["show", `${input.headSha}:.gitattributes`]);
      if (r.status === 0) gattr = generatedPatterns(r.stdout);
    } catch {
      gattr = [];
    }
  }
  const generated = new Set<string>();
  for (const f of files) {
    if (LOCKFILES.has(base(f.path))) {
      generated.add(f.path);
      push({
        kind: "generated",
        text: `Lockfile ${f.deleted ? "deleted" : "changed"}: ${f.path}`,
        path: f.path,
        line: null,
        method: "by path",
      });
    } else if (GENERATED_PATH.test(f.path)) {
      generated.add(f.path);
      push({
        kind: "generated",
        text: `Generated file ${f.deleted ? "deleted" : "changed"}: ${f.path}`,
        path: f.path,
        line: null,
        method: "by path",
      });
    } else {
      let on = false;
      for (const g of gattr) if (g.re.test(f.path)) on = g.on;
      if (on) {
        generated.add(f.path);
        push({
          kind: "generated",
          text: `Generated file (linguist-generated) ${f.deleted ? "deleted" : "changed"}: ${f.path}`,
          path: f.path,
          line: null,
          method: "by .gitattributes",
        });
      }
    }
  }
  const authored = files.filter((f) => !generated.has(f.path));

  // Exported declarations added, removed or changed (module-level lines of the diff). A
  // test or a migration file is not a module other code imports.
  for (const f of authored) {
    if (TEST_PATH.test(f.path) || MIGRATION_PATH.test(f.deleted ? (f.oldPath ?? f.path) : f.path))
      continue;
    const added = new Map<string, DiffLine>();
    const removed = new Map<string, DiffLine>();
    for (const l of f.plus)
      for (const d of declaredExports(f.path, l.text)) if (!added.has(d)) added.set(d, l);
    for (const l of f.minus)
      for (const d of declaredExports(f.path, l.text)) if (!removed.has(d)) removed.set(d, l);
    for (const [d, l] of added) {
      const old = removed.get(d);
      if (!old)
        push({
          kind: "export_added",
          text: `${d} added`,
          path: f.path,
          line: l.n,
          method: "from the diff's lines",
        });
      else if (old.text.trim() !== l.text.trim())
        push({
          kind: "export_changed",
          text: `${d}: declaration line changed`,
          path: f.path,
          line: l.n,
          method: "from the diff's lines",
        });
    }
    for (const [d, l] of removed)
      if (!added.has(d))
        push({
          kind: "export_removed",
          text: `${d} removed${f.deleted ? " (file deleted)" : ""}`,
          path: f.deleted ? f.oldPath : f.path,
          line: l.n,
          method: "from the diff's lines",
        });
  }

  // Migrations (by path) and DDL statements added (from the diff's lines).
  for (const f of authored) {
    const p = f.deleted ? (f.oldPath ?? f.path) : f.path;
    const migration = MIGRATION_PATH.test(p);
    if (migration)
      push({
        kind: "migration",
        text: `Migration file ${f.added ? "added" : f.deleted ? "deleted" : "changed"}: ${p}`,
        path: p,
        line: null,
        method: "by path",
      });
    // Prose and test fixtures are not schema changes (a migration file is, wherever it is).
    if (DOC_EXT.test(f.path) || (!migration && TEST_PATH.test(f.path))) continue;
    for (const l of f.plus) {
      const m = l.text.match(DDL);
      if (!m) continue;
      // Outside SQL and migration files only an upper-case statement counts (prose is not DDL).
      const stmt = m[1]!;
      if (!migration && !/^[A-Z]+\s+[A-Z]/.test(stmt)) continue;
      push({
        kind: "ddl",
        text: `DDL added: ${stmt
          .replace(/\s+/g, " ")
          .replace(/[\s"'`;,(]+$/, "")
          .slice(0, 120)}`,
        path: f.path,
        line: l.n,
        method: "from the diff's lines",
      });
    }
  }

  // Config files changed (by path). Manifests are dependencies; lockfiles are generated.
  for (const f of authored) {
    const p = f.deleted ? (f.oldPath ?? f.path) : f.path;
    if (MANIFESTS.has(base(p)) || !CONFIG_PATH.test(p)) continue;
    push({
      kind: "config",
      text: `Config file ${f.added ? "added" : f.deleted ? "deleted" : "changed"}: ${p}`,
      path: p,
      line: null,
      method: "by path",
    });
  }

  // Environment variables newly read or no longer read (whole-repo diff, so a read that
  // moved between files is neither), and keys added to or removed from a .env example.
  const envPlus = new Map<string, { path: string; line: number }>();
  const envMinus = new Map<string, { path: string; line: number }>();
  for (const f of authored) {
    // A test setting or reading a variable is not the change reading it.
    if (TEST_PATH.test(f.path) && !ENV_EXAMPLE.test(f.path)) continue;
    for (const l of f.plus)
      for (const n of envNames(f.path, l.text))
        if (!envPlus.has(n)) envPlus.set(n, { path: f.path, line: l.n });
    for (const l of f.minus)
      for (const n of envNames(f.path, l.text))
        if (!envMinus.has(n)) envMinus.set(n, { path: f.oldPath ?? f.path, line: l.n });
  }
  for (const [n, at] of envPlus)
    if (!envMinus.has(n))
      push({
        kind: "env_added",
        text: ENV_EXAMPLE.test(at.path)
          ? `${n} added to ${base(at.path)}`
          : `Reads environment variable ${n} (new in this change)`,
        path: at.path,
        line: at.line,
        method: "from the diff's lines",
      });
  for (const [n, at] of envMinus)
    if (!envPlus.has(n))
      push({
        kind: "env_removed",
        text: ENV_EXAMPLE.test(at.path)
          ? `${n} removed from ${base(at.path)}`
          : `No longer reads environment variable ${n}`,
        path: at.path,
        line: at.line,
        method: "from the diff's lines",
      });

  // Dependency entries added, removed or bumped, per manifest.
  for (const f of authored) {
    const b = base(f.path);
    if (!MANIFESTS.has(b) && !/^requirements[^/]*\.txt$/.test(b)) continue;
    const plus = new Map<string, { v: string; n: number }>();
    const minus = new Map<string, { v: string; n: number }>();
    for (const l of f.plus) {
      const e = dependencyEntry(f.path, l.text);
      if (e && !plus.has(e[0])) plus.set(e[0], { v: e[1], n: l.n });
    }
    for (const l of f.minus) {
      const e = dependencyEntry(f.path, l.text);
      if (e && !minus.has(e[0])) minus.set(e[0], { v: e[1], n: l.n });
    }
    for (const [name, a] of plus) {
      const r = minus.get(name);
      if (!r)
        push({
          kind: "dependency_added",
          text: `Dependency added: ${name} ${a.v}`,
          path: f.path,
          line: a.n,
          method: "from the manifest diff",
        });
      else if (r.v !== a.v)
        push({
          kind: "dependency_bumped",
          text: `Dependency changed: ${name} ${r.v} → ${a.v}`,
          path: f.path,
          line: a.n,
          method: "from the manifest diff",
        });
    }
    for (const [name, r] of minus)
      if (!plus.has(name))
        push({
          kind: "dependency_removed",
          text: `Dependency removed: ${name} ${r.v}`,
          path: f.path,
          line: r.n,
          method: "from the manifest diff",
        });
  }

  // Route files and route registrations (pattern match, per framework).
  for (const f of authored) {
    if (TEST_PATH.test(f.path)) continue;
    const p = f.deleted ? (f.oldPath ?? f.path) : f.path;
    if (ROUTE_FILE.test(p))
      push({
        kind: "route",
        text: `Route file ${f.added ? "added" : f.deleted ? "deleted" : "changed"}: ${p}`,
        path: p,
        line: null,
        method: "pattern match",
      });
    const seen = new Map<string, { sign: "+" | "-" | "±"; n: number }>();
    const scan = (lines: DiffLine[], sign: "+" | "-") => {
      for (const l of lines)
        for (const r of ROUTE_LINES) {
          const m = l.text.match(r.re);
          if (!m) continue;
          const key = `${r.method(m)} ${r.path(m)}`;
          const prev = seen.get(key);
          seen.set(key, prev && prev.sign !== sign ? { sign: "±", n: prev.n } : { sign, n: l.n });
          break;
        }
    };
    scan(f.plus, "+");
    scan(f.minus, "-");
    for (const [key, s] of seen)
      push({
        kind: "route",
        text: `Route ${key} ${s.sign === "+" ? "added" : s.sign === "-" ? "removed" : "line changed"}`,
        path: p,
        line: s.sign === "-" ? null : s.n,
        method: "pattern match",
      });
  }

  // Changed source modules with no test in this change that imports them (by import text,
  // over every test file at the head).
  const testFiles = new Set(
    authored.filter((f) => !f.deleted && TEST_PATH.test(f.path)).map((f) => f.path),
  );
  for (const p of input.paths ?? []) {
    // numstat writes a rename as `old => new` or `dir/{old => new}/file`: the new side.
    const np = p.includes(" => ")
      ? p
          .replace(/\{[^{}]* => ([^{}]*)\}/g, "$1")
          .replace(/^.* => /, "")
          .replace(/\/\//g, "/")
      : p;
    if (TEST_PATH.test(np)) testFiles.add(np);
  }
  const modules = authored.filter(
    (f) =>
      !f.deleted &&
      !TEST_PATH.test(f.path) &&
      !MIGRATION_PATH.test(f.path) &&
      (JS_EXT.test(f.path) || PY_EXT.test(f.path)) &&
      !/\.d\.[cm]?ts$/.test(f.path) &&
      !CONFIG_PATH.test(f.path) &&
      moduleSpecifier(f.path) !== null,
  );
  if (modules.length > 0) {
    const checked = modules.slice(0, MAX_MODULES);
    if (modules.length > MAX_MODULES)
      notAnalysed.push(
        `${modules.length - MAX_MODULES} more changed modules: not checked for an importing test.`,
      );
    const importers = testImporters(input, checked);
    if (importers === null)
      notAnalysed.push(
        "Tests importing the changed modules: not analysed (the head commit could not be read).",
      );
    else if (typeof importers === "string")
      notAnalysed.push(`Tests importing the changed modules: not analysed (${importers}).`);
    else
      for (const m of checked) {
        const spec = moduleSpecifier(m.path)!;
        const by = importers.get(spec) ?? new Set<string>();
        const inChange = [...by].filter((t) => testFiles.has(t));
        if (inChange.length > 0) continue;
        push({
          kind: "untested_module",
          text: `${m.path} changed and no test file in this change imports it${by.size ? ` (${by.size} unchanged test ${by.size === 1 ? "file imports" : "files import"} it)` : " (no test file at the head imports it)"}`,
          path: m.path,
          line: null,
          method: "by import text",
        });
      }
  }

  // Downstream repos (the scope graph's depends_on edges).
  for (const d of input.downstream ?? [])
    push({
      kind: "downstream_repo",
      text: `${d.repo} may be affected: ${d.via}`,
      path: null,
      line: null,
      method: "scope graph depends_on",
    });

  for (const [kind, n] of counts)
    if (n > MAX_FACTS_PER_KIND)
      notAnalysed.push(
        `${n - MAX_FACTS_PER_KIND} more ${kind.replace(/_/g, " ")} facts: not listed.`,
      );
  if (input.truncated)
    notAnalysed.push("The diff was cut at its size cap: files past the cut are not analysed.");
  if (files.some((f) => OTHER_SOURCE_EXT.test(f.path) && !TEST_PATH.test(f.path)))
    notAnalysed.push(
      "Exports and test imports outside TypeScript, JavaScript and Python: not analysed.",
    );
  const lockfile = files.some((f) => LOCKFILES.has(base(f.path)));
  if (lockfile)
    notAnalysed.push(
      "Lockfile entries: not analysed (a lockfile changed, so resolved versions may have too).",
    );
  notAnalysed.push("Callers of changed symbols and their test coverage: not analysed.");
  const has = (...kinds: ImpactKind[]) => kinds.some((k) => counts.has(k));
  const none: string[] = [];
  // A cut diff proves no absence: what is past the cut was not read.
  if (!input.truncated) {
    if (!has("migration", "ddl")) none.push("migration or DDL");
    if (!has("config")) none.push("config");
    if (!has("env_added", "env_removed")) none.push("environment variable");
    if (!lockfile && !has("dependency_added", "dependency_removed", "dependency_bumped"))
      none.push("dependency");
  }
  return { facts, none, not_analysed: notAnalysed };
}

/**
 * For each changed module's specifier, the test files at the head whose text imports it
 * (one bounded `git grep`). null: no head to read; a string: why the grep failed.
 */
function testImporters(
  input: ImpactInput,
  modules: ReadonlyArray<{ path: string }>,
): Map<string, Set<string>> | null | string {
  if (!input.headSha || !input.runGit || !input.localPath) return null;
  const js = [
    ...new Set(modules.filter((m) => JS_EXT.test(m.path)).map((m) => moduleSpecifier(m.path)!)),
  ];
  const py = [
    ...new Set(modules.filter((m) => PY_EXT.test(m.path)).map((m) => moduleSpecifier(m.path)!)),
  ];
  const patterns: string[] = [];
  if (js.length) patterns.push("-e", `/(${js.map(ereEscape).join("|")})(\\.[cm]?[jt]sx?)?["'\`]`);
  if (py.length)
    patterns.push(
      "-e",
      `(from|import)[[:space:]]+[A-Za-z0-9_.]*(${py.map(ereEscape).join("|")})([^A-Za-z0-9_]|$)`,
    );
  // The repo's own grep config must not change the output shape this parses (a line or
  // column number, colour codes), so it is pinned here.
  const args = [
    "-c",
    "grep.lineNumber=false",
    "-c",
    "grep.column=false",
    "-c",
    "grep.fullName=false",
    "-c",
    "color.grep=never",
    "grep",
    "-I",
    "-o",
    "-z",
    "-E",
    ...patterns,
    input.headSha,
    "--",
    ":(glob)**/*.test.*",
    ":(glob)**/*.spec.*",
    ":(glob)**/test/**",
    ":(glob)**/tests/**",
    ":(glob)**/__tests__/**",
    ":(glob)**/test_*.py",
    ":(glob)**/*_test.py",
  ];
  let r;
  try {
    r = input.runGit(input.localPath, args, { maxBuffer: GREP_MAX_BUFFER });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  if (r.status === 1) return new Map();
  if (r.status !== 0) return (r.stderr.split("\n")[0] || "git grep failed").trim();
  // Output past the cap is unread: a module whose importer is past it would read as untested.
  if (r.truncated) return "the search output passed its size cap";
  const out = new Map<string, Set<string>>();
  const prefix = `${input.headSha}:`;
  for (const line of r.stdout.split("\n")) {
    const z = line.indexOf("\0");
    if (z < 0) continue;
    let file = line.slice(0, z);
    if (file.startsWith(prefix)) file = file.slice(prefix.length);
    const match = line.slice(z + 1);
    const names: string[] = [];
    const jm = match.match(/^\/([^/"'`]+?)(?:\.[cm]?[jt]sx?)?["'`]$/);
    if (jm) names.push(jm[1]!);
    else
      for (const n of py)
        if (
          new RegExp(
            `(?:^|[^A-Za-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Za-z0-9_]|$)`,
          ).test(match)
        )
          names.push(n);
    for (const n of names) {
      const set = out.get(n) ?? new Set<string>();
      set.add(file);
      out.set(n, set);
    }
  }
  return out;
}
