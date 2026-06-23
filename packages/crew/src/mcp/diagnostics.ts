import { CrewError } from "../util/errors.js";

/**
 * Turn a {@link CrewError} thrown during MCP server startup into an
 * actionable, multi-line diagnostic. MCP clients typically surface only a bare
 * "server failed to start" on a non-zero exit, so the message we write to stderr
 * is the agent operator's only clue. Every known startup failure code maps to a
 * concrete next step; unknown codes fall back to `crew doctor`.
 *
 * Pure (string in, string out) so the bin entrypoint stays a thin shell and the
 * full code→guidance mapping is unit-testable without spawning a subprocess.
 */
export function diagnoseStartupError(err: CrewError): string {
  const head = `  reason (${err.code}): ${err.message}`;
  const tips: Record<string, string[]> = {
    CONFIG_NOT_FOUND: [
      "Point the server at a config: `crew-mcp -c /path/to/crew.yaml`",
      "or set CREW_CONFIG, or run `crew init` to scaffold one.",
    ],
    INVALID_CONFIG: [
      "Fix the validation issues listed above in crew.yaml / safety_policy.yaml.",
      "Run `crew doctor` for a full readiness check once it parses.",
    ],
    DISPATCH_UNAVAILABLE: ["Build the dispatch package first: `pnpm -C ../dispatch build`."],
  };
  const bullets = tips[err.code] ?? ["Run `crew doctor` for a full readiness check."];
  return [head, ...bullets.map((b) => `  • ${b}`)].join("\n");
}
