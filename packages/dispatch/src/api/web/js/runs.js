// Running now (RUN-ACTIVITY): run rows, run logs and run detail.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api, authToken } from "./api.js";
import { emptyState, panelHead } from "./components.js";
import { clear, el } from "./dom.js";
import { fmtDuration, fmtTime, money } from "./format.js";
import { badge } from "./icons.js";
import { closeSheet, openSheet } from "./sheet.js";

// --- "Running now" panel (RUN-ACTIVITY) -------------------------------------

/** Human label for a run kind (the backend's snake_case → a readable noun). */
const RUN_KIND_LABELS = {
  product_owner: "Suggest work",
  onboard: "Onboard repo",
  poll_work: "Poll for work",
  merge: "Merge",
  other: "Run",
};
function runKindLabel(kind) {
  return RUN_KIND_LABELS[kind] || kind || "Run";
}

/** Badge tone for a finished run's status. */
function runStatusBadge(status) {
  const tone =
    status === "succeeded"
      ? "ok"
      : status === "failed"
        ? "danger"
        : status === "unknown"
          ? "warn"
          : "";
  return badge(status, tone);
}

/** Elapsed/duration text for a run row, from its start (+ end when finished). */
function runDuration(run) {
  const start = Date.parse(run.started_at);
  if (Number.isNaN(start)) return "—";
  const end = run.ended_at ? Date.parse(run.ended_at) : Date.now();
  return fmtDuration(end - start);
}

/** Open the captured log for a finished run in a sheet (best-effort fetch). */
async function viewRunLog(run, title) {
  const body = el("div", { class: "run-log" }, [el("p", { class: "dim" }, "Loading log…")]);
  openSheet(title || `${runKindLabel(run.kind)} log`, body);
  try {
    const tok = authToken();
    const res = await fetch(`/api/runs/${encodeURIComponent(run.id)}/log`, {
      headers: tok ? { authorization: "Bearer " + tok } : {},
    });
    clear(body);
    if (!res.ok) {
      body.appendChild(
        el(
          "p",
          { class: "dim" },
          res.status === 404 ? "No log captured for this run." : "Could not load the log.",
        ),
      );
      return;
    }
    const text = await res.text();
    body.appendChild(
      // A long log scrolls inside its <pre>: focusable and named (axe scrollable-region-focusable).
      el(
        "pre",
        { class: "run-log-pre", tabindex: "0", role: "region", "aria-label": "Run log" },
        text && text.trim() ? text : "(log is empty)",
      ),
    );
  } catch {
    clear(body);
    body.appendChild(el("p", { class: "dim" }, "Could not load the log."));
  }
}

/**
 * Open the run-detail drawer for a run. Fetches GET /api/runs/:id and renders
 * phase · turns · spend + a streaming factory-log tail. For active runs it polls
 * every 3s until the run settles; the timer is cleared when the sheet closes.
 *
 * Zero-state safe: missing detail fields render as "—".
 */
function viewRunDetail(runId, kindLabel) {
  const POLL_MS = 3000;
  let detailTimer = null;

  const metaBar = el("div", { class: "run-detail-meta" });
  const logSection = el("div", { class: "run-detail-log" });
  const body = el("div", { class: "run-detail" }, [metaBar, logSection]);

  // Intercept sheet close to cancel polling.
  const origClose = closeSheet;
  const cleanup = () => {
    if (detailTimer !== null) {
      clearInterval(detailTimer);
      detailTimer = null;
    }
  };

  openSheet(`${kindLabel} · detail`, body);

  // Patch the sheet close button to also clear the timer (one-shot: the next
  // openSheet call will rebuild the head, so this is safe).
  const closeBtn = document.querySelector(".sheet-head .icon-btn");
  if (closeBtn) {
    const orig = closeBtn.onclick;
    closeBtn.onclick = () => {
      cleanup();
      if (orig) orig();
      else origClose();
    };
  }

  const fmtCost = (usd) => (usd > 0 ? money(usd) : null);
  const fmtTurns = (n) => (n > 0 ? `${n} turn${n === 1 ? "" : "s"}` : null);

  const renderDetail = (detail) => {
    clear(metaBar);
    clear(logSection);

    const chips = [];
    if (detail.phase) chips.push(el("span", { class: "run-detail-chip" }, detail.phase));
    const turns = fmtTurns(detail.num_turns);
    if (turns) chips.push(el("span", { class: "run-detail-chip dim" }, turns));
    const cost = fmtCost(detail.cost_usd);
    if (cost) chips.push(el("span", { class: "run-detail-chip tabnum" }, cost));
    // Honest cost: an estimate is labelled, an unmeasured call is counted, an
    // unreadable ledger is "unknown" — never a silent $0.
    if (detail.estimated_usd > 0) {
      chips.push(
        el(
          "span",
          {
            class: "run-detail-chip dim",
            title: "includes the runner's estimate for killed / timed-out calls",
          },
          `incl. ${money(detail.estimated_usd)} est.`,
        ),
      );
    }
    if (detail.unknown_calls > 0) {
      chips.push(
        el(
          "span",
          { class: "run-detail-chip warn", title: "calls whose usage the CLI did not report" },
          `${detail.unknown_calls} call${detail.unknown_calls === 1 ? "" : "s"} unmeasured`,
        ),
      );
    }
    if (detail.cost_status === "unreadable") {
      chips.push(el("span", { class: "run-detail-chip warn" }, "cost unknown (ledger unreadable)"));
    }
    if (detail.outcome) {
      const tone =
        detail.outcome === "in_review"
          ? "ok"
          : detail.outcome === "FAILED" ||
              detail.outcome === "FLAGGED" ||
              detail.outcome === "REFUSED"
            ? "danger"
            : "warn";
      chips.push(badge(detail.outcome, tone));
    } else if (detail.run.status === "running") {
      chips.push(el("span", { class: "run-spinner run-spinner--sm", "aria-hidden": "true" }));
    }
    if (chips.length) metaBar.appendChild(el("div", { class: "run-detail-chips" }, chips));
    if (detail.ticket_number !== null) {
      metaBar.appendChild(
        el("p", { class: "run-detail-ticket dim" }, `Ticket #${detail.ticket_number}`),
      );
    }

    if (detail.log_tail) {
      logSection.appendChild(
        el(
          "pre",
          {
            class: "run-log-pre run-detail-log-pre",
            tabindex: "0",
            role: "region",
            "aria-label": "Run log, latest lines",
          },
          detail.log_tail,
        ),
      );
    } else if (detail.run.status !== "running") {
      logSection.appendChild(el("p", { class: "dim" }, "No log captured for this run."));
    } else {
      logSection.appendChild(el("p", { class: "dim" }, "Waiting for log output…"));
    }
  };

  const fetchDetail = async () => {
    try {
      const data = await api("GET", `/api/runs/${encodeURIComponent(runId)}`);
      if (!document.querySelector(".sheet.open")) {
        cleanup();
        return;
      }
      renderDetail(data.detail);
      // Stop polling once the run has settled (no longer running).
      if (data.detail.run.status !== "running") {
        cleanup();
      }
    } catch {
      // Leave the last paint on transient errors.
    }
  };

  // Initial paint: show a loading placeholder, then fetch.
  metaBar.appendChild(el("p", { class: "dim" }, "Loading…"));
  fetchDetail();

  detailTimer = setInterval(() => {
    if (!document.querySelector(".sheet.open")) {
      cleanup();
      return;
    }
    fetchDetail();
  }, POLL_MS);
}

/**
 * Format a USD cost for inline display in a run row.
 * Returns null when cost is zero/unknown (so no chip is rendered).
 */
function runCostChip(costUsd) {
  if (!costUsd || costUsd <= 0) return null;
  return el("span", { class: "run-cost-chip tabnum dim" }, money(costUsd));
}

/** One active run row: kind · repo · phase · elapsed · spinner · detail button. */
function activeRunRow(run) {
  // `run._phase` and `run._cost_usd` are injected by the enriched list render.
  const phaseChip = run._phase ? el("span", { class: "run-phase-chip dim" }, run._phase) : null;
  const costChip = runCostChip(run._cost_usd);
  return el(
    "li",
    {
      class: "run-row run-active run-row--clickable",
      onclick: () => viewRunDetail(run.id, runKindLabel(run.kind)),
      title: "Click to view live detail",
    },
    [
      el("span", { class: "run-spinner", "aria-hidden": "true" }),
      el("span", { class: "run-kind" }, runKindLabel(run.kind)),
      run.repo
        ? el(
            "span",
            { class: "run-repo dim", title: run.repo },
            String(run.repo).split("/").filter(Boolean).pop() || run.repo,
          )
        : null,
      phaseChip,
      costChip,
      el(
        "span",
        { class: "run-elapsed dim tabnum", title: `started ${fmtTime(run.started_at)}` },
        runDuration(run),
      ),
    ],
  );
}

/** One finished run row: kind · repo · phase · status · cost · duration · view-log. */
function finishedRunRow(run) {
  const phaseChip = run._phase ? el("span", { class: "run-phase-chip dim" }, run._phase) : null;
  const costChip = runCostChip(run._cost_usd);
  return el("li", { class: "run-row run-done" }, [
    el("span", { class: "run-kind" }, runKindLabel(run.kind)),
    run.repo
      ? el(
          "span",
          { class: "run-repo dim", title: run.repo },
          String(run.repo).split("/").filter(Boolean).pop() || run.repo,
        )
      : null,
    phaseChip,
    runStatusBadge(run.status),
    costChip,
    el(
      "span",
      { class: "run-elapsed dim tabnum", title: `ended ${fmtTime(run.ended_at)}` },
      runDuration(run),
    ),
    run.log_path
      ? el(
          "button",
          { class: "btn small run-viewlog", type: "button", onclick: () => viewRunLog(run) },
          "view log",
        )
      : null,
  ]);
}

/**
 * The "Running now" panel: a compact card that polls GET /api/runs?active=1
 * every ~3s, showing each in-flight run (kind · repo · elapsed · spinner) and
 * the most-recent finished runs (status · duration · view-log). When there are
 * zero active and zero recent it renders a quiet empty state instead of clutter.
 *
 * Lifecycle: the poll self-terminates once the panel node is detached from the
 * DOM (a view change rebuilds Overview from scratch), so no global teardown hook
 * is needed. The first paint is synchronous-ish (an immediate fetch) so the card
 * never flashes empty before the first interval.
 */
function runActivityPanel() {
  const POLL_MS = 3000;
  const card = el("div", { class: "card panel run-activity", id: "running-now" }, [
    panelHead("Running now", "background runs: polls, suggestions, merges", null, { kit: "ink" }),
  ]);
  const listWrap = el("div", { class: "run-activity-body" }, [
    el("p", { class: "dim" }, "Loading runs…"),
  ]);
  card.appendChild(listWrap);

  let stopped = false;

  const render = (active, recent) => {
    clear(listWrap);
    if ((!active || active.length === 0) && (!recent || recent.length === 0)) {
      listWrap.appendChild(
        emptyState("Nothing running.", "Polls, suggestions and merges you start show up here."),
      );
      return;
    }
    if (active && active.length) {
      listWrap.appendChild(el("div", { class: "run-recent-title dim" }, "In play now"));
      listWrap.appendChild(el("ul", { class: "run-list run-now" }, active.map(activeRunRow)));
    }
    if (recent && recent.length) {
      listWrap.appendChild(el("div", { class: "run-recent-title dim" }, "Recently finished"));
      // The last six; the rest fold away (a busy day lists dozens).
      listWrap.appendChild(el("ul", { class: "run-list" }, recent.slice(0, 6).map(finishedRunRow)));
      if (recent.length > 6)
        listWrap.appendChild(
          el("details", { class: "run-more" }, [
            el("summary", {}, `${recent.length - 6} more finished`),
            el("ul", { class: "run-list" }, recent.slice(6).map(finishedRunRow)),
          ]),
        );
    }
  };

  /**
   * Fetch the enriched detail for a run (best-effort). Returns the detail
   * object on success, null on any error. Used to inject phase + cost_usd into
   * run rows without blocking the main list render.
   */
  const fetchRunDetail = async (runId) => {
    try {
      const data = await api("GET", `/api/runs/${encodeURIComponent(runId)}`);
      return data.detail || null;
    } catch {
      return null;
    }
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const data = await api("GET", "/api/runs?active=1");
      // Don't paint into a panel that's been detached mid-flight (view changed).
      if (stopped) return;
      const active = data.active || [];
      const recent = data.recent || [];

      // Enrich active runs with phase + cost_usd via parallel detail fetches
      // (best-effort: failures leave the fields unset, rows still render).
      if (active.length > 0) {
        const details = await Promise.all(active.map((r) => fetchRunDetail(r.id)));
        if (!stopped) {
          for (let i = 0; i < active.length; i++) {
            const d = details[i];
            if (d) {
              active[i]._phase = d.phase || null;
              active[i]._cost_usd = d.cost_usd || 0;
            }
          }
        }
      }

      if (!stopped) render(active, recent);
    } catch {
      // A transient read failure shouldn't blank the panel; leave the last paint.
    }
  };

  // Immediate first paint (the card is still being assembled into the view, so we
  // do NOT gate this on attachment — only the recurring interval self-terminates
  // on detach, once the card has actually been mounted).
  poll();
  const timer = setInterval(() => {
    if (stopped || !document.body.contains(card)) {
      clearInterval(timer);
      stopped = true;
      return;
    }
    poll();
  }, POLL_MS);

  return card;
}

export { RUN_KIND_LABELS, runDuration, viewRunLog, viewRunDetail, runActivityPanel };
