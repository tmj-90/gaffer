// View: Memory (Repo Digest, Feature ledger, Lore).
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { roLock } from "../access.js";
import { api } from "../api.js";
import { emptyState, panelHead, statCell, viewHead } from "../components.js";
import { app, clear, el, field } from "../dom.js";
import { fmtDay, fmtTime, plural } from "../format.js";
import { badge, icon, kitShirt, repoTag, ycard } from "../icons.js";
import {
  carryOpenForms,
  disposeView,
  mountView,
  navigate,
  parseHash,
  routeGen,
  routeSignal,
} from "../router.js";
import { toast } from "../toast.js";
import { onboardButton } from "./onboarding.js";
import { hashText } from "./work.js";

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

export { memoryState, writeMemoryStateToUrl, repoHasDigest, renderMemory };
