#!/usr/bin/env node
// runner/lib/risk-classify.mjs — the PRE-DELIVERY RISK CLASSIFIER (delta roadmap gap 3,
// gap-verify-first-attempts B4). Pure and deterministic: signals read from the scout
// packet (lib/scout.mjs) and the ticket text. It can only RAISE the declared risk_level,
// never lower it: effective = max(declared, every signal's level). The router
// (bin/route-model.mjs) is handed the effective level; the raised level and its reasons
// are recorded on the ticket (`wg ticket scout-record`, a system event) and shown in the
// Review packet's backing rows.
//
// Signals (kind → the level it asks for):
//   migration     a migration file among the scout's items, or "migration" in the text   high
//   auth          an auth / permission / secret path named or in a stack frame, or the
//                 ticket text talks about auth, permissions, passwords or tokens          high
//   schema        a schema file (proto, graphql, openapi, prisma, sql) among the items   medium
//   public_api    a named module is a package entry, or has importers in another
//                 workspace package                                                        medium
//   concurrency   race / deadlock / mutex / concurrency words in the text                 medium
//   cross_repo    more than one write repo                                                medium
//   prior_failure a previous attempt was sent back or retried after a failed gate         medium
//   fan_out       a named item has >= FAN_OUT_MEDIUM callers (>= FAN_OUT_HIGH: high)      medium|high
//   untested      a named source module no test imports or is named for (index)          medium
//
// CLI: node risk-classify.mjs --show <ticket show json> --packet <scout packet json>
//      → {declared, effective, raised, signals:[{kind, detail, level, raises}]}
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { AUTH_RE, ENTRY_RE, TEST_RE, writeRepos } from "./scout.mjs";

export const LEVELS = ["low", "medium", "high", "critical"];
export const FAN_OUT_MEDIUM = 10;
export const FAN_OUT_HIGH = 25;
const rank = (l) => {
  const i = LEVELS.indexOf(String(l || "").toLowerCase());
  return i === -1 ? 1 : i;
};

const TEXT = {
  migration: /\b(migrat(e|es|ion|ions|ing)|alter table|add column|drop column|ddl)\b/i,
  auth: /\b(auth(entication|enticate|orization|orisation|orize|orise|z|n)?|permissions?|rbac|acl|oauth|jwt|passwords?|csrf|credentials?|secrets?|access control|session tokens?|api keys?)\b/i,
  concurrency:
    /\b(race conditions?|races?|concurren(t|cy)|deadlocks?|mutex(es)?|thread[- ]safe(ty)?|locking|atomic(ally)?|semaphores?|idempoten(t|cy)|double[- ](submit|charge|write)s?)\b/i,
};

/** Classify. Every input optional; a missing packet means text-only signals. */
export function classify({ show, packet }) {
  const t = (show && show.ticket) || {};
  const declared = LEVELS.includes(String(t.risk_level || "").toLowerCase())
    ? String(t.risk_level).toLowerCase()
    : "medium";
  const text = `${t.title ?? ""}\n${t.description ?? ""}`.slice(0, 20000);
  const signals = [];
  const add = (kind, detail, level) => {
    if (signals.some((s) => s.kind === kind)) return;
    signals.push({ kind, detail, level, raises: rank(level) > rank(declared) });
  };
  const items = (packet && Array.isArray(packet.items) ? packet.items : []).filter(Boolean);
  const direct = items.filter(
    (i) =>
      (i.sources || []).includes("named") ||
      (i.sources || []).includes("stack") ||
      (i.reasons || []).some((r) => /^defines /.test(r)),
  );

  const mig = items.find((i) => (i.tags || []).includes("migration"));
  if (mig) add("migration", `migration file ${mig.path}`, "high");
  else if (TEXT.migration.test(text))
    add("migration", "the ticket talks about a migration", "high");

  const authItem = direct.find((i) => AUTH_RE.test(i.path) && !TEST_RE.test(i.path));
  if (authItem) add("auth", `auth or permission path ${authItem.path}`, "high");
  else {
    const m = text.match(TEXT.auth);
    if (m) add("auth", `the ticket talks about ${m[0].toLowerCase()}`, "high");
  }

  const schema = items.find((i) => (i.tags || []).includes("schema"));
  if (schema) add("schema", `schema file ${schema.path}`, "medium");

  const facts = (packet && Array.isArray(packet.seed_facts) ? packet.seed_facts : []).filter(
    (f) => f && f.path && !f.note,
  );
  const entry = direct.find((i) => ENTRY_RE.test(i.path) && !TEST_RE.test(i.path));
  const cross = facts.find((f) => f.cross_package_callers > 0);
  if (cross)
    add(
      "public_api",
      `${cross.symbol || cross.path} is imported from ${cross.cross_package_callers} other ${cross.cross_package_callers === 1 ? "package" : "packages"}`,
      "medium",
    );
  else if (entry) add("public_api", `package entry ${entry.path}`, "medium");

  const cm = text.match(TEXT.concurrency);
  if (cm) add("concurrency", `the ticket talks about ${cm[0].toLowerCase()}`, "medium");

  const writes = writeRepos(show);
  if (writes.length > 1) add("cross_repo", `${writes.length} write repos`, "medium");

  const prior = (packet && packet.prior) || null;
  const attempts = Math.max(0, Math.trunc(Number(t.attempt_count || 0)) || 0);
  const sentBack = prior ? prior.sent_back : 0;
  const gates = prior && Array.isArray(prior.gates) ? prior.gates : [];
  if (attempts > 0 || sentBack > 0 || gates.length > 0)
    add(
      "prior_failure",
      sentBack > 0
        ? `a previous attempt was sent back${sentBack > 1 ? ` (${sentBack} reasons)` : ""}`
        : gates.length > 0
          ? `a previous attempt failed the ${gates.join(", ")} gate${gates.length > 1 ? "s" : ""}`
          : `attempt ${attempts + 1}`,
      "medium",
    );

  const top = [...facts].sort((a, b) => b.callers_total - a.callers_total)[0];
  if (top && top.callers_total >= FAN_OUT_MEDIUM)
    add(
      "fan_out",
      `${top.callers_total} callers of ${top.symbol || top.path} (index, a lower bound)`,
      top.callers_total >= FAN_OUT_HIGH ? "high" : "medium",
    );

  const untested = facts.find(
    (f) =>
      !TEST_RE.test(f.path) &&
      Number(f.tests_total) === 0 &&
      Number(f.module_tests_total) === 0 &&
      packet.index &&
      packet.index.used &&
      !(packet.index.caps_hit || []).length,
  );
  if (untested)
    add("untested", `no test imports or is named for ${untested.path} (index)`, "medium");

  let eff = rank(declared);
  for (const s of signals) eff = Math.max(eff, rank(s.level));
  // A signal never asks for critical: that stays a person's call.
  const effective = LEVELS[Math.min(eff, Math.max(rank(declared), 2))];
  return { declared, effective, raised: rank(effective) > rank(declared), signals };
}

/** "risk raised to high: migration file db/x.sql, 14 callers of f" (or null). */
export function raisedSentence(r) {
  if (!r || !r.raised) return null;
  const why = r.signals.filter((s) => s.raises).map((s) => s.detail);
  return `risk raised to ${r.effective} (declared ${r.declared}): ${why.join(", ")}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const opt = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) opt[a[i].replace(/^--/, "")] = a[i + 1];
  const j = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  try {
    process.stdout.write(
      `${JSON.stringify(classify({ show: j(opt.show) || {}, packet: j(opt.packet) }))}\n`,
    );
  } catch {
    process.exit(0);
  }
}
