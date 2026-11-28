// Research before the spec (backlog 69): the research step inside Plan a build.
//
// WHAT IS RENDERED, AND HOW (protection G). Everything in a research run came from a
// model that read pages anyone can write, so it is shown as PLAIN TEXT: every string goes
// through el()'s text children (createTextNode), never el()'s `html` attribute, never
// innerHTML, never Markdown. A source is a link only when it is https, carries no
// credentials and its host is the one the server checked (safeResearchHref); it opens in
// a new tab with rel="noopener noreferrer" and its full host is written beside it. No
// image, favicon, preview or embed of anything from a result is ever made, and nothing
// here fetches a research URL: the only requests are to this dashboard's own API.
// The marks ("not fetched by the run", "the agent's opinion", "only opinion behind it")
// are computed by the server from the research hook's log; the model cannot set them.

import { api } from "../api.js";
import { clear, el } from "../dom.js";

export const RESEARCH_PRIORITIES = ["must", "should", "could", "wont"];
const PRIORITY_WORDS = {
  must: "Must",
  should: "Should",
  could: "Could",
  wont: "Won't",
};

/**
 * The href for a research source, or null when it must not be a link: anything that is
 * not an absolute https URL, carries a user or password, or whose host differs from the
 * host the server checked and shows.
 */
export function safeResearchHref(source) {
  if (!source || typeof source.url !== "string" || typeof source.host !== "string") return null;
  if (!/^https:\/\//.test(source.url)) return null;
  let u;
  try {
    u = new URL(source.url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  if (u.hostname !== source.host) return null;
  return u.href;
}

/** One source: a safe link (or plain text), its host beside it, and its fetch mark. */
export function renderResearchSource(source) {
  const href = safeResearchHref(source);
  const text = String(source && source.url != null ? source.url : "");
  return el("span", { class: "rs-source" }, [
    href
      ? el("a", { class: "rs-link", href, target: "_blank", rel: "noopener noreferrer" }, text)
      : el("span", { class: "rs-link rs-inert" }, text),
    el(
      "span",
      { class: "rs-host dim" },
      ` (${String(source && source.host ? source.host : "unknown host")})`,
    ),
    source && source.fetched === false
      ? el("span", { class: "rs-mark" }, "not fetched by the run")
      : null,
  ]);
}

function section(title, children) {
  return el("section", { class: "rs-section" }, [el("h4", { class: "rs-h" }, title), ...children]);
}

/** The findings (claim, why, sources), read-only. */
function renderFindings(findings) {
  if (!findings.length) return el("p", { class: "dim" }, "No findings.");
  return el(
    "ol",
    { class: "rs-findings" },
    findings.map((f) =>
      el("li", { class: "rs-finding", dataset: { id: f.id } }, [
        el("div", { class: "rs-claim" }, [
          el("span", { class: "rs-id dim" }, `${f.id} `),
          String(f.claim || ""),
        ]),
        f.why ? el("div", { class: "rs-why dim" }, String(f.why)) : null,
        f.opinion
          ? el(
              "div",
              { class: "rs-mark" },
              "The agent's opinion: no source was fetched by the run.",
            )
          : null,
        f.sources && f.sources.length
          ? el(
              "ul",
              { class: "rs-sources" },
              f.sources.map((s) => el("li", {}, renderResearchSource(s))),
            )
          : null,
      ]),
    ),
  );
}

/**
 * The editable feature list. `state.features` is the panel's working copy:
 * { id?, title, description, priority, kept, origin?, unsupported?, backed_by? }.
 */
function renderFeatures(state, locked, repaint) {
  const rows = state.features.map((f, i) => {
    const kept = el("input", {
      type: "checkbox",
      class: "rs-keep",
      "aria-label": `Keep feature ${i + 1}`,
      checked: f.kept ? "" : undefined,
      disabled: locked ? "" : undefined,
      onchange: (e) => {
        f.kept = e.target.checked;
        state.dirty = true;
        repaint();
      },
    });
    const title = el("input", {
      type: "text",
      class: "rs-title-input",
      value: String(f.title || ""),
      maxlength: "120",
      "aria-label": `Feature ${i + 1} title`,
      disabled: locked ? "" : undefined,
      oninput: (e) => {
        f.title = e.target.value;
        state.dirty = true;
      },
    });
    const prio = el(
      "select",
      {
        class: "rs-priority",
        "aria-label": `Feature ${i + 1} priority`,
        disabled: locked ? "" : undefined,
        onchange: (e) => {
          f.priority = e.target.value;
          state.dirty = true;
        },
      },
      RESEARCH_PRIORITIES.map((p) =>
        el("option", { value: p, selected: f.priority === p ? "" : undefined }, PRIORITY_WORDS[p]),
      ),
    );
    const desc = el("textarea", {
      class: "rs-desc",
      rows: "2",
      maxlength: "400",
      "aria-label": `Feature ${i + 1} description`,
      disabled: locked ? "" : undefined,
      oninput: (e) => {
        f.description = e.target.value;
        state.dirty = true;
      },
    });
    desc.value = String(f.description || "");
    return el(
      "li",
      { class: `rs-feature${f.kept ? "" : " rs-dropped"}`, dataset: { id: f.id || "" } },
      [
        el("div", { class: "rs-feature-row" }, [kept, title, prio]),
        desc,
        el("div", { class: "rs-feature-meta dim" }, [
          f.origin === "person" ? "Added by you. " : null,
          f.backed_by && f.backed_by.length ? `Backed by ${f.backed_by.join(", ")}. ` : null,
          f.unsupported && f.origin !== "person"
            ? el("span", { class: "rs-mark" }, "Only the agent's opinion behind it.")
            : null,
        ]),
      ],
    );
  });
  const add = locked
    ? null
    : el(
        "button",
        {
          class: "btn rs-add",
          type: "button",
          onclick: () => {
            state.features.push({
              title: "",
              description: "",
              priority: "should",
              kept: true,
              origin: "person",
            });
            state.dirty = true;
            repaint();
          },
        },
        "Add a feature",
      );
  return el("div", {}, [el("ol", { class: "rs-features" }, rows), add]);
}

function renderQuestions(state, locked, repaint) {
  if (!state.questions.length) return el("p", { class: "dim" }, "No open questions.");
  return el(
    "ul",
    { class: "rs-questions" },
    state.questions.map((q) =>
      el("li", {}, [
        el("label", { class: "rs-q" }, [
          el("input", {
            type: "checkbox",
            checked: q.kept ? "" : undefined,
            disabled: locked ? "" : undefined,
            onchange: (e) => {
              q.kept = e.target.checked;
              state.dirty = true;
              repaint();
            },
          }),
          ` ${String(q.text || "")}`,
        ]),
      ]),
    ),
  );
}

/** The working copy of a run's editable parts. */
export function researchEditState(run) {
  return {
    runId: run.id,
    features: (run.features || []).map((f) => ({ ...f })),
    questions: (run.open_questions || []).map((q) => ({ ...q })),
    dirty: false,
  };
}

/**
 * The whole research card for a run. `ctx`: { state (researchEditState), locked
 * (true for a read token / scoped token, or once a spec was drafted), repaint(),
 * onSave(), onDraft(), busy, error }.
 */
export function renderResearchRun(run, ctx) {
  const wrap = el("section", { class: "pb-proposal rs-card", "aria-label": "Research" });
  wrap.appendChild(
    el("div", { class: "pb-proposal-head" }, [
      el("div", { class: "pb-bot-label" }, "Research"),
      el("div", { class: "rs-status dim" }, statusLine(run)),
    ]),
  );
  if (run.status === "running") {
    wrap.appendChild(
      el("p", { class: "rs-running" }, [
        el("span", { class: "btn-spinner", "aria-hidden": "true" }),
        " The research agent is searching and reading pages. This can take several minutes; you can close this panel and come back.",
      ]),
    );
    return wrap;
  }
  if (run.status === "failed") {
    wrap.appendChild(
      el(
        "p",
        { class: "pb-error-msg" },
        `The research run failed: ${String(run.error || "no reason given")}`,
      ),
    );
    return wrap;
  }
  if (run.status === "discarded") {
    wrap.appendChild(el("p", { class: "dim" }, "This research run was discarded."));
    return wrap;
  }
  const locked = !!ctx.locked || !!run.spec_id;
  if (run.summary) wrap.appendChild(el("p", { class: "rs-summary" }, String(run.summary)));
  wrap.appendChild(
    section("Features (keep, drop, reword, re-rank, add your own)", [
      renderFeatures(ctx.state, locked, ctx.repaint),
    ]),
  );
  wrap.appendChild(
    section("Open questions (a kept one becomes a decision to settle in the spec)", [
      renderQuestions(ctx.state, locked, ctx.repaint),
    ]),
  );
  wrap.appendChild(section("Findings", [renderFindings(run.findings || [])]));
  if (run.comparables && run.comparables.length) {
    wrap.appendChild(
      section("Comparable products", [
        el(
          "ul",
          { class: "rs-comparables" },
          run.comparables.map((c) =>
            el("li", {}, [
              el("b", {}, String(c.name || "")),
              c.note ? ` ${String(c.note)}` : null,
              c.source ? el("div", {}, renderResearchSource(c.source)) : null,
            ]),
          ),
        ),
      ]),
    );
  }
  if (run.risks && run.risks.length) {
    wrap.appendChild(
      section("Risks", [
        el(
          "ul",
          {},
          run.risks.map((k) => el("li", {}, String(k.text || ""))),
        ),
      ]),
    );
  }
  const log = run.log || { fetches: [], searches: [] };
  wrap.appendChild(
    el("p", { class: "rs-log dim" }, [
      `The run searched ${log.searches.length} ${log.searches.length === 1 ? "time" : "times"} and fetched ${log.fetches.length} ${log.fetches.length === 1 ? "page" : "pages"}`,
      run.dropped_urls
        ? `; ${run.dropped_urls} link(s) it gave failed the URL rules and were left out`
        : "",
      ".",
    ]),
  );
  if (ctx.error) wrap.appendChild(el("p", { class: "pb-error-msg" }, String(ctx.error)));
  if (run.spec_id) {
    wrap.appendChild(
      el(
        "p",
        { class: "dim" },
        "A spec was drafted from this research; edit and freeze it in the spec step.",
      ),
    );
  } else {
    const save = el(
      "button",
      {
        class: "btn",
        type: "button",
        disabled: locked || ctx.busy || !ctx.state.dirty ? "" : undefined,
        onclick: ctx.onSave,
      },
      "Save changes",
    );
    const draft = el(
      "button",
      {
        class: "btn primary rs-draft",
        type: "button",
        disabled: locked || ctx.busy ? "" : undefined,
        onclick: ctx.onDraft,
      },
      "Draft the spec from this",
    );
    if (ctx.locked && ctx.lockTitle) {
      save.setAttribute("title", ctx.lockTitle);
      draft.setAttribute("title", ctx.lockTitle);
    }
    wrap.appendChild(el("div", { class: "pb-proposal-actions" }, [save, draft]));
  }
  return wrap;
}

function statusLine(run) {
  const n = (run.features || []).filter((f) => f.kept).length;
  if (run.status === "running") return "Running";
  if (run.status === "ready") return `${n} of ${(run.features || []).length} features kept`;
  return run.status;
}

/** The edit body the server takes (PATCH /research/:id) from a working copy. */
export function researchEditBody(state) {
  return {
    features: state.features
      .filter((f) => String(f.title || "").trim())
      .map((f) => ({
        ...(f.id ? { id: f.id } : {}),
        title: String(f.title).trim(),
        description: String(f.description || "").trim(),
        priority: RESEARCH_PRIORITIES.includes(f.priority) ? f.priority : "should",
        kept: !!f.kept,
      })),
    open_questions: state.questions.map((q) => ({ id: q.id, kept: !!q.kept })),
  };
}

/** Save the working copy; resolves to the updated run. */
export async function saveResearch(state) {
  const res = await api(
    "PATCH",
    `/research/${encodeURIComponent(state.runId)}`,
    researchEditBody(state),
  );
  return res.research;
}

/** Remove every child of `node` and draw `run` into it (used by the plan panel). */
export function paintResearch(node, run, ctx) {
  clear(node);
  node.appendChild(renderResearchRun(run, ctx));
}
