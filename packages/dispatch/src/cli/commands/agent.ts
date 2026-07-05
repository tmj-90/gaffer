import type { Command } from "commander";

import type { Actor } from "../../domain/types.js";
import { cliActor, open, printJson, validateTtl } from "../shared.js";

export function registerAgent(program: Command): void {
  // --- Agent / claim / evidence flow (mirrors the MCP tools) -----------------

  const agent = program.command("agent").description("Agent commands");
  agent
    .command("register")
    .description("Register an agent")
    .option("-n, --name <name>", "display name")
    .option("--max-risk <level>", "max risk", "medium")
    .option("--cap <capability...>", "capabilities", [])
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const a = wg.registerAgent(
        { display_name: opts.name, max_risk: opts.maxRisk, capabilities: opts.cap },
        cliActor(),
      );
      printJson({ ok: true, agent: { id: a.id, display_name: a.display_name } });
      wg.db.close();
    });

  program
    .command("claim")
    .description("Claim the next ready ticket for an agent")
    .requiredOption("-a, --agent <id>", "agent id")
    .option("--ttl <seconds>", "claim TTL seconds", (v) => Number(v), 900)
    .action((opts, cmd) => {
      validateTtl(opts.ttl);
      const wg = open(cmd.optsWithGlobals());
      const res = wg.claimNextTicket(
        { agentId: opts.agent, ttlSeconds: opts.ttl },
        { type: "agent", id: opts.agent },
      );
      printJson(res ? { ok: true, ...res } : { ok: true, claimed: null });
      wg.db.close();
    });

  program
    .command("claim-ticket <ref>")
    .description("Claim a CHOSEN ready ticket for an agent (same eligibility as claim)")
    .requiredOption("-a, --agent <id>", "agent id")
    .option("--ttl <seconds>", "claim TTL seconds", (v) => Number(v), 900)
    .option("--cap <capability...>", "agent capabilities to apply", [])
    .action((ref, opts, cmd) => {
      validateTtl(opts.ttl);
      const wg = open(cmd.optsWithGlobals());
      const res = wg.claimTicket(
        { ticket_id: ref, agent_id: opts.agent, ttl_seconds: opts.ttl, capabilities: opts.cap },
        { type: "agent", id: opts.agent },
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  program
    .command("human-claim <ref>")
    .description(
      'TRACK-2b: take a ready ticket "by hand" (I\'ll do this myself). Moves it ready -> in_progress owned by you; the factory selection loop then structurally skips it.',
    )
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const res = wg.humanClaimTicket(ref, cliActor());
      printJson({ ok: true, ...res, human_owned: true });
      wg.db.close();
    });

  program
    .command("human-release <ref>")
    .description(
      "TRACK-2b: hand a by-hand ticket back to the queue (in_progress -> ready, clearing your ownership marker so agents can pick it up).",
    )
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const res = wg.humanReleaseTicket(ref, cliActor());
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  program
    .command("heartbeat <token>")
    .description("Extend an active claim lease")
    .action((token, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson({ ok: true, ...wg.heartbeat(token) });
      wg.db.close();
    });

  program
    .command("evidence <ref>")
    .description("Record evidence against a claimed ticket")
    .requiredOption("--token <token>", "claim token")
    .requiredOption("--type <type>", "evidence type (e.g. test_output, manual_note)")
    .requiredOption("--summary <text>", "evidence summary")
    .option("--ac <acId>", "acceptance criterion id")
    .option("--uri <uri>", "evidence uri")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const t = wg.resolveTicket(ref);
      const res = wg.recordEvidence(
        {
          claimToken: opts.token,
          ticket_id: t.id,
          ac_id: opts.ac,
          evidence_type: opts.type,
          summary: opts.summary,
          uri: opts.uri,
        },
        { type: "agent" },
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  program
    .command("submit <ref>")
    .description("Submit a claimed ticket for review")
    .requiredOption("--token <token>", "claim token")
    .option("--reason <text>", "reason")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const t = wg.resolveTicket(ref);
      const res = wg.submitForReview(
        { claimToken: opts.token, ticket_id: t.id, reason: opts.reason },
        { type: "agent" },
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  program
    .command("runner-release <ref>")
    .description(
      "RUNNER-OWNED-BOOKKEEPING: release/park a runner-held delivery claim. --to ready (failure/retry), refining (legacy park), or blocked (rework loop exhausted — VISIBLE column). --token releases the matching claim; omit it for a tokenless resumed delivery.",
    )
    .requiredOption("--to <status>", "ready|refining|blocked")
    .option("--token <token>", "claim token to release (optional for a resumed delivery)")
    .option("--reason <text>", "reason recorded on the transition + card")
    .option("--reason-code <code>", "structured reason code, e.g. rework_exhausted")
    .option("--attempt <n>", "rework attempt number reached (paired with --max)")
    .option("--max <n>", "rework attempt ceiling (GAFFER_MAX_DELIVERY_ATTEMPTS)")
    .action((ref, opts, cmd) => {
      if (opts.to !== "ready" && opts.to !== "refining" && opts.to !== "blocked") {
        throw new Error("--to must be 'ready', 'refining', or 'blocked'");
      }
      const wg = open(cmd.optsWithGlobals());
      const t = wg.resolveTicket(ref);
      const res = wg.runnerRelease(
        {
          ticket_id: t.id,
          to: opts.to,
          claimToken: opts.token,
          reason: opts.reason,
          ...(opts.reasonCode ? { reasonCode: opts.reasonCode } : {}),
          ...(opts.attempt !== undefined ? { attempt: Number(opts.attempt) } : {}),
          ...(opts.max !== undefined ? { maxAttempts: Number(opts.max) } : {}),
        },
        { type: "system" },
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  program
    .command("runner-rework <ref>")
    .description(
      "RUNNER-OWNED-BOOKKEEPING: record a live rework attempt on an in-flight delivery (stays in_progress). Surfaces 'reworking · attempt N/M' + the latest failure on the board card between retries.",
    )
    .requiredOption("--attempt <n>", "current rework attempt (1-based)")
    .requiredOption("--max <n>", "rework attempt ceiling")
    .option("--reason <text>", "latest failure detail shown on the card (short)")
    .option("--gate <name>", "the gate that failed (e.g. tests, definition-of-done)")
    .option(
      "--failure <text>",
      "the FULL distilled failing test + assertion/stack, appended to the durable failure trail (falls back to --reason)",
    )
    .option("--ac <id>", "the acceptance criterion being worked toward, when known")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const t = wg.resolveTicket(ref);
      const res = wg.recordReworkAttempt(
        {
          ticket_id: t.id,
          attempt: Number(opts.attempt),
          maxAttempts: Number(opts.max),
          reason: opts.reason ?? "reworking",
          ...(opts.gate ? { gate: String(opts.gate) } : {}),
          ...(opts.failure ? { distilledFailure: String(opts.failure) } : {}),
          ...(opts.ac ? { acId: String(opts.ac) } : {}),
        },
        { type: "system" },
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  program
    .command("delivery-artifact <ref>")
    .description("Record where a ticket was delivered (branch/PR). Persists onto the ticket.")
    .option("--token <token>", "claim token (required for agent actors)")
    .option("--branch <name>", "branch name")
    .option("--pr <url>", "pull request url")
    .option("--commit <sha>", "commit sha")
    .option("--diff <text>", "diff summary")
    .option("--as <actor>", "actor type: human|admin|system|agent", "human")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor =
        opts.as === "agent"
          ? { type: "agent" }
          : opts.as === "system"
            ? { type: "system" }
            : opts.as === "admin"
              ? { type: "admin", id: process.env.USER ?? "cli" }
              : cliActor();
      const res = wg.recordDeliveryArtifact(
        {
          ticket_id: ref,
          claim_token: opts.token,
          branch_name: opts.branch,
          pr_url: opts.pr,
          commit: opts.commit,
          diff_summary: opts.diff,
        },
        actor,
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  program
    .command("block <ref>")
    .description("Mark a ticket blocked")
    .requiredOption("--reason <text>", "reason")
    .option("--token <token>", "claim token")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const t = wg.resolveTicket(ref);
      const res = wg.markBlocked(
        { claimToken: opts.token, ticket_id: t.id, reason: opts.reason },
        { type: "agent" },
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });
}

// --- System delivery evidence (no claim token; system actor only) ----------
// Registered AFTER the review group so the root --help command order is
// preserved (these two top-level commands follow review/wont-do/reopen in the
// original single-file CLI).
export function registerAgentSystem(program: Command): void {
  program
    .command("attach-evidence <ref>")
    .description("Attach delivery evidence as the system/factory actor (no claim token)")
    .requiredOption("--type <type>", "evidence type (e.g. diff_summary, pull_request)")
    .requiredOption("--summary <text>", "evidence summary")
    .option("--uri <uri>", "evidence uri")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const res = wg.attachDeliveryEvidence(
        ref,
        { evidenceType: opts.type, summary: opts.summary, uri: opts.uri },
        { type: "system" },
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  program
    .command("expire-claims")
    .description("Expire stale claims (system recovery)")
    .action((_opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson({ ok: true, ...wg.expireStaleClaims({ type: "system" }) });
      wg.db.close();
    });
}
