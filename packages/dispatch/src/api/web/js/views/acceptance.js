// Ticket acceptance: the acceptance profile, runtime acceptance, tester provenance, add an AC.
// Moved verbatim from app.js (the entry); the module map is in app.js.

import { api } from "../api.js";
import { el, field } from "../dom.js";
import { fmtTime } from "../format.js";
import { glyph } from "../icons.js";
import { router } from "../router.js";
import { guard, toast } from "../toast.js";

// ACCEPTANCE PROFILES (Release C): how the tester's PASS is proven. The runner runs the
// commands a person registers for the cli and api profiles; web, migration and
// performance are defined but not run yet (a PASS there is a person's verdict).
const ACCEPTANCE_PROFILE_HELP = {
  unit: "The tester's tests, replayed on a clean checkout of the tested commit (the default).",
  cli: "The runner also runs the commands you register on the clean checkout and records a transcript: argv, exit code, stdout, stderr, files changed. A PASS needs every expectation to hold.",
  api: "The runner also boots the service with your command on a free port, waits for its health path and runs each probe, recording the responses. A PASS needs every probe to answer as expected.",
  web: "Defined, not run by the runner yet: the tester's PASS is held for your verdict.",
  migration: "Defined, not run by the runner yet: the tester's PASS is held for your verdict.",
  performance: "Defined, not run by the runner yet: the tester's PASS is held for your verdict.",
};
const ACCEPTANCE_SPEC_EXAMPLE = {
  cli: {
    cases: [{ argv: ["node", "bin/cli.mjs", "--version"], expect: { exit: 0, stdout: ["1.0"] } }],
  },
  api: {
    boot_argv: ["node", "server.mjs"],
    health_path: "/health",
    probes: [{ method: "GET", path: "/items", expect: { status: 200 } }],
  },
};
const TEST_CONTRACT_EDITABLE = [
  "draft",
  "refining",
  "ready",
  "blocked",
  "claimed",
  "in_progress",
  "in_review",
];

/** The ticket's acceptance profile, and (while the contract is editable) a form to set it. */
function renderAcceptanceProfile(t, closed) {
  let raw;
  try {
    raw = t.test_contract ? JSON.parse(t.test_contract) : null;
  } catch {
    raw = null;
  }
  const profile =
    raw && typeof raw.profile === "string" && raw.profile in ACCEPTANCE_PROFILE_HELP
      ? raw.profile
      : "unit";
  const spec =
    raw && raw.profile_spec && typeof raw.profile_spec === "object" ? raw.profile_spec : null;
  const count =
    profile === "cli" && spec && Array.isArray(spec.cases)
      ? `${spec.cases.length} ${spec.cases.length === 1 ? "command" : "commands"} registered`
      : profile === "api" && spec && Array.isArray(spec.probes)
        ? `${spec.probes.length} ${spec.probes.length === 1 ? "probe" : "probes"} registered`
        : profile === "cli" || profile === "api"
          ? "no commands registered yet: the tester's PASS is held until you register them"
          : "";
  const current = el("p", { class: "tk-accept-current" }, [
    el("span", { class: "badge no-dot" }, profile),
    " ",
    ACCEPTANCE_PROFILE_HELP[profile],
    count ? el("span", { class: "dim" }, ` ${count}.`) : null,
  ]);
  if (closed || !TEST_CONTRACT_EDITABLE.includes(t.status)) {
    return el("div", { class: "tk-accept" }, [
      current,
      closed
        ? null
        : el(
            "p",
            { class: "dim" },
            "Frozen while the ticket is in testing or later: the tester is bound to the contract it read.",
          ),
    ]);
  }
  const select = el(
    "select",
    { "aria-label": "Acceptance profile" },
    Object.keys(ACCEPTANCE_PROFILE_HELP).map((p) => {
      const o = el("option", { value: p }, p);
      if (p === profile) o.selected = true;
      return o;
    }),
  );
  const area = el("textarea", {
    class: "mono",
    rows: "8",
    "aria-label": "Profile spec (JSON)",
    spellcheck: "false",
  });
  area.value = spec ? JSON.stringify(spec, null, 2) : "";
  const fillExample = () => {
    if (!area.value.trim() && ACCEPTANCE_SPEC_EXAMPLE[select.value])
      area.placeholder = JSON.stringify(ACCEPTANCE_SPEC_EXAMPLE[select.value], null, 2);
  };
  fillExample();
  select.addEventListener("change", fillExample);
  const save = el("button", { class: "btn", type: "button" }, "Save profile");
  save.addEventListener("click", () =>
    guard(async () => {
      let body;
      const text = area.value.trim();
      if (select.value === "unit" || !text) body = { profile: select.value };
      else {
        try {
          body = { profile: select.value, spec: JSON.parse(text) };
        } catch {
          toast("The spec is not valid JSON", { ok: false });
          return;
        }
      }
      await api("POST", `/tickets/${t.id}/acceptance-profile`, body);
      toast(`Acceptance profile set to ${select.value}`, { ok: true });
      router();
    }),
  );
  return el("div", { class: "tk-accept" }, [
    current,
    el("details", { class: "tk-accept-edit" }, [
      el("summary", {}, "Change the acceptance profile"),
      el(
        "p",
        { class: "setting-help dim" },
        "The runner runs these commands itself, on a clean checkout, in the same sandbox as the gates: argv lists, never shell strings. Changing them changes the contract, so an earlier PASS no longer covers the ticket.",
      ),
      el("label", {}, ["Profile ", select]),
      area,
      el("div", {}, save),
    ]),
  ]);
}

/** One acceptance evidence row's payload (the runner's), or null. */
function acceptancePayload(e) {
  if (
    !e ||
    e.recorded_by_actor_type !== "system" ||
    typeof e.uri !== "string" ||
    !e.uri.startsWith("gaffer-acceptance:")
  )
    return null;
  try {
    const p = JSON.parse(e.payload_json || "{}");
    return p && (p.kind === "transcript" || p.kind === "api_response") ? p : null;
  } catch {
    return null;
  }
}

/** The transcript / probe record as plain text (never HTML). Exported for the tests. */
function acceptanceTranscriptText(p) {
  const out = [];
  const ex = (s) => (s && typeof s.excerpt === "string" ? s.excerpt.trimEnd() : "");
  const checks = (c) =>
    (Array.isArray(c.checks) ? c.checks : [])
      .map((k) => `  ${k.held ? "ok  " : "FAIL"} ${k.what}${k.detail ? ` (${k.detail})` : ""}`)
      .join("\n");
  if (p.sandbox) out.push(`sandbox: ${p.sandbox}`);
  if (p.kind === "api_response" && p.boot) {
    const b = p.boot;
    out.push(
      `$ ${(b.argv || []).join(" ")}   (${b.port_env || "PORT"}=${b.port ?? "?"})`,
      `health ${b.health ? `${b.health.path}: ${b.health.healthy ? "healthy" : "not healthy"} after ${b.health.waited_ms ?? "?"} ms` : "not reached"}`,
    );
  }
  for (const c of Array.isArray(p.cases) ? p.cases : []) {
    out.push("");
    if (p.kind === "transcript") {
      out.push(`$ ${(Array.isArray(c.argv) ? c.argv : []).join(" ")}`);
      out.push(
        `exit ${c.exit ?? "none"}${c.signal ? ` (signal ${c.signal})` : ""}${c.timed_out ? " (timed out)" : ""}${c.duration_ms !== undefined ? `, ${c.duration_ms} ms` : ""}`,
      );
      if (ex(c.stdout)) out.push("stdout:", ex(c.stdout));
      if (ex(c.stderr)) out.push("stderr:", ex(c.stderr));
      const fs = c.fs || {};
      const changed = [
        ...(fs.added || []).map((f) => `+ ${f}`),
        ...(fs.modified || []).map((f) => `~ ${f}`),
        ...(fs.deleted || []).map((f) => `- ${f}`),
      ];
      if (changed.length) out.push("files:", ...changed.map((l) => `  ${l}`));
    } else {
      const req = c.request || {};
      const res = c.response || {};
      out.push(
        `${req.method || "GET"} ${req.path || c.name || ""} -> ${res.status ?? "no answer"}`,
      );
      if (res.headers && Object.keys(res.headers).length)
        out.push(...Object.entries(res.headers).map(([k, v]) => `  ${k}: ${v}`));
      if (ex(res.body)) out.push("body:", ex(res.body));
    }
    const k = checks(c);
    if (k) out.push(k);
  }
  return out.join("\n");
}

/** The runner's runtime acceptance records, newest first, as expandable text. */
function renderRuntimeAcceptance(evidence) {
  const rows = (evidence || [])
    .map((e) => ({ e, p: acceptancePayload(e) }))
    .filter((r) => r.p !== null)
    .reverse();
  if (!rows.length) return el("p", { class: "dim" }, "No runtime acceptance recorded.");
  return el(
    "ul",
    { class: "clean" },
    rows.map(({ e, p }) =>
      el("li", { class: `tt-row tt-${p.passed ? "pass" : "fail"} tk-accept-row` }, [
        glyph(p.passed ? "done" : "failed", 16, p.passed ? "Passed" : "Did not pass"),
        el("details", { class: "tk-accept-transcript" }, [
          el("summary", {}, [
            e.summary,
            el("span", { class: "badge no-dot", style: "margin-left:8px" }, "by runner"),
            " ",
            el("code", { class: "mono" }, String(p.tested_commit || "").slice(0, 12)),
          ]),
          el(
            "p",
            { class: "dim" },
            `Recorded by the runner (system), ${p.kind === "transcript" ? "the CLI transcript" : "the API probe responses"} on tested commit ${p.tested_commit}. Excerpts are bounded and redacted; each stream's sha256 is in the record.`,
          ),
          el("pre", { class: "mono tk-accept-pre" }, acceptanceTranscriptText(p)),
        ]),
        el("div", { class: "ac-meta tt-who" }, `runner · ${fmtTime(e.created_at)}`),
      ]),
    ),
  );
}

/**
 * The tester agent a system-recorded PASS names ({ id, run }), from a test_output row's
 * payload_json, or null (an agent's or a person's PASS, a legacy row).
 */
function parseTesterAgent(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    const a = o && typeof o === "object" ? o.tester_agent : null;
    return a && typeof a === "object" && typeof a.id === "string" && a.id
      ? { id: a.id, run: typeof a.run === "string" ? a.run : null }
      : null;
  } catch {
    return null;
  }
}

/**
 * How a tester PASS the runner recorded as the system reads: "recorded by the runner
 * after the tester agent's run" (the runner measured the identities; the verdict is the
 * tester agent's). "" for any other PASS, which keeps its own wording.
 */
function testerRecordedBy(provenance, agent) {
  if (provenance !== "system" || !agent || !agent.id) return "";
  const who = agent.id === "tester" ? "the tester agent" : agent.id;
  return `recorded by the runner after ${who}'s run`;
}

/** The review packet's "by …" line for the tester verdict. */
function testerByline(ts) {
  const recorded = testerRecordedBy(ts.provenance, ts.tester_agent);
  if (recorded) return ` · ${recorded}`;
  return ts.provenance
    ? ` · by ${ts.provenance === "agent" ? "the tester agent" : `a ${ts.provenance}`}`
    : "";
}

/**
 * BBT-001: pull the tester-verdict provenance ("agent" | "human" | "system") out of
 * a test_output evidence row's payload_json, tolerant of legacy rows with no payload.
 */
function parseTesterProvenance(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    const p = o && typeof o === "object" ? o.provenance : null;
    return p === "agent" || p === "human" || p === "system" ? p : null;
  } catch {
    return null;
  }
}

/**
 * The BBT tester verdict ("pass" | "fail") from a test_output row's payload_json, or
 * null when the row is not a tester verdict. This is the marker that distinguishes a
 * tester result from ordinary implementation/AC test_output evidence.
 */
function parseTesterVerdict(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    const v = o && typeof o === "object" ? o.verdict : null;
    return v === "pass" || v === "fail" ? v : null;
  } catch {
    return null;
  }
}

/** Parse the raw test_contract JSON column for the detail card (tolerant). */
function parseTicketTestContract(raw) {
  if (!raw) return null;
  try {
    const o = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!o || typeof o !== "object") return null;
    const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    return {
      changed_surfaces: list(o.changed_surfaces),
      runtime_deps: list(o.runtime_deps),
      env_vars: list(o.env_vars),
      run_command: typeof o.run_command === "string" ? o.run_command : "",
      harness_ready: o.harness_ready === true,
    };
  } catch {
    return null;
  }
}

function renderAddAcForm(ticketId) {
  const text = el("input", {
    type: "text",
    placeholder: "New acceptance criterion…",
    required: "",
  });
  const verify = el("input", { type: "text", placeholder: "verification method (optional)" });
  // MACHINE-CHECKABLE AC: a shell command the RUNNER executes in the delivery
  // worktree; exit 0 ⇒ satisfied (runner-verified), else rework. Optional.
  const check = el("input", {
    type: "text",
    name: "check_command",
    placeholder: "check command, e.g. npm test (optional — runner-executed)",
  });
  const evidence = el("input", { type: "checkbox" });
  const form = el(
    "form",
    {
      class: "inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        const body = { text: text.value.trim() };
        if (!body.text) return;
        if (verify.value.trim()) body.verification_method = verify.value.trim();
        if (check.value.trim()) body.check_command = check.value.trim();
        if (evidence.checked) body.evidence_required = true;
        guard(async () => {
          await api("POST", `/tickets/${ticketId}/acceptance-criteria`, body);
          toast("Acceptance criterion added", { ok: true });
          router();
        });
      },
    },
    [
      field("Criterion", text),
      field("Verification", verify),
      field("Check command", check),
      el("div", { class: "field", style: "flex:0 0 auto" }, [
        el("label", {}, "Evidence"),
        el("label", { class: "checkbox-line" }, [evidence, "required"]),
      ]),
      el("button", { class: "btn", type: "submit" }, "Add AC"),
    ],
  );
  return form;
}

export {
  renderAcceptanceProfile,
  renderRuntimeAcceptance,
  parseTesterAgent,
  testerRecordedBy,
  testerByline,
  parseTesterProvenance,
  parseTesterVerdict,
  parseTicketTestContract,
  renderAddAcForm,
};
