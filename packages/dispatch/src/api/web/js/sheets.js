// The action sheets: confirm, value, reason, won't do, unblock, answer, merge, paused, ready approval.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api } from "./api.js";
import { el, field } from "./dom.js";
import { plural } from "./format.js";
import { glyph } from "./icons.js";
import { router } from "./router.js";
import { closeSheet, openSheet, sheetOpen } from "./sheet.js";
import { appState } from "./state.js";
import { statusLabel } from "./status.js";
import { guard, toast } from "./toast.js";
import { WONT_DO_PRESETS } from "../app.js";

/** A bottom sheet / side panel with a short intro, a form and its actions. */
function actionSheet(title, { intro, body, actions, focus }) {
  openSheet(
    title,
    el("div", { class: "act-sheet" }, [
      intro ? el("p", { class: "act-intro" }, intro) : null,
      body || null,
      el("div", { class: "btn-row act-actions" }, actions),
    ]),
    { focus },
  );
}

/**
 * Ask before an act, in the shared sheet (never window.confirm: unstyled, it blocks
 * the page and ignores the kit). `onConfirm` does the work; the sheet closes when it
 * resolves and stays open, with the error toasted, when it throws. A danger sheet
 * starts on Cancel, so Enter never destroys anything by accident.
 */
function confirmSheet({ title, intro, body, confirm, tone = "primary", onConfirm }) {
  let busy = false;
  const go = el(
    "button",
    {
      class: `btn ${tone === "danger" ? "danger" : "primary"} confirm-submit`,
      type: "button",
      onclick: async () => {
        if (busy) return;
        busy = true;
        go.setAttribute("aria-busy", "true");
        try {
          await onConfirm();
          if (go.isConnected && sheetOpen()) closeSheet();
        } catch (e) {
          toast((e && e.message) || "That did not go through.", { code: e && e.code });
        } finally {
          busy = false;
          go.removeAttribute("aria-busy");
        }
      },
    },
    confirm,
  );
  const cancel = el(
    "button",
    { class: "btn", type: "button", onclick: () => closeSheet() },
    "Cancel",
  );
  actionSheet(title, {
    intro,
    body,
    actions: [go, cancel],
    focus: tone === "danger" ? cancel : go,
  });
}

/**
 * One value, edited in the shared sheet (the inline-form twin of confirmSheet, for
 * what was a window.prompt). An empty value is refused in place; an unchanged one
 * just closes. `onSave(value)` does the work and may throw to keep the sheet open.
 */
function valueSheet({ title, intro, label, value = "", hint, confirm = "Save", onSave }) {
  const hintId = `vs-hint-${++appState.fieldSeq}`;
  const input = el("input", {
    type: "text",
    class: "value-sheet-input",
    value,
    required: "",
    autocomplete: "off",
    spellcheck: "false",
    "aria-describedby": hintId,
  });
  const hintEl = el("p", { class: "act-hint", id: hintId }, hint || "");
  let busy = false;
  const form = el(
    "form",
    {
      class: "act-sheet value-sheet",
      novalidate: "",
      onsubmit: async (e) => {
        e.preventDefault();
        if (busy) return;
        const next = input.value.trim();
        if (!next) {
          input.setAttribute("aria-invalid", "true");
          hintEl.classList.add("is-error");
          hintEl.textContent = `${label} cannot be empty.`;
          input.focus();
          return;
        }
        if (next === value) {
          closeSheet();
          return;
        }
        busy = true;
        try {
          await onSave(next);
          if (form.isConnected && sheetOpen()) closeSheet();
        } catch (err) {
          toast((err && err.message) || "That did not go through.", { code: err && err.code });
        } finally {
          busy = false;
        }
      },
    },
    [
      intro ? el("p", { class: "act-intro" }, intro) : null,
      field(label, input),
      hintEl,
      el("div", { class: "btn-row act-actions" }, [
        el("button", { class: "btn primary", type: "submit" }, confirm),
        el("button", { class: "btn", type: "button", onclick: () => closeSheet() }, "Cancel"),
      ]),
    ],
  );
  input.addEventListener("input", () => {
    input.removeAttribute("aria-invalid");
    hintEl.classList.remove("is-error");
    hintEl.textContent = hint || "";
  });
  openSheet(title, form, { focus: input });
  input.select();
  return form;
}

/** Hide a repo from the dashboard (reversible), asked in the shared sheet. */
function hideRepoSheet(repo, after) {
  confirmSheet({
    title: `Hide ${repo.name}`,
    intro: `${repo.name} leaves the Map and the lists. It stays registered, its tickets are unaffected, and you can unhide it from the Hidden repos page.`,
    confirm: "Hide repo",
    onConfirm: async () => {
      await api("POST", `/repos/${repo.id}/hidden`, { hidden: true });
      toast(`${repo.name} hidden`, { ok: true });
      after();
    },
  });
}

/** The ticket a sheet acts on, named at its top: glyph, number and title. */
function sheetTicket(t) {
  if (!t) return null;
  return el("p", { class: "rs-ticket" }, [
    t.status ? glyph(t.status, 16, statusLabel(t.status, t.landing_state)) : null,
    t.number != null ? el("b", { class: "rs-num tabnum" }, `#${t.number}`) : null,
    t.title ? el("span", { class: "rs-title" }, t.title) : null,
  ]);
}

/**
 * The one place a reason is collected: Send back, Won't do, a tester's verdict, Stop,
 * a repo ruled off the boundary. It opens in the shared sheet (side panel at desktop,
 * bottom sheet on a phone), so it wears the kit in both themes, traps focus, gives
 * focus back to its trigger on Cancel or Esc, and closes when the route changes.
 *
 *   title    names the act and the ticket ("Send #15 back")
 *   ticket   the ticket it acts on (shown under the title), or null
 *   intro    what happens when you confirm, from what the server does
 *   presets  quick reasons: a tap fills the box (one-handed on a phone)
 *   required when true the confirm stays disabled until there is a reason, and
 *            the submit re-checks (a reason is REQUIRED for these endpoints)
 *   confirm  the button word, the same verb as the button that opened it
 *   tone     "primary" or "danger"
 *   capture  offer "also capture as a lore draft" (Review's send back / won't do)
 *   onConfirm(reason, captureLore) does the work; the sheet closes when it
 *            resolves and stays open (reason kept) when it throws.
 *
 * Hooks: `.reject-dialog` (the form), `.reject-chip`, `.reject-reason-input`,
 * `.reject-dialog-actions .reject-submit`, `.reject-capture-cb`.
 */
function reasonSheet({
  title,
  ticket = null,
  intro,
  label = "Reason",
  hint,
  presets = [],
  placeholder,
  required = true,
  confirm,
  tone = "primary",
  capture = false,
  onConfirm,
}) {
  const hintId = `rs-hint-${++appState.fieldSeq}`;
  const input = el("textarea", {
    class: "reject-reason-input",
    name: "reason",
    rows: 4,
    maxlength: "20000",
    placeholder: placeholder || null,
    required: required ? "" : null,
    "aria-describedby": hintId,
  });
  const chips = presets.length
    ? el(
        "div",
        { class: "reject-chips", role: "group", "aria-label": "Quick reasons" },
        presets.map((text) =>
          el(
            "button",
            {
              class: "chip reject-chip",
              type: "button",
              "aria-pressed": "false",
              onclick: () => {
                input.value = text;
                sync();
                input.focus();
              },
            },
            text,
          ),
        ),
      )
    : null;
  const submit = el(
    "button",
    {
      class: `btn ${tone === "danger" ? "danger" : "primary"} reject-submit`,
      type: "submit",
      // aria-disabled, not disabled: the confirm stays focusable and, pressed with an
      // empty box, says why instead of doing nothing silently.
      "aria-disabled": required ? "true" : null,
    },
    confirm,
  );
  const captureBox = capture
    ? el("input", { type: "checkbox", class: "reject-capture-cb", name: "capture" })
    : null;
  const hintText =
    hint ||
    (required
      ? "Required. It is kept on the ticket."
      : "Optional. It is kept on the ticket if you write one.");
  const hintEl = el("p", { class: "act-hint", id: hintId }, hintText);
  const form = el(
    "form",
    {
      class: "act-sheet reject-dialog",
      novalidate: "",
      onsubmit: (e) => {
        e.preventDefault();
        void send();
      },
    },
    [
      sheetTicket(ticket),
      intro ? el("p", { class: "act-intro" }, intro) : null,
      chips,
      field(label, input),
      hintEl,
      captureBox
        ? el("label", { class: "reject-capture" }, [
            captureBox,
            el("span", {}, [
              el("b", {}, "Also file it as a lore draft. "),
              "It waits in the memory review queue for you; it is never approved on its own.",
            ]),
          ])
        : null,
      el("div", { class: "btn-row act-actions reject-dialog-actions" }, [
        submit,
        el("button", { class: "btn", type: "button", onclick: () => closeSheet() }, "Cancel"),
      ]),
    ],
  );
  function sync() {
    const v = input.value.trim();
    if (required) submit.setAttribute("aria-disabled", String(!v));
    input.removeAttribute("aria-invalid");
    hintEl.classList.remove("is-error");
    hintEl.textContent = hintText;
    if (chips)
      for (const c of chips.children)
        c.setAttribute("aria-pressed", String(c.textContent === input.value));
  }
  let busy = false;
  async function send() {
    if (busy) return;
    const reason = input.value.trim();
    // Backstop the invariant even if the disabled state were bypassed.
    if (required && !reason) {
      input.setAttribute("aria-invalid", "true");
      hintEl.classList.add("is-error");
      hintEl.textContent = `Write a reason first: ${confirm} needs one.`;
      input.focus();
      return;
    }
    busy = true;
    submit.setAttribute("aria-disabled", "true");
    submit.setAttribute("aria-busy", "true");
    try {
      await onConfirm(reason, captureBox ? captureBox.checked : false);
      // Close only if this form is still what the sheet shows.
      if (form.isConnected && sheetOpen()) closeSheet();
    } catch (e) {
      if (!e || e.code !== "ABORTED")
        toast((e && e.message) || "That did not go through.", { code: e && e.code });
      submit.setAttribute("aria-disabled", String(required && !input.value.trim()));
    } finally {
      busy = false;
      submit.removeAttribute("aria-busy");
    }
  }
  input.addEventListener("input", sync);
  // Ctrl/Cmd+Enter sends from the box (Enter alone is a new line).
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  });
  openSheet(title, form, { focus: input });
  return form;
}

/**
 * Won't do: close a ticket without building it (-> cancelled, with a reason). The
 * ticket page's button and a Work card's Move menu both open this one sheet; the
 * server's guarded won't-do path decides whether the move is legal.
 */
function wontDoSheet(t) {
  const ref = t.number != null ? `#${t.number}` : "this ticket";
  return reasonSheet({
    title: `Won't do ${ref}`,
    ticket: t,
    intro: `${ref} closes without being built and goes to Won't do. You can reopen it into Refining later.`,
    label: "Why not?",
    presets: WONT_DO_PRESETS,
    confirm: "Won't do",
    tone: "danger",
    onConfirm: async (reason) => {
      await api("POST", `/tickets/${t.id}/wont-do`, { reason });
      toast(`${ref} closed as won't do.`, { ok: true });
      router();
    },
  });
}

/** Unblock: move a blocked ticket back to Ready (another go) or Refining (rewrite first). */
function unblockSheet(t, it = {}) {
  const ref = t.number != null ? `#${t.number}` : "this ticket";
  const opt = (value, word, rest, checked) =>
    el("label", {}, [
      el("input", { type: "radio", name: "unblock-to", value, checked: checked ? "" : null }),
      el("span", {}, [el("b", {}, word), ` ${rest}`]),
    ]);
  const choice = el("fieldset", { class: "choice" }, [
    el("legend", {}, `Move ${ref} to`),
    opt(
      "ready",
      "Ready",
      "— an agent claims it and delivers again, with a fresh set of attempts.",
      true,
    ),
    opt(
      "refining",
      "Refining",
      "— it comes back to you to rewrite the ticket or its criteria first.",
    ),
  ]);
  const go = el(
    "button",
    {
      class: "btn primary",
      type: "button",
      onclick: () =>
        guard(async () => {
          const to = choice.querySelector("input:checked")?.value || "ready";
          await api("POST", `/tickets/${t.id}/move`, { to });
          closeSheet();
          toast(`Unblocked ${ref}: it is ${statusLabel(to)} now.`, { ok: true });
          router();
        }),
    },
    "Unblock",
  );
  actionSheet(`Unblock ${ref}`, {
    intro: [it.reason ? `Parked: ${it.reason}` : "This ticket is blocked."].join(" "),
    body: el("div", {}, [
      choice,
      el("p", { class: "act-hint" }, [
        "To brief the next attempt, add or sharpen an acceptance criterion on ",
        el("a", { href: `#/ticket/${t.id}`, onclick: closeSheet }, `the ticket page`),
        " first.",
      ]),
    ]),
    actions: [go, el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel")],
  });
}

/** Answer a decision the agents are waiting on (resolves it as accepted, with your answer). */
function answerSheet(it, f) {
  const d = (f && f.decisions.find((x) => x.id === it.decisionId)) || {};
  const answer = el("textarea", { rows: 4, name: "answer", required: "" });
  const rationale = el("input", { type: "text", name: "rationale" });
  const resolve = (status) =>
    guard(async () => {
      if (status === "accepted" && !answer.value.trim()) {
        answer.setAttribute("aria-invalid", "true");
        answer.focus();
        toast("Write an answer first.");
        return;
      }
      const body = { status };
      if (answer.value.trim()) body.answer = answer.value.trim();
      if (rationale.value.trim()) body.rationale = rationale.value.trim();
      await api("POST", `/decisions/${it.decisionId}/resolve`, body);
      // The agent that asked parked its ticket: answering does not move it back, so
      // offer the Unblock here instead of leaving the human to find the Blocked row.
      const parked = it.ticket && it.ticket.id ? await stillParked(it.ticket.id) : null;
      router();
      if (parked) {
        answeredUnblockSheet(parked.ticket, parked.waiting, status);
        return;
      }
      closeSheet();
      toast(status === "accepted" ? "Answered. Agents read it next time." : "Question rejected.", {
        ok: true,
      });
    });
  actionSheet(d.title || "Answer the decision", {
    intro: d.question || it.reason,
    body: el("div", { class: "stack" }, [
      field("Your answer", answer),
      field("Why (optional)", rationale),
    ]),
    actions: [
      el(
        "button",
        { class: "btn primary", type: "button", onclick: () => resolve("accepted") },
        "Answer",
      ),
      el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel"),
      el(
        "button",
        { class: "btn danger", type: "button", onclick: () => resolve("rejected") },
        "Reject the question",
      ),
    ],
  });
}

/**
 * The ticket a just-answered decision belongs to, when it is still Blocked: its row
 * and how many other decisions it still waits on. null when it is not blocked (or
 * the read fails: the plain "Answered" toast is then the honest fallback).
 */
async function stillParked(ticketId) {
  try {
    const v = await api("GET", `/tickets/${ticketId}`);
    if (!v || !v.ticket || v.ticket.status !== "blocked") return null;
    return { ticket: v.ticket, waiting: (v.blocking_decisions || []).length };
  } catch {
    return null;
  }
}

/**
 * After an answer (or a rejected question) on a ticket the agent parked: the same
 * sheet says the ticket is still Blocked and offers Unblock → Ready, the move the
 * human would otherwise make from the Blocked row. A human presses it; nothing
 * moves on its own. While other decisions still hold the ticket, it says so instead.
 */
function answeredUnblockSheet(t, waiting, status) {
  const ref = t.number != null ? `#${t.number}` : "this ticket";
  const done = status === "accepted" ? "Your answer is recorded." : "The question is rejected.";
  const close = el("button", { class: "btn", type: "button", onclick: closeSheet }, "Not now");
  if (waiting > 0) {
    actionSheet(`${ref} is still blocked`, {
      intro: `${done} ${ref} still waits on ${plural(waiting, "more decision")}: answer ${waiting === 1 ? "it" : "them"} before you unblock it.`,
      actions: [
        el("a", { class: "btn", href: `#/ticket/${t.id}`, onclick: closeSheet }, "Open the ticket"),
        el("button", { class: "btn", type: "button", onclick: closeSheet }, "Done"),
      ],
    });
    return;
  }
  const go = el(
    "button",
    {
      class: "btn primary answered-unblock",
      type: "button",
      onclick: () =>
        guard(async () => {
          await api("POST", `/tickets/${t.id}/move`, { to: "ready" });
          closeSheet();
          toast(
            `Unblocked ${ref}: it is Ready now${status === "accepted" ? ", with your answer in its next brief" : ""}.`,
            { ok: true },
          );
          router();
        }),
    },
    `Unblock ${ref} → Ready`,
  );
  actionSheet(`Unblock ${ref}?`, {
    intro: `${done} ${ref} is still Blocked: the agent parked it on this question, and answering does not move it back. Unblock it to Ready and an agent delivers it again${status === "accepted" ? ", reading your answer" : ""}.`,
    body: sheetTicket(t),
    actions: [go, close],
    focus: go,
  });
}

/** Merge an approved branch (the merge runner), or record that you merged it by hand. */
function mergeSheet(t) {
  const ref = t.number != null ? `#${t.number}` : "this ticket";
  actionSheet(`Merge ${ref}`, {
    intro:
      "It is approved, but its delivery branch has not merged. Merge runs the merge runner on the branch; the board updates when it lands.",
    actions: [
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/merge`);
              closeSheet();
              toast(`Merge started for ${ref}.`, { ok: true });
              router();
            }),
        },
        "Merge",
      ),
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/mark-merged`);
              closeSheet();
              toast(`${ref} marked merged.`, { ok: true });
              router();
            }),
        },
        "I merged it by hand",
      ),
      el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel"),
    ],
  });
}

/**
 * A delivery paused at a cap: the human's move is Continue (resume it in its kept
 * worktree) or Stop (abandon it), the same two the ticket page offers.
 */
function pausedSheet(t, it) {
  const ref = t.number != null ? `#${t.number}` : "this ticket";
  actionSheet(`${ref} is paused`, {
    intro: it.reason,
    actions: [
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/continue`, {});
              closeSheet();
              toast(`Continue requested: the factory resumes ${ref} where it stopped.`, {
                ok: true,
              });
              router();
            }),
        },
        "Continue",
      ),
      el(
        "button",
        {
          class: "btn danger",
          type: "button",
          title: "Stop: the ticket is cancelled and its worktree is removed on the next tick",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/stop`, {});
              closeSheet();
              toast(`Stopped ${ref}: it is cancelled; its worktree is removed on the next tick.`, {
                ok: true,
              });
              router();
            }),
        },
        "Stop",
      ),
      el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel"),
    ],
  });
}

/** Regulated tickets: the ready-approval a human must give before the queue takes it. */
function readyApprovalSheet(t, it) {
  const ref = t.number != null ? `#${t.number}` : "this ticket";
  actionSheet(`Approve ${ref} for the queue`, {
    intro: it.reason,
    actions: [
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () =>
            guard(async () => {
              await api("POST", `/tickets/${t.id}/ready-approval`);
              closeSheet();
              toast(`${ref} approved for the queue.`, { ok: true });
              router();
            }),
        },
        "Approve",
      ),
      el("a", { class: "btn", href: `#/ticket/${t.id}`, onclick: closeSheet }, "Open the ticket"),
    ],
  });
}

export {
  actionSheet,
  confirmSheet,
  valueSheet,
  hideRepoSheet,
  reasonSheet,
  wontDoSheet,
  unblockSheet,
  answerSheet,
  mergeSheet,
  pausedSheet,
  readyApprovalSheet,
};
