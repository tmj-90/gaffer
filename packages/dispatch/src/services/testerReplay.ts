import type { Db } from "../db/connection.js";

/**
 * TESTER REPLAY ON THE LANDED REVISION (external review #4).
 *
 * The independent tester's PASS is evidence about the commit it tested. Its assertions
 * live on `gaffer-tests/ticket-<n>`, so after the default branch moved the merge of the
 * tested commit could pass the repository's own suite (the merge gate) yet fail the
 * tester's saved assertion — and the epic still read "accepted". Both runner landing paths
 * now replay the tester's test files on the exact merge candidate after the repo's gates
 * pass, and hold a red replay like a red merge gate. When the candidate lands, the runner
 * records WHICH tester assertions passed on WHICH landed revision: one SYSTEM `commit`
 * evidence row per landing, uri `gaffer-tester-replayed:<landed sha>`, payload
 * `{ kind: "tester_replay", tested, pin, files, via, repo, not_replayed_repos, note }`.
 * A record with NO files says the landing ran no tester assertion (the PASS saved none, or
 * an older PASS's tests branch did not describe it): it never counts an epic as accepted.
 *
 * That record is the one answer the merge gate, `gaffer status`, the dashboard ticket page
 * and `wg stats` (an epic is accepted only on it) give to "did the tester's assertions pass
 * on what landed?". Only SYSTEM rows count: agents record evidence as `agent` through the
 * MCP, and the CLI that writes it (`wg ticket record-tester-replay`) is refused to agents
 * by the safety hook and to every actor but `system` by the service.
 */
export const TESTER_REPLAY_PREFIX = "gaffer-tester-replayed:";

const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export interface BoundTesterPass {
  evidenceId: string;
  testedCommit: string | null;
  provenance: string | null;
  at: string;
}

export interface TesterReplayRecord {
  /** The landed revision the tester's assertions passed on (the gated merge commit). */
  commit: string;
  /** The tested commit whose assertions were replayed (the landing's pin). */
  tested: string;
  files: string[];
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
