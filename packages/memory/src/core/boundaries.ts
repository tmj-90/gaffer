/**
 * Boundaries — the cross-repo interaction map.
 *
 * A boundary edge says "repo R `provides` or `consumes` contract C". A
 * contract is any named integration point: an event, an HTTP endpoint, a
 * queue, a DB table, an RPC method. Aggregated across every repo's
 * committed `.memory/` (via `sync`), the edges form a directed graph:
 *
 *   provides(orders-svc, order-submitted)
 *   consumes(reporting-svc, order-submitted)
 *   consumes(billing-svc,  order-submitted)
 *
 * so the headline query — "I'm about to change `order-submitted`, who
 * does that affect?" — is a single lookup: the providers (where it's
 * defined) and the consumers (who breaks if the shape changes).
 *
 * Trust model mirrors lore exactly: agents DECLARE edges as `draft`
 * (invisible to the default map) and a human RATIFIES them to `active`
 * via the CLI. The MCP surface can read the map and suggest edges; it
 * cannot approve them. This keeps the map from silently filling with
 * agent guesses — the same guard that makes lore trustworthy.
 */
import type { Database } from "better-sqlite3";

import type { Boundary, BoundaryRole, BoundaryRow, BoundaryStatus } from "../db/types.js";
import { newLoreId } from "./ids.js";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Normalise a contract name so the cross-repo join actually connects:
 * the map is worthless if it's `OrderSubmitted` in one repo and
 * `order-submitted` in another. Lowercase, trim, collapse internal
 * whitespace and underscores to single hyphens, strip surrounding
 * punctuation. Mirrors the spirit of `normaliseTag` but tolerates the
 * `/`, `.`, and `:` that real contract names carry (e.g.
 * `POST /v1/orders`, `orders.submitted`, `kafka:order-events`).
 */
export function normaliseContract(c: string): string {
  return (
    c
      .trim()
      // Split camelCase / PascalCase BEFORE lowercasing so "OrderSubmitted"
      // and "order-submitted" converge — without this the cross-repo join
      // silently fails when one team writes the event name in camelCase and
      // another in kebab. Insert a hyphen at lower→Upper and Upper-run→Upper
      // boundaries (e.g. "HTTPServer" → "HTTP-Server").
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-\s]+|[-\s]+$/g, "")
  );
}

function normaliseRepo(r: string): string {
  return r.trim();
}

const ALLOWED_ROLES: ReadonlySet<BoundaryRole> = new Set(["provides", "consumes"]);

function rowToBoundary(row: BoundaryRow): Boundary {
  return {
    id: row.id,
    repo: row.repo,
    contract: row.contract,
    role: row.role,
    kind: row.kind ?? undefined,
    status: row.status,
    detail: row.detail ?? undefined,
    source: row.source ?? undefined,
    author: row.author ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DeclareBoundaryInput {
  readonly repo: string;
  readonly contract: string;
  readonly role: BoundaryRole;
  readonly kind?: string;
  readonly detail?: string;
  readonly source?: string;
  readonly author?: string;
}

/**
 * Insert or update one boundary edge. The `(repo, contract, role)`
 * triple is unique, so re-declaring the same edge UPDATES it in place
 * (refreshing detail/kind/source) rather than creating a duplicate —
 * the map stays one canonical edge per direction per repo.
 *
 * `status` is chosen by the caller's entry point, mirroring lore:
 *   - `addBoundary`     → 'active'  (human, CLI)
 *   - `suggestBoundary` → 'draft'   (agent, MCP)
 *
 * Trust gate (this is the boundary equivalent of "agents can't promote
 * their own lore"): the agent/draft path may only touch an edge that is
 * STILL A DRAFT. Re-declaring an already-ratified (`active`) or retired
 * (`deprecated`) edge from the agent path is a NO-OP — it returns the
 * existing edge unchanged rather than silently rewriting its
 * detail/source/kind, which would let a prompt-injected agent poison a
 * human-approved edge that other agents then read via `find_dependents`.
 * The human path (`status === 'active'`, via `addBoundary`/the CLI) may
 * update any edge and promotes a draft to active.
 */
function upsertBoundary(
  db: Database,
  input: DeclareBoundaryInput,
  status: BoundaryStatus,
): Boundary {
  const repo = normaliseRepo(input.repo);
  if (!repo) throw new Error("declareBoundary: repo must be non-empty");
  const contract = normaliseContract(input.contract);
  if (!contract) {
    throw new Error("declareBoundary: contract must be non-empty");
  }
  if (!ALLOWED_ROLES.has(input.role)) {
    throw new Error(
      `declareBoundary: role must be 'provides' or 'consumes' (got ${JSON.stringify(input.role)})`,
    );
  }
  const ts = nowIso();
  const existing = db
    .prepare("SELECT * FROM boundaries WHERE repo = ? AND contract = ? AND role = ?")
    .get(repo, contract, input.role) as BoundaryRow | undefined;

  if (existing) {
    // Trust gate: the agent/draft path can only refresh a still-draft
    // edge. If the existing edge has already been ratified or retired by
    // a human, an agent re-declaration must NOT mutate it — return it
    // untouched. Without this an agent could overwrite the source/detail
    // of a human-approved edge while it stays active, bypassing review.
    if (status === "draft" && existing.status !== "draft") {
      return getBoundary(db, existing.id)!;
    }
    // A human re-asserting an edge can promote a draft to active; an
    // agent re-declaration of a draft keeps it a draft.
    const nextStatus =
      status === "active" && existing.status === "draft" ? "active" : existing.status;
    db.prepare(
      `UPDATE boundaries SET
         kind = ?, detail = ?, source = ?, author = ?,
         status = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.kind ?? existing.kind,
      input.detail ?? existing.detail,
      input.source ?? existing.source,
      input.author ?? existing.author,
      nextStatus,
      ts,
      existing.id,
    );
    db.prepare(
      "INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, 'boundary_updated', ?, ?)",
    ).run(existing.id, ts, JSON.stringify({ repo, contract, role: input.role }));
    return getBoundary(db, existing.id)!;
  }

  const id = newLoreId();
  db.prepare(
    `INSERT INTO boundaries
       (id, repo, contract, role, kind, status, detail, source, author, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    repo,
    contract,
    input.role,
    input.kind ?? null,
    status,
    input.detail ?? null,
    input.source ?? null,
    input.author ?? null,
    ts,
    ts,
  );
  db.prepare("INSERT INTO events (lore_id, kind, ts, payload) VALUES (?, ?, ?, ?)").run(
    id,
    status === "draft" ? "boundary_suggested" : "boundary_declared",
    ts,
    JSON.stringify({ repo, contract, role: input.role }),
  );
  return getBoundary(db, id)!;
}

/** Human-declared edge. Lands `active` — visible in the default map. */
export function addBoundary(db: Database, input: DeclareBoundaryInput): Boundary {
  return upsertBoundary(db, input, "active");
}

/** Agent-declared edge. Lands `draft` — hidden until a human approves. */
export function suggestBoundary(db: Database, input: DeclareBoundaryInput): Boundary {
  return upsertBoundary(db, input, "draft");
}

export function getBoundary(db: Database, id: string): Boundary | null {
  const row = db.prepare("SELECT * FROM boundaries WHERE id = ?").get(id) as
    | BoundaryRow
    | undefined;
  return row ? rowToBoundary(row) : null;
}

/** Promote a draft edge → active. Null on unknown id / non-draft. */
export function approveBoundary(db: Database, id: string): Boundary | null {
  const ts = nowIso();
  const r = db
    .prepare(
      "UPDATE boundaries SET status = 'active', updated_at = ? WHERE id = ? AND status = 'draft'",
    )
    .run(ts, id);
  if (r.changes === 0) return null;
  db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, 'boundary_approved', ?)").run(
    id,
    ts,
  );
  return getBoundary(db, id);
}

/** Drop a draft edge entirely. Refuses non-drafts (use deprecate). */
export function rejectBoundary(db: Database, id: string): boolean {
  const ts = nowIso();
  const row = db.prepare("SELECT status FROM boundaries WHERE id = ?").get(id) as
    | { status: BoundaryStatus }
    | undefined;
  if (!row || row.status !== "draft") return false;
  db.prepare("DELETE FROM boundaries WHERE id = ?").run(id);
  db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, 'boundary_rejected', ?)").run(
    id,
    ts,
  );
  return true;
}

/** Mark an edge deprecated — kept for history, hidden from the default map. */
export function deprecateBoundary(db: Database, id: string): Boundary | null {
  const ts = nowIso();
  const r = db
    .prepare("UPDATE boundaries SET status = 'deprecated', updated_at = ? WHERE id = ?")
    .run(ts, id);
  if (r.changes === 0) return null;
  db.prepare("INSERT INTO events (lore_id, kind, ts) VALUES (?, 'boundary_deprecated', ?)").run(
    id,
    ts,
  );
  return getBoundary(db, id);
}

export interface ListBoundariesOptions {
  readonly repo?: string;
  readonly contract?: string;
  readonly role?: BoundaryRole;
  readonly includeDrafts?: boolean;
  readonly includeDeprecated?: boolean;
}

/** List edges under the same default-active filter the map uses. */
export function listBoundaries(db: Database, opts: ListBoundariesOptions = {}): Boundary[] {
  const statuses: BoundaryStatus[] = ["active"];
  if (opts.includeDrafts) statuses.push("draft");
  if (opts.includeDeprecated) statuses.push("deprecated");
  const filters = [`status IN (${statuses.map(() => "?").join(",")})`];
  const params: string[] = [...statuses];
  if (opts.repo) {
    filters.push("repo = ?");
    params.push(normaliseRepo(opts.repo));
  }
  if (opts.contract) {
    filters.push("contract = ?");
    params.push(normaliseContract(opts.contract));
  }
  if (opts.role) {
    filters.push("role = ?");
    params.push(opts.role);
  }
  const rows = db
    .prepare(
      `SELECT * FROM boundaries WHERE ${filters.join(" AND ")}
       ORDER BY contract, role, repo`,
    )
    .all(...params) as BoundaryRow[];
  return rows.map(rowToBoundary);
}

/** Drafts awaiting review — the boundary equivalent of `listDrafts`. */
export function listBoundaryDrafts(db: Database): Boundary[] {
  const rows = db
    .prepare("SELECT * FROM boundaries WHERE status = 'draft' ORDER BY created_at DESC")
    .all() as BoundaryRow[];
  return rows.map(rowToBoundary);
}

export interface ImpactResult {
  readonly contract: string;
  /** Repos that own / produce the contract (where a change originates). */
  readonly providers: Boundary[];
  /** Repos that depend on it (who breaks if the shape changes). */
  readonly consumers: Boundary[];
}

/**
 * The headline query: given a contract, return who provides it and who
 * consumes it. This is what an agent calls BEFORE editing a contract —
 * the consumers are the blast radius. Active edges only by default;
 * drafts are opt-in (unreviewed edges aren't authoritative).
 */
export function findDependents(
  db: Database,
  contract: string,
  opts: { includeDrafts?: boolean } = {},
): ImpactResult {
  const key = normaliseContract(contract);
  const edges = listBoundaries(db, {
    contract: key,
    includeDrafts: opts.includeDrafts,
  });
  return {
    contract: key,
    providers: edges.filter((e) => e.role === "provides"),
    consumers: edges.filter((e) => e.role === "consumes"),
  };
}

/** Distinct contract names in the map (active by default). For discovery. */
export function listContracts(
  db: Database,
  opts: { includeDrafts?: boolean; includeDeprecated?: boolean } = {},
): string[] {
  const statuses: BoundaryStatus[] = ["active"];
  if (opts.includeDrafts) statuses.push("draft");
  if (opts.includeDeprecated) statuses.push("deprecated");
  const rows = db
    .prepare(
      `SELECT DISTINCT contract FROM boundaries
       WHERE status IN (${statuses.map(() => "?").join(",")})
       ORDER BY contract`,
    )
    .all(...statuses) as Array<{ contract: string }>;
  return rows.map((r) => r.contract);
}

// ── Sync round-trip (cross-repo aggregation) ──────────────────────────

export interface BoundaryExportRecord {
  readonly id: string;
  readonly repo: string;
  readonly contract: string;
  readonly role: BoundaryRole;
  readonly kind?: string;
  readonly status: BoundaryStatus;
  readonly detail?: string;
  readonly source?: string;
  readonly author?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Export edges for the sync artifact. Active by default (drafts/
 * deprecated opt-in) so a committed `.memory/boundaries.jsonl` only
 * carries ratified edges — the PR is the review gate, same as lore.
 * Stable ordering so two exports diff cleanly.
 */
export function exportBoundaries(
  db: Database,
  opts: { includeDrafts?: boolean; includeDeprecated?: boolean } = {},
): BoundaryExportRecord[] {
  return listBoundaries(db, {
    includeDrafts: opts.includeDrafts,
    includeDeprecated: opts.includeDeprecated,
  }).map((b) => ({
    id: b.id,
    repo: b.repo,
    contract: b.contract,
    role: b.role,
    kind: b.kind,
    status: b.status,
    detail: b.detail,
    source: b.source,
    author: b.author,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  }));
}

export interface ImportBoundaryResult {
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
}

/**
 * Upsert an edge from a sync import, keyed by `(repo, contract, role)` —
 * NOT by id, because two repos exporting their own maps legitimately
 * carry different ids for the same logical edge, and we want them to
 * converge on one local row. The incoming `status` is authoritative (the
 * PR is the trust gate, mirroring lore import). Safe-import: a strictly
 * newer local `updated_at` is preserved unless `force`.
 */
export function importBoundary(
  db: Database,
  rec: BoundaryExportRecord,
  opts: { force?: boolean; dryRun?: boolean } = {},
): "created" | "updated" | "skipped" {
  const repo = normaliseRepo(rec.repo);
  const contract = normaliseContract(rec.contract);
  if (!repo || !contract || !ALLOWED_ROLES.has(rec.role)) return "skipped";
  const existing = db
    .prepare("SELECT id, updated_at FROM boundaries WHERE repo = ? AND contract = ? AND role = ?")
    .get(repo, contract, rec.role) as { id: string; updated_at: string } | undefined;
  if (existing && !opts.force && rec.updatedAt && existing.updated_at > rec.updatedAt) {
    return "skipped";
  }
  if (opts.dryRun) return existing ? "updated" : "created";
  const ts = nowIso();
  if (existing) {
    db.prepare(
      `UPDATE boundaries SET
         kind = ?, status = ?, detail = ?, source = ?, author = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      rec.kind ?? null,
      rec.status,
      rec.detail ?? null,
      rec.source ?? null,
      rec.author ?? null,
      rec.updatedAt ?? ts,
      existing.id,
    );
    return "updated";
  }
  // Reuse the incoming id when it's well-shaped and unused; otherwise
  // mint a fresh one so a malformed/clashing id can't poison the table.
  const id =
    /^[a-z2-9]{8}$/.test(rec.id) && !db.prepare("SELECT 1 FROM boundaries WHERE id = ?").get(rec.id)
      ? rec.id
      : newLoreId();
  db.prepare(
    `INSERT INTO boundaries
       (id, repo, contract, role, kind, status, detail, source, author, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    repo,
    contract,
    rec.role,
    rec.kind ?? null,
    rec.status,
    rec.detail ?? null,
    rec.source ?? null,
    rec.author ?? null,
    rec.createdAt ?? ts,
    rec.updatedAt ?? ts,
  );
  return "created";
}
