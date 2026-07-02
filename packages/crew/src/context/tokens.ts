import { createHash } from "node:crypto";

import type { ContextPacket } from "./packet.js";

/**
 * Token accounting for context packets. The factory has no model tokenizer in
 * process, so we use the well-established ~4-characters-per-token heuristic over
 * the JSON-serialised payload. It is deterministic, dependency-free, and good
 * enough to *measure and compare* packet cost across tickets — which is what the
 * token-hygiene pass needs (relative size + regression detection), not exact
 * billing parity with a specific vendor tokenizer.
 */

/** Average characters per token for mixed English/code (industry rule of thumb). */
const CHARS_PER_TOKEN = 4;

/** Estimate the token cost of an arbitrary JSON-serialisable value. */
export function estimateTokens(value: unknown): number {
  if (value === undefined) return 0;
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Per-section token breakdown of a context packet plus the rolled-up total. */
export interface PacketTokenReport {
  readonly total: number;
  readonly bySection: Readonly<Record<PacketSection, number>>;
}

export type PacketSection =
  | "ticket"
  | "acceptanceCriteria"
  | "repositories"
  | "workScope"
  | "verification"
  | "relevantLore"
  | "scopedLore"
  | "productContext"
  | "skills"
  | "forbiddenActions"
  | "constraints"
  | "evidenceExpectations";

/**
 * The content-bearing fields of a packet, measured independently so a caller can
 * see *where* the tokens go (lore vs skills vs repos) and trim the heaviest
 * section. Excludes the packet's own `tokens`/`fingerprint` metadata to avoid
 * measuring the measurement.
 */
export function measurePacket(packet: ContextPacket): PacketTokenReport {
  const bySection: Record<PacketSection, number> = {
    ticket: estimateTokens(packet.ticket),
    acceptanceCriteria: estimateTokens(packet.acceptanceCriteria),
    repositories: estimateTokens(packet.repositories),
    workScope: estimateTokens(packet.workScope),
    verification: estimateTokens(packet.verification),
    relevantLore: estimateTokens(packet.relevantLore),
    scopedLore: estimateTokens(packet.scopedLore),
    productContext: estimateTokens(packet.productContext),
    skills: estimateTokens(packet.skills),
    forbiddenActions: estimateTokens(packet.forbiddenActions),
    constraints: estimateTokens(packet.constraints),
    evidenceExpectations: estimateTokens(packet.evidenceExpectations),
  };
  const total = Object.values(bySection).reduce((sum, n) => sum + n, 0);
  return { total, bySection };
}

/**
 * A stable content fingerprint of a packet's payload, used to detect when the
 * context handed to an agent is unchanged from a previous tick so it need not be
 * re-sent. Hashes the content sections only — never the `tokens`/`fingerprint`
 * metadata — so an unchanged packet always yields the same fingerprint.
 */
export function packetFingerprint(packet: ContextPacket): string {
  const payload = JSON.stringify({
    factory: packet.factory,
    ticket: packet.ticket,
    acceptanceCriteria: packet.acceptanceCriteria,
    repositories: packet.repositories,
    workScope: packet.workScope,
    verification: packet.verification,
    relevantLore: packet.relevantLore,
    scopedLore: packet.scopedLore,
    productContext: packet.productContext,
    skills: packet.skills,
    forbiddenActions: packet.forbiddenActions,
    constraints: packet.constraints,
    evidenceExpectations: packet.evidenceExpectations,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
