// Type declaration for the canonical dangerous-command deny list (S-3). Lets the
// crew TypeScript parity test consume the shared `.mjs` source with full types
// across the .mjs/.ts boundary without weakening it to `any`. The runtime hook
// (plain ESM) ignores this file; it exists purely so `tsc` can type the import.

/** One dangerous-command deny rule shared by the runtime hook and the parity test. */
export interface DangerousCommandRule {
  /** RegExp tested against the raw command string (the runtime deny rule). */
  readonly re: RegExp;
  /** Human-readable reason surfaced on block. */
  readonly why: string;
  /** Tags the one rule the greenfield bootstrap allowance may relax. */
  readonly install?: boolean;
  /** A representative command that MUST match `re` (parity-test input). */
  readonly example: string;
  /** Whether the crew TS classifier is EXPECTED to flag `example`. */
  readonly crewFlags: boolean;
}

export declare const DANGEROUS_COMMANDS: ReadonlyArray<DangerousCommandRule>;
