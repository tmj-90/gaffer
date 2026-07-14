import type { ContextPacket } from "../context/packet.js";

export interface AgentEvidence {
  acId?: string;
  evidenceType: string;
  summary: string;
  uri?: string;
  payload?: unknown;
}

export interface AgentRunResult {
  status: "submitted_for_review" | "blocked" | "completed";
  summary: string;
  evidence: AgentEvidence[];
  blockedReason?: string;
  loreSuggestions?: Array<{ title: string; summary: string; tags?: string[] }>;
  /**
   * Absolute paths the agent actually changed across all repos. The
   * implementation loop classifies these against the ticket's write/read roots
   * (FG-009): a change that lands on a read-only or outside repo fails the loop
   * before any clean delivery is recorded. Omitted/empty → nothing to verify.
   */
  changedPaths?: string[];
}

/**
 * Vendor-agnostic agent runtime boundary. The MVP ships a mock implementation;
 * real Claude Code / Cursor / script runtimes can be slotted in later without
 * touching the loop.
 *
 * `run` is async: a real runtime spawns an agent process (`claude -p`), which is
 * inherently asynchronous. The mock resolves immediately. (tick.sh migration P1 —
 * the seam went async so a live `ClaudeAgentRuntime` spawn can slot in behind it.)
 */
export interface AgentRuntime {
  run(packet: ContextPacket): Promise<AgentRunResult>;
}

/**
 * No-op mock runtime for the MVP. Produces one evidence item per AC and reports
 * the work as ready for review — enough to exercise the loop end-to-end.
 */
export class MockAgentRuntime implements AgentRuntime {
  constructor(private readonly result?: Partial<AgentRunResult>) {}

  async run(packet: ContextPacket): Promise<AgentRunResult> {
    const evidence: AgentEvidence[] =
      this.result?.evidence ??
      packet.acceptanceCriteria.map((ac) => ({
        acId: ac.id,
        evidenceType: "note",
        summary: `Mock agent satisfied AC: ${ac.text}`,
      }));
    return {
      status: this.result?.status ?? "submitted_for_review",
      summary: this.result?.summary ?? `Mock implementation for ticket #${packet.ticket.number}.`,
      evidence,
      ...(this.result?.blockedReason ? { blockedReason: this.result.blockedReason } : {}),
      ...(this.result?.loreSuggestions ? { loreSuggestions: this.result.loreSuggestions } : {}),
      ...(this.result?.changedPaths ? { changedPaths: this.result.changedPaths } : {}),
    };
  }
}
