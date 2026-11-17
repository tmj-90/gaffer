// POST-MERGE FINDINGS AND LESSONS (backlog 59): the dashboard's two pieces, one module.
//
//  - findingsCard(t, findings): on the Ticket page of a DONE ticket, "Something was wrong
//    with this?" (a quiet secondary action that opens a small form: what went wrong, an
//    optional category, optional paths), and the findings written on it with who and when.
//    Each standing finding offers a person "Propose as a lesson", "Open a fix ticket" (the
//    confirm first asks the server what the regression link would do to autonomy and says
//    it) and "Withdraw" (with a reason). Mounted from ticket.js (one line).
//  - lessonsPanel(): on Health beside Escaped defects, "Lessons: N live, M drafts waiting,
//    recurrences after: k of n" and each lesson's before / after (GET /api/lessons).
//    Mounted from health.js (one line).
//
// Every write is a person's act: the server refuses an agent, a read-only token and an
// out-of-scope principal, and each control here is locked WHEN IT IS CREATED with the
// page's helper (roLock, kind "ticket"), including the ones built after an await. Labels
// read with a server string are table() lookups. State is said in words, never colour alone.

import { roLock } from "../access.js";
import { api } from "../api.js";
import { callout, dataTable, panelHead } from "../components.js";
import { el } from "../dom.js";
import { fmtTime } from "../format.js";
import { table } from "../lookup.js";
import { router } from "../router.js";
import { guard, toast } from "../toast.js";

/** The closed list of categories, in the order the form offers them. */
const CATEGORIES = [
  ["missed_requirement", "Missed requirement"],
  ["wrong_assumption", "Wrong assumption"],
  ["test_gap", "Test gap"],
  ["convention", "Convention"],
  ["other", "Other"],
];
const CATEGORY_LABEL = table(Object.fromEntries(CATEGORIES));

/** A lesson's lore status, in words. */
const LORE_STATUS_LABEL = table({
  draft: "Draft: waiting for a person in Memory",
  active: "Live",
  rejected: "Rejected",
  deprecated: "Retired",
  superseded: "Superseded",
});

const who = (by) => (by && (by.id || by.type)) || "someone";

/** A button that is a person's act on this ticket: locked when created for who may not. */
function actButton(label, onclick, cls = "btn small") {
  return roLock(el("button", { class: cls, type: "button", onclick }, label), "ticket");
}

/** The inline Withdraw form for one finding (a reason is required). */
function withdrawForm(t, f, host) {
  const reason = roLock(
    el("input", {
      class: "input",
      type: "text",
      maxlength: "500",
      required: "required",
      placeholder: "Why it is withdrawn",
      "aria-label": "Why the finding is withdrawn",
    }),
    "ticket",
  );
  const form = el(
    "form",
    {
      class: "fd-inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        const why = reason.value.trim();
        if (!why) return;
        guard(async () => {
          await api("POST", `/tickets/${t.id}/findings/${f.id}/withdraw`, { reason: why });
          toast("Finding withdrawn. It stays on the record, marked.", { ok: true });
          router();
        });
      },
    },
    [
      reason,
      roLock(el("button", { class: "btn small", type: "submit" }, "Withdraw"), "ticket"),
      el("button", { class: "btn small quiet", type: "button", onclick: () => form.remove() }, "Cancel"),
    ],
  );
  host.appendChild(form);
  reason.focus?.();
}

/**
 * "Open a fix ticket": ask the server what the regression link would do (it steps
 * autonomy down when an agent approved the change), say it, then let the person confirm.
 * The confirm button is created after the read: locked at creation.
 */
export async function fixTicketConfirm(t, f, host) {
  const p = await api("GET", `/tickets/${t.id}/findings/${f.id}/fix-ticket`);
  const box = el("div", { class: "fd-confirm", role: "group", "aria-label": "Open a fix ticket" }, [
    el(
      "p",
      {},
      `A new ticket at the same risk, delivering to the same repository, with this finding quoted, linked as a regression of #${(p.regression_of && p.regression_of.number) ?? "?"}.`,
    ),
    callout({
      tone: p.steps_down ? "needs" : "info",
      title: p.steps_down ? "Autonomy steps down." : "No autonomy change.",
      body: String(p.message || ""),
      cls: "fd-autonomy",
    }),
  ]);
  box.appendChild(
    el("div", { class: "fd-actions" }, [
      actButton(
        "Open the fix ticket",
        () =>
          guard(async () => {
            const r = await api("POST", `/tickets/${t.id}/findings/${f.id}/fix-ticket`);
            const n = r && r.ticket ? r.ticket.number : null;
            toast(`Opened fix ticket #${n ?? "?"}.`, { ok: true });
            if (r && r.ticket && r.ticket.id) location.hash = `#/ticket/${r.ticket.id}`;
            else router();
          }),
        "btn small primary",
      ),
      el("button", { class: "btn small quiet", type: "button", onclick: () => box.remove() }, "Cancel"),
    ]),
  );
  host.appendChild(box);
}

/** One finding as the card lists it. */
function findingItem(t, f) {
  const cat = f.category ? CATEGORY_LABEL[f.category] || "Other" : null;
  const item = el("li", { class: "fd-item", dataset: { finding: f.id } }, [
    el("p", { class: "fd-meta" }, [
      cat ? el("b", { class: "fd-cat" }, cat) : el("b", { class: "fd-cat" }, "Finding"),
      ` · ${who(f.filed_by)}, ${fmtTime(f.filed_at)}`,
      f.regression_ticket
        ? ` · from the regression link on #${f.regression_ticket.number ?? "?"}`
        : "",
    ]),
    el("p", { class: "fd-text" }, String(f.text || "")),
    f.paths && f.paths.length
      ? el("p", { class: "fd-paths dim" }, [
          f.paths_source === "delivery" ? "Paths (from the delivery): " : "Paths: ",
          f.paths.join(", "),
        ])
      : null,
    f.withdrawn
      ? el("p", { class: "fd-state fd-withdrawn" }, [
          el("b", {}, "Withdrawn"),
          ` by ${who(f.withdrawn.by)}, ${fmtTime(f.withdrawn.at)}: ${f.withdrawn.reason || ""}`,
        ])
      : null,
    f.lesson
      ? el("p", { class: "fd-state fd-lesson" }, [
          el("b", {}, "Proposed as a lesson"),
          f.lesson.lore_id ? ` (${f.lesson.lore_id})` : "",
          ". A person approves it in ",
          el("a", { href: "#/memory" }, "Memory"),
          "; then later changes on these paths see it.",
        ])
      : null,
    f.fix_ticket
      ? el("p", { class: "fd-state fd-fix" }, [
          el("b", {}, "Fix ticket "),
          el(
            "a",
            { href: `#/ticket/${f.fix_ticket.ticket_id}` },
            `#${f.fix_ticket.number ?? "?"}`,
          ),
        ])
      : null,
  ]);
  if (!f.withdrawn) {
    const actions = el("div", { class: "fd-actions" });
    if (!f.lesson)
      actions.appendChild(
        actButton("Propose as a lesson", () =>
          guard(async () => {
            await api("POST", `/tickets/${t.id}/findings/${f.id}/lesson`);
            toast("Proposed as a lesson: it waits for a person's approval in Memory.", {
              ok: true,
            });
            router();
          }),
        ),
      );
    if (!f.fix_ticket)
      actions.appendChild(
        actButton("Open a fix ticket", () => {
          if (item.querySelector(".fd-confirm")) return;
          guard(() => fixTicketConfirm(t, f, item));
        }),
      );
    actions.appendChild(
      actButton(
        "Withdraw",
        () => {
          if (!item.querySelector(".fd-inline-form")) withdrawForm(t, f, item);
        },
        "btn small quiet",
      ),
    );
    item.appendChild(actions);
  }
  return item;
}

/** The small "what went wrong" form, opened by the quiet secondary action. */
function addForm(t, host) {
  const text = roLock(
    el("textarea", {
      class: "input fd-text-input",
      rows: "3",
      maxlength: "2000",
      required: "required",
      "aria-label": "What went wrong",
      placeholder: "What went wrong after it was done",
    }),
    "ticket",
  );
  const cat = roLock(
    el("select", { class: "input", "aria-label": "Category (optional)" }, [
      el("option", { value: "" }, "No category"),
      ...CATEGORIES.map(([v, l]) => el("option", { value: v }, l)),
    ]),
    "ticket",
  );
  const paths = roLock(
    el("input", {
      class: "input",
      type: "text",
      maxlength: "2000",
      "aria-label": "Paths it concerns (optional, comma separated)",
      placeholder: "Paths (optional; default: what the change touched)",
    }),
    "ticket",
  );
  const form = el(
    "form",
    {
      class: "fd-form",
      onsubmit: (e) => {
        e.preventDefault();
        const body = { text: text.value.trim() };
        if (!body.text) return;
        if (cat.value) body.category = cat.value;
        const ps = paths.value
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        if (ps.length) body.paths = ps;
        guard(async () => {
          await api("POST", `/tickets/${t.id}/findings`, body);
          toast("Recorded. It counts as feedback, and can become a lesson or a fix ticket.", {
            ok: true,
          });
          router();
        });
      },
    },
    [
      el("label", { class: "dim" }, "What went wrong"),
      text,
      el("div", { class: "fd-row" }, [cat, paths]),
      el("div", { class: "fd-actions" }, [
        roLock(el("button", { class: "btn small primary", type: "submit" }, "Record it"), "ticket"),
        el("button", { class: "btn small quiet", type: "button", onclick: () => form.remove() }, "Cancel"),
      ]),
    ],
  );
  host.appendChild(form);
  text.focus?.();
}

/**
 * The Ticket page's findings card. Nothing for a ticket that is not done and has none.
 * @param {{id: string, status: string}} t
 * @param {Array<object>|undefined} findings
 */
export function findingsCard(t, findings) {
  const list = Array.isArray(findings) ? findings : [];
  const done = t && t.status === "done";
  if (!done && list.length === 0) return null;
  const section = el(
    "section",
    { class: "card panel fd-card", "aria-label": "What went wrong after it was done" },
    [panelHead("What went wrong after it was done", null, null, { level: 3 })],
  );
  if (list.length)
    section.appendChild(el("ul", { class: "fd-list" }, list.map((f) => findingItem(t, f))));
  if (done) {
    const host = el("div", { class: "fd-add" });
    host.appendChild(
      actButton(
        "Something was wrong with this?",
        () => {
          if (!host.querySelector(".fd-form")) addForm(t, host);
        },
        "btn-link fd-open",
      ),
    );
    section.appendChild(host);
  }
  section.appendChild(
    el(
      "p",
      { class: "dim fd-foot" },
      "A person's word, kept on the record. A finding the factory learns from becomes a lesson only when a person approves it.",
    ),
  );
  return section;
}

const kOfN = (k, n, rate) => `${k} of ${n}${rate == null ? "" : ` (${rate}%)`}`;

/** The rendered lessons panel for a report (pure: exported for the page and the tests). */
export function renderLessons(r) {
  const k = (r && r.recurrences_after) || { k: 0, n: 0 };
  const lessons = (r && Array.isArray(r.lessons) && r.lessons) || [];
  const live = (r && r.live) || 0;
  const drafts = (r && r.drafts_waiting) || 0;
  return [
    el(
      "p",
      { class: "fd-summary" },
      `Lessons: ${live} live, ${drafts} draft${drafts === 1 ? "" : "s"} waiting, recurrences after: ${k.k} of ${k.n}`,
    ),
    lessons.length
      ? dataTable({
          caption: "Each lesson: changes on its paths, and how many had something go wrong after",
          stackOnPhone: true,
          cls: "fd-lessons-table",
          columns: [
            {
              key: "number",
              label: "From",
              format: (_v, l) =>
                el("a", { href: `#/ticket/${l.ticket_id}` }, `#${l.number ?? "?"}`),
            },
            {
              key: "lore_status",
              label: "Status",
              format: (v) => (v ? LORE_STATUS_LABEL[v] || String(v) : "Unknown (memory did not say)"),
            },
            { key: "paths", label: "Paths", format: (v) => (Array.isArray(v) ? v.join(", ") : "") },
            {
              key: "before",
              label: "Before",
              format: (_v, l) =>
                kOfN(l.measure.recurrences_before, l.measure.changes_before, l.measure.rate_before_pct),
            },
            {
              key: "after",
              label: "After",
              format: (_v, l) =>
                l.measure.state === "not_approved"
                  ? "not live yet"
                  : kOfN(l.measure.recurrences_after, l.measure.changes_after, l.measure.rate_after_pct),
            },
          ],
          rows: lessons,
        })
      : el("p", { class: "dim" }, "No lesson yet: one is proposed from a finding on a done ticket."),
    r && r.note ? el("p", { class: "dim fd-note" }, String(r.note)) : null,
  ];
}

/** Health's lessons section: drawn now, filled when GET /api/lessons answers. */
export function lessonsPanel() {
  const body = el("div", { class: "fd-lessons-body" }, [el("p", { class: "dim" }, "Reading lessons.")]);
  const section = el("section", { class: "card panel fd-lessons", "aria-label": "Lessons" }, [
    panelHead("Lessons from findings", "what went wrong after a change was done", null, { level: 2 }),
    body,
  ]);
  api("GET", "/api/lessons")
    .then((r) => body.replaceChildren(...renderLessons(r).filter(Boolean)))
    .catch((e) => {
      if (e && e.code === "ABORTED") return;
      body.replaceChildren(el("p", { class: "dim" }, "Lessons could not be read."));
    });
  return section;
}
