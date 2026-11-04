// The diff: safe links, the diff renderer, per-file sections, risk overlay, approvability.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api } from "./api.js";
import { clear, el } from "./dom.js";
import { icon, ycard } from "./icons.js";
import { routeSignal } from "./router.js";

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

export { safeHttpUrl, splitDiffFiles, repoDiffSection, renderTicketDiff };
