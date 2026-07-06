import type { Command } from "commander";

import { buildNotifierFromEnv } from "../../notify/config.js";
import { isNotifyKind } from "../../notify/types.js";
import { DispatchError } from "../../util/errors.js";
import { printJson } from "../shared.js";

export function registerNotify(program: Command): void {
  // --- H2 notifications: a setup-helper to test the configured sinks ----------
  const notify = program.command("notify").description("Human-gate notification commands");
  notify
    .command("test")
    .description(
      "Fire a synthetic human-gate event through the sinks configured via the " +
        "GAFFER_NOTIFY_* env vars (webhook · slack · desktop). With nothing " +
        "configured the notifier is a no-op and this reports 'disabled'.",
    )
    .option(
      "--kind <kind>",
      "gate kind: review_needed · ticket_blocked · ticket_parked · decision_pending",
      "review_needed",
    )
    .action((opts: { kind?: string }) => {
      const kind = opts.kind ?? "review_needed";
      if (!isNotifyKind(kind)) {
        throw new DispatchError("VALIDATION_ERROR", `Unknown notify kind: ${kind}`, {
          allowed: ["review_needed", "ticket_blocked", "ticket_parked", "decision_pending"],
        });
      }
      const notifier = buildNotifierFromEnv();
      if (!notifier.enabled) {
        printJson({ ok: true, enabled: false, message: "no notify sinks configured" });
        return;
      }
      notifier.notify({
        kind,
        title: "Synthetic test event",
        status: "in_review",
        at: new Date().toISOString(),
        detail: "dispatch notify test",
      });
      printJson({ ok: true, enabled: true, fired: kind });
    });

  notify
    .command("emit")
    .description(
      "Fire a REAL human-gate event through the configured GAFFER_NOTIFY_* sinks. " +
        "Used by the runner's ask-on-cap guard to ping the operator when a delivery " +
        "hits a turn/budget cap and is parked for review (carries ticket#, spend, " +
        "dashboard URL). With nothing configured the notifier is a no-op and this " +
        "reports 'disabled'. Free-text fields are dropped from the outbound body " +
        "by default (redacted); set GAFFER_NOTIFY_FULL_PAYLOAD=1 to include them.",
    )
    .requiredOption(
      "--kind <kind>",
      "gate kind: review_needed · ticket_blocked · ticket_parked · decision_pending",
    )
    .option("--ticket <number>", "ticket number the gate is scoped to")
    .option("--title <title>", "short human title (ticket title)")
    .option("--status <status>", "ticket status at the gate")
    .option("--repo <repo>", "repo name, when one is associated")
    .option("--url <url>", "deep link the operator can click (dashboard ticket URL)")
    .option("--detail <detail>", "free-text extra context (reason, attempt count, spend)")
    .action(
      (opts: {
        kind: string;
        ticket?: string;
        title?: string;
        status?: string;
        repo?: string;
        url?: string;
        detail?: string;
      }) => {
        if (!isNotifyKind(opts.kind)) {
          throw new DispatchError("VALIDATION_ERROR", `Unknown notify kind: ${opts.kind}`, {
            allowed: ["review_needed", "ticket_blocked", "ticket_parked", "decision_pending"],
          });
        }
        const notifier = buildNotifierFromEnv();
        if (!notifier.enabled) {
          printJson({ ok: true, enabled: false, message: "no notify sinks configured" });
          return;
        }
        const ticketNumber =
          opts.ticket != null && /^\d+$/.test(opts.ticket.trim())
            ? Number(opts.ticket.trim())
            : undefined;
        notifier.notify({
          kind: opts.kind,
          ...(ticketNumber != null ? { ticket_number: ticketNumber } : {}),
          ...(opts.title ? { title: opts.title } : {}),
          ...(opts.status ? { status: opts.status } : {}),
          ...(opts.repo ? { repo: opts.repo } : {}),
          ...(opts.url ? { url: opts.url } : {}),
          ...(opts.detail ? { detail: opts.detail } : {}),
          at: new Date().toISOString(),
        });
        printJson({ ok: true, enabled: true, fired: opts.kind, ticket: ticketNumber ?? null });
      },
    );
}
