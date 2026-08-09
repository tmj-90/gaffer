import { CrewError } from "../../util/errors.js";

// =====================================================================
// MCP runtime-config render — TS port of the tick.sh `.mcp.json` sed
// substitution (P1b context assembly, docs/tick-sh-runtime-migration.md).
// ---------------------------------------------------------------------
// tick.sh renders a per-tick RUNTIME copy of runner/.mcp.json by sed-
// substituting five ${NAME} placeholders (tick.sh:1839–1840, bootstrap
// twin at 912–913), escaping the replacement via _gaffer_sed_repl
// (factory.config.sh) — whose whole point is a LITERAL substitution.
//
// PARITY NOTES:
//  - The bash sed runs over the RAW template text, so placeholders inside
//    the template's `_comment` prose are substituted too. This renderer is
//    therefore a textual replaceAll over the raw template, NOT a JSON-field-
//    wise substitution.
//  - `split(token).join(value)` is used instead of String.replace so a value
//    containing `$&`/`$'` (legal in paths/tokens) is never interpreted as a
//    replacement pattern.
//  - An empty claimToken is VALID (a resumed delivery / dry-run holds no
//    token; the MCP server treats "" as "no token").
//
// FAIL-CLOSED: unlike the bash path (which trusts sed), the render throws a
// CrewError when the result is not valid JSON, is missing the dispatch or
// memory server entry, or still contains an unsubstituted ${NAME} placeholder
// (e.g. a misspelled placeholder in a drifted template) — a broken MCP config
// must never reach a live agent launch.
// =====================================================================

/** The five runtime values substituted into the .mcp.json template. */
export interface McpRuntimeInputs {
  dispatchDb: string;
  memoryDb: string;
  dispatchMcpBin: string;
  memoryMcpBin: string;
  /** May legitimately be "" (resumed delivery / dry-run — no runner-held claim). */
  claimToken: string;
}

const PLACEHOLDERS: ReadonlyArray<[token: string, key: keyof McpRuntimeInputs]> = [
  ["${DISPATCH_DB}", "dispatchDb"],
  ["${MEMORY_DB}", "memoryDb"],
  ["${DISPATCH_MCP_BIN}", "dispatchMcpBin"],
  ["${MEMORY_MCP_BIN}", "memoryMcpBin"],
  ["${GAFFER_CLAIM_TOKEN}", "claimToken"],
];

const LEFTOVER_PLACEHOLDER = /\$\{[A-Z_]+\}/;

/**
 * Render the runtime MCP config from the raw template text. Literal textual
 * substitution of the five `${NAME}` tokens, then fail-closed validation.
 *
 * @throws CrewError (`INVALID_MCP_TEMPLATE`) when the rendered result is not
 *   valid JSON, lacks `mcpServers.dispatch`/`mcpServers.memory`, or still
 *   carries an unsubstituted `${NAME}` placeholder.
 */
export function renderMcpRuntimeConfig(template: string, inputs: McpRuntimeInputs): string {
  let rendered = template;
  for (const [token, key] of PLACEHOLDERS) {
    rendered = rendered.split(token).join(inputs[key]);
  }

  const leftover = LEFTOVER_PLACEHOLDER.exec(rendered);
  if (leftover) {
    throw new CrewError(
      "INVALID_MCP_TEMPLATE",
      `MCP runtime config still contains an unsubstituted placeholder after render: ${leftover[0]}`,
      { placeholder: leftover[0] },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch (err) {
    throw new CrewError(
      "INVALID_MCP_TEMPLATE",
      `MCP runtime config is not valid JSON after render: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const servers =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)["mcpServers"]
      : undefined;
  const hasServer = (name: string): boolean =>
    servers !== null &&
    typeof servers === "object" &&
    typeof (servers as Record<string, unknown>)[name] === "object" &&
    (servers as Record<string, unknown>)[name] !== null;
  if (!hasServer("dispatch") || !hasServer("memory")) {
    throw new CrewError(
      "INVALID_MCP_TEMPLATE",
      "MCP runtime config must define both mcpServers.dispatch and mcpServers.memory",
    );
  }
  return rendered;
}
