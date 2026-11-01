import type { Command } from "commander";
import { z } from "zod";

import type { Actor } from "../../domain/types.js";
import { TICKET_STATUSES } from "../../domain/types.js";
import type { AutonomyPolicyGate } from "../../repositories/autonomyPolicyRepository.js";
import { DispatchError } from "../../util/errors.js";
import {
  cliActor,
  open,
  parseAs,
  printJson,
  testerActor,
  validateTtl,
  warnLandedAlready,
} from "../shared.js";

export function registerTicket(program: Command): void {
  const ticket = program.command("ticket").description("Ticket commands");

  ticket
    .command("create")
    .description("Create a draft ticket")
    .requiredOption("-t, --title <title>", "ticket title")
    .option("-d, --description <text>", "description", "")
    .option("-p, --policy <pack>", "policy pack", "solo_loose")
    .option("--risk <level>", "risk level", "medium")
    .option("--priority <n>", "priority", (v) => Number(v), 0)
    .option("--bootstrap", "mark as a greenfield (create-a-repo) bootstrap ticket", false)
    .option(
      "--budget <usd>",
      "per-ticket cost ceiling in USD (all agent spend on the ticket)",
      (v) => Number(v),
    )
    .action((opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const t = wg.createTicket(
        {
          title: opts.title,
          description: opts.description,
          policy_pack: opts.policy,
          risk_level: opts.risk,
          priority: opts.priority,
          bootstrap: opts.bootstrap,
          ...(opts.budget !== undefined ? { delivery_budget_usd: opts.budget } : {}),
        },
        cliActor(),
      );
      printJson({
        ok: true,
        ticket: {
          number: t.number,
          id: t.id,
          status: t.status,
          bootstrap: t.bootstrap === 1,
          delivery_budget_usd: t.delivery_budget_usd,
        },
      });
      wg.db.close();
    });

  ticket
    .command("budget <ref>")
    .description("Set (or clear) a ticket's per-ticket cost ceiling (USD)")
    .option(
      "--usd <amount>",
      "USD ceiling for this ticket's cumulative agent spend (delivery, review, clarify, …)",
      (v) => Number(v),
    )
    .option("--clear", "clear the per-ticket budget (fall back to the factory-wide budget)", false)
    .action((ref, opts, cmd) => {
      const value = opts.clear ? null : opts.usd;
      if (value === undefined) {
        // A structured failure (stderr JSON, exit 1) like every other CLI error — it
        // used to print {ok:false} on stdout and exit 0, invisible to scripts.
        throw new DispatchError("VALIDATION_ERROR", "provide --usd <amount> or --clear");
      }
      const wg = open(cmd.optsWithGlobals());
      const t = wg.setDeliveryBudget({ ticket: ref, delivery_budget_usd: value }, cliActor());
      printJson({
        ok: true,
        ticket: { number: t.number, id: t.id, delivery_budget_usd: t.delivery_budget_usd },
      });
      wg.db.close();
    });

  ticket
    .command("ready <ref>")
    .description("Mark a ticket ready (evaluates policy)")
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const t = wg.resolveTicket(ref);
      const res = wg.markReady(t.id, cliActor());
      printJson({ ok: true, status: res.ticket.status, event: res.eventId, policy: res.policy });
      wg.db.close();
    });

  ticket
    .command("move <ref> <to>")
    .description("Board move: send a ticket to another status (e.g. un-ready: ready -> draft)")
    .option("--admin", "act as an admin actor", false)
    .action((ref, to, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor = opts.admin
        ? { type: "admin", id: process.env.USER ?? "cli" }
        : cliActor();
      const res = wg.moveTicket(ref, to, actor);
      printJson({ ok: true, status: res.ticket.status, event: res.eventId });
      wg.db.close();
    });

  ticket
    .command("show <ref>")
    .description("Show a ticket with AC, repos and events")
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(wg.view(ref));
      wg.db.close();
    });

  ticket
    .command("diff <ref>")
    .description(
      "The delivery diff per write repo, with the head commit (`headSha`) it was computed " +
        "against. --heads prints only `repo=sha` lines — the values `review approve --commit` takes.",
    )
    .option("--heads", "print only one repo=sha line per write repo", false)
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const d = wg.ticketDiff(wg.resolveTicket(ref).id);
      if (opts.heads) {
        for (const r of d.repos) if (r.headSha) process.stdout.write(`${r.repo}=${r.headSha}\n`);
      } else {
        printJson(d);
      }
      wg.db.close();
    });

  ticket
    .command("landing <ref>")
    .description(
      "PER-REPOSITORY LANDING: each write repo's approved commit and whether it has landed. " +
        "A ticket is done only when every approved revision has landed.",
    )
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      // `approval`: the approval a landing acts on (REVOCATION-SAFE LANDING) — the merge
      // runner reads it before its gates and hands it back to landing-begin.
      printJson({ ok: true, ...wg.landingStatus(ref), approval: wg.landingApproval(ref) });
      wg.db.close();
    });

  ticket
    .command("landing-begin <ref>")
    .description(
      "REVOCATION-SAFE LANDING: immediately before a default branch moves, re-check that the " +
        "ticket is still ready_for_merge on the same approval with green required CI, and record " +
        "the landing as started. Refuses (STATE_CONFLICT) when it was revoked meanwhile: land " +
        "nothing. The merge paths call this per repo. System/admin only.",
    )
    .requiredOption("--repo <repo>", "repo name or id")
    .requiredOption("--commit <sha>", "the approved commit about to land")
    .option("--approval <id>", "the approval the landing started on (`ticket landing` .approval)")
    .option("--via <how>", "local | pr")
    .option("--as <actor>", "actor type: system|admin", "system")
    .action((ref, opts, cmd) => {
      const as = parseAs(opts.as, ["system", "admin"] as const);
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor =
        as === "admin" ? { type: "admin", id: process.env.USER ?? "cli" } : { type: "system" };
      const res = wg.beginLanding(
        ref,
        {
          repo: String(opts.repo),
          commit: String(opts.commit),
          ...(opts.approval ? { approval: String(opts.approval) } : {}),
          ...(opts.via ? { via: String(opts.via) } : {}),
        },
        actor,
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  ticket
    .command("record-landing <ref>")
    .description(
      "PER-REPOSITORY LANDING: record that one write repo's approved commit reached its " +
        "default branch (the merge paths call this per repo). System/admin only; idempotent.",
    )
    .requiredOption("--repo <repo>", "repo name or id")
    .requiredOption("--commit <sha>", "the approved commit that landed")
    .option(
      "--via <how>",
      "local | git-verified (checked against the default branch) | pr | pr-stale (upstream)",
    )
    .option("--as <actor>", "actor type: system|admin", "system")
    .action((ref, opts, cmd) => {
      const as = parseAs(opts.as, ["system", "admin"] as const);
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor =
        as === "admin" ? { type: "admin", id: process.env.USER ?? "cli" } : { type: "system" };
      const res = wg.recordLanding(
        ref,
        { repo: String(opts.repo), commit: String(opts.commit), via: opts.via },
        actor,
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  ticket
    .command("record-tester-replay <ref>")
    .description(
      "TESTER REPLAY: record that the independent tester's test files passed on the revision " +
        "that landed (the runner's landing path calls this once the merge gate replayed them on " +
        "the merge candidate). System only; idempotent per landed revision.",
    )
    .requiredOption("--commit <sha>", "the landed revision (the gated merge commit)")
    .requiredOption("--pin <sha>", "the tested commit whose assertions were replayed")
    .option("--files-json <json>", "JSON array of the tester's test files that ran", "[]")
    .option("--repo <repo>", "repo name or id (default: the ticket's primary repo)")
    .option("--via <how>", "local | pr")
    .option("--note <text>", "why these (or no) tester files were replayed")
    .option("--as <actor>", "actor type: system", "system")
    .action((ref, opts, cmd) => {
      parseAs(opts.as, ["system"] as const);
      let files: unknown;
      try {
        files = JSON.parse(String(opts.filesJson));
      } catch {
        files = null;
      }
      if (!Array.isArray(files) || !files.every((f) => typeof f === "string")) {
        throw new DispatchError("VALIDATION_ERROR", "--files-json must be a JSON array of paths");
      }
      const wg = open(cmd.optsWithGlobals());
      const res = wg.recordTesterReplay(
        ref,
        {
          commit: String(opts.commit),
          pin: String(opts.pin),
          files: files as string[],
          repo: opts.repo ? String(opts.repo) : undefined,
          via: opts.via ? String(opts.via) : undefined,
          note: opts.note ? String(opts.note) : undefined,
        },
        { type: "system" },
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  ticket
    .command("dossier <ref>")
    .description(
      "DELIVERY-DOSSIER: assemble the tamper-evident evidence artifact for a " +
        "delivered ticket from existing recorded state, and record its content hash " +
        "against the control plane (a `ticket.dossier_recorded` event). --markdown " +
        "renders the human-readable view; --no-record previews without writing the event.",
    )
    .option("--markdown", "render the human-readable Markdown dossier", false)
    .option("--no-record", "preview only — do NOT record the tamper-evidence event")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      try {
        // `--no-record` (Commander sets opts.record=false) is a pure read; otherwise
        // record the ONE tamper-evidence event (idempotent when unchanged).
        if (opts.record === false) {
          const dossier = wg.dossier(ref);
          if (opts.markdown) process.stdout.write(`${wg.dossierSvc.renderMarkdown(dossier)}\n`);
          else printJson({ ok: true, recorded: false, dossier });
        } else {
          const { dossier, eventId } = wg.recordDossier(ref, cliActor());
          if (opts.markdown) process.stdout.write(`${wg.dossierSvc.renderMarkdown(dossier)}\n`);
          else printJson({ ok: true, recorded: eventId !== null, event: eventId, dossier });
        }
      } finally {
        wg.db.close();
      }
    });

  ticket
    .command("auto-decision <ref>")
    .description(
      "GRADUATED-AUTONOMY: read-only ship decision the AFK runner consults — is `auto` " +
        "permitted for THIS ticket at --gate (approve|merge)? Reuses isAutonomyAllowed " +
        "(env floor OR an earned per-repo/risk policy). Prints allow|deny. No mutation.",
    )
    .requiredOption("--gate <gate>", "approve | merge")
    .action((ref, opts, cmd) => {
      const gate = opts.gate as string;
      if (gate !== "approve" && gate !== "merge") {
        throw new DispatchError("VALIDATION_ERROR", "--gate must be 'approve' or 'merge'.", {
          gate,
        });
      }
      const wg = open(cmd.optsWithGlobals());
      const ticket = wg.resolveTicket(ref);
      const decision = wg.autonomyGateDecision(ticket, gate as AutonomyPolicyGate);
      printJson({ ok: true, number: ticket.number, ...decision });
      wg.db.close();
    });

  ticket
    .command("list")
    .description("List tickets")
    .option("-s, --status <status>", "filter by status")
    .option(
      "--claimable",
      "only tickets whose dependencies are all done (what a claim can take); the runner's candidate scan applies its limit to this list",
      false,
    )
    .action((opts, cmd) => {
      if (opts.status !== undefined) {
        const statusResult = z.enum(TICKET_STATUSES).safeParse(opts.status);
        if (!statusResult.success) {
          throw new DispatchError(
            "VALIDATION_ERROR",
            `Invalid status: "${opts.status}". Allowed: ${TICKET_STATUSES.join(", ")}.`,
            { status: opts.status, allowed: TICKET_STATUSES },
          );
        }
      }
      const wg = open(cmd.optsWithGlobals());
      // SCHEDULER: a dependant whose prerequisite is not done can never be claimed. The
      // runner's scan used to walk them first (priority order) and hit its limit before
      // reaching the low-priority prerequisite that would unblock them all — forever.
      const rows = wg
        .list(opts.status)
        .filter(
          (t) =>
            opts.claimable !== true ||
            wg.ticketDependencies.unsatisfiedDependencies(t.id).length === 0,
        );
      printJson(
        // `acceptance` rides along so the runner's tester lane can pick an epic's
        // acceptance ticket out of in_testing even with GAFFER_TESTING off.
        rows.map((t) => ({
          number: t.number,
          status: t.status,
          title: t.title,
          id: t.id,
          acceptance: t.acceptance ?? 0,
        })),
      );
      wg.db.close();
    });

  ticket
    .command("approve-ready <ref>")
    .description("Grant the human ready-approval a regulated ticket needs before going ready")
    .option("--admin", "act as an admin actor", false)
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor = opts.admin
        ? { type: "admin", id: process.env.USER ?? "cli" }
        : cliActor();
      const res = wg.grantReadyApproval(ref, actor);
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  ticket
    .command("set-reviewer <ref>")
    .description("Assign the reviewer a factory_strict/regulated ticket needs before going ready")
    .requiredOption("--reviewer <id>", "reviewer id")
    .option("--admin", "act as an admin actor", false)
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor = opts.admin
        ? { type: "admin", id: process.env.USER ?? "cli" }
        : cliActor();
      const res = wg.assignReviewer(ref, opts.reviewer, actor);
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  ticket
    .command("reopen-for-review <ref>")
    .description(
      "Re-open a done ticket for review (done -> in_review) after the auto-merge " +
        "resolver fixed a conflict on the branch — records the resolution for re-review",
    )
    .requiredOption("--reason <reason>", "short why the ticket is being reopened")
    .requiredOption("--resolution <summary>", "resolver's summary of what was reconciled")
    .option("--as <actor>", "actor type: system|admin", "system")
    .action((ref, opts, cmd) => {
      const as = parseAs(opts.as, ["system", "admin"] as const);
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor =
        as === "admin" ? { type: "admin", id: process.env.USER ?? "cli" } : { type: "system" };
      const res = wg.reopenForReview(
        ref,
        { reason: opts.reason, resolution: opts.resolution },
        actor,
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  ticket
    .command("hold <ref>")
    .description(
      "Hold an approved ticket for a human (ready_for_merge | in_testing -> blocked) with a " +
        "reason code — the runner's merge gate and a late red CI result. System/admin only.",
    )
    .requiredOption("--reason-code <code>", "snake_case reason code (e.g. merge_gate_red, ci_red)")
    .requiredOption("--reason <text>", "why it is held (shown in the human queue)")
    .option("--as <actor>", "actor type: system|admin", "system")
    .action((ref, opts, cmd) => {
      const as = parseAs(opts.as, ["system", "admin"] as const);
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor =
        as === "admin" ? { type: "admin", id: process.env.USER ?? "cli" } : { type: "system" };
      const res = wg.holdForHuman(
        ref,
        { reasonCode: String(opts.reasonCode), reason: String(opts.reason) },
        actor,
      );
      printJson({ ok: true, status: res.ticket.status, event: res.eventId });
      wg.db.close();
    });

  ticket
    .command("ci-result <ref>")
    .description(
      "REQUIRED CI: record a CI result for the ticket's candidate commit (pending | pass | " +
        "fail). A fail on an approved ticket holds it for a human. System/admin only.",
    )
    .requiredOption("--commit <sha>", "the commit the checks ran on")
    .requiredOption("--state <state>", "pending | pass | fail")
    .option("--detail <text>", "the failing check (name + url) or a note")
    .option("--as <actor>", "actor type: system|admin", "system")
    .action((ref, opts, cmd) => {
      const as = parseAs(opts.as, ["system", "admin"] as const);
      const state = z.enum(["pending", "pass", "fail"]).parse(String(opts.state));
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor =
        as === "admin" ? { type: "admin", id: process.env.USER ?? "cli" } : { type: "system" };
      const res = wg.recordCiResult(
        ref,
        {
          commit: String(opts.commit),
          state,
          ...(opts.detail ? { detail: String(opts.detail) } : {}),
        },
        actor,
      );
      warnLandedAlready(res.landedAlready, `CI failure for ${String(opts.commit).slice(0, 12)}`);
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  ticket
    .command("ci-status <ref>")
    .description("REQUIRED CI: the latest recorded CI state for a commit of the ticket")
    .option("--commit <sha>", "the candidate commit (default: the latest result)")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson({ ok: true, ...wg.ciStatus(ref, opts.commit ? String(opts.commit) : null) });
      wg.db.close();
    });

  ticket
    .command("mark-merged <ref>")
    .description(
      "Mark an approved-and-merging ticket actually merged (ready_for_merge -> done). " +
        "The merge runner's callback once the git merge of the delivery branch lands, " +
        "so 'done' means actually merged. System/admin only.",
    )
    .option("--as <actor>", "actor type: system|admin", "system")
    .action((ref, opts, cmd) => {
      const as = parseAs(opts.as, ["system", "admin"] as const);
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor =
        as === "admin" ? { type: "admin", id: process.env.USER ?? "cli" } : { type: "system" };
      const res = wg.markMerged(ref, actor);
      printJson({ ok: true, ticket: res.ticket, eventId: res.eventId });
      wg.db.close();
    });

  ticket
    .command("set-testable <ref>")
    .description(
      "BBT-001: mark a ticket eligible for the independent black-box testing lane " +
        "(--off to clear). Gates entry to in_testing on review approval when GAFFER_TESTING is on.",
    )
    .option("--off", "clear the flag (mark NOT testable)", false)
    .option("--admin", "act as an admin actor", false)
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor = opts.admin
        ? { type: "admin", id: process.env.USER ?? "cli" }
        : cliActor();
      const res = wg.setTestable(ref, !opts.off, actor);
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  ticket
    .command("allow-test-changes <ref>")
    .description(
      "GATE INTEGRITY: allow this ticket to change its tests (delete/rename a test, add a " +
        "skip marker, change a gate script) — the runner's integrity gate row then reads " +
        "PASS with a note instead of FLAG, and the test changes alone no longer hold an auto-approve " +
        "(they still count as medium risk, so a ticket declared low is still held). " +
        "It does NOT change which command the gate runs: a gate script the delivery changed " +
        "still runs as the BASE commit has it, so to change the gate itself, change the " +
        "repo's registered test/lint command or merge the script change to the base first. " +
        "--off withdraws the allowance. Human/admin only; recorded as an event.",
    )
    .option("--off", "withdraw the allowance (test changes are flagged again)", false)
    .option("--reason <text>", "why this ticket may change its tests (kept on the event)")
    .option("--admin", "act as an admin actor", false)
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const actor: Actor = opts.admin
        ? { type: "admin", id: process.env.USER ?? "cli" }
        : cliActor();
      const res = wg.setAllowTestChanges(ref, !opts.off, actor, opts.reason);
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  ticket
    .command("test-contract <ref>")
    .description(
      "BBT-001: record (replace) a ticket's test_contract — the testing handover the " +
        "independent tester reads to stand the system up (never the diff).",
    )
    .option("--surface <surface...>", "changed boundary surface(s): API/endpoint/CLI/page", [])
    .option("--dep <dep...>", "runtime dependency to stand up (e.g. 'Postgres 16')", [])
    .option("--env <var...>", "environment variable the tester sets", [])
    .option("--run <command>", "how to bring the system up / invoke the surface", "")
    .option("--harness-ready", "a black-box harness already exists for this surface", false)
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const contract = wg.setTestContract(
        ref,
        {
          changed_surfaces: opts.surface,
          runtime_deps: opts.dep,
          env_vars: opts.env,
          run_command: opts.run,
          harness_ready: opts.harnessReady,
        },
        cliActor(),
      );
      printJson({ ok: true, test_contract: contract });
      wg.db.close();
    });

  ticket
    .command("tester-pass <ref>")
    .description("BBT-001: record an independent tester PASS (in_testing -> ready_for_merge)")
    .requiredOption("--summary <text>", "passing test-result summary (recorded as evidence)")
    .option("--uri <uri>", "evidence uri")
    .option(
      "--tested-commit <sha>",
      "the exact commit the tester ran against (binds the verdict to it)",
    )
    .option(
      "--contract-hash <hex>",
      "hash of the contract tested (title + description + criteria + test_contract)",
    )
    .option(
      "--replay <state>",
      "the runner's clean replay of the tester's tests on the tested commit: passed | failed | skipped",
    )
    .option(
      "--tests-commit <sha|none>",
      "the commit holding the test files this tester run saved (gaffer-tests/ticket-<n>), or none",
    )
    .option("--as <actor>", "actor type: agent|human|admin|system", "agent")
    .action((ref, opts, cmd) => {
      const actor = testerActor(opts.as);
      const wg = open(cmd.optsWithGlobals());
      const res = wg.testerPass(
        ref,
        {
          summary: opts.summary,
          uri: opts.uri,
          ...(opts.testedCommit ? { tested_commit: String(opts.testedCommit) } : {}),
          ...(opts.contractHash ? { contract_hash: String(opts.contractHash) } : {}),
          ...(opts.replay ? { replay: String(opts.replay) } : {}),
          ...(opts.testsCommit ? { tests_commit: String(opts.testsCommit) } : {}),
        },
        actor,
      );
      printJson({ ok: true, status: res.ticket.status, event: res.eventId });
      wg.db.close();
    });

  ticket
    .command("tester-fail <ref>")
    .description(
      "BBT-001: record an independent tester FAIL (in_testing -> refining, with evidence)",
    )
    .requiredOption(
      "--summary <text>",
      "failing-test summary (recorded as evidence + reject reason)",
    )
    .option("--uri <uri>", "evidence uri")
    .option(
      "--to <status>",
      "where the FAIL lands below the retry cap: refining (hold for a human, default) or ready (re-queue for rework with the failing observation as feedback)",
      "refining",
    )
    .option(
      "--tested-commit <sha>",
      "the exact commit the tester ran against (binds the verdict to it)",
    )
    .option(
      "--contract-hash <hex>",
      "hash of the contract tested (title + description + criteria + test_contract)",
    )
    .option(
      "--replay <state>",
      "the runner's clean replay of the tester's tests on the tested commit: passed | failed | skipped",
    )
    .option("--as <actor>", "actor type: agent|human|admin|system", "agent")
    .action((ref, opts, cmd) => {
      if (opts.to !== "refining" && opts.to !== "ready") {
        throw new DispatchError("VALIDATION_ERROR", "--to must be refining or ready");
      }
      const actor = testerActor(opts.as);
      const wg = open(cmd.optsWithGlobals());
      const res = wg.testerFail(
        ref,
        {
          summary: opts.summary,
          uri: opts.uri,
          to: opts.to as "refining" | "ready",
          ...(opts.testedCommit ? { tested_commit: String(opts.testedCommit) } : {}),
          ...(opts.contractHash ? { contract_hash: String(opts.contractHash) } : {}),
          ...(opts.replay ? { replay: String(opts.replay) } : {}),
        },
        actor,
      );
      printJson({ ok: true, status: res.ticket.status, event: res.eventId });
      wg.db.close();
    });

  ticket
    .command("require-cap <ref>")
    .description("Set (replace) the capabilities a ticket requires of a claiming agent")
    .option("--cap <capability...>", "required capabilities (omit to clear)", [])
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const res = wg.setRequiredCapabilities(
        { ticket_id: ref, capabilities: opts.cap },
        cliActor(),
      );
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  // --- Ticket scope links + repo access boundaries (WG-001 + WG-002) ---------

  const ticketScope = ticket.command("scope").description("Ticket↔scope-node links (WG-001)");
  ticketScope
    .command("link <ref> <nodeId>")
    .description("Link a ticket to a scope node")
    .option("--relation <relation>", "relation (primary|secondary|suggested|rejected)", "secondary")
    .option("--confidence <n>", "confidence 0..1 (for suggested)")
    .action((ref, nodeId, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const link = wg.linkTicketScope(
        {
          ticket_id: ref,
          scope_node_id: nodeId,
          relation: opts.relation,
          ...(opts.confidence !== undefined ? { confidence: Number(opts.confidence) } : {}),
        },
        cliActor(),
      );
      printJson({
        ok: true,
        scope: { scope_node_id: link.scope_node_id, relation: link.relation },
      });
      wg.db.close();
    });

  ticketScope
    .command("primary <ref> <nodeId>")
    .description("Mark a scope node as the ticket's primary scope")
    .action((ref, nodeId, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const link = wg.setPrimaryScope(ref, nodeId, cliActor());
      printJson({
        ok: true,
        scope: { scope_node_id: link.scope_node_id, relation: link.relation },
      });
      wg.db.close();
    });

  ticketScope
    .command("list <ref>")
    .description("List a ticket's scope links (primary first)")
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(
        wg
          .listTicketScopes(ref)
          .map((s) => ({ id: s.id, name: s.name, type: s.type, relation: s.relation })),
      );
      wg.db.close();
    });

  ticketScope
    .command("rm <ref> <nodeId>")
    .description("Remove a ticket↔scope link")
    .action((ref, nodeId, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const res = wg.removeTicketScope(ref, nodeId, cliActor());
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  const ticketDep = ticket.command("dep").description("Ticket dependencies (EP-001)");
  ticketDep
    .command("add <ref> <dependsOnRef>")
    .description("Declare that <ref> must wait for <dependsOnRef> to be done")
    .action((ref, dependsOnRef, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const res = wg.addDependency({ ticket: ref, depends_on: dependsOnRef }, cliActor());
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  ticketDep
    .command("list <ref>")
    .description("List a ticket's dependencies (depended-on number/status + satisfied)")
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(wg.listDependencies(ref));
      wg.db.close();
    });

  ticketDep
    .command("rm <ref> <dependsOnRef>")
    .description("Remove a ticket dependency")
    .action((ref, dependsOnRef, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const res = wg.removeDependency(ref, dependsOnRef, cliActor());
      printJson({ ok: true, ...res });
      wg.db.close();
    });

  const ticketRepo = ticket
    .command("repo-access")
    .description("Ticket↔repo access boundaries (WG-002)");
  ticketRepo
    .command("set <ref> <repoRef>")
    .description("Set a repo's access boundary on a ticket")
    .option("--access <access>", "access (write|read|test|none)", "write")
    .option(
      "--relation <relation>",
      "relation (confirmed|suggested|rejected|context_only)",
      "confirmed",
    )
    .option("--source <source>", "source", "manual")
    .action((ref, repoRef, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const res = wg.setTicketRepoAccess(
        {
          ticket_id: ref,
          repo_id: repoRef,
          access: opts.access,
          relation: opts.relation,
          source: opts.source,
        },
        cliActor(),
      );
      printJson({ ok: true, access: res.access, relation: res.relation });
      wg.db.close();
    });

  ticketRepo
    .command("packet <ref>")
    .description("Show the partitioned work-packet repo boundary (write/read/test/denied)")
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const p = wg.workPacketRepos(ref);
      const names = (rs: Array<{ name: string }>) => rs.map((r) => r.name);
      printJson({
        writeRepos: names(p.writeRepos),
        readOnlyRepos: names(p.readOnlyRepos),
        testRepos: names(p.testRepos),
        deniedRepos: names(p.deniedRepos),
        suggestedRepos: names(p.suggestedRepos),
        rejectedRepos: names(p.rejectedRepos),
      });
      wg.db.close();
    });

  ticketRepo
    .command("mono-fallback <ref>")
    .description("Promote a single unmapped repo to a confirmed write boundary")
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(wg.applyMonoFallback(ref, cliActor()));
      wg.db.close();
    });

  const ticketDelivery = ticket
    .command("repo-delivery")
    .description("Per-repo delivery artifacts (WG-005)");
  ticketDelivery
    .command("record <ref> <repoRef>")
    .description("Record (upsert) a repo's delivery artifact on a ticket")
    .option("--branch <branch>", "branch name")
    .option("--commit <sha>", "commit sha")
    .option(
      "--base-sha <sha>",
      "the commit the delivery branch was cut from (the runner records it; the gate-integrity scan diffs from it)",
    )
    .option(
      "--base-recut",
      "with --base-sha: the runner cut the branch again from the base, so the new base replaces the stored one (a stored base is otherwise write-once)",
    )
    .option("--pr <url>", "pull-request url")
    .option("--status <status>", "delivery status")
    .option("--evidence <ref>", "evidence reference")
    .action((ref, repoRef, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const res = wg.recordRepoDelivery(
        {
          ticket_id: ref,
          repo_id: repoRef,
          branch_name: opts.branch,
          commit_sha: opts.commit,
          base_sha: opts.baseSha,
          ...(opts.baseRecut ? { base_recut: true } : {}),
          pr_url: opts.pr,
          status: opts.status,
          evidence_ref: opts.evidence,
        },
        cliActor(),
      );
      printJson({ ok: true, delivery: res.delivery });
      wg.db.close();
    });
  ticketDelivery
    .command("list <ref>")
    .description("List a ticket's per-repo delivery artifacts")
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson(wg.listRepoDeliveries(ref));
      wg.db.close();
    });

  // --- Pause-on-cap (PAUSE-ON-CAP): pause / continue / stop / resume ----------

  ticket
    .command("pause <ref>")
    .description(
      "Pause an in-flight delivery that hit a turn/budget cap (-> paused). The runner " +
        "keeps the worktree + branch alive; this records the resume context. System actor.",
    )
    .requiredOption("--reason <reason>", "cap_hit (turn cap) or budget_cap")
    .option("--branch <name>", "the gaffer/ delivery branch the partial work lives on")
    .option("--worktree <path>", "absolute path of the primary worktree kept alive")
    .option("--worktrees-json <json>", "JSON map of all write-repo worktrees (WT_ROWS)")
    .option("--repo <name>", "primary repo name/path the delivery targets")
    .option("--attempt <n>", "delivery attempt number at the pause", "0")
    .option("--turns <n>", "accumulated agent turns reported by the capped call")
    .option("--spend <text>", "spend-so-far relayed verbatim (e.g. $2.5600 or unknown)")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const reason = opts.reason as string;
      if (reason !== "cap_hit" && reason !== "budget_cap" && reason !== "timeout") {
        throw new DispatchError(
          "VALIDATION_ERROR",
          "--reason must be 'cap_hit', 'budget_cap' or 'timeout'.",
          { reason },
        );
      }
      const toInt = (v: string | undefined): number | null =>
        v === undefined || v === "" ? null : Number.parseInt(v, 10);
      const res = wg.pauseDelivery(
        ref,
        {
          reason,
          branch_name: opts.branch ?? null,
          worktree_path: opts.worktree ?? null,
          worktrees_json: opts.worktreesJson ?? null,
          repo: opts.repo ?? null,
          attempt: toInt(opts.attempt) ?? 0,
          turns: toInt(opts.turns),
          spend: opts.spend ?? null,
        },
        { type: "system" },
      );
      printJson({ ok: true, status: res.ticket.status, event: res.eventId });
      wg.db.close();
    });

  ticket
    .command("continue <ref>")
    .description(
      "Continue a paused delivery: mark it resume-requested so the factory loop resumes it.",
    )
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const res = wg.continuePaused(ref, cliActor());
      printJson({ ok: true, ticket_id: res.ticketId, event: res.eventId, resume_requested: true });
      wg.db.close();
    });

  ticket
    .command("stop <ref>")
    .description(
      "Stop a paused delivery: abandon it (-> cancelled), drop the resume context. The runner reaps the worktree.",
    )
    .option("--reason <text>", "why the paused delivery is being abandoned")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const res = wg.stopPaused(ref, cliActor(), opts.reason);
      printJson({ ok: true, status: res.ticket.status, event: res.eventId });
      wg.db.close();
    });

  ticket
    .command("resume-begin <ref>")
    .description(
      "Factory-loop resume entry point: re-enter delivery in the EXISTING worktree " +
        "(paused -> in_progress) and print the resume context (worktree, branch, attempt). " +
        "With --agent, the resume is leased to that agent and its claim_token printed. System actor.",
    )
    .option("--agent <id>", "lease the resumed delivery to this (runner) agent")
    .option("--ttl <seconds>", "lease TTL in seconds (with --agent)", "900")
    .action((ref, opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      const lease =
        typeof opts.agent === "string" && opts.agent !== ""
          ? { agentId: opts.agent as string, ttlSeconds: Number(opts.ttl) }
          : undefined;
      if (lease) validateTtl(lease.ttlSeconds);
      const res = wg.beginResume(ref, { type: "system" }, lease);
      printJson({
        ok: true,
        ticket_id: res.ticketId,
        event: res.eventId,
        context: res.context,
        claim_token: res.claimToken ?? null,
      });
      wg.db.close();
    });

  ticket
    .command("paused-context <ref>")
    .description(
      "Print the resume context for a paused ticket (worktree path, branch, attempt, spend), or null.",
    )
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      printJson({ ok: true, context: wg.pausedContext(ref) });
      wg.db.close();
    });

  ticket
    .command("resume-requested")
    .description(
      "List paused tickets a human has asked to continue (oldest first) — the factory loop's resume queue.",
    )
    .action((_opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      // Enrich each resume-context row with the ticket NUMBER + title so the factory
      // loop (which keys worktree dirs + prompts on the number) can resume without a
      // second lookup. A row whose ticket vanished is skipped defensively.
      const rows = wg.listResumeRequested().map((r) => {
        try {
          const t = wg.view(r.ticket_id).ticket;
          return { ...r, number: t.number, title: t.title, status: t.status };
        } catch {
          return { ...r, number: null, title: null, status: null };
        }
      });
      printJson(rows);
      wg.db.close();
    });

  ticket
    .command("paused-clear <ref>")
    .description(
      "Drop a resume context once a resumed delivery finally leaves the paused state (runner cleanup).",
    )
    .action((ref, _opts, cmd) => {
      const wg = open(cmd.optsWithGlobals());
      wg.clearPausedContext(ref);
      printJson({ ok: true, cleared: true });
      wg.db.close();
    });
}
