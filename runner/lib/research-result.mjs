// =====================================================================
// What comes back from a research run (backlog 69, protection F).
// ---------------------------------------------------------------------
// The research agent's reply is DATA written by a model that read pages an attacker may
// control. It is accepted only when it parses to this exact schema; nothing outside it is
// kept; every string loses its control, bidirectional and zero-width characters and is
// held to a length cap, every list to a count cap, and the whole result is REFUSED (never
// truncated in silence) when a cap is passed, so the person never reads half a claim.
//
//   { phase: "research",
//     summary: "<=1200",
//     findings:     [ { id, claim <=400, why <=400, sources: [url] <=5 } ]   <=30
//     comparables:  [ { name <=120, url?, note <=300 } ]                      <=15
//     features:     [ { id, title <=120, description <=400,
//                       priority: must|should|could|wont, backed_by: [finding id] } ] <=30
//     open_questions: [ "<=300" ] <=15
//     risks:          [ "<=300" ] <=15 }
//   or { phase: "error", error: "<=500" }
//
// Computed here, from the hook's log (lib/hook/research.mjs readResearchLog), never taken
// from the model:
//   - every URL passes url-rules.mjs checkResearchUrl again or is dropped (counted);
//   - a source is `fetched` only when the run's hook allowed a WebFetch of exactly that
//     URL (or reported it as a fetch's final URL); otherwise it is kept, marked "not
//     fetched by the run";
//   - a finding with no fetched source is `opinion` (the agent's own view);
//   - a feature none of whose backing findings has a fetched source is `unsupported`.
// The model's ids are replaced (f1.., ft1.., q1.., k1..); a backed_by id that names no
// finding is dropped. Fields the model sets for any of the marks are ignored.
// =====================================================================
import { checkResearchUrl } from "./hook/url-rules.mjs";

export const RESEARCH_LIMITS = Object.freeze({
  summary: 1200,
  findings: 30,
  claim: 400,
  why: 400,
  sources: 5,
  comparables: 15,
  name: 120,
  note: 300,
  features: 30,
  title: 120,
  description: 400,
  questions: 15,
  risks: 15,
  item: 300,
  error: 500,
});
export const PRIORITIES = Object.freeze(["must", "should", "could", "wont"]);

// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

/** Remove control, bidi and zero-width characters; fold line breaks and tabs to spaces. */
export function cleanText(v) {
  return String(v ?? "")
    .replace(STRIP, "")
    .replace(/[\t\n\r]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

class Refusal extends Error {}
const refuse = (msg) => {
  throw new Refusal(msg);
};

function text(v, cap, where, { required = true } = {}) {
  if (v === undefined || v === null) {
    if (required) refuse(`${where} is missing`);
    return "";
  }
  if (typeof v !== "string") refuse(`${where} is not text`);
  const s = cleanText(v);
  if (required && s === "") refuse(`${where} is empty`);
  if ([...s].length > cap) refuse(`${where} is ${[...s].length} characters (cap ${cap})`);
  return s;
}

function list(v, cap, where) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) refuse(`${where} is not a list`);
  if (v.length > cap) refuse(`${where} has ${v.length} entries (cap ${cap})`);
  return v;
}

function obj(v, where) {
  if (!v || typeof v !== "object" || Array.isArray(v)) refuse(`${where} is not an object`);
  return v;
}

/** The set of URLs the run's hook allowed (and final URLs it recorded). */
function fetchedSet(log) {
  const set = new Set();
  for (const f of log?.fetches ?? []) if (typeof f.url === "string") set.add(f.url);
  for (const f of log?.fetched ?? []) {
    if (typeof f.final_url === "string") set.add(f.final_url);
  }
  return set;
}

/**
 * Validate and normalise one parsed reply against the schema, computing the marks from
 * `log`. Returns `{ ok: true, result }` (result carries `dropped_urls`), or
 * `{ ok: false, error }`. A `phase: "error"` reply comes back as `{ ok: false, error }`
 * with the model's (cleaned, capped) reason.
 */
export function validateResearchResult(reply, log) {
  try {
    const r = obj(reply, "the result");
    if (r.phase === "error") {
      return { ok: false, error: `the research agent reported: ${text(r.error, RESEARCH_LIMITS.error, "error") }` };
    }
    if (r.phase !== "research") refuse(`unknown result phase ${JSON.stringify(String(r.phase)).slice(0, 40)}`);
    const fetched = fetchedSet(log);
    let dropped = 0;
    const source = (u, where) => {
      if (typeof u !== "string") refuse(`${where} is not a URL string`);
      const c = checkResearchUrl(cleanText(u));
      if (!c.ok) {
        dropped += 1;
        return null;
      }
      return { url: c.url, host: c.host, fetched: fetched.has(c.url) };
    };

    const summary = text(r.summary, RESEARCH_LIMITS.summary, "summary", { required: false });
    const idMap = new Map();
    const findings = list(r.findings, RESEARCH_LIMITS.findings, "findings").map((f, i) => {
      const o = obj(f, `finding ${i + 1}`);
      const id = `f${i + 1}`;
      if (typeof o.id === "string" && o.id.trim() && !idMap.has(o.id.trim())) idMap.set(o.id.trim(), id);
      const sources = list(o.sources, RESEARCH_LIMITS.sources, `finding ${i + 1} sources`)
        .map((u, k) => source(u, `finding ${i + 1} source ${k + 1}`))
        .filter(Boolean);
      // One URL listed twice is one source.
      const seen = new Set();
      const unique = sources.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
      return {
        id,
        claim: text(o.claim, RESEARCH_LIMITS.claim, `finding ${i + 1} claim`),
        why: text(o.why, RESEARCH_LIMITS.why, `finding ${i + 1} why`, { required: false }),
        sources: unique,
        opinion: !unique.some((s) => s.fetched),
      };
    });
    const byId = new Map(findings.map((f) => [f.id, f]));
    const comparables = list(r.comparables, RESEARCH_LIMITS.comparables, "comparables").map((c, i) => {
      const o = obj(c, `comparable ${i + 1}`);
      const out = {
        name: text(o.name, RESEARCH_LIMITS.name, `comparable ${i + 1} name`),
        note: text(o.note, RESEARCH_LIMITS.note, `comparable ${i + 1} note`, { required: false }),
      };
      if (o.url !== undefined && o.url !== null && o.url !== "") {
        const s = source(o.url, `comparable ${i + 1} url`);
        if (s) out.source = s;
      }
      return out;
    });
    const features = list(r.features, RESEARCH_LIMITS.features, "features").map((f, i) => {
      const o = obj(f, `feature ${i + 1}`);
      const priority = typeof o.priority === "string" ? o.priority.trim().toLowerCase() : "";
      if (!PRIORITIES.includes(priority)) {
        refuse(`feature ${i + 1} priority must be one of ${PRIORITIES.join(" | ")}`);
      }
      const backed = list(o.backed_by, RESEARCH_LIMITS.findings, `feature ${i + 1} backed_by`)
        .map((b) => (typeof b === "string" ? idMap.get(b.trim()) : undefined))
        .filter((b) => b !== undefined);
      const backedBy = [...new Set(backed)];
      return {
        id: `ft${i + 1}`,
        title: text(o.title, RESEARCH_LIMITS.title, `feature ${i + 1} title`),
        description: text(o.description, RESEARCH_LIMITS.description, `feature ${i + 1} description`, {
          required: false,
        }),
        priority,
        backed_by: backedBy,
        unsupported: !backedBy.some((b) => byId.get(b) && !byId.get(b).opinion),
      };
    });
    const questions = list(r.open_questions, RESEARCH_LIMITS.questions, "open_questions").map((q, i) => ({
      id: `q${i + 1}`,
      text: text(q, RESEARCH_LIMITS.item, `open question ${i + 1}`),
    }));
    const risks = list(r.risks, RESEARCH_LIMITS.risks, "risks").map((q, i) => ({
      id: `k${i + 1}`,
      text: text(q, RESEARCH_LIMITS.item, `risk ${i + 1}`),
    }));
    if (findings.length === 0 && features.length === 0) refuse("the result has no findings and no features");
    return {
      ok: true,
      result: { summary, findings, comparables, features, open_questions: questions, risks, dropped_urls: dropped },
    };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, error: `the research result was refused: ${e.message}` };
    return { ok: false, error: `the research result could not be read: ${e && e.message ? e.message : e}` };
  }
}
