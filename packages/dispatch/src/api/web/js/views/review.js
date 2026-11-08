// View: Review queue (the clear desk and The Gaffer's Sign-off).
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { lockReason, readOnly, roLock } from "../access.js";
import { api } from "../api.js";
import { ensureAgents } from "../club.js";
import { panelHead, statCell } from "../components.js";
import { renderTicketDiff, repoDiffSection, safeHttpUrl } from "../diff.js";
import { app, clear, el, prefersReducedMotion } from "../dom.js";
import { fmtDuration, fmtRelative, fmtTime, plural } from "../format.js";
import { agentChip, glyph, icon, repoTag, ycard } from "../icons.js";
import { clearDeskSignature, reviewSignature, updateNavBadges } from "../live.js";
import { allTickets, hlWork } from "../matchday.js";
import { navigate, routeSignal, router } from "../router.js";
import { confirmSheet, reasonSheet } from "../sheets.js";
import { hasTicketAction, riskBadge, statusBadge, statusLabel } from "../status.js";
import { guard, toast } from "../toast.js";
import {
  REJECT_REASON_PRESETS,
  WONT_DO_PRESETS,
  acChecklist,
  blockedWrites,
  commentWhere,
  decorateCommentable,
  deliveredBy,
  diffRowAnchor,
  dodChecklist,
  isModalOpen,
  markOutsideFiles,
  noteReviewOpen,
  outsideStatedChange,
  parseDodEvidence,
  reopenedForReview,
  repoPath,
  revealJudge,
  reviewCommentComposer,
  reviewCommentItem,
  reviewEvidenceList,
  reviewedBy,
  sinceStatus,
} from "./review-comments.js";
import {
  acTable,
  approvedFallback,
  backingPanel,
  humanAsks,
  impactBacking,
  impactPanel,
  integrityBanner,
  intentBlock,
  packetDod,
  prunePacketCache,
  reviewFlag,
  reviewPacketFor,
  sameSha,
  testModifiedAnns,
  verdictStrip,
} from "./review-packet.js";

/** The change last signed off in this tab, so the clear desk can say where it went. */
let lastSignedOff = null;

/**
 * STALE REVISION: set when an approval was refused because the branch moved after the
 * diff was shown. The re-rendered Review view reads it once and says so above the new
 * diff, so the human knows what they are now looking at is a different commit.
 */
let reviewMovedNotice = null;

/** The commits a rendered diff covered: one `{ repo, sha }` per repo with a known head. */
function shownCommits(repos) {
  return (repos || [])
    .filter((r) => r && typeof r.headSha === "string" && r.headSha)
    .map((r) => ({ repo: r.repoId || r.repo, sha: r.headSha }));
}

/** True for the server's "the change moved since it was shown" refusals. */
function isStaleRevision(e) {
  const reason = e && e.details && e.details.reason;
  return (
    Boolean(e) &&
    e.status === 409 &&
    (reason === "stale_revision" || reason === "revision_required")
  );
}

/**
 * The Review page with nothing waiting: the desk is clear, said on the stadium
 * board, with where the signed work is now (testing, to merge, full time) and
 * who is still on the pitch, so the next stop is one click away.
 */
async function renderClearDesk(wrap) {
  const signal = routeSignal();
  const [all, claims, dash] = await Promise.all([
    allTickets("", { signal }).then((r) => r.tickets || []),
    api("GET", "/claims", undefined, { signal })
      .then((r) => r.claims || [])
      .catch(() => []),
    api("GET", "/api/dashboard", undefined, { signal })
      .then((r) => r.summary || null)
      .catch(() => null),
  ]);
  wrap.dataset.sig = clearDeskSignature(all);
  const by = (st) => all.filter((t) => t.status === st);
  const testing = by("in_testing");
  const toMerge = by("ready_for_merge");
  const playing = all.filter((t) => t.status === "claimed" || t.status === "in_progress");
  const readyN = by("ready").length;
  const medianReview = (dash?.cycleTimeByState || []).find((c) => c.status === "in_review");
  const delivered = dash?.deliveredToday;

  const signed =
    lastSignedOff && all.find((t) => t.id === lastSignedOff.id && t.status !== "in_review");
  // The line under the headline: where the work is, each part a way to get there.
  const others = [
    dash?.blocked ? plural(dash.blocked, "blocked ticket") : null,
    dash?.openDecisions ? plural(dash.openDecisions, "decision") : null,
  ].filter(Boolean);
  const bits = [
    signed
      ? [
          "you signed ",
          el("a", { href: `#/ticket/${signed.id}` }, `#${signed.number}`),
          ` ${fmtRelative(lastSignedOff.at)}; it is ${statusLabel(signed.status, signed.landing_state).toLowerCase()} now`,
        ]
      : null,
    playing.length
      ? el(
          "a",
          { href: "#/work?status=in_progress" },
          `${plural(playing.length, "change")} on the pitch`,
        )
      : "no one on the pitch",
    others.length
      ? el("a", { href: "#/overview" }, `${others.join(" and ")} on your team sheet`)
      : null,
    delivered != null ? `${plural(delivered, "ticket")} landed today` : null,
    medianReview && medianReview.samples
      ? `a change waits ${fmtDuration(medianReview.medianMs)} for you, on the median`
      : null,
  ].filter(Boolean);
  const sub = el("p", { class: "hl-sub" });
  bits.forEach((b, i) => {
    if (i) sub.appendChild(el("span", { class: "sep", "aria-hidden": "true" }, "\u00a0· "));
    sub.append(...[].concat(b));
  });
  if (sub.firstChild && sub.firstChild.nodeType === 3)
    sub.firstChild.textContent = sub.firstChild.textContent.replace(/^./, (c) => c.toUpperCase());
  wrap.appendChild(
    el("section", { class: "scoreboard bleed rv-clear-board", "aria-label": "Review" }, [
      el("div", { class: "scoreboard-in" }, [
        el("div", { class: "sb-main" }, [
          el("h1", { class: "hl" }, "Desk clear. Nothing waits for your sign-off."),
          sub,
        ]),
        el(
          "div",
          { class: "sb-cells kpi-row", role: "group", "aria-label": "Around the sign-off" },
          [
            statCell({ label: "Waiting", value: "00", flip: "rv-wait", title: "0 in review" }),
            statCell({
              label: "In testing",
              value: String(testing.length).padStart(2, "0"),
              href: "#/work?status=in_testing",
              flip: "rv-test",
              title: `${testing.length} with the tester`,
            }),
            statCell({
              label: "To merge",
              value: String(toMerge.length).padStart(2, "0"),
              href: "#/work?status=ready_for_merge",
              flip: "rv-merge",
              title: `${toMerge.length} approved, with the merge runner`,
            }),
            statCell({
              label: "On the pitch",
              value: String(playing.length).padStart(2, "0"),
              href: "#/work",
              flip: "rv-pitch",
              title: `${playing.length} being delivered`,
            }),
          ],
        ),
      ]),
    ]),
  );

  // Since the whistle: the latest changes past the sign-off, newest first.
  const past = all
    .filter((t) => ["in_testing", "ready_for_merge", "done", "cancelled"].includes(t.status))
    .sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0))
    .slice(0, 6);
  const resultRow = (t) =>
    el("li", { class: `rv-res${signed && t.id === signed.id ? " is-yours" : ""}` }, [
      el("span", { class: "rv-res-no" }, `#${t.number}`),
      el("a", { class: "rv-res-t", href: `#/ticket/${t.id}` }, t.title),
      el("span", { class: "rv-res-st" }, [
        statusBadge(t.status, t.landing_state),
        signed && t.id === signed.id ? el("small", { class: "rv-res-you" }, "you signed it") : null,
      ]),
      el(
        "time",
        { class: "rv-res-when tabnum", datetime: t.updated_at, title: fmtTime(t.updated_at) },
        fmtRelative(t.updated_at),
      ),
    ]);
  const results = el(
    "section",
    { class: "card panel rv-results", "aria-label": "Latest results" },
    [
      panelHead("Latest results", null, { href: "#/work", text: "The board" }, { kit: "ink" }),
      past.length
        ? el("ol", { class: "rv-res-list" }, past.map(resultRow))
        : el("p", { class: "dim" }, "Nothing has come through the sign-off yet."),
    ],
  );

  // Still playing: who is delivering what, so you know what lands here next.
  const claimFor = new Map(claims.map((c) => [c.ticket_id, c]));
  const playRow = (t) => {
    const c = claimFor.get(t.id);
    return el("li", { class: "rv-res" }, [
      el("span", { class: "rv-res-no" }, `#${t.number}`),
      el("a", { class: "rv-res-t", href: `#/ticket/${t.id}` }, t.title),
      el("span", { class: "rv-res-st" }, [
        c && c.agent_id
          ? agentChip(c.agent_id, c.agent_display_name, 22)
          : statusBadge(t.status, t.landing_state),
      ]),
      el(
        "span",
        { class: "rv-res-when tabnum" },
        c && c.created_at ? `on for ${fmtDuration(Date.now() - Date.parse(c.created_at))}` : "",
      ),
    ]);
  };
  const coming = el(
    "section",
    { class: "card panel rv-coming", "aria-label": "Coming off the pitch" },
    [
      panelHead("Coming your way", playing.length ? String(playing.length) : null, null, {
        kit: "claret",
      }),
      playing.length
        ? el("ol", { class: "rv-res-list" }, playing.map(playRow))
        : el("p", { class: "dim" }, [
            readyN
              ? `${plural(readyN, "ticket")} ${readyN === 1 ? "waits" : "wait"} in the fixtures for a free agent. `
              : "The fixtures are empty too. ",
            el("a", { href: "#/work?status=ready" }, "See the fixtures"),
          ]),
    ],
  );
  wrap.appendChild(el("div", { class: "rv-clear-grid" }, [coming, results]));
}

/**
 * Review: the gaffer's sign-off, one change per page. The queue runs across the
 * top as tabs (#/review/<id>; #/review opens the first). The sign-off block —
 * Approve, Send back, Won't do — sits above the fold beside the diff, with the
 * flags (yellow cards) under it and a goal-difference file list over the diff.
 * Keys: j / k next / previous change, a arm → a approve, r send back.
 */
async function renderReview(param) {
  // Every ticket in review (GET /tickets answers 500 rows a page), the same read the
  // refresh signature makes, so a long queue neither loses its tail nor re-renders.
  const tickets = (await allTickets("status=in_review", { full: true })).tickets;
  const wrap = el("div", { class: "view view-review" });
  // The refresh compares this before re-reading anything (see VIEW_SIGNATURES).
  wrap.dataset.sig = reviewSignature(tickets);
  await ensureAgents();

  const idx = Math.max(0, param ? tickets.findIndex((t) => t.id === param) : 0);
  const gone = param && !tickets.some((t) => t.id === param);

  if (tickets.length === 0 && !gone) {
    wrap.classList.add("rv-clear");
    await renderClearDesk(wrap);
    return wrap;
  }

  const signal = routeSignal();
  // The queue: one tab per change waiting, the current one marked.
  const queue = el(
    "nav",
    {
      class: "rv-queue",
      "aria-label": `Review queue: ${plural(tickets.length, "change")} waiting`,
    },
    tickets.map((q, i) =>
      el(
        "a",
        {
          class: "rv-tab",
          href: `#/review/${q.id}`,
          "aria-current": !gone && i === idx ? "page" : null,
          "aria-label": `#${q.number} ${q.title}`,
        },
        [
          glyph("in_review", 16),
          el("b", {}, q.number != null ? `#${q.number}` : "—"),
          el("span", { class: "rv-tab-t", title: q.title }, q.title),
        ],
      ),
    ),
  );
  if (tickets.length) wrap.appendChild(queue);

  if (gone) {
    // The change was signed off (or moved) since this link was made: say where it is.
    const v = await api("GET", `/tickets/${param}`, undefined, { signal }).catch(() => null);
    const t = v && v.ticket;
    wrap.appendChild(
      el("div", { class: "card rv-gone", role: "status" }, [
        el(
          "h1",
          { class: "rv-gone-h" },
          t
            ? [...hlWork(t), ` is ${statusLabel(t.status, t.landing_state).toLowerCase()} now.`]
            : "That change is not in review.",
        ),
        el("p", {}, [
          t ? el("a", { href: `#/ticket/${t.id}` }, "Open the ticket") : null,
          t && tickets.length ? " · " : null,
          tickets.length
            ? el(
                "a",
                { href: `#/review/${tickets[0].id}` },
                `Next in review: #${tickets[0].number}`,
              )
            : "Nothing else waits for your sign-off.",
        ]),
      ]),
    );
    return wrap;
  }

  const t = tickets[idx];
  const next = tickets[idx + 1] || (idx > 0 ? tickets[0] : null);
  prunePacketCache(tickets);
  // The detail and the review packet (one dossier read, cached per id@updated_at)
  // in parallel; a packet that cannot be read leaves the page as it was without it.
  const [detail, packet] = await Promise.all([
    api("GET", `/tickets/${t.id}`, undefined, { signal }),
    reviewPacketFor(t, signal).catch(() => null),
  ]);
  const ac = detail.acceptance_criteria || [];
  const evidence = detail.evidence || [];
  const ticketEvents = detail.events || [];
  const isReopened = reopenedForReview(ticketEvents);
  // REVIEW COMMENTS: the reviewer's comments (the detail carries them; the anchor states
  // come from GET …/review/comments?anchors=1, which runs git) and the server's Fix these
  // outcome. The open ones join the one flags list below.
  let comments = Array.isArray(detail.review_comments) ? detail.review_comments : [];
  let fixOutcome = null;
  const attemptNow = Number((detail.ticket || t).attempt_count) || 0;
  const openComments = () => comments.filter((c) => c.status === "open");
  const openMustFix = () => openComments().filter((c) => c.severity === "must_fix");
  const commentFlag = () => {
    const open = openComments().length;
    if (!open) return [];
    const must = openMustFix().length;
    return [
      [
        "Open comments",
        `Open comments: ${open} (${must} must-fix). ` +
          (must
            ? "Fix these sends the must-fix ones back as numbered requirements; resolve the ones this change answers."
            : "Resolve them, or leave them as notes for later."),
        "From the review comments on this change",
      ],
    ];
  };
  const satisfied = ac.filter((a) => a.status === "satisfied").length;
  const repo =
    (detail.repositories || []).find((r) => r.access === "write") || detail.repositories?.[0];
  const by = deliveredBy(ticketEvents);
  const rby = reviewedBy(detail.ticket || t, ticketEvents);
  const since = sinceStatus(ticketEvents, "in_review");
  // REVIEW TELEMETRY: a person has this ticket on screen in this review round.
  noteReviewOpen(t.id, since);
  // ONE SOURCE for the gates: with a review packet, the verdict strip's rows (the server's
  // read of the runner's DoD record); without one (an older server), the evidence row.
  const dod = packet ? packetDod(packet) : parseDodEvidence(evidence);
  const writes = blockedWrites(evidence);
  // Every row below that asks for a human: the flags, the summary and the warnings
  // beside the button read this one list.
  const asks = humanAsks(evidence, ticketEvents, dod);
  // Once the diff shows the tests changed, the integrity asks are that finding: the
  // `test-modified` flag and the test-changes banner say it, never twice.
  let shownAsks = asks;
  const prUrl = safeHttpUrl(t.pr_url);

  // Fix 4: a human must not approve a change they couldn't see. Approve starts
  // DISABLED and only enables once the diff loads with a real, non-empty change.
  let diffState = { approvable: false, reason: "Loading the delivery diff…" };
  // What Approve does, as the server computes it from the settings and ticket state the
  // approve path acts on (GET /diff's approve_outcome). Until it arrives the button just
  // says "Approve"; it never promises a merge the click will not start.
  let outcome = null;
  const isApproved = () => Boolean(approveBtn && approveBtn.classList.contains("is-approved"));
  // The repos (with their head commits) the diff below rendered — what Approve covers.
  let diffRepos = [];
  // The sign-off's status line: hidden until Approve lands, then it says where the
  // change went and offers the next one as its own link (never auto-advanced).
  const doneLine = el("p", { class: "rv-done", role: "status", tabindex: "-1", hidden: "" });
  const approve = () =>
    guard(async () => {
      // Signed once: a second press (click or key) on a signed change does nothing.
      if (approveBtn && approveBtn.classList.contains("is-approved")) return;
      if (!diffState.approvable) {
        toast(`Can't approve — ${diffState.reason}`, {});
        return;
      }
      // Approve exactly what was shown: the head commit of every repo the diff rendered.
      // A branch that moved since is refused (409 stale_revision) and nothing is approved.
      let r;
      try {
        r = await api("POST", `/tickets/${t.id}/review/approve`, {
          commits: shownCommits(diffRepos),
        });
      } catch (e) {
        if (!isStaleRevision(e)) throw e;
        reviewMovedNotice = { id: t.id, message: e.message };
        toast("Not approved — the change moved since you opened it. The new diff is loaded.", {});
        router();
        return;
      }
      const to = r && r.ticket && r.ticket.status;
      // What the click actually did: the server settles its outcome against the real
      // route (the tester, a merge started or skipped). An older server sends none, so
      // read the status and the merge result instead.
      const done = (r && r.approve_outcome) || approvedFallback(to, r && r.merge);
      lastSignedOff = { id: t.id, number: t.number, at: new Date().toISOString() };
      // Stay on the diff: the button says it is done and where the change went, and
      // moving on is its own link.
      if (approveBtn) {
        approveBtn.setAttribute("disabled", "");
        approveBtn.classList.add("is-approved");
        approveLabel.textContent = `Approved · ${done.done_label}`;
        approveBtn.setAttribute("aria-label", `Approved #${t.number}: ${done.done_label}`);
        approveBtn.prepend(icon("check", "", 20));
      }
      nextLine.hidden = true;
      // The yellow card is withdrawn from the title; the queue tab shows the move.
      const card = wrap.querySelector(".rv-title .rv-card");
      if (card && !prefersReducedMotion() && typeof card.animate === "function")
        card
          .animate(
            [
              { transform: "rotate(-8deg)", opacity: 1 },
              { transform: "rotate(-30deg) translate(-6px, 30px)", opacity: 0 },
            ],
            { duration: 300, easing: "cubic-bezier(.5,0,.75,0)", fill: "forwards" },
          )
          .finished.then(() => card.remove())
          .catch(() => card.remove());
      else if (card) card.remove();
      const tab = wrap.querySelector('.rv-tab[aria-current="page"]');
      if (tab) {
        tab.querySelector(".glyph")?.replaceWith(glyph(to || "ready_for_merge", 16));
        tab.appendChild(el("small", { class: "rv-tab-done" }, "approved"));
      }
      const meta = wrap.querySelector(".rv-meta .badge.st");
      // Where the landing is now, in the server's words: the approved ticket's own
      // landing_state (what the ticket page, the board and the queue say, a usage pause
      // included), else the approval's outcome.
      const landed = {
        land_now: "Approved · landing",
        land_next_tick: "Approved · lands next tick",
        waits_for_merge: "Approved · waiting for Merge now",
      }[done.kind];
      const landing =
        (r && r.ticket && r.ticket.landing_state) ||
        (landed ? { label: landed, detail: done.sentence } : undefined);
      if (meta && to) meta.replaceWith(statusBadge(to, landing));
      clear(doneLine);
      doneLine.append(
        el("span", { class: "rv-done-t" }, [
          el("b", {}, `Approved #${t.number}.`),
          ` ${done.sentence} `,
        ]),
        next
          ? el("a", { class: "rv-next-link", href: `#/review/${next.id}` }, [
              `Next in review: #${next.number}`,
              icon("chevron", "", 16),
            ])
          : "Nothing else waits for your sign-off.",
      );
      wrap.querySelector(".rv-keys")?.remove();
      doneLine.hidden = false;
      doneLine.focus({ preventScroll: true });
      // Pin the address to this change, so a later refresh says where it went
      // instead of silently swapping the next change in under the reader.
      if (!param && typeof history !== "undefined" && history.replaceState)
        history.replaceState(null, "", `#/review/${t.id}`);
      toast(`Approved — ${done.done_label.toLowerCase()}`, { ok: true });
      updateNavBadges();
    });
  const reject = (to) => {
    const ref = `#${t.number}`;
    const wont = to === "cancelled";
    reasonSheet({
      title: wont ? `Won't do ${ref}` : `Send ${ref} back`,
      ticket: t,
      intro: wont
        ? `${ref} closes without merging and goes to Won't do. Its acceptance criteria reset to not met. You can reopen it into Refining later.`
        : `${ref} goes back to Refining with your reason, and its acceptance criteria reset to not met. You look at it there before an agent delivers it again.`,
      label: wont ? "Why not?" : "What should change?",
      presets: wont ? WONT_DO_PRESETS : REJECT_REASON_PRESETS,
      confirm: wont ? "Won't do" : "Send back",
      tone: wont ? "danger" : "primary",
      capture: true,
      onConfirm: async (reason, captureLore) => {
        const resp = await api("POST", `/tickets/${t.id}/review/reject`, {
          to,
          reason,
          captureLore,
        });
        // One toast for the act and the capture: two fired back to back, and the
        // second replaced the first before it could be read.
        const done = wont ? `${ref} closed as won't do` : `${ref} sent back`;
        const cap = captureLore ? resp && resp.lore_capture : null;
        // The draft waits for a human in Memory: say where, and link there.
        if (cap && cap.captured)
          toast(`${done} · reason filed as draft lore${cap.repo ? ` for ${cap.repo}` : ""}.`, {
            ok: true,
            link: {
              href: cap.repo ? `#/memory/${encodeURIComponent(cap.repo)}` : "#/memory",
              text: "Approve it in Memory",
            },
          });
        else if (cap)
          toast(`${done}, but the lore draft could not be filed (memory is unavailable).`);
        else toast(wont ? `${done}.` : `${done} to Refining.`, { ok: true });
        router();
      },
    });
  };

  const canApprove = hasTicketAction(t.status, "approve");
  // Approve is a two-step arm→confirm, by click or by key.
  const ARM_WINDOW_MS = 3000;
  const approveLabel = el("span", {}, "Approve");
  // One line under the button: what follows the click (the outcome's sentence).
  const nextLine = el("p", {
    class: "signoff-next",
    id: `signoff-next-${t.id}`,
    "aria-live": "polite",
    hidden: "",
  });
  const approveBtn = canApprove
    ? el(
        "button",
        {
          class: "btn primary big signoff-btn",
          type: "button",
          disabled: "",
          "aria-label": "Approve",
          "aria-describedby": nextLine.id,
        },
        [approveLabel],
      )
    : null;
  roLock(approveBtn, "ticket");
  const restLabel = () => (outcome ? outcome.label : "Approve");
  // One arm for both paths: the first `a` or click raises the yellow card on the
  // button (the outcome's confirm label: "Confirm: send to tester", "Confirm and land
  // now"…), rings the sign-off block and shows the 3s window draining under the
  // buttons; a second press inside it approves. Esc, j/k, leaving the button or the
  // window running out all put it down again.
  let armed = false;
  let armedVia = null;
  let armTimer = null;
  const armHint = el("p", { class: "rv-arm", role: "status", hidden: "" });
  const disarm = () => {
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    armed = false;
    armedVia = null;
    signoff?.classList.remove("card-armed");
    armHint.hidden = true;
    clear(armHint);
    if (!approveBtn) return;
    approveBtn.classList.remove("btn-armed");
    if (!isApproved()) {
      approveLabel.textContent = restLabel();
      approveBtn.setAttribute("aria-label", restLabel());
    }
  };
  const arm = (via) => {
    disarm();
    armed = true;
    armedVia = via;
    signoff?.classList.add("card-armed");
    const confirm = outcome ? outcome.confirm_label : "Confirm approval";
    if (approveBtn && !approveBtn.disabled) {
      approveBtn.classList.add("btn-armed");
      approveLabel.textContent = confirm;
      approveBtn.setAttribute("aria-label", `${confirm}: approve #${t.number}`);
    }
    armHint.append(
      el("span", { class: "rv-arm-t" }, [
        el("b", {}, "Armed. "),
        via === "key"
          ? [el("span", { class: "kbd" }, "a"), " again to approve"]
          : "Click again to approve",
        " · ",
        el("span", { class: "kbd" }, "Esc"),
        " puts it down",
      ]),
      el("span", { class: "rv-arm-clock", "aria-hidden": "true" }, [el("span", {})]),
    );
    armHint.hidden = false;
    armTimer = setTimeout(disarm, ARM_WINDOW_MS);
  };
  let signoff = null;
  const onApproveClick = () => {
    if (!diffState.approvable) {
      toast(`Can't approve — ${diffState.reason}`, {});
      return;
    }
    if (armed) {
      disarm();
      approve();
      return;
    }
    arm("click");
  };
  if (approveBtn) {
    approveBtn.addEventListener("click", onApproveClick);
    // A click-arm is put down when the pointer/focus leaves the button.
    approveBtn.addEventListener("blur", () => armedVia === "click" && disarm());
  }
  const diffBlockBanner = el(
    "div",
    { class: "reopen-banner diff-block-banner", style: "display:none" },
    [icon("alert"), ""],
  );
  // The approval just refused as stale: say the change moved, once, above the new diff.
  const moved = reviewMovedNotice && reviewMovedNotice.id === t.id ? reviewMovedNotice : null;
  if (moved) reviewMovedNotice = null;
  const movedBanner = moved
    ? el(
        "div",
        {
          class: "reopen-banner diff-moved-banner",
          role: "alert",
          "aria-label": "The change moved since you opened it, so nothing was approved.",
        },
        [
          icon("alert"),
          el("span", {}, [
            el("b", {}, "The change moved since you opened it. "),
            "Nothing was approved. The diff below is the new head — review it again before you approve. ",
            el("small", { class: "mono" }, moved.message),
          ]),
        ],
      )
    : null;
  // GATE INTEGRITY: filled once the diff loads, from the server's `test-modified` flag.
  const integritySlot = el("div", { class: "integrity-slot" });

  // Flags: what to look at before signing. Evidence flags now; the diff's risk
  // annotations join them once the diff loads.
  const flagList = el("ul", { class: "flag-list" });
  const flagCount = el("span", { class: "panel-aux" });
  const summary = el("p", { class: "signoff-sum" });
  const flagsNow = [];
  if (isReopened)
    flagsNow.push([
      "Merge conflict resolved",
      "The branch had a conflict that an agent resolved. Re-read the resolved diff before you sign.",
      "Raised by the merge runner",
    ]);
  for (const w of writes)
    flagsNow.push([
      "Blocked write",
      w.path
        ? `The safety hook stopped a write to ${repoPath(w.path, detail.repositories)}: ${w.why.replace(/^write /, "a write ")}${
            w.roots.length
              ? `. This ticket may write only to ${w.roots.map((r) => repoPath(r, detail.repositories)).join(", ")}`
              : ""
          }. Nothing landed there; check the change does not depend on it.`
        : w.why,
      "Raised by the safety hook (FG-007)",
    ]);
  if (dod && dod.dod !== "PASS")
    flagsNow.push([
      "Gate failed",
      `The Definition of Done failed: ${dod.gates
        .filter((g) => g.status === "FAIL")
        .map((g) => g.gate)
        .join(", ")}.`,
      "Raised by the runner",
    ]);
  for (const d of (packet && packet.disagreements) || [])
    flagsNow.push([
      "Test count disagrees",
      `${d.message} The agent wrote: “${d.excerpt}”. Trust the gate output, not the summary.`,
      "Derived from the agent's evidence and the runner's test output",
    ]);
  // SAME CANDIDATE: the runner gated one commit and the branch is now at another, so a
  // green gate is about other code. One of the flags (the one list), never a hold.
  for (const c of (packet && packet.candidate) || []) {
    const runnerRecord = c.gated_by === "runner" || c.gated_by == null;
    if (!c.gated_sha || !c.diff_head || !runnerRecord || sameSha(c.gated_sha, c.diff_head))
      continue;
    const inRepo = (packet.candidate.length > 1 && ` in ${c.repo}`) || "";
    flagsNow.push(
      c.gated_earlier
        ? [
            "Gated commit not recorded yet",
            `This attempt's gated commit${inRepo} is not recorded yet (the runner records it just after the ticket enters review). The one on record, ${c.gated_sha.slice(0, 12)}, is an earlier attempt's. Reload in a moment before you rely on the gates.`,
            "Derived from the runner's recorded delivery commits and the ticket's claim",
          ]
        : [
            "Not the gated commit",
            `The gates ran on ${c.gated_sha.slice(0, 12)}${inRepo}, but the branch is now at ${c.diff_head.slice(0, 12)}. Read the newer commits: no gate result is recorded for them.`,
            "Derived from the runner's recorded delivery commit and the branch head",
          ],
    );
  }
  // LANE-SETTING CONSISTENCY (lane-hook R1): the runner last routed under a GAFFER_TESTING
  // that decides this ticket differently from this dashboard's. One of the flags.
  const laneSplit = packet && packet.tester_lane && packet.tester_lane.runner;
  if (laneSplit && laneSplit.gates !== !!packet.tester_expected)
    flagsNow.push([
      "Tester lane differs",
      `The runner last routed with GAFFER_TESTING ${laneSplit.mode} and this dashboard reads ${packet.tester_lane.mode}. ${
        packet.tester_expected
          ? "The runner will not send this ticket to the tester, and approval waits for a PASS."
          : "The runner sends tickets like this to the tester, but this dashboard lets you approve without a PASS."
      } Set GAFFER_TESTING the same for both (Settings, with neither environment overriding it).`,
      "Derived from the runner's recorded tester lane (runner.tester_lane) and this dashboard's GAFFER_TESTING",
    ]);
  if (ac.length && satisfied < ac.length)
    flagsNow.push([
      "Criteria not met",
      `${ac.length - satisfied} of ${ac.length} acceptance criteria are not satisfied yet.`,
      "From the ticket's criteria",
    ]);
  let lastFlagArgs = [[], []];
  const paintFlags = (riskAnns, outside = []) => {
    lastFlagArgs = [riskAnns, outside];
    const testsChanged = riskAnns.some((a) => a.kind === "test-modified");
    shownAsks = testsChanged ? asks.filter((a) => a.topic !== "tests") : asks;
    paintAsks();
    const all = [
      ...shownAsks.map((a) => [a.title, a.detail, a.source]),
      ...riskAnns.map((a) => [
        String(a.kind)
          .replace(/-/g, " ")
          .replace(/^./, (c) => c.toUpperCase()),
        a.detail +
          (a.kind === "sensitive-path"
            ? ". Check it is safe to ship, and that a migration has a way back."
            : a.kind === "test-modified"
              ? a.allowed
                ? ". Allowed by a person; check these are the changes the ticket asked for."
                : ". A green gate proves less when its own tests changed; auto-approve is held."
              : "."),
        "Raised by the server's risk check",
      ]),
      ...outside.map((o) => [
        "Edit outside the stated change",
        `${o.path} is changed, but the agent's smallest-change note does not list it. Check it belongs in this ticket.`,
        `Derived from the diff's paths and the agent's smallest-change note (evidence ${String(o.noteId || "").slice(0, 8)})`,
      ]),
      ...commentFlag(),
      ...flagsNow,
    ];
    clear(flagList);
    for (const [h, b, src] of all) flagList.appendChild(reviewFlag(h, b, src));
    if (!all.length)
      flagList.appendChild(
        el(
          "li",
          { class: "flag-none" },
          "No flags: the risk check, the gates and the safety hook raised nothing.",
        ),
      );
    flagCount.textContent = String(all.length);
    const gates = !dod
      ? "No gate report yet"
      : dod.dod === "PASS"
        ? "Gates passed"
        : "A gate failed";
    const crit = ac.length
      ? ` and ${satisfied} of ${ac.length} acceptance criteria are satisfied`
      : "";
    summary.textContent = all.length
      ? `${plural(all.length, "thing")} to check before you sign: ${all.map((x) => x[0].toLowerCase()).join(", ")}. ${gates}${crit}.`
      : `Nothing flagged. ${gates}${crit}.`;
  };
  // The requests for a human, beside the button: the reviewer sees them where they sign.
  const asksSlot = el("div", { class: "signoff-asks-slot" });
  function paintAsks() {
    clear(asksSlot);
    const list = shownAsks;
    if (!list.length) return;
    asksSlot.appendChild(
      el(
        "div",
        {
          class: "signoff-asks",
          role: "status",
          "aria-label": `${plural(list.length, "request")} for a human before you sign`,
        },
        [
          el("p", { class: "signoff-asks-h" }, [
            icon("alert", "", 18),
            ` ${list.length === 1 ? "A human is asked for" : `${list.length} requests for a human`} before you sign`,
          ]),
          el(
            "ul",
            { class: "clean signoff-asks-list" },
            list.map((a) => el("li", {}, [el("b", {}, a.title), el("span", {}, ` ${a.detail}`)])),
          ),
        ],
      ),
    );
  }
  paintFlags([]);

  const branchLine = el("p", { class: "rv-branch" }, [
    t.branch_name ? el("code", { class: "mono" }, t.branch_name) : null,
    prUrl ? [" · ", el("a", { href: prUrl, target: "_blank", rel: "noopener" }, "PR")] : null,
  ]);
  const diffAux = el("span", { class: "panel-aux" });
  // CHANGE IMPACT: the Behavioural surface panel, filled above the diff once it loads.
  const impactSlot = el("div", { class: "rv-impact-slot" });
  const applyDiffState = (state, repos = [], res = null) => {
    diffState = state || { approvable: false, reason: "The diff state is unknown." };
    outcome = (res && res.approve_outcome) || null;
    if (res && res.reject_outcome) fixOutcome = res.reject_outcome;
    // A server-side hold (required CI not passed) refuses the approval: say so instead.
    if (outcome && !outcome.approvable && diffState.approvable)
      diffState = { approvable: false, reason: outcome.sentence };
    if (approveBtn && !isApproved() && !armed) {
      approveLabel.textContent = restLabel();
      approveBtn.setAttribute("aria-label", restLabel());
    }
    if (outcome && !isApproved()) {
      nextLine.textContent = outcome.sentence;
      nextLine.hidden = false;
      nextLine.dataset.outcome = outcome.kind;
    }
    diffRepos = repos;
    if (diffState.approvable) {
      diffBlockBanner.style.display = "none";
      // A read token never gets a live Approve (the server would refuse it).
      if (approveBtn && !isApproved() && !readOnly()) approveBtn.removeAttribute("disabled");
    } else {
      diffBlockBanner.style.display = "";
      clear(diffBlockBanner);
      diffBlockBanner.appendChild(icon("alert"));
      diffBlockBanner.appendChild(document.createTextNode(`Approve blocked — ${diffState.reason}`));
      if (approveBtn) approveBtn.setAttribute("disabled", "");
    }
    const live = repos.filter((r) => !r.unavailable);
    strip?._setRisk(live.flatMap((r) => r.riskAnnotations || []));
    strip?._setShown(repos);
    clear(impactSlot);
    const surface = impactPanel(repos);
    if (surface) impactSlot.appendChild(surface);
    backing?._setImpact(impactBacking(repos));
    clear(integritySlot);
    const ib = integrityBanner(t, testModifiedAnns(live));
    if (ib) integritySlot.appendChild(ib);
    const outside = outsideStatedChange(evidence, live);
    paintFlags(
      live.flatMap((r) => r.riskAnnotations || []),
      outside,
    );
    markOutsideFiles(diffBox, outside);
    decorateCommentable(diffBox, onLineComment, onFileComment);
    paintComments();
    loadSince();
    if (live.length) {
      const files = live.reduce((n, r) => n + (r.files || 0), 0);
      const add = live.reduce((n, r) => n + (r.additions || 0), 0);
      const del = live.reduce((n, r) => n + (r.deletions || 0), 0);
      diffAux.textContent = plural(files, "file");
      branchLine.append(
        live[0].baseBranch ? ` → ${live[0].baseBranch}` : "",
        ` · ${plural(files, "file")}, `,
        el("span", { class: "diff-add-stat" }, `+${add}`),
        " ",
        el("span", { class: "diff-del-stat" }, `−${del}`),
      );
    }
  };
  // --- review comments: the panel, the threads under the lines, Fix these ------------
  const commentList = el("ul", { class: "clean rc-list" });
  const commentAux = el("span", { class: "panel-aux" });
  const fixLine = el("p", {
    class: "fix-next",
    id: `fix-next-${t.id}`,
    "aria-live": "polite",
    hidden: "",
  });
  const fixBtn = hasTicketAction(t.status, "rework")
    ? el(
        "button",
        {
          class: "btn fix-these",
          type: "button",
          disabled: "",
          "aria-describedby": fixLine.id,
          onclick: () => fixThese(),
        },
        "Fix these (0)",
      )
    : null;
  roLock(fixBtn, "ticket");
  const paintFixBtn = () => {
    if (!fixBtn) return;
    const n = openMustFix().length;
    const label =
      fixOutcome && fixOutcome.requirements === n ? fixOutcome.label : `Fix these (${n})`;
    fixBtn.textContent = label;
    // A read token keeps roLock's switched-off state and the title that says why.
    const locked = Boolean(lockReason("ticket"));
    if (n > 0 && !locked) fixBtn.removeAttribute("disabled");
    else fixBtn.setAttribute("disabled", "");
    if (!locked)
      fixBtn.title =
        n > 0
          ? "Send it back with your open must-fix comments as numbered requirements."
          : "Mark a comment Must fix to send it back with Fix these.";
    if (n > 0 && fixOutcome && fixOutcome.requirements === n) {
      fixLine.textContent = fixOutcome.sentence;
      fixLine.dataset.outcome = fixOutcome.kind;
      fixLine.hidden = false;
    } else fixLine.hidden = true;
  };
  const reloadComments = async () => {
    try {
      const r = await api("GET", `/tickets/${t.id}/review/comments?anchors=1`, undefined, {
        signal,
      });
      if (r && Array.isArray(r.comments)) comments = r.comments;
      if (r && r.reject_outcome) fixOutcome = r.reject_outcome;
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    paintComments();
  };
  const actOnComment = (c, action) =>
    guard(async () => {
      await api("POST", `/tickets/${t.id}/review/comments/${c.id}/${action}`, {});
      toast(
        action === "resolve"
          ? "Comment resolved."
          : action === "reopen"
            ? "Comment reopened."
            : "Comment withdrawn.",
        { ok: true },
      );
      await reloadComments();
    });
  const saveComment = async (anchor, body, severity) => {
    await api("POST", `/tickets/${t.id}/review/comments`, {
      body,
      severity,
      ...(anchor.repoId ? { repo: anchor.repoId } : {}),
      ...(anchor.path ? { path: anchor.path } : {}),
      ...(anchor.line ? { line: anchor.line, side: anchor.side } : {}),
      ...(anchor.head ? { commit: anchor.head } : {}),
    });
    toast(severity === "must_fix" ? "Must-fix comment added." : "Comment added.", { ok: true });
    await reloadComments();
  };
  const openComposer = (anchor, place) => {
    if (readOnly()) return;
    const where = commentWhere({ ...anchor, repo: null });
    const existing = [...wrap.querySelectorAll(".rc-composer")].find(
      (f) => f.dataset.anchor === anchor.key,
    );
    if (existing) {
      existing._focus();
      return;
    }
    const form = reviewCommentComposer({
      where,
      onSave: (body, severity) => saveComment(anchor, body, severity),
    });
    form.dataset.anchor = anchor.key;
    place(form);
    form._focus();
  };
  let cursorRow = null;
  const setCursor = (row) => {
    if (cursorRow) cursorRow.classList.remove("is-cursor");
    cursorRow = row;
    if (row) row.classList.add("is-cursor");
  };
  function onLineComment(row) {
    const a = diffRowAnchor(row);
    if (!a) return;
    setCursor(row);
    openComposer(
      {
        key: `${a.pre.dataset.repoId || ""}|${a.pre.dataset.path}|${a.side}|${a.line}`,
        repoId: a.pre.dataset.repoId || null,
        path: a.pre.dataset.path,
        line: a.line,
        side: a.side,
        head: a.pre.dataset.head || null,
      },
      (form) => {
        let after = row;
        while (after.nextElementSibling && after.nextElementSibling.classList.contains("rc-thread"))
          after = after.nextElementSibling;
        after.after(form);
      },
    );
  }
  function onFileComment(pre, bar) {
    openComposer(
      {
        key: `${pre.dataset.repoId || ""}|${pre.dataset.path}|file`,
        repoId: pre.dataset.repoId || null,
        path: pre.dataset.path,
        line: null,
        side: null,
        head: pre.dataset.head || null,
      },
      (form) => bar.after(form),
    );
  }
  const ticketCommentBtn = roLock(
    el(
      "button",
      {
        class: "btn small",
        type: "button",
        onclick: () =>
          openComposer(
            { key: "ticket", repoId: null, path: null, line: null, side: null },
            (form) => commentList.before(form),
          ),
      },
      "Comment on the change",
    ),
    "ticket",
  );
  /** Threads under the lines they point at (only on the revision they were written on). */
  const paintThreads = () => {
    for (const n of wrap.querySelectorAll(".rc-thread")) n.remove();
    const pres = [...wrap.querySelectorAll(".diff-pre[data-path]")];
    for (const c of comments) {
      if (!c.path || c.line == null || c.status === "withdrawn") continue;
      for (const pre of pres) {
        if (pre.dataset.path !== c.path) continue;
        if ((pre.dataset.repoId || null) !== (c.repo_id || null)) continue;
        if (!pre.dataset.head || pre.dataset.head !== c.anchor_sha) continue;
        if (c.side === "old" && pre.dataset.since === "1") continue;
        const attr = c.side === "old" ? "ol" : "ln";
        const row = [...pre.querySelectorAll(`.diff-line[data-${attr}]`)].find(
          (r) => Number(r.dataset[attr]) === c.line,
        );
        if (!row) continue;
        let thread = row.nextElementSibling;
        if (!thread || !thread.classList.contains("rc-thread")) {
          thread = el(
            "div",
            { class: "rc-thread", role: "group", "aria-label": `Comments on line ${c.line}` },
            [el("ul", { class: "clean" })],
          );
          row.after(thread);
        }
        thread
          .querySelector("ul")
          .appendChild(reviewCommentItem(c, { attempt: attemptNow, onAct: actOnComment }));
      }
    }
  };
  function paintComments() {
    clear(commentList);
    const shown = comments.filter((c) => c.status !== "withdrawn");
    for (const c of shown)
      commentList.appendChild(reviewCommentItem(c, { attempt: attemptNow, onAct: actOnComment }));
    if (!shown.length)
      commentList.appendChild(
        el(
          "li",
          { class: "dim rc-none" },
          "No comments yet. Use the + beside a line, Comment on this file, or press c on a line you clicked.",
        ),
      );
    const open = openComments().length;
    commentAux.textContent = open
      ? `${open} open (${openMustFix().length} must-fix)`
      : String(shown.length);
    paintThreads();
    paintFixBtn();
    paintFlags(...lastFlagArgs);
  }
  const fixThese = () => {
    const list = openMustFix();
    if (!list.length) return;
    const n = list.length;
    confirmSheet({
      title: `Fix these on #${t.number}`,
      intro:
        fixOutcome && fixOutcome.requirements === n
          ? fixOutcome.sentence
          : `#${t.number} goes back with ${plural(n, "numbered requirement")}. Its acceptance criteria reset to not met.`,
      body: el(
        "ol",
        { class: "rc-fix-list" },
        list.map((c) =>
          el("li", {}, [
            el("code", { class: "mono" }, c.short_id || String(c.id).slice(0, 8)),
            " ",
            el("b", {}, commentWhere(c)),
            el("span", {}, `: ${c.body}`),
          ]),
        ),
      ),
      confirm: `Send back with ${plural(n, "requirement")}`,
      onConfirm: async () => {
        const r = await api("POST", `/tickets/${t.id}/review/fix`, {
          comment_ids: list.map((c) => c.id),
        });
        const done = r && r.reject_outcome;
        toast(done ? done.sentence : `#${t.number} sent back with ${plural(n, "requirement")}.`, {
          ok: true,
        });
        router();
      },
    });
  };

  // --- since your review (A3): the interdiff from the commit you sent back --------
  const hasRejectPin = evidence.some((e) =>
    String(e.uri || "").startsWith("gaffer-rejected-commit:"),
  );
  const sinceBox = el("div", { class: "diff-box since-box", hidden: "" });
  const sinceBar = el("div", { class: "since-bar", hidden: "" });
  let sinceLoaded = false;
  const showSince = (on) => {
    sinceBox.hidden = !on;
    diffBox.hidden = on;
    for (const b of sinceBar.querySelectorAll("button[data-since]"))
      b.setAttribute("aria-pressed", String(b.dataset.since === (on ? "1" : "0")));
  };
  async function loadSince() {
    if (!hasRejectPin || sinceLoaded) return;
    sinceLoaded = true;
    let res;
    try {
      res = await api("GET", `/tickets/${t.id}/diff?since=rejected`, undefined, { signal });
    } catch {
      return;
    }
    const since = (res && Array.isArray(res.since) && res.since) || [];
    const repos = (res && Array.isArray(res.repos) && res.repos) || [];
    const rewritten = since.filter((x) => x.history_rewritten);
    if (!repos.length && !rewritten.length) return;
    clear(sinceBox);
    clear(sinceBar);
    const files = repos.reduce((n, r) => n + (r.files || 0), 0);
    // The attempt the person sent back (the pin's round), which an agent reviewer's later
    // send-backs do not move; the delivery on screen is attempt attempt_count + 1.
    const pinAttempts = since
      .filter((x) => x.available && !x.history_rewritten && Number.isInteger(x.attempt))
      .map((x) => x.attempt);
    const fromAttempt = pinAttempts.length ? Math.min(...pinAttempts) : attemptNow;
    if (repos.length) {
      sinceBar.append(
        el("div", { class: "since-toggle", role: "group", "aria-label": "Which changes to show" }, [
          el(
            "button",
            {
              class: "btn small",
              type: "button",
              dataset: { since: "1" },
              onclick: () => showSince(true),
            },
            `Changes since your review (attempt ${fromAttempt} → ${attemptNow + 1})`,
          ),
          el(
            "button",
            {
              class: "btn small",
              type: "button",
              dataset: { since: "0" },
              onclick: () => showSince(false),
            },
            "Whole change",
          ),
        ]),
        el(
          "p",
          { class: "since-note dim" },
          `${plural(files, "file")} changed since you sent it back. Approve still covers the whole change.`,
        ),
      );
    }
    for (const x of rewritten)
      sinceBar.appendChild(
        el("p", { class: "reopen-banner since-rewritten", role: "status" }, [
          icon("alert"),
          el("span", {}, [
            el("b", {}, `${x.repo}: the branch history was rewritten since you sent it back. `),
            "The commit you reviewed is not in the new head's history, so there is no interdiff to show; read the whole change.",
          ]),
        ]),
      );
    repos.forEach((rd, i) => {
      const sec = repoDiffSection(rd, 100 + i);
      for (const pre of sec.querySelectorAll(".diff-pre[data-path]")) pre.dataset.since = "1";
      sinceBox.appendChild(sec);
    });
    sinceBar.hidden = false;
    decorateCommentable(sinceBox, onLineComment, null);
    paintThreads();
    showSince(repos.length > 0);
    // The comments written on the sent-back revision get their git anchor tags.
    if (comments.some((c) => c.round < attemptNow)) reloadComments();
  }

  // --- the live head check (A3): the change moved under the reader -----------------
  const HEADS_POLL_MS = 20000;
  let movedLive = false;
  const movedLiveBanner = el("div", {
    class: "reopen-banner diff-moved-banner moved-live",
    role: "alert",
    hidden: "",
  });
  const checkHeads = async () => {
    if (!wrap.isConnected || movedLive || isApproved() || !diffRepos.length) return;
    if (document.visibilityState === "hidden") return;
    let r;
    try {
      r = await api("GET", `/tickets/${t.id}/heads`, undefined, { signal });
    } catch {
      return;
    }
    const heads = r && Array.isArray(r.heads) ? r.heads : null;
    if (!heads || movedLive) return;
    const moved = diffRepos.filter((d) => {
      if (!d.repoId || !d.headSha) return false;
      const h = heads.find((x) => x.repo_id === d.repoId);
      return Boolean(h && h.sha && h.sha !== d.headSha);
    });
    if (!moved.length) return;
    movedLive = true;
    disarm();
    diffState = {
      approvable: false,
      reason:
        "the change moved since you opened it. Reload the diff and review the new head first.",
    };
    if (approveBtn) approveBtn.setAttribute("disabled", "");
    clear(movedLiveBanner);
    movedLiveBanner.append(
      icon("alert"),
      el("span", {}, [
        el("b", {}, "The change moved since you opened it. "),
        `${moved.map((m) => m.repo).join(", ")} has a new commit, so Approve is off until you reload and review the new head. `,
        el(
          "button",
          { class: "btn small", type: "button", onclick: () => router() },
          "Reload the diff",
        ),
      ]),
    );
    movedLiveBanner.hidden = false;
  };
  const headsTimer = setInterval(checkHeads, HEADS_POLL_MS);
  window.addEventListener("focus", checkHeads);

  // The verdict strip: the runner's facts, under the title and above everything
  // the agent wrote. Built before the diff so the diff's risk flags can join it.
  const strip = packet
    ? verdictStrip(packet, {
        onRunLog: () => noteReviewOpen(t.id, since, "run_log"),
        // BLINDING: opening the judge's collapsed view before deciding is recorded.
        // review14/2: one request records the reveal and returns the grade.
        onJudgeReveal: () => revealJudge(t.id, since),
      })
    : null;
  // INSPECTABLE CONFIDENCE: the server's backing rows (an older server sends none).
  const backing = packet && Array.isArray(packet.backing) ? backingPanel(packet.backing) : null;
  // An in_review ticket's diff carries its change-impact facts (the Behavioural surface).
  const diffBox = renderTicketDiff(t.id, applyDiffState);

  // Header: the yellow card, the number, the title; then the facts in one line.
  wrap.appendChild(
    el("header", { class: "rv-head" }, [
      el("h1", { class: "rv-title" }, [
        ycard(40, "rv-card"),
        el("span", { class: "rv-no" }, t.number != null ? `#${t.number}` : ""),
        " ",
        t.title,
      ]),
      el("p", { class: "rv-meta" }, [
        statusBadge(t.status, t.landing_state),
        repo ? repoTag(repo.name, 20) : null,
        riskBadge(t.risk_level, { long: true }),
        by
          ? el("span", { class: "rv-by" }, ["delivered by ", agentChip(by.id, by.name, 22)])
          : null,
        rby && (!by || rby.id !== by.id)
          ? el("span", { class: "rv-by rv-rby" }, ["reviewed by ", agentChip(rby.id, rby.name, 22)])
          : null,
        since
          ? el(
              "span",
              { class: "rv-wait" },
              `waiting ${fmtDuration(Date.now() - Date.parse(since))}`,
            )
          : null,
      ]),
      branchLine,
      // REVIEW FACTS: what was asked, above the runner's facts (inside the header, so the
      // strip still follows it).
      packet && "intent" in packet ? intentBlock(packet.intent) : null,
    ]),
  );
  if (strip) wrap.appendChild(strip);

  signoff = el(
    "section",
    {
      class: "card signoff",
      dataset: { reviewIdx: "0" },
      tabindex: "-1",
      "aria-label": "The gaffer's sign-off",
    },
    [
      panelHead("The gaffer's sign-off", null, null, { kit: "claret" }),
      summary,
      movedBanner,
      movedLiveBanner,
      asksSlot,
      integritySlot,
      canApprove ? diffBlockBanner : null,
      el(
        "div",
        { class: "btn-row review-card-actions" },
        [
          approveBtn,
          fixBtn,
          hasTicketAction(t.status, "rework")
            ? roLock(
                el(
                  "button",
                  { class: "btn", type: "button", onclick: () => reject("refining") },
                  "Send back…",
                ),
                "ticket",
              )
            : null,
          hasTicketAction(t.status, "wont_do")
            ? roLock(
                el(
                  "button",
                  { class: "btn danger", type: "button", onclick: () => reject("cancelled") },
                  "Won't do…",
                ),
                "ticket",
              )
            : null,
        ].filter(Boolean),
      ),
      canApprove ? nextLine : null,
      fixBtn ? fixLine : null,
      armHint,
      el("p", { class: "rv-keys" }, [
        el("span", { class: "kbd" }, "a"),
        " twice to approve · ",
        el("span", { class: "kbd" }, "r"),
        " send back · ",
        el("span", { class: "kbd" }, "c"),
        " comment on the clicked line · ",
        el("span", { class: "kbd" }, "j"),
        el("span", { class: "kbd" }, "k"),
        " next / previous",
      ]),
      // Last, so once Approve lands it is the block's foot (the key line goes).
      doneLine,
    ],
  );
  signoff._actions = { approve, reject };

  const diffSection = el("section", { class: "rv-diff", "aria-label": "The diff" }, [
    el("h2", { class: "rv-h2" }, ["The diff ", diffAux]),
    impactSlot,
    sinceBar,
    sinceBox,
    diffBox,
  ]);
  // A click on a line marks it, so `c` comments on it.
  diffSection.addEventListener("click", (e) => {
    const row = e.target && e.target.closest && e.target.closest(".diff-line");
    if (row && diffRowAnchor(row)) setCursor(row);
  });

  // The referee's checks: the Definition-of-Done gates, then the criteria, in one page.
  const dodBox = dodChecklist(evidence);
  const checks = el("section", { class: "card panel rv-checks", "aria-label": "Gates" }, [
    panelHead(
      "The gates",
      !dod ? "no gate report yet" : dod.dod === "PASS" ? "all passed" : "a gate failed",
    ),
    dodBox ||
      el(
        "p",
        { class: "dim" },
        "The runner has not recorded a Definition-of-Done report for this delivery.",
      ),
    ac.length
      ? el("h3", { class: "rv-h3" }, [
          "Acceptance criteria ",
          el("span", { class: "count" }, `${satisfied} of ${ac.length}`),
        ])
      : null,
    ac.length ? (packet ? acTable(packet.acceptance) : acChecklist(ac)) : null,
  ]);

  wrap.appendChild(
    el("div", { class: "rv-grid" }, [
      el("div", { class: "rv-left" }, [
        signoff,
        el("section", { class: "rv-flags", "aria-label": "Flags" }, [
          el("h2", { class: "rv-h2" }, ["Flags ", flagCount]),
          flagList,
        ]),
        el("section", { class: "rv-comments", "aria-label": "Review comments" }, [
          el("h2", { class: "rv-h2" }, ["Comments ", commentAux]),
          el("div", { class: "btn-row rc-toolbar" }, [ticketCommentBtn]),
          commentList,
        ]),
        backing,
        checks,
        el("section", { class: "rv-evid", "aria-label": "Evidence" }, [
          el("h2", { class: "rv-h2" }, [
            "Evidence ",
            el("span", { class: "panel-aux" }, String(evidence.length)),
          ]),
          reviewEvidenceList(evidence, ac, {
            repos: detail.repositories,
            asks: new Set(asks.map((a) => a.id).filter(Boolean)),
            onRawOpen: () => noteReviewOpen(t.id, since, "evidence"),
          }) || el("p", { class: "dim" }, "No evidence recorded."),
        ]),
      ]),
      el("div", { class: "rv-right" }, [diffSection]),
    ]),
  );
  // One column (≤1180px): the diff moves up under the flags, ahead of the gates
  // and the evidence; two columns put it back beside the sign-off.
  const oneCol =
    typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 1180px)") : null;
  const placeDiff = () => {
    const left = wrap.querySelector(".rv-left");
    const right = wrap.querySelector(".rv-right");
    if (!left || !right) return;
    if (oneCol && oneCol.matches) left.querySelector(".rv-flags")?.after(diffSection);
    else if (diffSection.parentNode !== right) right.appendChild(diffSection);
  };
  placeDiff();
  oneCol?.addEventListener?.("change", placeDiff);

  // Keys: j/k move along the queue, a arms → a approves, r sends back, Esc disarms.
  const cards = [signoff];
  // The one change on screen carries the queue cursor.
  signoff.classList.add("card-accent");
  const onKey = (e) => {
    if (!wrap.isConnected) return; // never act on a queue that is not on screen
    if (isModalOpen()) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "j" || e.key === "k") {
      e.preventDefault();
      disarm();
      const to = tickets[idx + (e.key === "j" ? 1 : -1)];
      if (to) navigate(`#/review/${to.id}`);
    } else if (e.key === "c") {
      if (readOnly()) return;
      const active = document.activeElement;
      const row =
        (active && active.closest && active.closest(".diff-line")) ||
        (cursorRow && cursorRow.isConnected ? cursorRow : null);
      if (!row || !diffRowAnchor(row)) return;
      e.preventDefault();
      onLineComment(row);
    } else if ((e.key === "a" || e.key === "r") && readOnly()) {
      // A read token signs nothing off: the keys do what the switched-off buttons do.
      return;
    } else if (e.key === "a") {
      e.preventDefault();
      if (approveBtn && approveBtn.classList.contains("is-approved")) return;
      if (armed) {
        disarm();
        cards[0]._actions.approve();
      } else arm("key");
    } else if (e.key === "Escape") {
      disarm();
    } else if (e.key === "r") {
      e.preventDefault();
      cards[0]._actions.reject("refining");
    }
  };
  document.addEventListener("keydown", onKey);
  let observer = null;
  const teardown = () => {
    document.removeEventListener("keydown", onKey);
    clearInterval(headsTimer);
    window.removeEventListener("focus", checkHeads);
    if (armTimer) clearTimeout(armTimer);
    oneCol?.removeEventListener?.("change", placeDiff);
    if (observer) observer.disconnect();
  };
  wrap._dispose = teardown;
  observer = new MutationObserver(() => {
    if (!document.body.contains(wrap)) teardown();
  });
  observer.observe(app, { childList: true });
  paintComments();
  if (comments.length) reloadComments();
  wrap._settled = diffBox._settled ? Promise.allSettled([diffBox._settled]) : Promise.resolve();
  return wrap;
}

export { renderReview };
