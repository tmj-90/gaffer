import { renderDeliveryPrompt, type DeliveryPromptInputs } from "./deliveryPrompt.js";
import { renderMcpRuntimeConfig, type McpRuntimeInputs } from "./mcpConfig.js";

// =====================================================================
// Delivery-context assembly umbrella (P1b, docs/tick-sh-runtime-migration.md).
// ---------------------------------------------------------------------
// The seam P2's live ClaudeAgentRuntime.run() will call: given pre-resolved
// inputs (scope/worktrees/skills stay with the runner until their own
// slices), produce the two artifacts the live `claude -p` launch consumes —
// the delivery prompt and the rendered per-tick MCP runtime config. Pure and
// fail-closed (both renderers throw on invalid inputs; see their modules).
// =====================================================================

/** The assembled delivery context: what the live agent launch consumes. */
export interface DeliveryContext {
  /** The full delivery prompt (fresh or resume variant). */
  prompt: string;
  /** The rendered per-tick .mcp.json content (carries the claim token). */
  mcpRuntimeJson: string;
}

/**
 * Assemble the delivery context for one ticket: prompt + MCP runtime config.
 *
 * @param inputs      Pre-resolved prompt inputs (see DeliveryPromptInputs).
 * @param mcpTemplate The RAW runner/.mcp.json template text.
 * @param mcp         The five runtime values substituted into the template.
 */
export function assembleDeliveryContext(
  inputs: DeliveryPromptInputs,
  mcpTemplate: string,
  mcp: McpRuntimeInputs,
): DeliveryContext {
  return {
    prompt: renderDeliveryPrompt(inputs),
    mcpRuntimeJson: renderMcpRuntimeConfig(mcpTemplate, mcp),
  };
}
