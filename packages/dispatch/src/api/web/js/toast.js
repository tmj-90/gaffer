// Toast, and the guarded async action helpers.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api } from "./api.js";
import { clear, el } from "./dom.js";
import { RUN_KIND_LABELS } from "../app.js";

// --- Toast ------------------------------------------------------------------

let toastTimer;
/**
 * One short sentence on the scoreboard black. `link` ({ href, text }) adds the one
 * place to go next ("Approve it in Memory"); a toast with a link stays up longer, so
 * it can be reached, and following it puts the toast away.
 */
function toast(message, { ok = false, code, link } = {}) {
  const node = document.getElementById("toast");
  clear(node);
  node.className = `toast${ok ? " ok" : ""}`;
  if (code) node.appendChild(el("span", { class: "toast-code" }, code));
  node.appendChild(el("span", { class: "toast-msg" }, message));
  if (link)
    node.appendChild(
      el(
        "a",
        {
          class: "toast-link",
          href: link.href,
          onclick: () => {
            node.hidden = true;
          },
        },
        link.text,
      ),
    );
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      node.hidden = true;
    },
    link ? 9000 : ok ? 2600 : 5200,
  );
}

/** Wrap an async action so any thrown API error is shown as a toast. */
async function guard(fn) {
  try {
    await fn();
  } catch (e) {
    toast(e.message || "Unexpected error", { code: e.code });
  }
}

/**
 * Shared async-action helper. Every long-running button (Suggest work,
 * Plan a build, Poll for work) fires a backend job that returns immediately but
 * whose RESULT lands ~a minute later. Without instant feedback the buttons feel
 * dead, so this gives one consistent running state for all three:
 *
 *   - disables the trigger button and swaps its label to `running` (e.g.
 *     "Polling…") with an inline spinner, so the click visibly "took";
 *   - runs the action through {@link guard} so a thrown API error still toasts;
 *   - always restores the button (label + enabled) in a `finally`, even on error.
 *
 * `fn` receives nothing and may return a value; the button is the single source
 * of the busy state so callers never hand-roll disabled/label juggling.
 */
async function runAsyncAction(btn, running, fn) {
  if (!btn || btn.disabled) return;
  const original = [...btn.childNodes];
  btn.disabled = true;
  btn.classList.add("is-running");
  btn.setAttribute("aria-busy", "true");
  clear(btn);
  btn.appendChild(el("span", { class: "btn-spinner", "aria-hidden": "true" }));
  btn.appendChild(el("span", {}, running));
  try {
    await guard(fn);
  } finally {
    btn.disabled = false;
    btn.classList.remove("is-running");
    btn.removeAttribute("aria-busy");
    clear(btn);
    for (const node of original) btn.appendChild(node);
  }
}

/**
 * Like {@link runAsyncAction}, but keeps the button in its running state until
 * the REAL background run (not just the HTTP spawn-ack) finishes.
 *
 * The pre-RUN-ACTIVITY bug: the spawn POST returns in milliseconds, so the
 * button reset while the (~minute-long) `claude -p` work churned on invisibly —
 * the button looked "done" when it wasn't. Here `fn` returns the run id(s) the
 * action started; the button stays disabled + spinning while ANY of them is
 * still active (polled via GET /api/runs?active=1), then resets. A safety cap
 * stops the poll so a wedged run can never disable the button forever; the
 * "Running now" panel remains the source of truth either way.
 */
async function runAsyncActionUntilDone(btn, running, fn) {
  if (!btn || btn.disabled) return;
  const original = [...btn.childNodes];
  const restore = () => {
    btn.disabled = false;
    btn.classList.remove("is-running");
    btn.removeAttribute("aria-busy");
    clear(btn);
    for (const node of original) btn.appendChild(node);
  };
  btn.disabled = true;
  btn.classList.add("is-running");
  btn.setAttribute("aria-busy", "true");
  clear(btn);
  btn.appendChild(el("span", { class: "btn-spinner", "aria-hidden": "true" }));
  btn.appendChild(el("span", {}, running));

  let runIds;
  try {
    const ids = await fn();
    runIds = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  } catch (e) {
    toast(e.message || "Unexpected error", { code: e.code });
    restore();
    return;
  }

  // No trackable run id came back (e.g. unconfigured) — nothing to wait on.
  if (runIds.length === 0) {
    restore();
    return;
  }

  // Poll until none of our run ids is still active, or a safety cap elapses
  // (~10 min) so a stuck run never wedges the button. The panel still reflects it.
  const POLL_MS = 3000;
  const MAX_POLLS = 200;
  const wanted = new Set(runIds);
  let polls = 0;
  const done = () =>
    new Promise((resolve) => {
      const tick = async () => {
        polls += 1;
        let activeIds = new Set();
        try {
          const data = await api("GET", "/api/runs?active=1");
          activeIds = new Set((data.active || []).map((r) => r.id));
        } catch {
          // transient — try again next tick
        }
        const stillRunning = [...wanted].some((id) => activeIds.has(id));
        if (!stillRunning || polls >= MAX_POLLS) {
          resolve();
          return;
        }
        setTimeout(tick, POLL_MS);
      };
      setTimeout(tick, POLL_MS);
    });
  await done();
  restore();
  // The run finished (or the cap elapsed) — say so when it FAILED. Before this a
  // failed onboard / product-owner / poll run only showed in the Running-now panel
  // while the button quietly reset, so a first-run misconfiguration looked like
  // "nothing happened". Best-effort: a read error here never throws.
  try {
    const data = await api("GET", "/api/runs");
    const recent = [...(data.recent || []), ...(data.active || [])];
    const failed = recent.filter((r) => wanted.has(r.id) && r.status === "failed");
    for (const r of failed) {
      const why = r.summary || r.error || r.last_line || "";
      toast(
        `${RUN_KIND_LABELS[r.kind] || r.kind || "Run"} failed${r.exit_code != null ? ` (exit ${r.exit_code})` : ""}${why ? ` — ${String(why).slice(0, 160)}` : ""}. Open it under Running now for the log.`,
        { code: "RUN_FAILED" },
      );
    }
  } catch {
    // best-effort
  }
}

export { toast, guard, runAsyncAction, runAsyncActionUntilDone };
