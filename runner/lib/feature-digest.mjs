#!/usr/bin/env node
/**
 * Gaffer factory — the FEATURE-LIFECYCLE + REPO-DIGEST wiring.
 *
 * Connects the factory's merge step (bin/merge-ticket.mjs) and the brownfield
 * epic-create path (bin/decompose.mjs → dashboard `create_epic`) to the memory
 * product's MCP surface:
 *   update_repo_digest / get_repo_digest
 *   add_feature(repo, scope_node?, name, summary, status, provenance)
 *   advance_feature(id, toStatus)        — backlog → building → shipped
 *   list_features
 * exposed to this Node runner as deterministic MEMORY CLI verbs (the `lg` helper /
 * MEMORY_CLI_BIN channel in factory.config.sh — the same memory product the
 * onboard producer already writes to via the memory MCP). These are NOT dispatch
 * control-plane verbs: digest + feature lifecycle live in the memory product, so the
 * merge producer writes there. This module follows the EXACT precedent set by
 * `buildReapprovalCommand`: it builds the argv, the caller runs it best-effort, and a
 * non-zero exit is logged, never fatal (the memory product catches up; the merge
 * ALWAYS succeeds regardless).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE COST DESIGN — prepare-at-delivery / apply-at-merge
 * ─────────────────────────────────────────────────────────────────────────────
 * The digest must stay fresh on merge WITHOUT a fresh full `claude -p` per merge,
 * and a REJECTED delivery must never pollute the digest. So the work is split:
 *
 *   PREPARE (delivery agent, already running, already knows the diff): the agent
 *   records a single structured EVIDENCE row on the ticket — a `manual_note`
 *   whose summary starts with the marker `GAFFER_DIGEST_DELTA_V1` followed by a
 *   JSON payload describing the digest section deltas + the feature note. This is
 *   recorded as ordinary AC/delivery evidence; it is INERT until a merge applies
 *   it. A rejected ticket never merges, so its prepared delta never lands.
 *
 *   APPLY (merge, deterministic, NO agent): on a CLEAN merge bin/merge-ticket.mjs
 *   reads the ticket's evidence (`wg ticket show`), finds the LAST
 *   GAFFER_DIGEST_DELTA_V1 payload, and replays it as plain CLI writes — stamping
 *   each digest section with `source: "merge:#<n>"` and advancing/adding the
 *   feature to `shipped`. No model is spawned in the merge hot path.
 *
 *   FALLBACK: a merge with NO prepared delta (e.g. an older delivery) still does a
 *   MINIMAL deterministic update — stamp the repo digest freshness with
 *   `source: "merge:#<n>"` and advance/add the linked feature to `shipped`. Still
 *   no agent.
 *
 * IDEMPOTENCE: every write carries `--source merge:#<n>` (digest) or is an
 * advance to a terminal status (feature). A re-run merge re-stamps the same
 * source and re-asserts `shipped` — a no-op, never a double-apply. `advance_feature`
 * to a status the feature already holds is expected to be a no-op on the memory side.
 *
 * Every function here is PURE (argv/string builders + a parser). The actual spawn,
 * the try/catch, and the gating live in the caller (merge-ticket.mjs), mirroring
 * how buildReapprovalCommand is pure and signalReapproval owns the spawn.
 */

/** The marker that opens a prepared digest-delta evidence summary. Versioned so a
 *  future payload shape can coexist with a parser that ignores unknown versions. */
export const DIGEST_DELTA_MARKER = "GAFFER_DIGEST_DELTA_V1";

/**
 * The CLI these jobs target. Digest + feature lifecycle live in the MEMORY product
 * (memory-mcp) — the runner drives it through the `lg` helper / MEMORY_CLI_BIN
 * (factory.config.sh), NOT the dispatch control-plane `wg` CLI. The earlier draft of
 * this module wrongly emitted `wg digest …` / `wg feature …`; those verbs don't exist
 * in dispatch and the data isn't there. The onboard producer already writes the digest
 * via the memory MCP — this aligns the merge producer to the same home. Every job
 * carries `command: MEMORY_CLI` so the call site spawns the memory CLI (DB via the
 * MEMORY_DB env var, no `--db` flag — that's the memory CLI's bin contract). */
export const MEMORY_CLI = "lg";

/** Digest section name → the memory CLI flag that sets it on `digest set`. The memory
 *  CLI takes named section flags (a partial set merges, keeping unpassed sections),
 *  unlike the old `--section <name> --content <c>` pair. An unknown/unsupported section
 *  name maps to null so the apply path can skip it rather than emit a bad flag. */
const DIGEST_SECTION_FLAG = Object.freeze({
  overview: "--overview",
  structure: "--structure",
  conventions: "--conventions",
  stack: "--stack",
});

/** Normalise a delta's section name to a memory-CLI section flag, or null if it isn't a
 *  recognised digest section. Tolerant of case/whitespace so an agent's "Overview" or
 *  " stack " still lands. */
export function digestSectionFlag(section) {
  const key = String(section ?? "")
    .trim()
    .toLowerCase();
  return Object.prototype.hasOwnProperty.call(DIGEST_SECTION_FLAG, key)
    ? DIGEST_SECTION_FLAG[key]
    : null;
}

/** Feature lifecycle states (memory product contract). */
export const FEATURE_STATUS = Object.freeze({
  BACKLOG: "backlog",
  BUILDING: "building",
  SHIPPED: "shipped",
});

/** Build the `source` stamp that tags every digest write to a specific merge.
 *  Deterministic + idempotent: the same ticket number always yields the same tag,
 *  so a re-run merge overwrites rather than appends. */
export function mergeSource(ticketNumber) {
  return `merge:#${String(ticketNumber)}`;
}

/**
 * Serialise a prepared digest delta into the evidence-summary string the delivery
 * agent records (marker + compact JSON). Exported so the `prepare-digest-delta`
 * skill, the dashboard, and the tests all build the SAME shape.
 *
 * `delta` shape (all optional except at least one of sections/feature):
 *   {
 *     repo: "<repo-name>",
 *     sections: [ { section: "<digest section>", content: "<new prose>" }, ... ],
 *     feature: { name, summary?, scopeNode?, provenance? }
 *   }
 */
export function encodeDigestDelta(delta) {
  const safe = delta && typeof delta === "object" ? delta : {};
  return `${DIGEST_DELTA_MARKER} ${JSON.stringify(safe)}`;
}

/**
 * Parse ONE evidence-summary string. Returns the decoded delta object when the
 * summary is a well-formed GAFFER_DIGEST_DELTA_V1 payload, else null. Tolerant:
 * a malformed/garbage payload returns null (the merge then falls back) — it never
 * throws, because a bad prepared note must never break a merge.
 *
 * R-8: a row that STARTS with the delta marker but fails to parse is logged as a
 * WARNING so the operator can see that prepared digest work was lost. Silent null
 * returns only for rows that do NOT start with the marker (i.e. unrelated evidence).
 */
export function parseDigestDeltaSummary(summary) {
  const text = String(summary ?? "").trim();
  if (!text.startsWith(DIGEST_DELTA_MARKER)) return null;
  const json = text.slice(DIGEST_DELTA_MARKER.length).trim();
  if (!json) {
    process.stderr.write(
      `WARNING: digest-delta row starts with ${DIGEST_DELTA_MARKER} marker but has no JSON payload — ` +
        `prepared digest work LOST (falling back to minimal stamp)\n`,
    );
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    process.stderr.write(
      `WARNING: digest-delta row starts with ${DIGEST_DELTA_MARKER} marker but JSON is malformed ` +
        `(${err?.message ?? err}) — prepared digest work LOST (falling back to minimal stamp)\n`,
    );
    return null;
  }
  if (!obj || typeof obj !== "object") {
    process.stderr.write(
      `WARNING: digest-delta row starts with ${DIGEST_DELTA_MARKER} marker but parsed to a non-object ` +
        `(got ${typeof obj}) — prepared digest work LOST (falling back to minimal stamp)\n`,
    );
    return null;
  }
  return obj;
}

/**
 * Pick the prepared digest delta out of a ticket's evidence rows. Dispatch's
 * `ticket show` returns `{ evidence: [{ summary, ... }, ...] }` oldest-first; we
 * take the LAST matching GAFFER_DIGEST_DELTA_V1 payload (the freshest prepare wins
 * if the agent recorded more than one). Returns the decoded delta or null.
 *
 * Side-effect-free + defensive against any view shape (missing/!array evidence).
 */
export function selectPreparedDelta(view) {
  const evidence = view && Array.isArray(view.evidence) ? view.evidence : [];
  let found = null;
  for (const row of evidence) {
    const delta = parseDigestDeltaSummary(row?.summary);
    if (delta) found = delta; // keep scanning — last match wins
  }
  return found;
}

/**
 * Build the deterministic Dispatch CLI argv list that APPLIES a prepared delta on
 * merge. Returns an ORDERED array of `{ command:"wg", args:[...], kind }` jobs the
 * caller runs in sequence, best-effort. Pure — spawns nothing.
 *
 *   digest section  → lg digest set <repo> --<section> <content> --source merge:#<n>
 *   feature shipped → see buildFeatureShippedCommands (folded in here when the
 *                     delta carries a feature with no linked feature id)
 *
 * The digest write targets the MEMORY CLI's `digest set` (a partial set MERGES into the
 * existing digest, keeping unpassed sections), one job per section so each lands as its
 * own merge-stamped partial update. An unrecognised section name is skipped.
 *
 * `opts`:
 *   ticketNumber  — stamps the --source and feature provenance.
 *   repo          — fallback repo name when a delta omits its own `repo`.
 *   featureId     — the feature linked to the ticket, if known (advance it);
 *                   when absent and the delta names a feature, add_feature(shipped).
 */
export function buildApplyCommands(delta, { ticketNumber, repo, featureId } = {}) {
  const jobs = [];
  const source = mergeSource(ticketNumber);
  const repoName = String(delta?.repo || repo || "").trim();

  const sections = Array.isArray(delta?.sections) ? delta.sections : [];
  for (const s of sections) {
    const flag = digestSectionFlag(s?.section);
    const content = String(s?.content ?? "");
    if (!flag || !content) continue; // skip empty / unrecognised section deltas
    jobs.push({
      kind: "digest",
      command: MEMORY_CLI,
      args: ["digest", "set", repoName, flag, content, "--source", source],
    });
  }

  // The feature note carried INSIDE the delta (delivery agent didn't know an id).
  const feature = delta?.feature && typeof delta.feature === "object" ? delta.feature : null;
  for (const job of buildFeatureShippedCommands({
    ticketNumber,
    repo: repoName,
    featureId,
    feature,
  })) {
    jobs.push(job);
  }
  return jobs;
}

/**
 * Build the deterministic feature → shipped command(s). Two paths:
 *   • a linked feature id is known → advance_feature(id, "shipped")
 *   • else a feature note is supplied → add_feature(..., status:"shipped")
 *   • else nothing (no feature to ship) → []
 * Pure; the caller runs the argv best-effort. Exported for the minimal-fallback
 * path (merge with no prepared delta but a linked feature) and the tests.
 */
export function buildFeatureShippedCommands({ ticketNumber, repo, featureId, feature } = {}) {
  const id = String(featureId ?? "").trim();
  if (id) {
    return [
      {
        kind: "feature-advance",
        command: MEMORY_CLI,
        args: ["feature", "advance", id, "--to", FEATURE_STATUS.SHIPPED],
      },
    ];
  }
  const f = feature && typeof feature === "object" ? feature : null;
  const name = String(f?.name ?? "").trim();
  if (!name) return [];
  // memory CLI `feature add` takes the repo as a POSITIONAL (not --repo) and has no
  // actor flag (the local CLI runs as the trust principal).
  const args = [
    "feature",
    "add",
    String(f.repo || repo || "").trim(),
    "--name",
    name,
    "--summary",
    String(f.summary ?? ""),
    "--status",
    FEATURE_STATUS.SHIPPED,
    "--provenance",
    String(f.provenance || mergeSource(ticketNumber)),
  ];
  if (String(f.scopeNode ?? "").trim()) {
    args.push("--scope-node", String(f.scopeNode).trim());
  }
  return [{ kind: "feature-add", command: MEMORY_CLI, args }];
}

/**
 * Build the MINIMAL deterministic digest stamp used when a merge has NO prepared
 * delta. It does NOT invent prose (no agent) — it stamps the digest's freshness
 * marker with the merge source so `get_repo_digest` shows the repo moved on this
 * merge, and (separately, via the feature path) advances the linked feature.
 * Returns a single `{ command:"wg", args, kind }` job. Pure.
 */
export function buildMinimalDigestStamp({ ticketNumber, repo }) {
  return {
    kind: "digest-stamp",
    command: MEMORY_CLI,
    args: ["digest", "touch", String(repo ?? "").trim(), "--source", mergeSource(ticketNumber)],
  };
}

/**
 * Build the brownfield epic → feature(building) command. Called when a brownfield
 * (existing-repo) epic is created/confirmed for a feature. Two shapes mirror the
 * memory contract:
 *   • an existing backlog feature → advance_feature(id, "building")
 *   • no existing feature        → add_feature(repo, scope_node?, name, summary,
 *                                   status:"building", provenance:<epic ref>)
 * `provenance` is the epic ref. Pure; the caller runs it best-effort. Exported for
 * bin/epic-feature.mjs and the tests.
 */
export function buildEpicBuildingCommands({
  repo,
  name,
  summary,
  provenance,
  scopeNode,
  featureId,
} = {}) {
  const id = String(featureId ?? "").trim();
  if (id) {
    return [
      {
        kind: "feature-advance",
        command: MEMORY_CLI,
        args: ["feature", "advance", id, "--to", FEATURE_STATUS.BUILDING],
      },
    ];
  }
  const featureName = String(name ?? "").trim();
  const repoName = String(repo ?? "").trim();
  if (!featureName || !repoName) return [];
  // memory CLI `feature add` takes the repo as a POSITIONAL and has no actor flag.
  const args = [
    "feature",
    "add",
    repoName,
    "--name",
    featureName,
    "--summary",
    String(summary ?? ""),
    "--status",
    FEATURE_STATUS.BUILDING,
    "--provenance",
    String(provenance ?? ""),
  ];
  if (String(scopeNode ?? "").trim()) {
    args.push("--scope-node", String(scopeNode).trim());
  }
  return [{ kind: "feature-add", command: MEMORY_CLI, args }];
}
