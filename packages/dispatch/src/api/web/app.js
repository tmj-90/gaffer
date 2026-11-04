// Gaffer dashboard — plain ES-module SPA over the Dispatch REST API.
// No framework, no build step. Every view calls the JSON API via fetch().
//
// Presentation: "Match Day". The gaffer is the manager and the factory is the
// club on match day — a claret club header, a stadium scoreboard, programme
// pages with kit-colour section blocks, referee's cards for status. The tokens,
// components and conventions are in css/ (see css/tokens.css) and the shared
// helpers below (el/field/icon/glyph, viewHead, panelHead, emptyState,
// skeleton, statCell, charts). Every mark carries data the server gave us.

import {
  agentTitle,
  agentWho,
  learnWhoami,
  lockReason,
  readOnly,
  roLock,
  roLockAll,
} from "./js/access.js";
import { adoptTokenFromUrl, api, authToken } from "./js/api.js";
import { buildChrome, paintBrand } from "./js/chrome.js";
import {
  ROLE_LABELS,
  actorName,
  agentNames,
  applySquad,
  canEditSquad,
  ensureAgents,
  ensureSquad,
  learnDisplay,
  squad,
} from "./js/club.js";
import { emptyState, panelHead, statCell, viewHead } from "./js/components.js";
import { app, clear, el, field, prefersReducedMotion, svgEl } from "./js/dom.js";
import { fmtDay, fmtDuration, fmtRelative, fmtTime, money, moneyW, plural } from "./js/format.js";
import { clockTime, freshness, paintFreshness } from "./js/freshness.js";
import {
  agentChip,
  agentShirt,
  agentTag,
  badge,
  crest,
  glyph,
  icon,
  kitShirt,
  learnKits,
  repoTag,
  ycard,
} from "./js/icons.js";
import {
  RGB_HOUSE_CLARET,
  RGB_HOUSE_SKY,
  applyClub,
  clubLetters,
  clubName,
  kitTokens,
  readHouseKit,
  rgbHex,
  setKitTokens,
} from "./js/kit.js";
import {
  autoRefreshTimer,
  clearDeskSignature,
  refreshCurrentView,
  reviewSignature,
  startLiveStream,
  updateNavBadges,
} from "./js/live.js";
import { logout, renderLogin } from "./js/login.js";
import {
  DETAIL_FULL,
  OFF_PITCH,
  ON_BENCH,
  ON_PITCH,
  TERMINAL,
  allTickets,
  benchedCampaignLine,
  boardAll,
  hlWork,
  loadMatchDay,
  ticketDetails,
} from "./js/matchday.js";
import { closePalette, openPalette, paletteEls } from "./js/palette.js";
import {
  carryOpenForms,
  disposeView,
  jumpTo,
  mountView,
  navigate,
  parseHash,
  routeGen,
  routeSignal,
  router,
  setDocTitle,
} from "./js/router.js";
import { viewRunLog } from "./js/runs.js";
import { closeSheet, openSheet, sheetOpen } from "./js/sheet.js";
import {
  actionSheet,
  confirmSheet,
  hideRepoSheet,
  reasonSheet,
  unblockSheet,
  valueSheet,
} from "./js/sheets.js";
import { appState } from "./js/state.js";
import { accessBadge, hasTicketAction, riskBadge, statusBadge, statusLabel } from "./js/status.js";
import { guard, runAsyncAction, toast } from "./js/toast.js";
import { testerByline } from "./js/views/acceptance.js";
import { progPage } from "./js/views/programme.js";
import { ticketLede } from "./js/views/ticket.js";
import { RISK_LEVELS, hashText } from "./js/views/work.js";

window.wgLogout = logout;
let freshPainted = "";
freshness.listeners.add((now, was) => {
  // Repaint only when what the line says would change (state or the minute shown).
  const key = `${now}|${freshness.lastOkAt ? clockTime(freshness.lastOkAt) : ""}`;
  if (key !== freshPainted) {
    freshPainted = key;
    paintFreshness();
  }
  // Coming back: re-read the view at once instead of waiting for the next tick.
  if (was === "offline" && (now === "live" || now === "polling")) refreshCurrentView();
});
// A phone tab coming back to the foreground re-checks at once instead of
// trusting its old state: restart the stream and re-read the view.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !autoRefreshTimer) return;
  startLiveStream();
  refreshCurrentView();
});

// Global ⌘K / Ctrl+K hotkey.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (paletteEls && paletteEls.scrim.classList.contains("open")) closePalette();
    else openPalette();
  }
});

// ===========================================================================
//  Decisions — folded into Overview, card reused
// ===========================================================================

// ===========================================================================
//  View: Review queue
// ===========================================================================

function safeHttpUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * Render a slice of unified-diff lines as monospace rows, colouring +/- with the
 * existing success/danger tokens. Each line is inserted as its OWN text node
 * (never innerHTML), so a hostile diff line can never inject markup. Returns the
 * scrollable `<pre>` well.
 */
/**
 * One diff as a keyboard-scrollable region: a wide diff scrolls sideways inside
 * its <pre>, so the <pre> is focusable and named (axe scrollable-region-focusable).
 */
function diffPre(lines, label = "Diff", { trimHeader = false } = {}) {
  // A per-file block already names its file: drop git's preamble (diff --git,
  // index, ---/+++) up to the first hunk, when there is one.
  let body = lines;
  if (trimHeader) {
    const h = lines.findIndex((l) => l.startsWith("@@"));
    if (h > 0) body = lines.slice(h);
  }
  // The gutter carries the new file's line numbers (from each @@ header), via a
  // data attribute so the copied text of a line is only the line. The old side's
  // numbers ride along (`data-ol`): a removed line shows it, and a review comment can
  // anchor to either side.
  // Inside a hunk a `---`/`+++` line is a removed `-- …` / added `++…` line of the file,
  // not a file header: only the lines before a file's first @@ are its header.
  let ln = null;
  let ol = null;
  let inHunk = false;
  const rows = body.map((line) => {
    let cls = "diff-line";
    const first = line.charAt(0);
    let n = null;
    let o = null;
    if (line.startsWith("diff --git ")) inHunk = false;
    if (!inHunk && (line.startsWith("+++") || line.startsWith("---"))) cls += " diff-file";
    else if (line.startsWith("@@")) {
      inHunk = true;
      cls += " diff-hunk";
      const m = line.match(/\+(\d+)/);
      ln = m ? Number(m[1]) : null;
      const mo = line.match(/^@@ -(\d+)/);
      ol = mo ? Number(mo[1]) : null;
    } else if (first === "+") {
      cls += " diff-add";
      n = ln != null ? ln++ : null;
    } else if (first === "-") {
      cls += " diff-del";
      o = ol != null ? ol++ : null;
    } else if (ln != null && first !== "\\") {
      n = ln++;
      o = ol != null ? ol++ : null;
    }
    const dataset = {};
    if (n != null) dataset.ln = String(n);
    if (o != null) dataset.ol = String(o);
    // Render an empty line as a non-breaking space so the row keeps its height.
    return el(
      "div",
      { class: cls, dataset: n != null || o != null ? dataset : undefined },
      line === "" ? " " : line,
    );
  });
  return el("pre", { class: "diff-pre", tabindex: "0", role: "region", "aria-label": label }, rows);
}

/**
 * REVIEW COMMENTS: mark a per-file diff `<pre>` with the repo, path and head it shows, so
 * the Review view can put a comment button on its lines and a thread under a line. A
 * deleted file (`+++ /dev/null`) is commented on by its old path.
 */
function commentAnchored(pre, rd, f) {
  if (!pre || !rd || !f) return pre;
  pre.dataset.path = f.path;
  if (rd.repoId) pre.dataset.repoId = rd.repoId;
  if (rd.headSha) pre.dataset.head = rd.headSha;
  if (rd.truncated) pre.dataset.truncated = "1";
  return pre;
}

/** Back-compat: render a whole unified diff as one `<pre>`. */
function diffBody(diffText, label) {
  return diffPre(String(diffText || "").split("\n"), label);
}

/**
 * Split a unified `git diff` into per-file chunks. Each chunk starts at a
 * `diff --git ` line; any preamble before the first such line is dropped.
 *
 * The display PATH is derived from the chunk's `+++ ` line (strip the `b/`
 * prefix), falling back to the `--- ` source (strip `a/`) for a pure deletion
 * (`+++ /dev/null`), and finally to the `diff --git` line. It is used ONLY as a
 * text-node child / attribute value downstream, so a hostile path (spaces,
 * quotes, markup, escaped bytes) is inert — never a DOM id or selector.
 *
 * Per-file +/- counts are best-effort: with a truncated diff the last chunk may
 * be cut mid-line, so these are advisory (the aggregate `truncated` badge stays
 * on the section head).
 */
function splitDiffFiles(diffText) {
  const lines = String(diffText || "").split("\n");
  const files = [];
  let cur = null;
  const flush = () => {
    if (cur) files.push(cur);
  };
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      flush();
      cur = { header: line, lines: [], additions: 0, deletions: 0 };
    }
    if (!cur) continue; // drop any preamble before the first `diff --git`
    cur.lines.push(line);
    // The ---/+++ header precedes the first hunk; after it, such a line is content (a
    // removed `-- …` or an added `++ …` line), never the file's name.
    if (line.startsWith("@@")) cur.inHunk = true;
    if (!cur.inHunk && line.startsWith("+++ ")) cur.plus = line.slice(4).trim();
    else if (!cur.inHunk && line.startsWith("--- ")) cur.minus = line.slice(4).trim();
    else if (line.charAt(0) === "+") cur.additions += 1;
    else if (line.charAt(0) === "-") cur.deletions += 1;
  }
  flush();
  const stripPrefix = (p, pfx) => (p && p.startsWith(pfx) ? p.slice(pfx.length) : p);
  for (const f of files) {
    let p;
    if (f.plus && f.plus !== "/dev/null") p = stripPrefix(f.plus, "b/");
    else if (f.minus && f.minus !== "/dev/null") p = stripPrefix(f.minus, "a/");
    else p = f.header.replace(/^diff --git\s+/, "");
    f.path = p || "(unknown file)";
  }
  return files;
}

/** A file path with a break chance after each "/": a narrow head wraps at a folder, not mid-name. */
function pathBreaks(p) {
  const parts = String(p).split("/");
  return parts.flatMap((part, i) => (i < parts.length - 1 ? [`${part}/`, el("wbr")] : [part]));
}

/** A single repo's diff section: header (repo/branch/stats) + per-file file
 *  strip (jumper) + one collapsible `<details>` per file. `repoIdx` scopes the
 *  DOM ids to indices — a path is NEVER used to build an id or selector. */
function repoDiffSection(rd, repoIdx = 0, { collapsed = false } = {}) {
  const statBits = [];
  if (rd.unavailable) {
    statBits.push(el("span", { class: "diff-stat dim" }, rd.message || rd.unavailable));
  } else {
    statBits.push(
      el("span", { class: "diff-stat" }, `${rd.files} file${rd.files === 1 ? "" : "s"}`),
    );
    statBits.push(el("span", { class: "diff-stat diff-add-stat" }, `+${rd.additions}`));
    statBits.push(el("span", { class: "diff-stat diff-del-stat" }, `−${rd.deletions}`));
    if (rd.truncated) statBits.push(el("span", { class: "diff-stat warn" }, "truncated"));
  }
  const header = el("div", { class: "diff-head" }, [
    el("code", { class: "mono diff-repo" }, rd.repo),
    rd.branch
      ? el("span", { class: "diff-branch" }, [
          el("code", { class: "mono" }, `${rd.baseBranch}…${rd.branch}`),
        ])
      : null,
    el("span", { class: "diff-stats" }, statBits),
  ]);
  const risk = rd.unavailable ? null : riskOverlay(rd.riskAnnotations || []);

  if (rd.unavailable) {
    return el("div", { class: "diff-section is-unavailable" }, [header, risk]);
  }

  // Set of risk paths, so a file can carry an ADVISORY marker when its path
  // matches a riskAnnotations entry. Tolerant match survives rename (`old => new`)
  // strings and a/b-prefix / sub-path differences; drives presentation only.
  const riskAnns = rd.riskAnnotations || [];
  const riskInfo = (fp) => {
    for (const a of riskAnns) {
      const paths = a.paths || [];
      const hit = paths.some((p) => p === fp || (p && fp && (p.includes(fp) || fp.includes(p))));
      if (hit) return a;
    }
    return null;
  };

  const files = splitDiffFiles(rd.diff);
  if (files.length === 0) {
    // No parseable `diff --git` chunk (e.g. a plain textual diff): fall back to
    // the single-pre rendering so nothing is lost.
    return el("div", { class: "diff-section is-plain" }, [header, risk, diffBody(rd.diff)]);
  }

  // The file list: one row per file, flagged files carry a yellow card, and a
  // goal-difference bar shows lines added (green) against lines removed (red).
  const strip = el("nav", { class: "diff-filestrip", "aria-label": "Files in this diff" });
  const filesBox = el("div", { class: "diff-files" });
  const maxLines = Math.max(1, ...files.map((f) => f.additions + f.deletions));
  const GD_BLOCKS = 16;

  files.forEach((f, fileIdx) => {
    const targetId = `diff-file-${repoIdx}-${fileIdx}`;
    const ann = riskInfo(f.path);
    const riskTitle = ann ? `${String(ann.kind).replace(/-/g, " ")}: ${ann.detail}` : null;
    const isNew = f.minus === "/dev/null";
    const isGone = f.plus === "/dev/null";
    const total = f.additions + f.deletions;
    const blocks = total ? Math.max(1, Math.round((total / maxLines) * GD_BLOCKS)) : 0;
    const addBlocks = total ? Math.round((f.additions / total) * blocks) : 0;
    const gd = el(
      "span",
      { class: "gd", "aria-hidden": "true" },
      Array.from({ length: blocks }, (_, i) => el("i", { class: i < addBlocks ? "gd-a" : "gd-d" })),
    );

    // Jumper row — path is a text node; target id is index-derived, never the path.
    const jump = el(
      "button",
      {
        type: "button",
        class: "diff-filejump" + (ann ? " has-risk" : ""),
        dataset: { fileTarget: targetId },
        title: riskTitle || f.path,
        "aria-label": `${f.path}: ${f.additions} added, ${f.deletions} removed${ann ? `, flagged (${riskTitle})` : ""}`,
        onclick: () => {
          const target = document.getElementById(targetId);
          if (!target) return;
          target.open = true;
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        },
      },
      [
        el("span", { class: "dfj-flag" }, ann ? ycard(14, "diff-file-risk") : null),
        el("code", { class: "mono diff-filejump-path" }, pathBreaks(f.path)),
        el("span", { class: "diff-filejump-stat" }, [
          el("span", { class: "diff-add-stat" }, `+${f.additions}`),
          el("span", { class: "diff-del-stat" }, `−${f.deletions}`),
        ]),
        gd,
      ],
    );
    strip.appendChild(jump);

    // Collapsible per-file block — native <details>, so collapse hides ONLY this
    // file's lines. The id is index-scoped, never derived from the path.
    const summaryChildren = [
      icon("chevron", "diff-file-chev"),
      el("code", { class: "mono diff-file-path" }, pathBreaks(f.path)),
      isNew ? el("span", { class: "diff-file-tag" }, "new file") : null,
      isGone ? el("span", { class: "diff-file-tag" }, "deleted") : null,
      el("span", { class: "diff-filejump-stat" }, [
        el("span", { class: "diff-add-stat" }, `+${f.additions}`),
        " ",
        el("span", { class: "diff-del-stat" }, `−${f.deletions}`),
      ]),
    ];
    if (ann) {
      const marker = ycard(14, "diff-file-risk");
      marker.setAttribute("title", riskTitle);
      summaryChildren.push(marker);
    }
    filesBox.appendChild(
      el(
        "details",
        {
          class: `diff-file-block${ann ? " is-flagged" : ""}`,
          // Folded (the ticket page) the file list is the way in; open (Review) it reads top to bottom.
          open: collapsed ? null : "",
          id: targetId,
        },
        [
          el("summary", { class: "diff-file-summary" }, summaryChildren),
          ann
            ? el("p", { class: "diff-file-flag" }, [
                ycard(14),
                `${String(ann.kind)
                  .replace(/-/g, " ")
                  .replace(/^./, (c) => c.toUpperCase())}: ${ann.detail}`,
              ])
            : null,
          commentAnchored(diffPre(f.lines, `Diff of ${f.path}`, { trimHeader: true }), rd, f),
        ],
      ),
    );
  });

  return el("div", { class: `diff-section${rd.truncated ? " is-truncated" : ""}` }, [
    header,
    risk,
    strip,
    filesBox,
  ]);
}

/**
 * ADVISORY risk overlay on the review diff — flags where the reviewer's scarce
 * attention should go FIRST (sensitive paths, dependency changes, large deletions),
 * computed server-side from the real diff (src/services/riskAnnotations.ts). It NEVER
 * gates approval — the authoritative diff + the Approve-gated-on-real-diff check are
 * unchanged. An empty scan shows an explicit "clear" state, not a blank region.
 */
function riskOverlay(anns) {
  if (!anns.length) {
    return el(
      "div",
      { class: "risk-overlay risk-none" },
      "No elevated-risk signals — advisory scan clear.",
    );
  }
  const sevOrder = { high: 0, medium: 1 };
  const badges = [...anns]
    .sort((a, b) => (sevOrder[a.severity] ?? 9) - (sevOrder[b.severity] ?? 9))
    .map((a) =>
      el(
        "span",
        {
          class: "risk-badge risk-" + (a.severity === "high" ? "high" : "medium"),
          // Full path list on hover; the badge text stays a short summary.
          title: (a.paths || []).join("\n") || a.detail,
        },
        `${String(a.kind).replace(/-/g, " ")}: ${a.detail}`,
      ),
    );
  return el("div", { class: "risk-overlay" }, [
    el("span", { class: "risk-lead" }, "Review first"),
    ...badges,
  ]);
}

/**
 * Decide whether a loaded diff payload is safe to APPROVE off (fix 4, the human
 * backstop to the P0 done-gate). A human must not approve a change they could not
 * actually see, so approval is allowed ONLY when at least one WRITE repo returned
 * a REAL, non-empty diff (no `unavailable` reason). Any repo that came back as
 * `repo_not_on_disk` / `no_branch` / `git_error` / `empty` is surfaced as the
 * blocking reason. Mirrors the backend `hasRealDeliveryDiff` so the UI never
 * offers an approve the server would (rightly) reject.
 */
function diffApprovability(repos) {
  if (!repos || repos.length === 0) {
    return { approvable: false, reason: "No write repos to diff — nothing to review." };
  }
  const hasRealDiff = repos.some(
    (rd) => !rd.unavailable && rd.diff && String(rd.diff).trim() !== "",
  );
  if (hasRealDiff) return { approvable: true, reason: null };
  const blocked = repos.find((rd) => rd.unavailable);
  const reason = blocked
    ? `The diff could not be loaded (${blocked.message || blocked.unavailable}). You can't approve a change you can't see.`
    : "The diff loaded empty — there is no change to review.";
  return { approvable: false, reason };
}

/**
 * Fetch + render the diff-in-review for a ticket (one section per WRITE repo).
 * Returns a placeholder that fills in asynchronously, so the review card / ticket
 * sheet render immediately and the (possibly slow) git diff streams in after.
 *
 * `onState` (optional) is called once the diff load settles with the
 * {@link diffApprovability} verdict, so a caller (the review card) can gate its
 * Approve button on a diff the human could actually see. Until it fires, callers
 * should treat the ticket as NOT approvable (fail-closed).
 */
function renderTicketDiff(ticketId, onState, opts = {}) {
  const box = el("div", { class: "diff-box" }, [el("div", { class: "ac-meta" }, "Loading diff…")]);
  // The response rides along so the sign-off can read its `approve_outcome`.
  const report = (state, repos = [], res = null) => {
    if (typeof onState === "function") onState(state, repos, res);
  };
  // `_settled` resolves once the diff (or its error) is on screen, so a background
  // refresh can hold the page height until then (review-scroll-jumps-to-top).
  box._settled = api("GET", `/tickets/${ticketId}/diff`, undefined, { signal: routeSignal() })
    .then((res) => {
      clear(box);
      const repos = (res && res.repos) || [];
      if (repos.length === 0) {
        box.appendChild(el("p", { class: "section-note" }, "No write repos to diff."));
        report(diffApprovability(repos), [], res);
        return;
      }
      if (repos.length > 1) {
        box.classList.add("is-multi");
        box.appendChild(el("div", { class: "ac-meta" }, `Diff (${repos.length} repos)`));
      }
      repos.forEach((rd, i) => box.appendChild(repoDiffSection(rd, i, opts)));
      report(diffApprovability(repos), repos, res);
    })
    .catch((e) => {
      clear(box);
      box.appendChild(
        el("p", { class: "policy-result fail" }, `Could not load diff: ${e.message}`),
      );
      report({
        approvable: false,
        reason: `The diff endpoint errored (${e.message}). You can't approve a change you can't see.`,
      });
    });
  return box;
}

// ===========================================================================
//  Review comments (A1), Fix these (A2), since your review (A3)
// ===========================================================================

/** Where a comment points, in words: repo:path:line, the file, or the whole change. */
function commentWhere(c) {
  if (!c.path) return "the whole change";
  const at = `${c.repo ? `${c.repo}:` : ""}${c.path}`;
  if (c.line == null) return `${at} (the file)`;
  return `${at}:${c.line}${c.side === "old" ? " (old side)" : ""}`;
}

/** The git-derived anchor tag of a comment written on an earlier revision. */
const ANCHOR_TAGS = {
  changed: ["anchor changed in this revision", "warn"],
  untouched: ["anchor untouched", "no-dot"],
  current: ["written on this revision", "no-dot"],
  unknown: ["anchor not checkable here", "no-dot"],
};

/**
 * One comment: severity, where it points, the body (a text node), its state, the git
 * anchor tag when it was written on an earlier revision, the delivery agent's replies
 * (labelled as what the agent says: a claim, never a resolution) and the reviewer's
 * Resolve / Reopen / Withdraw.
 */
function reviewCommentItem(c, { attempt = 0, onAct } = {}) {
  const earlier = typeof c.round === "number" && c.round < attempt;
  const tag = earlier && c.anchor_state ? ANCHOR_TAGS[c.anchor_state] : null;
  const act = (action, label, kind = "") =>
    roLock(
      el(
        "button",
        {
          class: `btn small ${kind}`.trim(),
          type: "button",
          dataset: { commentAct: action },
          onclick: () => onAct && onAct(c, action),
        },
        label,
      ),
      "ticket",
    );
  const actions =
    c.status === "open"
      ? [act("resolve", "Resolve"), act("withdraw", "Withdraw")]
      : [act("reopen", "Reopen")];
  return el(
    "li",
    {
      class: `rc-item is-${c.status} sev-${c.severity}`,
      dataset: { commentId: c.id },
    },
    [
      el("p", { class: "rc-head" }, [
        badge(
          c.severity === "must_fix" ? "Must fix" : "Consider",
          c.severity === "must_fix" ? "warn" : "no-dot",
        ),
        " ",
        el("code", { class: "mono rc-id" }, c.short_id || String(c.id).slice(0, 8)),
        " ",
        el("span", { class: "rc-where" }, commentWhere(c)),
        c.status !== "open" ? [" ", badge(c.status, "no-dot")] : null,
        tag
          ? [
              " ",
              el(
                "span",
                {
                  class: `badge rc-anchor ${tag[1]}`,
                  title:
                    "From git: the lines this comment points at, compared between the revision it was written on and this one.",
                },
                tag[0],
              ),
            ]
          : null,
      ]),
      el("p", { class: "rc-body" }, c.body),
      (c.agent_replies || []).map((r) =>
        el("p", { class: "rc-reply" }, [
          el("b", {}, "The agent says: "),
          r.summary,
          el("small", { class: "dim" }, " (its claim; only you resolve the comment)"),
        ]),
      ),
      el("p", { class: "rc-meta dim" }, [
        c.author_id ? `${c.author_id} · ` : "",
        earlier ? `written on attempt ${c.round + 1}` : "this attempt",
        c.sent_round != null ? " · sent back with Fix these" : "",
      ]),
      el("div", { class: "btn-row rc-actions" }, actions),
    ],
  );
}

/**
 * The inline comment form: a body, Must fix / Consider, Comment and Cancel. A typed draft
 * is a text field the refresh never throws away (viewHasTypedText).
 */
function reviewCommentComposer({ where, onSave, onCancel }) {
  const ta = el("textarea", {
    class: "rc-input",
    rows: "3",
    "aria-label": `Comment on ${where}`,
    placeholder: "What should change?",
  });
  const name = `rc-sev-${++appState.fieldSeq}`;
  const radio = (value, label, checked) =>
    el("label", { class: "rc-sev" }, [
      el("input", { type: "radio", name, value, checked: checked ? "" : null }),
      ` ${label}`,
    ]);
  let busy = false;
  const form = el(
    "form",
    {
      class: "rc-composer",
      novalidate: "",
      onsubmit: async (e) => {
        e.preventDefault();
        if (busy) return;
        const body = ta.value.trim();
        if (!body) {
          ta.focus();
          return;
        }
        const sev = form.querySelector(`input[name="${name}"]:checked`);
        busy = true;
        try {
          await onSave(body, sev ? sev.value : "must_fix");
          form.remove();
        } catch (err) {
          toast((err && err.message) || "The comment was not saved.", { code: err && err.code });
        } finally {
          busy = false;
        }
      },
    },
    [
      el("p", { class: "rc-composer-h" }, ["Comment on ", el("b", {}, where)]),
      ta,
      el("div", { class: "rc-composer-row" }, [
        radio("must_fix", "Must fix", true),
        radio("consider", "Consider", false),
        el("span", { class: "grow" }),
        el("button", { class: "btn small primary", type: "submit" }, "Comment"),
        el(
          "button",
          {
            class: "btn small",
            type: "button",
            onclick: () => {
              form.remove();
              if (onCancel) onCancel();
            },
          },
          "Cancel",
        ),
      ]),
    ],
  );
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && ta.value.trim() === "") {
      e.stopPropagation();
      form.remove();
      if (onCancel) onCancel();
    }
  });
  form._focus = () => ta.focus();
  return form;
}

/** The commentable row a diff line is (new side unless it only has an old number). */
function diffRowAnchor(row) {
  const pre = row && row.closest && row.closest(".diff-pre[data-path]");
  if (!pre) return null;
  const since = pre.dataset.since === "1";
  if (row.dataset.ln) return { pre, line: Number(row.dataset.ln), side: "new" };
  if (row.dataset.ol && !since) return { pre, line: Number(row.dataset.ol), side: "old" };
  return null;
}

/**
 * Put a comment button on every commentable line of the per-file diffs in `box`, and a
 * "Comment on this file" button above each file. One empty button per line (its label is
 * for a screen reader, its glyph is CSS), so a copied line is still only the line.
 */
function decorateCommentable(box, onLine, onFile) {
  if (!box) return;
  for (const pre of box.querySelectorAll(".diff-pre[data-path]")) {
    if (pre.dataset.cmt === "1") continue;
    pre.dataset.cmt = "1";
    for (const row of pre.querySelectorAll(".diff-line")) {
      const a = diffRowAnchor(row);
      if (!a) continue;
      const b = el("button", {
        class: "diff-cmt",
        type: "button",
        tabindex: "-1",
        "aria-label": `Comment on line ${a.line}${a.side === "old" ? " (old side)" : ""} of ${pre.dataset.path}`,
        onclick: (e) => {
          e.stopPropagation();
          onLine(row);
        },
      });
      roLock(b, "ticket");
      row.prepend(b);
    }
    if (onFile && pre.dataset.since !== "1") {
      const bar = el("div", { class: "rc-filebar" }, [
        roLock(
          el(
            "button",
            { class: "btn small", type: "button", onclick: () => onFile(pre, bar) },
            "Comment on this file",
          ),
          "ticket",
        ),
      ]);
      pre.before(bar);
    }
  }
}

/** True when the ticket's events show a merge-conflict-resolved reopen pending re-review. */
function reopenedForReview(events) {
  return (events || []).some((ev) => ev.event_type === "ticket.reopened_for_review");
}

// PAUSE-ON-CAP: pull the latest pause reason/spend/turns/branch off the events so the
// detail view's paused banner can explain WHY the delivery paused. Returns an empty
// shape when there is no pause event (defensive — the banner only renders for
// status === 'paused' anyway).
function pausedInfo(events) {
  const out = { reason: "cap_hit", spend: null, turns: null, branch: null };
  const paused = (events || []).filter((ev) => ev.event_type === "ticket.paused");
  const last = paused[paused.length - 1];
  if (!last) return out;
  let payload;
  try {
    payload = JSON.parse(last.payload_json || "{}");
  } catch {
    // Malformed payload — fall back to the defaults already in `out`.
    return out;
  }
  if (payload.reason) out.reason = payload.reason;
  if (payload.spend != null) out.spend = payload.spend;
  if (payload.turns != null) out.turns = payload.turns;
  if (payload.branch_name != null) out.branch = payload.branch_name;
  return out;
}

/**
 * Definition-of-Done checklist (I3). The runner records the enforced DoD verdict
 * as a `test_output` evidence row whose summary opens with `DoD: PASS|FAIL` and a
 * machine-parseable JSON line: {"dod","gates":[{gate,repo,status,rc,note}…]}.
 * Render the latest such row as a compact ✓/✗ checklist so the reviewer sees a
 * pre-verified board — and, for a failing gate, the captured `note`. A FAIL row
 * here means the delivery was AUTO-REJECTED before review; it lingers only as
 * history, but surfacing it keeps the gate honest. All text goes through text
 * nodes (el coerces strings) — never innerHTML — so it stays XSS-safe.
 */
function parseDodEvidence(evidence) {
  // The runner records the DoD row as the system actor; an agent-recorded row that
  // merely looks like one is the agent's word, never a gate verdict.
  const rows = (evidence || []).filter(
    (ev) =>
      ev.evidence_type === "test_output" &&
      ev.recorded_by_agent !== true &&
      typeof ev.summary === "string" &&
      ev.summary.startsWith("DoD: "),
  );
  if (rows.length === 0) return null;
  // Newest wins: the last attached DoD row reflects the current verdict.
  const summary = rows[rows.length - 1].summary;
  const jsonLine = summary.split("\n")[1] || "";
  try {
    const parsed = JSON.parse(jsonLine);
    if (!parsed || !Array.isArray(parsed.gates)) return null;
    return parsed;
  } catch {
    // A malformed/legacy row must never break the Review view — just skip it.
    return null;
  }
}

function dodChecklist(evidence) {
  const dod = parseDodEvidence(evidence);
  if (!dod) return null;
  const overall = dod.dod === "PASS" ? "PASS" : "FAIL";
  const items = dod.gates.map((g) => {
    const status =
      g.status === "PASS"
        ? "pass"
        : g.status === "FAIL"
          ? "fail"
          : g.status === "FLAG"
            ? "flag"
            : "skip";
    const mark = { pass: "✓", fail: "✗", flag: "!", skip: "–" }[status];
    const children = [
      el("span", { class: `dod-mark dod-${status}`, "aria-hidden": "true" }, mark),
      el("span", { class: "dod-gate" }, String(g.gate || "gate")),
      el("span", { class: "dod-repo ac-meta" }, String(g.repo || "")),
      el(
        "span",
        { class: `dod-word dod-w-${status}` },
        { pass: "passed", fail: "failed", flag: "flagged", skip: "skipped" }[status],
      ),
    ];
    // A tests gate that passed only on its rerun at concurrency 1 (lib/dod.sh): a yellow
    // card for the reviewer, and the note names both runs.
    if (g.flaky === true) {
      children.push(el("span", { class: "dod-flaky" }, "Flaky suspected"));
      if (g.note)
        children.push(el("span", { class: "dod-note dod-note-flaky ac-meta" }, String(g.note)));
      if (g.source) children.push(el("span", { class: "dod-src ac-meta" }, String(g.source)));
      return el("li", { class: `dod-item dod-i-${status} is-flaky` }, children);
    }
    // A passing gate names the command it ran; a failing one surfaces its captured note,
    // and the integrity row (gate integrity) says what it found in words.
    if ((status === "fail" || status === "flag" || g.gate === "integrity") && g.note) {
      children.push(el("span", { class: `dod-note dod-note-${status} ac-meta` }, String(g.note)));
    } else if (g.note) {
      children.push(el("code", { class: "dod-cmd mono" }, String(g.note)));
    }
    // Where the command's behaviour was read from (the base commit, for a script).
    if (g.source && g.gate !== "integrity")
      children.push(el("span", { class: "dod-src ac-meta" }, String(g.source)));
    return el("li", { class: `dod-item dod-i-${status}` }, children);
  });
  return el("div", { class: `review-dod dod-${overall === "PASS" ? "ok" : "bad"}` }, [
    el("div", { class: "ac-meta dod-cap" }, [
      "Definition of Done ",
      badge(overall === "PASS" ? "all gates green" : "gate failed", "no-dot"),
      dod.gates.some((g) => g.flaky === true) ? badge("flaky suspected", "no-dot") : null,
    ]),
    el("ul", { class: "clean dod-list" }, items),
  ]);
}

/** Acceptance criteria as a checklist: glyph · the criterion · its state. */
function acChecklist(acList) {
  return el(
    "ul",
    { class: "ac-list" },
    acList.map((a) =>
      el("li", { class: `ac-row ac-${a.status}` }, [
        glyph(a.status === "satisfied" ? "done" : a.status === "failed" ? "failed" : "draft", 16),
        el("span", { class: "ac-row-t" }, a.text),
        el("span", { class: "ac-state" }, String(a.status || "").replace(/_/g, " ")),
      ]),
    ),
  );
}

/** The evidence label a reviewer reads ("test output", "diff summary"). */
function evidenceKind(type) {
  return String(type || "note").replace(/_/g, " ");
}

/**
 * The evidence, oldest first, as a minute list: when · who (named, with the
 * agent-reported chip) · what kind · the first line of what it says. Longer
 * captures (a DoD report, a diff stat) fold their remaining lines.
 */
function reviewEvidenceList(evidence, acList, { repos, asks, onRawOpen } = {}) {
  if (!evidence || evidence.length === 0) return null;
  const acText = new Map((acList || []).map((a) => [a.id, a.text]));
  const rows = evidence
    .slice()
    .sort((x, y) => String(x.created_at || "").localeCompare(String(y.created_at || "")))
    .map((ev) => {
      const link = safeHttpUrl(ev.uri);
      const acLabel = ev.ac_id && acText.has(ev.ac_id) ? acText.get(ev.ac_id) : null;
      // Provenance — who recorded this evidence and when, plus an explicit flag
      // when it was SELF-REPORTED by a delivery agent so the reviewer weighs it with
      // due skepticism. `recorded_by_agent` is set server-side ONLY when the recording
      // actor is a KNOWN registered agent (a reliable positive signal); it is never
      // inferred from an absence, and no "trusted" label is fabricated. `created_by`
      // renders through el() as a text node, so it can never inject markup.
      const raw = ev.created_by ? String(ev.created_by) : "—";
      const who =
        squad.byId.get(raw)?.display_name_effective ||
        agentNames.get(raw) ||
        (raw === "system" ? "the runner" : raw);
      const provBadge =
        ev.recorded_by_agent === true ? badge("agent-reported", "no-dot prov-agent") : null;
      const asking = asks && asks.has(ev.id);
      const lines = String(ev.summary || "").split("\n");
      // A blocked-write note and absolute paths read as repo-relative paths.
      const say = (l) =>
        l
          .replace(/(\/[^\s\][,]+)/g, (m) => (m.split("/").length > 4 ? repoPath(m, repos) : m))
          .replace(
            /^FG-007 boundary violation\(s\) blocked by the safety hook during delivery:$/,
            "FG-007: the safety hook blocked a write outside the write roots",
          );
      const first = say(lines[0] || "");
      const rest = lines
        .slice(1)
        .filter((l) => l.trim())
        .map(say);
      return el("li", { class: asking ? "review-evi evi-asks" : "review-evi" }, [
        el(
          "time",
          {
            class: "evi-time tabnum",
            datetime: ev.created_at || "",
            title: ev.created_at ? fmtTime(ev.created_at) : null,
          },
          ev.created_at ? clockTime(Date.parse(ev.created_at)) : "—",
        ),
        el("div", { class: "evi-main" }, [
          el("div", { class: "ac-meta evi-prov" }, [
            el("span", { class: "evi-who" }, who),
            badge(evidenceKind(ev.evidence_type), "no-dot evi-kind"),
            provBadge,
            asking ? badge("asks for a human", "no-dot evi-ask") : null,
          ]),
          el("p", { class: "evi-summary" }, first),
          rest.length
            ? el(
                "details",
                {
                  class: "evi-more",
                  ontoggle: onRawOpen
                    ? (e) => {
                        if (e.currentTarget.open) onRawOpen();
                      }
                    : null,
                },
                [
                  el("summary", {}, `${plural(rest.length, "more line")}`),
                  el(
                    "pre",
                    {
                      class: "evi-pre",
                      tabindex: "0",
                      role: "region",
                      "aria-label": `${evidenceKind(ev.evidence_type)}, in full`,
                    },
                    rest.join("\n"),
                  ),
                ],
              )
            : null,
          acLabel ? el("p", { class: "ac-meta evi-ac" }, `for AC: ${acLabel}`) : null,
          link
            ? el(
                "a",
                {
                  class: "evi-link",
                  href: link,
                  target: "_blank",
                  rel: "noopener",
                  onclick: onRawOpen ? () => onRawOpen() : null,
                },
                "open",
              )
            : null,
        ]),
      ]);
    });
  return el("div", { class: "review-evidence" }, [el("ol", { class: "clean evi-list" }, rows)]);
}

// Preset quick-reject reasons. Tapping a chip fills the reason so an operator
// can reject one-handed on a phone without summoning a keyboard; the free-text
// field stays as a fallback for anything the chips don't cover.
const REJECT_REASON_PRESETS = [
  "Doesn't meet the spec",
  "Tests missing or failing",
  "Wrong approach",
  "Scope creep",
  "Needs cleanup first",
];
const WONT_DO_PRESETS = [
  "No longer needed",
  "Covered by another ticket",
  "Not worth the risk",
  "Out of scope for this campaign",
];

/**
 * Single source of truth for "is a blocking modal open right now?".
 *
 * The review gate's global j/k/a/r shortcuts (and any future global key
 * shortcut) MUST bail when this is true. Without it, a keystroke aimed at an
 * open dialog leaks through to the review queue underneath — the reject-reason
 * dialog is appended to `document.body` (NOT the app/view container the review
 * MutationObserver watches), so the gate's key handler never detaches while a
 * reject is in progress. Pressing `a` after tapping a reason chip would then
 * approve+merge `cards[cursor]` — potentially a DIFFERENT ticket than the one
 * being rejected. That is a reject-to-approve path through the exact human gate
 * this product exists to protect.
 *
 * Keyed on each modal's real open-signal so it can't leak or go stale:
 *   - reject dialog + move-menu are removed from the DOM on close → presence == open;
 *   - command palette + detail sheet persist and toggle an `.open` class.
 * Any modal added later should follow one of those two conventions (or be added
 * to this selector) so global shortcuts stay suppressed underneath it.
 */
function isModalOpen() {
  // Single source of truth for "a modal owns the keyboard" — must list EVERY modal scrim,
  // or the review hotkeys (a = approve+merge) leak through the ones it omits. `.pb-scrim`
  // covers both the Plan-a-build and Author-a-spec panels (they share the class).
  return Boolean(
    document.querySelector(
      ".reject-scrim, .movemenu-scrim, .palette-scrim.open, .sheet-scrim.open, .pb-scrim.open",
    ),
  );
}

/** Who delivered a ticket: the agent on its latest claim ({ id, name, no } or null). */
function deliveredBy(events) {
  const c = (events || []).filter((e) => e.event_type === "claim.created" && e.actor_id).pop();
  if (!c || !(squad.byId.has(c.actor_id) || agentNames.has(c.actor_id))) return null;
  return agentWho(c.actor_id);
}
/**
 * Who reviewed it: the ticket's assigned reviewer when that is a registered agent,
 * else the last reviewer-role agent that acted on it ({ id, name, no } or null).
 */
function reviewedBy(ticket, events) {
  const rid = ticket && ticket.reviewer;
  if (rid && squad.byId.has(rid)) return agentWho(rid);
  const REVIEW_ROLES = new Set(["reviewer", "security_reviewer"]);
  const e = (events || [])
    .filter((x) => x.actor_type === "agent" && x.actor_id)
    .filter((x) => REVIEW_ROLES.has(squad.byId.get(x.actor_id)?.role))
    .pop();
  return e ? agentWho(e.actor_id) : null;
}
/**
 * REVIEW TELEMETRY (Release A metrics): tell the server, once per ticket and review
 * round, that a person opened the ticket in Review (`what` empty) or opened a raw view
 * of it (`what`: run_log | evidence | full_diff). Health splits time in review into
 * queue wait and decision time with it. Best-effort and silent: a refusal (a read token
 * is refused before any request) or a network error loses one measurement, nothing else.
 */
const reviewOpensSent = new Set();
/**
 * On a ticket page, unfolding a file of a ticket in review's folded diff opens the full
 * diff outside the Review view: note it (full_diff). Returns `box` for inline use.
 */
function reviewRawWatch(box, t, events) {
  if (box && t && t.status === "in_review" && box.addEventListener)
    box.addEventListener(
      "toggle",
      (e) => {
        if (e.target && e.target.open && e.target.classList?.contains("diff-file-block"))
          noteReviewOpen(t.id, sinceStatus(events, "in_review"), "full_diff");
      },
      true,
    );
  return box;
}
function noteReviewOpen(ticketId, round, what = "") {
  if (!ticketId || !round || readOnly()) return;
  const key = `${ticketId}@${round}${what ? `#${what}` : ""}`;
  if (reviewOpensSent.has(key)) return;
  reviewOpensSent.add(key);
  const path = what
    ? `/tickets/${ticketId}/review-raw-opened`
    : `/tickets/${ticketId}/review-opened`;
  api("POST", path, what ? { what, round_entered_at: round } : { round_entered_at: round }).catch(
    () => {},
  );
}
/** When the ticket last moved into its current status (the wait starts there). */
function sinceStatus(events, status) {
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event_type !== "ticket.transitioned") continue;
    try {
      if (JSON.parse(e.payload_json || "{}").to === status) return e.created_at;
    } catch {
      /* skip a malformed payload */
    }
  }
  return null;
}
/** The safety hook's blocked writes, from the FG-007 evidence note. */
function blockedWrites(evidence) {
  const out = [];
  for (const ev of evidence || []) {
    const s = String(ev.summary || "");
    if (!/^FG-007/.test(s)) continue;
    for (const line of s.split("\n").slice(1)) {
      // The hook writes "<why (…)>: <target> [write-roots: a, b]" or
      // "<why (…)>: <target> — "<cmd>"". The target is the first path after the
      // reason; the roots in brackets are where the ticket may write (the old
      // greedy match took the last root for the target).
      const m = line.match(/^BLOCKED[^:]*:\s*(.*?\)):\s*(\/[^\s\]]+)(.*)$/);
      if (m) {
        const roots = (m[3].match(/\[write-roots:\s*([^\]]*)\]/) || [])[1];
        out.push({
          why: m[1].trim(),
          path: m[2],
          roots: roots ? roots.split(/,\s*/).filter(Boolean) : [],
        });
      } else if (line.trim()) out.push({ why: line.trim(), path: null, roots: [] });
    }
  }
  return out;
}
/** A long absolute path, shortened to its last three parts. */
function shortPath(p) {
  const parts = String(p || "")
    .split("/")
    .filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : String(p || "");
}
/**
 * Files the diff changes that the delivering agent's smallest-change note does not
 * name. Gaffer has no out-of-scope field: this compares the note (manual_note
 * evidence "Smallest-change note: …") with the diff's own paths, and says so.
 * No note → no derivation (an empty answer, never a guess).
 */
function outsideStatedChange(evidence, repos) {
  const note = (evidence || [])
    .filter((e) => /^Smallest-change note:/i.test(String(e.summary || "")))
    .pop();
  if (!note) return [];
  const said = (String(note.summary).match(/[\w.-]+(?:\/[\w.-]+)+|[\w-]+\.\w{1,6}/g) || []).map(
    (x) => x.replace(/\.+$/, ""),
  );
  if (!said.length) return [];
  const out = [];
  for (const rd of repos || []) {
    for (const f of splitDiffFiles(rd.diff)) {
      const p = f.path;
      if (!said.some((x) => x === p || p.endsWith("/" + x) || x.endsWith("/" + p)))
        out.push({ path: p, noteId: note.id });
    }
  }
  return out;
}
/** Card the diff's files that sit outside the stated change (file list + file block). */
function markOutsideFiles(box, outside) {
  if (!box || !outside.length) return;
  const set = new Set(outside.map((o) => o.path));
  for (const jump of box.querySelectorAll(".diff-filejump")) {
    const p = jump.querySelector(".diff-filejump-path")?.textContent;
    if (!set.has(p) || jump.classList.contains("has-risk")) continue;
    jump.classList.add("has-risk");
    const flag = jump.querySelector(".dfj-flag");
    if (flag && !flag.firstChild) flag.appendChild(ycard(14, "diff-file-risk"));
    jump.setAttribute(
      "aria-label",
      `${jump.getAttribute("aria-label")}, flagged (outside the stated change)`,
    );
    const block = box.querySelector(`[id="${jump.dataset.fileTarget}"]`);
    if (block && !block.classList.contains("is-flagged")) {
      block.classList.add("is-flagged");
      block
        .querySelector(".diff-file-summary")
        ?.after(
          el("p", { class: "diff-file-flag" }, [
            ycard(14),
            "Not in the agent's smallest-change note (derived; see the flag on the left).",
          ]),
        );
    }
  }
}
/** An absolute path inside a known repo, said as "repo/rel/path" (else shortened). */
function repoPath(p, repos) {
  const s = String(p || "");
  for (const r of repos || []) {
    const root = String(r.local_path || "").replace(/\/+$/, "");
    if (!root || !r.name) continue;
    if (s === root) return r.name;
    if (s.startsWith(root + "/")) return `${r.name}/${s.slice(root.length + 1)}`;
  }
  return shortPath(s);
}
// --- Gate integrity: the delivery changed the tests that decide it is done -----

/** The server's `test-modified` risk annotations across a diff's live repos. */
function testModifiedAnns(repos) {
  return (repos || [])
    .filter((r) => !r.unavailable)
    .flatMap((r) => (r.riskAnnotations || []).map((a) => ({ ...a, repo: r.repo })))
    .filter((a) => a.kind === "test-modified");
}

/** The runner's integrity row from the newest DoD evidence, when it FLAGged. */
function integrityFlagOf(evidence) {
  const dod = parseDodEvidence(evidence);
  if (!dod) return null;
  return dod.gates.find((g) => g.gate === "integrity" && g.status === "FLAG") || null;
}

/**
 * Allow (or withdraw) test changes on a ticket — a human's call, recorded as an event.
 * With it set, the runner's integrity row reads PASS with a note and the server no
 * longer holds an auto-approve for the test changes on their own.
 */
function allowTestChangesSheet(t, allow) {
  const ref = t.number != null ? `#${t.number}` : "this ticket";
  const reason = el("textarea", {
    class: "input",
    rows: "2",
    maxlength: "500",
    "aria-label": "Why this ticket may change its tests",
    placeholder: "Why this ticket may change its tests (kept on the event)",
  });
  actionSheet(
    allow ? `Allow test changes on ${ref}` : `Withdraw the test-changes allowance on ${ref}`,
    {
      intro: allow
        ? "Only when the ticket asked for these test changes. The gate's integrity row will read PASS with a note on its next run, and the test changes alone no longer hold an agent's approve (they still count as medium risk, so a ticket declared low stays held). You still sign the change off here."
        : "Test changes on this ticket are flagged again, and an agent approve is held until a person looks.",
      body: allow ? reason : null,
      focus: allow ? reason : undefined,
      actions: [
        el(
          "button",
          {
            class: allow ? "btn primary" : "btn danger",
            type: "button",
            onclick: () =>
              guard(async () => {
                const why = allow ? reason.value.trim() : "";
                await api("POST", `/tickets/${t.id}/allow-test-changes`, {
                  allow_test_changes: allow,
                  ...(why ? { reason: why } : {}),
                });
                closeSheet();
                toast(
                  allow ? `Test changes allowed on ${ref}.` : `Allowance withdrawn on ${ref}.`,
                  {
                    ok: true,
                  },
                );
                router();
              }),
          },
          allow ? "Allow test changes" : "Withdraw allowance",
        ),
        el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel"),
      ],
    },
  );
}

/**
 * The Review banner for a delivery that changed its own tests: what changed (one line
 * per finding, from the server's `test-modified` annotation), what that means for the
 * auto-approve, and the human's allow / withdraw control. Empty when nothing changed.
 */
function integrityBanner(t, anns) {
  if (!anns.length) return null;
  const allowed = anns.every((a) => a.allowed);
  // One line per finding; the repo leads only when more than one repo changed tests.
  const many = new Set(anns.map((a) => a.repo)).size > 1;
  const items = anns.flatMap((a) =>
    (a.items && a.items.length ? a.items : [a.detail]).map((line) =>
      many ? `${a.repo}: ${line}` : line,
    ),
  );
  const shown = items.slice(0, 8);
  return el(
    "div",
    {
      class: `warn-box integrity-banner${allowed ? " is-allowed" : ""}`,
      role: allowed ? "status" : "alert",
      "aria-label": allowed
        ? "Test changes are allowed on this ticket."
        : "This delivery changed the tests that gate it.",
    },
    [
      icon("alert"),
      el("div", { class: "integrity-body" }, [
        el(
          "p",
          { class: "integrity-h" },
          allowed
            ? "Test changes are allowed on this ticket."
            : "This delivery changed the tests that decide it is done.",
        ),
        el(
          "ul",
          { class: "integrity-items" },
          [
            ...shown.map((line) => el("li", {}, line)),
            items.length > shown.length
              ? el("li", { class: "dim" }, `and ${items.length - shown.length} more`)
              : null,
          ].filter(Boolean),
        ),
        el(
          "p",
          { class: "integrity-note" },
          allowed
            ? "A person allowed it, so the gate reads PASS with a note from its next run. Check the changes are the ones the ticket asked for."
            : "A green gate proves less when its own tests changed. Auto-approve is held until a person looks.",
        ),
        // A read token sees the control switched off (the server refuses it anyway).
        roLock(
          el(
            "button",
            {
              class: "btn small",
              type: "button",
              onclick: () => allowTestChangesSheet(t, !allowed),
            },
            allowed ? "Withdraw allowance…" : "Allow test changes…",
          ),
          "ticket",
        ),
      ]),
    ],
  );
}

/** One flag: a yellow card, a caps title, what it means, who raised it. */
function reviewFlag(title, body, source) {
  return el("li", { class: "flag" }, [
    ycard(22, "flag-card"),
    el("div", { class: "flag-body" }, [
      el("h3", { class: "flag-title" }, title),
      el("p", { class: "flag-text" }, body),
      source ? el("p", { class: "flag-src" }, source) : null,
    ]),
  ]);
}

/**
 * The evidence rows (and events) that ASK FOR A HUMAN before sign-off: the runner's
 * needs_human_review requests, a reviewer agent's CHANGES, a tester's FAIL or hold, a
 * merge-gate hold, a DoD FLAG gate, an observed-risk escalation, anything held "for a
 * human". The flags, the summary line and the warnings beside the button all read this
 * one list, built from the same rows the Evidence list renders, so the sign-off can never
 * say "Nothing flagged" over a request for a human further down the page.
 * Returns [{ id, title, detail, source, topic? }]; `id` is the evidence row's id (null for
 * events). `topic: "tests"` marks the GATE INTEGRITY asks (the runner's integrity FLAG, an
 * auto-approve held because the tests changed): one finding, which the diff's
 * `test-modified` flag and the test-changes banner say instead once the diff has loaded.
 */
const HUMAN_ASK_RULES = [
  [/^needs_human_review\b[:\s]*/i, "Runner asks for a human review", "Raised by the runner"],
  [
    /^Reviewer agent \(advisory\): changes requested\s*[—-]?\s*/i,
    "Reviewer asked for changes",
    "Raised by the reviewer agent",
  ],
  [/^tester held:\s*/i, "Tester held it for a human", "Raised by the tester lane"],
  [/^MERGE GATE FAILED:\s*/i, "Merge gate held it", "Raised by the merge gate"],
  [/^agent review could not run:\s*/i, "Agent review could not run", "Raised by the runner"],
  [/^PARKED\b[^:]*:\s*/i, "Parked for a human", "Raised by the runner"],
];
/**
 * ONE ROUND: where the ticket's CURRENT delivery attempt begins in its event log (the
 * latest claim, or a human taking it straight from Ready) and where it last entered
 * review, as event-log positions (-1: none on record). A request for a human recorded
 * before the attempt began was about an earlier attempt's code: that round's verdicts are
 * in the rework history, not asks of this sign-off. Each evidence row is placed by its
 * own `evidence.recorded` event, so the order is the log's, never a clock comparison
 * across tables (a row with no such event falls back to its timestamp).
 */
function roundMarks(events) {
  const list = events || [];
  const payload = (e) => {
    try {
      return JSON.parse(e.payload_json || "{}") || {};
    } catch {
      return {};
    }
  };
  let attempt = -1;
  let review = -1;
  const recordedAt = new Map();
  list.forEach((e, i) => {
    if (e.event_type === "evidence.recorded") {
      const id = payload(e).evidence_id;
      if (id) recordedAt.set(String(id), i);
      return;
    }
    if (e.event_type !== "ticket.transitioned") return;
    const p = payload(e);
    if (p.to === "claimed" || (p.to === "in_progress" && p.from !== "claimed")) attempt = i;
    if (p.to === "in_review") review = i;
  });
  /** Was evidence row `ev` recorded before the mark at log position `at`? */
  const before = (ev, at) => {
    if (at < 0) return false;
    const pos = recordedAt.get(String(ev.id));
    if (pos !== undefined) return pos < at;
    return Boolean(ev.created_at && ev.created_at < list[at].created_at);
  };
  return { attempt, review, before };
}
function humanAsks(evidence, events, dod) {
  const out = [];
  // ONE ROUND: only this attempt's requests ask anything of this sign-off. A reviewer
  // agent's advisory CHANGES is a verdict on what it reviewed, so it counts only since
  // the ticket last entered review (the Work card's rule, boardService.advisoryReview).
  const round = roundMarks(events);
  for (const ev of evidence || []) {
    const s = String(ev.summary || "");
    const first = s.split("\n")[0];
    const rule = HUMAN_ASK_RULES.find(([re]) => re.test(first));
    if (round.before(ev, round.attempt)) continue;
    if (rule && rule[1] === "Reviewer asked for changes" && round.before(ev, round.review))
      continue;
    let payload;
    try {
      payload = ev.payload_json ? JSON.parse(ev.payload_json) : null;
    } catch {
      payload = null;
    }
    if (rule) {
      const detail = first.replace(rule[0], "").trim() || first;
      out.push({ id: ev.id, title: rule[1], detail, source: rule[2] });
    } else if (payload && payload.verdict === "fail") {
      out.push({
        id: ev.id,
        title: "Tester asked for changes",
        detail: first,
        source: "Raised by the tester",
      });
    } else if (/\b(needs a human|held (?:[\w ]+ )?for a human)\b/i.test(first)) {
      out.push({
        id: ev.id,
        title: "Held for a human",
        detail: first,
        source: "Raised by the runner",
      });
    }
  }
  let integrityFlag = false;
  for (const g of (dod && dod.gates) || []) {
    if (String(g.status || "").toUpperCase() !== "FLAG") continue;
    const integrity = g.gate === "integrity";
    integrityFlag = integrityFlag || integrity;
    out.push({
      id: null,
      title: `Gate flagged: ${g.gate || "gate"}`,
      detail: g.note ? String(g.note) : "The Definition of Done flagged this gate for a human.",
      source: "Raised by the runner's gates",
      ...(integrity ? { topic: "tests" } : {}),
    });
  }
  (events || []).forEach((e, i) => {
    if (e.event_type !== "ticket.autoship_escalated") return;
    if (i < round.attempt) return;
    let p;
    try {
      p = JSON.parse(e.payload_json || "{}") || {};
    } catch {
      p = {};
    }
    // GATE INTEGRITY: an escalation for the tests changing is that finding, not a risk level
    // above the declared one; said once (the runner's integrity FLAG, when present, says it).
    if (Array.isArray(p.holds) && p.holds.length) {
      if (!integrityFlag)
        out.push({
          id: null,
          title: "Auto-approve held: tests changed",
          detail: `${p.holds.join("; ")}. An agent's or auto approval is held until a person looks; a human approval is not.`,
          source: "Raised by the gate-integrity check",
          topic: "tests",
        });
      return;
    }
    out.push({
      id: null,
      title: "Observed risk above declared",
      detail: `The real diff reads as ${p.observed || "unknown"} risk, above the declared ${p.declared || "risk"}${
        Array.isArray(p.reasons) && p.reasons.length ? `: ${p.reasons.join("; ")}` : ""
      }. Auto-approve was held for a human.`,
      source: "Raised by the observed-risk check",
    });
  });
  return out;
}

/**
 * The review packet's gate report in the DoD row's shape: the verdict strip's own rows
 * (the server's read of the runner's DoD record), so the flags, the summary and the
 * requests for a human never say something about the gates the strip contradicts.
 */
function packetDod(p) {
  const g = p && p.gates;
  if (!g) return null;
  return {
    dod: g.overall,
    gates: (g.rows || []).map((r) => ({
      gate: r.gate,
      repo: r.repo,
      status: r.status,
      note: r.note || r.command || "",
    })),
  };
}

/**
 * What an approval did when the server sent no `approve_outcome` (an older server): read
 * the new status and the merge result. Never says a merge is running unless one started.
 */
function approvedFallback(to, merge) {
  if (to === "in_testing")
    return { done_label: "Sent to tester", sentence: "It goes to the tester next." };
  if (merge && merge.triggered)
    return { done_label: "Landing now", sentence: "The merge runner is landing it now." };
  if (merge && merge.skipped === "auto_merge_off")
    return {
      done_label: "Waits for Merge now",
      sentence:
        "It waits in Ready for merge: Auto-merge on approval is off, so press Merge now to land it.",
    };
  return {
    done_label: "Ready for merge",
    sentence: "It waits in Ready for merge until the runner's merge lane or Merge now lands it.",
  };
}

// ── The review packet: the runner's facts, above the agent's words ──────────
// One GET /tickets/:id/dossier?include=packet per change, kept against the
// ticket's id@updated_at: a refresh that re-renders the page for another
// ticket's sake (the queue moved) reuses it, and a changed ticket reads it again.
const packetCache = new Map();
async function reviewPacketFor(t, signal) {
  const sig = `${t.id}@${t.updated_at || ""}`;
  const hit = packetCache.get(t.id);
  if (hit && hit.sig === sig) return hit.packet;
  const d = await api("GET", `/tickets/${t.id}/dossier?include=packet`, undefined, { signal });
  const packet = (d && d.review_packet) || null;
  if (packet) packetCache.set(t.id, { sig, packet });
  return packet;
}
/** Forget packets for tickets that left the queue (the cache never outgrows it). */
function prunePacketCache(tickets) {
  const live = new Set(tickets.map((t) => t.id));
  for (const id of packetCache.keys()) if (!live.has(id)) packetCache.delete(id);
}

const VD_WORD = { PASS: "passed", FAIL: "failed", FLAG: "flagged", SKIPPED: "skipped" };
/** One cell of the verdict strip: a caps label, the verdict, then its detail. */
function verdictCell(key, label, value, aria, body, tone = "") {
  return el(
    "div",
    {
      class: `vd-cell vd-${key}${tone ? ` vd-${tone}` : ""}`,
      role: "group",
      "aria-label": aria,
    },
    [
      el("p", { class: "vd-k" }, label),
      el("p", { class: "vd-v" }, value),
      el("div", { class: "vd-body" }, body),
    ],
  );
}
/** Who sent a delivery back, said plainly. */
function reworkWho(r) {
  if (r.by === "gate") return r.gate ? `the ${r.gate} gate` : "a gate";
  return r.by === "tester" ? "the tester" : "the review";
}
/** What a criterion's evidence is, said on its row (and in its label). */
function acEvidenceWords(a) {
  const c = a.check;
  if (a.evidence_kind === "runner" && c)
    return c.passed
      ? `The runner ran the check: exit ${c.exit_code ?? 0}`
      : `The runner ran the check and it failed: exit ${c.exit_code ?? "unknown"}`;
  if (a.evidence_kind === "human" && c)
    return `A person recorded the check result: exit ${c.exit_code ?? "unknown"}`;
  if (a.evidence_kind === "agent") return "No machine evidence: only the agent's word";
  return "No machine evidence: nothing recorded";
}

const JUDGE_DIM_LABEL = {
  ac_coverage: "Acceptance criteria",
  correctness: "Correctness",
  minimalism: "Smallest change",
  test_adequacy: "Tests",
  security: "Security",
};
const JUDGE_WORD = { pass: "Pass", borderline: "Borderline", fail: "Fail" };
/**
 * The judge's cell of the verdict strip: its verdict and score, then every dimension it
 * scored 3 or lower with its reason (lowest first), its one-line summary and the model.
 */
function judgeCell(jd) {
  const score = Number(jd.score);
  const shown = Number.isFinite(score) ? score.toFixed(1) : "?";
  const weak = Object.entries(jd.dims || {})
    .filter(([, v]) => typeof v === "number" && v <= 3)
    .sort((a, b) => a[1] - b[1]);
  const why = jd.rationale || {};
  return verdictCell(
    "judge",
    "Judge",
    `${JUDGE_WORD[jd.overall] || jd.overall} ${shown}/5`,
    `Quality judge, advisory: ${jd.overall}, ${shown} of 5${
      weak.length ? `, ${plural(weak.length, "weak dimension")}` : ""
    }`,
    [
      weak.length
        ? el(
            "ul",
            { class: "clean vd-judge-dims" },
            weak.map(([d, v]) =>
              el("li", { class: "vd-judge-dim" }, [
                el("b", {}, `${JUDGE_DIM_LABEL[d] || d} ${v}/5`),
                why[d] ? [": ", el("span", { class: "vd-why" }, why[d])] : null,
              ]),
            ),
          )
        : el("p", { class: "vd-sub" }, "No dimension scored 3 or lower."),
      jd.summary ? el("p", { class: "vd-say" }, jd.summary) : null,
      el("p", { class: "vd-sub" }, [
        "A model's grade of the diff, not a check: nothing gates on it",
        jd.judge_model ? ` · ${jd.judge_model}` : "",
        jd.at ? ` · ${fmtTime(jd.at)}` : "",
      ]),
    ],
    jd.overall === "fail" ? "bad" : jd.overall === "borderline" ? "warn" : "",
  );
}

/**
 * The verdict strip under the title: gates, the independent tester, cost and
 * turns, attempts and rework, risk and its reasons, the reviewed-commit pin.
 * Each a recorded fact (see services/reviewPacketService.ts). `setRisk(anns)`
 * adds the diff's own risk annotations once the diff has loaded.
 */
/**
 * REVIEW FACTS (intent): what was asked, the ticket's description as the human wrote it,
 * above the runner's facts. Text only: a description is untrusted text.
 */
const INTENT_FOLD_CHARS = 600;
function intentBlock(intent) {
  const body = el(
    "p",
    { class: "rv-intent-t" },
    intent ||
      "The ticket has no description: the title and the acceptance criteria are all that was asked.",
  );
  const kids = [el("h2", { class: "rv-intent-h" }, "What was asked"), body];
  if (intent && intent.length > INTENT_FOLD_CHARS) {
    body.classList.add("is-folded");
    const more = el(
      "button",
      {
        type: "button",
        class: "btn-link rv-intent-more",
        "aria-expanded": "false",
        onclick: () => {
          const open = body.classList.toggle("is-folded") === false;
          more.setAttribute("aria-expanded", String(open));
          more.textContent = open ? "Show less" : "Show all of it";
        },
      },
      "Show all of it",
    );
    kids.push(more);
  }
  return el("section", { class: "rv-intent", "aria-label": "What was asked" }, kids);
}

/** The Behavioural surface's order: what callers see first, what was generated last. */
const IMPACT_ORDER = [
  "export_removed",
  "export_changed",
  "export_added",
  "symbol_callers",
  "route",
  "migration",
  "ddl",
  "config",
  "env_added",
  "env_removed",
  "dependency_added",
  "dependency_removed",
  "dependency_bumped",
  "untested_module",
  "downstream_repo",
  "generated",
];

/** "a, b or c". */
function orList(items) {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** Open a file block of the Review diff (and its line, when the diff shows it). */
function goToDiffFile(targetId, line) {
  const block = document.getElementById(targetId);
  if (!block) return;
  block.open = true;
  const row = line != null ? block.querySelector(`.diff-line[data-ln="${Number(line)}"]`) : null;
  (row || block).scrollIntoView({ behavior: "smooth", block: row ? "center" : "start" });
  if (row) {
    row.classList.add("is-target");
    setTimeout(() => row.classList.remove("is-target"), 2400);
  }
}

/**
 * CHANGE IMPACT: the "Behavioural surface" panel above the diff, from each repo's
 * server-computed `impact` (GET /diff?include=impact). Every line says how it was found
 * and links to its file in the diff below; what the scan finds nothing of is said once,
 * and what it does not cover is said as not analysed. Advisory: nothing gates on it.
 * Null when no repo carries impact facts (an older server, or no diff).
 */
function impactPanel(repos) {
  const withImpact = (repos || []).map((rd, i) => ({ rd, i })).filter((x) => x.rd.impact);
  if (!withImpact.length) return null;
  const multi = withImpact.length > 1;
  const blocks = withImpact.map(({ rd, i }) => {
    const files = splitDiffFiles(rd.diff);
    const fileIdx = (p) => files.findIndex((f) => f.path === p);
    const facts = [...(rd.impact.facts || [])].sort(
      (a, b) => IMPACT_ORDER.indexOf(a.kind) - IMPACT_ORDER.indexOf(b.kind),
    );
    const goTo = (path, line) => {
      const idx = path ? fileIdx(path) : -1;
      const target = idx >= 0 ? `diff-file-${i}-${idx}` : null;
      return target
        ? el(
            "button",
            {
              type: "button",
              class: "btn-link rv-impact-go",
              dataset: { fileTarget: target },
              "aria-label": `Show ${path} in the diff`,
              onclick: () => goToDiffFile(target, line),
            },
            el("code", { class: "mono" }, `${path}${line != null ? `:${line}` : ""}`),
          )
        : el("code", { class: "mono" }, `${path}${line != null ? `:${line}` : ""}`);
    };
    // CALLERS (code index): the importers and tests a symbol_callers fact lists, each with
    // what is known about it. A file in this diff links to it; the rest are named.
    const refList = (refs) =>
      refs && refs.length
        ? el(
            "ul",
            { class: "clean rv-impact-refs" },
            refs.map((r) =>
              el("li", { class: `rv-impact-ref rv-ref-${r.role}` }, [
                el("small", { class: "dim" }, r.role === "test" ? "test " : "caller "),
                goTo(r.path, r.in_change ? null : r.line),
                r.through ? el("small", { class: "dim" }, ` through ${r.through}`) : null,
                r.in_change ? el("small", { class: "rv-ref-note" }, " changed here") : null,
                r.role === "caller" && r.tested === false
                  ? el("small", { class: "rv-ref-note rv-ref-untested" }, " no test imports it")
                  : null,
              ]),
            ),
          )
        : null;
    const list = el(
      "ul",
      { class: "clean rv-impact-list" },
      facts.map((f) => {
        const idx = f.path ? fileIdx(f.path) : -1;
        const target = idx >= 0 ? `diff-file-${i}-${idx}` : null;
        return el("li", { class: `rv-impact-fact rv-k-${f.kind}` }, [
          el("span", { class: "rv-impact-t" }, f.text),
          " ",
          el("small", { class: "rv-impact-method" }, f.method),
          target
            ? [
                " ",
                el(
                  "button",
                  {
                    type: "button",
                    class: "btn-link rv-impact-go",
                    dataset: { fileTarget: target },
                    "aria-label": `Show ${f.path} in the diff`,
                    onclick: () => goToDiffFile(target, f.line),
                  },
                  el("code", { class: "mono" }, `${f.path}${f.line != null ? `:${f.line}` : ""}`),
                ),
              ]
            : null,
          f.kind === "symbol_callers" ? refList(f.refs) : null,
        ]);
      }),
    );
    const none = rd.impact.none || [];
    const callers = rd.impact.callers;
    return el("div", { class: "rv-impact-repo" }, [
      multi
        ? el("h4", { class: "rv-impact-repo-h" }, el("code", { class: "mono" }, rd.repo))
        : null,
      facts.length
        ? list
        : el("p", { class: "dim" }, "The scan found nothing to list in this diff."),
      none.length ? el("p", { class: "rv-impact-none" }, `No ${orList(none)} change found.`) : null,
      callers && callers.status === "none_changed" && callers.reason
        ? el("p", { class: "rv-impact-none rv-impact-callers-none" }, `Callers: ${callers.reason}`)
        : null,
      ...(rd.impact.not_analysed || []).map((n) => el("p", { class: "rv-impact-na dim" }, n)),
    ]);
  });
  return el("section", { class: "card panel rv-impact", "aria-label": "Behavioural surface" }, [
    el("h3", { class: "rv-h3" }, "Behavioural surface"),
    el(
      "p",
      { class: "rv-impact-sub dim" },
      "Read from the diff and the tree at the head commit, each line with how it was found. Advisory: nothing gates on it.",
    ),
    ...blocks,
  ]);
}

/** The Behavioural surface's rows for "What is not backed" (changed modules with no test). */
function impactBacking(repos) {
  const n = (repos || []).reduce(
    (k, rd) =>
      k + ((rd.impact && rd.impact.facts) || []).filter((f) => f.kind === "untested_module").length,
    0,
  );
  if (!n) return [];
  // Of those, the ones the code index finds no test for on the base branch either.
  const bare = (repos || []).reduce(
    (k, rd) =>
      k +
      ((rd.impact && rd.impact.facts) || []).filter(
        (f) => f.kind === "untested_module" && f.index_tests === 0,
      ).length,
    0,
  );
  return [
    {
      fact:
        n === 1
          ? "1 changed module has no test in this change that imports it"
          : `${n} changed modules have no test in this change that imports them`,
      holds: false,
      source: "the Behavioural surface (by import text)",
      cell: "impact",
    },
    ...(bare
      ? [
          {
            fact:
              bare === 1
                ? "1 of them has no test on the base branch that imports it or is named for it either"
                : `${bare} of them have no test on the base branch that imports them or is named for them either`,
            holds: false,
            source: "the Behavioural surface (by import text, code index)",
            cell: "impact",
          },
        ]
      : []),
  ];
}

/** A commit id, short, in mono; or a plain word when there is none. */
function shaOr(sha, none) {
  return sha ? el("code", { class: "mono" }, String(sha).slice(0, 12)) : none;
}
/** Two commit ids name one commit (equal, or one a ≥7-hex prefix of the other). */
function sameSha(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  return x.length >= 7 && y.length >= 7 && (x.startsWith(y) || y.startsWith(x));
}

/**
 * The strip's Candidate cell: per write repo, the commit the gates ran on, the commit the
 * diff shows, the tester's commit and the pin, and whether they are one commit (the
 * server's `same`). Once the diff loads, `_setShown(repos)` checks the commit on screen
 * too. Its run-log links open the delivery and tester logs.
 */
function candidateCell(p, onRunLog) {
  const cands = p.candidate || [];
  const allSame = cands.every((c) => c.same);
  // Only the runner's own record says the gates ran on a commit: an agent's or a person's
  // record of the head is not shown to be one candidate, but it does not differ either.
  const notRunner = (c) => c.gated_by === "agent" || c.gated_by === "human";
  const unknown = cands.some((c) => !c.diff_head || !c.gated_sha || notRunner(c));
  // A rework entered review a moment before the runner recorded its gated commit (or that
  // record failed): the row still holds an earlier attempt's commit.
  const earlier = !unknown && cands.some((c) => c.gated_earlier);
  const multi = cands.length > 1;
  const sub = el("p", { class: "vd-sub vd-cand-sub" });
  const rows = el(
    "ul",
    { class: "clean vd-cand-list" },
    cands.map((c) =>
      el("li", { class: "vd-cand" }, [
        multi ? el("b", { class: "vd-cand-repo" }, c.repo) : null,
        el("span", { class: "vd-cand-row" }, [
          "Gates ran on ",
          shaOr(c.gated_sha, "no recorded commit"),
          c.gated_by === "agent"
            ? " (the agent's record)"
            : c.gated_by === "human"
              ? " (a person's record)"
              : c.gated_earlier
                ? " (an earlier attempt's record)"
                : "",
        ]),
        el("span", { class: "vd-cand-row vd-cand-shown" }, [
          "The diff shows ",
          shaOr(c.diff_head, c.head_unavailable ? `nothing (${c.head_unavailable})` : "nothing"),
        ]),
        el("span", { class: "vd-cand-row" }, [
          "Tested commit ",
          shaOr(c.tester_tested, p.tester_expected ? "none yet" : "none (no tester)"),
        ]),
        c.pin ? el("span", { class: "vd-cand-row" }, ["Pinned ", shaOr(c.pin, "")]) : null,
      ]),
    ),
  );
  const words = (state) =>
    state === "same"
      ? "The gates ran on the commit the diff shows, and any tested or pinned commit is that commit."
      : state === "moved"
        ? "The branch moved after these facts were read: the diff on screen is a newer commit."
        : unknown
          ? "Not every commit is known from the runner's record, so this is not shown to be one candidate."
          : earlier
            ? "The runner records the commit its gates ran on just after the ticket enters review, and this attempt's record is not in: the commit on record is an earlier attempt's. Reload in a moment."
            : "These are not one commit: a green gate or tester verdict is about another commit.";
  const value = (state) =>
    state === "same"
      ? "One commit"
      : state === "moved"
        ? "Moved"
        : unknown
          ? "Unknown"
          : earlier
            ? "Not recorded"
            : "Differs";
  let state = allSame ? "same" : "differs";
  sub.textContent = words(state);
  const links = (p.run_links || []).map((r) =>
    el(
      "button",
      {
        type: "button",
        class: "btn-link vd-runlink",
        dataset: { runId: r.run_id, role: r.role },
        title: `The dashboard run that was running then (${r.method}), started ${fmtTime(r.started_at)}`,
        onclick: () => {
          // A raw view: the review-time measure counts it (ticket.review_raw_opened).
          if (typeof onRunLog === "function") onRunLog();
          viewRunLog(
            { id: r.run_id, kind: r.kind },
            `${r.role === "tester" ? "Tester" : "Delivery"} run log`,
          );
        },
      },
      r.role === "tester" ? "View tester run log" : "View delivery run log",
    ),
  );
  // The runs table carries no ticket: say on screen how the link was found.
  const foundBy = links.length ? el("small", { class: "vd-runlink-by" }, " (found by time)") : null;
  const runLine = el("p", { class: "vd-sub vd-runlinks" }, [
    links.length
      ? ""
      : "No run log is recorded for this delivery (its runner was not started from the dashboard).",
    ...links.flatMap((a, i) => (i ? [" · ", a] : [a])),
    foundBy,
  ]);
  const cell = verdictCell(
    "candidate",
    "Candidate",
    value(state),
    `Candidate: ${value(state).toLowerCase()}`,
    [rows, sub, runLine],
    state === "same" ? "ok" : unknown || earlier ? "warn" : "bad",
  );
  cell._setShown = (repos) => {
    const moved = (repos || []).some((r) => {
      const c = cands.find((x) => x.repo_id === r.repoId);
      return c && r.headSha && c.diff_head && !sameSha(r.headSha, c.diff_head);
    });
    if (!moved) return;
    state = "moved";
    cell.querySelector(".vd-v").textContent = value(state);
    cell.setAttribute("aria-label", `Candidate: ${value(state).toLowerCase()}`);
    cell.classList.remove("vd-ok", "vd-bad");
    cell.classList.add("vd-warn");
    sub.textContent = words(state);
  };
  return cell;
}

/** The strip's CI cell: the latest recorded CI result for the candidate commit. */
function ciCell(ci) {
  if (!ci)
    return verdictCell(
      "ci",
      "CI",
      "None",
      "CI: no result recorded",
      el("p", { class: "vd-sub" }, "No CI result is recorded for this ticket."),
    );
  const v = { pass: "Green", fail: "Red", pending: "Running" }[ci.state] || "No result";
  const tone = { pass: "ok", fail: "bad" }[ci.state] || "warn";
  return verdictCell(
    "ci",
    "CI",
    v,
    `CI: ${v.toLowerCase()}${ci.commit ? ` for ${ci.commit.slice(0, 12)}` : ""}`,
    [
      el("p", { class: "vd-sub" }, [
        ci.state ? "Recorded for " : "Nothing recorded for ",
        shaOr(ci.commit, "the candidate commit (its head cannot be read)"),
        ci.at ? ` · ${fmtTime(ci.at)}` : "",
      ]),
      ci.detail ? el("p", { class: "vd-say" }, ci.detail) : null,
      !ci.state && ci.latest
        ? el("p", { class: "vd-sub" }, [
            `The latest result recorded is ${ci.latest.state} for `,
            shaOr(ci.latest.commit, ""),
            ".",
          ])
        : null,
      el("p", { class: "vd-sub" }, "Approval waits for a passing result for this commit."),
    ],
    tone,
  );
}

/** Where a backing row's fact is shown: its strip cell, the criteria table or the evidence. */
const BACKING_TARGET = {
  candidate: ".vd-cell.vd-candidate",
  gates: ".vd-cell.vd-gates",
  integrity: ".vd-cell.vd-gates",
  tester: ".vd-cell.vd-tester",
  ci: ".vd-cell.vd-ci",
  criteria: ".rv-ac-table, .rv-checks",
  evidence: ".rv-evid",
  impact: ".rv-impact",
};

/**
 * INSPECTABLE CONFIDENCE: "What backs this / What is not backed", the server's backing rows
 * (each a fact, whether it holds, and where it comes from) as two lists. No score, no
 * headline and no ask: the flags list stays the one list of things to check. Each row
 * links to where the fact is shown. `_setImpact(repos)` adds the Behavioural surface's
 * rows once the diff loads.
 */
function backingPanel(rows) {
  const holds = el("ul", { class: "clean rv-backing-list rv-backs" });
  const not = el("ul", { class: "clean rv-backing-list rv-unbacked" });
  const rowEl = (b) =>
    el("li", { class: `rv-backing-row ${b.holds ? "is-held" : "is-unheld"}` }, [
      el(
        "span",
        { class: `dod-mark dod-${b.holds ? "pass" : "skip"}`, "aria-hidden": "true" },
        b.holds ? "✓" : "–",
      ),
      el("span", { class: "rv-backing-fact" }, b.fact),
      el("small", { class: "rv-backing-src" }, b.source),
      BACKING_TARGET[b.cell]
        ? el(
            "button",
            {
              type: "button",
              class: "btn-link rv-backing-go",
              "aria-label": `Show where: ${b.fact}`,
              onclick: (e) => {
                const root = e.currentTarget.closest(".view-review") || document;
                const to = root.querySelector(BACKING_TARGET[b.cell]);
                if (to) to.scrollIntoView({ behavior: "smooth", block: "center" });
              },
            },
            "show",
          )
        : null,
    ]);
  const paint = (list) => {
    clear(holds);
    clear(not);
    for (const b of list) (b.holds ? holds : not).appendChild(rowEl(b));
    if (!holds.children.length)
      holds.appendChild(
        el("li", { class: "rv-backing-none dim" }, "No recorded fact backs it yet."),
      );
    if (!not.children.length)
      not.appendChild(el("li", { class: "rv-backing-none dim" }, "Every fact read here holds."));
  };
  let base = rows || [];
  paint(base);
  const panel = el("section", { class: "card panel rv-backing", "aria-label": "What backs this" }, [
    el("h2", { class: "rv-h2" }, "What backs this"),
    holds,
    el("h3", { class: "rv-h3" }, "What is not backed"),
    not,
  ]);
  panel._setImpact = (extra) => paint([...base, ...(extra || [])]);
  return panel;
}

function verdictStrip(p, hooks = {}) {
  const cells = [];

  // Gates: the runner's DoD rows, each with its command; the test count it saw.
  const g = p.gates;
  const gateBody = [];
  // A multi-repo delivery ran each gate once per repo: name the repo on every row, or
  // "tests passed" twice says nothing about which repo is which.
  const gateRepos = g
    ? new Set(g.rows.map((r) => r.repo).filter((x) => x && x !== "-"))
    : new Set();
  const multiRepo = gateRepos.size > 1;
  if (g) {
    gateBody.push(
      el(
        "ul",
        { class: "clean vd-gate-list" },
        g.rows.map((r) => {
          // GATE INTEGRITY: a FLAG is the yellow "!" of the gates checklist, never a skip.
          const st =
            r.status === "PASS"
              ? "pass"
              : r.status === "FAIL"
                ? "fail"
                : r.status === "FLAG"
                  ? "flag"
                  : "skip";
          return el("li", { class: `vd-gate vd-g-${st}` }, [
            el(
              "span",
              { class: `dod-mark dod-${st}`, "aria-hidden": "true" },
              { pass: "✓", fail: "✗", flag: "!", skip: "–" }[st],
            ),
            el("b", {}, r.gate),
            multiRepo && r.repo && r.repo !== "-"
              ? el("span", { class: "vd-gate-repo" }, r.repo)
              : null,
            el("span", { class: `vd-word vd-w-${st}` }, VD_WORD[r.status] || r.status),
            r.command
              ? el("code", { class: "vd-cmd mono" }, r.command)
              : r.note
                ? el("span", { class: "vd-note" }, r.note)
                : null,
          ]);
        }),
      ),
    );
    gateBody.push(
      el(
        "p",
        { class: "vd-sub" },
        g.tally
          ? `The runner saw ${plural(g.tally.passed, "test")} pass${
              g.tally.failed ? `, ${g.tally.failed} fail` : ""
            }${g.tally.skipped ? `, ${g.tally.skipped} skipped` : ""} (${g.tally.framework}).`
          : "The runner's test output carries no test count.",
      ),
    );
  } else gateBody.push(el("p", { class: "vd-sub" }, "The runner has recorded no gate report."));
  for (const d of p.disagreements || [])
    gateBody.push(el("p", { class: "vd-flag" }, [ycard(16), d.message]));
  // The integrity row checks the gates; it is not one of them (it never "ran" the work).
  const gateList = g ? g.rows.filter((r) => r.gate !== "integrity") : [];
  const ran = gateList.filter((r) => r.status !== "SKIPPED").length;
  cells.push(
    verdictCell(
      "gates",
      "Gates",
      g ? (g.overall === "PASS" ? "Passed" : "Failed") : "No report",
      g
        ? `Gates: ${g.overall === "PASS" ? "passed" : "failed"}, ${ran} of ${gateList.length} ran`
        : "Gates: no report recorded",
      gateBody,
      g ? (g.overall === "PASS" ? "ok" : "bad") : "warn",
    ),
  );

  // The independent tester: its verdict and what it tested, or when it comes.
  const ts = p.tester;
  // A PASS on a commit the branch has moved past is not a PASS of this commit (lane-hook
  // R3): the same comparison as the server's backing row, on any write repo's head, and
  // only when a head was read (otherwise the strip cannot tell).
  const cands = Array.isArray(p.candidate) ? p.candidate : [];
  const passMoved =
    ts &&
    ts.verdict === "pass" &&
    ts.tested_commit &&
    cands.some((c) => c.diff_head) &&
    !cands.some((c) => sameSha(ts.tested_commit, c.diff_head));
  // LANE-SETTING CONSISTENCY: the runner last routed under a lane that does not gate this
  // ticket, so "it tests before you review" is not what will happen (the flag says why).
  const runnerLane = p.tester_lane && p.tester_lane.runner;
  const runnerSkips = !!(runnerLane && p.tester_expected && !runnerLane.gates);
  cells.push(
    passMoved
      ? verdictCell(
          "tester",
          "Tester",
          "Not this commit",
          `Independent tester: passed ${ts.tested_commit.slice(0, 12)}, not tested on this commit`,
          [
            el("p", { class: "vd-sub" }, [
              "Passed ",
              el("code", { class: "mono" }, ts.tested_commit.slice(0, 12)),
              testerByline(ts),
              ` · ${fmtTime(ts.at)}`,
            ]),
            el(
              "p",
              { class: "vd-say" },
              "Not tested on this commit: the branch has moved past the commit the tester passed, and approval waits for a PASS on the new one.",
            ),
          ],
          "warn",
        )
      : ts
        ? verdictCell(
            "tester",
            "Tester",
            ts.verdict === "pass" ? "Passed" : "Failed",
            `Independent tester: ${ts.verdict === "pass" ? "passed" : "failed"}${
              ts.tested_commit ? `, tested commit ${ts.tested_commit.slice(0, 12)}` : ""
            }`,
            [
              el("p", { class: "vd-sub" }, [
                ts.tested_commit
                  ? ["Tested ", el("code", { class: "mono" }, ts.tested_commit.slice(0, 12))]
                  : "No commit recorded",
                testerByline(ts),
                ` · ${fmtTime(ts.at)}`,
              ]),
              el("p", { class: "vd-say" }, ts.summary),
            ],
            ts.verdict === "pass" ? "ok" : "bad",
          )
        : verdictCell(
            "tester",
            "Tester",
            p.tester_expected ? "Not yet" : "None",
            p.tester_expected
              ? "Independent tester: has not passed this commit yet"
              : "Independent tester: not used for this ticket",
            el(
              "p",
              { class: "vd-sub" },
              runnerSkips
                ? `Approval waits for the independent tester's PASS, but the runner last routed with GAFFER_TESTING ${runnerLane.mode}, which does not send this ticket to the tester. See Flags.`
                : p.tester_expected
                  ? "The independent tester tests a delivery before you review it, and approval waits for its PASS on the commit you sign."
                  : p.tester_lane &&
                      p.tester_lane.mode === "auto" &&
                      p.tester_lane.missing_test_command.length
                    ? `This ticket does not go through the independent tester: no test command is registered for ${p.tester_lane.missing_test_command.join(", ")}.`
                    : "This ticket does not go through the independent tester.",
            ),
          ),
  );

  // SAME CANDIDATE and REQUIRED CI (an older server's packet has neither).
  let candCell = null;
  if (Array.isArray(p.candidate) && p.candidate.length) {
    candCell = candidateCell(p, hooks.onRunLog);
    cells.push(candCell);
  }
  if ("ci" in p) cells.push(ciCell(p.ci));

  // Cost and turns so far, from the usage ledger (an estimate is said as one).
  const c = p.cost;
  const unknown = c.ledger_status === "unreadable";
  const untracked = c.ledger_status === "unconfigured" || c.ledger_status === "no_ticket";
  cells.push(
    verdictCell(
      "cost",
      "Cost",
      unknown ? "Unknown" : untracked ? "Not tracked" : money(c.cost_usd),
      unknown
        ? "Cost: unknown, the usage ledger could not be read"
        : untracked
          ? "Cost: not tracked, no usage ledger"
          : `Cost so far: ${money(c.cost_usd)} over ${plural(c.num_turns, "turn")}`,
      el("p", { class: "vd-sub" }, [
        unknown
          ? "The usage ledger could not be read."
          : untracked
            ? "No usage ledger is configured."
            : plural(c.num_turns, "turn"),
        !unknown && c.estimated_usd > 0 ? ` · ${money(c.estimated_usd)} of it estimated` : "",
        c.unknown_calls ? ` · ${plural(c.unknown_calls, "call")} unmeasured` : "",
        c.budget_usd != null ? ` · budget ${moneyW(c.budget_usd)}` : "",
      ]),
      unknown ? "warn" : "",
    ),
  );

  // Attempts and the rework history (latest three).
  const at = p.attempts;
  const rework = at.rework || [];
  cells.push(
    verdictCell(
      "attempts",
      "Attempt",
      `${at.attempt_count + 1} of ${at.max_attempts}`,
      `Attempt ${at.attempt_count + 1} of ${at.max_attempts}, sent back ${plural(rework.length, "time")}`,
      rework.length
        ? [
            el(
              "ol",
              { class: "clean vd-rework" },
              rework
                .slice(-3)
                .map((r) =>
                  el("li", {}, [
                    el("span", { class: "vd-when tabnum" }, fmtTime(r.at)),
                    ` Sent back by ${reworkWho(r)}: `,
                    el("span", { class: "vd-why" }, r.reason),
                  ]),
                ),
            ),
            rework.length > 3
              ? el("p", { class: "vd-sub" }, `${plural(rework.length - 3, "earlier send-back")}`)
              : null,
          ]
        : el("p", { class: "vd-sub" }, "First time through: nothing has sent it back."),
      rework.length ? "warn" : "",
    ),
  );

  // Risk: the declared level, the recorded reasons, then the diff's own flags.
  const riskList = el("ul", { class: "clean vd-reasons" });
  const riskSub = el("p", { class: "vd-sub" }, "Reading the diff's risk check…");
  const riskCell = verdictCell(
    "risk",
    "Risk",
    riskBadge(p.risk.level, { long: true }),
    `Risk: ${p.risk.level}`,
    [riskList, riskSub],
  );
  const paintRisk = (anns) => {
    clear(riskList);
    const reasons = [...p.risk.reasons, ...(anns || []).map((a) => a.detail)];
    for (const r of reasons) riskList.appendChild(el("li", {}, r));
    if (anns) riskSub.textContent = reasons.length ? "" : "The diff's risk check raised nothing.";
    riskSub.hidden = !riskSub.textContent;
    riskCell.setAttribute(
      "aria-label",
      `Risk: ${p.risk.level}${reasons.length ? `, ${plural(reasons.length, "reason")}` : ""}`,
    );
  };
  paintRisk(null);
  cells.push(riskCell);

  // The reviewed-commit pin, when one is recorded: landing merges only that commit.
  if (p.pin)
    cells.push(
      verdictCell(
        "pin",
        "Pinned",
        el("code", { class: "mono" }, p.pin.sha.slice(0, 12)),
        `Reviewed commit pinned: ${p.pin.sha.slice(0, 12)}`,
        el("p", { class: "vd-sub" }, [
          /^agent review/.test(p.pin.summary) ? "By the agent review" : "By a review",
          ` · ${fmtTime(p.pin.at)}. Only this commit can land.`,
        ]),
      ),
    );

  // EVAL JUDGE (the runner's opt-in judge): the quality judge's grade, when one was recorded for
  // this delivery. A model's opinion of the diff, not a runner fact: said as one, and no
  // gate reads it. Its weak dimensions carry the judge's own reasons.
  const jd = p.judge;
  if (jd) cells.push(judgeCell(jd));

  const strip = el(
    "section",
    { class: "rv-verdict", "aria-label": "The runner's verdict" },
    el("div", { class: "vd-cells" }, cells),
  );
  strip._setRisk = paintRisk;
  strip._setShown = (repos) => candCell?._setShown(repos);
  return strip;
}

/**
 * The acceptance criteria as the runner sees them: each with its check command
 * and the runner's recorded exit code, or "no machine evidence" on a yellow card
 * when only the agent's word (or nothing) backs it.
 */
function acTable(rows) {
  return el("table", { class: "rv-ac-table" }, [
    el("caption", { class: "sr-only" }, "Acceptance criteria and the evidence behind each"),
    el(
      "thead",
      {},
      el("tr", {}, [
        el("th", { scope: "col" }, "Criterion"),
        el("th", { scope: "col" }, "Check"),
        el("th", { scope: "col" }, "Evidence"),
      ]),
    ),
    el(
      "tbody",
      {},
      rows.map((a) => {
        const kind = a.evidence_kind;
        const failed = a.check && !a.check.passed;
        const tone = kind === "runner" || kind === "human" ? (failed ? "bad" : "ok") : "none";
        const words = acEvidenceWords(a);
        return el(
          "tr",
          {
            class: `ac-ev ac-ev-${kind} ac-ev-${tone}`,
            "aria-label": `${a.text}: ${String(a.status).replace(/_/g, " ")}. ${words}.`,
          },
          [
            el("td", { class: "ac-ev-t" }, [
              el("span", {}, a.text),
              el("span", { class: "ac-state" }, String(a.status || "").replace(/_/g, " ")),
            ]),
            el(
              "td",
              { class: "ac-ev-cmd" },
              a.check_command
                ? el("code", { class: "mono" }, a.check_command)
                : el("span", { class: "dim" }, "No check command"),
            ),
            el(
              "td",
              { class: "ac-ev-what" },
              el("div", { class: "ac-ev-in" }, [
                tone === "ok"
                  ? el("span", { class: "dod-mark dod-pass", "aria-hidden": "true" }, "✓")
                  : tone === "bad"
                    ? redCard(16)
                    : ycard(16),
                el("span", { class: "ac-ev-word" }, [
                  kind === "runner" || kind === "human"
                    ? el("span", {}, [
                        el("b", {}, kind === "runner" ? "Runner" : "Person"),
                        ` · exit ${a.check.exit_code ?? "unknown"}`,
                      ])
                    : el("b", {}, "No machine evidence"),
                  el(
                    "small",
                    { class: "ac-ev-by" },
                    kind === "agent"
                      ? `The agent's word${a.verified_by ? ` (verified by ${actorName("agent", a.verified_by)})` : ""}`
                      : kind === "none"
                        ? "Nothing recorded"
                        : a.verified_by
                          ? `verified by ${a.verified_by}`
                          : fmtTime(a.check.at),
                  ),
                ]),
              ]),
            ),
          ],
        );
      }),
    ),
  ]);
}

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
    ? verdictStrip(packet, { onRunLog: () => noteReviewOpen(t.id, since, "run_log") })
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

// ===========================================================================
//  Map (UI-000 / UI-001 / UI-002 / UI-003)
// ===========================================================================

const SCOPE_NODE_TYPES = [
  "factory",
  "domain",
  "product",
  "capability",
  "system",
  "service",
  "library",
  "external_dependency",
];
const SCOPE_EDGE_RELATIONS_V1 = ["contains", "depends_on"];
const SCOPE_EDGE_RELATIONS_ADVANCED = [
  "calls",
  "publishes_to",
  "consumes_from",
  "shares_library",
  "deployed_with",
];
const SCOPE_REPO_RELATIONS = [
  "owns",
  "contains",
  "uses",
  "depends_on",
  "shared_by",
  "deployed_with",
  "read_context",
  "write_target",
  "test_target",
];
const SCOPE_REPO_ACCESS = ["write", "read", "test", "none"];

const factoryState = { query: "" };

function parseTags(json) {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}
function typeLabel(type) {
  return String(type || "").replace(/_/g, " ");
}
// The Map's live overlay: what each ticket on the board means at a ground.
// Red = blocked or failed, yellow = waits on your sign-off, paused = off the pitch
// in the dugout (held at a budget cap or by hand), in play = the rest of the pitch.
// Drafts and refining tickets are on the bench and are not shown as counters.
const MAP_RED = new Set(["blocked", "failed"]);
const MAP_YELLOW = new Set(["in_review", "ready_for_merge"]);
function mapTone(status) {
  if (MAP_RED.has(status)) return "red";
  if (MAP_YELLOW.has(status)) return "yellow";
  if (status === "paused") return "paused";
  if (ON_PITCH.has(status)) return "play";
  return null;
}
const MAP_TONE_RANK = { red: 0, yellow: 1, paused: 2, play: 3 };
/**
 * The scope the server records for a ticket that targets a repo with no ground:
 * an external_dependency node named "repo:<name>". It is the free agent playing
 * as its own single-repo scope, never a third party, so the Map leaves it off the
 * grounds and shows the repo under Free agents.
 */
function isImplicitScope(n) {
  return (
    !!n &&
    n.type === "external_dependency" &&
    /^repo:/.test(n.name || "") &&
    (/^Implicit single-repo scope/i.test(n.description || "") || !n.description)
  );
}
const MAP_COUNTERS = 6;

/** Every ticket on the board once: the live columns, the closed area and won't-do. */
function boardCards(board) {
  const seen = new Set();
  const out = [];
  for (const c of [
    ...((board && board.columns) || []).flatMap((col) => col.cards || []),
    ...((board && board.closed) || []),
    ...((board && board.wontDo) || []),
  ]) {
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/**
 * Who plays at each ground and which tickets are there: the ONE source the Map,
 * a ground's page and a repo's page all count from. A ticket is at a ground when
 * a repo it delivers to (the board's write boundary) plays there, or when the
 * ticket is linked to the ground itself (as campaign members are). Reads: the
 * board, each repo's scope links, and the details of the tickets in the book.
 * `all` puts every ticket in the book (a ground's page counts its results too);
 * the Map only needs the live ones.
 */
async function mapOverlay(nodes, repos, signal, { all = false } = {}) {
  const opt = (p, fb) =>
    api("GET", p, undefined, { signal }).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return fb;
    });
  // The whole board, and every repo's grounds in ONE read (it was one per repo).
  const [board, scopeLinks] = await Promise.all([
    boardAll("", { signal }).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return null;
    }),
    opt("/scope/repos?all=1", { by_repo: {} }),
  ]);
  const links = repos.map((r) => ({
    scopes: (scopeLinks && scopeLinks.by_repo && scopeLinks.by_repo[r.id]) || [],
  }));
  const every = boardCards(board);
  const cards = every.filter((c) => mapTone(c.status));
  const book = all ? every.filter((c) => c.status !== "cancelled") : cards;
  // node id → [{ repo, relation, access }]
  const reposAt = new Map(nodes.map((n) => [n.id, []]));
  // repo id → [{ node, relation, access }]
  const groundsOf = new Map(repos.map((r) => [r.id, []]));
  repos.forEach((r, i) => {
    for (const s of (links[i] && links[i].scopes) || []) {
      if (!reposAt.has(s.id)) continue;
      reposAt.get(s.id).push({ repo: r, relation: s.relation, access: s.default_access });
      groundsOf.get(r.id).push({ node: s, relation: s.relation, access: s.default_access });
    }
  });
  const repoIdByName = new Map(repos.map((r) => [r.name, r.id]));
  const nodesOfRepo = new Map();
  for (const [nid, list] of reposAt)
    for (const { repo } of list) {
      if (!nodesOfRepo.has(repo.id)) nodesOfRepo.set(repo.id, new Set());
      nodesOfRepo.get(repo.id).add(nid);
    }
  // Direct links (a ticket scoped to a ground, as campaign members are).
  const details = book.length
    ? await ticketDetails(book, signal).catch((e) => {
        if (e && e.code === "ABORTED") throw e;
        return new Map();
      })
    : new Map();
  const at = new Map(nodes.map((n) => [n.id, new Map()]));
  const ofRepo = new Map(repos.map((r) => [r.id, new Map()]));
  for (const c of book) {
    const here = new Set();
    for (const r of c.repos || []) {
      const rid = r.id || repoIdByName.get(r.name);
      if (ofRepo.has(rid)) ofRepo.get(rid).set(c.id, c);
      for (const nid of nodesOfRepo.get(rid) || []) here.add(nid);
    }
    for (const s of (details.get(c.id) && details.get(c.id).scopes) || []) here.add(s.id);
    for (const nid of here) if (at.has(nid)) at.get(nid).set(c.id, c);
  }
  const sorted = (m) =>
    [...m.values()].sort(
      (a, b) =>
        (MAP_TONE_RANK[mapTone(a.status)] ?? 9) - (MAP_TONE_RANK[mapTone(b.status)] ?? 9) ||
        (b.priority || 0) - (a.priority || 0) ||
        (a.number || 0) - (b.number || 0),
    );
  const live = (list) => list.filter((c) => mapTone(c.status));
  const ticketsAt = new Map([...at].map(([k, v]) => [k, sorted(v)]));
  const ticketsOfRepo = new Map([...ofRepo].map(([k, v]) => [k, sorted(v)]));
  return {
    board: !!board,
    cards: sorted(new Map(cards.map((c) => [c.id, c]))),
    book: sorted(new Map(book.map((c) => [c.id, c]))),
    reposAt,
    groundsOf,
    ticketsAt,
    ticketsOfRepo,
    liveAt: new Map([...ticketsAt].map(([k, v]) => [k, live(v)])),
    liveOfRepo: new Map([...ticketsOfRepo].map(([k, v]) => [k, live(v)])),
  };
}

/** The tickets at a ground, from the overlay. The club holds every ticket. */
function groundBook(n, ov, { live = true } = {}) {
  if (!ov) return [];
  if (n.type === "factory") return live ? ov.cards : ov.book;
  return (live ? ov.liveAt : ov.ticketsAt).get(n.id) || [];
}

/**
 * Counts, each ticket in exactly one: red (blocked or failed), yellow (waits on
 * your sign-off), paused (in the dugout) and play (the rest of the pitch).
 * live = red + yellow + paused + play, so the words on a card add up to its
 * counters, and live + done + bench is every ticket in the book.
 */
function mapTally(list) {
  // merge: the yellow that is already signed off and waits only on the merge, so
  // the words can say "2 to review · 1 to merge" (Health counts the 2).
  const t = { red: 0, yellow: 0, merge: 0, paused: 0, play: 0, live: 0, done: 0, bench: 0 };
  for (const c of list || []) {
    const tone = mapTone(c.status);
    if (tone) {
      t[tone] += 1;
      t.live += 1;
      if (c.status === "ready_for_merge") t.merge += 1;
    } else if (c.status === "done") t.done += 1;
    else if (ON_BENCH.has(c.status)) t.bench += 1;
  }
  return t;
}
/** A tally in words, worst first: "1 blocked · 2 to review · 1 paused · 3 in play". */
function tallyWords(t) {
  return [
    t.red ? el("span", { class: "is-red" }, `${t.red} blocked`) : null,
    t.yellow - t.merge ? el("span", {}, `${t.yellow - t.merge} to review`) : null,
    t.merge ? el("span", {}, `${t.merge} to merge`) : null,
    t.paused ? el("span", {}, `${t.paused} paused`) : null,
    t.play ? el("span", {}, `${t.play} in play`) : null,
  ]
    .filter(Boolean)
    .flatMap((x, i) => (i ? [" · ", x] : [x]));
}
/** Where a counter goes: a change waiting on you opens in Review, the rest on its page. */
function mapCounterHref(c) {
  return c.status === "in_review" ? `#/review/${c.id}` : `#/ticket/${c.id}`;
}
/**
 * A ticket as a magnet counter: its number on a disc, carded when it needs you.
 * On the Map it is a link to the ticket (as the tactics board's are); inside a
 * row that is already a link, pass `link: false`.
 */
function mapCounter(c, { link = true } = {}) {
  const tone = mapTone(c.status);
  const word = statusLabel(c.status, c.landing_state);
  const marks = [
    el("span", { class: "mag-n tabnum" }, String(c.number ?? "?")),
    tone === "yellow" ? ycard(12, "mag-card") : null,
    tone === "red" ? el("span", { class: "mag-red", "aria-hidden": "true" }) : null,
    tone === "paused" ? el("span", { class: "mag-pause", "aria-hidden": "true" }) : null,
  ];
  if (!link)
    return el(
      "span",
      { class: `mag is-${tone}`, title: `#${c.number} ${c.title || ""} · ${word}` },
      marks,
    );
  return el(
    "a",
    {
      class: `mag is-${tone}`,
      href: mapCounterHref(c),
      title: `#${c.number} ${c.title || ""} · ${word}`,
      "aria-label": `#${c.number} ${word}${tone === "yellow" ? ", needs you" : ""}: ${c.title || ""}`,
    },
    marks,
  );
}

/** One ground on the map: name (the link), type and risk, who plays here, what is live. */
function mapGround(n, ov, relLine) {
  const repos = (ov && ov.reposAt.get(n.id)) || [];
  // The club holds everything: its card tallies every live ticket, without counters.
  const club = n.type === "factory" && ov;
  const live = groundBook(n, ov);
  const t = mapTally(live);
  const search = [n.name, n.type, n.owner, ...repos.map((r) => r.repo.name)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const shown = club ? [] : live.slice(0, MAP_COUNTERS);
  const more = club ? 0 : live.length - shown.length;
  return el(
    "div",
    {
      class: `scope-gnode type-${n.type}${t.red ? " has-red" : ""}`,
      dataset: { name: (n.name || "").toLowerCase(), search, node: n.id },
    },
    [
      el("div", { class: "sg-top" }, [
        el("a", { class: "sg-name", href: `#/node/${n.id}` }, n.name),
        n.risk_level ? riskBadge(n.risk_level) : null,
      ]),
      el("span", { class: "sg-meta" }, [
        el("span", { class: "sg-type" }, typeLabel(n.type)),
        n.owner ? el("span", {}, `@${n.owner}`) : null,
      ]),
      relLine ? el("span", { class: "sg-rel" }, relLine) : null,
      repos.length
        ? el("span", { class: "sg-repos" }, [
            ...repos.slice(0, 2).map((r) => repoTag(r.repo.name, 16)),
            repos.length > 2 ? el("span", { class: "sg-more" }, `+${repos.length - 2}`) : null,
          ])
        : null,
      live.length
        ? el("span", { class: "sg-live" }, [
            club
              ? el("span", { class: "sg-club" }, [
                  el("b", { class: "tabnum" }, String(live.length)),
                  " live across the club",
                ])
              : el("span", { class: "sg-mags" }, [
                  ...shown.map((c) => mapCounter(c)),
                  more > 0
                    ? el(
                        "a",
                        {
                          class: "sg-more mag-more",
                          href: `#/node/${n.id}`,
                          "aria-label": `${more} more live at ${n.name}`,
                        },
                        `+${more}`,
                      )
                    : null,
                ]),
            el("span", { class: "sg-words" }, tallyWords(t)),
          ])
        : el("span", { class: "sg-words is-quiet" }, ov && ov.board ? "Nothing in play" : ""),
    ],
  );
}

/** The map key: what the lines, counters and cards mean. */
function mapKey() {
  const disc = (cls, extra) =>
    el("span", { class: `mag is-${cls}`, "aria-hidden": "true" }, [
      el("span", { class: "mag-n" }, "12"),
      extra,
    ]);
  return el("ul", { class: "clean map-key", "aria-label": "Map key" }, [
    el("li", {}, [el("span", { class: "mk-line contains" }), "contains"]),
    el("li", {}, [el("span", { class: "mk-line dep" }), "depends on"]),
    el("li", {}, [disc("play"), "a ticket on the pitch"]),
    el("li", {}, [disc("yellow", ycard(12, "mag-card")), "waits on your sign-off"]),
    el("li", {}, [
      disc("red", el("span", { class: "mag-red", "aria-hidden": "true" })),
      "blocked or failed",
    ]),
    el("li", {}, [
      disc("paused", el("span", { class: "mag-pause", "aria-hidden": "true" })),
      "paused, in the dugout",
    ]),
  ]);
}

async function renderFactory() {
  const signal = routeSignal();
  const soft = (p, fb) =>
    api("GET", p, undefined, { signal }).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return fb;
    });
  const [nodesRes, edgesRes, unmappedRes, reposRes, hiddenRes] = await Promise.all([
    api("GET", "/scope/nodes", undefined, { signal }),
    api("GET", "/scope/edges", undefined, { signal }),
    api("GET", "/scope/unmapped-repos", undefined, { signal }),
    soft("/repositories", { repositories: [] }),
    soft("/repositories?hidden=only", null),
  ]);
  const hiddenN = hiddenRes ? (hiddenRes.repositories || []).length : 0;
  // The server's synthetic "repo:<name>" scopes are free agents, not grounds.
  const implicitIds = new Set((nodesRes.nodes || []).filter(isImplicitScope).map((n) => n.id));
  const nodes = (nodesRes.nodes || []).filter((n) => !implicitIds.has(n.id));
  const edges = (edgesRes.edges || []).filter(
    (e) => !implicitIds.has(e.from_node_id) && !implicitIds.has(e.to_node_id),
  );
  const unmapped = unmappedRes.repositories || [];
  const repos = reposRes.repositories || [];
  learnKits(repos.map((r) => r.name));
  const ov = await mapOverlay(nodes, repos, signal);
  const readAt = Date.now();

  const wrap = el("div", { class: "view view-map" });
  const campaigns = nodes.filter((n) => n.type === "epic").length;
  wrap.appendChild(
    viewHead(
      "The scouting map",
      [
        plural(nodes.length, "ground"),
        plural(repos.length, "repo"),
        campaigns ? plural(campaigns, "campaign") : null,
        ov.board ? `${ov.cards.length} live ${ov.cards.length === 1 ? "ticket" : "tickets"}` : null,
        unmapped.length ? plural(unmapped.length, "free agent") : null,
      ]
        .filter(Boolean)
        .join(" · "),
      [
        roLock(
          el("button", { class: "btn", type: "button", onclick: () => navigate("#/node") }, [
            icon("plus"),
            "New ground",
          ]),
        ),
        onboardButton(repos, null, { primary: true }),
      ],
    ),
  );

  const graphCard = renderScopeGraph(nodes, edges, ov, readAt);
  wrap.appendChild(graphCard);
  wrap._mounted = () => graphCard._fit && graphCard._fit();

  const register = renderRepoRegister(repos, unmapped, ov);
  const freeAgents = renderUnmappedSection(unmapped, repos, hiddenN, {
    ov,
    grounds: nodes.length,
  });
  const side = el("div", { class: "stack map-side" }, [
    unmapped.length ? null : freeAgents,
    el("details", { class: "card map-help" }, [
      el("summary", {}, "How the map works"),
      el("p", {}, [
        "A ground is a scope node: the club, a product, a service, a campaign or something outside the ground. ",
        el("b", {}, "Contains"),
        " lines show what sits inside what; dashed ",
        el("b", {}, "depends on"),
        " lines show who leans on whom.",
      ]),
      el(
        "p",
        {},
        "Repos play at one or more grounds, each with its own access (write, read or test). A repo with no ground plays as its own single-repo scope, and can be given a ground later without touching its tickets.",
      ),
    ]),
    renderFactoryFooter(),
  ]);
  wrap.appendChild(el("div", { class: "map-lower" }, [register, side]));
  if (unmapped.length) wrap.appendChild(freeAgents);

  wrap.dataset.sig = hashText(
    JSON.stringify([
      nodes.map((n) => [n.id, n.updated_at]),
      edges.map((e) => e.id),
      repos.map((r) => [r.id, r.updated_at]),
      unmapped.map((r) => r.id),
      hiddenN,
      [...ov.reposAt].map(([k, v]) => [k, v.map((x) => `${x.repo.id}:${x.access}`)]),
      ov.cards.map((c) => `${c.id}:${c.status}`),
    ]),
  );
  applyFactoryFilter(wrap, factoryState.query.trim().toLowerCase());
  return wrap;
}

// Low-key entry point to the (deliberately unadvertised) "Hidden repos" page.
// Not a nav tab — a small footer link under the Map, so a hidden repo
// can be brought back without surfacing the capability prominently.
function renderFactoryFooter() {
  return el("div", { class: "factory-footer dim" }, [
    el(
      "a",
      {
        class: "hidden-repos-link",
        href: "#/hidden",
        title: "Repos hidden from the dashboard",
      },
      "Hidden repos",
    ),
  ]);
}

/** Column names from what stands in them (the club, its products, its services…). */
const MAP_COL_WORD = {
  factory: "The club",
  domain: "Domains",
  product: "Products",
  capability: "Capabilities",
  system: "Systems",
  service: "Services",
  library: "Libraries",
  component: "Components",
  external_dependency: "Outside the ground",
  epic: "Campaigns",
};
/**
 * The map's columns, by what a ground IS, so a column's name is always true and
 * outside grounds always stand at the far touchline: the club and its campaigns,
 * domains, products, services (and the other parts that run), outside the ground.
 * Empty tiers are dropped.
 */
const MAP_TIER = {
  factory: 0,
  epic: 0,
  domain: 1,
  product: 2,
  capability: 2,
  system: 3,
  service: 3,
  library: 3,
  component: 3,
  external_dependency: 4,
};
const mapTierOf = (n) => MAP_TIER[n.type] ?? 3;

/**
 * Lay the grounds out in tiers (columns) and order each column by where the
 * grounds it is linked to sit in the columns before it (barycentre), so contains
 * lines cross as little as they can.
 */
function mapLayout(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parents = new Map();
  for (const e of edges) {
    if (e.relation !== "contains") continue;
    if (byId.has(e.from_node_id) && byId.has(e.to_node_id))
      parents.set(e.to_node_id, e.from_node_id);
  }
  const tiers = [...new Set(nodes.map(mapTierOf))].sort((x, y) => x - y);
  const cols = tiers.map((tier) => nodes.filter((n) => mapTierOf(n) === tier));
  const colOf = new Map();
  cols.forEach((list, ci) => list.forEach((n) => colOf.set(n.id, ci)));
  const rowOf = new Map();
  const typeRank = (n) => (n.type === "factory" ? 0 : n.type === "epic" ? 2 : 1);
  cols.forEach((list, ci) => {
    const key = (n) => {
      const ups = edges
        .map((e) =>
          e.to_node_id === n.id ? e.from_node_id : e.from_node_id === n.id ? e.to_node_id : null,
        )
        .filter((id) => id && rowOf.has(id) && colOf.get(id) < ci)
        .map((id) => rowOf.get(id));
      return ups.length
        ? ups.reduce((x, y) => x + y, 0) / ups.length
        : ci === 0
          ? typeRank(n) * 100
          : 999;
    };
    const keys = new Map(list.map((n) => [n.id, key(n)]));
    list.sort((x, y) => keys.get(x.id) - keys.get(y.id) || x.name.localeCompare(y.name));
    list.forEach((n, ri) => rowOf.set(n.id, ri));
  });
  const word = (t) => MAP_COL_WORD[t] || typeLabel(t);
  const colName = (list) => {
    const types = [...new Set(list.map((n) => n.type))];
    if (types.length === 1) return word(types[0]);
    if (types.includes("factory")) return "The club and its campaigns";
    const ws = types.map(word);
    return ws.length === 2
      ? `${ws[0]} and ${ws[1].toLowerCase()}`
      : `${ws.slice(0, -1).join(", ")} and ${ws[ws.length - 1].toLowerCase()}`;
  };
  return { byId, parents, cols, colOf, rowOf, colName };
}

/** "Part of Checkout · depends on Stripe": a ground's lines, read as words (the phone list). */
function mapRelLine(n, edges, byId) {
  const parts = [];
  for (const e of edges) {
    if (e.to_node_id === n.id && e.relation === "contains" && byId.has(e.from_node_id))
      parts.push(`part of ${byId.get(e.from_node_id).name}`);
    if (e.from_node_id === n.id && e.relation !== "contains" && byId.has(e.to_node_id))
      parts.push(
        `${e.relation === "depends_on" ? "depends on" : typeLabel(e.relation)} ${byId.get(e.to_node_id).name}`,
      );
  }
  if (!parts.length) return null;
  const s = parts.join(" · ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderScopeGraph(nodes, edges, ov, readAt = Date.now()) {
  const live = ov ? ov.cards.length : 0;
  const card = el("section", { class: "card panel scope-graph", "aria-label": "The grounds" }, [
    panelHead(
      "The grounds",
      [
        plural(nodes.length, "ground"),
        ov && ov.board ? `${live} live` : null,
        `as of ${clockTime(readAt)}`,
      ]
        .filter(Boolean)
        .join(" · "),
      null,
      { kit: "ink" },
    ),
  ]);
  const search = el("input", {
    type: "search",
    placeholder: "A ground, a repo, an owner…",
    value: factoryState.query,
    "aria-label": "Search the Map",
    oninput: (e) => {
      factoryState.query = e.target.value;
      const root = e.target.closest(".view") || card;
      applyFactoryFilter(root, e.target.value.trim().toLowerCase());
    },
  });
  card.appendChild(
    el("div", { class: "map-tools" }, [
      el("label", { class: "map-find" }, [el("span", { class: "map-find-l" }, "Find"), search]),
      nodes.length ? mapKey() : null,
    ]),
  );
  card.appendChild(el("p", { class: "map-found", role: "status", "aria-live": "polite" }));
  if (nodes.length === 0) {
    card.appendChild(
      el("p", { class: "map-none" }, [
        "No grounds on the map yet, so every repo plays as a free agent. ",
        el("a", { href: "#/node" }, "Mark out the club's first ground"),
        ": the club itself, then its products and the services they run on.",
      ]),
    );
    return card;
  }
  const { byId, cols, colOf, rowOf, colName } = mapLayout(nodes, edges);
  const maxRows = Math.max(1, ...cols.map((c) => c.length));
  // The drawing is a CSS grid: a label row, then one row per rank, so a card is as
  // tall as what it says (a long name or a second row of counters never clips) and
  // the gaps between rows run clear across every column. The chalk lines are drawn
  // once the cards are placed, through those gaps (see drawMapEdges).
  const cells = [];
  cols.forEach((list, ci) => {
    cells.push(
      el("div", {
        class: `graph-lane${ci % 2 ? " is-alt" : ""}`,
        style: `grid-column:${ci + 1};grid-row:1 / ${maxRows + 2}`,
        "aria-hidden": "true",
      }),
      el(
        "h3",
        { class: "graph-collabel", style: `grid-column:${ci + 1};grid-row:1` },
        colName(list),
      ),
    );
    for (const n of list) {
      const g = mapGround(n, ov, null);
      g.style.gridColumn = String(ci + 1);
      g.style.gridRow = String(rowOf.get(n.id) + 2);
      cells.push(g);
    }
  });
  const svgHost = el("div", { class: "graph-edges", "aria-hidden": "true" });
  const graph = el(
    "div",
    {
      class: "graph",
      dataset: { cols: String(cols.length) },
      style: `grid-template-columns:repeat(${cols.length}, minmax(0, 1fr));grid-template-rows:auto repeat(${maxRows}, auto)`,
    },
    [svgHost, ...cells],
  );
  const scroller = el(
    "div",
    {
      class: "graph-scroll",
      role: "region",
      "aria-label": "The scope graph: grounds in columns, lines for contains and depends on",
    },
    [graph],
  );
  card.appendChild(scroller);
  // The same grounds as a list, tier by tier, the lines as words: the phone reads
  // this, and so does a desktop too narrow for every column at a readable width.
  card.appendChild(
    el(
      "div",
      { class: "map-list" },
      cols.map((list) =>
        el("section", { class: "ml-col", "aria-label": colName(list) }, [
          el("h3", { class: "ml-head" }, colName(list)),
          el(
            "div",
            { class: "ml-cards" },
            list.map((n) => mapGround(n, ov, mapRelLine(n, edges, byId))),
          ),
        ]),
      ),
    ),
  );
  // The narrowest a column may get before the map reads as the list instead.
  const COL_MIN = 176,
    COL_GAP = 36,
    PAD = 18;
  const need = cols.length * COL_MIN + (cols.length - 1) * COL_GAP + PAD * 2;
  let ro = null;
  let lastW = -1;
  const fit = () => {
    const w = card.clientWidth;
    if (!w || w === lastW) return;
    lastW = w;
    // The card's padding is inside clientWidth; the scroller sits in its content box.
    const cs = window.getComputedStyle(card);
    const inner = w - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const asList = inner < need;
    card.classList.toggle("is-list", asList);
    card.classList.toggle("is-graph", !asList);
    if (!asList) drawMapEdges(graph, svgHost, edges, colOf);
  };
  card._fit = () => {
    fit();
    if (!ro && typeof window.ResizeObserver === "function") {
      ro = new window.ResizeObserver(() => {
        lastW = -1;
        fit();
      });
      ro.observe(card);
    }
  };
  card._dispose = () => ro && ro.disconnect();
  return card;
}

/**
 * Draw the chalk lines between placed cards. Neighbouring columns join with a
 * curve through the gap between them. A line that skips a column never runs
 * under a card: it drops down its own gap to the nearest clear gap between rows,
 * runs along it, and climbs the gap before its target. Same-column links bow out
 * into the gap beside them.
 */
function drawMapEdges(graph, host, edges, colOf) {
  const W = graph.offsetWidth,
    H = graph.offsetHeight;
  if (!W || !H) return;
  const box = new Map();
  for (const g of graph.querySelectorAll(".scope-gnode")) {
    box.set(g.dataset.node, {
      x: g.offsetLeft,
      y: g.offsetTop,
      w: g.offsetWidth,
      h: g.offsetHeight,
    });
  }
  // Column edges, and the clear channels between rows (and above the first, below the last).
  const colL = [],
    colR = [];
  const rowTop = [],
    rowBot = [];
  for (const g of graph.querySelectorAll(".scope-gnode")) {
    const b = box.get(g.dataset.node);
    const ci = colOf.get(g.dataset.node);
    const ri = Number(g.style.gridRow) - 2;
    colL[ci] = Math.min(colL[ci] ?? Infinity, b.x);
    colR[ci] = Math.max(colR[ci] ?? -Infinity, b.x + b.w);
    rowTop[ri] = Math.min(rowTop[ri] ?? Infinity, b.y);
    rowBot[ri] = Math.max(rowBot[ri] ?? -Infinity, b.y + b.h);
  }
  const rows = rowTop.length;
  const channels = [];
  for (let r = 0; r <= rows; r++) {
    const above = r === 0 ? null : rowBot[r - 1];
    const below = r === rows ? null : rowTop[r];
    if (above == null && below != null) channels.push(below - 12);
    else if (below == null && above != null) channels.push(Math.min(H - 8, above + 12));
    else if (above != null) channels.push((above + below) / 2);
  }
  const gapAfter = (ci) =>
    colL[ci + 1] != null ? (colR[ci] + colL[ci + 1]) / 2 : Math.min(W - 6, colR[ci] + 14);
  const gapBefore = (ci) => (ci > 0 ? (colR[ci - 1] + colL[ci]) / 2 : Math.max(6, colL[ci] - 14));
  const used = new Map();
  const lane = (key) => {
    const k = used.get(key) || 0;
    used.set(key, k + 1);
    return (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 5;
  };
  // A polyline with rounded corners.
  const round = (pts, r = 10) => {
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i - 1],
        [x1, y1] = pts[i],
        [x2, y2] = pts[i + 1];
      const l1 = Math.hypot(x1 - x0, y1 - y0),
        l2 = Math.hypot(x2 - x1, y2 - y1);
      const k = Math.min(r, l1 / 2, l2 / 2);
      if (!k) {
        d += ` L${x1} ${y1}`;
        continue;
      }
      const ax = x1 - ((x1 - x0) / l1) * k,
        ay = y1 - ((y1 - y0) / l1) * k;
      const bx = x1 + ((x2 - x1) / l2) * k,
        by = y1 + ((y2 - y1) / l2) * k;
      d += ` L${ax.toFixed(1)} ${ay.toFixed(1)} Q${x1} ${y1} ${bx.toFixed(1)} ${by.toFixed(1)}`;
    }
    const last = pts[pts.length - 1];
    return `${d} L${last[0]} ${last[1]}`;
  };
  let paths = "";
  for (const e of edges) {
    const a = box.get(e.from_node_id),
      b = box.get(e.to_node_id);
    if (!a || !b) continue;
    const ca = colOf.get(e.from_node_id),
      cb = colOf.get(e.to_node_id);
    const cls = e.relation === "contains" ? "contains" : "dep";
    const ya = a.y + a.h / 2,
      yb = b.y + b.h / 2;
    let d;
    if (ca === cb) {
      // Bow into the gap beside the column (the left one at the far touchline).
      const right = colL[ca + 1] != null || ca === 0;
      const x = right ? a.x + a.w : a.x;
      const bow = right ? gapAfter(ca) + 8 : gapBefore(ca) - 8;
      const xb = right ? b.x + b.w : b.x;
      d = `M${x} ${ya} C ${bow} ${ya}, ${bow} ${yb}, ${xb} ${yb}`;
    } else {
      const fwd = cb > ca;
      const x1 = fwd ? a.x + a.w : a.x,
        x2 = fwd ? b.x : b.x + b.w;
      if (Math.abs(cb - ca) === 1) {
        const mx = (x1 + x2) / 2;
        d = `M${x1} ${ya} C ${mx} ${ya}, ${mx} ${yb}, ${x2} ${yb}`;
      } else {
        const gx1 = (fwd ? gapAfter(ca) : gapBefore(ca)) + lane(`g${fwd ? ca : ca - 1}`);
        const gx2 = (fwd ? gapBefore(cb) : gapAfter(cb)) + lane(`g${fwd ? cb - 1 : cb}`);
        // The clear channel nearest the straight line between the two ends.
        const want = (ya + yb) / 2;
        const ch = channels.length
          ? channels.reduce((p, c) => (Math.abs(c - want) < Math.abs(p - want) ? c : p))
          : want;
        const cy = ch + lane(`c${ch}`);
        d = round([
          [x1, ya],
          [gx1, ya],
          [gx1, cy],
          [gx2, cy],
          [gx2, yb],
          [x2, yb],
        ]);
      }
    }
    paths += `<path class="gedge ${cls}" d="${d}"/>`;
  }
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" focusable="false">${paths}</svg>`;
}

/** A labelled cell: the label shows on a phone, where a row stacks. */
function regCell(label, body, cls = "") {
  return el("td", { class: cls }, [el("span", { class: "reg-l" }, label), body]);
}
/** A count with its mark: red square for blocked, yellow card for review. */
function regCount(n, tone) {
  return el("span", { class: `reg-n${n ? "" : " is-zero"}${n && tone ? ` is-${tone}` : ""}` }, [
    n && tone === "red" ? glyph("blocked", 14) : null,
    n && tone === "yellow" ? ycard(14) : null,
    n && tone === "paused" ? glyph("paused", 14) : null,
    el("span", { class: "tabnum" }, String(n)),
  ]);
}
/** The gates a repo's deliveries must pass, in words. */
function regGates(r) {
  const set = [
    r.test_command ? "tests" : null,
    r.lint_command ? "lint" : null,
    r.coverage_command ? "coverage" : null,
  ].filter(Boolean);
  return set.length
    ? el("span", { class: "reg-gates" }, set.join(" · "))
    : el("span", { class: "reg-gates is-none" }, [glyph("failed", 14), "No gates"]);
}

/** Who plays where: every mapped repo, its grounds and what is live in it. */
function renderRepoRegister(repos, unmapped, ov) {
  const free = new Set(unmapped.map((r) => r.id));
  const mapped = repos.filter((r) => !free.has(r.id));
  const head = panelHead("Who plays where", `${plural(mapped.length, "repo")} at a ground`, null, {
    kit: "claret",
  });
  if (!mapped.length)
    return el("section", { class: "card prog map-register", "aria-label": "Who plays where" }, [
      head,
      el(
        "p",
        { class: "quiet" },
        repos.length
          ? "No repo plays at a ground yet. Open a repo and give it one."
          : "No repos signed yet. Onboard a repo to bring it into the club.",
      ),
    ]);
  // A Paused column only when a mapped repo has a ticket in the dugout.
  const anyPaused = mapped.some((r) => mapTally(ov.liveOfRepo.get(r.id)).paused > 0);
  const rows = mapped.map((r) => {
    const t = mapTally(ov.liveOfRepo.get(r.id));
    const grounds = ov.groundsOf.get(r.id) || [];
    return el("tr", { class: "repo-row", dataset: { kind: "repo", repoId: r.id } }, [
      el("th", { scope: "row", class: "reg-repo" }, [
        el("a", { href: `#/repo/${r.id}` }, repoTag(r.name, 22)),
        el(
          "span",
          { class: "reg-sub" },
          [r.stack, r.default_branch].filter(Boolean).join(" · ") || null,
        ),
      ]),
      regCell(
        "Grounds",
        el(
          "span",
          { class: "reg-grounds" },
          grounds.map((g) =>
            el("span", { class: "reg-ground" }, [
              el("a", { href: `#/node/${g.node.id}` }, g.node.name),
              el("span", { class: "reg-acc" }, [g.relation, g.access].filter(Boolean).join(" · ")),
            ]),
          ),
        ),
      ),
      regCell("Blocked", regCount(t.red, "red"), "reg-num"),
      regCell("To review", regCount(t.yellow, "yellow"), "reg-num"),
      anyPaused ? regCell("Paused", regCount(t.paused, "paused"), "reg-num") : null,
      regCell("In play", regCount(t.play), "reg-num"),
      regCell("Gates", regGates(r), "reg-gc"),
    ]);
  });
  return el("section", { class: "card prog map-register", "aria-label": "Who plays where" }, [
    head,
    el("table", { class: "reg-table" }, [
      el(
        "thead",
        {},
        el("tr", {}, [
          el("th", { scope: "col" }, "Repo"),
          el("th", { scope: "col" }, "Plays at"),
          el("th", { scope: "col", class: "reg-num" }, "Blocked"),
          el("th", { scope: "col", class: "reg-num" }, "To review"),
          anyPaused ? el("th", { scope: "col", class: "reg-num" }, "Paused") : null,
          el("th", { scope: "col", class: "reg-num" }, "In play"),
          el("th", { scope: "col" }, "Gates"),
        ]),
      ),
      el("tbody", {}, rows),
    ]),
  ]);
}

/** Free agents: repos with no ground, each playing as its own single-repo scope. */
function renderUnmappedSection(unmapped, repos = [], hiddenN = 0, { ov = null, grounds = 0 } = {}) {
  const head = panelHead("Free agents", `${plural(unmapped.length, "repo")} with no ground`, null, {
    kit: "sky",
  });
  const card = el(
    "section",
    { class: "card prog map-free", dataset: { section: "unmapped" }, "aria-label": "Free agents" },
    [head],
  );
  if (unmapped.length === 0) {
    card.appendChild(
      el("div", { class: "quiet map-free-none" }, [
        el(
          "p",
          {},
          hiddenN
            ? [
                "Every repo in the squad has a ground. ",
                el("a", { href: "#/hidden" }, `${plural(hiddenN, "hidden repo")}`),
                ` ${hiddenN === 1 ? "is" : "are"} left out.`,
              ]
            : "Every repo in the squad has a ground.",
        ),
        onboardButton(repos, null),
      ]),
    );
    return card;
  }
  card.appendChild(
    el(
      "p",
      { class: "gr-note" },
      grounds
        ? "No ground yet, so each plays as its own single-repo scope and its tickets count only here. Give one a ground from its page."
        : "No ground on the map yet, so each plays as its own single-repo scope. Mark out a ground, or give one a ground from its page.",
    ),
  );
  const rows = unmapped.map((r) => {
    const live = (ov && ov.liveOfRepo.get(r.id)) || [];
    const t = mapTally(live);
    return el("tr", { class: "repo-row", dataset: { kind: "repo", repoId: r.id } }, [
      el("th", { scope: "row", class: "reg-repo" }, [
        el("a", { href: `#/repo/${r.id}` }, repoTag(r.name, 22)),
        live.length
          ? el("span", { class: "reg-live" }, [
              el("span", { class: "sg-mags" }, [
                ...live.slice(0, MAP_COUNTERS).map((c) => mapCounter(c)),
                live.length > MAP_COUNTERS
                  ? el(
                      "a",
                      {
                        class: "sg-more mag-more",
                        href: `#/repo/${r.id}`,
                        "aria-label": `${live.length - MAP_COUNTERS} more live in ${r.name}`,
                      },
                      `+${live.length - MAP_COUNTERS}`,
                    )
                  : null,
              ]),
              el("span", { class: "sg-words" }, tallyWords(t)),
            ])
          : ov && ov.board
            ? el("span", { class: "reg-sub" }, "Nothing in play")
            : null,
      ]),
      regCell(
        "Path",
        r.local_path
          ? el("code", { class: "mono reg-path" }, r.local_path)
          : el("span", { class: "dim" }, "—"),
      ),
      regCell("Stack", el("span", {}, r.stack || "—")),
      regCell("Branch", el("span", {}, r.default_branch || "—")),
      regCell("Gates", renderRepoCommands(r)),
      el("td", { class: "row-actions" }, hideRepoBtn(r)),
    ]);
  });
  card.appendChild(
    el("table", { class: "reg-table reg-free" }, [
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ["Repo", "Path", "Stack", "Branch", "Gate commands", ""].map((h) =>
            el("th", { scope: "col" }, h || el("span", { class: "sr-only" }, "Actions")),
          ),
        ),
      ),
      el("tbody", {}, rows),
    ]),
  );
  card.appendChild(el("div", { class: "map-free-act" }, onboardButton(repos, null)));
  return card;
}

function renderRepoCommands(repo) {
  const cmds = [
    repo.test_command ? ["test", repo.test_command] : null,
    repo.lint_command ? ["lint", repo.lint_command] : null,
    repo.coverage_command ? ["coverage", repo.coverage_command] : null,
  ].filter(Boolean);
  if (cmds.length === 0) return el("span", { class: "dim" }, "—");
  return el(
    "div",
    { class: "cmd-list" },
    cmds.map(([label, cmd]) =>
      el("div", { class: "cmd-row" }, [
        el("span", { class: "cmd-label" }, label),
        el("code", { class: "mono" }, cmd),
      ]),
    ),
  );
}

/**
 * Repo detail: the Definition-of-Done gate commands, EDITABLE. Onboarding
 * auto-detects them from the manifest; a wrong or missing command is the top
 * reason a delivery bounces (tests gate FAIL) or ships unverified (all gates
 * SKIP), so the operator can correct them here. Empty clears a gate (skipped).
 * The coverage command sits here too but is NOT a DoD gate: it feeds the idle
 * coverage scan (coverage-did-not-decrease is a deferred gate).
 */
function renderRepoCommandsEditor(repo) {
  // Named distinctly from the global `field()` labelled-control helper it calls.
  const commandField = (name, label, value, ph) => {
    const input = el("input", {
      type: "text",
      name,
      value: value || "",
      placeholder: ph,
      class: "mono",
    });
    return { input, row: field(label, input) };
  };
  const test = commandField("test_command", "Test command", repo.test_command, "e.g. npm test");
  const lint = commandField("lint_command", "Lint command", repo.lint_command, "e.g. npm run lint");
  const cov = commandField(
    "coverage_command",
    "Coverage command (idle scan, not a gate)",
    repo.coverage_command,
    "optional — e.g. npm run coverage",
  );
  const form = el(
    "form",
    {
      class: "cmd-editor",
      onsubmit: (e) => {
        e.preventDefault();
        guard(async () => {
          await api("POST", `/repos/${repo.id}/commands`, {
            test_command: test.input.value.trim(),
            lint_command: lint.input.value.trim(),
            coverage_command: cov.input.value.trim(),
          });
          toast("Gate commands saved", { ok: true });
          router();
        });
      },
    },
    [
      el("div", { class: "cmd-fields" }, [test.row, lint.row, cov.row]),
      el("div", { class: "cmd-save" }, el("button", { class: "btn", type: "submit" }, "Save")),
    ],
  );
  return el("div", { class: "cmd-block" }, [
    el(
      "p",
      { class: "gr-note" },
      "The runner runs these on every delivery, in its worktree. A failing check sends the delivery back; an empty one is skipped. The coverage command is not a gate: it feeds the idle coverage scan.",
    ),
    form,
  ]);
}

// A discreet "Hide" button for a repo row (WG-006). Stops the row's navigate
// click, asks in the shared sheet, then hides the repo and refreshes — it drops off the list and
// reappears on the "Hidden repos" page.
function hideRepoBtn(repo) {
  return roLock(hideRepoBtnControl(repo), "repo");
}
function hideRepoBtnControl(repo) {
  return el(
    "button",
    {
      class: "btn small repo-hide-btn",
      type: "button",
      "aria-label": `Hide ${repo.name} from the dashboard`,
      title: "Hide this repo from the dashboard (reversible)",
      onclick: (e) => {
        e.stopPropagation();
        hideRepoSheet(repo, () => router());
      },
    },
    "Hide",
  );
}

/**
 * The one way back from a detail page: a real link (it opens in a new tab like any
 * other), the back arrow, and "Back to <where>". Ticket, ground, repo and spec
 * pages all use it, so the way back reads and sits the same everywhere.
 */
function backLink(href, label) {
  return el("a", { class: "back-link", href }, [icon("backarrow", "", 16), el("span", {}, label)]);
}

/** The way back from a ground or repo page to the Map. */
function backToMap() {
  return backLink("#/factory", "Back to Map");
}

// View: Hidden repos (WG-006). A deliberately low-key surface — reached only via
// the small footer link on the Map — listing every hidden repo with an
// "Unhide" button that returns it to its normal place.
async function renderHidden() {
  const repos = (await api("GET", "/repositories?hidden=only")).repositories || [];
  learnKits(repos.map((r) => r.name));
  const wrap = el("div", { class: "view view-hidden" });
  wrap.appendChild(backToMap());
  wrap.appendChild(
    viewHead(
      "Hidden repos",
      repos.length ? `${plural(repos.length, "repo")} left out of the squad` : "None hidden",
    ),
  );
  wrap.appendChild(
    el(
      "p",
      { class: "gr-note hidden-note" },
      "A hidden repo stays registered with its links and grounds, but is left out of the repo list, the Map's free agents and the repo pickers. Unhide one to bring it back.",
    ),
  );

  if (!repos.length) {
    wrap.appendChild(emptyState("Nothing is hidden. Every registered repo is in the squad."));
    return wrap;
  }

  const rows = repos.map((r) =>
    el("tr", { class: "repo-row", dataset: { kind: "repo", repoId: r.id } }, [
      el("th", { scope: "row", class: "reg-repo" }, repoTag(r.name, 22)),
      regCell(
        "Path",
        r.local_path
          ? el("code", { class: "mono reg-path" }, r.local_path)
          : el("span", { class: "dim" }, "—"),
      ),
      regCell("Stack", el("span", {}, r.stack || "—")),
      el(
        "td",
        { class: "row-actions" },
        roLock(
          el(
            "button",
            {
              class: "btn small",
              type: "button",
              "aria-label": `Unhide ${r.name}`,
              onclick: () =>
                guard(async () => {
                  await api("POST", `/repos/${r.id}/hidden`, { hidden: false });
                  toast(`${r.name} un-hidden`, { ok: true });
                  router();
                }),
            },
            "Unhide",
          ),
        ),
      ),
    ]),
  );
  wrap.appendChild(
    progPage("map-free", "ink", "Left out of the squad", plural(repos.length, "repo"), [
      el("table", { class: "reg-table reg-free" }, [
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            ["Repo", "Path", "Stack", ""].map((h) =>
              el("th", { scope: "col" }, h || el("span", { class: "sr-only" }, "Actions")),
            ),
          ),
        ),
        el("tbody", {}, rows),
      ]),
    ]),
  );
  return wrap;
}

function applyFactoryFilter(wrap, q) {
  // Dim the grounds that don't match (the layout stays where it is); hide repo rows.
  const hits = new Set();
  wrap.querySelectorAll(".scope-gnode").forEach((node) => {
    const text = (node.dataset.search || node.dataset.name || node.textContent || "").toLowerCase();
    const miss = !!q && !text.includes(q);
    node.classList.toggle("is-dim", miss);
    if (!miss) hits.add(node.dataset.name);
  });
  let rows = 0;
  wrap.querySelectorAll(".repo-row").forEach((row) => {
    const text = row.textContent.toLowerCase();
    row.hidden = !!q && !text.includes(q);
    if (!row.hidden) rows += 1;
  });
  // Say what the filter found, for everyone (a live region, not just dimming).
  const out = wrap.querySelector(".map-found");
  if (out) {
    const grounds = hits.size;
    out.textContent = !q
      ? ""
      : grounds || rows
        ? `${plural(grounds, "ground")} and ${plural(rows, "repo")} match “${q}”.`
        : `Nothing on the map matches “${q}”. Try a ground, a repo or an owner.`;
    out.classList.toggle("is-none", !!q && !grounds && !rows);
  }
}

// --- View: Scope node editor + detail (UI-001) ------------------------------

/**
 * Fixtures or results: each ticket a row with its counter (carded when it needs
 * you), its title and its status. Links to the ticket.
 */
function fixtureList(list, { empty, limit = 8, byTime = false } = {}) {
  if (!list || !list.length) return el("p", { class: "quiet" }, empty);
  const rows = byTime
    ? [...list].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    : list;
  const shown = rows.slice(0, limit);
  return el("div", { class: "repo-tickets" }, [
    el(
      "ul",
      { class: "clean repo-ticket-list gr-fx-list" },
      shown.map((t) =>
        el(
          "li",
          {},
          el("a", { class: "repo-ticket-row gr-fx-row", href: `#/ticket/${t.id}` }, [
            mapTone(t.status)
              ? el("span", { class: "gr-fx-mag" }, [
                  el("span", { class: "sr-only" }, "#"),
                  mapCounter(t, { link: false }),
                ])
              : el("span", { class: "num" }, t.number != null ? `#${t.number}` : t.id.slice(0, 8)),
            el("span", { class: "repo-ticket-title" }, t.title),
            el("span", { class: "repo-ticket-side" }, [
              statusBadge(t.status, t.landing_state),
              t.updated_at
                ? el(
                    "time",
                    { class: "repo-ticket-time", datetime: t.updated_at },
                    fmtTime(t.updated_at),
                  )
                : null,
            ]),
          ]),
        ),
      ),
    ),
    rows.length > shown.length
      ? el("p", { class: "repo-ticket-more" }, [
          `${rows.length - shown.length} more on the `,
          el("a", { href: "#/work" }, "Work board"),
          ".",
        ])
      : null,
  ]);
}

/** The stat strip a ground or repo page opens on: the Map's counts, nothing else. */
function groundStats(t) {
  return el("div", { class: `kpi-row gr-stats${t.paused ? " has-paused" : ""}` }, [
    statCell({
      label: "Live",
      value: String(t.live),
      sub: t.paused ? "the next four, added up" : "the next three, added up",
    }),
    statCell({ label: "Blocked", value: String(t.red), sub: "blocked or failed" }),
    statCell({
      label: "To review",
      value: String(t.yellow),
      sub: t.merge
        ? `${t.yellow - t.merge} to sign off, ${t.merge} approved to merge`
        : "waits on your sign-off",
      needs: t.yellow > 0,
    }),
    // Paused is rare: its cell shows only when something sits in the dugout.
    t.paused ? statCell({ label: "Paused", value: String(t.paused), sub: "in the dugout" }) : null,
    statCell({ label: "In play", value: String(t.play), sub: "the rest of the pitch" }),
    statCell({ label: "Done", value: String(t.done), sub: "shipped" }),
    statCell({ label: "Bench", value: String(t.bench), sub: "drafts and refining" }),
  ]);
}

/** One line from the same counts: "13 live here: 2 blocked · 3 to review · 8 in play. 6 done." */
function groundCountLine(t, { club = false, where = "here" } = {}) {
  if (!t.live && !t.done && !t.bench)
    return el(
      "p",
      { class: "gr-count is-quiet" },
      club ? "No ticket in the club yet." : `No ticket plays ${where} yet.`,
    );
  return el("p", { class: "gr-count" }, [
    el("b", { class: "tabnum" }, String(t.live)),
    club ? " live across the club" : ` live ${where}`,
    t.live ? [": ", ...tallyWords(t)] : null,
    ". ",
    `${t.done} done`,
    t.bench ? ` · ${t.bench} on the bench` : null,
    ".",
  ]);
}

async function renderNode(id) {
  const signal = routeSignal();
  const [nodesRes, edgesRes, reposRes] = await Promise.all([
    api("GET", "/scope/nodes", undefined, { signal }),
    api("GET", "/scope/edges", undefined, { signal }),
    api("GET", "/repositories", undefined, { signal }).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return { repositories: [] };
    }),
  ]);
  const allNodes = nodesRes.nodes || [];
  const allEdges = edgesRes.edges || [];
  const allRepos = reposRes.repositories || [];
  learnKits(allRepos.map((r) => r.name));

  if (!id) return renderNewGround(allNodes);

  const view = await api("GET", `/scope/nodes/${id}`, undefined, { signal });
  const node = view.node;
  if (node?.name) setDocTitle("node", node.name, id);
  const repos = view.repos || [];

  // The ground's tickets, counted exactly as its card on the Map counts them.
  const ov = await mapOverlay(allNodes, allRepos, signal, { all: true }).catch((e) => {
    if (e && e.code === "ABORTED") throw e;
    return null;
  });
  const isClub = node.type === "factory";
  const book = ov && ov.board ? groundBook(node, ov, { live: false }) : null;
  const t = book ? mapTally(book) : null;
  const live = book ? book.filter((c) => mapTone(c.status)) : [];
  const results = book ? book.filter((c) => c.status === "done") : [];

  const wrap = el("div", { class: "view view-ground" });
  wrap.appendChild(backToMap());

  const tags = parseTags(node.tags_json);
  const loreTags = parseTags(node.lore_tags_json);
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const incoming = allEdges.filter((e) => e.to_node_id === node.id);
  const parent = incoming.find((e) => e.relation === "contains");
  const parentNode = parent ? byId.get(parent.from_node_id) : null;

  const editDetails = el("details", { class: "edit-panel gr-edit" }, [
    el("summary", { class: "btn small" }, "Edit ground"),
    el("div", { class: "card gr-edit-body" }, renderNodeForm(node, allNodes)),
  ]);
  const deleteBtn = roLock(
    el(
      "button",
      {
        class: "btn danger small",
        type: "button",
        onclick: () =>
          confirmSheet({
            title: `Delete ${node.name}`,
            intro: `The ground “${node.name}” is deleted from the Map. This cannot be undone.`,
            confirm: "Delete ground",
            tone: "danger",
            onConfirm: async () => {
              await api("DELETE", `/scope/nodes/${node.id}`);
              toast("Ground deleted", { ok: true });
              navigate("#/factory");
            },
          }),
      },
      "Delete ground",
    ),
  );

  wrap.appendChild(
    el("header", { class: `gr-head is-node type-${node.type}` }, [
      el("div", { class: "gr-head-main" }, [
        el("div", { class: "tk-meta" }, [
          el("span", { class: "gr-type" }, typeLabel(node.type)),
          riskBadge(node.risk_level),
          node.owner ? el("span", { class: "gr-owner" }, `Run by @${node.owner}`) : null,
          parentNode
            ? el("span", {}, [
                "Part of ",
                el(
                  "a",
                  { class: "tk-epic-link", href: `#/node/${parentNode.id}` },
                  parentNode.name,
                ),
              ])
            : null,
        ]),
        el("h1", { class: "detail-title" }, node.name),
        t ? groundCountLine(t, { club: isClub }) : null,
        node.description
          ? el("p", { class: "gr-lede desc" }, node.description)
          : el("p", { class: "gr-lede dim" }, "No description yet."),
        tags.length || loreTags.length
          ? el("div", { class: "tag-row" }, [
              ...tags.map((x) => el("span", { class: "tag-chip" }, x)),
              ...loreTags.map((x) => el("span", { class: "tag-chip lore" }, `lore:${x}`)),
            ])
          : null,
        el("div", { class: "gr-actions" }, [
          node.type === "epic"
            ? el("a", { class: "btn small", href: `#/epics/${node.id}` }, "Open the campaign")
            : null,
          editDetails,
          deleteBtn,
        ]),
      ]),
    ]),
  );
  if (isImplicitScope(node)) {
    const repoName = node.name.slice(5);
    const r = allRepos.find((x) => x.name === repoName);
    wrap.appendChild(
      el("p", { class: "gr-implicit" }, [
        el("b", {}, "Not a ground. "),
        "The factory records this scope when a ticket targets ",
        r ? el("a", { href: `#/repo/${r.id}` }, repoName) : repoName,
        ", a repo with no ground, so the ticket still has a scope. On the Map it plays as a free agent; give it a ground from its page.",
      ]),
    );
  }
  if (t) wrap.appendChild(groundStats(t));

  const fixtures = el("section", { class: "card gr-card", "aria-label": "Fixtures" }, [
    panelHead(
      "Fixtures",
      book ? (live.length ? `${live.length} live, worst first` : "nothing live") : "",
      null,
      { kit: "claret" },
    ),
    book
      ? fixtureList(live, {
          limit: 12,
          empty: isClub
            ? "Nothing in play anywhere in the club."
            : repos.length
              ? "Nothing in play here. The repos that play here have no live ticket."
              : "Nothing in play here. Link a repo, or put a ticket on this ground from its page.",
        })
      : el("p", { class: "quiet" }, "The board did not answer, so the fixtures are unknown."),
  ]);
  const resultsCard = book
    ? el("section", { class: "card gr-card", "aria-label": "Results" }, [
        panelHead(
          "Results",
          results.length ? `latest ${Math.min(8, results.length)} of ${results.length} done` : "",
          null,
          { kit: "ink" },
        ),
        fixtureList(results, { byTime: true, empty: "Nothing shipped from here yet." }),
      ])
    : null;

  const repoCard = el("section", { class: "card gr-card", "aria-label": "Who plays here" }, [
    panelHead("Who plays here", plural(repos.length, "repo"), null, { kit: "sky" }),
    isClub
      ? el(
          "p",
          { class: "gr-note" },
          "The club holds every ground, so its fixtures are every live ticket. Repos play at the grounds inside it.",
        )
      : null,
    repos.length
      ? el(
          "ul",
          { class: "clean gr-rows" },
          repos.map((r) =>
            el(
              "li",
              {},
              el("div", { class: "assoc-row" }, [
                el("a", { class: "assoc-name gr-repo", href: `#/repo/${r.id}` }, [
                  kitShirt(r.name || r.id, 22),
                  el("span", {}, r.name || r.id),
                ]),
                el("div", { class: "assoc-meta" }, [
                  el("span", { class: "gr-rel" }, r.relation),
                  accessBadge(r.default_access),
                ]),
              ]),
            ),
          ),
        )
      : el("p", { class: "quiet" }, "No repo plays here yet. Link one below."),
    el("h3", { class: "gr-sub" }, "Link a repo"),
    roLockAll(renderLinkRepoForm(node.id)),
  ]);

  const connCard = renderConnectionsCard(node, allNodes, allEdges);

  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("div", { class: "stack" }, [fixtures, resultsCard]),
      el("div", { class: "stack" }, [repoCard, connCard]),
    ]),
  );
  return wrap;
}

/** A new ground: what it is, where it stands, then the form. */
function renderNewGround(allNodes) {
  const wrap = el("div", { class: "view view-ground view-new-ground" });
  wrap.appendChild(backToMap());
  const hasClub = allNodes.some((n) => n.type === "factory");
  wrap.appendChild(
    viewHead(
      "New ground",
      allNodes.length
        ? `${plural(allNodes.length, "ground")} on the map already`
        : "The first ground on the map",
    ),
  );
  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("section", { class: "card gr-card", "aria-label": "The ground" }, [
        panelHead("The ground", "name, type, owner, risk", null, { kit: "claret" }),
        renderNodeForm(null, allNodes),
      ]),
      el("section", { class: "card gr-card gr-types", "aria-label": "Which type" }, [
        panelHead("Which type", "where it stands on the map", null, { kit: "sky" }),
        el(
          "dl",
          { class: "kv gr-kv gr-typekey" },
          [
            ["Factory", hasClub ? "The club itself. You have one already." : "The club itself."],
            ["Product", "Something customers use: Checkout, Catalogue."],
            ["Service", "Something products lean on: Payments, Stock sync."],
            ["Domain or capability", "A wider area that holds products or services."],
            ["External dependency", "Outside the ground: Stripe, an ERP."],
          ].flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]),
        ),
        el(
          "p",
          { class: "gr-note" },
          "After it is made, link the repos that play here and connect it to its neighbours from its page.",
        ),
      ]),
    ]),
  );
  return wrap;
}

function renderNodeForm(node, allNodes = []) {
  const isEdit = !!node;
  // An existing ground keeps its own type, even one this list does not offer (epic).
  const types =
    node && node.type && !SCOPE_NODE_TYPES.includes(node.type)
      ? [node.type, ...SCOPE_NODE_TYPES]
      : SCOPE_NODE_TYPES;
  const hasClub = allNodes.some((n) => n.type === "factory");
  const typeNow = node ? node.type : hasClub ? "product" : "factory";
  const name = el("input", {
    type: "text",
    required: "",
    value: node?.name || "",
    placeholder: "e.g. Trading Platform",
  });
  const type = el(
    "select",
    {},
    types.map((t) => el("option", { value: t, selected: typeNow === t }, typeLabel(t))),
  );
  const owner = el("input", {
    type: "text",
    value: node?.owner || "",
    placeholder: "team or person",
  });
  const risk = el(
    "select",
    {},
    RISK_LEVELS.map((r) =>
      el("option", { value: r, selected: (node?.risk_level || "low") === r }, r),
    ),
  );
  const desc = el("textarea", { placeholder: "What is this ground, and what does it own?" });
  desc.value = node?.description || "";
  const tags = el("input", {
    type: "text",
    value: parseTags(node?.tags_json).join(", "),
    placeholder: "comma,separated,tags",
  });
  const loreTags = el("input", {
    type: "text",
    value: parseTags(node?.lore_tags_json).join(", "),
    placeholder: "comma,separated,lore tags",
  });
  const splitTags = (v) =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  const form = el(
    "form",
    {
      class: "form-grid",
      onsubmit: (e) => {
        e.preventDefault();
        const body = { name: name.value.trim(), type: type.value, risk_level: risk.value };
        if (!body.name) return;
        if (owner.value.trim()) body.owner = owner.value.trim();
        if (desc.value.trim()) body.description = desc.value.trim();
        body.tags = splitTags(tags.value);
        body.lore_tags = splitTags(loreTags.value);
        guard(async () => {
          if (isEdit) {
            await api("PATCH", `/scope/nodes/${node.id}`, body);
            toast("Ground updated", { ok: true });
            router();
          } else {
            const r = await api("POST", "/scope/nodes", body);
            toast("Ground created", { ok: true });
            navigate(`#/node/${r.node.id}`);
          }
        });
      },
    },
    [
      el("div", { class: "form-grid cols-2" }, [
        field("Name", name),
        field("Type", type),
        field("Owner", owner),
        field("Risk level", risk),
      ]),
      field("Description", desc),
      el("div", { class: "form-grid cols-2" }, [field("Tags", tags), field("Lore tags", loreTags)]),
      el("div", { class: "btn-row" }, [
        el(
          "button",
          { class: "btn primary", type: "submit" },
          isEdit ? "Save changes" : "Create ground",
        ),
      ]),
    ],
  );
  return roLockAll(form);
}

function renderConnectionsCard(node, allNodes, allEdges) {
  const byId = new Map(allNodes.map((n) => [n.id, n]));
  const outgoing = allEdges.filter((e) => e.from_node_id === node.id);
  const incoming = allEdges.filter((e) => e.to_node_id === node.id);
  const edgeRow = (e, dir) => {
    const otherId = dir === "out" ? e.to_node_id : e.from_node_id;
    const other = byId.get(otherId);
    return el(
      "li",
      {},
      el("div", { class: "assoc-row" }, [
        el("span", { class: "edge-text" }, [
          el("span", { class: "gr-rel" }, edgePhrase(e.relation, dir)),
          other
            ? el("a", { class: "assoc-name", href: `#/node/${otherId}` }, other.name)
            : el("span", { class: "dim" }, otherId.slice(0, 8)),
        ]),
        el(
          "button",
          {
            class: "btn danger small",
            type: "button",
            "aria-label": `Remove ${e.relation} edge`,
            onclick: () =>
              guard(async () => {
                await api("DELETE", `/scope/edges/${e.id}`);
                toast("Edge removed", { ok: true });
                router();
              }),
          },
          "✕",
        ),
      ]),
    );
  };
  const list =
    outgoing.length || incoming.length
      ? el("ul", { class: "clean" }, [
          ...outgoing.map((e) => edgeRow(e, "out")),
          ...incoming.map((e) => edgeRow(e, "in")),
        ])
      : el("p", { class: "quiet" }, "No connections yet: this ground stands alone on the map.");
  return roLockAll(
    el("section", { class: "card gr-card", "aria-label": "Neighbours" }, [
      panelHead("Neighbours", `${outgoing.length + incoming.length} on the map`, null, {
        kit: "sky",
      }),
      list,
      el("h3", { class: "gr-sub" }, "Add a connection"),
      renderAddEdgeForm(node, allNodes),
    ]),
  );
}
/** An edge read from this node's side: "Contains", "Depends on", "Part of", "Needed by". */
function edgePhrase(relation, dir) {
  const words = String(relation || "").replace(/_/g, " ");
  if (dir === "out") return words.charAt(0).toUpperCase() + words.slice(1);
  if (relation === "contains") return "Part of";
  if (relation === "depends_on") return "Needed by";
  return `${words.charAt(0).toUpperCase() + words.slice(1)} (from)`;
}

function renderAddEdgeForm(node, allNodes) {
  const others = allNodes.filter((n) => n.id !== node.id);
  const target = el("select", {}, [
    el("option", { value: "" }, others.length ? "Select target node…" : "No other nodes"),
    ...others.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  ]);
  const relation = el(
    "select",
    {},
    SCOPE_EDGE_RELATIONS_V1.map((r, i) => el("option", { value: r, selected: i === 0 }, r)),
  );
  const advancedToggle = el("input", { type: "checkbox" });
  const advancedWrap = el("label", { class: "checkbox-line" }, [
    advancedToggle,
    " Advanced relations",
  ]);
  advancedToggle.addEventListener("change", () => {
    clear(relation);
    const rels = advancedToggle.checked
      ? [...SCOPE_EDGE_RELATIONS_V1, ...SCOPE_EDGE_RELATIONS_ADVANCED]
      : SCOPE_EDGE_RELATIONS_V1;
    rels.forEach((r, i) => relation.appendChild(el("option", { value: r, selected: i === 0 }, r)));
  });
  const form = el(
    "form",
    {
      class: "inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        if (!target.value) {
          toast("Pick a target node first");
          return;
        }
        const body = { from_node_id: node.id, to_node_id: target.value, relation: relation.value };
        if (advancedToggle.checked && !SCOPE_EDGE_RELATIONS_V1.includes(relation.value))
          body.advanced = true;
        guard(async () => {
          await api("POST", "/scope/edges", body);
          toast("Connection added", { ok: true });
          router();
        });
      },
    },
    [
      field("Connect to", target),
      field("Relation", relation),
      el("div", { class: "field", style: "flex:0 0 auto" }, [
        el("label", { html: "&nbsp;" }),
        advancedWrap,
      ]),
      el("button", { class: "btn", type: "submit" }, "Add connection"),
    ],
  );
  return form;
}

function renderLinkRepoForm(nodeId) {
  const repoSel = el("select", { required: "" }, [el("option", { value: "" }, "Loading repos…")]);
  guard(async () => {
    const repos = (await api("GET", "/repositories")).repositories || [];
    clear(repoSel);
    repoSel.appendChild(el("option", { value: "" }, "Select a repo…"));
    repos.forEach((r) => repoSel.appendChild(el("option", { value: r.id }, r.name)));
  });
  const relation = el(
    "select",
    {},
    SCOPE_REPO_RELATIONS.map((r) => el("option", { value: r, selected: r === "owns" }, r)),
  );
  const access = el(
    "select",
    {},
    SCOPE_REPO_ACCESS.map((a) => el("option", { value: a, selected: a === "write" }, a)),
  );
  const form = el(
    "form",
    {
      class: "inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        if (!repoSel.value) {
          toast("Pick a repo first");
          return;
        }
        guard(async () => {
          await api("POST", "/scope/repos", {
            scope_node_id: nodeId,
            repo_id: repoSel.value,
            relation: relation.value,
            default_access: access.value,
          });
          toast("Repo linked", { ok: true });
          router();
        });
      },
    },
    [
      field("Repo", repoSel),
      field("Relation", relation),
      field("Access", access),
      el("button", { class: "btn", type: "submit" }, "Link repo"),
    ],
  );
  return form;
}

// --- View: Repo profile (UI-002 / UI-003 / UI-006) --------------------------

async function renderRepo(id) {
  if (!id) return renderFactory();
  const [repos, scopesRes, nodesRes] = await Promise.all([
    // include hidden so a hidden repo's detail page still resolves (and can be un-hidden).
    api("GET", "/repositories?hidden=1"),
    api("GET", `/repos/${id}/scopes`),
    api("GET", "/scope/nodes"),
  ]);
  const repo = (repos.repositories || []).find((r) => r.id === id || r.name === id);
  const scopes = scopesRes.scopes || [];
  const allNodes = nodesRes.nodes || [];

  const wrap = el("div", { class: "view view-ground" });
  wrap.appendChild(backToMap());
  if (!repo) {
    wrap.appendChild(
      emptyState("Repository not found", "It may have been removed or renamed.", "map"),
    );
    return wrap;
  }
  // The repo's tickets: those that deliver to it (the board's write boundary), the
  // same source the Map's "Who plays where" counts from.
  let tickets = null;
  let ticketErr = null;
  try {
    const board = await boardAll();
    tickets = boardCards(board).filter(
      (c) =>
        c.status !== "cancelled" &&
        (c.repos || []).some((r) => r.id === repo.id || r.name === repo.name),
    );
  } catch (e) {
    if (e && e.code === "ABORTED") throw e;
    ticketErr = e;
  }

  setDocTitle("repo", repo.name, id);
  const isMapped = scopes.length > 0;
  const hasWrite = scopes.some((s) => s.default_access === "write");
  const t = tickets ? mapTally(tickets) : null;
  const sortedT = tickets
    ? [...tickets].sort(
        (a, b) =>
          (MAP_TONE_RANK[mapTone(a.status)] ?? 9) - (MAP_TONE_RANK[mapTone(b.status)] ?? 9) ||
          (b.priority || 0) - (a.priority || 0) ||
          (a.number || 0) - (b.number || 0),
      )
    : null;

  const hideBtn = repo.hidden
    ? el(
        "button",
        {
          class: "btn small",
          type: "button",
          "aria-label": `Unhide ${repo.name}`,
          onclick: () =>
            guard(async () => {
              await api("POST", `/repos/${repo.id}/hidden`, { hidden: false });
              toast(`${repo.name} un-hidden`, { ok: true });
              router();
            }),
        },
        "Unhide repo",
      )
    : el(
        "button",
        {
          class: "btn small",
          type: "button",
          "aria-label": `Hide ${repo.name} from the dashboard`,
          title: "Hide this repo from the dashboard (reversible)",
          onclick: () => hideRepoSheet(repo, () => navigate("#/factory")),
        },
        "Hide repo",
      );
  roLock(hideBtn, "repo");

  const lede = t ? groundCountLine(t, { where: "in this repo" }) : null;

  wrap.appendChild(
    el("header", { class: "gr-head" }, [
      el("div", { class: "gr-kit" }, kitShirt(repo.name, 96)),
      el("div", { class: "gr-head-main" }, [
        el("div", { class: "tk-meta" }, [
          el("span", { class: `gr-mapped${isMapped ? "" : " is-off"}` }, [
            glyph(isMapped ? "done" : "draft", 16),
            el(
              "span",
              {},
              isMapped
                ? `On the map · ${scopes.length} ground${scopes.length === 1 ? "" : "s"}`
                : "Not on the map",
            ),
          ]),
          riskBadge(repo.risk_level),
          repo.stack ? el("span", { class: "gr-owner" }, `Stack: ${repo.stack}`) : null,
          repo.hidden ? badge("hidden") : null,
        ]),
        el("h1", { class: "detail-title" }, repo.name),
        lede,
        el("div", { class: "gr-actions" }, [hideBtn]),
      ]),
    ]),
  );
  if (tickets && tickets.length) wrap.appendChild(groundStats(t));

  const branchBtn = el(
    "button",
    {
      class: "btn small",
      type: "button",
      "aria-label": `Edit default branch for ${repo.name}`,
      title:
        "The base branch every delivery worktree branches off. A wrong value fails delivery at worktree setup.",
      onclick: () =>
        valueSheet({
          title: `Default branch for ${repo.name}`,
          intro:
            "The base every delivery worktree branches off. A branch that does not exist fails delivery at worktree setup.",
          label: "Default branch",
          value: repo.default_branch || "main",
          hint: "The branch name as git knows it, such as main or develop.",
          onSave: async (branch) => {
            await api("POST", `/repos/${repo.id}/default-branch`, { default_branch: branch });
            toast(`${repo.name} default branch → ${branch}`, { ok: true });
            router();
          },
        }),
    },
    "Edit",
  );
  roLock(branchBtn, "repo");
  const kvRow = (k, v) => [el("dt", {}, k), el("dd", {}, v)];
  const groundCard = el("section", { class: "card gr-card", "aria-label": "The ground" }, [
    panelHead("The ground", "where the work is done", null, { kit: "claret" }),
    el("dl", { class: "kv gr-kv" }, [
      ...kvRow(
        "Path",
        repo.local_path
          ? el("code", { class: "mono" }, repo.local_path)
          : el("span", { class: "dim" }, "Not set"),
      ),
      ...kvRow(
        "Default branch",
        el("span", { class: "gr-kv-act" }, [
          el("code", { class: "mono" }, repo.default_branch || "main"),
          branchBtn,
        ]),
      ),
      ...kvRow(
        "Remote",
        repo.remote_url
          ? el("code", { class: "mono" }, repo.remote_url)
          : el("span", { class: "dim" }, "None: local only"),
      ),
    ]),
    !isMapped ? renderMapRepoBox(repo, allNodes) : null,
    !hasWrite
      ? el("div", { class: "warn-box gr-warn" }, [
          ycard(22),
          el("p", {}, [
            el("strong", {}, "No write access. "),
            isMapped
              ? "This repo is on the map, but no link grants write access, so agents cannot deliver code to it."
              : "This repo plays on its own (single-repo mode). Put it on the map with write access to use it in factory mode.",
          ]),
        ])
      : null,
  ]);

  const checksCard = el("section", { class: "card gr-card", "aria-label": "Referee's checks" }, [
    panelHead("Referee's checks", "the Definition of Done", null, { kit: "sky" }),
    roLockAll(renderRepoCommandsEditor(repo), "repo"),
  ]);

  const scopeCard = el("section", { class: "card gr-card", "aria-label": "On the map" }, [
    panelHead("On the map", `${scopes.length} ground${scopes.length === 1 ? "" : "s"}`, null, {
      kit: "ink",
    }),
    el(
      "p",
      { class: "gr-note" },
      "Each ground on the Map this repo plays for, with its relation and the access agents inherit. Change access in place; change the relation by re-linking.",
    ),
    scopes.length
      ? el(
          "ul",
          { class: "clean gr-rows" },
          scopes.map((s) => renderRepoScopeRow(repo, s)),
        )
      : el("p", { class: "quiet" }, "Not on the map: this repo is its own single-repo scope."),
    el("h3", { class: "gr-sub" }, "Link to a ground"),
    renderAddAssociationForm(repo, allNodes, scopes),
  ]);

  const ticketCard = el(
    "section",
    { class: "card gr-card", "aria-label": "Results and fixtures" },
    [
      panelHead(
        "Results & fixtures",
        tickets && tickets.length
          ? `${tickets.length > 8 ? `8 of ${tickets.length}` : plural(tickets.length, "ticket")} delivering here, live first`
          : "",
        null,
        { kit: "ink" },
      ),
      tickets
        ? fixtureList(sortedT, { empty: "No ticket delivers to this repo yet." })
        : renderRepoTickets(repo, tickets, ticketErr),
    ],
  );

  wrap.appendChild(
    el("div", { class: "detail-grid" }, [
      el("div", { class: "stack" }, [groundCard, checksCard, scopeCard]),
      el("div", { class: "stack" }, [ticketCard]),
    ]),
  );
  return wrap;
}

function renderRepoScopeRow(repo, s) {
  const accessSel = el(
    "select",
    { class: "access-select", "aria-label": `Default access for ${s.name}` },
    SCOPE_REPO_ACCESS.map((a) => el("option", { value: a, selected: s.default_access === a }, a)),
  );
  accessSel.addEventListener("change", () =>
    guard(async () => {
      await api("PATCH", `/scope/repos/${s.association_id}`, { default_access: accessSel.value });
      toast(`Access set to ${accessSel.value}`, { ok: true });
      router();
    }),
  );
  const relationSel = el(
    "select",
    { class: "access-select", "aria-label": `Relation to ${s.name}` },
    SCOPE_REPO_RELATIONS.map((r) => el("option", { value: r, selected: s.relation === r }, r)),
  );
  relationSel.addEventListener("change", () =>
    guard(async () => {
      await api("DELETE", `/scope/repos/${s.association_id}`);
      await api("POST", "/scope/repos", {
        scope_node_id: s.id,
        repo_id: repo.id,
        relation: relationSel.value,
        default_access: s.default_access,
      });
      toast(`Relation set to ${relationSel.value}`, { ok: true });
      router();
    }),
  );
  // Relation, access and Unlink each change the mapping: a read token's are off.
  return roLockAll(
    el(
      "li",
      {},
      el("div", { class: "assoc-row assoc-row-edit" }, [
        el("div", { class: "assoc-edit-main" }, [
          el("a", { class: "assoc-name", href: `#/node/${s.id}` }, s.name),
          badge(typeLabel(s.type), `type-${s.type}`),
        ]),
        el("div", { class: "assoc-edit-controls" }, [
          el("label", { class: "assoc-edit-field" }, [
            el("span", { class: "assoc-edit-label" }, "relation"),
            relationSel,
          ]),
          el("label", { class: "assoc-edit-field" }, [
            el("span", { class: "assoc-edit-label" }, "access"),
            accessSel,
          ]),
          el(
            "button",
            {
              class: "btn danger small",
              type: "button",
              "aria-label": `Unlink from ${s.name}`,
              onclick: () =>
                confirmSheet({
                  title: `Unlink ${repo.name}`,
                  intro: `${repo.name} is no longer mapped into “${s.name}”. Existing tickets are unaffected.`,
                  confirm: "Unlink",
                  tone: "danger",
                  onConfirm: async () => {
                    await api("DELETE", `/scope/repos/${s.association_id}`);
                    toast("Association removed", { ok: true });
                    router();
                  },
                }),
            },
            "Unlink",
          ),
        ]),
      ]),
    ),
  );
}

function renderMapRepoBox(repo, allNodes) {
  if (!allNodes.length)
    return el("div", { class: "map-repo-box" }, [
      el("strong", {}, "Unmapped. "),
      "Create a scope node on the Map first, then map this repo into it.",
    ]);
  const nodeSel = el(
    "select",
    { "aria-label": "Scope node to map into" },
    allNodes.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  );
  const accessSel = el(
    "select",
    { "aria-label": "Default access" },
    SCOPE_REPO_ACCESS.filter((a) => a !== "none").map((a) =>
      el("option", { value: a, selected: a === "write" }, a),
    ),
  );
  const mapBtn = el(
    "button",
    {
      class: "btn primary small",
      type: "button",
      onclick: () =>
        guard(async () => {
          await api("POST", "/scope/repos", {
            scope_node_id: nodeSel.value,
            repo_id: repo.id,
            relation: "owns",
            default_access: accessSel.value,
          });
          toast("Repo mapped into the Map", { ok: true });
          router();
        }),
    },
    "Map this repo",
  );
  return roLockAll(
    el("div", { class: "map-repo-box" }, [
      el("div", { class: "map-repo-lead" }, [
        el("strong", {}, "This repo is unmapped. "),
        "Map it into a scope node to coordinate it in factory mode. Existing tickets are not affected.",
      ]),
      el("div", { class: "map-repo-controls" }, [
        el("label", { class: "assoc-edit-field" }, [
          el("span", { class: "assoc-edit-label" }, "into node"),
          nodeSel,
        ]),
        el("label", { class: "assoc-edit-field" }, [
          el("span", { class: "assoc-edit-label" }, "access"),
          accessSel,
        ]),
        mapBtn,
      ]),
    ]),
  );
}

function renderRepoTickets(repo, tickets, err) {
  const box = el("div", { class: "repo-tickets" });
  if (!tickets) {
    box.appendChild(
      el(
        "p",
        { class: "quiet" },
        `Recent tickets unavailable${err && err.code ? ` (${err.code})` : ""}.`,
      ),
    );
    return box;
  }
  if (!tickets.length) {
    box.appendChild(el("p", { class: "quiet" }, "No tickets reference this repo yet."));
    return box;
  }
  const recent = [...tickets]
    .sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")))
    .slice(0, 8);
  box.appendChild(
    el(
      "ul",
      { class: "clean repo-ticket-list" },
      recent.map((t) =>
        el(
          "li",
          {},
          el("a", { class: "repo-ticket-row", href: `#/ticket/${t.id}` }, [
            el("span", { class: "num" }, t.number != null ? `#${t.number}` : t.id.slice(0, 8)),
            el("span", { class: "repo-ticket-title" }, t.title),
            el("span", { class: "repo-ticket-side" }, [
              statusBadge(t.status, t.landing_state),
              el(
                "time",
                { class: "repo-ticket-time", datetime: t.updated_at },
                fmtTime(t.updated_at),
              ),
            ]),
          ]),
        ),
      ),
    ),
  );
  if (tickets.length > recent.length) {
    box.appendChild(
      el("p", { class: "repo-ticket-more" }, [
        `${tickets.length - recent.length} more on the `,
        el("a", { href: "#/work" }, "Work board"),
        ".",
      ]),
    );
  }
  return box;
}

function renderAddAssociationForm(repo, allNodes, existing) {
  const nodeSel = el("select", { required: "" }, [
    el("option", { value: "" }, allNodes.length ? "Select a scope node…" : "No scope nodes yet"),
    ...allNodes.map((n) => el("option", { value: n.id }, `${n.name} (${typeLabel(n.type)})`)),
  ]);
  const relation = el(
    "select",
    {},
    SCOPE_REPO_RELATIONS.map((r) => el("option", { value: r, selected: r === "owns" }, r)),
  );
  const access = el(
    "select",
    {},
    SCOPE_REPO_ACCESS.map((a) => el("option", { value: a, selected: a === "write" }, a)),
  );
  const form = el(
    "form",
    {
      class: "inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        if (!nodeSel.value) {
          toast("Pick a scope node first");
          return;
        }
        const dup = existing.some((s) => s.id === nodeSel.value && s.relation === relation.value);
        if (dup) {
          toast(`Already linked to that node with relation “${relation.value}”.`);
          return;
        }
        guard(async () => {
          await api("POST", "/scope/repos", {
            scope_node_id: nodeSel.value,
            repo_id: repo.id,
            relation: relation.value,
            default_access: access.value,
          });
          toast("Linked to scope node", { ok: true });
          router();
        });
      },
    },
    [
      field("Scope node", nodeSel),
      field("Relation", relation),
      field("Access", access),
      el("button", { class: "btn", type: "submit" }, "Add association"),
    ],
  );
  return roLockAll(form);
}

// ===========================================================================
//  Epics — epic scope nodes + their tickets as a phased, dependency-aware board
// ===========================================================================
//
// An epic is a scope node of type "epic" that `contains` its tickets. There is
// no "tickets-for-epic" endpoint, so the view stitches the tree from the
// existing surfaces: GET /scope/nodes (the epics), GET /tickets (the universe),
// and GET /tickets/details (each ticket's `scopes` → epic membership, plus its
// `dependencies` → the "blocked by #N" edges). Tickets are grouped into phases
// by their dependency depth so the build order reads top-to-bottom.

/**
 * Assign each ticket a phase = longest dependency chain to a root, computed over
 * the epic's own tickets only. Phase 0 = no in-epic dependencies (e.g. the
 * bootstrap ticket); each subsequent phase hard-waits on the one before it.
 */
function computePhases(tickets, depsById) {
  const inEpic = new Set(tickets.map((t) => t.id));
  const memo = new Map();
  const visiting = new Set();
  const depth = (id) => {
    if (memo.has(id)) return memo.get(id);
    if (visiting.has(id)) return 0; // defensive: cycles are rejected server-side
    visiting.add(id);
    const deps = (depsById.get(id) || []).filter((d) => inEpic.has(d));
    const d = deps.length ? 1 + Math.max(...deps.map(depth)) : 0;
    visiting.delete(id);
    memo.set(id, d);
    return d;
  };
  const byPhase = new Map();
  for (const t of tickets) {
    const p = depth(t.id);
    if (!byPhase.has(p)) byPhase.set(p, []);
    byPhase.get(p).push(t);
  }
  return byPhase;
}

/** The epic's acceptance ticket (its Final): flagged by the server, or named so. */
function isAcceptanceTicket(t) {
  return !!(
    t &&
    (t.acceptance === 1 || t.acceptance === true || /^Acceptance/i.test(t.title || ""))
  );
}

/**
 * The acceptance ticket is always the Final: it takes a round of its own after
 * every other round, whatever its dependency depth says (an acceptance ticket
 * whose edges were never drawn would otherwise share a round with the work).
 */
function pinAcceptanceLast(byPhase) {
  const keys = [...byPhase.keys()].sort((a, b) => a - b);
  if (keys.length === 0) return byPhase;
  const moved = [];
  for (const k of keys) {
    const list = byPhase.get(k);
    moved.push(...list.filter(isAcceptanceTicket));
    const rest = list.filter((t) => !isAcceptanceTicket(t));
    if (rest.length) byPhase.set(k, rest);
    else byPhase.delete(k);
  }
  if (moved.length) {
    const left = [...byPhase.keys()];
    byPhase.set(left.length ? Math.max(...left) + 1 : 0, moved);
  }
  return byPhase;
}

/** Why a held ticket is held, in the ticket page's own words (its lede, minus the status word). */
function heldReason(t, detail) {
  if (!detail) return [];
  const parts = ticketLede(t, detail.rework_trail || [], detail.events || []);
  return parts.slice(1).filter((p) => typeof p === "string");
}

/** A small red card (held) for a block heading or a table cell: always next to words. */
function redCard(size = 16) {
  return svgEl(
    "svg",
    {
      viewBox: "0 0 12 16",
      width: (size * 0.75).toFixed(1),
      height: size,
      class: "rcard",
      "aria-hidden": "true",
      focusable: "false",
    },
    svgEl("rect", {
      x: 1,
      y: 1,
      width: 10,
      height: 14,
      rx: 1.4,
      fill: "var(--red)",
      stroke: "var(--ycard-edge)",
      "stroke-width": 1.2,
    }),
  );
}

const NEEDS_SIGN_OFF = new Set(["in_review", "ready_for_merge"]);

async function renderEpics(param) {
  // A deep link (#/epics/:nodeId) scrolls to that campaign.
  const focusId = param || null;
  const signal = routeSignal();
  // Claims (who wears which ticket) and specs (what a campaign is played to) are
  // extras: the season still reads without them.
  const extra = (p, fallback) =>
    api("GET", p, undefined, { signal }).catch((e) => {
      if (e && e.code === "ABORTED") throw e;
      return fallback;
    });
  const [nodesRes, ticketsRes, claimsRes, specsRes] = await Promise.all([
    api("GET", "/scope/nodes", undefined, { signal }),
    allTickets("", { signal }),
    extra("/claims", { claims: [] }),
    extra("/specs", { specs: [] }),
    ensureSquad(),
  ]);
  const epics = (nodesRes.nodes || []).filter((n) => n.type === "epic");
  const tickets = ticketsRes.tickets || [];
  const planBtn = roLock(
    el("button", { class: "btn primary", type: "button", onclick: () => openPlanBuild() }, [
      icon("spark"),
      el("span", {}, "Plan a build"),
    ]),
  );
  // Authoring a spec lives on Specs; the season links there.
  const specsLink = el("a", { class: "btn", href: "#/specs" }, "Specs");
  const wrap = el("div", { class: "view view-epics" });

  if (epics.length === 0) {
    wrap.dataset.sig = "empty";
    wrap.appendChild(viewHead("The season", "No campaigns yet", [specsLink, planBtn]));
    wrap.appendChild(
      emptyState(
        "No campaigns on the fixture list.",
        "Describe what to build in plain words: Plan a build proposes the draw (draft tickets, round by round), and the campaign lands here once you confirm it.",
        null,
        roLock(
          el("button", { class: "btn primary", type: "button", onclick: () => openPlanBuild() }, [
            icon("spark"),
            el("span", {}, "Plan a build"),
          ]),
        ),
      ),
    );
    return wrap;
  }

  // Membership + dependencies come from each ticket's detail (cached by updated_at).
  const detailById = await ticketDetails(
    tickets.filter((t) => t.status !== "cancelled"),
    signal,
  );
  // A held member's line says why (its rework trail and events): read those in full.
  const heldFull = await ticketDetails(
    tickets.filter((t) => OFF_PITCH.has(t.status)),
    signal,
    DETAIL_FULL,
  );
  for (const [k, v] of heldFull) detailById.set(k, v);
  const membersByEpic = new Map(epics.map((e) => [e.id, []]));
  const depsById = new Map();
  const depViewById = new Map();
  const repoByTicket = new Map();
  for (const t of tickets) {
    const detail = detailById.get(t.id);
    if (!detail) continue;
    const deps = detail.dependencies || [];
    depsById.set(
      t.id,
      deps.map((d) => d.depends_on_ticket_id),
    );
    depViewById.set(t.id, deps);
    const repos = detail.repositories || [];
    const repoW = repos.find((r) => r.access === "write") || repos[0];
    if (repoW) repoByTicket.set(t.id, repoW.name);
    for (const sc of detail.scopes || []) {
      if (membersByEpic.has(sc.id)) membersByEpic.get(sc.id).push({ ...t, ...detail.ticket });
    }
  }
  const agentByTicket = new Map();
  for (const c of (claimsRes && claimsRes.claims) || []) {
    if (c.status && c.status !== "active") continue;
    agentByTicket.set(c.ticket_id, agentWho(c.agent_id, c.agent_display_name));
  }

  // A campaign played to a spec: the spec names the epic as its scope node.
  const specByEpic = new Map();
  for (const s of (specsRes && specsRes.specs) || []) {
    if (s.scope_node_id && membersByEpic.has(s.scope_node_id) && !specByEpic.has(s.scope_node_id))
      specByEpic.set(s.scope_node_id, { spec: s, rollup: null });
  }
  await Promise.all(
    [...specByEpic.values()].map((v) =>
      extra(`/specs/${encodeURIComponent(v.spec.id)}/coverage`, null).then((r) => {
        v.rollup = specCoverageRollup(r && r.coverage);
        v.gaps = specGapCount(r && r.coverage, v.spec.status);
      }),
    ),
  );

  const ctx = { depsById, depViewById, detailById, repoByTicket, agentByTicket };
  const seasons = epics.map((epic) => campaignFacts(epic, membersByEpic.get(epic.id) || [], ctx));

  // Same data → same signature → the refresh leaves the page (and its open folds) alone.
  wrap.dataset.sig = hashText(
    JSON.stringify([
      epics.map((e) => [e.id, e.name, e.description || ""]),
      seasons.map((s) =>
        s.members.map((m) => [
          m.id,
          m.status,
          m.title,
          agentTitle(agentByTicket.get(m.id) || { name: "" }),
          (depViewById.get(m.id) || []).map((d) => `${d.depends_on_ticket_id}:${d.satisfied}`),
        ]),
      ),
      [...specByEpic.entries()].map(([k, v]) => [k, v.spec.id, v.spec.status, v.rollup, v.gaps]),
    ]),
  );

  const allMembers = seasons.flatMap((s) => s.members);
  const heldN = seasons.filter((s) => s.held.length).length;
  const doneN = allMembers.filter((m) => m.status === "done").length;
  wrap.appendChild(
    viewHead(
      "The season",
      `${plural(epics.length, "campaign")} · ${heldN ? `${heldN} held` : "none held"} · ${doneN} of ${plural(allMembers.length, "ticket")} done`,
      [specsLink, planBtn],
    ),
  );
  if (seasons.length > 1) wrap.appendChild(seasonTable(seasons));

  const list = el("div", { class: "epic-list" });
  for (const s of seasons)
    list.appendChild(renderEpicCard(s, ctx, specByEpic.get(s.epic.id), focusId === s.epic.id));
  wrap.appendChild(list);

  // The draw's bracket lines are measured once the page is laid out, and again
  // whenever a draw changes size (fonts landing, a resize, a fold opening).
  let ro = null;
  wrap._mounted = () => {
    const draws = [...wrap.querySelectorAll(".ep-draw")];
    draws.forEach(drawEpicLines);
    if (typeof window.ResizeObserver === "function") {
      ro = new window.ResizeObserver((entries) => {
        for (const e of entries) drawEpicLines(e.target);
      });
      draws.forEach((d) => ro.observe(d));
    }
    if (document.fonts && document.fonts.ready)
      document.fonts.ready.then(() => draws.forEach(drawEpicLines)).catch(() => {});
    // After the router's scroll-to-top, not before it.
    if (focusId) setTimeout(() => jumpTo(`epic-${focusId}`), 0);
  };
  wrap._dispose = () => {
    if (ro) ro.disconnect();
    ro = null;
  };
  return wrap;
}

/** Everything one campaign's page and its table row say, computed once. */
function campaignFacts(epic, members, ctx) {
  const byPhase = pinAcceptanceLast(computePhases(members, ctx.depsById));
  const phases = [...byPhase.keys()].sort((a, b) => a - b);
  const done = members.filter((m) => m.status === "done").length;
  const held = members
    .filter((m) => OFF_PITCH.has(m.status))
    .sort((a, b) => (a.number || 0) - (b.number || 0));
  const heldIds = new Set(held.map((m) => m.id));
  const waits = members.filter(
    (m) => m.status !== "done" && (ctx.depsById.get(m.id) || []).some((d) => heldIds.has(d)),
  );
  const needs = members.filter((m) => NEEDS_SIGN_OFF.has(m.status));
  // Next fixture: a ready ticket that can actually be claimed, i.e. every ticket
  // it waits on is done (the server refuses a claim with DEPENDENCY_BLOCKED otherwise).
  const nextUp = members.filter(
    (m) => m.status === "ready" && (ctx.depViewById.get(m.id) || []).every((d) => d.satisfied),
  );
  const liveIdx = phases.findIndex((p) => (byPhase.get(p) || []).some((t) => t.status !== "done"));
  const won = members.length > 0 && done === members.length;
  return {
    epic,
    members,
    byPhase,
    phases,
    done,
    held,
    heldIds,
    waits,
    needs,
    nextUp,
    liveIdx,
    won,
  };
}

/** "#8, #9 and #10" */
function ticketList(ts) {
  const ns = ts.map((t) => `#${t.number}`);
  return ns.length > 1 ? `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}` : ns[0] || "";
}

/** The table: one line per campaign — its rounds, how far it has got, what holds it. */
function seasonTable(seasons) {
  const rows = seasons.map((s) => {
    const name = s.epic.name;
    const where = s.held.length
      ? el("span", { class: "ep-where is-red" }, [
          redCard(16),
          el("span", {}, [
            "Held at ",
            el(
              "a",
              { href: `#/ticket/${s.held[0].id}`, title: s.held[0].title },
              `#${s.held[0].number}`,
            ),
            s.waits.length
              ? ` · ${ticketList(s.waits)} ${s.waits.length === 1 ? "waits" : "wait"}`
              : "",
          ]),
        ])
      : s.needs.length
        ? el("span", { class: "ep-where" }, [
            ycard(16),
            el("span", {}, [
              el("a", { href: `#/review/${s.needs[0].id}` }, `#${s.needs[0].number}`),
              s.needs[0].status === "in_review"
                ? " waits for your sign-off"
                : " waits for the merge",
            ]),
          ])
        : el(
            "span",
            { class: "ep-where" },
            s.won
              ? [glyph("done", 16), el("span", {}, "Won")]
              : !s.members.length
                ? "No tickets yet"
                : s.nextUp.length
                  ? [
                      glyph("ready", 16),
                      el("span", {}, [
                        "Next: ",
                        el(
                          "a",
                          { href: `#/ticket/${s.nextUp[0].id}`, title: s.nextUp[0].title },
                          `#${s.nextUp[0].number}`,
                        ),
                      ]),
                    ]
                  : [glyph("in_progress", 16), el("span", {}, "In play")],
          );
    const roundsLabel = s.phases.length
      ? s.won
        ? `All ${s.phases.length} rounds won`
        : `Round ${s.liveIdx + 1} of ${s.phases.length}`
      : "No rounds";
    return el("tr", { class: s.held.length ? "is-held" : "" }, [
      el(
        "th",
        { scope: "row", class: "ep-t-name" },
        el("a", { href: `#epic-${s.epic.id}`, title: name }, name),
      ),
      el("td", { class: "ep-t-rounds" }, [
        el(
          "span",
          { class: "ep-mini", role: "img", "aria-label": roundsLabel },
          s.phases.map((p, i) => {
            const tix = s.byPhase.get(p) || [];
            const d = tix.filter((t) => t.status === "done").length;
            const isHeld = tix.some((t) => s.heldIds.has(t.id));
            return el("i", {
              class: isHeld
                ? "is-held"
                : d === tix.length
                  ? "is-won"
                  : i === s.liveIdx
                    ? "is-live"
                    : "",
              style: { "--p": `${tix.length ? Math.round((d / tix.length) * 100) : 0}%` },
            });
          }),
        ),
        el("span", { class: "ep-t-sub", "aria-hidden": "true" }, roundsLabel),
      ]),
      el("td", { class: "ep-t-num tabnum" }, `${s.done}/${s.members.length}`),
      el("td", { class: "ep-t-where" }, where),
    ]);
  });
  return progPage("ep-table", "claret", "The table", `${plural(seasons.length, "campaign")}`, [
    el("div", { class: "ep-table-scroll" }, [
      el("table", { class: "ep-season" }, [
        el(
          "caption",
          { class: "sr-only" },
          "Every campaign: its rounds, tickets done and what holds it",
        ),
        el("thead", {}, [
          el("tr", {}, [
            el("th", { scope: "col" }, "Campaign"),
            el("th", { scope: "col" }, "Rounds"),
            el("th", { scope: "col", class: "ep-t-num" }, "Done"),
            el("th", { scope: "col" }, "Where it stands"),
          ]),
        ]),
        el("tbody", {}, rows),
      ]),
    ]),
  ]);
}

/**
 * One campaign: a programme page. The sky block carries its name and how far it
 * has got (a red card when a ticket holds it); then what holds it and the one
 * thing to do about it, the brief, the spec it is played to, the draw (every
 * ticket, round by round, joined by bracket lines), and the next fixture.
 */
function renderEpicCard(s, ctx, specLink, focused) {
  const { epic, members, byPhase, phases, done, held, waits, needs, nextUp, liveIdx, won } = s;
  const aux = members.length
    ? `${won ? "all rounds won" : `round ${liveIdx + 1} of ${phases.length}`} · ${done} of ${members.length} done`
    : "no tickets";
  const head = panelHead(
    epic.name,
    aux,
    { text: "On the map", href: `#/node/${epic.id}` },
    { kit: "sky", level: "h2" },
  );
  if (held.length)
    head.appendChild(el("span", { class: "ep-flag" }, [redCard(22), el("span", {}, "Held")]));
  else if (needs.length)
    head.appendChild(el("span", { class: "ep-flag" }, [ycard(22), el("span", {}, "Needs you")]));
  else if (won) head.appendChild(el("span", { class: "ep-flag" }, [glyph("done", 20), "Won"]));

  const card = el("article", {
    class: `card epic-card campaign${held.length ? " is-held" : ""}${focused ? " card-accent" : ""}`,
    id: `epic-${epic.id}`,
    "aria-labelledby": `epic-h-${epic.id}`,
  });
  head.querySelector(".panel-title").id = `epic-h-${epic.id}`;
  card.appendChild(head);

  if (members.length === 0) {
    if (epic.description) card.appendChild(el("p", { class: "epic-desc" }, epic.description));
    card.appendChild(el("p", { class: "ep-lede" }, "This campaign has no tickets yet."));
    return card;
  }

  // Where it stands, in one sentence from the data, with the one thing to do.
  const h = held[0];
  const lede = held.length
    ? el("div", { class: "ep-stands is-held" }, [
        el("p", { class: "ep-lede" }, [
          el("b", { class: "is-red" }, [
            glyph("blocked", 18),
            " Held at ",
            el("a", { href: `#/ticket/${h.id}` }, `#${h.number}`),
            ".",
          ]),
          " ",
          el("span", { class: "ep-held-t" }, `“${h.title}”`),
          " ",
          ...heldReason(h, ctx.detailById.get(h.id)),
          waits.length
            ? ` ${ticketList(waits)} ${waits.length === 1 ? "waits" : "wait"} on it.`
            : "",
          held.length > 1
            ? ` ${held.length - 1} more ${held.length === 2 ? "is" : "are"} off the pitch.`
            : "",
        ]),
        el("div", { class: "btn-row" }, [
          h.status === "blocked"
            ? el(
                "button",
                {
                  class: "btn",
                  type: "button",
                  onclick: () =>
                    unblockSheet(h, {
                      reason: heldReason(h, ctx.detailById.get(h.id)).join("").trim(),
                    }),
                },
                `Unblock #${h.number}…`,
              )
            : null,
          el("a", { class: "btn quiet", href: `#/ticket/${h.id}` }, `Open #${h.number}`),
        ]),
      ])
    : el(
        "p",
        { class: "ep-lede" },
        needs.length
          ? [
              ycard(16),
              " ",
              el("a", { href: `#/review/${needs[0].id}` }, `#${needs[0].number}`),
              needs[0].status === "in_review"
                ? " waits for your sign-off."
                : " is approved and waits for the merge.",
              needs.length > 1 ? ` ${needs.length - 1} more after it.` : "",
              " Nothing is holding the campaign.",
            ]
          : won
            ? "Won: every ticket is done, the Final included."
            : benchedCampaignLine(members)
              ? [
                  benchedCampaignLine(members),
                  " ",
                  el("a", { href: "#/work?status=draft" }, "Ready them on the Work board"),
                  ` to start round ${liveIdx + 1}.`,
                ]
              : `Round ${liveIdx + 1} of ${phases.length} is being played. Nothing is holding it.`,
      );
  card.appendChild(lede);
  if (epic.description) card.appendChild(el("p", { class: "epic-desc" }, epic.description));
  if (specLink) {
    const { spec, rollup, gaps } = specLink;
    card.appendChild(
      el("p", { class: "ep-spec" }, [
        "Played to the spec ",
        el("a", { href: `#/specs/${encodeURIComponent(spec.id)}` }, `“${spec.title}”`),
        ` (${(SPEC_STATUS_LABEL[spec.status] || spec.status || "").toLowerCase()})`,
        rollup && rollup.total
          ? `: ${rollup.covered} of ${plural(rollup.total, "clause")} covered${gaps ? `, ${plural(gaps, "gap")}` : ""}.`
          : ".",
      ]),
    );
  }

  const draw = renderEpicDag(byPhase, phases, { ...ctx, heldIds: s.heldIds, epicName: epic.name });
  const next = el("p", { class: "epic-next" }, [
    el("b", {}, "Next fixture: "),
    nextUp.length
      ? nextUp.flatMap((t, i) => [
          i ? ", " : "",
          el("a", { href: `#/ticket/${t.id}` }, `#${t.number} ${t.title}`),
        ])
      : held.length
        ? "nothing can be claimed until the hold is cleared."
        : won
          ? "none: the campaign is won."
          : (() => {
              // Ready, but waiting on unfinished work: say who, not "nothing is ready".
              const waiting = members.filter((m) => m.status === "ready");
              return waiting.length
                ? `nothing can be claimed yet: ${ticketList(waiting)} ${waiting.length === 1 ? "waits" : "wait"} on unfinished work.`
                : "nothing is ready to claim.";
            })(),
  ]);
  if (won) {
    // A won campaign keeps its page short: the draw folds away.
    card.appendChild(
      el("details", { class: "ep-fold" }, [
        el("summary", {}, `Show the draw (${plural(members.length, "ticket")})`),
        draw,
      ]),
    );
  } else {
    card.appendChild(draw);
    card.appendChild(next);
  }
  return card;
}

/** A round's name: the last round is the Final when it holds the acceptance ticket. */
function epicRoundName(byPhase, phases, i) {
  const p = phases[i];
  return i === phases.length - 1 && i > 0 && (byPhase.get(p) || []).some(isAcceptanceTicket)
    ? "Final"
    : `Round ${i + 1}`;
}

/**
 * The draw: one mown lane per round (a column at desktop, stacked on a phone),
 * every ticket a fixture card in its round, ordered so the bracket lines cross
 * as little as they can. The lines (drawn by drawEpicLines once laid out) join
 * each ticket to what it waits on: solid when met, dashed when not, red dashed
 * out of a held ticket.
 */
function renderEpicDag(byPhase, phases, ctx) {
  const { depViewById, agentByTicket, repoByTicket, heldIds } = ctx;
  const rowOf = new Map();
  const cols = phases.map((p, ci) => {
    const tix = (byPhase.get(p) || []).slice();
    const bary = (t) => {
      const ys = (depViewById.get(t.id) || [])
        .map((d) => rowOf.get(d.depends_on_ticket_id))
        .filter((y) => y != null);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity;
    };
    tix.sort((a, b) =>
      ci === 0
        ? (a.number || 0) - (b.number || 0)
        : bary(a) - bary(b) || (a.number || 0) - (b.number || 0),
    );
    tix.forEach((t, i) => rowOf.set(t.id, i));
    return tix;
  });

  const edges = [];
  const tie = (t) => {
    const deps = depViewById.get(t.id) || [];
    const blockers = deps.filter((d) => !d.satisfied);
    for (const d of deps) {
      if (!rowOf.has(d.depends_on_ticket_id)) continue;
      edges.push({
        from: d.depends_on_ticket_id,
        to: t.id,
        cls: heldIds.has(d.depends_on_ticket_id) ? "held" : d.satisfied ? "sat" : "pend",
      });
    }
    const agent = agentByTicket.get(t.id);
    const repo = repoByTicket.get(t.id);
    const needs = NEEDS_SIGN_OFF.has(t.status);
    const waitsOnHeld = blockers.some((b) => heldIds.has(b.depends_on_ticket_id));
    const label = [
      `#${t.number} ${statusLabel(t.status, t.landing_state)}: ${t.title}`,
      repo ? `in ${repo}` : "",
      agent ? `${agent.name} on it` : "",
      needs ? (t.status === "in_review" ? "waits for your sign-off" : "waits for the merge") : "",
      blockers.length ? `waiting on ${blockers.map((b) => "#" + b.number).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return el(
      "a",
      {
        class: `dag-node status-${t.status}${isAcceptanceTicket(t) ? " is-final" : ""}`,
        href: `#/ticket/${t.id}`,
        title: t.title,
        "aria-label": label,
        dataset: { id: t.id },
      },
      [
        el("span", { class: "dn-top" }, [
          el("span", { class: "dn-num" }, t.number != null ? `#${t.number}` : "—"),
          needs ? ycard(16) : null,
          statusBadge(t.status, t.landing_state),
        ]),
        el("span", { class: "dn-title" }, t.title),
        el("span", { class: "dn-foot" }, [
          repo
            ? el("span", { class: "dn-repo" }, [kitShirt(repo, 16), el("span", {}, repo)])
            : null,
          agent
            ? el("span", { class: "dn-agent", title: agentTitle(agent) }, [
                agentShirt(agent.name, 22, agent.no),
                el("span", {}, agent.no || agent.name),
              ])
            : null,
          blockers.length
            ? el("span", { class: `dn-block${waitsOnHeld ? " is-red" : ""}` }, [
                waitsOnHeld ? glyph("blocked", 12) : icon("clock", "dn-block-ico", 12),
                `waits on ${blockers.map((b) => (b.number != null ? "#" + b.number : "?")).join(", ")}`,
              ])
            : null,
        ]),
      ],
    );
  };

  const rounds = phases.map((p, ci) => {
    const tix = cols[ci];
    const name = epicRoundName(byPhase, phases, ci);
    const done = tix.filter((t) => t.status === "done").length;
    const isHeld = tix.some((t) => heldIds.has(t.id));
    return el(
      "section",
      {
        class: `ep-round${name === "Final" ? " is-final" : ""}${isHeld ? " is-held" : ""}`,
        "aria-label": `${name}: ${done} of ${tix.length} done`,
      },
      [
        el("header", { class: "ep-round-head" }, [
          el("h3", { class: "ep-round-name" }, name),
          el(
            "span",
            { class: "ep-round-frac tabnum", "aria-hidden": "true" },
            `${done}/${tix.length}`,
          ),
          el(
            "span",
            { class: "ep-round-bar", "aria-hidden": "true" },
            el("i", {
              style: { width: `${tix.length ? Math.round((done / tix.length) * 100) : 0}%` },
            }),
          ),
        ]),
        el(
          "ol",
          { class: "ep-ties" },
          tix.map((t) => el("li", {}, tie(t))),
        ),
      ],
    );
  });

  const lines = svgEl("svg", { class: "ep-lines", "aria-hidden": "true", focusable: "false" });
  const draw = el("div", { class: "ep-draw", style: { "--rounds": String(phases.length) } }, [
    lines,
    ...rounds,
  ]);
  draw._edges = edges;
  return el(
    "div",
    {
      class: "ep-draw-scroll",
      role: "region",
      "aria-label": `${ctx.epicName || "Campaign"}: the draw`,
      tabindex: phases.length >= 6 ? "0" : undefined,
    },
    draw,
  );
}

/**
 * Draw the bracket lines of one draw from where its cards actually are. Each
 * line leaves the right edge of the ticket waited on, turns at the lane edge of
 * the waiting ticket's round, and enters its left edge. Rounds that stack (a
 * phone) carry "waits on #N" on the cards instead, and no lines.
 */
function drawEpicLines(draw) {
  const svg = draw && draw.querySelector(".ep-lines");
  if (!svg || !draw.isConnected) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const rounds = [...draw.querySelectorAll(".ep-round")];
  const box = draw.getBoundingClientRect();
  const side =
    rounds.length > 1 &&
    Math.abs(rounds[0].getBoundingClientRect().top - rounds[1].getBoundingClientRect().top) < 2 &&
    box.width > 0;
  svg.style.display = side ? "" : "none";
  if (!side) return;
  const w = Math.round(draw.scrollWidth),
    h = Math.round(draw.scrollHeight);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  const nodeOf = new Map([...draw.querySelectorAll(".dag-node")].map((n) => [n.dataset.id, n]));
  const roundOf = (n) => n.closest(".ep-round");
  const order = { sat: 0, pend: 1, held: 2 };
  const edges = (draw._edges || []).filter((e) => nodeOf.has(e.from) && nodeOf.has(e.to));
  const midY = (n) => {
    const r = n.getBoundingClientRect();
    return r.top + Math.min(r.height / 2, 28) - box.top;
  };
  // Lines that leave one card, or enter one, fan out a few pixels apart (ordered
  // by where the other end is), so two lines never share a segment: a met line
  // under an unmet one would read as met.
  const FAN = 6;
  const fan = (key, other) => {
    const groups = new Map();
    for (const e of edges) {
      const k = e[key];
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }
    const off = new Map();
    for (const list of groups.values()) {
      list.sort((p, q) => midY(nodeOf.get(p[other])) - midY(nodeOf.get(q[other])));
      list.forEach((e, i) => off.set(e, (i - (list.length - 1) / 2) * FAN));
    }
    return off;
  };
  const outOff = fan("from", "to");
  const inOff = fan("to", "from");
  // Each straight run is its own path whose dashes are phased to the page, not to
  // the path, so where two dashed runs still overlap their dashes coincide.
  const period = { pend: 8, held: 12 };
  const seg = (cls, xa, ya, xb, yb) => {
    const horiz = Math.abs(ya - yb) < 0.5;
    const lo = horiz ? Math.min(xa, xb) : Math.min(ya, yb);
    const hi = horiz ? Math.max(xa, xb) : Math.max(ya, yb);
    if (hi - lo < 0.5) return;
    const d = horiz
      ? `M${lo.toFixed(1)} ${ya.toFixed(1)} H${hi.toFixed(1)}`
      : `M${xa.toFixed(1)} ${lo.toFixed(1)} V${hi.toFixed(1)}`;
    const attrs = { class: `edge ${cls}`, d };
    if (period[cls]) attrs["stroke-dashoffset"] = (lo % period[cls]).toFixed(1);
    svg.appendChild(svgEl("path", attrs));
  };
  for (const e of edges.slice().sort((a, b) => order[a.cls] - order[b.cls])) {
    const a = nodeOf.get(e.from),
      b = nodeOf.get(e.to);
    const ra = a.getBoundingClientRect(),
      rb = b.getBoundingClientRect(),
      lane = roundOf(b).getBoundingClientRect();
    const x1 = ra.right - box.left,
      y1 = midY(a) + (outOff.get(e) || 0),
      x2 = rb.left - box.left,
      y2 = midY(b) + (inOff.get(e) || 0);
    if (x2 <= x1) continue;
    const xm = Math.max(x1 + 6, Math.min(x2 - 6, lane.left - box.left));
    seg(e.cls, x1, y1, xm, y1);
    seg(e.cls, xm, y1, xm, y2);
    seg(e.cls, xm, y2, x2, y2);
  }
}

// ===========================================================================
//  Plan a build — the decompose chat panel (a docked, mobile-first sheet)
// ===========================================================================
//
// One-line brief → POST /plan-build → the backend spawns the decompose helper →
// it answers with a clarify turn (questions), a plan (proposed epic + tickets),
// or an error. The FRONTEND accumulates the conversation `history` and replays
// it each turn. A plan is PROPOSED ONLY — "Create these tickets" is the human's
// explicit confirm, which POSTs the plan to /epics and lands DRAFT tickets.

// The conversation no longer dead-ends client-side: a long chat is never blocked.
// "Build the tickets" (forcePlan) is always available so the user can break out at
// any point, and the decomposer's own advisory turn ceiling force-plans rather than
// rejecting — see PLAN_BUILD_FORCE_EMPHASIS_TURNS for when the escape is emphasised.

// H9 — DURABLE SESSIONS: the panel persists its conversation to the server via
// /plan-sessions so a reload or navigation-away restores the exact history +
// proposed plan. Each turn calls POST /plan-sessions/:id/turns to append both
// the user message and the assistant reply. On first open the panel fetches
// GET /plan-sessions/active to restore any in-progress session. "Start new plan"
// archives the current session (POST /plan-sessions/:id/archive, status:abandoned)
// and creates a fresh one. Confirming a plan archives with status:confirmed.
//
// GRACEFUL DEGRADATION: every session API call is best-effort. If the endpoint
// is unreachable (older server, network blip) the panel continues with in-memory
// state exactly as before H9 — `planBuildState.sessionId` stays null and no
// persistence calls are attempted for that session.

let planBuildEls = null;
let planBuildState = null;

function ensurePlanBuild() {
  if (planBuildEls) return planBuildEls;
  const scrim = el("div", { class: "pb-scrim", onclick: closePlanBuild });
  const log = el("div", { class: "pb-log", role: "log", "aria-live": "polite" });
  const input = el("textarea", {
    class: "pb-input",
    rows: "1",
    placeholder: "Describe the app you want to build…",
    "aria-label": "Your message",
  });
  const sendBtn = el(
    "button",
    { class: "btn pb-send", type: "submit", "aria-label": "Send" },
    icon("send"),
  );
  // "Build the tickets now" escape: forces the decomposer to emit a plan from the
  // brief + answers so far. Always visible so the user is NEVER stuck clarifying;
  // it gets emphasised once the conversation runs several turns deep (see render).
  const forceBtn = el(
    "button",
    {
      class: "btn primary pb-force",
      type: "button",
      "aria-label": "Build the tickets now from what you've told me",
      onclick: () => submitPlanBuildTurn({ forcePlan: true }),
    },
    [icon("check"), el("span", {}, "Build the tickets")],
  );
  const actions = el("div", { class: "pb-actions" }, [
    forceBtn,
    el("span", { class: "pb-keys" }, "Enter sends · Shift+Enter for a new line"),
    sendBtn,
  ]);
  const form = el("form", { class: "pb-composer" }, [input, actions]);
  const titleEl = el("div", { class: "pb-title" }, "Plan a build");
  const subEl = el("div", { class: "pb-sub" }, "Your brief → the planner's questions → the draw");
  const closeBtn = el(
    "button",
    { class: "icon-btn pb-close", type: "button", "aria-label": "Close", onclick: closePlanBuild },
    icon("close", "", 20),
  );
  const panel = el(
    "aside",
    { class: "pb-panel", role: "dialog", "aria-modal": "true", "aria-label": "Plan a build" },
    [
      el("header", { class: "pb-head" }, [
        el("div", { class: "pb-head-main" }, [titleEl, subEl]),
        el("div", { class: "pb-head-actions" }, [
          el(
            "button",
            {
              class: "btn pb-new-plan",
              type: "button",
              "aria-label": "Start a new plan (archives current conversation)",
              onclick: startNewPlanBuild,
            },
            "New plan",
          ),
          closeBtn,
        ]),
      ]),
      el("p", { class: "pb-guardrail" }, [
        el("b", {}, "Proposes only. "),
        "Nothing runs until you confirm, and confirmed tickets land as draft (or ready, if you say so).",
      ]),
      log,
      form,
    ],
  );
  panel.addEventListener("click", (e) => e.stopPropagation());

  // Auto-grow the composer; Enter sends, Shift+Enter is a newline.
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitPlanBuildTurn();
  });
  scrim.appendChild(panel); // the panel must live inside the scrim (click-outside closes; panel stops propagation)
  document.body.appendChild(scrim);

  planBuildEls = {
    scrim,
    panel,
    log,
    input,
    sendBtn,
    forceBtn,
    form,
    titleEl,
    subEl,
    closeBtn,
    inline: null,
  };
  return planBuildEls;
}

// ---------------------------------------------------------------------------
//  Session helpers — best-effort; never throw to the caller.
// ---------------------------------------------------------------------------

/**
 * Restore the in-progress session state from a server session row.
 * Parses messages_json and populates planBuildState.history + plan.
 * The server stores assistant turns as JSON-stringified decompose envelopes;
 * user turns store the raw text in `content`.
 */
function restorePlanBuildSession(session) {
  if (!planBuildState || !session) return;
  planBuildState.sessionId = session.id;
  planBuildState.brief = session.brief || null;

  let messages;
  try {
    messages = JSON.parse(session.messages_json || "[]");
  } catch {
    messages = [];
  }

  const history = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      // First user message is the brief; subsequent ones are answers.
      const isFirst = history.filter((t) => t.role === "user").length === 0;
      history.push(
        isFirst ? { role: "user", brief: msg.content } : { role: "user", answer: msg.content },
      );
    } else if (msg.role === "assistant") {
      try {
        const envelope = JSON.parse(msg.content);
        if (envelope && envelope.phase === "clarify") {
          history.push({ role: "assistant", questions: envelope.questions || [] });
        }
        // plan turns are restored via plan_json below, not via history
      } catch {
        // Malformed assistant message — skip.
      }
    }
  }
  planBuildState.history = history;

  if (session.plan_json) {
    try {
      planBuildState.plan = JSON.parse(session.plan_json);
    } catch {
      planBuildState.plan = null;
    }
  }
}

/**
 * Create a new server-side session. Best-effort: if the API is unreachable,
 * sessionId stays null and the panel works in pure in-memory mode.
 */
async function createPlanBuildSession() {
  try {
    const res = await api("POST", "/plan-sessions");
    if (res && res.session && res.session.id) {
      planBuildState.sessionId = res.session.id;
    }
  } catch {
    // Degrade gracefully — session persistence unavailable.
  }
}

/**
 * Append a message to the current session. Called after each user turn and
 * after each assistant reply. Best-effort — never interrupts the chat.
 */
async function persistPlanBuildTurn(role, content, opts) {
  const id = planBuildState && planBuildState.sessionId;
  if (!id) return;
  try {
    await api("POST", `/plan-sessions/${id}/turns`, { role, content, ...opts });
  } catch {
    // Session persistence unavailable — continue in-memory.
  }
}

/**
 * Archive the current session (if any). Called on "Start new plan" (abandoned)
 * and on confirmPlanBuild (confirmed). Best-effort.
 */
async function archivePlanBuildSession(status) {
  const id = planBuildState && planBuildState.sessionId;
  if (!id) return;
  try {
    await api("POST", `/plan-sessions/${id}/archive`, { status });
  } catch {
    // Ignore — the session may not exist on an older server.
  }
}

function openPlanBuild(opts = {}) {
  const els = ensurePlanBuild();
  // On the Plan-a-build page the panel is part of the page: (re)start it there.
  if (els.inline && els.inline.isConnected && els.inline.contains(els.panel)) {
    startPlanBuild(opts);
    els.panel.scrollIntoView?.({
      block: "start",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    return;
  }
  startPlanBuild(opts);
  els.scrim.classList.add("open");
  document.addEventListener("keydown", planBuildKeydown);
}

/**
 * The Plan-a-build page (#/create) hosts the same panel inline: the conversation
 * state, the session persistence and the tests' hooks are shared with the sheet.
 * Returns the undo, which hands the panel back to its scrim — but only while this
 * host still holds it (a newer render of the page may have taken it already).
 */
function mountPlanBuildInline(host) {
  const els = ensurePlanBuild();
  closePlanBuild();
  host.appendChild(els.panel);
  els.inline = host;
  els.panel.classList.add("pb-inline");
  els.panel.setAttribute("role", "region");
  els.panel.removeAttribute("aria-modal");
  els.closeBtn.hidden = true;
  els.titleEl.textContent = "The team talk";
  els.subEl.textContent =
    "You give the brief. The planner asks what it needs, then proposes the draw.";
  startPlanBuild({ focus: false });
  return () => {
    if (!host.contains(els.panel)) return;
    els.scrim.appendChild(els.panel);
    els.inline = null;
    els.panel.classList.remove("pb-inline");
    els.panel.setAttribute("role", "dialog");
    els.panel.setAttribute("aria-modal", "true");
    els.closeBtn.hidden = false;
    els.titleEl.textContent = "Plan a build";
    els.subEl.textContent = "Your brief → the planner's questions → the draw";
  };
}

function startPlanBuild(opts = {}) {
  const { input } = ensurePlanBuild();
  // `mode` is the start toggle: "new" (greenfield app) vs "extend" (add tickets
  // to an existing scope node / epic). `target` holds the chosen extend node and
  // becomes the `context` sent to the decomposer on the first turn. `nodes` is
  // loaded lazily for the extend picker; an empty list just hides the option.
  // `sessionId` is the server-side session id (null when persistence unavailable).
  // `spec` (SPEC-DRIVEN): when opened from a FROZEN spec via buildFromFrozenSpec(),
  // its clauses ride along on every plan-build POST so the decomposer satisfies each
  // clause and stamps spec_clause_id provenance on the ACs — without this the whole
  // spec→plan→coverage traceability chain is dead (the spec never reaches decompose).
  // `repo` (from a spec's target_repo): start in "extend" mode targeting that repo
  // so the first turn's context carries it and decompose takes the brownfield path.
  const seededRepo = typeof opts.repo === "string" && opts.repo.trim() ? opts.repo.trim() : null;
  planBuildState = {
    history: [],
    plan: null,
    busy: false,
    brief: opts.brief || null,
    mode: seededRepo ? "extend" : "new",
    target: seededRepo ? { kind: "repo", id: seededRepo, name: seededRepo } : null,
    nodes: [],
    repos: [],
    sessionId: null,
    spec: Array.isArray(opts.spec) && opts.spec.length ? opts.spec : null,
  };
  renderPlanBuildLog();
  // Seeded from a spec: pre-fill the brief so the user can immediately "Build the tickets".
  if (planBuildState.brief && input) input.value = planBuildState.brief;
  if (opts.focus !== false) setTimeout(() => input.focus(), 50);
  // Best-effort: restore the in-progress session from the server, and populate
  // the "Extend existing" picker. Both are non-blocking; the panel works without them.
  guard(async () => {
    const [sessionRes, nodesRes, reposRes] = await Promise.all([
      api("GET", "/plan-sessions/active").catch(() => null),
      api("GET", "/scope/nodes"),
      api("GET", "/repositories"),
    ]);
    if (!planBuildState) return; // panel was closed during the fetch
    // A spec-driven open is ALWAYS a fresh session — never restore an unrelated
    // in-progress plan over the frozen-spec intent.
    if (planBuildState.spec) {
      await createPlanBuildSession();
    } else if (sessionRes && sessionRes.session && planBuildState.history.length === 0) {
      // Restore server session (if one exists and the panel hasn't been interacted with).
      restorePlanBuildSession(sessionRes.session);
    } else if ((!sessionRes || !sessionRes.session) && !readOnly()) {
      // No active session on the server — create one (best-effort). A read token
      // cannot hold one (the server refuses the POST), so it reads without.
      await createPlanBuildSession();
    }
    planBuildState.nodes = nodesRes.nodes || [];
    planBuildState.repos = reposRes.repositories || [];
    // Only repaint while still on the empty intro (no turns sent yet) OR if we
    // just restored a session with history.
    renderPlanBuildLog();
  });
}

/**
 * Archive the current session as 'abandoned' and open a fresh one.
 * The "New plan" button in the panel header calls this.
 */
async function startNewPlanBuild() {
  if (!planBuildState || planBuildState.busy) return;
  await archivePlanBuildSession("abandoned");
  // Reset in-memory state.
  planBuildState = {
    history: [],
    plan: null,
    busy: false,
    brief: null,
    mode: "new",
    target: null,
    nodes: planBuildState ? planBuildState.nodes : [],
    repos: planBuildState ? planBuildState.repos : [],
    sessionId: null,
    spec: null, // "New plan" starts clean — any frozen-spec attachment is dropped
  };
  renderPlanBuildLog();
  // Create a fresh server-side session.
  await createPlanBuildSession();
  if (planBuildEls) planBuildEls.input.focus();
}
function closePlanBuild() {
  if (!planBuildEls) return;
  planBuildEls.scrim.classList.remove("open");
  document.removeEventListener("keydown", planBuildKeydown);
}
function planBuildKeydown(e) {
  if (e.key === "Escape") closePlanBuild();
}

/** Repaint the conversation log from state (turns + the live proposal). */
function renderPlanBuildLog() {
  const { log } = planBuildEls;
  clear(log);

  if (planBuildState.history.length === 0) {
    log.appendChild(
      el("div", { class: "pb-intro" }, [
        renderPlanBuildModeToggle(),
        planBuildState.spec
          ? el(
              "p",
              { class: "pb-spec-note" },
              `Built to a frozen spec: its ${plural(planBuildState.spec.length, "clause")} ride along, so every criterion names the clause it proves.`,
            )
          : null,
        planBuildState.spec
          ? el(
              "p",
              { class: "pb-ask" },
              "The spec's brief is in the box below. Edit it if you like, then send it to the planner.",
            )
          : planBuildState.mode === "extend"
            ? el(
                "p",
                { class: "pb-ask" },
                planBuildState.target
                  ? `Say what to add to “${planBuildState.target.name}” in a line or two. For example:`
                  : "Pick what to extend, then say what to add in a line or two. For example:",
              )
            : el("p", { class: "pb-ask" }, "Say what to build in a line or two. For example:"),
        // From a frozen spec the brief is already written: no stock examples then.
        planBuildState.spec
          ? null
          : el(
              "ul",
              { class: "pb-examples" },
              (planBuildState.mode === "extend"
                ? ["add CSV export to the reports", "add a settings page with dark mode"]
                : ["a web app that tracks gym workouts", "an API that summarises PDFs"]
              ).map((ex) =>
                el(
                  "li",
                  {},
                  el(
                    "button",
                    {
                      class: "pb-example",
                      type: "button",
                      onclick: () => {
                        planBuildEls.input.value = ex;
                        planBuildEls.input.focus();
                      },
                    },
                    ex,
                  ),
                ),
              ),
            ),
      ]),
    );
  }

  let userTurn = 0;
  for (const turn of planBuildState.history) {
    if (turn.role === "user") {
      log.appendChild(
        el("div", { class: "pb-msg pb-user" }, [
          el("div", { class: "pb-bot-label" }, userTurn++ === 0 ? "Your brief" : "You"),
          el("div", { class: "pb-msg-t" }, turn.answer || turn.brief || ""),
        ]),
      );
    } else if (turn.role === "assistant" && turn.questions) {
      log.appendChild(
        el("div", { class: "pb-msg pb-bot" }, [
          el(
            "div",
            { class: "pb-bot-label" },
            `The planner asks ${turn.questions.length === 1 ? "one question" : `${turn.questions.length} questions`}`,
          ),
          el(
            "ol",
            { class: "pb-questions" },
            turn.questions.map((q) => el("li", {}, q)),
          ),
          el(
            "p",
            { class: "pb-hint" },
            "Answer below in your own words, or build the tickets now.",
          ),
        ]),
      );
    } else if (turn.role === "assistant" && turn.error) {
      log.appendChild(
        el("div", { class: "pb-msg pb-bot pb-error-msg" }, [
          el("div", { class: "pb-bot-label" }, "Couldn't build the plan"),
          el("div", {}, turn.error),
          el(
            "div",
            { class: "pb-error-hint dim" },
            'Edit your brief and try again, or press "Build the tickets".',
          ),
        ]),
      );
    }
  }

  if (planBuildState.plan) {
    log.appendChild(renderPlanProposal(planBuildState.plan));
  }

  if (planBuildState.notice) {
    log.appendChild(el("p", { class: "pb-notice", role: "alert" }, planBuildState.notice));
  }

  if (planBuildState.busy) {
    log.appendChild(
      el("div", { class: "pb-msg pb-bot pb-thinking", role: "status" }, [
        el("span", { class: "btn-spinner", "aria-hidden": "true" }),
        el("span", {}, "The planner is working on it…"),
      ]),
    );
  }

  updatePlanBuildActions();
  log.scrollTop = log.scrollHeight;
}

/** Turn depth (number of user messages sent) at which "Build the tickets" emphasises. */
const PLAN_BUILD_FORCE_EMPHASIS_TURNS = 3;

/**
 * Keep the composer actions honest about where the conversation is:
 *  - "Build the tickets" (forcePlan) is ALWAYS available so the user is never
 *    stuck clarifying — it forces the decomposer to emit a plan from what it has.
 *  - It gets EMPHASISED once several turns deep (the point where endless clarify
 *    stops earning its keep).
 *  - Once a plan is on screen the conversation's job is done — review/create takes
 *    over — so both the composer and the force button are hidden.
 * The "Send"/Continue button stays secondary: it keeps refining.
 */
function updatePlanBuildActions() {
  if (!planBuildEls) return;
  const { forceBtn, form } = planBuildEls;
  const turns = planBuildState.history.filter((t) => t.role === "user").length;
  const hasPlan = !!planBuildState.plan;
  // Hide the whole composer once a plan is proposed — the create path owns it now.
  form.hidden = hasPlan;
  if (!hasPlan) {
    planBuildEls.input.placeholder = turns
      ? "Answer the planner, or add anything it should know…"
      : "Describe what to build…";
    // A bare first turn has no brief yet — force-plan with nothing to go on is a no-op.
    forceBtn.disabled = planBuildState.busy || turns === 0;
    forceBtn.classList.toggle("pb-force-strong", turns >= PLAN_BUILD_FORCE_EMPHASIS_TURNS);
  }
  lockPlanBuildForReadOnly();
}

/**
 * A read token may read a plan conversation but not hold one: the composer, its
 * examples and mode toggle, New plan and the plan's create buttons are switched off
 * (Close stays live). Runs after every repaint of the panel.
 */
function lockPlanBuildForReadOnly() {
  if (!planBuildEls || !readOnly()) return;
  planBuildEls.closeBtn.setAttribute("data-ro-ok", "");
  roLockAll(planBuildEls.panel);
}

// ── Shared target selector ──────────────────────────────────────────────────
// One control for "pick a repo OR a scope node, and assign it as a target".
// A target is { kind: "repo" | "node", id, name }. A node resolves to its linked
// repo NAME(s) via resolveTargetRepos() so every consumer (plan-build extend,
// idle-loop scoping) ends up repo-name-based — the loop/decompose backends never
// learn about nodes. Two variants: single-select (a <select> with Repos/Scopes
// optgroups, plus a repo disambiguator when a multi-repo node is chosen) and
// multi-select (grouped checkboxes). Self-contained + styled to match the
// existing form controls.

/** Cache of node id → repo NAMES, so a node only fetches its repos once per session. */
const nodeReposCache = new Map();

/**
 * Resolve a node's linked repo NAMES. Uses the already-loaded `scopeRepos` map
 * (node id → repo objects) when present, else fetches `GET /scope/repos?node=<id>`
 * once and caches it. A repo target resolves to its own single name. Best-effort:
 * returns [] on any error so a save never hard-fails on a transient fetch.
 */
async function resolveTargetRepos(target, scopeRepos) {
  if (!target) return [];
  if (target.kind === "repo") return target.name ? [target.name] : [];
  const id = target.id;
  if (scopeRepos && Array.isArray(scopeRepos[id])) {
    return scopeRepos[id].map((r) => r.name).filter(Boolean);
  }
  if (nodeReposCache.has(id)) return nodeReposCache.get(id);
  try {
    const { repos } = await api("GET", `/scope/repos?node=${encodeURIComponent(id)}`);
    const names = (Array.isArray(repos) ? repos : []).map((r) => r.name).filter(Boolean);
    nodeReposCache.set(id, names);
    return names;
  } catch {
    return [];
  }
}

/**
 * Single-select target picker. Renders a labelled <select> grouping repos
 * ("Repos") and scope nodes ("Scopes"). On choosing a repo the value becomes
 * { kind:"repo", id, name }; on a node it becomes { kind:"node", id, name } and,
 * when the node links more than one repo, a second <select> appears so the user
 * disambiguates which repo to target (a node with exactly one repo auto-resolves).
 * Calls `onChange(target)` with the current selection (or null when cleared).
 */
function targetPickerSingle({ repos, nodes, value, allowRepo = true, allowNode = true, onChange }) {
  const wrap = el("div", { class: "target-picker" });
  const repoList = allowRepo ? repos || [] : [];
  const nodeList = allowNode ? nodes || [] : [];

  // Slot for the per-node repo disambiguator (filled when a multi-repo node is chosen).
  const repoSlot = el("div", { class: "target-picker-reposlot" });

  const optionValue = (kind, id) => `${kind}:${id}`;
  const selected =
    value && value.kind
      ? optionValue(value.kind, value.kind === "repo" ? value.name : value.id)
      : "";

  const sel = el(
    "select",
    { class: "target-picker-select", "aria-label": "Target repo or scope" },
    [
      el("option", { value: "" }, "Select a target…"),
      repoList.length
        ? el(
            "optgroup",
            { label: "Repos" },
            repoList.map((r) =>
              el(
                "option",
                {
                  value: optionValue("repo", r.name),
                  selected: selected === optionValue("repo", r.name) ? "" : undefined,
                },
                r.name,
              ),
            ),
          )
        : null,
      nodeList.length
        ? el(
            "optgroup",
            { label: "Scopes" },
            nodeList.map((n) =>
              el(
                "option",
                {
                  value: optionValue("node", n.id),
                  selected: selected === optionValue("node", n.id) ? "" : undefined,
                },
                `${n.name} (${typeLabel(n.type)})`,
              ),
            ),
          )
        : null,
    ],
  );

  // Build the per-node repo disambiguator into the slot from a list of repo names.
  // Idempotent: clears the slot first, so it survives consumer re-renders that
  // remount the whole picker with the same node `value`.
  function renderRepoSlot(target, names) {
    clear(repoSlot);
    if (names.length <= 1) {
      // 0 → greenfield-style (no repo); 1 → use it directly. No disambiguation.
      target.repo = names[0] || null;
      return;
    }
    const repoSel = el(
      "select",
      { class: "target-picker-select", "aria-label": "Which repo in this scope" },
      [
        el("option", { value: "" }, "Pick a repo in this scope…"),
        ...names.map((name) =>
          el("option", { value: name, selected: target.repo === name ? "" : undefined }, name),
        ),
      ],
    );
    repoSel.addEventListener("change", () => {
      target.repo = repoSel.value || null;
      onChange(target);
    });
    repoSlot.appendChild(el("label", { class: "target-picker-sublabel" }, "Repo in scope"));
    repoSlot.appendChild(repoSel);
  }

  // For a node target: render the disambiguator. Uses the repo-name cache when
  // present (so a remount paints synchronously); otherwise fetches, then repaints
  // just the slot — without notifying the consumer (no re-render churn).
  function hydrateRepoSlot(target) {
    clear(repoSlot);
    if (!target || target.kind !== "node") return;
    if (nodeReposCache.has(target.id)) {
      renderRepoSlot(target, nodeReposCache.get(target.id));
      return;
    }
    // The slot belongs to this picker instance; paint into it when the resolve
    // lands. A remount supersedes us with its own slot, so this is always safe.
    resolveTargetRepos(target).then((names) => renderRepoSlot(target, names));
  }

  sel.addEventListener("change", () => {
    clear(repoSlot);
    const raw = sel.value;
    if (!raw) {
      onChange(null);
      return;
    }
    const sep = raw.indexOf(":");
    const kind = raw.slice(0, sep);
    const key = raw.slice(sep + 1);
    if (kind === "repo") {
      onChange({ kind: "repo", id: key, name: key, repo: key });
      return;
    }
    const node = nodeList.find((n) => n.id === key);
    const target = node
      ? { kind: "node", id: node.id, name: node.name, type: node.type, repo: null }
      : null;
    if (!target) {
      onChange(null);
      return;
    }
    // Notify first (the consumer may re-render and remount this picker — the new
    // mount's hydrateRepoSlot then paints the disambiguator), then paint here too
    // for consumers that don't re-render. A detached paint is harmless.
    onChange(target);
    hydrateRepoSlot(target);
  });

  wrap.appendChild(sel);
  wrap.appendChild(repoSlot);
  // Restore the disambiguator when remounted with a node already selected (the
  // consumer re-renders the picker on every change, so this keeps it in sync).
  if (value && value.kind === "node") hydrateRepoSlot(value);
  return wrap;
}

/**
 * Multi-select target picker. Renders grouped checkboxes (Repos / Scopes) and
 * keeps a live Set of selected targets. `getTargets()` returns the current
 * selection as `{ kind, id, name }[]`; consumers resolve nodes to repo NAMES via
 * resolveTargetRepos() on save. An empty selection means "all" — the caller owns
 * that copy. Used for the idle loops (repos + nodes, node expands to repo names).
 */
function targetPickerMulti({ repos, nodes, value, onChange }) {
  const wrap = el("div", { class: "target-picker target-picker-multi" });
  const repoList = repos || [];
  const nodeList = nodes || [];

  // Selection keyed by "kind:id" so repos and nodes can't collide.
  const selected = new Map();
  for (const t of value || []) selected.set(`${t.kind}:${t.id}`, t);

  const emit = () => onChange(getTargets());
  function getTargets() {
    return [...selected.values()];
  }

  function checkboxRow(target, label) {
    const key = `${target.kind}:${target.id}`;
    const input = el("input", { type: "checkbox", "aria-label": label });
    input.checked = selected.has(key);
    input.addEventListener("change", () => {
      if (input.checked) selected.set(key, target);
      else selected.delete(key);
      emit();
    });
    return el("label", { class: "target-picker-check" }, [input, el("span", {}, label)]);
  }

  if (repoList.length) {
    wrap.appendChild(el("div", { class: "target-picker-grouplabel" }, "Repos"));
    const group = el("div", { class: "target-picker-group" });
    for (const r of repoList) {
      group.appendChild(checkboxRow({ kind: "repo", id: r.name, name: r.name }, r.name));
    }
    wrap.appendChild(group);
  }
  if (nodeList.length) {
    wrap.appendChild(el("div", { class: "target-picker-grouplabel" }, "Scopes"));
    const group = el("div", { class: "target-picker-group" });
    for (const n of nodeList) {
      group.appendChild(
        checkboxRow(
          { kind: "node", id: n.id, name: n.name, type: n.type },
          `${n.name} (${typeLabel(n.type)})`,
        ),
      );
    }
    wrap.appendChild(group);
  }
  if (!repoList.length && !nodeList.length) {
    wrap.appendChild(el("div", { class: "target-picker-empty dim" }, "No repos or scopes yet."));
  }

  // Expose the live reader so the caller can collect on save.
  wrap.getTargets = getTargets;
  return wrap;
}

/**
 * Shared entry point. `multiple` chooses the variant; both share the repos/nodes
 * inputs and the { kind, id, name } target shape. Kept as one function so the two
 * consumers (plan-build extend, idle loops) reach for the same abstraction.
 */
function targetPicker(opts) {
  return opts.multiple ? targetPickerMulti(opts) : targetPickerSingle(opts);
}

/**
 * Start toggle: "New app" vs "Extend existing". In extend mode a repo/scope
 * picker appears; the chosen target becomes the `context` the decomposer uses
 * to propose EXTENDING tickets rather than rebuilding. The toggle only shows on
 * the empty intro (before any turn) — once the conversation starts the target is
 * locked so history stays coherent.
 */
function renderPlanBuildModeToggle() {
  const nodes = planBuildState.nodes || [];
  const newRadio = el("input", {
    type: "radio",
    name: "pb-mode",
    value: "new",
    checked: planBuildState.mode === "new" ? "" : undefined,
  });
  const extendRadio = el("input", {
    type: "radio",
    name: "pb-mode",
    value: "extend",
    checked: planBuildState.mode === "extend" ? "" : undefined,
  });
  newRadio.addEventListener("change", () => {
    if (newRadio.checked) {
      planBuildState.mode = "new";
      planBuildState.target = null;
      renderPlanBuildLog();
      planBuildEls.input.focus();
    }
  });
  extendRadio.addEventListener("change", () => {
    if (extendRadio.checked) {
      planBuildState.mode = "extend";
      renderPlanBuildLog();
      planBuildEls.input.focus();
    }
  });

  const children = [
    el("div", { class: "mode-toggle" }, [
      el("label", { class: "mode-option" }, [
        newRadio,
        el("span", {}, [
          el("strong", {}, "New app"),
          el("span", { class: "mode-sub" }, "a new repo, from scratch"),
        ]),
      ]),
      el("label", { class: "mode-option" }, [
        extendRadio,
        el("span", {}, [
          el("strong", {}, "Extend existing"),
          el("span", { class: "mode-sub" }, "add to a repo or scope we have"),
        ]),
      ]),
    ]),
  ];

  if (planBuildState.mode === "extend") {
    const repos = planBuildState.repos || [];
    // Shared selector: offers BOTH repos and scope nodes. Choosing a repo sets the
    // target directly (the first-turn context carries that `repo`, no guessing);
    // choosing a multi-repo node expands to a repo disambiguator; a single-repo
    // node resolves to its one repo. The picker keeps target.repo current.
    const picker = targetPicker({
      repos,
      nodes,
      value: planBuildState.target,
      multiple: false,
      onChange: (target) => {
        planBuildState.target = target;
        planBuildState.notice = null;
        renderPlanBuildLog();
        planBuildEls.input.focus();
      },
    });
    children.push(field("Extend", picker, { class: "pb-extend-field" }));
  }

  return el("div", { class: "pb-mode" }, children);
}

/**
 * The proposal as the draw: the epic's name and brief, then its tickets round by
 * round (a ticket's round is its dependency depth in the plan), then the Final
 * the factory adds on confirm, then the two ways to confirm.
 */
// ---- Requirements agreed during clarification -----------------------------------
// The planner asks questions; the human's answers are requirements ("links expire after
// 30 minutes"). A proposal that dropped one used to be confirmed with only the brief, so
// the acceptance ticket never carried it and the independent tester never checked it.
// The proposal now lists every agreed answer, marks the ones no proposed criterion
// covers, and confirming carries the kept ones into the acceptance ticket's criteria
// (server: epic.agreed_requirements). Mirrors util/planClarifications.ts.
const PB_STOPWORDS = new Set(
  (
    "the a an and or but of to in on at for with from by as is are be been it its this that " +
    "these those should must will would can could may might shall do does did not no yes " +
    "after before when then than so if we our you your they them their there here also " +
    "just only all any each every some such very want need needs please"
  ).split(" "),
);
function pbTokens(text) {
  const words = new Set();
  const numbers = new Set();
  for (const tok of String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)) {
    if (!tok) continue;
    if (/^\p{N}+$/u.test(tok)) numbers.add(tok);
    else if (tok.length >= 3 && !PB_STOPWORDS.has(tok)) words.add(tok);
  }
  return { words, numbers };
}
function pbCriterionCovers(criterion, answer) {
  const a = pbTokens(answer);
  if (!a.words.size && !a.numbers.size) return false;
  const c = pbTokens(criterion);
  for (const n of a.numbers) if (!c.numbers.has(n)) return false;
  if (!a.words.size) return true;
  let hit = 0;
  for (const w of a.words) if (c.words.has(w)) hit++;
  return hit * 2 >= a.words.size;
}
/** The answers given to the planner's questions in this chat (the brief is not one). */
function planAgreedRequirements() {
  const out = [];
  let pending = null;
  for (const h of (planBuildState && planBuildState.history) || []) {
    if (!h) continue;
    if (h.role === "assistant") {
      pending = Array.isArray(h.questions)
        ? h.questions.filter((q) => q && String(q).trim())
        : null;
      continue;
    }
    const answer = typeof h.answer === "string" ? h.answer.trim() : "";
    if (pending && answer) {
      out.push({
        ...(pending.length ? { question: pending.join(" ").slice(0, 4000) } : {}),
        answer: answer.slice(0, 4000),
      });
    }
    pending = null;
  }
  return out.slice(0, 50);
}

function renderPlanAgreed(plan, agreed, withFinal) {
  if (!agreed.length) return null;
  const tickets = plan.tickets || [];
  const acText = (ac) => (typeof ac === "string" ? ac : (ac && ac.text) || "");
  const keep = (planBuildState.agreedKeep = planBuildState.agreedKeep || {});
  const items = agreed.map((r, i) => {
    const coveredBy = [];
    tickets.forEach((t, ti) => {
      const acs = Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : [];
      if (acs.some((ac) => pbCriterionCovers(acText(ac), r.answer))) coveredBy.push(`T${ti + 1}`);
    });
    if (keep[i] === undefined) keep[i] = true;
    const box = el("input", {
      type: "checkbox",
      class: "pb-agreed-keep",
      "aria-label": `Add “${r.answer.slice(0, 80)}” to the acceptance criteria`,
      ...(withFinal ? {} : { disabled: "" }),
      onchange: (e) => {
        keep[i] = e.target.checked;
      },
    });
    box.checked = withFinal && keep[i];
    return el("li", { class: `pb-agreed-item${coveredBy.length ? "" : " is-uncovered"}` }, [
      el("label", { class: "pb-agreed-label" }, [box, el("span", {}, r.answer)]),
      r.question ? el("p", { class: "pb-agreed-q" }, `Asked: ${r.question}`) : null,
      el(
        "p",
        { class: "pb-agreed-cover" },
        coveredBy.length
          ? `Covered by ${coveredBy.join(", ")}'s criteria`
          : "No proposed ticket's criteria cover this",
      ),
    ]);
  });
  const uncovered = items.filter((li) => li.classList.contains("is-uncovered")).length;
  return el("section", { class: "pb-agreed", "aria-label": "Requirements agreed while planning" }, [
    el("h4", { class: "pb-agreed-title" }, "Agreed while planning"),
    el(
      "p",
      { class: "pb-agreed-note" },
      withFinal
        ? `Each one you keep becomes a criterion of the Final, so the independent tester checks it.${uncovered ? ` ${plural(uncovered, "requirement")} ${uncovered === 1 ? "is" : "are"} in no ticket's criteria.` : ""}`
        : "This epic has no Final (acceptance is off), so nothing carries these into a criterion: add them to a ticket before you confirm.",
    ),
    el("ul", { class: "pb-agreed-list" }, items),
  ]);
}

function renderPlanProposal(plan) {
  const epic = plan.epic || {};
  const tickets = plan.tickets || [];
  const depthMemo = new Map();
  const depth = (i, seen = new Set()) => {
    if (depthMemo.has(i)) return depthMemo.get(i);
    if (seen.has(i)) return 0;
    seen.add(i);
    const deps = (Array.isArray(tickets[i]?.dependsOn) ? tickets[i].dependsOn : []).filter(
      (d) => Number.isInteger(d) && d >= 0 && d < tickets.length && d !== i,
    );
    const v = deps.length ? 1 + Math.max(...deps.map((d) => depth(d, seen))) : 0;
    depthMemo.set(i, v);
    return v;
  };
  const rounds = [];
  tickets.forEach((t, i) => {
    const d = depth(i);
    (rounds[d] = rounds[d] || []).push(i);
  });
  const filled = rounds.filter(Boolean);
  const known = new Set(((planBuildState && planBuildState.repos) || []).map((r) => r.name));
  const withFinal = epic.acceptance !== false;

  const ticketRow = (i) => {
    const t = tickets[i];
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : [];
    const acs = Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : [];
    const acText = (ac) => (typeof ac === "string" ? ac : (ac && ac.text) || "");
    return el("li", { class: "pb-ticket" }, [
      el("div", { class: "pb-ticket-top" }, [
        // A proposal index, never a ticket number: the server numbers the tickets
        // only when you confirm, so "#1" here would name a ticket that exists.
        el(
          "span",
          { class: "pb-ticket-idx tabnum", title: `Proposed ticket ${i + 1}: not created yet` },
          `T${i + 1}`,
        ),
        el("span", { class: "pb-ticket-title" }, t.title),
      ]),
      el("div", { class: "pb-ticket-meta" }, [
        t.repo
          ? known.has(t.repo)
            ? repoTag(t.repo, 16)
            : el("span", { class: "pb-repo-new" }, [kitShirt(t.repo, 16), `new repo: ${t.repo}`])
          : el("span", {}, "no repo named"),
        t.bootstrap ? badge("bootstrap") : null,
        typeof t.priority === "number"
          ? el("span", { class: "tabnum" }, `priority ${t.priority}`)
          : null,
        deps.length
          ? el(
              "span",
              { class: "pb-ticket-deps" },
              `after ${deps.map((d) => `T${d + 1}`).join(", ")}`,
            )
          : null,
      ]),
      t.description ? el("p", { class: "pb-ticket-desc" }, t.description) : null,
      acs.length
        ? el("details", { class: "pb-acs-fold" }, [
            el("summary", {}, plural(acs.length, "acceptance criterion", "acceptance criteria")),
            el(
              "ul",
              { class: "pb-acs" },
              acs.map((ac) => el("li", {}, acText(ac))),
            ),
          ])
        : el(
            "p",
            { class: "pb-ticket-noac" },
            "No acceptance criterion: it stays draft until one is added.",
          ),
    ]);
  };

  const wrap = el(
    "section",
    { class: "pb-proposal", "aria-label": `Proposed campaign: ${epic.name || "epic"}` },
    [
      el("header", { class: "pb-proposal-head" }, [
        el("h3", { class: "pb-proposal-name" }, epic.name || "Proposed epic"),
        el(
          "p",
          { class: "pb-proposal-aux" },
          `The draw, proposed · ${plural(tickets.length, "ticket")} in ${plural(filled.length, "round")}${withFinal ? " + the Final" : ""}`,
        ),
      ]),
      epic.description ? el("p", { class: "pb-proposal-desc" }, epic.description) : null,
      el("ol", { class: "pb-rounds" }, [
        ...filled.map((idxs, ri) =>
          el("li", { class: "pb-round" }, [
            el("h4", { class: "pb-round-name" }, `Round ${ri + 1}`),
            el("ol", { class: "pb-tickets" }, idxs.map(ticketRow)),
          ]),
        ),
        withFinal
          ? el("li", { class: "pb-round is-final" }, [
              el("h4", { class: "pb-round-name" }, "Final"),
              el("div", { class: "pb-final" }, [
                el("span", { class: "pb-ticket-title" }, `Acceptance: ${epic.name || "the build"}`),
                el(
                  "p",
                  { class: "pb-ticket-desc" },
                  "Added by the factory when you confirm. Your brief is its contract; it runs last, against the whole build, and the independent tester decides it.",
                ),
              ]),
            ])
          : null,
      ]),
    ],
  );

  const agreedSection = renderPlanAgreed(plan, planAgreedRequirements(), withFinal);
  if (agreedSection) wrap.appendChild(agreedSection);

  wrap.appendChild(
    el("div", { class: "pb-confirm-row" }, [
      el(
        "p",
        { class: "pb-confirm-note" },
        `Create as draft to look them over first, or create and ready them for the squad now. Readying asks each ticket's gate: one with no acceptance criterion stays draft.`,
      ),
      el("div", { class: "pb-confirm-actions" }, [
        el(
          "button",
          {
            class: "btn",
            type: "button",
            onclick: () => confirmPlanBuild(plan),
          },
          el("span", {}, "Create as draft"),
        ),
        el(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: () => confirmPlanBuild(plan, { ready: true }),
          },
          [icon("check"), el("span", {}, "Create & ready")],
        ),
      ]),
    ]),
  );
  return wrap;
}

/**
 * Send the next turn: append the user message, POST /plan-build, fold the reply.
 *
 * `forcePlan` is the "Build the tickets now" escape — it fires WITHOUT requiring
 * new input (it builds from the brief + answers so far) and asks the decomposer to
 * stop clarifying and return a plan. The normal (Continue/Send) path keeps refining.
 */
async function submitPlanBuildTurn(opts = {}) {
  const forcePlan = opts.forcePlan === true;
  const { input, sendBtn } = planBuildEls;
  const text = input.value.trim();
  // Continue/Send needs text; "Build the tickets" does not — it forces a plan from
  // whatever has been said so far. Either way, never fire while a turn is in flight.
  if (planBuildState.busy) return;
  if (!forcePlan && !text) return;

  const isFirst = planBuildState.history.length === 0;
  // Extend mode requires a target before the first turn, otherwise "extend" has
  // nothing to extend. Later turns inherit the locked target, so only gate the first.
  // Both refusals are said inline, next to the composer, not in a toast.
  if (isFirst && planBuildState.mode === "extend" && !planBuildState.target) {
    planBuildState.notice = "Pick the repo or scope to extend first.";
    renderPlanBuildLog();
    return;
  }
  // Force-plan with nothing said yet has nothing to plan from — ask for the brief.
  if (forcePlan && isFirst && !text) {
    planBuildState.notice = "Write the brief first: the tickets are built from it.";
    renderPlanBuildLog();
    input.focus();
    return;
  }
  planBuildState.notice = null;

  // Record the user's message. On a force-plan turn the input may be empty (the
  // user just pressed "Build the tickets"), so only push a message when there is text.
  if (text) {
    if (isFirst) planBuildState.brief = text;
    planBuildState.history.push(
      isFirst ? { role: "user", brief: text } : { role: "user", answer: text },
    );
    // Persist the user turn server-side (best-effort; never awaited before the render).
    persistPlanBuildTurn("user", text, isFirst ? { brief: text } : {}).catch(() => {});
    input.value = "";
    input.style.height = "auto";
  }

  // Build the extend-existing context once (locked for the whole conversation).
  // The target is either a direct repo ({kind:"repo"}) — its name flows straight
  // through as `repo` — or a scope node ({kind:"node"}) — its id/name/type plus
  // the resolved/disambiguated repo NAME (when one was chosen).
  const target = planBuildState.target;
  const context =
    planBuildState.mode === "extend" && target
      ? target.kind === "repo"
        ? { mode: "extend", repo: target.name }
        : {
            mode: "extend",
            scopeNodeId: target.id,
            scopeNodeName: target.name,
            scopeNodeType: target.type,
            // Brownfield: forward the resolved/disambiguated target repo NAME so
            // decompose takes the existing-repo path. Only included when resolved.
            ...(target.repo ? { repo: target.repo } : {}),
          }
      : undefined;

  planBuildState.busy = true;
  // Immediate running state: disable + relabel the send button to "Planning…"
  // (the inline "thinking" dots render from `busy` in renderPlanBuildLog), so the
  // turn visibly "took" rather than firing silently.
  sendBtn.disabled = true;
  sendBtn.classList.add("is-running");
  sendBtn.setAttribute("aria-busy", "true");
  clear(sendBtn);
  sendBtn.appendChild(el("span", { class: "btn-spinner", "aria-hidden": "true" }));
  sendBtn.appendChild(el("span", { class: "pb-send-label" }, "Planning…"));
  renderPlanBuildLog();

  // Send the brief + the answered turns; the helper treats answered Qs as settled.
  // On a force-plan turn the decomposer is told to stop clarifying and return a
  // plan now from what it has — so the user is never trapped in an endless chat.
  // NOTE: we handle errors explicitly (not via guard) so a failed turn leaves a
  // PERSISTENT error message in the chat + clears the thinking bubble, rather than
  // hanging on the typing dots with only a transient toast.
  let failure = null;
  try {
    const res = await api("POST", "/plan-build", {
      brief: planBuildState.brief,
      history: planBuildState.history
        .filter((t) => !(t.role === "assistant" && t.error)) // never resend a failed turn
        .map((t) => (t.role === "user" && t.brief ? { role: "user", answer: t.brief } : t)),
      ...(context !== undefined ? { context } : {}),
      ...(forcePlan ? { forcePlan: true } : {}),
      // SPEC-DRIVEN: thread the frozen spec's clauses so the decomposer satisfies each
      // and stamps spec_clause_id provenance on the ACs (drives the coverage read model).
      ...(Array.isArray(planBuildState.spec) && planBuildState.spec.length
        ? { spec: planBuildState.spec }
        : {}),
    });
    if (res.phase === "clarify") {
      planBuildState.history.push({ role: "assistant", questions: res.questions || [] });
      persistPlanBuildTurn("assistant", JSON.stringify(res)).catch(() => {});
    } else if (res.phase === "plan") {
      planBuildState.plan = res.plan || null;
      persistPlanBuildTurn("assistant", JSON.stringify(res), { plan: res.plan || null }).catch(
        () => {},
      );
    } else {
      failure = res.error || "The planner returned no result.";
      persistPlanBuildTurn("assistant", JSON.stringify(res)).catch(() => {});
    }
  } catch (e) {
    failure = e && e.message ? e.message : "The request errored before a plan came back.";
  }

  // Always land the UI in a resolved state — bubble cleared, composer usable.
  planBuildState.busy = false;
  if (failure) {
    planBuildState.history.push({ role: "assistant", error: failure });
    toast(failure, { code: "PLAN_BUILD" });
  }
  sendBtn.disabled = false;
  sendBtn.classList.remove("is-running");
  sendBtn.removeAttribute("aria-busy");
  clear(sendBtn);
  sendBtn.appendChild(icon("send"));
  renderPlanBuildLog();
}

/**
 * Human confirm → create_epic. Tickets land draft; toast + jump to the epic.
 *
 * Greenfield seam: a bootstrap plan names a repo that does NOT exist yet (the
 * runner greenfield mode registers it when the bootstrap ticket runs).
 * Shipped create_epic requires a named repo to already exist, so before posting
 * we drop `repo`/`access` for any ticket whose repo isn't registered yet. The
 * repo name stayed visible in the proposal for review; the link is established
 * later when the repo is onboarded. Everything else (ACs, deps, bootstrap,
 * priority) is preserved, so the draft epic still lands intact.
 */
// `opts.ready` (the "Create & ready" button) readies the created tickets in the
// same step so the human doesn't have to draft→ready each one by hand. It is
// GATE-AWARE, never a blind status flip: it POSTs /ready per ticket and lets the
// server's intake gate decide — a ticket with no acceptance criterion is refused
// and simply stays draft, so "Create & ready" can never push slop past the AC gate.
async function confirmPlanBuild(plan, opts = {}) {
  await guard(async () => {
    const known = new Set(
      ((await api("GET", "/repositories")).repositories || []).map((r) => r.name),
    );
    let deferred = 0;
    const tickets = (plan.tickets || []).map((t) => {
      if (t.repo && !known.has(t.repo)) {
        deferred++;
        const { repo, access, ...rest } = t;
        // Carry the intended repo NAME onto `source` so the runner bootstraps a
        // cleanly-named repo instead of falling back to a slug of the ticket title.
        // Only when the plan didn't already set `source`; the link itself stays
        // deferred until the repo is onboarded.
        return rest.source ? rest : { ...rest, source: repo };
      }
      return t;
    });
    // ACCEPTANCE GATE: the brief this plan came from rides on the epic so the
    // factory-created acceptance ticket carries it as its contract. The session's
    // recorded brief wins; else the first user turn of this chat.
    const firstTurn = ((planBuildState && planBuildState.history) || []).find(
      (h) => h && h.role === "user" && typeof h.brief === "string" && h.brief.trim(),
    );
    const brief =
      (planBuildState && planBuildState.brief) || (firstTurn ? firstTurn.brief : null) || null;
    const withBrief = brief ? { ...plan.epic, brief: String(brief).slice(0, 20000) } : plan.epic;
    // The answers given while the planner asked its questions ride on the epic as its
    // agreed requirements (the ones the human kept in the proposal), so the acceptance
    // ticket carries each as a criterion. Explicit even when empty: the server then
    // never re-derives what the human chose to drop.
    const keep = (planBuildState && planBuildState.agreedKeep) || {};
    const agreed = planAgreedRequirements().filter((_, i) => keep[i] !== false);
    const epic = { ...withBrief, agreed_requirements: agreed };
    const sessionId = planBuildState && planBuildState.sessionId;
    const res = await api("POST", "/epics", {
      epic,
      tickets,
      ...(sessionId ? { plan_session_id: sessionId } : {}),
    });
    // Archive the session as confirmed now that the epic has been created.
    await archivePlanBuildSession("confirmed");
    const numbers = res.ticket_numbers || [];
    const count = numbers.length;
    const tested = Number(res.testable_tickets) || 0;
    const note =
      (deferred
        ? ` (${deferred} repo link${deferred === 1 ? "" : "s"} deferred to bootstrap)`
        : "") +
      (tested
        ? `; ${tested} marked for the independent tester (set-testable --off unmarks one)`
        : "");

    let readied = 0;
    let heldDraft = 0;
    if (opts.ready && count) {
      // Resolve the just-created tickets by number, then let the server's ready
      // gate decide per ticket. A refusal (missing AC, unmet precondition) is
      // expected for some tickets — they stay draft, counted, never surfaced as an
      // error. Bootstrap-gated tickets are readied too; the loop honours deps.
      const all = (await allTickets()).tickets;
      const mine = all.filter((t) => numbers.includes(t.number));
      for (const t of mine) {
        try {
          await api("POST", `/tickets/${t.id}/ready`, {});
          readied++;
        } catch {
          heldDraft++;
        }
      }
    }

    const msg = opts.ready
      ? `Created ${count} ticket${count === 1 ? "" : "s"} — ${readied} readied` +
        (heldDraft ? `, ${heldDraft} held as draft (add an acceptance criterion)` : "") +
        note
      : `Created ${count} draft ticket${count === 1 ? "" : "s"} — ready them when set${note}`;
    toast(msg, { ok: true });
    closePlanBuild();
    navigate(`#/epics/${res.epic_node_id}`);
    // If already on the epics view, navigate() with the same view won't re-fire
    // the hashchange when the param differs only — force a refresh to be safe.
    router();
  });
}

// ---------------------------------------------------------------------------
//  Author a spec — the spec-author chat step (Spec-Driven Development, Phase 1c)
// ---------------------------------------------------------------------------
//
// A sibling to "Plan a build": a one-line brief becomes an AI-drafted, EDITABLE
// spec (clauses), which the human refines, then CREATES (POST /specs) and FREEZES
// (POST /specs/:id/freeze). It PROPOSES ONLY — nothing is created until the human
// presses "Create spec", and nothing is immutable until "Freeze". This flow is
// entirely additive: the one-liner plan-build path above is untouched. It reuses
// the pb-* panel styling (the spec panel is a second pb-panel instance) plus a few
// spec-specific classes (sb-*) for the editable clause list.
//
// The chat half mirrors submitPlanBuildTurn: clarify turns show questions and let
// the user continue; a "spec" turn hands its clauses to the editable draft. The
// "Draft the spec now" (forcePlan) escape is always available so the user is never
// stuck clarifying — exactly like plan-build's "Build the tickets".
//
// The three clause kinds match the dispatch/spec-author contract exactly.
const SPEC_CLAUSE_KINDS = ["requirement", "non-goal", "decision"];

let specBuildEls = null;
let specBuildState = null;

function ensureSpecBuild() {
  if (specBuildEls) return specBuildEls;
  const scrim = el("div", { class: "pb-scrim", onclick: closeSpecBuild });
  const log = el("div", { class: "pb-log", role: "log", "aria-live": "polite" });
  const input = el("textarea", {
    class: "pb-input",
    rows: "1",
    placeholder: "Describe what the product must do, in one line…",
    "aria-label": "Your message",
  });
  const sendBtn = el(
    "button",
    { class: "btn pb-send", type: "submit", "aria-label": "Send" },
    icon("send"),
  );
  // "Draft the spec now" escape: forces the author to emit a spec from the brief +
  // answers so far. Always visible so the user is NEVER stuck clarifying.
  const forceBtn = el(
    "button",
    {
      class: "btn primary pb-force",
      type: "button",
      "aria-label": "Draft the spec now from what you've told me",
      onclick: () => submitSpecBuildTurn({ forcePlan: true }),
    },
    [icon("check"), el("span", {}, "Draft the spec")],
  );
  const actions = el("div", { class: "pb-actions" }, [forceBtn, sendBtn]);
  const form = el("form", { class: "pb-composer" }, [input, actions]);
  const panel = el(
    "aside",
    { class: "pb-panel", role: "dialog", "aria-modal": "true", "aria-label": "Author a spec" },
    [
      el("header", { class: "pb-head" }, [
        el("div", { class: "pb-head-main" }, [
          el("div", { class: "pb-title" }, "Author a spec"),
          el(
            "div",
            { class: "pb-sub" },
            "Your brief → clauses you edit → frozen into the playbook",
          ),
        ]),
        el("div", { class: "pb-head-actions" }, [
          el(
            "button",
            {
              class: "btn pb-new-plan",
              type: "button",
              "aria-label": "Start a new spec (clears this conversation)",
              onclick: startNewSpecBuild,
            },
            "New spec",
          ),
          el(
            "button",
            {
              class: "icon-btn pb-close",
              type: "button",
              "aria-label": "Close",
              onclick: closeSpecBuild,
            },
            icon("close", "", 20),
          ),
        ]),
      ]),
      el("p", { class: "pb-guardrail" }, [
        el("b", {}, "Proposes only. "),
        "Nothing is created until you press Create spec, and nothing is locked until you freeze it.",
      ]),
      log,
      form,
    ],
  );
  panel.addEventListener("click", (e) => e.stopPropagation());

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 140) + "px";
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitSpecBuildTurn();
  });
  scrim.appendChild(panel);
  document.body.appendChild(scrim);

  specBuildEls = { scrim, panel, log, input, sendBtn, forceBtn, form };
  return specBuildEls;
}

function openSpecBuild() {
  const { scrim, input } = ensureSpecBuild();
  // `history` accumulates clarify turns; `draft` is the editable clause set once
  // the author returns a spec; `createdSpec` is the persisted spec (with id) after
  // Create; once `createdSpec` exists the flow shows the Freeze action.
  // `targetRepo` is the repo the spec is FOR: it rides on POST /specs as
  // `target_repo`, so the lore the freeze seeds is tagged with that repo and the
  // delivery primer's per-repo `memory search --repo <name>` can surface it —
  // untagged clauses never reached a delivery agent. `repos` feeds its picker.
  specBuildState = {
    history: [],
    draft: null,
    createdSpec: null,
    busy: false,
    brief: null,
    title: "",
    targetRepo: "",
    repos: [],
  };
  renderSpecBuildLog();
  scrim.classList.add("open");
  document.addEventListener("keydown", specBuildKeydown);
  setTimeout(() => input.focus(), 50);
  loadSpecBuildRepos();
}

/** Best-effort: populate the target-repo picker. The panel works without it. */
function loadSpecBuildRepos() {
  guard(async () => {
    const res = await api("GET", "/repositories").catch(() => null);
    if (!specBuildState || !res) return; // panel closed / repos unavailable
    specBuildState.repos = res.repositories || [];
    if (specBuildState.draft) renderSpecBuildLog();
  });
}

function startNewSpecBuild() {
  if (!specBuildState || specBuildState.busy) return;
  specBuildState = {
    history: [],
    draft: null,
    createdSpec: null,
    busy: false,
    brief: null,
    title: "",
    targetRepo: "",
    repos: specBuildState.repos || [],
  };
  renderSpecBuildLog();
  if (specBuildEls) specBuildEls.input.focus();
}

function closeSpecBuild() {
  if (!specBuildEls) return;
  specBuildEls.scrim.classList.remove("open");
  document.removeEventListener("keydown", specBuildKeydown);
}
function specBuildKeydown(e) {
  if (e.key === "Escape") closeSpecBuild();
}

/** Repaint the spec conversation log from state (turns + the editable draft). */
function renderSpecBuildLog() {
  const { log } = specBuildEls;
  clear(log);

  if (specBuildState.history.length === 0 && !specBuildState.draft) {
    log.appendChild(
      el("div", { class: "pb-intro" }, [
        el("p", {}, "Describe the product in one line and I'll draft a spec. For example:"),
        el(
          "ul",
          { class: "pb-examples" },
          ["a web app that tracks gym workouts", "an API that summarises PDFs"].map((ex) =>
            el(
              "li",
              {},
              el(
                "button",
                {
                  class: "pb-example",
                  type: "button",
                  onclick: () => {
                    specBuildEls.input.value = ex;
                    specBuildEls.input.focus();
                  },
                },
                ex,
              ),
            ),
          ),
        ),
      ]),
    );
  }

  for (const turn of specBuildState.history) {
    if (turn.role === "user") {
      log.appendChild(el("div", { class: "pb-msg pb-user" }, turn.answer || turn.brief || ""));
    } else if (turn.role === "assistant" && turn.questions) {
      log.appendChild(
        el("div", { class: "pb-msg pb-bot" }, [
          el("div", { class: "pb-bot-label dim" }, "Clarifying questions"),
          el(
            "ul",
            { class: "pb-questions" },
            turn.questions.map((q) => el("li", {}, q)),
          ),
        ]),
      );
    } else if (turn.role === "assistant" && turn.error) {
      log.appendChild(
        el("div", { class: "pb-msg pb-bot pb-error-msg" }, [
          el("div", { class: "pb-bot-label" }, "Couldn't draft the spec"),
          el("div", {}, turn.error),
          el(
            "div",
            { class: "pb-error-hint dim" },
            'Edit your brief and try again, or press "Draft the spec".',
          ),
        ]),
      );
    }
  }

  if (specBuildState.draft) {
    log.appendChild(renderSpecDraft(specBuildState.draft));
  }

  if (specBuildState.busy) {
    log.appendChild(
      el("div", { class: "pb-msg pb-bot pb-thinking" }, [
        el("span", { class: "pb-dot" }),
        el("span", { class: "pb-dot" }),
        el("span", { class: "pb-dot" }),
      ]),
    );
  }

  updateSpecBuildActions();
  log.scrollTop = log.scrollHeight;
}

/**
 * Composer state: the "Draft the spec" force button is always available so the
 * user is never stuck clarifying. Once a draft is on screen the chat's job is done
 * (edit/create takes over), so the whole composer is hidden.
 */
function updateSpecBuildActions() {
  if (!specBuildEls) return;
  const { forceBtn, form } = specBuildEls;
  const turns = specBuildState.history.filter((t) => t.role === "user").length;
  form.hidden = !!specBuildState.draft;
  if (specBuildState.draft) return;
  forceBtn.disabled = specBuildState.busy || turns === 0;
}

/**
 * Render the editable clause draft. Each clause is a kind chip (select) + editable
 * text + editable rationale, with a remove button; a footer allows adding a clause
 * and — once at least one clause exists — Create spec. After Create, the row swaps
 * to a Freeze action. All edits mutate the in-memory draft (the panel's UI state);
 * the persisted spec is only written on Create / Freeze.
 */
function renderSpecDraft(draft) {
  const clauses = draft.clauses || [];
  const created = specBuildState.createdSpec;
  const frozen = created && created.status === "frozen";
  const wrap = el("section", { class: "pb-proposal sb-draft", "aria-label": "Proposed spec" });

  wrap.appendChild(
    el("header", { class: "pb-proposal-head" }, [
      el("h3", { class: "pb-proposal-name" }, "Proposed spec"),
      el(
        "p",
        { class: "pb-proposal-aux" },
        `${frozen ? "Frozen: in the playbook" : created ? "Created as a draft spec" : "A draft: edit any clause"} · ${plural(clauses.length, "clause")}`,
      ),
    ]),
  );

  // Title field — required by create_spec; defaults to the brief. Editable until
  // the spec is created (immutable server-side after that).
  const titleInput = el("input", {
    class: "sb-title",
    type: "text",
    value: specBuildState.title || "",
    placeholder: "Spec title",
    "aria-label": "Spec title",
    maxlength: "300",
    disabled: created ? "" : undefined,
  });
  titleInput.addEventListener("input", () => {
    specBuildState.title = titleInput.value;
    updateSpecCreateEnabled();
  });
  wrap.appendChild(field("Title", titleInput, { class: "sb-title-field" }));

  // Target repo — which repo this spec is FOR. Sent as `target_repo` on Create so
  // the clauses the freeze seeds into Memory carry that repo tag; the delivery
  // primer searches lore per repo, so an untagged clause never reaches an agent.
  // Optional (an org-wide spec may span repos), locked once the spec is created.
  const repos = specBuildState.repos || [];
  const repoSel = el(
    "select",
    {
      class: "select sb-target-repo",
      "aria-label": "Target repo",
      disabled: created ? "" : undefined,
    },
    [
      el("option", { value: "" }, repos.length ? "No target repo (org-wide)" : "No repos known"),
      ...repos.map((r) =>
        el(
          "option",
          { value: r.name, selected: specBuildState.targetRepo === r.name ? "" : undefined },
          r.name,
        ),
      ),
    ],
  );
  if (created && created.target_repo && !repos.some((r) => r.name === created.target_repo)) {
    repoSel.appendChild(
      el("option", { value: created.target_repo, selected: "" }, created.target_repo),
    );
  }
  repoSel.addEventListener("change", () => {
    specBuildState.targetRepo = repoSel.value;
  });
  repoSel.title = "Tags the lore seeded at freeze so this repo's delivery agents see it.";
  wrap.appendChild(field("Target repo", repoSel, { class: "sb-target-repo-field" }));

  const list = el("ol", { class: "pb-tickets sb-clauses" });
  clauses.forEach((clause, i) => list.appendChild(renderSpecClauseRow(clause, i, !!created)));
  wrap.appendChild(list);

  if (!created) {
    wrap.appendChild(
      el("div", { class: "sb-add-row" }, [
        el(
          "button",
          {
            class: "btn sb-add",
            type: "button",
            onclick: () => {
              specBuildState.draft.clauses.push({ kind: "requirement", text: "", rationale: "" });
              renderSpecBuildLog();
            },
          },
          [icon("plus"), el("span", {}, "Add clause")],
        ),
      ]),
    );
  }

  // Persistent error slot (not just a toast) — mirrors pb-error-msg styling.
  if (specBuildState.actionError) {
    wrap.appendChild(
      el("div", { class: "pb-msg pb-bot pb-error-msg sb-action-error" }, [
        el("div", { class: "pb-bot-label" }, "Action failed"),
        el("div", {}, specBuildState.actionError),
      ]),
    );
  }

  const confirmRow = el("div", { class: "pb-confirm-row" });
  if (!created) {
    const createBtn = el(
      "button",
      {
        class: "btn primary sb-create",
        type: "button",
        onclick: () => createSpecFromDraft(),
      },
      [icon("check"), el("span", {}, "Create spec")],
    );
    confirmRow.appendChild(
      el(
        "p",
        { class: "pb-confirm-note dim" },
        `${clauses.length} clause${clauses.length === 1 ? "" : "s"}, created as a draft spec you can freeze when ready.`,
      ),
    );
    confirmRow.appendChild(createBtn);
  } else if (!frozen) {
    confirmRow.appendChild(
      el(
        "p",
        { class: "pb-confirm-note dim" },
        "Spec created as draft. Freeze to lock the clauses and seed product-intent lore.",
      ),
    );
    confirmRow.appendChild(
      el(
        "button",
        { class: "btn primary sb-freeze", type: "button", onclick: () => freezeCreatedSpec() },
        [icon("check"), el("span", {}, "Freeze spec")],
      ),
    );
  } else {
    confirmRow.appendChild(
      el(
        "p",
        { class: "pb-confirm-note dim" },
        "Spec frozen: its clauses can no longer change. Plan a build from it, and each ticket carries the clauses it proves.",
      ),
    );
    confirmRow.appendChild(
      el(
        "button",
        { class: "btn primary sb-build", type: "button", onclick: () => buildFromFrozenSpec() },
        [icon("check"), el("span", {}, "Build the tickets from this spec")],
      ),
    );
  }
  wrap.appendChild(confirmRow);
  return wrap;
}

/** One editable clause row: kind chip + text + rationale + remove. */
function renderSpecClauseRow(clause, i, locked) {
  const kindSel = el(
    "select",
    {
      class: "select sb-kind",
      "aria-label": `Clause ${i + 1} kind`,
      disabled: locked ? "" : undefined,
    },
    SPEC_CLAUSE_KINDS.map((k) =>
      el("option", { value: k, selected: clause.kind === k ? "" : undefined }, k),
    ),
  );
  kindSel.addEventListener("change", () => {
    specBuildState.draft.clauses[i].kind = kindSel.value;
  });

  const textArea = el("textarea", {
    class: "pb-input sb-clause-text",
    rows: "2",
    value: clause.text || "",
    placeholder: "One testable statement…",
    "aria-label": `Clause ${i + 1} text`,
    disabled: locked ? "" : undefined,
  });
  textArea.value = clause.text || "";
  textArea.addEventListener("input", () => {
    specBuildState.draft.clauses[i].text = textArea.value;
    updateSpecCreateEnabled();
  });

  const rationaleInput = el("input", {
    class: "sb-clause-rationale",
    type: "text",
    value: clause.rationale || "",
    placeholder: "Rationale (optional)",
    "aria-label": `Clause ${i + 1} rationale`,
    disabled: locked ? "" : undefined,
  });
  rationaleInput.addEventListener("input", () => {
    specBuildState.draft.clauses[i].rationale = rationaleInput.value;
  });

  const top = el("div", { class: "pb-ticket-top sb-clause-top" }, [
    el("span", { class: "sb-clause-no tabnum", "aria-hidden": "true" }, String(i + 1)),
    kindSel,
    !locked
      ? el(
          "button",
          {
            class: "icon-btn sb-remove",
            type: "button",
            "aria-label": `Remove clause ${i + 1}`,
            onclick: () => {
              specBuildState.draft.clauses.splice(i, 1);
              renderSpecBuildLog();
            },
          },
          el("span", { html: "✕" }),
        )
      : null,
  ]);

  return el("li", { class: "pb-ticket sb-clause" }, [top, textArea, rationaleInput]);
}

/** Enable/disable the Create button live from title + at-least-one-non-empty-clause. */
function updateSpecCreateEnabled() {
  if (!specBuildEls) return;
  const btn = specBuildEls.panel.querySelector(".sb-create");
  if (!btn) return;
  const clauses = (specBuildState.draft && specBuildState.draft.clauses) || [];
  const ok =
    (specBuildState.title || "").trim().length > 0 && clauses.some((c) => (c.text || "").trim());
  btn.disabled = !ok || specBuildState.busy;
}

/**
 * Send the next spec-author turn. Mirrors submitPlanBuildTurn: append the user
 * message, POST /spec-build, fold the reply (clarify → questions; spec → editable
 * draft; error → persistent in-chat error + toast). `forcePlan` drafts the spec now.
 */
async function submitSpecBuildTurn(opts = {}) {
  const forcePlan = opts.forcePlan === true;
  const { input, sendBtn } = specBuildEls;
  const text = input.value.trim();
  if (specBuildState.busy) return;
  if (!forcePlan && !text) return;

  const isFirst = specBuildState.history.length === 0;
  if (forcePlan && isFirst && !text) {
    toast("Tell me what to build first, then I can draft the spec.");
    return;
  }

  if (text) {
    if (isFirst) {
      specBuildState.brief = text;
      // Seed a sensible default title from the brief (editable in the draft view).
      specBuildState.title = text.slice(0, 120);
    }
    specBuildState.history.push(
      isFirst ? { role: "user", brief: text } : { role: "user", answer: text },
    );
    input.value = "";
    input.style.height = "auto";
  }

  specBuildState.busy = true;
  sendBtn.disabled = true;
  sendBtn.classList.add("is-running");
  sendBtn.setAttribute("aria-busy", "true");
  clear(sendBtn);
  sendBtn.appendChild(el("span", { class: "btn-spinner", "aria-hidden": "true" }));
  sendBtn.appendChild(el("span", { class: "pb-send-label" }, "Drafting…"));
  renderSpecBuildLog();

  let failure = null;
  try {
    const res = await api("POST", "/spec-build", {
      brief: specBuildState.brief,
      history: specBuildState.history
        .filter((t) => !(t.role === "assistant" && t.error))
        .map((t) => (t.role === "user" && t.brief ? { role: "user", answer: t.brief } : t)),
      ...(forcePlan ? { forcePlan: true } : {}),
    });
    if (res.phase === "clarify") {
      specBuildState.history.push({ role: "assistant", questions: res.questions || [] });
    } else if (res.phase === "spec") {
      const clauses = (res.spec && Array.isArray(res.spec.clauses) ? res.spec.clauses : []).map(
        (c) => ({
          clause_id: c.clause_id,
          kind: SPEC_CLAUSE_KINDS.includes(c.kind) ? c.kind : "requirement",
          text: c.text || "",
          rationale: c.rationale || "",
        }),
      );
      specBuildState.draft = { clauses };
    } else {
      failure = res.error || "The spec author returned no result.";
    }
  } catch (e) {
    failure = e && e.message ? e.message : "The request errored before a spec came back.";
  }

  specBuildState.busy = false;
  if (failure) {
    specBuildState.history.push({ role: "assistant", error: failure });
    toast(failure, { code: "SPEC_BUILD" });
  }
  sendBtn.disabled = false;
  sendBtn.classList.remove("is-running");
  sendBtn.removeAttribute("aria-busy");
  clear(sendBtn);
  sendBtn.appendChild(icon("send"));
  renderSpecBuildLog();
}

/** Human confirm → POST /specs. Clauses land as a draft spec, then Freeze appears. */
async function createSpecFromDraft() {
  if (!specBuildState || !specBuildState.draft || specBuildState.busy) return;
  const title = (specBuildState.title || "").trim();
  if (!title) {
    toast("Give the spec a title first.");
    return;
  }
  // Only send non-empty clauses; the server rejects blank text at its boundary.
  const clauses = specBuildState.draft.clauses
    .filter((c) => (c.text || "").trim())
    .map((c) => ({
      ...(c.clause_id ? { clause_id: c.clause_id } : {}),
      kind: c.kind,
      text: c.text.trim(),
      ...(c.rationale && c.rationale.trim() ? { rationale: c.rationale.trim() } : {}),
    }));
  if (clauses.length === 0) {
    toast("Add at least one clause with text before creating the spec.");
    return;
  }

  specBuildState.busy = true;
  specBuildState.actionError = null;
  renderSpecBuildLog();
  try {
    const res = await api("POST", "/specs", {
      title,
      ...(specBuildState.brief ? { brief: specBuildState.brief } : {}),
      clauses,
      // The repo this spec is for. The freeze tags every seeded clause with it so the
      // delivery primer's per-repo lore search surfaces the clauses to that repo's
      // agents; omitted (org-wide) when none was picked.
      ...(specBuildState.targetRepo ? { target_repo: specBuildState.targetRepo } : {}),
    });
    specBuildState.createdSpec = res.spec || null;
    // Reflect the server-assigned clause ids/order back into the editable draft.
    if (res.spec && Array.isArray(res.spec.clauses)) {
      specBuildState.draft = {
        clauses: res.spec.clauses.map((c) => ({
          clause_id: c.clause_id,
          kind: c.kind,
          text: c.text,
          rationale: c.rationale || "",
        })),
      };
    }
    toast("Spec created as a draft. Freeze it when it is ready.", { ok: true });
  } catch (e) {
    // Persistent error (rendered in the draft card), plus a toast for immediacy.
    specBuildState.actionError = e && e.message ? e.message : "Could not create the spec.";
    toast(specBuildState.actionError, { code: e && e.code });
  } finally {
    specBuildState.busy = false;
    renderSpecBuildLog();
  }
}

/** Freeze the created spec → immutable clauses + seeded product-intent lore. */
async function freezeCreatedSpec() {
  if (!specBuildState || !specBuildState.createdSpec || specBuildState.busy) return;
  const id = specBuildState.createdSpec.id;
  specBuildState.busy = true;
  specBuildState.actionError = null;
  renderSpecBuildLog();
  try {
    const res = await api("POST", `/specs/${id}/freeze`);
    specBuildState.createdSpec = res.spec || specBuildState.createdSpec;
    toast("Spec frozen: its clauses can no longer change.", { ok: true });
  } catch (e) {
    specBuildState.actionError = e && e.message ? e.message : "Could not freeze the spec.";
    toast(specBuildState.actionError, { code: e && e.code });
  } finally {
    specBuildState.busy = false;
    renderSpecBuildLog();
  }
}

/**
 * Hand a FROZEN spec off to the "Plan a build" decomposer. Its clauses ride along on the
 * plan-build POST so the decomposer satisfies each clause and stamps spec_clause_id
 * provenance on the ACs — the coverage/traceability read model depends on this. Closes the
 * spec panel and opens plan-build seeded with the clauses + a brief; the user then presses
 * "Build the tickets". Without this handoff the frozen spec never reaches decompose and the
 * Specs coverage view reads 0% for every spec even when the work fully delivers.
 */
function buildFromFrozenSpec() {
  const spec = specBuildState && specBuildState.createdSpec;
  if (!spec || spec.status !== "frozen") return;
  // The server's spec row carries its clauses as `clauses_json` (a string); only a
  // locally built object has a `clauses` array. Reading only the array made this
  // button do nothing at all on a real spec.
  let raw = spec.clauses;
  if (!Array.isArray(raw)) {
    try {
      raw = JSON.parse(spec.clauses_json || "[]");
    } catch {
      raw = [];
    }
  }
  const clauses = (Array.isArray(raw) ? raw : [])
    .filter((c) => c && c.clause_id && c.kind && c.text)
    .map((c) => ({
      clause_id: c.clause_id,
      kind: c.kind,
      text: c.text,
      ...(c.rationale ? { rationale: c.rationale } : {}),
    }));
  if (!clauses.length) return;
  const brief =
    (specBuildState && specBuildState.brief) ||
    spec.brief ||
    spec.title ||
    "Build from the frozen spec.";
  closeSpecBuild();
  // Carry the spec's target repo into the plan: the decomposer then takes the
  // existing-repo (brownfield) path for that repo instead of scaffolding a new one.
  openPlanBuild({ spec: clauses, brief, ...(spec.target_repo ? { repo: spec.target_repo } : {}) });
}

// --- View: Memory (Repo Digest · Feature ledger · Lore) ---------------------
//
// The unified control room reads the SEPARATE memory product (memory) through
// the Dispatch API's server-side read endpoints — ONE origin, one process. This
// view surfaces three read-only memory artefacts and never mutates anything:
//   • Repo Digest   — the repo's understanding (overview/structure/conventions/
//                     stack) with its freshness line + honesty caveat.
//   • Features      — the ledger split Shipped / Building / Backlog,
//                     filterable by scope node.
//   • Lore          — the team's recorded lore (read-only).
//
// Memory is OPTIONAL: each endpoint answers `{ available:false, reason }` when
// the memory store isn't configured/built, and this view renders a clean
// "memory unavailable" panel from that — it never errors the dashboard.

const FEATURE_GROUPS = [
  { status: "shipped", label: "Shipped", note: "Live in the repo." },
  { status: "building", label: "Building", note: "In flight right now." },
  { status: "backlog", label: "Backlog", note: "Proposed, not yet started." },
];

// Hash-driven so links + the router re-render cleanly:
//   #/memory                      → repo picker, nothing selected
//   #/memory/<repo>               → digest + features + lore for <repo>
//   #/memory/<repo>?node=<n>      → features narrowed to one scope node
const memoryState = { repo: "", node: "" };

function writeMemoryStateToUrl() {
  const repo = memoryState.repo;
  if (!repo) {
    navigate("#/memory");
    return;
  }
  const qs = memoryState.node ? `?node=${encodeURIComponent(memoryState.node)}` : "";
  navigate(`#/memory/${encodeURIComponent(repo)}${qs}`);
}

/** Render the structured "memory unavailable" panel from an unavailable result. */
function memoryUnavailable(reason) {
  return el("div", { class: "memory-unavailable", dataset: { state: "unavailable" } }, [
    el("p", { class: "es-title" }, "Memory unavailable"),
    el("p", { class: "es-sub" }, reason || "The memory product is not reachable right now."),
    el("p", { class: "section-note" }, [
      "The dashboard keeps working without it. Configure the memory CLI (",
      el("code", { class: "mono" }, "MEMORY_CLI_BIN"),
      " + ",
      el("code", { class: "mono" }, "MEMORY_DB"),
      ") on the Dispatch server to light these surfaces up.",
    ]),
  ]);
}

/**
 * "Onboard a repo" — POST /repos/onboard to scan a repo, register it in Dispatch,
 * and build its Memory digest + feature inventory (the data the Repo Digest +
 * Feature ledger below read). The endpoint spawns the configured DISPATCH_ONBOARD_CMD
 * detached, so the scan + digest build run async; we show an immediate running state
 * (via the shared runAsyncAction helper the other spawn buttons use), then re-read the
 * Memory view so the freshly-built digest + features surface. A NOT_CONFIGURED (no
 * DISPATCH_ONBOARD_CMD) toasts its message via the shared guard. `presetRepo` (when
 * given) pre-selects the repo so the digest empty-state can offer "onboard THIS repo".
 */
/**
 * Does Memory already hold a digest for this registered repo? true / false, or null when
 * it cannot say (memory unavailable, the read failed): the caller then asks first.
 */
async function repoHasDigest(name) {
  try {
    const res = await api("GET", `/api/memory/digest/${encodeURIComponent(name)}`);
    if (!res || res.available === false) return null;
    return !!res.digest;
  } catch {
    return null;
  }
}

/**
 * The "Onboard a repo" sheet: a registered repo (the select) OR a typed path. What the
 * person typed wins: typing a path resets the select, and picking a repo clears the
 * path. Onboarding a repo Memory already knows (it has a digest, or that cannot be
 * read) is a deliberate choice: a confirmation names the cost before anything runs.
 * `opts.onboarded` maps repo name → whether it has a digest, when the caller knows.
 */
function openOnboardPicker(repos, presetRepo, opts = {}) {
  const known = opts.onboarded || {};
  const repoSel = el("select", {}, [
    el("option", { value: "" }, repos.length ? "Pick a registered repo…" : "No registered repos"),
    ...repos.map((r) => el("option", { value: r.name, selected: presetRepo === r.name }, r.name)),
  ]);
  const pathInput = el("input", {
    type: "text",
    name: "onboard-path",
    placeholder: "/path/to/a/local/repo",
    autocomplete: "off",
    spellcheck: "false",
  });
  if (presetRepo) repoSel.value = presetRepo;
  pathInput.addEventListener("input", () => {
    if (pathInput.value.trim()) repoSel.value = "";
  });
  repoSel.addEventListener("change", () => {
    if (repoSel.value) pathInput.value = "";
  });

  const bare = (p) => String(p || "").replace(/\/+$/, "");
  const runBtn = el("button", { class: "btn primary", type: "submit" }, "Onboard");
  const form = el(
    "form",
    {
      class: "form-grid",
      onsubmit: (e) => {
        e.preventDefault();
        // A typed path wins over the select; the endpoint resolves which kind it is.
        const typed = pathInput.value.trim();
        const target = typed || repoSel.value.trim();
        if (!target) {
          toast("Pick a registered repo or type a path to onboard.");
          return;
        }
        // A registered repo by name, or a typed path that is its checkout.
        const registered = repos.find(
          (r) => r.name === target || (typed && r.local_path && bare(r.local_path) === bare(typed)),
        );
        const go = async () => {
          await api("POST", "/repos/onboard", { repo: target });
          toast(`Onboarding '${target}' — its digest + features will appear shortly.`, {
            ok: true,
          });
          if (sheetOpen()) closeSheet();
          // Re-read the Memory view focused on the onboarded repo so the digest +
          // feature ledger refresh once the producer lands them.
          memoryState.repo = registered ? registered.name : memoryState.repo;
          memoryState.node = "";
          writeMemoryStateToUrl();
          router();
        };
        if (!registered) {
          runAsyncAction(runBtn, "Onboarding…", go);
          return;
        }
        runAsyncAction(runBtn, "Checking…", async () => {
          const name = registered.name;
          const has = name in known ? known[name] : await repoHasDigest(name);
          if (has === false) {
            await go();
            return;
          }
          confirmSheet({
            title: `Onboard ${name} again?`,
            intro:
              `${name} is ${has ? "already onboarded: Memory holds its digest and feature inventory" : "already registered, and Memory may already hold its digest"}, ` +
              "and refreshes them itself as agents deliver. Onboarding it again cards the whole repo once more: " +
              "several minutes and model calls for a larger repo, and a fresh onboarding intake decision on the Team Sheet.",
            confirm: `Re-onboard ${name}`,
            onConfirm: go,
          });
        });
      },
    },
    [
      el(
        "p",
        { class: "mode-note dim" },
        "Scans the repo, registers it in Dispatch, and builds its Memory digest + feature inventory.",
      ),
      el(
        "p",
        { class: "mode-note dim" },
        "Cards the whole repo — a sizeable one-off (several minutes + model calls for larger repos). " +
          "Memory then refreshes itself incrementally as agents deliver, so you don't need to re-run it.",
      ),
      field("Registered repo", repoSel),
      el("div", { class: "or-divider dim" }, "or"),
      field("Local path", pathInput),
      el("div", { class: "btn-row" }, [runBtn]),
    ],
  );

  openSheet("Onboard a repo", form);
}

/** The Memory view's "Onboard a repo" trigger (header + empty-state share it). */
function onboardButton(repos, presetRepo, opts) {
  const o = opts || {};
  const pickerOpts = o.onboarded ? { onboarded: o.onboarded } : {};
  const btn = el(
    "button",
    {
      class: o.primary ? "btn primary" : "btn",
      type: "button",
      title: "Scan a repo and build its Memory digest + feature inventory",
      onclick: () => openOnboardPicker(repos, presetRepo, pickerOpts),
    },
    [icon("plus"), el("span", {}, o.label || "Onboard a repo")],
  );
  return roLock(btn, "repo");
}

// --- Specs (Spec-Driven Development, Phase 3: coverage & traceability) -------

const SPEC_STATUS_LABEL = { draft: "Draft", frozen: "Frozen", superseded: "Superseded" };
const CLAUSE_KIND_LABEL = {
  requirement: "Requirement",
  "non-goal": "Non-goal",
  decision: "Decision",
};
const LORE_STATUS_LABEL = {
  active: "reaching agents",
  draft: "unratified",
  absent: "not seeded",
  unknown: "",
};

/** Count clauses on a spec row without throwing on a malformed clauses_json. */
function specClauseCount(spec) {
  try {
    const parsed = JSON.parse(spec.clauses_json || "[]");
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Specs view. Two surfaces on one route: a list of specs (#/specs) and, for a
 * given spec (#/specs/:id), the coverage TRACE — each clause → its covering ACs
 * (satisfied vs open), the coverage gaps (orphan clauses) called out, per-clause
 * bounce counts, and the seeded-lore ratification status. Modelled on renderEpics.
 */
async function renderSpecs(param) {
  const specId = param ? decodeURIComponent(param) : "";
  return specId ? renderSpecDetail(specId) : renderSpecList();
}

/** A spec's status: its mark + its word (a lock when frozen: the clauses cannot change). */
function specStatusMark(status) {
  const word = SPEC_STATUS_LABEL[status] || status || "—";
  const mark =
    status === "frozen"
      ? icon("lock", "spec-lock", 16)
      : glyph(status === "superseded" ? "cancelled" : "draft", 16);
  return el("span", { class: `spec-card-status status-${status}` }, [mark, el("span", {}, word)]);
}

/** How many of a clause's covering criteria are met, of how many. */
function clauseMet(c) {
  const acs = Array.isArray(c.covering_acs) ? c.covering_acs : [];
  return { met: acs.filter((ac) => ac.satisfied).length, of: acs.length };
}

/**
 * One clause's coverage state (the data-state hook). The server's `satisfied`
 * flag is true when ANY covering criterion is met, so the state is read from the
 * criteria themselves: satisfied only when every one is met, partly met when
 * some are, open when none are. A clause is proven only when all of it is.
 */
function clauseState(c) {
  if (c.orphan) return "orphan";
  const { met, of } = clauseMet(c);
  if (!of) return c.satisfied ? "satisfied" : "open";
  return met === of ? "satisfied" : met > 0 ? "partial" : "open";
}

/** Clause kinds that record intent rather than behaviour: no criterion is not a gap. */
const INTENT_KINDS = new Set(["non-goal", "decision"]);

/**
 * A spec not built yet: a draft, or a frozen spec with no campaign playing it and
 * no criterion naming any clause (the state between "Freeze spec" and "Plan a
 * build from it"). Its clauses read "not covered yet" everywhere (the squares,
 * the board line, the lede and the list), never as gaps: nothing has failed.
 */
function specUnbuilt(status, clauses, scopeNodeId) {
  if (status === "draft") return true;
  return !scopeNodeId && !(clauses || []).some((c) => c.covered);
}

/**
 * A gap is a clause that should be proven and is not: a requirement of a spec
 * whose build is under way with no criterion covering it. A spec not built yet
 * (specUnbuilt) has no gaps by design, and a non-goal or a decision with no
 * criterion is not a failure; those read quietly, never red.
 */
function clauseIsGap(c, status, unbuilt = false) {
  return !!c.orphan && !unbuilt && status !== "draft" && !INTENT_KINDS.has(c.kind);
}

/** How many of a coverage payload's clauses are gaps (see clauseIsGap). */
function specGapCount(coverage, status) {
  const clauses = coverage && Array.isArray(coverage.clauses) ? coverage.clauses : null;
  if (clauses) {
    const unbuilt = specUnbuilt(status, clauses, coverage.scope_node_id);
    return clauses.filter((c) => clauseIsGap(c, status, unbuilt)).length;
  }
  const r = specCoverageRollup(coverage);
  return r && status !== "draft" && (r.covered || coverage.scope_node_id) ? r.orphans : 0;
}

/**
 * The form guide: one square per clause, in the order written — filled when
 * every criterion is met, outlined with a filled corner when some are, outlined
 * when covered but none is met yet, red when it is a gap, dashed when it has no
 * criterion and is not a gap (a spec not built yet, a non-goal, a decision).
 * Decorative next to the sentence that states the same counts.
 */
function specFormGuide(clauses, status, scopeNodeId) {
  const unbuilt = specUnbuilt(status, clauses, scopeNodeId);
  return el(
    "span",
    { class: "spec-form", "aria-hidden": "true" },
    clauses.map((c, i) => {
      const state = clauseState(c);
      const cls =
        state === "orphan" ? (clauseIsGap(c, status, unbuilt) ? "orphan" : "none") : state;
      return el(
        "i",
        {
          class: `fg fg-${cls}`,
          title: `Clause ${i + 1} (${CLAUSE_KIND_LABEL[c.kind] || c.kind}): ${c.text}`,
        },
        String(i + 1),
      );
    }),
  );
}

/**
 * "6 of 8 covered · 1 satisfied · 2 partly met · 1 gap" — the counts the form
 * guide draws. Satisfied means every criterion on the clause is met.
 */
function specCoverageWords(r, gaps) {
  if (!r) return "Coverage unavailable";
  if (!r.total) return "No clauses yet";
  if (!r.covered)
    return gaps
      ? `Nothing covered: ${plural(gaps, "gap")}`
      : `Not covered yet: no criterion names ${r.total === 1 ? "it" : "them"}`;
  return [
    `${r.covered} of ${r.total} covered`,
    r.satisfied != null ? `${r.satisfied} satisfied` : null,
    r.partial ? `${r.partial} partly met` : null,
    gaps ? plural(gaps, "gap") : "no gaps",
  ]
    .filter(Boolean)
    .join(" · ");
}

async function renderSpecList() {
  const signal = routeSignal();
  const res = await api("GET", "/specs", undefined, { signal });
  const specs = res.specs || [];

  const wrap = el("div", { class: "view view-specs", dataset: { view: "specs" } });
  const author = roLock(
    el("button", { class: "btn primary", type: "button", onclick: () => openSpecBuild() }, [
      icon("spark"),
      el("span", {}, "Author a spec"),
    ]),
  );
  const by = (st) => specs.filter((s) => s.status === st).length;
  wrap.appendChild(
    viewHead(
      "The playbook",
      specs.length
        ? [
            plural(specs.length, "spec"),
            by("frozen") ? `${by("frozen")} frozen` : null,
            by("draft") ? `${by("draft")} draft` : null,
            by("superseded") ? `${by("superseded")} superseded` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "No specs written yet.",
      author,
    ),
  );

  if (specs.length === 0) {
    // What is on the pitch without a written play: the campaigns and live tickets,
    // so the empty page still says something true about this club.
    const [nodesRes, ticketsRes] = await Promise.all([
      api("GET", "/scope/nodes", undefined, { signal }).catch(() => ({ nodes: [] })),
      allTickets("", { signal }).catch(() => ({ tickets: [] })),
    ]);
    const epics = (nodesRes.nodes || []).filter((n) => n.type === "epic");
    const live = (ticketsRes.tickets || []).filter((t) => !TERMINAL.has(t.status));
    wrap.appendChild(
      el("section", { class: "card playbook-empty" }, [
        panelHead("No specs yet", null, null, { kit: "ink" }),
        el(
          "div",
          { class: "pb-steps", role: "list" },
          [
            ["1", "The brief", "Say what to build in a paragraph."],
            ["2", "The clauses", "Gaffer drafts testable clauses; you edit them."],
            ["3", "Frozen", "Each clause is traced to the acceptance criteria that prove it."],
          ].map(([n, h, t]) =>
            el("div", { class: "pb-step", role: "listitem" }, [
              el("span", { class: "pb-n", "aria-hidden": "true" }, n),
              el("h3", {}, h),
              el("p", {}, t),
            ]),
          ),
        ),
        el(
          "p",
          { class: "pb-now" },
          epics.length || live.length
            ? [
                `Playing without a written spec right now: ${plural(epics.length, "campaign")}${epics.length ? ` (${epics.map((e) => e.name).join(", ")})` : ""} and ${plural(live.length, "live ticket")}. `,
                el("a", { href: "#/epics" }, "See the season"),
                ".",
              ]
            : "Nothing is on the pitch yet: a spec is a good first play.",
        ),
        el("div", { class: "btn-row" }, [
          roLock(
            el("button", { class: "btn primary", type: "button", onclick: () => openSpecBuild() }, [
              icon("spark"),
              el("span", {}, "Write the first play"),
            ]),
          ),
        ]),
      ]),
    );
    return wrap;
  }

  // Coverage per spec (best-effort: a failed read shows "Coverage unavailable" on
  // that row, never a broken page) and the campaign names the specs are played in.
  const [coverages, nodesRes] = await Promise.all([
    Promise.all(
      specs.map((s) =>
        api("GET", `/specs/${encodeURIComponent(s.id)}/coverage`, undefined, { signal })
          .then((r) => (r && r.coverage) || null)
          .catch(() => null),
      ),
    ),
    api("GET", "/scope/nodes", undefined, { signal }).catch(() => ({ nodes: [] })),
  ]);
  const covById = new Map(specs.map((s, i) => [s.id, coverages[i]]));
  const nodeName = new Map(((nodesRes && nodesRes.nodes) || []).map((n) => [n.id, n.name]));

  // The newest spec (by when it was written, the order the server lists them in)
  // is marked: it is the one most likely in play.
  const stamp = (x) => Date.parse(x.created_at || x.updated_at || 0) || 0;
  const newestId = specs.slice().sort((a, b) => stamp(b) - stamp(a))[0]?.id;

  const list = el("div", { class: "spec-list", role: "list" });
  for (const spec of specs)
    list.appendChild(
      el(
        "div",
        { role: "listitem" },
        renderSpecCard(spec, {
          coverage: covById.get(spec.id),
          isPrimary: spec.id === newestId,
          campaign: spec.scope_node_id ? nodeName.get(spec.scope_node_id) : null,
        }),
      ),
    );
  wrap.appendChild(
    el("section", { class: "card prog spec-plays", "aria-labelledby": "spec-plays-h" }, [
      (() => {
        const h = panelHead("The plays", `${plural(specs.length, "spec")}, as written`, null, {
          kit: "claret",
        });
        h.querySelector(".panel-title").id = "spec-plays-h";
        return h;
      })(),
      list,
      el("p", { class: "spec-key" }, [
        ...[
          ["satisfied", "1", "satisfied: every criterion met"],
          ["partial", "2", "partly met: some criteria met"],
          ["open", "3", "covered, none met yet"],
          ["orphan", "4", "a gap: a requirement nothing covers while it is built"],
          [
            "none",
            "5",
            "no criterion yet, not a gap (a spec not built yet, a non-goal, a decision)",
          ],
        ].map(([cls, n, words]) =>
          el("span", { class: "spec-key-item" }, [
            el("span", { class: "spec-form", "aria-hidden": "true" }, [
              el("i", { class: `fg fg-${cls}` }, n),
            ]),
            el("span", {}, words),
          ]),
        ),
        el("span", {}, "Each square is a clause, in the order written."),
      ]),
    ]),
  );
  return wrap;
}

/**
 * A rollup {total,covered,satisfied,partial,orphans} from a coverage payload,
 * defensively read. Satisfied and partly met are counted from the clauses when
 * they are there (clauseState): the server's own `satisfied` counts a clause
 * with any criterion met, which is not the same as proven.
 */
function specCoverageRollup(coverage) {
  const src =
    coverage && coverage.rollup && typeof coverage.rollup === "object" ? coverage.rollup : null;
  if (!src) return null;
  const total = Number(src.total) || 0;
  const covered = Number(src.covered) || 0;
  const orphans = Array.isArray(src.orphans) ? src.orphans.length : Number(src.orphans) || 0;
  const clauses = Array.isArray(coverage.clauses) ? coverage.clauses : null;
  if (clauses && clauses.length) {
    const states = clauses.map(clauseState);
    const n = (st) => states.filter((x) => x === st).length;
    return { total, covered, satisfied: n("satisfied"), partial: n("partial"), orphans };
  }
  const satisfied = src.satisfied != null ? Number(src.satisfied) || 0 : null;
  return { total, covered, satisfied, partial: 0, orphans };
}

/** One spec = one line of the playbook, linking to its clause-by-clause trace. */
function renderSpecCard(spec, { coverage, isPrimary = false, campaign = null } = {}) {
  const count = specClauseCount(spec);
  const rollup = specCoverageRollup(coverage);
  const clauses = coverage && Array.isArray(coverage.clauses) ? coverage.clauses : [];
  const statusLabel = SPEC_STATUS_LABEL[spec.status] || spec.status;
  const gaps = coverage ? specGapCount(coverage, spec.status) : 0;
  const words = specCoverageWords(rollup, gaps);
  return el(
    "a",
    {
      class: `spec-card${isPrimary ? " spec-card--primary" : ""}${gaps ? " has-gaps" : ""}`,
      href: `#/specs/${encodeURIComponent(spec.id)}`,
      dataset: { specId: spec.id, status: spec.status },
      "aria-label": `${spec.title}: ${statusLabel}, ${plural(count, "clause")}, ${words}${campaign ? `, played in ${campaign}` : ""}`,
    },
    [
      el("span", { class: "spec-card-lead" }, [
        specStatusMark(spec.status),
        isPrimary ? el("span", { class: "spec-card-new" }, "newest") : null,
      ]),
      el("span", { class: "spec-card-body" }, [
        el("span", { class: "spec-card-title" }, spec.title),
        spec.brief ? el("span", { class: "spec-card-brief" }, spec.brief) : null,
        el("span", { class: "spec-card-meta" }, [
          el("span", {}, plural(count, "clause")),
          spec.target_repo ? repoTag(spec.target_repo, 16) : null,
          campaign ? el("span", {}, `Campaign: ${campaign}`) : null,
          spec.updated_at ? el("span", {}, `updated ${fmtRelative(spec.updated_at)}`) : null,
        ]),
      ]),
      el("span", { class: "spec-card-cov" }, [
        clauses.length ? specFormGuide(clauses, spec.status, coverage.scope_node_id) : null,
        el("span", { class: `spec-card-words${gaps ? " is-red" : ""}` }, words),
      ]),
    ],
  );
}

async function renderSpecDetail(specId) {
  const signal = routeSignal();
  const [res, specRes, nodesRes] = await Promise.all([
    api("GET", `/specs/${encodeURIComponent(specId)}/coverage`, undefined, { signal }),
    api("GET", `/specs/${encodeURIComponent(specId)}`, undefined, { signal }).catch(() => null),
    api("GET", "/scope/nodes", undefined, { signal }).catch(() => ({ nodes: [] })),
  ]);
  const cov = res && res.coverage;
  // GET /specs/:id answers { spec }; tolerate a list-shaped answer too.
  const spec =
    (specRes && specRes.spec) ||
    ((specRes && specRes.specs) || []).find((s) => s.id === specId) ||
    null;

  const wrap = el("div", { class: "view view-spec", dataset: { view: "specs" } });
  const back = backLink("#/specs", "Back to the playbook");
  wrap.appendChild(back);

  // Defensive: a missing / empty / malformed coverage payload must render a
  // clean empty state, not blank the whole spec view.
  if (!cov || typeof cov !== "object") {
    wrap.appendChild(viewHead((spec && spec.title) || "Spec", "Coverage"));
    wrap.appendChild(
      emptyState(
        "Coverage unavailable",
        "This spec's coverage report could not be loaded. It may have been removed, or the report is still being built.",
        null,
        el("a", { class: "btn", href: "#/specs" }, "Back to the playbook"),
      ),
    );
    return wrap;
  }

  const clauses = Array.isArray(cov.clauses) ? cov.clauses : [];
  const r = specCoverageRollup(cov.rollup ? cov : { ...cov, rollup: {} });
  r.satisfied = r.satisfied || 0;
  const status = cov.status || (spec && spec.status) || "";
  const targetRepo = (spec && spec.target_repo) || cov.target_repo || null;
  const campaign = cov.scope_node_id
    ? ((nodesRes && nodesRes.nodes) || []).find((n) => n.id === cov.scope_node_id)
    : null;
  const brief = (spec && spec.brief) || cov.brief || null;

  // The lede: where the spec stands, from its coverage. A gap is a requirement
  // nothing proves while it is built (clauseIsGap); a spec not built yet (a draft,
  // or frozen with no campaign and nothing covering it) reads as one calm "not
  // covered yet" in the squares, the board, the lede and the list, never as red.
  const unbuilt = specUnbuilt(status, clauses, cov.scope_node_id);
  const gapClauses = clauses.filter((c) => clauseIsGap(c, status, unbuilt));
  const gapsN = gapClauses.length;
  const quietN = clauses.filter((c) => c.orphan && !clauseIsGap(c, status, unbuilt)).length;
  const uncovered = unbuilt && r.total > 0 && r.covered === 0;
  // "1 already satisfied and 2 partly met": satisfied means every criterion is met.
  const metWords =
    r.satisfied && r.partial
      ? `, ${r.satisfied} already satisfied and ${r.partial} partly met`
      : r.satisfied
        ? `, ${r.satisfied} already satisfied`
        : r.partial
          ? `, none fully proven yet: ${r.partial} partly met`
          : "";
  const quietOf = (k) => clauses.filter((c) => c.orphan && c.kind === k).length;
  const quietWords = [
    quietOf("non-goal") ? plural(quietOf("non-goal"), "non-goal") : null,
    quietOf("decision") ? plural(quietOf("decision"), "decision") : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const total = plural(r.total, "clause");
  let lede;
  if (!r.total)
    lede = [el("b", {}, `${SPEC_STATUS_LABEL[status] || "Spec"}. `), "It has no clauses yet."];
  else if (uncovered)
    lede = [
      el("b", {}, `${SPEC_STATUS_LABEL[status] || "Spec"}. `),
      // Not built yet: said the same way here, on the board, and in the list.
      status === "draft"
        ? `Not covered yet, and no gaps: freeze it to lock its ${total} and seed them as lore for the agents; the criteria that prove them come with the build you plan from it.`
        : status === "frozen"
          ? `Not covered yet, and no gaps until it is built: plan a build from it, and each ticket's criteria will name the ${r.total === 1 ? "clause it proves" : "clauses they prove"}.`
          : `None of its ${total} is covered.`,
    ];
  else
    lede = [
      el("b", {}, `${SPEC_STATUS_LABEL[status] || "Spec"}. `),
      `${r.covered} of its ${total} ${r.covered === 1 ? "is" : "are"} covered by acceptance criteria${metWords}.`,
      gapsN
        ? [
            " ",
            el(
              "span",
              { class: "is-red" },
              `${gapsN === 1 ? "1 requirement has" : `${gapsN} requirements have`} no criterion, so nothing proves ${gapsN === 1 ? "it" : "them"} yet.`,
            ),
          ]
        : "",
      quietN
        ? status === "draft"
          ? ` ${quietN} ${quietN === 1 ? "is" : "are"} not covered yet.`
          : ` ${quietWords} ${quietN === 1 ? "has" : "have"} none, which is not counted as a gap.`
        : !gapsN
          ? " Every clause has a criterion."
          : "",
      status === "draft"
        ? " Freeze it to lock the clauses and seed them as lore for the agents."
        : "",
    ];

  const actions = [];
  if (cov.scope_node_id) {
    actions.push(
      el(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: () => navigate(`#/epics/${encodeURIComponent(cov.scope_node_id)}`),
        },
        [icon("epics"), el("span", {}, "Open campaign")],
      ),
    );
  }
  if (status === "draft") {
    actions.unshift(
      roLock(
        el(
          "button",
          {
            class: "btn primary",
            type: "button",
            onclick: (e) =>
              runAsyncAction(e.currentTarget, "Freezing…", async () => {
                await api("POST", `/specs/${encodeURIComponent(specId)}/freeze`);
                toast("Spec frozen: its clauses are locked and seeded as lore.", { ok: true });
                router();
              }),
          },
          [icon("lock", "", 18), el("span", {}, "Freeze spec")],
        ),
      ),
    );
  } else if (status === "frozen" && !cov.scope_node_id && clauses.length) {
    // A frozen spec with no campaign yet: build one from it, clause provenance and all.
    actions.unshift(
      el(
        "button",
        {
          class: "btn primary",
          type: "button",
          onclick: () =>
            openPlanBuild({
              spec: clauses
                .filter((c) => c.clause_id && c.kind && c.text)
                .map((c) => ({
                  clause_id: c.clause_id,
                  kind: c.kind,
                  text: c.text,
                  ...(c.rationale ? { rationale: c.rationale } : {}),
                })),
              brief: brief || cov.title || "Build from the frozen spec.",
              ...(targetRepo ? { repo: targetRepo } : {}),
            }),
        },
        [icon("spark"), el("span", {}, "Plan a build from it")],
      ),
    );
    roLock(actions[0]);
  }

  wrap.appendChild(
    el("header", { class: "spec-head" }, [
      el("p", { class: "spec-meta" }, [
        specStatusMark(status),
        targetRepo ? repoTag(targetRepo, 20) : el("span", {}, "Every repo"),
        campaign
          ? el(
              "a",
              { href: `#/epics/${encodeURIComponent(campaign.id)}` },
              `Campaign: ${campaign.name}`,
            )
          : null,
        el("span", {}, plural(r.total, "clause")),
        spec && spec.updated_at ? el("span", {}, `updated ${fmtRelative(spec.updated_at)}`) : null,
      ]),
      el("h1", { class: "detail-title" }, cov.title || (spec && spec.title) || "Spec"),
      el("p", { class: "spec-lede" }, lede),
      brief ? el("p", { class: "spec-brief" }, [el("b", {}, "The brief: "), `“${brief}”`]) : null,
      actions.length ? el("div", { class: "btn-row" }, actions) : null,
    ]),
  );

  const indexOf = new Map(clauses.map((c, i) => [c.clause_id, i + 1]));
  // Coverage gaps: requirements nothing proves, called out first. Only when some
  // clauses are covered: a spec nothing covers yet says so once, on the board.
  if (gapsN > 0 && !uncovered) {
    wrap.appendChild(
      el(
        "section",
        {
          class: "card coverage-gaps",
          dataset: { count: String(gapsN) },
          "aria-label": "Coverage gaps",
        },
        [
          panelHead(
            `${gapsN} coverage gap${gapsN === 1 ? "" : "s"}`,
            `${gapsN === 1 ? "a requirement" : "requirements"} with no acceptance criterion covering ${gapsN === 1 ? "it" : "them"}`,
            null,
            { kit: "red" },
          ),
          el(
            "ul",
            { class: "coverage-gaps-list" },
            gapClauses.map((c) =>
              el("li", { dataset: { clauseId: c.clause_id } }, [
                el(
                  "a",
                  {
                    class: "sc-no",
                    href: `#clause-${indexOf.get(c.clause_id) || ""}`,
                    "aria-label": `Clause ${indexOf.get(c.clause_id) || ""}, in the trace below`,
                  },
                  String(indexOf.get(c.clause_id) || ""),
                ),
                el("span", { class: "cg-text" }, c.text),
              ]),
            ),
          ),
          el(
            "p",
            { class: "cg-hint" },
            "Cover a gap with an acceptance criterion that names the clause, on the ticket that delivers it.",
          ),
        ],
      ),
    );
  }

  // Lore and bounces are said once for the spec when every clause shares them,
  // and per clause only where they differ.
  const loreSet = new Set(clauses.map((c) => c.lore_status || "unknown"));
  const loreOnce = loreSet.size === 1 ? [...loreSet][0] : null;
  const anyBounce = clauses.some((c) => c.bounce_count > 0);
  const notes = [];
  const uncoveredNote = !uncovered
    ? null
    : el("p", { class: "spec-board-note spec-uncovered" }, [
        glyph("draft", 16),
        el(
          "span",
          {},
          `Not covered yet: none of the ${total} has an acceptance criterion naming it. That is not a gap until a build is under way.`,
        ),
      ]);
  if (loreOnce && loreOnce !== "unknown")
    notes.push(
      el(
        "p",
        { class: "spec-board-note" },
        loreOnce === "active"
          ? "Lore: every clause is seeded and reaching the agents."
          : loreOnce === "draft"
            ? [
                "Lore: every clause is seeded as draft lore, unratified, so it is not reaching the agents yet. ",
                el("a", { href: "#/memory" }, "Ratify it in Memory"),
                ".",
              ]
            : `Lore: no clause is seeded yet.${status === "draft" ? " Freezing the spec seeds them." : ""}`,
      ),
    );
  if (anyBounce)
    notes.push(
      el(
        "p",
        { class: "spec-board-note" },
        "Bounced: how many times work on the tickets covering a clause was sent back.",
      ),
    );

  // The trace: one row per clause → its covering ACs → satisfied / open.
  const opts = { status, uncovered, unbuilt, loreOnce };
  const trace = el(
    "ol",
    { class: "spec-trace" },
    clauses.map((c, i) => el("li", { id: `clause-${i + 1}` }, renderClauseTrace(c, i + 1, opts))),
  );
  wrap.appendChild(
    progPage(
      "spec-clauses",
      "ink",
      "The clauses",
      `${plural(clauses.length, "clause")}, in the order written`,
      [
        specFormGuide(clauses, status, cov.scope_node_id),
        uncoveredNote,
        trace,
        notes.length ? el("div", { class: "spec-board-notes" }, notes) : null,
      ],
    ),
  );

  if (cov.gate_enabled) {
    wrap.appendChild(
      el(
        "p",
        { class: "section-note" },
        "The spec-coverage gate is on (advisory): a clause with no met criterion is flagged at the Definition of Done.",
      ),
    );
  }
  return wrap;
}

/**
 * One clause's trace row: its number, kind and text, its state, and the criteria
 * that prove it. A gap is red; a clause with no criterion that is not a gap is
 * quiet; when nothing in the spec is covered yet the board says so once and the
 * rows carry no state of their own.
 */
function renderClauseTrace(
  clause,
  n,
  { status, uncovered = false, unbuilt = false, loreOnce = null } = {},
) {
  const state = clauseState(clause);
  const isGap = clauseIsGap(clause, status, unbuilt);
  const acs = Array.isArray(clause.covering_acs) ? clause.covering_acs : [];
  const { met } = clauseMet(clause);
  const block = el("div", {
    class: `spec-clause${isGap ? " is-gap" : ""}`,
    dataset: {
      clauseId: clause.clause_id,
      state,
      covered: String(clause.covered),
      orphan: String(clause.orphan),
      // Proven: every covering criterion met (the server's flag means "any").
      satisfied: String(state === "satisfied"),
      met: String(met),
    },
  });
  const ofMet = acs.length > 1 ? ` · ${met} of ${acs.length} met` : "";
  const stateMark =
    state === "orphan"
      ? uncovered
        ? null
        : isGap
          ? el("span", { class: "sc-state is-red" }, [
              glyph("failed", 16),
              el("span", {}, "Gap: nothing proves it"),
            ])
          : el("span", { class: "sc-state is-quiet" }, [
              glyph("draft", 16),
              el("span", {}, status === "draft" ? "Not covered yet" : "No criterion"),
            ])
      : state === "satisfied"
        ? el("span", { class: "sc-state is-ok" }, [
            glyph("done", 16),
            el("span", {}, acs.length > 1 ? `Satisfied · all ${acs.length} met` : "Satisfied"),
          ])
        : state === "partial"
          ? el("span", { class: "sc-state is-part" }, [
              glyph("in_progress", 16),
              el("span", {}, `Partly met · ${met} of ${acs.length}`),
            ])
          : el("span", { class: "sc-state" }, [glyph("ready", 16), el("span", {}, `Open${ofMet}`)]);

  const tags = el("div", { class: "spec-clause-tags" }, [stateMark]);
  if (clause.bounce_count > 0) {
    const b = badge(`bounced ${clause.bounce_count}×`, "clause-bounce");
    b.title = `Work covering this clause was sent back ${plural(clause.bounce_count, "time")}`;
    tags.appendChild(b);
  }
  if (!loreOnce && clause.lore_status && clause.lore_status !== "unknown") {
    const label = LORE_STATUS_LABEL[clause.lore_status] || clause.lore_status;
    tags.appendChild(
      badge(
        `lore: ${clause.lore_status}${label ? ` (${label})` : ""}`,
        `lore-${clause.lore_status === "active" ? "active" : "draft"}`,
      ),
    );
  }

  const main = el("div", { class: "spec-clause-main" }, [
    el("div", { class: "spec-clause-head" }, [
      badge(CLAUSE_KIND_LABEL[clause.kind] || clause.kind, `clause-kind kind-${clause.kind}`),
      el("span", { class: "spec-clause-text" }, clause.text),
    ]),
    clause.rationale ? el("p", { class: "spec-clause-rationale" }, clause.rationale) : null,
  ]);
  if (acs.length) {
    main.appendChild(
      el(
        "ul",
        { class: "spec-clause-acs" },
        acs.map((ac) =>
          el("li", { class: "spec-ac", dataset: { satisfied: String(ac.satisfied) } }, [
            glyph(ac.satisfied ? "done" : "ready", 14, ac.satisfied ? "satisfied" : ac.ac_status),
            el("span", { class: "spec-ac-text" }, ac.ac_text),
            // The ticket and its status are one unit: they never wrap apart.
            el("span", { class: "spec-ac-tk" }, [
              el(
                "a",
                {
                  class: "spec-ac-ticket",
                  href: `#/ticket/${encodeURIComponent(ac.ticket_id)}`,
                  title: ac.ticket_title || "",
                },
                ac.ticket_number != null ? `#${ac.ticket_number}` : ac.ticket_title,
              ),
              ac.ticket_status
                ? el("span", { class: "spec-ac-st" }, statusLabel(ac.ticket_status))
                : null,
            ]),
          ]),
        ),
      ),
    );
  }
  block.appendChild(el("span", { class: "sc-no", "aria-hidden": "true" }, String(n)));
  block.appendChild(main);
  block.appendChild(tags);
  return block;
}

async function renderMemory(param) {
  const { query } = parseHash();
  memoryState.repo = param ? decodeURIComponent(param) : "";
  memoryState.node = query.get("node") || "";
  const signal = routeSignal();

  // The repos, and every draft across the club in one read: the drafts say which
  // repo needs the gaffer (its tab carries a yellow card), and which repo to open
  // when the address names none (the one whose draft is newest).
  const [reposRes, draftsRes] = await Promise.all([
    api("GET", "/repositories", undefined, { signal }),
    api("GET", "/api/memory/lore?status=draft&limit=200", undefined, { signal }).catch(() => null),
  ]);
  const repos = reposRes.repositories || [];
  const allDrafts =
    draftsRes && draftsRes.available !== false && Array.isArray(draftsRes.lore)
      ? draftsRes.lore.filter((l) => l && l.status === "draft")
      : null;
  const draftsFor = (name) =>
    allDrafts ? allDrafts.filter((l) => (l.repos || []).includes(name)).length : 0;

  // With no repo in the address, open one (a blank page asks a question the
  // operator should not have to answer to read anything): the repo with the
  // newest draft (the server lists newest first), else the first repo.
  if (!memoryState.repo && repos.length) {
    const names = new Set(repos.map((r) => r.name));
    const withDraft = (allDrafts || []).flatMap((l) => l.repos || []).find((n) => names.has(n));
    memoryState.repo = withDraft || repos[0].name;
  }
  const repo = memoryState.repo;

  const [digestRes, featuresRes] = repo
    ? await Promise.all([
        api("GET", `/api/memory/digest/${encodeURIComponent(repo)}`, undefined, { signal }),
        api(
          "GET",
          `/api/memory/features/${encodeURIComponent(repo)}${memoryState.node ? `?node=${encodeURIComponent(memoryState.node)}` : ""}`,
          undefined,
          { signal },
        ),
      ])
    : [null, null];

  const clubDrafts = allDrafts ? allDrafts.length : null;
  // Whether the repo on show already has a digest, so the onboard sheet knows a
  // re-onboard without asking the server again (unknown when memory is off).
  const onboarded =
    repo && digestRes && digestRes.available !== false ? { [repo]: !!digestRes.digest } : null;
  const wrap = el("div", { class: "view view-memory", dataset: { view: "memory" } });
  wrap.appendChild(
    viewHead(
      "Club history",
      [
        plural(repos.length, "repo") + " on the books",
        clubDrafts == null
          ? null
          : clubDrafts
            ? `${plural(clubDrafts, "lore draft")} across the club ${clubDrafts === 1 ? "awaits" : "await"} your signature`
            : "no lore drafts waiting",
      ]
        .filter(Boolean)
        .join(" · "),
      onboardButton(repos, repo, { onboarded }),
    ),
  );

  // The squad of repos: one kit per repo, the one being read marked, a yellow
  // card on every repo whose lore drafts wait for you.
  if (repos.length > 1) {
    wrap.appendChild(
      el(
        "nav",
        { class: "mem-repos", "aria-label": "Repos" },
        repos.map((r) => {
          const n = draftsFor(r.name);
          return el(
            "a",
            {
              class: "mem-repo",
              href: `#/memory/${encodeURIComponent(r.name)}`,
              "aria-current": r.name === repo ? "page" : null,
              "aria-label": n ? `${r.name}, ${plural(n, "lore draft")} waiting` : null,
            },
            [
              kitShirt(r.name, 22),
              el("span", {}, r.name),
              n
                ? el("span", { class: "mem-repo-n" }, [ycard(14), el("span", {}, String(n))])
                : null,
            ],
          );
        }),
      ),
    );
  }

  // Repo picker for a phone (the kits fold away there) — drives the page.
  const repoSel = el(
    "select",
    {
      "aria-label": "Select a repo",
      onchange: (e) => {
        memoryState.repo = e.target.value;
        memoryState.node = "";
        writeMemoryStateToUrl();
      },
    },
    [
      el("option", { value: "" }, repos.length ? "Select a repo…" : "No repos known"),
      ...repos.map((r) =>
        el(
          "option",
          { value: r.name, selected: repo === r.name },
          draftsFor(r.name) ? `${r.name} (${plural(draftsFor(r.name), "draft")})` : r.name,
        ),
      ),
    ],
  );
  // On a phone the header's Onboard folds into this row (one line, not two), so
  // the first draft to sign sits above the fold.
  const pickOnboard = onboardButton(repos, repo, { label: "Onboard", onboarded });
  pickOnboard.classList.add("mem-pick-onboard");
  wrap.appendChild(
    el("div", { class: `filters mem-pick${repos.length > 1 ? "" : " is-solo"}` }, [
      field("Repo", repoSel),
      pickOnboard,
    ]),
  );

  if (repo) wrap.appendChild(memoryStats(repo, digestRes, featuresRes, allDrafts, draftsFor));

  // Lore first (the drafts are the one thing here that needs you), the report
  // and the honours board beside it. The lore card mounts into a slot so a
  // filter change re-fetches ONLY that card, not the whole view.
  const loreSlot = el("div", { class: "lore-slot" });
  const side = el("div", { class: "mem-side" });
  if (repo) {
    side.appendChild(renderDigestCard(repo, digestRes, repos));
    side.appendChild(renderFeatureLedger(repo, featuresRes));
  } else {
    side.appendChild(
      emptyState(
        "No repos on the books yet.",
        "Onboard one and its scouting report and honours board land here.",
        null,
        onboardButton(repos, "", { primary: true }),
      ),
    );
  }
  wrap.appendChild(el("div", { class: "mem-grid" }, [loreSlot, side]));
  const reload = () => remountMemory(param);
  await mountLoreCard(loreSlot, repos, reload);

  // Refresh without moving anything: an unchanged read keeps the DOM (and the
  // open folds, the focus and the scroll) as it is. The lore card re-reads on its
  // own (a filter or a page change) and then re-signs the view (mountLoreCard),
  // so the next refresh compares against what is on screen, not the first read.
  wrap._memSigBase = [repos.map((r) => r.name), allDrafts, digestRes, featuresRes];
  wrap.dataset.sig = memorySignature(wrap._memSigBase, loreSlot._res);
  return wrap;
}

/** The Memory view's data signature: the view's reads, the lore page and its filters. */
function memorySignature(base, loreRes) {
  return hashText(
    JSON.stringify([...base, loreRes || null, { ...loreFilter, foldOpen: undefined }, memoryState]),
  );
}

/**
 * The club's numbers for this repo, on the stadium board: drafts that wait
 * for you (lit yellow when any), the honours (features shipped of all), and the
 * date of the scouting report. Every figure is one the responses gave us.
 */
function memoryStats(repo, digestRes, featuresRes, allDrafts, draftsFor) {
  const drafts = allDrafts ? draftsFor(repo) : null;
  const elsewhere = allDrafts ? allDrafts.length - drafts : 0;
  const feats = featuresRes && featuresRes.available !== false ? featuresRes.features || [] : null;
  const by = (s) => (feats ? feats.filter((f) => f.status === s).length : 0);
  const digest = digestRes && digestRes.available !== false ? digestRes.digest : null;
  const meta = (digest && digest.meta) || {};
  return el(
    "div",
    { class: "kpi-row mem-stats", role: "group", "aria-label": `${repo} in numbers` },
    [
      statCell({
        label: "Drafts await you",
        value: drafts == null ? "—" : String(drafts),
        needs: !!drafts,
        href: "#lore",
        sub:
          drafts == null
            ? "lore unavailable"
            : elsewhere
              ? `${elsewhere} more waiting in other repos`
              : drafts
                ? "lore to approve or reject"
                : "nothing to sign",
      }),
      statCell({
        label: "Honours",
        value: feats ? String(by("shipped")) : "—",
        unit: feats && feats.length ? `of ${feats.length}` : null,
        sub: !feats
          ? "ledger unavailable"
          : feats.length
            ? `${by("building")} building · ${by("backlog")} in the backlog`
            : "no features recorded yet",
      }),
      statCell({
        label: "Scouting report",
        value: digest && meta.updatedAt ? fmtDay(meta.updatedAt, { weekday: false }) : "—",
        sub: digest
          ? `source: ${meta.source || "—"}`
          : digestRes && digestRes.available === false
            ? "memory unavailable"
            : "not scouted yet",
      }),
    ],
  );
}

/** Re-read the whole Memory view in place (after a ratification), keeping the scroll. */
async function remountMemory(param) {
  const gen = routeGen;
  const focusIdx = (() => {
    const rows = [...document.querySelectorAll(".lore-row[data-status='draft']")];
    const i = rows.findIndex((r) => r.contains(document.activeElement));
    return i;
  })();
  let content;
  try {
    content = await renderMemory(param);
  } catch (e) {
    if (e && e.code !== "ABORTED")
      toast(e.message || "Could not re-read Memory.", { code: e.code });
    return;
  }
  if (gen !== routeGen) {
    disposeView(content);
    return;
  }
  const se = document.scrollingElement || document.documentElement;
  const y = se.scrollTop;
  const restoreForms = carryOpenForms(app.firstElementChild, content);
  mountView(content);
  se.scrollTop = y;
  // A form still open (a reject the server refused keeps its reason) keeps the focus.
  if (restoreForms()) return;
  // Triage keeps its place: focus goes to the next draft's Approve (or the card).
  if (focusIdx >= 0) {
    const next = [...content.querySelectorAll(".lore-row[data-status='draft'] .lore-approve")];
    const target = next[Math.min(focusIdx, next.length - 1)] || content.querySelector("#lore");
    if (target) {
      if (!target.hasAttribute("tabindex") && target.id === "lore")
        target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }
  }
}

// Lore card filters. They persist across the live re-render (the SSE refresh
// re-runs renderMemory every few seconds, and a reviewer mid-queue must not lose
// their "drafts only" view); the repo filter follows the page's repo whenever
// that changes. `limit` is a page, not a cap — the pager walks `total`.
const LORE_STATUSES = ["draft", "active", "deprecated", "superseded"];
const LORE_KINDS = ["decision", "requirement", "non-goal", "convention", "gotcha", "other"];
const loreFilter = {
  status: "",
  kind: "",
  repo: "",
  q: "", // the search box over the page shown (kept across a refresh)
  pageRepo: null,
  offset: 0,
  limit: 50,
  foldOpen: false,
};

/** The lore read for the current filters: GET /api/memory/lore?repo&status&kind&limit&offset. */
function loreQueryPath() {
  const q = new URLSearchParams();
  if (loreFilter.repo) q.set("repo", loreFilter.repo);
  if (loreFilter.status) q.set("status", loreFilter.status);
  if (loreFilter.kind) q.set("kind", loreFilter.kind);
  q.set("limit", String(loreFilter.limit));
  if (loreFilter.offset > 0) q.set("offset", String(loreFilter.offset));
  return `/api/memory/lore?${q.toString()}`;
}

/** Fetch the current lore page and (re)render the card into `slot`. */
async function mountLoreCard(slot, repos, reload) {
  if (loreFilter.pageRepo !== memoryState.repo) {
    loreFilter.pageRepo = memoryState.repo;
    loreFilter.repo = memoryState.repo;
    loreFilter.offset = 0;
  }
  // Only the newest read lands: two quick filter changes must not let the older
  // answer paint over the newer one.
  const seq = (slot._seq = (slot._seq || 0) + 1);
  let res;
  try {
    res = await api("GET", loreQueryPath(), undefined, { signal: routeSignal() });
  } catch (e) {
    if (e && e.code === "ABORTED") throw e;
    res = { available: false, reason: e && e.message ? e.message : "The lore request failed." };
  }
  if (seq !== slot._seq) return;
  if (!slot.isConnected && slot.childNodes.length) return; // view was torn down mid-fetch
  slot._res = res;
  const card = renderLoreList(res, loreFilter.repo, {
    repos,
    refresh: () => mountLoreCard(slot, repos, reload),
    reload: reload || (() => mountLoreCard(slot, repos, reload)),
  });
  // The read can land after the operator opened a reject on the card it replaces
  // (a slow server): the open form moves over to its row in the new page.
  const restoreForms = carryOpenForms(slot.firstElementChild, card);
  clear(slot);
  slot.appendChild(card);
  restoreForms();
  // Re-sign the view: what is on screen is now this page under these filters.
  const view = slot.closest(".view-memory");
  if (view && view._memSigBase) view.dataset.sig = memorySignature(view._memSigBase, res);
}

/**
 * Ratify a draft from the dashboard: POST /api/memory/lore/:id/approve|reject. The
 * server calls the memory CLI (its write boundary); success re-reads the view so
 * the row shows its new state (or leaves a drafts-only filter) and the counts on
 * the tabs and the strip agree. A refused decision (already ratified elsewhere,
 * unknown id) surfaces as a toast, never a silent no-op.
 */
async function ratifyLore(l, action, refresh, btn, reason) {
  // Busy without the `disabled` attribute: the browser blurs a disabled button to
  // <body>, and keyboard triage would then lose its place (WCAG 2.4.3). aria-disabled
  // keeps focus on the row so the re-render can hand it to the next draft's Approve.
  const group = btn ? [...(btn.closest(".lore-actions")?.querySelectorAll("button") || [btn])] : [];
  if (btn && btn.getAttribute("aria-disabled") === "true") return;
  for (const b of group) b.setAttribute("aria-disabled", "true");
  if (btn) {
    btn.classList.add("is-busy");
    btn.setAttribute("aria-busy", "true");
  }
  try {
    await api(
      "POST",
      `/api/memory/lore/${encodeURIComponent(l.id)}/${action}`,
      action === "reject" ? (reason ? { reason } : {}) : undefined,
    );
    toast(
      action === "approve"
        ? `Approved "${l.title}" — active for delivery agents from the next tick.`
        : `Rejected "${l.title}".`,
      { ok: true },
    );
  } catch (e) {
    toast(e && e.message ? e.message : `Could not ${action} the draft.`, { code: e && e.code });
    for (const b of group) b.removeAttribute("aria-disabled");
    if (btn) {
      btn.classList.remove("is-busy");
      btn.removeAttribute("aria-busy");
    }
  }
  if (refresh) await refresh();
}

/** Ticket references in a provenance line ("merge:#5", "epic Repeat orders · #6") become links. */
function provenanceNodes(text) {
  const out = [];
  const re = /#(\d+)/g;
  let last = 0;
  let m;
  const s = String(text);
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(el("a", { href: `#/ticket/${m[1]}` }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

/**
 * The scouting report (Repo Digest): the factory's read of a repo, set as a calm
 * document. The overview is the lede; structure, conventions and stack follow as
 * labelled paragraphs; the freshness line and the CLI's caveat close it.
 */
function renderDigestCard(repo, res, repos = []) {
  const card = el("section", {
    class: "card mem-page mem-report",
    dataset: { section: "digest" },
    "aria-label": "Scouting report",
  });
  card.appendChild(panelHead("Scouting report", `Repo Digest · ${repo}`, null, { kit: "claret" }));
  if (!res || res.available === false) {
    card.appendChild(memoryUnavailable(res ? res.reason : ""));
    return card;
  }
  const digest = res.digest;
  if (!digest) {
    // No digest yet — onboard this repo to populate it. The button POSTs to
    // /repos/onboard pre-targeting THIS repo, so it's a one-click action here.
    card.appendChild(
      emptyState(
        `No digest for ${repo} yet`,
        "Onboard this repo to scan it and build its Memory digest + feature inventory.",
        null,
        onboardButton(repos, repo, { onboarded: { [repo]: false } }),
      ),
    );
    return card;
  }
  const SECTIONS = [
    ["Overview", digest.overview],
    ["Structure", digest.structure],
    ["Conventions", digest.conventions],
    ["Stack", digest.stack],
  ];
  card.appendChild(
    el(
      "dl",
      { class: "scout" },
      SECTIONS.map(([label, body], i) =>
        el("div", { class: `scout-sec${i === 0 ? " scout-lede" : ""}` }, [
          el("dt", {}, label),
          el("dd", { class: body ? "" : "dim" }, body || "Not written yet."),
        ]),
      ),
    ),
  );
  // Freshness line ("updated_at · source") — the load-bearing provenance.
  const meta = digest.meta || {};
  card.appendChild(
    el("p", { class: "digest-fresh" }, [
      icon("clock", "fresh-ico", 16),
      el("span", {}, `updated ${fmtTime(meta.updatedAt)}`),
      el("span", { "aria-hidden": "true" }, "·"),
      el("span", {}, `source: ${meta.source || "—"}`),
    ]),
  );
  // The honesty caveat — surfaced verbatim so nobody over-trusts the summary.
  if (digest.caveat) card.appendChild(el("p", { class: "digest-caveat" }, digest.caveat));
  return card;
}

/**
 * The honours board (Feature ledger): what has shipped, what is building and what
 * waits in the backlog, one mown band per stage, each feature grouped under its
 * scope node and linked to the ticket its provenance names.
 */
function renderFeatureLedger(repo, res) {
  const ok = res && res.available !== false;
  const features = ok ? res.features || [] : [];
  const card = el("section", {
    class: "card mem-page mem-honours",
    dataset: { section: "features" },
    "aria-label": "Honours board",
  });
  card.appendChild(
    panelHead(
      ["Honours board", ok ? el("span", { class: "count" }, String(features.length)) : null],
      `Feature ledger · ${repo}`,
      null,
      { kit: "sky" },
    ),
  );
  if (!ok) {
    card.appendChild(memoryUnavailable(res ? res.reason : ""));
    return card;
  }

  // Scope-node filter — group/filter by `scope_node`. Built from the features
  // actually present so the options reflect reality.
  const nodes = Array.from(new Set(features.map((f) => f.scopeNode).filter(Boolean))).sort();
  if (nodes.length || memoryState.node) {
    const nodeSel = el(
      "select",
      {
        "aria-label": "Filter features by scope node",
        onchange: (e) => {
          memoryState.node = e.target.value;
          writeMemoryStateToUrl();
        },
      },
      [
        el("option", { value: "" }, "All scope nodes"),
        ...nodes.map((n) => el("option", { value: n, selected: memoryState.node === n }, `@${n}`)),
      ],
    );
    card.appendChild(el("div", { class: "filters mem-node" }, [field("Scope node", nodeSel)]));
  }

  if (features.length === 0) {
    card.appendChild(
      emptyState(
        `No features recorded for ${repo}${memoryState.node ? ` @${memoryState.node}` : ""}`,
        "The merge pipeline ships features into this ledger as work lands.",
      ),
    );
    return card;
  }

  // Shipped / Building / Backlog, each grouped by scope node.
  const lanes = el("div", { class: "ledger" });
  for (const group of FEATURE_GROUPS) {
    const inGroup = features.filter((f) => f.status === group.status);
    const lane = el("div", { class: "ledger-lane", dataset: { status: group.status } }, [
      el("div", { class: "ledger-head" }, [
        el("span", { class: "ledger-n tabnum" }, String(inGroup.length)),
        el("span", { class: "ledger-label" }, group.label),
        el("span", { class: "ledger-note" }, group.note),
      ]),
    ]);
    const list = el("div", { class: "ledger-list" });
    if (inGroup.length === 0) {
      list.appendChild(el("p", { class: "ledger-empty" }, "Nothing here."));
    } else {
      const byNode = new Map();
      for (const f of inGroup) {
        const key = f.scopeNode || "";
        if (!byNode.has(key)) byNode.set(key, []);
        byNode.get(key).push(f);
      }
      for (const [node, items] of byNode) {
        if (node) list.appendChild(el("div", { class: "ledger-node" }, `@${node}`));
        for (const f of items) list.appendChild(renderFeatureCard(f));
      }
    }
    lane.appendChild(list);
    lanes.appendChild(lane);
  }
  card.appendChild(lanes);
  return card;
}

function renderFeatureCard(f) {
  return el("div", { class: "feature-card", dataset: { status: f.status } }, [
    el("div", { class: "feature-top" }, [
      el("span", { class: "feature-name" }, f.name),
      f.area ? el("span", { class: "feature-area" }, f.area) : null,
    ]),
    f.summary ? el("p", { class: "feature-summary" }, f.summary) : null,
    f.provenance
      ? el("p", { class: "feature-prov" }, [
          icon("link", "prov-ico", 14),
          el("span", {}, provenanceNodes(f.provenance)),
        ])
      : null,
  ]);
}

/** Lore groups on a page, in the order the gaffer works them. */
const LORE_GROUPS = [
  { id: "draft", label: "Awaiting your signature", statuses: ["draft"] },
  { id: "active", label: "On the record", statuses: ["active"] },
  { id: "retired", label: "Retired", statuses: ["deprecated", "superseded"] },
];

/**
 * The Lore card: a repo / status / kind filter row, the current page of records
 * (the SERVER filters and pages — `total` is the true count) grouped drafts
 * first, approve / reject on every draft, and a pager. `repo` is the lore-card
 * repo filter (tagged records only; "All repos" shows everything, org-wide lore
 * included).
 */
function renderLoreList(res, repo, opts = {}) {
  const lore = (res && res.lore) || [];
  const refresh = opts.refresh || null;
  const reload = opts.reload || refresh;
  const ok = !!res && res.available !== false;
  const total = res && typeof res.total === "number" ? res.total : lore.length;
  const flaggedCount = lore.filter((l) => l && l.flagged).length;
  const draftCount = lore.filter((l) => l && l.status === "draft").length;
  const card = el("section", {
    class: "card mem-page mem-lore",
    id: "lore",
    dataset: { section: "lore" },
    "aria-label": "Club lore",
  });
  card.appendChild(
    panelHead(
      ["Club lore", ok ? el("span", { class: "count" }, String(total)) : null],
      ok
        ? [
            // Ratification queue at a glance: drafts on this page awaiting a decision.
            draftCount > 0 ? badge(plural(draftCount, "draft"), "lore-draft") : null,
            // Learn-loop signal: how many conventions the loop flagged for review.
            flaggedCount > 0 ? badge(`${flaggedCount} flagged`, "lore-flagged") : null,
            draftCount || flaggedCount ? null : "what the club has learned",
          ]
        : null,
      null,
      { kit: "ink" },
    ),
  );

  const loreNote = el(
    "p",
    { class: "section-note lore-note" },
    `${repo ? `Lore tagged ${repo}.` : "Lore across every repo, the club's own included."} Approve a draft and delivery agents read it from the next tick; \`gaffer lore review\` does the same from a terminal.`,
  );

  // Filter row — each change re-fetches from the first page.
  const onFilter = (patch) => {
    Object.assign(loreFilter, patch, { offset: 0 });
    if (refresh) refresh();
  };
  const repoSel = el(
    "select",
    { class: "select lore-filter-repo", "aria-label": "Lore repo filter" },
    [
      el("option", { value: "", selected: !repo ? "" : undefined }, "All repos"),
      ...(opts.repos || []).map((r) =>
        el("option", { value: r.name, selected: repo === r.name ? "" : undefined }, r.name),
      ),
    ],
  );
  if (repo && !(opts.repos || []).some((r) => r.name === repo)) {
    repoSel.appendChild(el("option", { value: repo, selected: "" }, repo));
  }
  repoSel.addEventListener("change", () => onFilter({ repo: repoSel.value }));
  const statusSel = el(
    "select",
    { class: "select lore-filter-status", "aria-label": "Lore status filter" },
    [
      el("option", { value: "" }, "Any status"),
      ...LORE_STATUSES.map((s) =>
        el(
          "option",
          { value: s, selected: loreFilter.status === s ? "" : undefined },
          s === "draft" ? "draft — awaiting ratification" : s,
        ),
      ),
    ],
  );
  statusSel.addEventListener("change", () => onFilter({ status: statusSel.value }));
  const kindSel = el(
    "select",
    { class: "select lore-filter-kind", "aria-label": "Lore kind filter" },
    [
      el("option", { value: "" }, "Any kind"),
      ...LORE_KINDS.map((k) =>
        el("option", { value: k, selected: loreFilter.kind === k ? "" : undefined }, k),
      ),
    ],
  );
  kindSel.addEventListener("change", () => onFilter({ kind: kindSel.value }));
  // The filters fold behind one line on a phone (the repo filter follows the
  // page's repo anyway), so "Awaiting your signature" and the first Approve are on
  // screen at load; on a desk they stay open and the summary line is hidden. The
  // fold remembers being opened across the live re-render.
  const narrow =
    typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches;
  const setBits = [
    loreFilter.repo !== (memoryState.repo || "")
      ? loreFilter.repo
        ? loreFilter.repo
        : "all repos"
      : null,
    loreFilter.status ? (loreFilter.status === "draft" ? "drafts" : loreFilter.status) : null,
    loreFilter.kind || null,
  ].filter(Boolean);
  const fold = el(
    "details",
    { class: "lore-fold", open: !narrow || loreFilter.foldOpen ? "" : undefined },
    [
      el("summary", { class: "lore-fold-sum" }, [
        el("span", { class: "lore-fold-label" }, "Filter"),
        el(
          "span",
          { class: "lore-fold-set" },
          setBits.length ? setBits.join(" · ") : `${repo || "all repos"} · all lore`,
        ),
      ]),
      el("div", { class: "filters lore-filters" }, [
        field("Repo", repoSel),
        field("Status", statusSel),
        field("Kind", kindSel),
      ]),
    ],
  );
  fold.addEventListener("toggle", () => {
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 760px)").matches)
      loreFilter.foldOpen = fold.open;
  });
  card.appendChild(fold);

  if (!ok) {
    card.appendChild(memoryUnavailable(res ? res.reason : ""));
    return card;
  }
  if (lore.length === 0) {
    card.appendChild(
      emptyState(
        loreFilter.status === "draft"
          ? repo
            ? `No drafts awaiting review for ${repo}`
            : "No drafts awaiting review"
          : repo
            ? `No lore tagged ${repo} yet`
            : "No lore recorded yet",
        loreFilter.status === "draft"
          ? "Agents, onboarding and the distiller file drafts here; approving one makes it active for delivery agents."
          : "Lore captures the conventions and decisions agents should respect.",
      ),
    );
    card.appendChild(loreNote);
    return card;
  }

  let firstDraft = true;
  const row = (l) => {
    const isDraft = l.status === "draft" && l.id;
    const actions = isDraft
      ? (() => {
          // One sign-off per view: the first draft's Approve is the primary.
          const approve = el(
            "button",
            {
              class: `btn ${firstDraft ? "primary " : ""}small lore-approve`,
              type: "button",
              "aria-label": `Approve “${l.title}”`,
            },
            [icon("check"), el("span", {}, "Approve")],
          );
          firstDraft = false;
          approve.addEventListener("click", () => ratifyLore(l, "approve", reload, approve));
          const reject = el(
            "button",
            { class: "btn small lore-reject", type: "button", "aria-label": `Reject “${l.title}”` },
            "Reject",
          );
          roLock(approve);
          roLock(reject);
          // Keyed by the draft's id, so an open reject survives a re-render (carryOpenForms).
          const actionsEl = el(
            "div",
            { class: "lore-actions", dataset: { keepKey: `lore:${l.id}` } },
            [approve, reject],
          );
          // Reject asks for an optional reason in place (the memory CLI recommends
          // one: the agent that filed the draft reads it). Enter rejects, with or
          // without words; Escape puts the buttons back.
          reject.addEventListener("click", () => {
            const why = el("input", {
              type: "text",
              class: "lore-reason",
              maxlength: "2000",
              placeholder: "Why? Optional; the agent reads it",
              "aria-label": `Reason for rejecting “${l.title}” (optional)`,
            });
            const confirm = el(
              "button",
              { class: "btn small danger lore-reject-confirm", type: "submit" },
              "Reject",
            );
            const cancel = el("button", { class: "btn small quiet", type: "button" }, "Cancel");
            const form = el("form", { class: "lore-reject-form" }, [
              why,
              el("div", { class: "lore-reject-btns" }, [confirm, cancel]),
            ]);
            const close = () => {
              delete actionsEl.dataset.keepOpen;
              actionsEl.replaceChildren(approve, reject);
              reject.focus();
            };
            cancel.addEventListener("click", close);
            form.addEventListener("keydown", (e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            });
            form.addEventListener("submit", (e) => {
              e.preventDefault();
              // Focus rides on the confirm button so the re-render can hand it on.
              confirm.focus();
              why.readOnly = true;
              ratifyLore(l, "reject", reload, confirm, why.value.trim()).finally(() => {
                why.readOnly = false; // a refused reject leaves the reason editable
              });
            });
            actionsEl.replaceChildren(form);
            actionsEl.dataset.keepOpen = "1";
            why.focus();
          });
          return actionsEl;
        })()
      : null;
    return el(
      "article",
      {
        class: `lore-row${l.flagged ? " is-flagged" : ""}`,
        dataset: { loreId: l.id || "", status: l.status || "" },
      },
      [
        el("div", { class: "lore-mark" }, [
          isDraft || l.flagged ? ycard(26, "lore-card") : null,
          l.kind ? el("span", { class: "lore-kind" }, l.kind) : null,
        ]),
        el("div", { class: "lore-body" }, [
          el("div", { class: "lore-head" }, [
            el("h4", { class: "lore-title" }, l.title),
            // The group already says draft / on the record; retired rows name their state.
            l.status && !["active", "draft"].includes(l.status)
              ? badge(l.status, `lore-${l.status}`)
              : null,
            l.stale ? badge("stale", "lore-stale") : null,
            // Learn-loop signal: this convention was served into a ticket that then
            // reworked/blocked. Badge it so the operator can spot conventions dragging
            // delivery down and curate them (an active record: the memory CLI's lifecycle verbs).
            l.flagged ? badge("flagged", "lore-flagged") : null,
          ]),
          l.summary ? el("p", { class: "lore-summary" }, l.summary) : null,
          el("div", { class: "lore-meta" }, [
            ...(l.repos || []).map((r) => repoTag(r, 16)),
            ...(l.tags || []).map((t) => el("span", { class: "tag-chip" }, t)),
            l.confidence ? el("span", { class: "lore-conf" }, `${l.confidence} confidence`) : null,
            l.source ? el("span", { class: "lore-src" }, l.source) : null,
          ]),
          l.flagged
            ? el(
                "p",
                { class: "lore-flag-hint" },
                `Served into a ticket that was then reworked or blocked: read it with \`gaffer lore show ${l.id}\`, then deprecate or update it with the memory CLI.`,
              )
            : null,
          l.id ? loreHistory(l) : null,
        ]),
        // Ratification: only a DRAFT can be approved or rejected (an active record is
        // deprecated/superseded through the CLI's lifecycle verbs, not from here).
        actions,
      ],
    );
  };
  const list = el("div", { class: "lore-list" });
  // The search box narrows the rows shown in place (what each row says: title,
  // summary, kind, repos, tags, source); every word must match.
  const searchText = new Map();
  const rowOf = (l) => {
    const node = row(l);
    searchText.set(
      node,
      [l.title, l.summary, l.kind, l.source, ...(l.repos || []), ...(l.tags || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase(),
    );
    return node;
  };
  for (const g of LORE_GROUPS) {
    const items = lore.filter((l) => g.statuses.includes(l.status));
    if (!items.length) continue;
    list.appendChild(
      el("h3", { class: `lore-group lore-group-${g.id}` }, [
        g.label,
        el("span", { class: "count" }, String(items.length)),
      ]),
    );
    for (const l of items) list.appendChild(rowOf(l));
  }
  const other = lore.filter((l) => !LORE_GROUPS.some((g) => g.statuses.includes(l.status)));
  if (other.length) {
    list.appendChild(
      el("h3", { class: "lore-group" }, [
        "Other",
        el("span", { class: "count" }, String(other.length)),
      ]),
    );
    for (const l of other) list.appendChild(rowOf(l));
  }
  card.appendChild(loreSearch(list, searchText, lore.length, total));
  card.appendChild(list);
  card.appendChild(loreNote);

  // Pager — the server pages; show where this page sits in `total`.
  const from = loreFilter.offset + 1;
  const to = loreFilter.offset + lore.length;
  if (total > lore.length || loreFilter.offset > 0) {
    const page = (delta) => {
      loreFilter.offset = Math.max(0, loreFilter.offset + delta);
      if (refresh) refresh();
    };
    card.appendChild(
      el("div", { class: "lore-pager" }, [
        el("span", { class: "tabnum" }, `Showing ${from}–${to} of ${total}`),
        el(
          "button",
          {
            class: "btn small lore-prev",
            type: "button",
            disabled: loreFilter.offset === 0 ? "" : undefined,
            onclick: () => page(-loreFilter.limit),
          },
          "Previous",
        ),
        el(
          "button",
          {
            class: "btn small lore-next",
            type: "button",
            disabled: to >= total ? "" : undefined,
            onclick: () => page(loreFilter.limit),
          },
          "Next",
        ),
      ]),
    );
  }
  return card;
}

/**
 * The search box over the lore rows shown: every word must appear in a row (title,
 * summary, kind, repos, tags, source). It narrows in place, hides a group heading
 * left with no row, and says how many match; when the store holds more than this
 * page it says the search covers this page, which the filters above narrow.
 */
function loreSearch(list, searchText, shown, total) {
  const input = el("input", {
    type: "search",
    class: "lore-search-input",
    value: loreFilter.q,
    autocomplete: "off",
    placeholder: "Words in a title, summary, tag or repo",
  });
  const count = el("p", { class: "lore-search-count dim", role: "status" });
  const apply = () => {
    loreFilter.q = input.value;
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    let hits = 0;
    let heading = null;
    let headingHits = 0;
    const closeHeading = () => {
      if (heading) heading.hidden = words.length > 0 && headingHits === 0;
    };
    for (const node of list.children) {
      if (node.tagName === "H3") {
        closeHeading();
        heading = node;
        headingHits = 0;
        continue;
      }
      const text = searchText.get(node) || "";
      const match = words.every((w) => text.includes(w));
      node.hidden = !match;
      if (match) {
        hits += 1;
        headingHits += 1;
      }
    }
    closeHeading();
    count.textContent = words.length
      ? `${hits} of the ${plural(shown, "record")} shown ${hits === 1 ? "matches" : "match"}${total > shown ? ` (the store holds ${total}: the filters above reach the rest)` : ""}.`
      : "";
    count.hidden = !words.length;
  };
  input.addEventListener("input", apply);
  apply();
  return el("div", { class: "lore-search" }, [field("Search lore", input), count]);
}

/**
 * A lore row's History: every earlier version of the record (each update snapshots
 * the one before), newest first, read on first open from
 * GET /api/memory/lore/:id/history. Read-only: it changes nothing. Which rows are
 * open, and what they read, outlive a live refresh of the Memory view: an open
 * History is never folded away (or read again) under the reader.
 */
const loreHistoryOpen = new Set();
const loreHistoryRead = new Map(); // lore id → the pending or settled read
function loreHistory(l) {
  const body = el("div", { class: "lore-history-body" });
  const box = el("details", { class: "lore-history" }, [el("summary", {}, "History"), body]);
  const line = (v, current) =>
    el("li", { class: `lore-version${current ? " is-current" : ""}` }, [
      el("p", { class: "lv-head" }, [
        el("b", { class: "tabnum" }, `v${v.version}`),
        ` · ${current ? "current" : v.status} · `,
        el("time", { datetime: v.at }, v.at ? fmtDay(v.at) : "undated"),
      ]),
      v.title && v.title !== l.title ? el("p", { class: "lv-title" }, v.title) : null,
      v.summary ? el("p", { class: "lv-summary" }, v.summary) : null,
    ]);
  const load = async () => {
    let read = loreHistoryRead.get(l.id);
    if (!read) {
      body.replaceChildren(el("p", { class: "dim" }, "Reading the history…"));
      read = api("GET", `/api/memory/lore/${encodeURIComponent(l.id)}/history`).catch((e) => ({
        available: false,
        reason: (e && e.message) || "the request failed",
      }));
      loreHistoryRead.set(l.id, read);
    }
    const h = await read;
    if (!h || !h.available) {
      loreHistoryRead.delete(l.id); // let a later open try again
      body.replaceChildren(
        el("p", { class: "dim" }, `History unavailable: ${(h && h.reason) || "no answer"}.`),
      );
      return;
    }
    body.replaceChildren(
      h.versions.length
        ? el(
            "ol",
            { class: "lore-versions", "aria-label": `Versions of “${l.title}”, newest first` },
            [line(h.current, true), ...h.versions.map((v) => line(v, false))],
          )
        : el("p", { class: "dim" }, "No earlier versions: this record has not been edited."),
    );
  };
  box.addEventListener("toggle", () => {
    if (box.open) {
      loreHistoryOpen.add(l.id);
      void load();
    } else loreHistoryOpen.delete(l.id);
  });
  if (loreHistoryOpen.has(l.id)) {
    box.open = true;
    void load();
  }
  return box;
}

// ===========================================================================
//  The club and the squad: "Name your club" (the crest) and #/squad
// ===========================================================================

/** The crest letters the server would derive: initials of up to 4 words, or 3 letters. */
function deriveShortName(name) {
  const words = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "GAF";
  if (words.length === 1) return [...words[0]].slice(0, 3).join("").toUpperCase();
  return words
    .slice(0, 4)
    .map((w) => [...w][0])
    .join("")
    .toUpperCase();
}
/** The house kit's two colours as #rrggbb (the colour pickers' starting point). */
function houseColours() {
  const read = (token, fallback) => {
    const v = readHouseKit()[token];
    if (!v || typeof window.getComputedStyle !== "function") return rgbHex(fallback);
    const probe = el("span", { hidden: "" });
    probe.style.color = v;
    document.body.appendChild(probe);
    const m = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/.exec(window.getComputedStyle(probe).color || "");
    probe.remove();
    return m ? rgbHex([+m[1], +m[2], +m[3]]) : rgbHex(fallback);
  };
  return { primary: read("--claret", RGB_HOUSE_CLARET), secondary: read("--sky", RGB_HOUSE_SKY) };
}
/** Redraw the view on screen after a name or the club changed (its signature may not have). */
function redrawForSquad() {
  const cur = app.firstElementChild;
  if (cur && cur.dataset) delete cur.dataset.sig;
  refreshCurrentView();
}

/**
 * "Name your club": the club's name, the crest's short name (1–4 characters) and
 * the two kit colours, with a live preview of the header crest and a shirt. Save
 * PATCHes /api/club; a refusal (422) is shown under the form, never toasted. Only
 * a full token opens it (the crest is a plain badge for a read token).
 */
function openClubSheet() {
  if (!canEditSquad()) return;
  const club = squad.club || {};
  const house = houseColours();
  const dirty = { primary: false, secondary: false, cleared: false };
  const hintId = `club-hint-${++appState.fieldSeq}`;
  const nameIn = el("input", {
    type: "text",
    name: "club_name",
    class: "club-name-in",
    maxlength: "60",
    value: club.name || "",
    placeholder: "Gaffer",
    autocomplete: "off",
  });
  const shortIn = el("input", {
    type: "text",
    name: "short_name",
    class: "club-short-in",
    maxlength: "4",
    value: club.short_name || "",
    placeholder: deriveShortName(club.name || "Gaffer"),
    autocomplete: "off",
    "aria-describedby": hintId,
  });
  const primIn = el("input", {
    type: "color",
    name: "kit_primary",
    class: "club-kit-in",
    value: club.kit_primary || house.primary,
  });
  const secIn = el("input", {
    type: "color",
    name: "kit_secondary",
    class: "club-kit-in",
    value: club.kit_secondary || house.secondary,
  });
  const err = el("p", { class: "form-error club-err", role: "alert", hidden: "" });
  const note = el("p", { class: "club-note", "aria-live": "polite" });
  const prevName = el("span", { class: "cp-name" });
  const prevCrest = el("span", { class: "cp-crest" });
  const prevShirt = el("span", { class: "cp-shirt" });
  const preview = el("div", { class: "club-preview", "aria-hidden": "true" }, [
    el("div", { class: "cp-bar" }, [prevCrest, prevName]),
    el("div", { class: "cp-pitch" }, [prevShirt, el("span", { class: "cp-cap" }, "Delivery 1")]),
  ]);
  const kit = () => ({
    primary: dirty.cleared ? null : dirty.primary || club.kit_primary ? primIn.value : null,
    secondary: dirty.cleared ? null : dirty.secondary || club.kit_secondary ? secIn.value : null,
  });
  const paint = () => {
    const name = nameIn.value.trim() || "Gaffer";
    const letters = shortIn.value.trim() || deriveShortName(name);
    shortIn.placeholder = deriveShortName(name);
    prevName.textContent = name;
    prevCrest.replaceChildren(crest("crest", 34, 40, letters));
    prevShirt.replaceChildren(agentShirt("Delivery 1", 56, "9"));
    const k = kit();
    const tokens = kitTokens(k.primary, k.secondary);
    setKitTokens(preview, tokens);
    note.textContent = tokens["--on-claret"]
      ? "A light kit: the words on it turn dark so they stay readable."
      : "";
  };
  nameIn.addEventListener("input", paint);
  shortIn.addEventListener("input", paint);
  primIn.addEventListener("input", () => {
    dirty.primary = true;
    dirty.cleared = false;
    paint();
  });
  secIn.addEventListener("input", () => {
    dirty.secondary = true;
    dirty.cleared = false;
    paint();
  });
  const houseBtn = el(
    "button",
    {
      class: "btn club-house",
      type: "button",
      onclick: () => {
        dirty.cleared = true;
        dirty.primary = dirty.secondary = false;
        primIn.value = house.primary;
        secIn.value = house.secondary;
        paint();
      },
    },
    "House kit",
  );
  const save = el("button", { class: "btn primary club-save", type: "submit" }, "Save");
  const form = el(
    "form",
    {
      class: "act-sheet club-form",
      novalidate: "",
      onsubmit: async (e) => {
        e.preventDefault();
        err.hidden = true;
        const short = shortIn.value.trim();
        if (short && !/^[\p{L}\p{N}&.]{1,4}$/u.test(short)) {
          err.textContent =
            "The short name is 1 to 4 letters or digits ('&' and '.' allowed), no spaces.";
          err.hidden = false;
          shortIn.setAttribute("aria-invalid", "true");
          shortIn.focus();
          return;
        }
        shortIn.removeAttribute("aria-invalid");
        const body = { name: nameIn.value.trim() || null, short_name: short || null };
        if (dirty.cleared) {
          body.kit_primary = null;
          body.kit_secondary = null;
        } else {
          if (dirty.primary) body.kit_primary = primIn.value;
          if (dirty.secondary) body.kit_secondary = secIn.value;
        }
        save.disabled = true;
        try {
          const res = await api("PATCH", "/api/club", body);
          if (res && res.club) applyClub(res.club);
          closeSheet();
          toast(`Saved: ${clubName()}`, { ok: true });
          redrawForSquad();
        } catch (x) {
          if (x && x.code === "UNAUTHORIZED") return;
          if (x && (x.status === 403 || x.code === "READ_ONLY_TOKEN")) {
            squad.capability = "read";
            err.textContent = "This token can only read: naming the club needs the full token.";
            paintBrand();
          } else err.textContent = (x && x.message) || "The club could not be saved.";
          err.hidden = false;
        } finally {
          save.disabled = false;
        }
      },
    },
    [
      el(
        "p",
        { class: "act-intro" },
        "The club's name and badge head every page; the kit colours dress the header, the crest and every agent's shirt.",
      ),
      preview,
      note,
      el(
        "p",
        { class: "act-hint club-hint", id: hintId },
        "The short name is 1–4 characters, shown on the crest; leave it blank to use the club's initials.",
      ),
      el("div", { class: "form-grid cols-2" }, [
        field("Club name", nameIn),
        field("Short name", shortIn),
        field("Primary kit", primIn),
        field("Secondary kit", secIn),
      ]),
      err,
      el("div", { class: "btn-row act-actions" }, [
        save,
        houseBtn,
        el("button", { class: "btn", type: "button", onclick: closeSheet }, "Cancel"),
      ]),
    ],
  );
  paint();
  openSheet("Name your club", form, { focus: nameIn });
}

/** One row of the squad table; with a full token its Rename edits it in place. */
function squadRow(a, edit) {
  const tr = el("tr", { class: "sq-row", dataset: { id: a.agent_id } });
  const reg = a.registered_name || String(a.agent_id).slice(0, 8);
  let renameBtn = null;
  const view = () => {
    const w = agentWho(a.agent_id, a.registered_name);
    renameBtn = edit
      ? el(
          "button",
          {
            class: "btn small sq-rename",
            type: "button",
            "aria-label": `Rename ${w.name} (${reg})`,
            onclick: editRow,
          },
          "Rename",
        )
      : null;
    tr.classList.remove("is-editing");
    tr.replaceChildren(
      el(
        "td",
        { class: "c-shirt", "data-label": "No." },
        el("span", { class: "sq-shirt" }, [
          agentShirt(w.name, 36, w.no),
          el(
            "span",
            { class: "sq-num tabnum" },
            a.shirt_number != null ? String(a.shirt_number) : "—",
          ),
        ]),
      ),
      el("th", { scope: "row", class: "c-name", "data-label": "Name" }, [
        a.display_name
          ? el("span", { class: "sq-dn" }, a.display_name)
          : el(
              "span",
              { class: "sq-dn is-default", title: "The default name, until you rename it" },
              [a.default_display_name, el("span", { class: "sr-only" }, " (default name)")],
            ),
      ]),
      el("td", { class: "c-role", "data-label": "Role" }, ROLE_LABELS[a.role] || a.role || "—"),
      el(
        "td",
        { class: "c-reg", "data-label": "Registered as" },
        el("code", { class: "mono" }, reg),
      ),
      el("td", { class: "c-status", "data-label": "Status" }, badge(a.status || "—")),
      el(
        "td",
        { class: "c-seen tabnum", "data-label": "Last seen" },
        a.last_seen_at
          ? el(
              "time",
              { datetime: a.last_seen_at, title: fmtTime(a.last_seen_at) },
              fmtRelative(a.last_seen_at),
            )
          : "never",
      ),
      edit ? el("td", { class: "c-act" }, renameBtn) : null,
    );
  };
  function editRow() {
    const w = agentWho(a.agent_id, a.registered_name);
    const errId = `sq-err-${++appState.fieldSeq}`;
    const nameIn = el("input", {
      type: "text",
      class: "sq-name-in",
      maxlength: "40",
      value: a.display_name || "",
      placeholder: a.default_display_name || "",
      "aria-label": `Name for ${reg}`,
      "aria-describedby": errId,
      autocomplete: "off",
    });
    const noIn = el("input", {
      type: "number",
      class: "sq-no-in",
      min: "1",
      max: "99",
      step: "1",
      inputmode: "numeric",
      value: a.shirt_number != null ? String(a.shirt_number) : "",
      placeholder: "—",
      "aria-label": `Shirt number for ${reg} (1–99, or blank)`,
      "aria-describedby": errId,
    });
    const err = el("p", { class: "form-error sq-err", id: errId, role: "alert", hidden: "" });
    const fail = (msg, input) => {
      err.textContent = msg;
      err.hidden = false;
      for (const i of [nameIn, noIn]) i.removeAttribute("aria-invalid");
      if (input) {
        input.setAttribute("aria-invalid", "true");
        input.focus();
      }
    };
    const save = el("button", { class: "btn small primary sq-save", type: "button" }, "Save");
    const cancel = () => {
      view();
      if (renameBtn) renameBtn.focus();
    };
    const doSave = async () => {
      const name = nameIn.value.trim();
      const raw = String(noIn.value || "").trim();
      if (name.length > 40) return fail("A name is at most 40 characters.", nameIn);
      let no = null;
      if (raw !== "") {
        no = Number(raw);
        if (!Number.isInteger(no) || no < 1 || no > 99)
          return fail("A shirt number is a whole number from 1 to 99, or blank.", noIn);
      }
      const body = {};
      if (name !== (a.display_name || "")) body.display_name = name || null;
      if (no !== (a.shirt_number ?? null)) body.shirt_number = no;
      if (!Object.keys(body).length) return cancel();
      save.disabled = true;
      try {
        const res = await api("PATCH", `/api/squad/agents/${encodeURIComponent(a.agent_id)}`, body);
        if (res && res.agent) {
          Object.assign(a, res.agent);
          learnDisplay(res.agent);
        }
        const now = agentWho(a.agent_id, a.registered_name);
        view();
        if (renameBtn) renameBtn.focus();
        toast(
          a.shirt_number != null ? `${now.name} wears No. ${a.shirt_number}` : `Saved: ${now.name}`,
          { ok: true },
        );
      } catch (x) {
        if (x && x.code === "UNAUTHORIZED") return;
        if (x && (x.status === 409 || x.code === "DUPLICATE")) {
          const holder = x.details && x.details.agent_id;
          const hn = holder ? agentWho(holder).name : null;
          fail(hn ? `That number is taken by ${hn}.` : x.message || "That number is taken.", noIn);
        } else if (x && (x.status === 403 || x.code === "READ_ONLY_TOKEN")) {
          squad.capability = "read";
          paintBrand();
          fail("This token can only read: renaming needs the full token.");
        } else fail((x && x.message) || "The name could not be saved.", nameIn);
      } finally {
        save.disabled = false;
      }
    };
    save.addEventListener("click", doSave);
    const keys = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        doSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    nameIn.addEventListener("keydown", keys);
    noIn.addEventListener("keydown", keys);
    tr.classList.add("is-editing");
    tr.replaceChildren(
      el(
        "td",
        { class: "c-shirt", "data-label": "No." },
        el("span", { class: "sq-shirt" }, [agentShirt(w.name, 36, w.no), noIn]),
      ),
      el("th", { scope: "row", class: "c-name", "data-label": "Name" }, [nameIn, err]),
      el("td", { class: "c-role", "data-label": "Role" }, ROLE_LABELS[a.role] || a.role || "—"),
      el(
        "td",
        { class: "c-reg", "data-label": "Registered as" },
        el("code", { class: "mono" }, reg),
      ),
      el("td", { class: "c-status", "data-label": "Status" }, badge(a.status || "—")),
      el(
        "td",
        { class: "c-seen tabnum", "data-label": "Last seen" },
        a.last_seen_at ? fmtRelative(a.last_seen_at) : "never",
      ),
      el("td", { class: "c-act" }, [
        save,
        el("button", { class: "btn small sq-cancel", type: "button", onclick: cancel }, "Cancel"),
      ]),
    );
    nameIn.focus();
  }
  view();
  return tr;
}

/**
 * #/squad: the club's squad as a team sheet. Shirt number, name (the default
 * "Delivery 1" until renamed), role, the label it registered with, status and when
 * it was last seen. A full token renames in place; a read token only reads.
 */
async function renderSquad() {
  const signal = routeSignal();
  const [res] = await Promise.all([api("GET", "/api/squad", undefined, { signal }), ensureSquad()]);
  applySquad(res);
  const agents = (res && res.agents) || [];
  const edit = canEditSquad();
  const wrap = el("div", { class: "view view-squad" });
  wrap.dataset.sig = hashText(
    JSON.stringify([
      edit,
      res && res.club,
      agents.map((a) => [a.agent_id, a.display_name, a.shirt_number, a.status, a.last_seen_at]),
    ]),
  );
  const named = agents.filter((a) => a.display_name).length;
  const numbered = agents.filter((a) => a.shirt_number != null).length;
  wrap.appendChild(
    viewHead(
      "Squad",
      agents.length
        ? `${plural(agents.length, "agent")} · ${named} named · ${numbered} with a shirt number`
        : "No agents registered yet",
      edit
        ? el(
            "button",
            { class: "btn sq-club-btn", type: "button", onclick: () => openClubSheet() },
            [crest("crest sq-club-crest", 20, 24, clubLetters()), el("span", {}, "Name your club")],
          )
        : null,
    ),
  );
  if (!edit)
    wrap.appendChild(
      el(
        "p",
        { class: "section-note sq-readonly" },
        "You are signed in with a read token: you can see the squad, and renaming needs the full token.",
      ),
    );
  const th = (label, cls) => el("th", { scope: "col", class: cls }, label);
  const body = agents.length
    ? el("div", { class: "sq-table-wrap" }, [
        el("table", { class: "sq-table", "aria-label": "The squad" }, [
          el("thead", {}, [
            el("tr", {}, [
              th("No.", "c-shirt"),
              th("Name", "c-name"),
              th("Role", "c-role"),
              th("Registered as", "c-reg"),
              th("Status", "c-status"),
              th("Last seen", "c-seen"),
              edit ? th(el("span", { class: "sr-only" }, "Rename"), "c-act") : null,
            ]),
          ]),
          el(
            "tbody",
            {},
            agents.map((a) => squadRow(a, edit)),
          ),
        ]),
      ])
    : emptyState(
        "No agents in the squad yet.",
        "An agent joins the squad when it registers with the control plane; it gets a default name like “Delivery 1”.",
      );
  wrap.appendChild(progPage("squad-sheet", "claret", "The squad", clubName(), body));
  wrap.appendChild(
    el(
      "p",
      { class: "section-note sq-foot" },
      "Names and shirt numbers are labels: every claim, event and gate still records the agent by its id. A shirt number is worn by one agent at a time.",
    ),
  );
  return wrap;
}

// ===========================================================================
//  View: Floor (#/floor) — the factory floor
//    An isometric drawing of the real factory state. A conveyor bent into an L
//    runs past the stations in lifecycle order (Drawing office, Stores, Assembly,
//    Inspection, Test rig, Loading bay, Despatch); every open ticket is a parcel
//    at its station; every live claim is a robot wearing its agent's shirt
//    number (the same agentWho() the Tactics Board's shirts use); blocked,
//    paused and failed tickets sit in the hazard-taped jam bay, whose beacon is
//    lit while it holds anything; the spend tank is filled to today's wage bill
//    against the daily budget; and the lorry carries what was despatched today.
//    Everything is read through loadMatchDay(), the Overview's own reads, so the
//    floor and the scoreboard can never disagree. Drawn from one set of box and
//    prism primitives so the light falls the same way on every object: the top
//    face is the lightest, the +y face mid, the +x face the darkest.
// ===========================================================================

/** Tile size (px per tile) and the height squash of the 2:1 dimetric projection. */
const FU = 40;
const FZK = 0.9;
/** Tile (x, y, z) to the drawing's (sx, sy). */
const fP = (x, y, z = 0, u = FU) => [(x - y) * u, ((x + y) * u) / 2 - z * u * FZK];
const fPt = (p) => p[0].toFixed(1) + "," + p[1].toFixed(1);
const fShade = (c, k) => (k ? `color-mix(in oklab, ${c}, var(--fl-shade) ${k}%)` : c);
const fTint = (c, k) => `color-mix(in oklab, ${c}, var(--fl-lift) ${k}%)`;
function fFace(pts, fill, u = FU, cls = "f") {
  return svgEl("polygon", {
    points: pts.map((q) => fPt(fP(q[0], q[1], q[2], u))).join(" "),
    style: `fill:${fill};stroke:${fill}`,
    class: cls,
  });
}
/** An axis-aligned box. c = { base } or explicit { top, front, side }. */
function fBox(x, y, z, w, d, h, c, u = FU, cls) {
  return svgEl("g", cls ? { class: cls } : {}, [
    fFace(
      [
        [x, y + d, z],
        [x + w, y + d, z],
        [x + w, y + d, z + h],
        [x, y + d, z + h],
      ],
      c.front ?? fShade(c.base, 9),
      u,
    ),
    fFace(
      [
        [x + w, y, z],
        [x + w, y + d, z],
        [x + w, y + d, z + h],
        [x + w, y, z + h],
      ],
      c.side ?? fShade(c.base, 22),
      u,
    ),
    fFace(
      [
        [x, y, z + h],
        [x + w, y, z + h],
        [x + w, y + d, z + h],
        [x, y + d, z + h],
      ],
      c.top ?? c.base,
      u,
    ),
  ]);
}
/** The silhouette of a box (focus rings and hit areas). */
function fHull(x, y, z, w, d, h, u = FU) {
  return [
    [x, y, z + h],
    [x + w, y, z + h],
    [x + w, y, z],
    [x + w, y + d, z],
    [x, y + d, z],
    [x, y + d, z + h],
  ]
    .map((p) => fPt(fP(p[0], p[1], p[2], u)))
    .join(" ");
}
/** A sawtooth roof over a footprint; `along` is the direction the teeth repeat. */
function fSawtooth(x, y, w, d, z, rise, hue, glass, along) {
  const g = svgEl("g");
  const len = along === "x" ? w : d;
  const n = Math.max(1, Math.round(len / 0.75));
  const step = len / n;
  for (let i = 0; i < n; i++) {
    const a = (along === "x" ? x : y) + i * step;
    const b = a + step;
    if (along === "x")
      g.append(
        fFace(
          [
            [a, y, z],
            [b, y, z + rise],
            [b, y + d, z + rise],
            [a, y + d, z],
          ],
          fTint(hue, 8),
        ),
        fFace(
          [
            [a, y + d, z],
            [b, y + d, z],
            [b, y + d, z + rise],
          ],
          fShade(hue, 14),
        ),
        fFace(
          [
            [b, y, z],
            [b, y + d, z],
            [b, y + d, z + rise],
            [b, y, z + rise],
          ],
          glass,
          FU,
          "f glass",
        ),
      );
    else
      g.append(
        fFace(
          [
            [x, a, z],
            [x, b, z + rise],
            [x + w, b, z + rise],
            [x + w, a, z],
          ],
          fTint(hue, 8),
        ),
        fFace(
          [
            [x + w, a, z],
            [x + w, b, z],
            [x + w, b, z + rise],
          ],
          fShade(hue, 26),
        ),
        fFace(
          [
            [x, b, z],
            [x + w, b, z],
            [x + w, b, z + rise],
            [x, b, z + rise],
          ],
          glass,
          FU,
          "f glass",
        ),
      );
  }
  return g;
}
const fRect = (x, y, w, h) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];
/**
 * A sign painted on a wall, on its own layer above the floor (nothing on the
 * floor may cover a station's name). It registers its sheared outline so the tag
 * pass keeps clear of it. along "x": the +y face; along "y": the +x face.
 */
function fSign(C, x0, y0, z, along, widthTiles, label) {
  const [ox, oy] = fP(x0, y0, z);
  const k = along === "x" ? 0.5 : -0.5;
  const W = widthTiles * FU;
  C.signs.push(
    svgEl(
      "g",
      { transform: `matrix(1,${k},0,1,${ox.toFixed(1)},${oy.toFixed(1)})`, class: "fl-sign" },
      [
        svgEl("rect", { x: 0, y: 0, width: W, height: 21, rx: 2, class: "fl-sign-board" }),
        svgEl("text", { x: 6, y: 15, class: "fl-sign-text" }, label),
      ],
    ),
  );
  C.obstacles.push([
    [ox, oy],
    [ox + W, oy + k * W],
    [ox + W, oy + k * W + 21],
    [ox, oy + 21],
  ]);
}

/* ---- tag placement: clear of every sign, scale and other tag (SAT test) ---- */
function fOverlaps(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = q[1] - p[1];
      const ny = p[0] - q[0];
      let amin = Infinity;
      let amax = -Infinity;
      let bmin = Infinity;
      let bmax = -Infinity;
      for (const v of a) {
        const d = v[0] * nx + v[1] * ny;
        amin = Math.min(amin, d);
        amax = Math.max(amax, d);
      }
      for (const v of b) {
        const d = v[0] * nx + v[1] * ny;
        bmin = Math.min(bmin, d);
        bmax = Math.max(bmax, d);
      }
      if (amax <= bmin || bmax <= amin) return false;
    }
  }
  return true;
}
/** A leader from an anchor to the nearest point of a tag box: [x0, y0, x1, y1]. */
function fLeader(x, y, bx, by, w, h) {
  if (x < bx || x > bx + w) return [x, y - 2, x < bx ? bx : bx + w, by + h / 2];
  return [x, y - 2, Math.max(bx + 4, Math.min(bx + w - 4, x)), by > y ? by : by + h];
}
function fSegPoly([a, b, c, d]) {
  const L = Math.hypot(c - a, d - b) || 1;
  const nx = ((d - b) / L) * 1.5;
  const ny = (-(c - a) / L) * 1.5;
  const k = 4 / L;
  const a2 = a + (c - a) * k;
  const b2 = b + (d - b) * k;
  const c2 = c - (c - a) * k;
  const d2 = d - (d - b) * k;
  return [
    [a2 + nx, b2 + ny],
    [c2 + nx, d2 + ny],
    [c2 - nx, d2 - ny],
    [a2 - nx, b2 - ny],
  ];
}
function fSegCross([a, b, c, d], [e, f, g, h]) {
  const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return (
    o(a, b, c, d, e, f) * o(a, b, c, d, g, h) < 0 && o(e, f, g, h, a, b) * o(e, f, g, h, c, d) < 0
  );
}
/**
 * Place every tag. Candidates run from straight up outward (higher, either side,
 * below), each scored by how far it strays; an overlap costs more than any
 * distance and a crossed leader costs extra. A tag that moves keeps a leader.
 */
function fPlaceTags(tags, obstacles, bounds) {
  const placed = [];
  const leaders = [];
  const prio = (t) => (t.kind === "danger" ? 0 : t.kind === "needs" ? 1 : 2);
  const order = tags.map((t, i) => [t, i]).sort((a, b) => prio(a[0]) - prio(b[0]) || a[1] - b[1]);
  for (const [t] of order) {
    const [x, y] = t.at;
    const w = t.w;
    const h = 20;
    const base = -t.lift - h;
    const cand = [];
    for (const up of [0, 14, 28, 42, 58]) cand.push([0, base - up, up * 0.6]);
    for (const side of [1, -1])
      for (const [dx, dy] of [
        [w / 2 + 18, base + 6],
        [w / 2 + 18, base - 12],
        [w / 2 + 30, base - 30],
        [w / 2 + 22, 4],
      ])
        cand.push([
          side * dx,
          dy,
          Math.abs(dx) * 0.55 + Math.abs(dy - base) * 0.3 + (side < 0 ? 2 : 0),
        ]);
    cand.push([0, 10, 40]);
    let best = null;
    for (const [dx, dy, cost] of cand) {
      const bx = x + dx - w / 2;
      const by = y + dy;
      const rect = fRect(bx - 3, by - 3, w + 6, h + 6);
      let hits = 0;
      for (const o of obstacles) if (fOverlaps(rect, o)) hits++;
      for (const p of placed) if (fOverlaps(rect, p)) hits++;
      if (bx < bounds[0] + 2 || bx + w > bounds[0] + bounds[2] - 2 || by < bounds[1] + 2) hits++;
      const lead = fLeader(x, y, bx, by, w, h);
      const lp = fSegPoly(lead);
      let cross = 0;
      for (const p of placed) if (fOverlaps(lp, p)) cross++;
      for (const l of leaders) if (fSegCross(lead, l)) cross++;
      const score = hits * 1000 + cross * 400 + cost;
      if (!best || score < best.score) best = { score, bx, by, lead };
      if (score < 1) break;
    }
    placed.push(fRect(best.bx - 2, best.by - 2, w + 4, h + 4));
    leaders.push(best.lead);
    t.box = [best.bx, best.by, w, h];
  }
}

/* ---- stations ------------------------------------------------------------ */
const FLOOR_STATIONS = {
  drawing: { name: "Drawing office", statuses: ["draft", "refining"], hue: "var(--fl-draft)" },
  stores: { name: "Stores", statuses: ["ready"], hue: "var(--fl-ready)" },
  assembly: { name: "Assembly", statuses: ["claimed", "in_progress"], hue: "var(--fl-build)" },
  inspection: { name: "Inspection", statuses: ["in_review"], hue: "var(--fl-inspect)" },
  testrig: { name: "Test rig", statuses: ["in_testing"], hue: "var(--fl-test)" },
  loading: { name: "Loading bay", statuses: ["ready_for_merge"], hue: "var(--fl-inspect)" },
  despatch: { name: "Despatch", statuses: ["done"], hue: "var(--fl-done)" },
  jam: { name: "Jam bay", statuses: ["blocked", "paused", "failed"], hue: "var(--red)" },
};
/** Lifecycle order: the stations along the line, then the bay off it. */
const FLOOR_ORDER = [
  "drawing",
  "stores",
  "assembly",
  "inspection",
  "testrig",
  "loading",
  "despatch",
  "jam",
];
const FLOOR_STATION_OF = {};
for (const [k, st] of Object.entries(FLOOR_STATIONS))
  for (const s of st.statuses) FLOOR_STATION_OF[s] = k;
/** Each ticket status as the floor says it in a sentence. */
const FLOOR_WORDS = {
  draft: "a draft",
  refining: "refining",
  ready: "ready",
  claimed: "claimed",
  in_progress: "in progress",
  in_review: "in review",
  in_testing: "in testing",
  ready_for_merge: "approved, waiting to merge",
  done: "despatched today",
  blocked: "blocked",
  paused: "paused",
  failed: "failed",
};
/** The sheds: footprint in tiles, height, and the direction the roof teeth run. */
const FLOOR_SHEDS = {
  drawing: { x: 0.3, y: 0.1, w: 2.75, d: 1.0, h: 1.05, along: "x" },
  assembly: { x: 5.6, y: 0.05, w: 2.95, d: 1.08, h: 1.25, along: "x" },
  inspection: { x: 8.8, y: 0.1, w: 2.2, d: 1.0, h: 1.1, along: "x" },
  testrig: { x: 9.75, y: 2.45, w: 1.2, d: 1.75, h: 0.95, along: "y" },
  loading: { x: 9.75, y: 4.45, w: 1.2, d: 2.55, h: 1.1, along: "y" },
  despatch: { x: 9.75, y: 7.2, w: 1.2, d: 2.45, h: 1.05, along: "y" },
};
/** The painted benches in Assembly (one per agent slot, at most four fit the bay). */
const FLOOR_MAX_BENCHES = 4;
const fBenchX = (i) => 5.8 + i * 1.02;
/** Where a station's parcels sit (tile coordinates); past the last slot is "+n". */
function floorSlots(k) {
  const out = [];
  if (k === "drawing")
    for (let i = 0; i < 6; i++) out.push({ x: 0.6 + i * 0.44, y: 1.6, z: 0.3, sz: 0.38, flat: 1 });
  if (k === "stores")
    for (const z of [0.42, 0.98])
      for (let i = 0; i < 4; i++) out.push({ x: 3.55 + i * 0.5, y: 0.62, z, sz: 0.4 });
  // claimed tickets whose robot is not on a bench wait on the belt by Assembly
  if (k === "assembly")
    for (let i = 0; i < 5; i++) out.push({ x: 5.9 + i * 0.5, y: 1.6, z: 0.3, sz: 0.4 });
  if (k === "inspection")
    for (let i = 0; i < 3; i++) out.push({ x: 9.3 + i * 0.78, y: 1.6, z: 0.3, sz: 0.46 });
  if (k === "testrig")
    for (let i = 0; i < 3; i++) out.push({ x: 11.5, y: 2.3 + i * 0.62, z: 0.3, sz: 0.44 });
  if (k === "loading")
    for (let i = 0; i < 3; i++)
      out.push({ x: 11.5, y: 4.95 + i * 0.85, z: 0.3, sz: 0.46, lift: i % 2 ? 46 : 22 });
  // the lorry's deck: what was despatched today, loaded mid-deck first (in view)
  if (k === "despatch")
    for (let l = 0; l < 2; l++)
      for (let r = 0; r < 3; r++)
        for (let c = 0; c < 2; c++)
          out.push({
            x: 11.22 + c * 0.56,
            y: [10.95, 10.35, 11.55][r],
            z: 0.54 + l * 0.38,
            sz: 0.42,
          });
  if (k === "jam")
    for (let r = 0; r < 2; r++)
      for (let c = 0; c < 3; c++)
        out.push({ x: 5.9 + c * 0.55, y: 4.45 + r * 0.6, z: 0, sz: 0.42, tilt: true });
  return out;
}
/** Where a robot stands beside a parcel it holds off the benches. */
function floorBeside(k, sl) {
  if (k === "testrig" || k === "loading") return [12.3, sl.y];
  if (k === "jam") return [sl.x, 5.75];
  if (k === "despatch") return [12.45, sl.y];
  return [sl.x, 2.45];
}

/** A kraft parcel (or a blue flat-pack: a draft). */
function floorParcel(x, y, z, sz, flat) {
  const g = svgEl("g", { class: "fl-pk" });
  if (flat) {
    g.append(
      fBox(x - sz / 2, y - sz / 2, z, sz, sz, 0.07, {
        top: "var(--fl-flat-t)",
        front: "var(--fl-flat-f)",
        side: "var(--fl-flat-s)",
      }),
    );
    const a = fP(x - sz / 4, y - sz / 2 + 0.04, z + 0.07);
    const b = fP(x - sz / 4, y + sz / 2 - 0.04, z + 0.07);
    const c = fP(x + sz / 4, y - sz / 2 + 0.04, z + 0.07);
    const d = fP(x + sz / 4, y + sz / 2 - 0.04, z + 0.07);
    g.append(
      svgEl("path", { d: `M${fPt(a)}L${fPt(b)}M${fPt(c)}L${fPt(d)}`, class: "fl-flat-line" }),
    );
    return g;
  }
  const h = sz * 0.86;
  g.append(fBox(x - sz / 2, y - sz / 2, z, sz, sz, h, FLOOR_KRAFT));
  const t = [
    fP(x - 0.05, y - sz / 2, z + h),
    fP(x + 0.05, y - sz / 2, z + h),
    fP(x + 0.05, y + sz / 2, z + h),
    fP(x - 0.05, y + sz / 2, z + h),
  ];
  g.append(svgEl("polygon", { points: t.map(fPt).join(" "), class: "fl-tape" }));
  return g;
}
const FLOOR_KRAFT = {
  top: "var(--fl-kraft-t)",
  front: "var(--fl-kraft-f)",
  side: "var(--fl-kraft-s)",
};

/**
 * A robot in a hard hat, facing down the line (+x), its agent's shirt number on
 * its chest plate in the club kit (the Tactics Board's shirt tokens). `carry`
 * puts its parcel in its arms. Returns { g, top } (top: above the parcel).
 */
function floorRobot(x0, y0, no, carry) {
  const k = 1.6;
  const u = FU * k;
  const x = x0 / k;
  const y = y0 / k;
  const g = svgEl("g", { class: "fl-bot" });
  const body = { top: "var(--fl-bot-t)", front: "var(--fl-bot-f)", side: "var(--fl-bot-s)" };
  const leg = { base: "var(--fl-bot-leg)" };
  g.append(fBox(x - 0.09, y - 0.12, 0, 0.08, 0.08, 0.2, leg, u));
  if (carry) g.append(fBox(x - 0.02, y - 0.2, 0.23, 0.44, 0.06, 0.06, body, u));
  g.append(fBox(x - 0.09, y + 0.04, 0, 0.08, 0.08, 0.2, leg, u));
  g.append(fBox(x - 0.15, y - 0.15, 0.2, 0.3, 0.3, 0.36, body, u));
  // the chest plate on the +y face: the club shirt colour with the stencil number
  g.append(
    fFace(
      [
        [x - 0.14, y + 0.15, 0.3],
        [x + 0.14, y + 0.15, 0.3],
        [x + 0.14, y + 0.15, 0.555],
        [x - 0.14, y + 0.15, 0.555],
      ],
      "var(--claret)",
      u,
      "f fl-bot-plate",
    ),
  );
  if (no) {
    const [ox, oy] = fP(x - 0.14, y + 0.15, 0.555, u);
    const pw = 0.28 * u;
    g.append(
      svgEl(
        "text",
        {
          transform: `matrix(1,0.5,0,1,${ox.toFixed(1)},${oy.toFixed(1)})`,
          x: (pw / 2).toFixed(1),
          y: 12.4,
          "text-anchor": "middle",
          class: "fl-bot-no",
        },
        String(no),
      ),
    );
  }
  g.append(fBox(x - 0.04, y - 0.04, 0.56, 0.08, 0.08, 0.05, leg, u));
  g.append(fBox(x - 0.12, y - 0.12, 0.6, 0.24, 0.24, 0.22, body, u));
  g.append(
    fFace(
      [
        [x + 0.12, y - 0.1, 0.66],
        [x + 0.12, y + 0.1, 0.66],
        [x + 0.12, y + 0.1, 0.78],
        [x + 0.12, y - 0.1, 0.78],
      ],
      "var(--fl-bot-visor)",
      u,
    ),
  );
  for (const ey of [-0.07, 0.03])
    g.append(
      fFace(
        [
          [x + 0.12, y + ey, 0.7],
          [x + 0.12, y + ey + 0.04, 0.7],
          [x + 0.12, y + ey + 0.04, 0.75],
          [x + 0.12, y + ey, 0.75],
        ],
        "var(--fl-bot-eye)",
        u,
      ),
    );
  const [hx, hy] = fP(x, y, 0.83, u);
  const r = 0.2 * u;
  g.append(
    svgEl("ellipse", { cx: hx, cy: hy + 1, rx: r * 1.35, ry: r * 0.68, class: "fl-hat-brim" }),
    svgEl("path", {
      d: `M${(hx - r).toFixed(1)},${hy.toFixed(1)} a${r.toFixed(1)},${(r * 0.95).toFixed(1)} 0 0 1 ${(2 * r).toFixed(1)},0 z`,
      class: "fl-hat",
    }),
    svgEl("path", {
      d: `M${hx.toFixed(1)},${(hy - r * 0.95).toFixed(1)} v-5`,
      class: "fl-antenna",
    }),
    svgEl("circle", { cx: hx, cy: hy - r * 0.95 - 6.5, r: 2.1, class: "fl-antenna-tip" }),
  );
  let top = fP(x, y, 1.0, u);
  if (carry) {
    g.append(fBox(x + 0.16, y - 0.16, 0.26, 0.32, 0.32, 0.28, FLOOR_KRAFT, u));
    const t = [
      fP(x + 0.28, y - 0.16, 0.54, u),
      fP(x + 0.36, y - 0.16, 0.54, u),
      fP(x + 0.36, y + 0.16, 0.54, u),
      fP(x + 0.28, y + 0.16, 0.54, u),
    ];
    g.append(svgEl("polygon", { points: t.map(fPt).join(" "), class: "fl-tape" }));
    g.append(fBox(x - 0.02, y + 0.14, 0.23, 0.44, 0.06, 0.06, body, u));
    top = fP(x + 0.32, y, 0.56, u);
  }
  return { g, top };
}
function floorCylinder(cx, cy, z0, z1, r, cls) {
  const [bx, by] = fP(cx, cy, z0);
  const [tx, ty] = fP(cx, cy, z1);
  const rx = r * FU * 1.414;
  const ry = r * FU * 0.707;
  return svgEl("g", { class: cls }, [
    svgEl("path", {
      d: `M${bx - rx},${by} L${tx - rx},${ty} A${rx},${ry} 0 0 1 ${tx + rx},${ty} L${bx + rx},${by} A${rx},${ry} 0 0 1 ${bx - rx},${by} Z`,
      class: "fl-cyl-body",
    }),
    svgEl("ellipse", { cx: tx, cy: ty, rx, ry, class: "fl-cyl-top" }),
  ]);
}
/** A tick step for the tank's scale: 3 to 6 graduations up to the budget. */
function floorTickStep(budget) {
  for (const m of [0.01, 0.1, 1, 10, 100, 1000])
    for (const k of [1, 2, 2.5, 5]) if (budget / (m * k) <= 6) return m * k;
  return Math.ceil(budget / 5);
}

/**
 * What the floor shows, from the Overview's match-day read: every open ticket as
 * a parcel at its station, the live claims (robots), today's despatches, the
 * wage bill against the budget and the decisions on the desk.
 */
function floorModel(f) {
  const now = f.now;
  // "Today" is the server's day (UTC midnight), the same day the scoreboard's
  // Delivered today counts, so the lorry and the tile never disagree.
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const needs = new Set(f.items.map((i) => i.ticket && i.ticket.id).filter(Boolean));
  const parkedWhy = new Map();
  for (const i of f.items)
    if (i.kind === "parked" && i.ticket) parkedWhy.set(i.ticket.id, i.reason);
  // A live claim: held now (a stale claim, past its heartbeat, has no robot).
  const live = new Map();
  for (const [tid, c] of f.claimByTicket) {
    if (c.expires_at && Date.parse(c.expires_at) < now) continue;
    const t = f.byId.get(tid);
    if (!t || t.status === "done" || t.status === "cancelled") continue;
    live.set(tid, { claim: c, who: agentWho(c.agent_id, c.agent_display_name) });
  }
  const parcel = (t) => {
    const ev = f.details.get(t.id)?.events;
    const hold = live.get(t.id);
    const run = t.number != null ? f.runByTicket.get(t.number) : null;
    return {
      id: t.id,
      number: t.number,
      title: t.title || "(untitled)",
      status: t.status,
      station: FLOOR_STATION_OF[t.status],
      needs: needs.has(t.id),
      why: parkedWhy.get(t.id) || null,
      who: hold ? hold.who : null,
      agentId: hold ? hold.claim.agent_id : null,
      running: Boolean(hold && run && !run.outcome),
      by:
        !hold && ["in_review", "in_testing", "ready_for_merge", "done"].includes(t.status)
          ? deliveredBy(ev)
          : null,
    };
  };
  const open = f.tickets
    .filter((t) => t.status !== "done" && t.status !== "cancelled" && FLOOR_STATION_OF[t.status])
    .map(parcel);
  const despatched = f.tickets
    .filter((t) => t.status === "done")
    .filter((t) => {
      const at = Date.parse(sinceStatus(f.details.get(t.id)?.events, "done") || t.updated_at);
      return Number.isFinite(at) && at >= dayStart.getTime();
    })
    .map(parcel);
  const all = [...open, ...despatched].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const byStation = {};
  for (const p of all) (byStation[p.station] ||= []).push(p);
  const today = f.cost && typeof f.cost.today_usd === "number" ? f.cost.today_usd : null;
  return {
    open,
    despatched,
    byStation,
    robots: all.filter((p) => p.who),
    // one bench per agent slot, and one for every robot at Assembly beyond them
    benches: Math.max(
      1,
      Math.min(
        FLOOR_MAX_BENCHES,
        Math.max(f.slots || 3, (byStation.assembly || []).filter((p) => p.who).length),
      ),
    ),
    decisions: f.items.filter((i) => i.kind === "decision").length,
    today,
    budget: f.budget,
  };
}

/** The sentence a parcel reads as: "#12 Fix the login redirect, in review, delivered by Kev (No. 9)". */
function floorSentence(p) {
  const named = (w) => `${w.name}${w.no ? ` (No. ${Number(w.no)})` : ""}`;
  let s = `#${p.number} ${p.title}, ${FLOOR_WORDS[p.status] || statusLabel(p.status, p.landing_state)}`;
  if (p.who) s += `, ${named(p.who)} on it${p.running ? ", its run in progress" : ""}`;
  else if (p.by) s += `, delivered by ${named(p.by)}`;
  if (p.needs) s += ", needs you";
  return s;
}

/** Draw the floor: one SVG, every parcel, robot and station a link. */
function floorScene(m) {
  const C = { items: [], tags: [], obstacles: [], signs: [] };
  const add = (depth, node) => C.items.push({ depth, node });
  const count = (k) => (m.byStation[k] || []).length;
  const SLAB = { w: 12.8, d: 10 };

  // the slab, its tile joints, the painted walkways and the lorry's yard
  const floor = svgEl("g", { class: "fl-floor" }, [
    fFace(
      [
        [0, SLAB.d, -0.35],
        [SLAB.w, SLAB.d, -0.35],
        [SLAB.w, SLAB.d, 0],
        [0, SLAB.d, 0],
      ],
      "var(--fl-slab-l)",
    ),
    fFace(
      [
        [SLAB.w, 0, -0.35],
        [SLAB.w, SLAB.d, -0.35],
        [SLAB.w, SLAB.d, 0],
        [SLAB.w, 0, 0],
      ],
      "var(--fl-slab-r)",
    ),
    fFace(
      [
        [0, 0, 0],
        [SLAB.w, 0, 0],
        [SLAB.w, SLAB.d, 0],
        [0, SLAB.d, 0],
      ],
      "var(--fl-ground)",
    ),
    fFace(
      [
        [10.6, SLAB.d, 0],
        [12.6, SLAB.d, 0],
        [12.6, 13.2, 0],
        [10.6, 13.2, 0],
      ],
      "var(--fl-yard)",
    ),
  ]);
  let joints = "";
  for (let i = 1; i < SLAB.w; i++) joints += `M${fPt(fP(i, 0))}L${fPt(fP(i, SLAB.d))}`;
  for (let j = 1; j < SLAB.d; j++) joints += `M${fPt(fP(0, j))}L${fPt(fP(SLAB.w, j))}`;
  floor.append(svgEl("path", { d: joints, class: "fl-joints" }));
  const walk = [
    [fP(0.3, 2.1), fP(11.0, 2.1)],
    [fP(11.0, 2.1), fP(11.0, 9.75)],
    [fP(0.3, 1.12), fP(5.55, 1.12)],
    [fP(12.0, 1.12), fP(12.0, 9.75)],
  ];
  floor.append(
    svgEl("path", { d: walk.map(([a, b]) => `M${fPt(a)}L${fPt(b)}`).join(""), class: "fl-walk" }),
  );

  // the belt, in one-tile chunks so the painter's sort stays honest
  const beltC = {
    top: "var(--fl-belt)",
    front: "var(--fl-belt-side)",
    side: fShade("var(--fl-belt-side)", 18),
  };
  for (let x = 0.3; x < 11.8 - 0.001; x += 1) {
    const w = Math.min(1, 11.8 - x);
    add(x + w / 2 + 1.1, fBox(x, 1.3, 0, w, 0.6, 0.3, beltC));
  }
  for (let y = 1.9; y < 9.75 - 0.001; y += 1) {
    const d = Math.min(1, 9.75 - y);
    add(11 + y + d / 2, fBox(11.2, y, 0, 0.6, d, 0.3, beltC));
  }
  let rollers = "";
  for (let x = 0.5; x < 11.2; x += 0.3)
    rollers += `M${fPt(fP(x, 1.32, 0.3))}L${fPt(fP(x, 1.88, 0.3))}`;
  for (let y = 2.1; y < 9.7; y += 0.3)
    rollers += `M${fPt(fP(11.22, y, 0.3))}L${fPt(fP(11.78, y, 0.3))}`;
  add(0.05, svgEl("path", { d: rollers, class: "fl-rollers" }));

  const glassFor = (k) => (count(k) ? "var(--fl-glass-lit)" : "var(--fl-glass)");
  const needsAt = (k) => (m.byStation[k] || []).some((p) => p.needs);
  // A station is a link to Work, filtered to its first status.
  const stationLink = (k, depth, node, hullPts) => {
    const st = FLOOR_STATIONS[k];
    const n = count(k);
    const what =
      k === "despatch"
        ? `${n} despatched today`
        : `${n} ${n === 1 ? "ticket" : "tickets"}${needsAt(k) ? ", needs you" : ""}`;
    const a = svgEl("a", {
      href: `#/work?status=${k === "assembly" ? "in_progress" : st.statuses[0]}`,
      class: "fl-hit fl-station",
      "aria-label": `${st.name}: ${what}. Open in Work.`,
      "data-station": k,
    });
    a.append(node, svgEl("polygon", { points: hullPts, class: "fl-ring" }));
    add(depth, a);
  };

  // the sheds: a plinth in the station hue, white walls, a sawtooth roof whose
  // glass is lit while the station holds work, the sign on the face to the belt
  const wall = { top: "var(--fl-wall)", front: "var(--fl-wall-f)", side: "var(--fl-wall-s)" };
  for (const [k, b] of Object.entries(FLOOR_SHEDS)) {
    const st = FLOOR_STATIONS[k];
    const g = svgEl("g", { class: `fl-shed fl-shed-${k}` });
    g.append(fBox(b.x, b.y, 0, b.w, b.d, 0.12, { base: st.hue }));
    g.append(fBox(b.x, b.y, 0.12, b.w, b.d, b.h - 0.12, wall));
    g.append(fSawtooth(b.x, b.y, b.w, b.d, b.h, 0.42, st.hue, glassFor(k), b.along));
    if (b.along === "x") fSign(C, b.x + 0.14, b.y + b.d, b.h - 0.04, "x", b.w - 0.28, st.name);
    else {
      if (k !== "testrig") {
        const y0 = b.y + 0.35;
        const y1 = b.y + b.d - 0.35;
        const X = b.x + b.w;
        let lines = "";
        for (let zz = 0.08; zz < 0.46; zz += 0.07)
          lines += `M${fPt(fP(X, y1, zz))}L${fPt(fP(X, y0, zz))}`;
        g.append(
          fFace(
            [
              [X, y0, 0.05],
              [X, y1, 0.05],
              [X, y1, 0.48],
              [X, y0, 0.48],
            ],
            "var(--fl-shutter)",
          ),
          svgEl("path", { d: lines, class: "fl-shutter-lines" }),
        );
      }
      fSign(C, b.x + b.w, b.y + b.d - 0.14, b.h - 0.04, "y", b.d - 0.28, st.name);
    }
    // a needs-you lamp on the roof: the referee's yellow card colour
    if (needsAt(k)) {
      const [lx, ly] = fP(b.x + b.w * 0.5, b.y + b.d * 0.5, b.h + 0.55);
      g.append(
        svgEl("path", { d: `M${lx},${ly + 2} v10`, class: "fl-lamp-post" }),
        svgEl("rect", { x: lx - 6, y: ly - 9, width: 12, height: 12, rx: 2, class: "fl-lamp" }),
      );
    }
    stationLink(k, b.x + b.w / 2 + b.y + b.d / 2, g, fHull(b.x, b.y, 0, b.w, b.d, b.h + 0.42));
  }

  // Stores: an open shelving rack
  {
    const g = svgEl("g", { class: "fl-rack" });
    const steel = { base: "var(--fl-ready)" };
    for (const [px, py] of [
      [3.25, 0.2],
      [5.3, 0.2],
      [3.25, 1.0],
      [5.3, 1.0],
    ])
      g.append(fBox(px - 0.04, py - 0.04, 0, 0.08, 0.08, 1.48, steel));
    for (const z of [0.34, 0.9, 1.44])
      g.append(
        fBox(3.2, 0.18, z, 2.15, 0.88, 0.06, {
          top: "var(--fl-shelf)",
          front: fShade("var(--fl-shelf)", 10),
          side: fShade("var(--fl-shelf)", 20),
        }),
      );
    fSign(C, 3.32, 1.04, 1.86, "x", 1.95, "Stores");
    stationLink("stores", 3.4, g, fHull(3.2, 0.16, 0, 2.15, 0.9, 1.9));
  }

  // the benches: one painted bay per agent slot
  {
    let d = "";
    for (let i = 0; i < m.benches; i++) {
      const x = fBenchX(i);
      const c = [
        [x - 0.42, 2.38],
        [x + 0.42, 2.38],
        [x + 0.42, 3.2],
        [x - 0.42, 3.2],
      ].map(([a, b]) => fP(a, b, 0.004));
      d += `M${c.map(fPt).join("L")}Z`;
    }
    add(0.06, svgEl("path", { d, class: "fl-bay" }));
  }

  // the test-rig gantry over leg 2
  {
    const frame = { base: "var(--fl-test)" };
    const GY = 2.25;
    add(11.05 + GY - 0.3, fBox(11.0, GY - 0.05, 0, 0.1, 0.1, 1.15, frame));
    const front = svgEl("g", {}, [
      fBox(11.95, GY - 0.05, 0, 0.1, 0.1, 1.15, frame),
      fBox(10.98, GY - 0.07, 1.12, 1.1, 0.14, 0.12, frame),
    ]);
    for (const xx of [11.2, 11.5, 11.8]) {
      const [lx, ly] = fP(xx, GY + 0.07, 1.06);
      front.append(svgEl("circle", { cx: lx, cy: ly, r: 2.6, class: "fl-gate-lamp" }));
    }
    add(12.0 + GY + 0.4, front);
  }

  // the jam bay: hazard tape round the floor and a beacon, lit while it holds anything
  const jam = m.byStation.jam || [];
  {
    const g = svgEl("g", { class: `fl-jam${jam.length ? " is-jammed" : ""}` });
    g.append(
      fFace(
        [
          [5.6, 4.0, 0.005],
          [7.6, 4.0, 0.005],
          [7.6, 5.55, 0.005],
          [5.6, 5.55, 0.005],
        ],
        jam.length ? "var(--fl-jam-floor)" : "var(--fl-ground)",
      ),
    );
    if (jam.length) {
      const C4 = [
        [5.6, 4.0],
        [7.6, 4.0],
        [7.6, 5.55],
        [5.6, 5.55],
      ];
      const edges = [
        [C4[0], C4[1], 12],
        [C4[1], C4[2], 10],
        [C4[2], C4[3], 12],
        [C4[3], C4[0], 10],
      ];
      const dash = (a, b, n) => {
        let d = "";
        for (let i = 0; i < n; i += 2) {
          const p0 = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
          const p1 = [a[0] + ((b[0] - a[0]) * (i + 1)) / n, a[1] + ((b[1] - a[1]) * (i + 1)) / n];
          d += `M${fPt(fP(p0[0], p0[1], 0.01))}L${fPt(fP(p1[0], p1[1], 0.01))}`;
        }
        return d;
      };
      g.append(
        svgEl("path", {
          d: edges
            .map(([a, b]) => `M${fPt(fP(a[0], a[1], 0.01))}L${fPt(fP(b[0], b[1], 0.01))}`)
            .join(""),
          class: "fl-hazard-base",
        }),
        svgEl("path", { d: edges.map(([a, b, n]) => dash(a, b, n)).join(""), class: "fl-hazard" }),
      );
    }
    g.append(fBox(5.67, 5.38, 0, 0.06, 0.06, 0.55, { base: "var(--fl-post)" }));
    fSign(C, 5.65, 5.52, 0.98, "x", 1.36, "Jam bay");
    stationLink("jam", 1.0, g, fHull(5.6, 4.0, 0, 2.0, 1.55, 0.01));
    const bg = svgEl("g", { class: "fl-beacon-wrap" });
    bg.append(fBox(7.32, 4.13, 0, 0.08, 0.08, 1.0, { base: "var(--fl-post)" }));
    const [bx, by] = fP(7.36, 4.17, 1.05);
    bg.append(
      svgEl("rect", {
        x: bx - 6,
        y: by - 12,
        width: 12,
        height: 14,
        rx: 3,
        class: jam.length ? "fl-beacon is-on" : "fl-beacon",
      }),
      svgEl("rect", { x: bx - 8, y: by + 1, width: 16, height: 3, rx: 1, class: "fl-beacon-cap" }),
    );
    add(7.36 + 4.17 + 0.3, bg);
  }

  // your desk: a glass-fronted cabin, lit while a decision waits for you
  {
    const g = svgEl("g", { class: "fl-desk" });
    const b = { x: 0.9, y: 6.4, w: 2.5, d: 2.4, h: 0.95 };
    g.append(fBox(b.x, b.y, 0, b.w, b.d, 0.12, { base: "var(--claret)" }));
    g.append(
      fBox(b.x, b.y, 0.12, b.w, b.d, b.h - 0.12, {
        top: "var(--fl-roof)",
        front: "var(--fl-wall-f)",
        side: "var(--fl-wall-s)",
      }),
    );
    const lit = m.decisions ? "var(--fl-glass-lit)" : "var(--fl-glass)";
    g.append(
      fFace(
        [
          [b.x + 0.2, b.y + b.d, 0.28],
          [b.x + b.w - 0.2, b.y + b.d, 0.28],
          [b.x + b.w - 0.2, b.y + b.d, 0.72],
          [b.x + 0.2, b.y + b.d, 0.72],
        ],
        lit,
        FU,
        "f glass",
      ),
      fFace(
        [
          [b.x + b.w, b.y + 0.2, 0.28],
          [b.x + b.w, b.y + b.d - 0.95, 0.28],
          [b.x + b.w, b.y + b.d - 0.95, 0.72],
          [b.x + b.w, b.y + 0.2, 0.72],
        ],
        lit,
        FU,
        "f glass",
      ),
    );
    fSign(C, b.x + b.w, b.y + b.d - 0.12, 1.26, "y", 0.95, "Desk");
    if (m.decisions) {
      const [lx, ly] = fP(b.x + b.w * 0.5, b.y + b.d * 0.5, b.h + 0.1);
      g.append(
        svgEl("path", { d: `M${lx},${ly + 2} v10`, class: "fl-lamp-post" }),
        svgEl("rect", { x: lx - 6, y: ly - 9, width: 12, height: 12, rx: 2, class: "fl-lamp" }),
      );
      C.tags.push({
        at: fP(b.x + b.w * 0.5, b.y + b.d * 0.5, b.h + 0.6),
        text: m.decisions === 1 ? "Decision" : `${m.decisions} decisions`,
        kind: "needs",
        lift: 10,
      });
    }
    const a = svgEl("a", {
      href: "#/overview",
      class: "fl-hit fl-station",
      "aria-label": m.decisions
        ? `Your desk: ${plural(m.decisions, "decision")} ${m.decisions === 1 ? "waits" : "wait"} for you. Answer on the Team sheet.`
        : "Your desk: no decision waits for you. Open the Overview.",
      "data-station": "desk",
    });
    a.append(g, svgEl("polygon", { points: fHull(b.x, b.y, 0, b.w, b.d, b.h), class: "fl-ring" }));
    add(b.x + b.w / 2 + b.y + b.d / 2, a);
  }

  // the spend tank: a glass cylinder filled to today's wage bill over the budget
  {
    const { today, budget } = m;
    const cx = 5.7;
    const cy = 7.5;
    const r = 0.62;
    const zMax = 2.6;
    const frac = budget && today != null ? Math.max(0, Math.min(1, today / budget)) : 0;
    const hot = budget && today != null && today / budget >= 0.9;
    const label =
      today == null
        ? "Spend tank: no spend recorded today."
        : budget
          ? `Spend tank: ${money(today)} of today's ${moneyW(budget)} budget (${Math.round((today / budget) * 100)}%).`
          : `Spend tank: ${money(today)} spent today. No daily budget is set, so the tank has no scale.`;
    const g = svgEl("g", {
      class: `fl-tank${hot ? " is-hot" : ""}`,
      role: "img",
      "aria-label": label,
    });
    g.append(floorCylinder(cx, cy, 0, 0.14, r + 0.08, "fl-tank-base"));
    g.append(floorCylinder(cx, cy, 0.14, 0.14 + zMax, r, "fl-tank-glass"));
    if (frac > 0)
      g.append(floorCylinder(cx, cy, 0.14, 0.14 + zMax * frac, r - 0.05, "fl-tank-fuel"));
    g.append(floorCylinder(cx, cy, 0.14 + zMax, 0.24 + zMax, r + 0.06, "fl-tank-cap"));
    if (budget) {
      const [bx0] = fP(cx, cy, 0);
      const rx = r * FU * 1.414;
      const ry = r * FU * 0.707;
      const step = floorTickStep(budget);
      // a graduation every step, the budget itself last; only the two ends are
      // figured, so the scale never crowds the jam bay's sign beside it
      const marks = [];
      for (let i = 0; i * step < budget - 1e-9; i++) marks.push(Math.round(i * step * 100) / 100);
      marks.push(budget);
      marks.forEach((v, i) => {
        const [, yy] = fP(cx, cy, 0.14 + (zMax * v) / budget);
        g.append(
          svgEl("path", {
            d: `M${(bx0 - rx).toFixed(1)},${yy.toFixed(1)} A${rx.toFixed(1)},${ry.toFixed(1)} 0 0 0 ${(bx0 + rx).toFixed(1)},${yy.toFixed(1)}`,
            class: "fl-grad",
          }),
          svgEl("path", {
            d: `M${(bx0 + rx - 4).toFixed(1)},${yy.toFixed(1)}h11`,
            class: "fl-tick",
          }),
        );
        if (i && i < marks.length - 1) return;
        const lab = v === 0 ? "$0" : moneyW(v);
        g.append(svgEl("text", { x: bx0 + rx + 11, y: yy + 4, class: "fl-tick-label" }, lab));
        C.obstacles.push(fRect(bx0 + rx + 9, yy - 8, lab.length * 7.6 + 4, 15));
      });
    }
    add(cx + cy, g);
    C.tags.push({
      at: fP(cx, cy, 0.3 + zMax),
      text:
        today == null
          ? "No spend today"
          : budget
            ? `${money(today)} of ${moneyW(budget)}`
            : `${money(today)} today`,
      kind: hot ? "danger" : "plain",
      lift: 16,
    });
  }

  // the lorry at the end of the line (its deck carries today's despatches)
  {
    const g = svgEl("g", { class: "fl-lorry" });
    const wheel = (wx, wy) => {
      const [ex, ey] = fP(wx, wy, 0.16);
      return svgEl("ellipse", { cx: ex, cy: ey, rx: 5.2, ry: 7, class: "fl-wheel" });
    };
    // the far wheels go under the deck, the near ones over it
    g.append(wheel(10.95, 10.35), wheel(10.95, 11.6));
    g.append(fBox(10.95, 10.0, 0.32, 1.2, 2.05, 0.22, { base: "var(--fl-lorry-deck)" }));
    g.append(wheel(12.15, 10.35), wheel(12.15, 11.6));
    add(22.1, g);
    const cab = svgEl("g", { class: "fl-lorry" });
    cab.append(wheel(10.95, 12.6));
    cab.append(fBox(10.95, 12.12, 0.24, 1.2, 0.8, 0.95, { base: "var(--fl-lorry)" }));
    cab.append(
      fFace(
        [
          [11.05, 12.92, 0.72],
          [12.05, 12.92, 0.72],
          [12.05, 12.92, 1.08],
          [11.05, 12.92, 1.08],
        ],
        "var(--fl-glass)",
        FU,
        "f glass",
      ),
    );
    cab.append(wheel(12.15, 12.6));
    add(24.1, cab);
  }

  // the parcels, station by station; a ticket held on a bench is carried by its robot
  const benchRobots = [];
  const tagKind = (p) =>
    p.status === "blocked" || p.status === "failed" ? "danger" : p.needs ? "needs" : null;
  const linkFor = (p, cls) =>
    svgEl("a", {
      href: `#/ticket/${p.id}`,
      class: `fl-hit ${cls}`,
      "aria-label": floorSentence(p),
      "data-n": p.number,
      "data-id": p.id,
      "data-status": p.status,
      "data-tip-title": p.title,
    });
  let order = 0;
  for (const k of FLOOR_ORDER) {
    let list = m.byStation[k] || [];
    if (k === "assembly") {
      const held = list.filter((p) => p.who);
      held.sort(
        (a, b) => (Number(a.who.no) || 1e3) - (Number(b.who.no) || 1e3) || a.number - b.number,
      );
      benchRobots.push(...held.slice(0, m.benches));
      list = [...held.slice(m.benches), ...list.filter((p) => !p.who)];
    }
    const slots = floorSlots(k);
    list.forEach((p, i) => {
      const sl = slots[i];
      if (!sl) return;
      const top = fP(sl.x, sl.y, sl.z + sl.sz * 0.86 + 0.02);
      const a = linkFor(p, "fl-parcel");
      const inner = svgEl("g", { class: "fl-drop", style: `--i:${order++}` });
      if (sl.tilt)
        inner.setAttribute(
          "transform",
          `rotate(${p.number % 2 ? -9 : 7} ${top[0].toFixed(1)} ${(top[1] + 10).toFixed(1)})`,
        );
      inner.append(floorParcel(sl.x, sl.y, sl.z, sl.sz, sl.flat));
      a.append(
        inner,
        svgEl("polygon", {
          points: fHull(
            sl.x - sl.sz / 2,
            sl.y - sl.sz / 2,
            sl.z,
            sl.sz,
            sl.sz,
            sl.flat ? 0.07 : sl.sz * 0.86,
          ),
          class: "fl-ring",
        }),
      );
      add(sl.x + sl.y + 0.2 + (sl.z > 0.6 ? sl.z * 0.1 : 0), a);
      const tk = tagKind(p);
      if (k === "jam")
        C.tags.push({
          at: top,
          text: p.status === "paused" ? `#${p.number} paused` : `#${p.number}`,
          kind: tk || "plain",
          lift: 6,
        });
      else if (tk) C.tags.push({ at: top, text: `#${p.number}`, kind: tk, lift: sl.lift ?? 22 });
      // a robot holding a ticket off the benches stands beside its parcel
      if (p.who) {
        const [rx, ry] = floorBeside(k, sl);
        const { g } = floorRobot(rx, ry, p.who.no, false);
        const ra = linkFor(p, "fl-robot");
        ra.setAttribute("data-agent", p.agentId);
        ra.append(
          g,
          svgEl("polygon", {
            points: fHull(rx - 0.28, ry - 0.28, 0, 0.56, 0.56, 1.55),
            class: "fl-ring",
          }),
        );
        add(rx + ry + 0.3, ra);
      }
    });
    if (list.length > slots.length) {
      const last = slots[slots.length - 1];
      C.tags.push({
        at: fP(last.x, last.y, last.z + 0.5),
        text: `+${list.length - slots.length}`,
        kind: "plain",
        lift: 8,
      });
    }
  }
  // robots on the benches, each carrying the parcel of the ticket it holds
  benchRobots.forEach((p, idx) => {
    const x = fBenchX(idx) - 0.12;
    const y = 2.8;
    const { g, top } = floorRobot(x, y, p.who.no, true);
    const a = linkFor(p, "fl-parcel fl-robot");
    a.setAttribute("data-agent", p.agentId);
    const inner = svgEl("g", { class: "fl-bot-wrap", style: `--i:${idx}` });
    inner.append(g);
    a.append(
      inner,
      svgEl("polygon", {
        points: fHull(x - 0.28, y - 0.28, 0, 1.08, 0.56, 1.55),
        class: "fl-ring",
      }),
    );
    add(x + y + 0.3, a);
    if (p.needs) C.tags.push({ at: top, text: `#${p.number}`, kind: "needs", lift: 18 });
  });

  C.items.sort((a, b) => a.depth - b.depth);
  const vb = [-410, -56, 930, 580];
  for (const t of C.tags) t.w = Math.max(34, t.text.length * 7.4 + 14);
  fPlaceTags(C.tags, C.obstacles, vb);
  const tagLayer = svgEl("g", { class: "fl-tags", "aria-hidden": "true" });
  for (const t of C.tags) {
    const [x, y] = t.at;
    const [bx, by, w, h] = t.box;
    const [x0, y0, x1, y1] = fLeader(x, y, bx, by, w, h);
    const straight = Math.abs(x1 - x0) < 1;
    tagLayer.append(
      svgEl("g", { class: `fl-tag fl-tag-${t.kind}` }, [
        svgEl("path", {
          d: `M${x0.toFixed(1)},${y0.toFixed(1)}L${x1.toFixed(1)},${y1.toFixed(1)}`,
          class: "fl-tag-stem",
        }),
        straight ? null : svgEl("circle", { cx: x, cy: y - 2, r: 2.6, class: "fl-tag-dot" }),
        svgEl("rect", { x: bx, y: by, width: w, height: h, rx: 2, class: "fl-tag-box" }),
        svgEl(
          "text",
          { x: bx + w / 2, y: by + 14.5, "text-anchor": "middle", class: "fl-tag-text" },
          t.text,
        ),
      ]),
    );
  }
  const world = svgEl("g", { class: "fl-world" }, [floor, ...C.items.map((i) => i.node)]);
  const signLayer = svgEl("g", { class: "fl-signs", "aria-hidden": "true" }, C.signs);
  const svg = svgEl(
    "svg",
    {
      viewBox: vb.join(" "),
      class: "fl-svg",
      role: "group",
      "aria-label":
        "The factory floor, drawn from live data. Every parcel, robot and station is a link.",
    },
    [world, signLayer, tagLayer],
  );
  // The drawing itself is no Tab stop (Chromium made it one); its links are.
  svg.setAttribute("tabindex", "-1");
  floorTabOrder(svg);
  return svg;
}

/**
 * The drawing is painted back to front (its DOM order is depth), so the browser's
 * Tab order wandered: Drawing office, three of its parcels, Stores, then two more
 * drawing-office parcels. Tab and Shift+Tab inside the floor follow the stations
 * instead, in lifecycle order: each station, then its parcels and robots by ticket
 * number, the desk last. Leaving the floor at either end is the browser's own Tab.
 */
function floorTabOrder(svg) {
  const rank = (a) => {
    const k = a.dataset.station || FLOOR_STATION_OF[a.dataset.status] || "desk";
    const i = FLOOR_ORDER.indexOf(k);
    return [i < 0 ? FLOOR_ORDER.length : i, a.dataset.station ? 0 : 1, Number(a.dataset.n) || 0];
  };
  const ordered = () =>
    [...svg.querySelectorAll("a.fl-hit")]
      .map((a, dom) => ({ a, dom, r: rank(a) }))
      .sort((x, y) => x.r[0] - y.r[0] || x.r[1] - y.r[1] || x.r[2] - y.r[2] || x.dom - y.dom)
      .map((x) => x.a);
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
    const list = ordered();
    const i = list.indexOf(document.activeElement);
    if (i < 0) return;
    const next = list[i + (e.shiftKey ? -1 : 1)];
    if (next) {
      e.preventDefault();
      next.focus();
      return;
    }
    // Off the end: hand the browser the anchor at that end of the DOM, and its own
    // Tab carries on out of the floor from there.
    const all = [...svg.querySelectorAll("a.fl-hit")];
    all[e.shiftKey ? 0 : all.length - 1]?.focus();
  });
  // Tabbing IN lands on the first station going forward, the last thing going back
  // (a click focuses what was clicked: only keyboard entry is redirected).
  let pointing = false;
  svg.addEventListener("pointerdown", () => {
    pointing = true;
    setTimeout(() => (pointing = false), 0);
  });
  svg.addEventListener("focusin", (e) => {
    const from = e.relatedTarget;
    if (pointing || !from || (from !== svg && svg.contains(from))) return;
    if (!e.target.closest?.("a.fl-hit")) return;
    const list = ordered();
    const forward = Boolean(from.compareDocumentPosition(svg) & from.DOCUMENT_POSITION_FOLLOWING);
    const want = forward ? list[0] : list[list.length - 1];
    if (want && want !== e.target) want.focus();
  });
}

/**
 * The hover and focus card: the ticket number and title (and what the floor says
 * about it), kept inside the stage so it can never widen the page.
 */
function wireFloorTips(stage, tip) {
  const show = (a) => {
    clear(tip);
    const n = a.getAttribute("data-n");
    const label = a.getAttribute("aria-label") || "";
    if (n) {
      const title = a.getAttribute("data-tip-title") || "";
      const rest = label.slice(`#${n} ${title}`.length).replace(/^,\s*/, "");
      tip.append(
        el("b", {}, `#${n}`),
        " ",
        el("span", { class: "fl-tip-title" }, title),
        rest ? el("span", { class: "fl-tip-sub" }, rest) : null,
      );
    } else tip.append(el("span", { class: "fl-tip-title" }, label.replace(/ Open in Work\.$/, "")));
    tip.hidden = false;
    const sr = stage.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = r.left - sr.left + r.width / 2 - tw / 2;
    let y = r.top - sr.top - th - 8;
    if (y < 4) y = r.bottom - sr.top + 8;
    x = Math.max(4, Math.min(sr.width - tw - 4, x));
    tip.style.left = `${Math.round(x)}px`;
    tip.style.top = `${Math.round(y)}px`;
  };
  const hide = () => {
    tip.hidden = true;
  };
  const hitOf = (e) => (e.target && e.target.closest ? e.target.closest("a.fl-hit") : null);
  stage.addEventListener("pointerover", (e) => {
    const a = hitOf(e);
    if (a) show(a);
  });
  stage.addEventListener("pointerout", (e) => {
    const a = hitOf(e);
    if (a && !a.contains(e.relatedTarget)) hide();
  });
  stage.addEventListener("focusin", (e) => {
    const a = hitOf(e);
    if (a) show(a);
  });
  stage.addEventListener("focusout", hide);
}

/** The stream's state in the floor's words (null while live or still connecting). */
function floorStreamLine() {
  const st = freshness.state();
  if (st === "offline") {
    const at = freshness.lastOkAt;
    return at
      ? `Can't reach the factory: this is the floor as it stood at ${clockTime(at)}. It moves again when the factory answers.`
      : "Can't reach the factory: the floor moves again when the factory answers.";
  }
  if (st === "polling")
    return "The live stream is down: the floor redraws every 9 seconds instead of the moment a ticket moves.";
  return null;
}

let floorArrived = false;
let floorBootAt = 0;
/** #/floor: the factory floor, live. */
async function renderFloor() {
  const f = await loadMatchDay();
  const m = floorModel(f);
  const wrap = el("div", { class: "view view-floor" });
  const robots = m.robots.length;
  const jam = (m.byStation.jam || []).length;
  const facts = [
    plural(m.open.length, "parcel") + " on the floor",
    `${plural(robots, "robot")} on ${plural(m.benches, "bench", "benches")}`,
    `${jam} in the jam bay`,
    `${m.despatched.length} despatched today`,
    m.today == null
      ? "no wage bill recorded today"
      : m.budget
        ? `${money(m.today)} of the ${moneyW(m.budget)} wage bill`
        : `${money(m.today)} wage bill today`,
  ];
  wrap.appendChild(
    viewHead(
      "Floor",
      "The factory floor: every ticket as a parcel moving station to station, every agent a robot on the one it holds.",
    ),
  );
  wrap.appendChild(el("p", { class: "fl-facts" }, facts.join(" · ")));

  // The stream line lives outside the data signature: it follows the tracker.
  const streamP = el("p", { class: "fl-stream", hidden: true });
  const paintStream = () => {
    // A page that has only just loaded is still connecting: give the stream a moment.
    const line = floorStreamLine();
    const early = Date.now() - floorBootAt < 6000 && freshness.state() === "polling";
    streamP.hidden = !line || early;
    clear(streamP);
    if (line && !early) streamP.append(glyph("blocked", 16), el("span", {}, line));
  };
  if (!floorBootAt) floorBootAt = Date.now();
  paintStream();
  freshness.listeners.add(paintStream);
  const streamTimer = setTimeout(paintStream, 6500);
  wrap.appendChild(streamP);

  // Quiet whenever no parcel is in play, not only before the first despatch: after
  // the day's last merge the floor is just as empty, so say so, with the day's count.
  if (!m.open.length)
    wrap.appendChild(
      el("div", { class: "empty-state fl-quiet" }, [
        el(
          "p",
          { class: "es-title" },
          m.despatched.length
            ? [
                `The floor is quiet: no tickets in play, ${m.despatched.length} despatched today. `,
                el("a", { href: "#/create" }, "Plan a build"),
                " to start the next one.",
              ]
            : [
                "The floor is quiet: no tickets in play. ",
                el("a", { href: "#/create" }, "Plan a build"),
                " to start the shift.",
              ],
        ),
      ]),
    );

  const svg = floorScene(m);
  if (!floorArrived && !prefersReducedMotion()) svg.classList.add("is-arriving");
  const tip = el("div", { class: "fl-tip", "aria-hidden": "true", hidden: true });
  const stage = el("div", { class: "fl-stage" }, [svg, tip]);
  wireFloorTips(stage, tip);

  // The key and the text of the floor: stations in lifecycle order with their
  // tickets, and who is on the benches (shirt, name, ticket).
  const key = el("ul", { class: "fl-key", "aria-label": "Key" }, [
    el("li", {}, [el("i", { class: "fl-sw fl-sw-needs" }), "Needs you"]),
    el("li", {}, [el("i", { class: "fl-sw fl-sw-red" }), "Blocked or failed"]),
    el("li", {}, [el("i", { class: "fl-sw fl-sw-lit" }), "Lit glass: the station holds work"]),
    el("li", {}, [
      el("i", { class: "fl-sw fl-sw-bot" }),
      "A robot: an agent (shirt number) on a live claim",
    ]),
    el("li", {}, [
      el("i", { class: "fl-sw fl-sw-tank" }),
      "Tank: today's wage bill against the daily budget",
    ]),
  ]);
  const stations = el(
    "ol",
    { class: "fl-stations", "aria-label": "Stations, in lifecycle order" },
    FLOOR_ORDER.map((k) => {
      const st = FLOOR_STATIONS[k];
      const list = m.byStation[k] || [];
      return el("li", { dataset: { station: k } }, [
        el("i", { class: `fl-sw fl-sw-${k}`, "aria-hidden": "true" }),
        el("span", { class: "fl-st-name" }, st.name),
        el(
          "span",
          { class: "fl-st-what" },
          k === "despatch"
            ? "done today"
            : st.statuses.map((s) => statusLabel(s).toLowerCase()).join(", "),
        ),
        el("span", { class: "fl-st-n tabnum" }, String(list.length)),
        list.length
          ? el(
              "span",
              { class: "fl-st-tickets" },
              list.map((p) =>
                el("a", { href: `#/ticket/${p.id}`, title: p.title }, `#${p.number}`),
              ),
            )
          : null,
      ]);
    }),
  );
  const bench = el("div", { class: "fl-bench" }, [
    el("h3", {}, "On the benches"),
    m.robots.length
      ? el(
          "ul",
          {},
          m.robots.map((p) =>
            el("li", {}, [
              agentTag(p.who.name, 22, p.who.no, agentTitle(p.who)),
              el("a", { href: `#/ticket/${p.id}` }, [el("b", {}, `#${p.number}`), " ", p.title]),
              el(
                "span",
                { class: "fl-bench-st" },
                FLOOR_WORDS[p.status] || statusLabel(p.status, p.landing_state),
              ),
            ]),
          ),
        )
      : el("p", {}, `No robot is on the floor: ${plural(m.benches, "bench", "benches")} free.`),
  ]);
  wrap.appendChild(
    el("section", { class: "fl-panel", "aria-labelledby": "fl-h" }, [
      el("div", { class: "fl-head" }, [
        el("h2", { id: "fl-h", class: "fl-title" }, [
          "The floor",
          el("span", { class: "panel-aux" }, `${m.open.length} in play`),
        ]),
        el(
          "p",
          { class: "fl-note" },
          "The line runs from the drawing office to the lorry; the jam bay is off it. Hover or focus a parcel for its ticket.",
        ),
      ]),
      stage,
      el("div", { class: "fl-legend" }, [key, el("div", { class: "fl-lists" }, [stations, bench])]),
    ]),
  );

  wrap.dataset.sig = hashText(
    JSON.stringify([
      [...m.open, ...m.despatched].map((p) => [
        p.id,
        p.status,
        p.title,
        p.needs,
        p.who && [p.who.name, p.who.no],
        p.by && [p.by.name, p.by.no],
        p.running,
      ]),
      m.benches,
      m.decisions,
      m.today,
      m.budget,
    ]),
  );
  wrap._mounted = () => {
    floorArrived = true;
  };
  wrap._dispose = () => {
    freshness.listeners.delete(paintStream);
    clearTimeout(streamTimer);
  };
  return wrap;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest?.('a[href^="#"]');
  if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const href = a.getAttribute("href");
  if (href.startsWith("#/") || href === "#") return;
  if (jumpTo(href.slice(1))) e.preventDefault();
});

/**
 * The members' entrance asks for nothing it cannot have. With no token, the public
 * /healthz says whether this server wants one, and if it does the gate is drawn
 * straight away (no data call that can only answer 401). With a token, ONE whoami
 * checks it first: a wrong token gets the gate from that one answer instead of a
 * page of refused reads and a live stream, and a right one tells the views at once
 * whether this token is read-only. Answers whether the dashboard may start.
 */
async function passGate() {
  if (!authToken()) {
    try {
      const res = await fetch("/healthz");
      const body = res.ok ? await res.json() : null;
      if (body && body.auth === true) {
        renderLogin(false);
        return false;
      }
    } catch {
      // An old server or a blip: start, and let the first read say if a token is needed.
    }
    return true;
  }
  try {
    const who = await api("GET", "/api/whoami");
    if (who && typeof who === "object" && who.capability) learnWhoami(who);
  } catch (e) {
    if (e && e.code === "UNAUTHORIZED") return false; // api() drew the gate already
    // Slow, failing or unreachable: start anyway (unknown counts as full; the server
    // still refuses a read token's writes), without a second wait for the same answer.
    squad.whoamiFailed = true;
  }
  return true;
}

async function start() {
  adoptTokenFromUrl(); // one-scan token pickup (QR) before the first authed call
  if (!(await passGate())) return;
  buildChrome();
  window.addEventListener("hashchange", () => {
    // A bare fragment that names a section on this page is a jump, not a route.
    const h = location.hash || "";
    if (h.length > 1 && !h.startsWith("#/") && jumpTo(h.slice(1))) return;
    // A sheet belongs to the page that opened it: a reason being written for #15 must
    // never stay over #20 (Back, a link, a typed address), where confirming it would
    // act on a ticket the reader is no longer looking at.
    if (sheetOpen()) closeSheet({ restore: false });
    router();
  });
  router();
}
start();

export {
  safeHttpUrl,
  renderTicketDiff,
  reopenedForReview,
  pausedInfo,
  parseDodEvidence,
  evidenceKind,
  reviewEvidenceList,
  REJECT_REASON_PRESETS,
  WONT_DO_PRESETS,
  isModalOpen,
  deliveredBy,
  reviewRawWatch,
  noteReviewOpen,
  sinceStatus,
  integrityFlagOf,
  renderReview,
  typeLabel,
  renderFactory,
  backLink,
  renderHidden,
  renderNode,
  renderRepo,
  computePhases,
  isAcceptanceTicket,
  renderEpics,
  openPlanBuild,
  mountPlanBuildInline,
  resolveTargetRepos,
  targetPicker,
  openSpecBuild,
  renderSpecs,
  renderMemory,
  openClubSheet,
  renderSquad,
  renderFloor,
};
