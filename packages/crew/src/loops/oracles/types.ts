/**
 * Tool-backed scan ORACLES. Where a heuristic grep guesses, an oracle consults a
 * real analysis tool (tsc / eslint / knip / semgrep) and returns precise,
 * structured findings. Oracles are strictly LOCAL-FIRST and OPTIONAL: a tool that
 * is not installed makes its oracle report `available: false`, and the calling
 * loop falls back to the existing heuristic path. A tool that errors, times out,
 * or emits garbage yields ZERO findings (never a crash) — the idle tick must
 * always survive.
 */

/** Severity of a normalized finding, ordered least → most severe. */
export type OracleSeverity = "info" | "warning" | "error";

/**
 * One precise finding emitted by a tool oracle. Always carries a repo-relative
 * `file` and 1-based `line`; `endLine` is optional. `rule` is the tool's rule id
 * (e.g. an ESLint rule name or a TS error code), and `message` is human-readable.
 */
export interface OracleFinding {
  /** Repo-relative path (never absolute — normalized by the adapter). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 1-based end line, when the tool reports a span. */
  endLine?: number;
  /** Tool rule id: ESLint rule, TS error code (`TS2345`), semgrep check id, etc. */
  rule: string;
  severity: OracleSeverity;
  message: string;
}

/**
 * The result of consulting one oracle. Either the tool was unavailable (so the
 * loop must fall back to its heuristic), or it ran and produced a (possibly
 * empty) list of findings. `unavailable` carries a short reason for the audit
 * log; `findings: []` from an available tool means "ran clean", which is
 * distinct from "tool absent".
 */
export type OracleResult =
  | { available: false; reason: string }
  | { available: true; findings: OracleFinding[] };

/** A normalized adapter over one analysis tool. */
export interface Oracle {
  /** Stable id for logging / the path-taken audit (`tsc`, `eslint`, …). */
  readonly id: string;
  /**
   * Consult the tool for `root`. MUST NOT throw: tool-absent →
   * `{ available: false }`; tool ran (even with a non-zero exit / garbage
   * output) → `{ available: true, findings }` with defensively-parsed findings.
   */
  consult(root: string): OracleResult;
}
