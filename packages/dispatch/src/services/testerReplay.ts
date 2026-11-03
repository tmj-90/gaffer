import type { Db } from "../db/connection.js";

/**
 * TESTER REPLAY ON THE LANDED REVISION (external review #4).
 *
 * The independent tester's PASS is evidence about the commit it tested. Its assertions
 * live on `gaffer-tests/ticket-<n>`, so after the default branch moved the merge of the
 * tested commit could pass the repository's own suite (the merge gate) yet fail the
 * tester's saved assertion, and the epic still read "accepted". Both runner landing paths
 * now replay the tester's test files on the exact merge candidate after the repo's gates
 * pass, and hold a red replay like a red merge gate.
 *
 * WHAT IS RECORDED (external review 10). The runner's tester lane records, on the PASS
 * itself (`tests`, system only), the TEST IDENTITIES its clean replay saw pass in the
 * tester's files: { file, name, line?, column? } (node:test full name and call site,
 * vitest / jest ancestor titles + title, pytest node id, go Test name, cargo test path).
 * The landing replay runs the registered test command with the tester's files and requires
 * EVERY bound identity to execute and pass on the candidate. When the candidate lands, the
 * runner records one SYSTEM `commit` evidence row per landing, uri
 * `gaffer-tester-replayed:<landed sha>`, payload `{ kind: "tester_replay", tested, pin,
 * files, tests, evidence, via, repo, not_replayed_repos, note }`:
 *   files    the tester's test FILES the replay proved ran (kept for every existing reader);
 *   tests    the test identities proven to have run and passed there;
 *   evidence "identities" when the bound PASS recorded identities (every one of them is in
 *            `tests`: recordTesterReplay refuses a record that lacks one), "files" for an
 *            older PASS without identities: FILE-LEVEL EVIDENCE ONLY (a file counted as run
 *            when any one of its tests ran), shown as such and never as an identity-level
 *            green.
 * A record with NO files says the landing ran no tester assertion (the PASS saved none, or
 * an older PASS's tests branch did not describe it): it never counts an epic as accepted,
 * and neither does one whose PASS bound identities but that proves none.
 *
 * That record is the one answer the merge gate, `gaffer status`, the dashboard ticket page
 * and `wg stats` (an epic is accepted only on it) give to "did the tester's assertions pass
 * on what landed?". Only SYSTEM rows count: agents record evidence as `agent` through the
 * MCP, and the CLI that writes it (`wg ticket record-tester-replay`) is refused to agents
 * by the safety hook and to every actor but `system` by the service; so are the PASS's
 * identities (`wg ticket tester-pass --tests-json`).
 */
export const TESTER_REPLAY_PREFIX = "gaffer-tester-replayed:";

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** One test the tester's PASS bound: the file and the runner's full test name. */
export interface TesterTestIdentity {
  file: string;
  name: string;
  /** node:test's call site (the tester's file is copied byte for byte, so it is stable). */
  line?: number;
  column?: number;
}

/** At most this many identities ride on one PASS or one replay record. */
export const MAX_TESTER_IDENTITIES = 5000;

/**
 * A list of test identities, or null when `raw` is not one (not an array, more than
 * MAX_TESTER_IDENTITIES, an entry without a file and a name, an oversized or NUL-bearing
 * value). Duplicates are dropped.
 */
export function parseTesterIdentities(raw: unknown): TesterTestIdentity[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_TESTER_IDENTITIES) return null;
  const out: TesterTestIdentity[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") return null;
    const o = t as Record<string, unknown>;
    const file = typeof o.file === "string" ? o.file.trim() : "";
    const name = typeof o.name === "string" ? o.name : "";
    if (!file || !name || file.length > 1000 || name.length > 2000) return null;
    if (file.includes("\0") || name.includes("\0") || /[\r\n]/.test(file)) return null;
    const id: TesterTestIdentity = { file, name };
    for (const k of ["line", "column"] as const) {
      const v = o[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return null;
      id[k] = v;
    }
    if (!out.some((x) => sameTesterIdentity(x, id))) out.push(id);
  }
  return out;
}

/** Do two identities name the same test? (line / column compared only when both carry it.) */
export function sameTesterIdentity(a: TesterTestIdentity, b: TesterTestIdentity): boolean {
  if (a.file !== b.file || a.name !== b.name) return false;
  if (a.line !== undefined && b.line !== undefined && a.line !== b.line) return false;
  if (a.column !== undefined && b.column !== undefined && a.column !== b.column) return false;
  return true;
}

/**
 * WHO TESTED, on a PASS the runner records as the system (it carries test identities, so
 * the system actor records it): the tester agent whose run the verdict came from, and that
 * run's id when the runner knew it. System only, like the identities: no agent-reachable
 * path sets it.
 */
export interface TesterAgentRef {
  id: string;
  run?: string;
}

const TESTER_AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/;
const TESTER_RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** A tester-agent reference, or null when `raw` is not one. */
export function parseTesterAgent(raw: unknown): TesterAgentRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !TESTER_AGENT_ID_RE.test(o.id)) return null;
  if (o.run === undefined || o.run === null) return { id: o.id };
  if (typeof o.run !== "string" || !TESTER_RUN_ID_RE.test(o.run)) return null;
  return { id: o.id, run: o.run };
}

export interface BoundTesterPass {
  evidenceId: string;
  testedCommit: string | null;
  provenance: string | null;
  /** The test identities the PASS bound (system-recorded), or null for an older PASS. */
  tests: TesterTestIdentity[] | null;
  at: string;
}

export interface TesterReplayRecord {
  /** The landed revision the tester's assertions passed on (the gated merge commit). */
  commit: string;
  /** The tested commit whose assertions were replayed (the landing's pin). */
  tested: string;
  files: string[];
  /** The test identities proven to have run and passed on the landed revision. */
  tests: TesterTestIdentity[];
  /** "identities" (the PASS bound identities) or "files" (file-level evidence only). */
  evidence: "identities" | "files";
  via: string | null;
  repoId: string | null;
  /** The ticket's other write repos, which the tester's assertions did not cover. */
  notReplayedRepos: string[];
  /** Why no (or which) tester files were replayed, as the landing path saw it. */
  note: string | null;
  at: string;
}

function parse(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The tester's own latest PASS: the newest `test_output` row a `ticket.tester_passed`
 * event names (dispatch's testerPass writes both in one transaction; a verdict-shaped row
 * anyone else recorded is not a tester PASS). Null when there is none.
 */
export function readBoundTesterPass(db: Db, ticketId: string): BoundTesterPass | null {
  try {
    const row = db
      .prepare(
        `SELECT e.id AS id, e.payload_json AS payload_json, e.created_at AS created_at
           FROM evidence e
          WHERE e.ticket_id = ? AND e.evidence_type = 'test_output'
            AND e.payload_json LIKE '%"verdict":"pass"%'
            AND EXISTS (SELECT 1 FROM work_events w WHERE w.entity_type = 'ticket'
                         AND w.entity_id = e.ticket_id AND w.event_type = 'ticket.tester_passed'
                         AND json_extract(w.payload_json, '$.evidence_id') = e.id)
          ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1`,
      )
      .get(ticketId) as { id: string; payload_json: string | null; created_at: string } | undefined;
    if (!row) return null;
    const p = parse(row.payload_json);
    const tested = typeof p.tested_commit === "string" ? p.tested_commit.toLowerCase() : "";
    return {
      evidenceId: row.id,
      testedCommit: SHA_RE.test(tested) ? tested : null,
      provenance: typeof p.provenance === "string" ? p.provenance : null,
      // A present but malformed binding reads as an empty one (it proves nothing).
      tests:
        p.tests === undefined || p.tests === null ? null : (parseTesterIdentities(p.tests) ?? []),
      at: row.created_at,
    };
  } catch {
    return null;
  }
}

/**
 * The newest SYSTEM replay record for `tested` (the tested commit whose assertions were
 * replayed), or null. Fail-soft: a schema without the columns has no record.
 */
export function readTesterReplay(
  db: Db,
  ticketId: string,
  tested: string | null,
): TesterReplayRecord | null {
  if (!tested) return null;
  try {
    const rows = db
      .prepare(
        `SELECT uri, payload_json, repo_id, created_at FROM evidence
          WHERE ticket_id = ? AND evidence_type = 'commit' AND recorded_by_actor_type = 'system'
            AND uri LIKE '${TESTER_REPLAY_PREFIX}%'
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(ticketId) as Array<{
      uri: string;
      payload_json: string | null;
      repo_id: string | null;
      created_at: string;
    }>;
    const want = tested.toLowerCase();
    for (const r of rows) {
      const commit = r.uri.slice(TESTER_REPLAY_PREFIX.length).toLowerCase();
      if (!SHA_RE.test(commit)) continue;
      const p = parse(r.payload_json);
      if (p.kind !== "tester_replay" || String(p.tested ?? "").toLowerCase() !== want) continue;
      return {
        commit,
        tested: want,
        files: Array.isArray(p.files) ? p.files.filter((f) => typeof f === "string") : [],
        tests: parseTesterIdentities(p.tests ?? []) ?? [],
        evidence: p.evidence === "identities" ? "identities" : "files",
        via: typeof p.via === "string" ? p.via : null,
        repoId: r.repo_id ?? null,
        notReplayedRepos: Array.isArray(p.not_replayed_repos)
          ? p.not_replayed_repos.filter((f) => typeof f === "string")
          : [],
        note: typeof p.note === "string" && p.note ? p.note : null,
        at: r.created_at,
      };
    }
    return null;
  } catch {
    return null;
  }
}
