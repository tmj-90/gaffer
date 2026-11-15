/**
 * AUTHORISATION META TEST over the whole API (the test auditor's ask, sec-authz-2).
 *
 * Walks EVERY operation in docs/openapi.json and asserts, for four callers:
 *   - no token:            every operation but the tokenless ones is 401;
 *   - the read token:      every state-changing operation is refused (403);
 *   - a read-only principal (unscoped, capability read): every state-changing operation
 *                          is refused (403);
 *   - a scoped principal (full capability, repo scope "app"), every path parameter
 *                          pointing at an object OUTSIDE its scope: every state-changing
 *                          operation is refused (403), and no read returns that object's
 *                          data.
 * The refusal must be the gate's 403, not just any failure: the body sent is "{}", so a
 * route missing its check would still fail validation and a "no 2xx" rule would pass.
 * After each caller's writes, and after every caller's reads (the shared token's too),
 * the database holds exactly what it held before, row for row (only a principal's
 * last_used_at may move). A new
 * route lands in the spec (scripts/openapi.mjs --check keeps them in step), so it is
 * swept here by construction and cannot be silently open.
 */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveReadToken, setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer, endEventStreams } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const FULL = "shared-full-token-for-the-authz-meta-test-0123456789";
const human: Actor = { type: "human", id: "tom" };
const SPEC = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../docs/openapi.json"), "utf8"),
) as {
  paths: Record<string, Record<string, { security?: unknown[]; requestBody?: unknown }>>;
};
const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const OPS = Object.entries(SPEC.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({
    method: m.toUpperCase(),
    path,
    open: Array.isArray(item[m]!.security) && item[m]!.security!.length === 0,
    hasBody: item[m]!.requestBody !== undefined,
  })),
);

// Strings that exist only on the out-of-scope objects: a read that returns any of them
// leaked data outside the principal's scope.
const SECRET = {
  repo: "secret-repo",
  path: "/srv/secret-path",
  ticket: "SECRET-TICKET-TITLE",
  decision: "SECRET-DECISION-TITLE",
  spec: "SECRET-SPEC-TITLE",
  node: "SECRET-SCOPE-NODE",
  agent: "secret-bot",
};

let base = "";
let wg: Dispatch;
let close: () => Promise<void>;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const saved = process.env.DISPATCH_API_TOKEN;

beforeAll(async () => {
  process.env.DISPATCH_AUDIT_OFF = "1";
  process.env.DISPATCH_API_TOKEN = FULL;
  wg = Dispatch.open(":memory:", new TestClock());
  const app = wg.registerRepository({ name: "app", default_branch: "main" }, human);
  const secret = wg.registerRepository(
    { name: SECRET.repo, default_branch: "main", local_path: SECRET.path },
    human,
  );
  const mk = (title: string, repo: string) => {
    const t = wg.createTicketWithLinks(
      { title, description: "", policy_pack: "solo_loose", risk_level: "low" },
      { repoAccess: [{ repo_id: repo, access: "write" as const }] },
      human,
    );
    return t;
  };
  const mine = mk("mine", app.id);
  const theirs = mk(SECRET.ticket, secret.id);
  const { ac } = wg.addAcceptanceCriterion({ ticket_id: theirs.id, text: "works" }, human);
  wg.markReady(theirs.id, human);
  const bot = wg.registerAgent({ display_name: SECRET.agent }, human);
  wg.claimTicket({ ticket_id: theirs.id, agent_id: bot.id, ttl_seconds: 600 }, { type: "system" });
  const claimId = wg.listActiveClaims().find((c) => c.ticket_id === theirs.id)!.claim_id;
  const decision = wg.createDecision(
    { title: SECRET.decision, question: "q", ticketId: theirs.id },
    human,
  );
  const node = wg.createScopeNode({ name: SECRET.node, type: "product" }, human);
  const link = wg.linkScopeRepo({ scope_node_id: node.id, repo_id: secret.id }, human);
  const spec = wg.createSpec(
    { title: SECRET.spec, clauses: [{ kind: "requirement", text: "x" }] },
    human,
  );
  const scoped = wg.createPrincipal(
    { name: "scoped", capability: "full", actorType: "human", repos: ["app"] },
    human,
  );
  const readOnly = wg.createPrincipal(
    { name: "reader", capability: "read", actorType: "human" },
    human,
  );
  Object.assign(ids, {
    ticket: theirs.id,
    mine: mine.id,
    ac: ac.id,
    claim: claimId,
    decision: decision.id,
    node: node.id,
    link: link.id,
    spec: spec.id,
    repo: secret.id,
    agent: bot.id,
    principal: readOnly.principal.id,
  });
  tokens.read = deriveReadToken(FULL);
  tokens.scoped = scoped.token;
  tokens.readOnly = readOnly.token;
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise<void>((resolve) => {
      endEventStreams("test over");
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
});

afterAll(async () => {
  await close();
  wg.db.close();
  setPrincipalResolver(null);
  if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
  else process.env.DISPATCH_API_TOKEN = saved;
});

/** The concrete URL for a spec path, every parameter an out-of-scope object. */
function concrete(path: string): string {
  const head = path.split("/")[1];
  const byHead: Record<string, string> = {
    tickets: ids.ticket!,
    decisions: ids.decision!,
    claims: ids.claim!,
    specs: ids.spec!,
    repos: ids.repo!,
    "plan-sessions": "00000000-0000-4000-8000-000000000000",
  };
  return path.replace(/\{(\w+)\}/g, (_m, name: string) => {
    if (name === "acId") return ids.ac!;
    if (name === "nodeId") return ids.node!;
    if (name === "dependsOn") return ids.mine!;
    if (name === "cid") return "00000000-0000-4000-8000-000000000001";
    if (name === "key") return "GAFFER_NOTIFY_WEBHOOK_URL";
    if (name === "repo") return SECRET.repo;
    if (path.startsWith("/scope/nodes")) return ids.node!;
    if (path.startsWith("/scope/repos")) return ids.link!;
    if (path.startsWith("/api/principals")) return ids.principal!;
    if (path.startsWith("/api/squad")) return ids.agent!;
    return byHead[head ?? ""] ?? "00000000-0000-4000-8000-000000000002";
  });
}

/**
 * Everything that can change: every row of every table, whole. Row counts alone would
 * miss an UPDATE (a repository's commands, a principal's scope, a delivery's branch).
 */
function snapshot(): string {
  const tables = (
    wg.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
  // A principal's last_used_at is bookkeeping every authenticated request may touch.
  const rows = tables.map((t) => [
    t,
    (
      wg.db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as Array<Record<string, unknown>>
    ).map((r) => (t === "api_principals" ? { ...r, last_used_at: null } : r)),
  ]);
  return JSON.stringify(rows);
}

/** The first difference between two snapshots, for a readable failure. */
function firstChange(before: string, after: string): string {
  if (before === after) return "";
  const a = JSON.parse(before) as Array<[string, unknown[]]>;
  const b = JSON.parse(after) as Array<[string, unknown[]]>;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) {
      return `table ${a[i]?.[0] ?? b[i]?.[0]} changed: ${JSON.stringify(b[i]?.[1]).slice(0, 400)}`;
    }
  }
  return "changed";
}

/**
 * Query strings each GET is also tried with: the ones that switch a route between
 * branches (a gate that trusted one parameter while the route answered another was
 * sec-authz-2 F2), with every value an out-of-scope object.
 */
function queryVariants(path: string): string[] {
  const q = [""];
  if (path === "/scope/repos")
    q.push("?all=1", `?all=1&node=${ids.node}`, `?all=1&repo=${ids.repo}`, `?node=${ids.node}`);
  if (path === "/repositories") q.push("?hidden=1", "?hidden=only");
  if (path === "/tickets" || path === "/api/board") q.push(`?repo=${ids.repo}`);
  if (path === "/tickets/details") q.push(`?ids=${ids.ticket}`);
  if (path === "/api/health") q.push("?view=summary", "?view=summary&window_days=7");
  return q;
}

async function send(
  op: (typeof OPS)[number],
  token: string | null,
  query = "",
): Promise<{ status: number; text: string }> {
  const ac = new AbortController();
  const stream = op.path === "/api/events/stream";
  const timer = setTimeout(() => ac.abort(), stream ? 1500 : 10_000);
  try {
    const res = await fetch(`${base}${concrete(op.path)}${stream ? "?since=0" : query}`, {
      method: op.method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(op.hasBody && op.method !== "GET" ? { "content-type": "application/json" } : {}),
      },
      ...(op.hasBody && op.method !== "GET" ? { body: "{}" } : {}),
      signal: ac.signal,
    });
    let text = "";
    try {
      text = await res.text();
    } catch {
      // A stream cut by the abort: what arrived before it is lost to text(), so read the
      // replay through a reader below instead.
    }
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a stream's replay (?since=0) for a while and return what arrived. */
async function readStream(token: string): Promise<{ status: number; text: string }> {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events/stream?since=0`, {
    headers: { authorization: `Bearer ${token}` },
    signal: ac.signal,
  });
  let text = "";
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    const deadline = Date.now() + 2500;
    const dec = new TextDecoder();
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), 300),
        ),
      ]);
      if (chunk.value) text += dec.decode(chunk.value, { stream: true });
      if (chunk.done && text.includes("work_event")) break;
    }
  }
  ac.abort();
  return { status: res.status, text };
}

const writes = OPS.filter((o) => o.method !== "GET");
const ok = (status: number): boolean => status >= 200 && status < 300;

describe("authorisation meta test over every operation in docs/openapi.json", () => {
  it("sweeps a non-trivial spec", () => {
    expect(OPS.length).toBeGreaterThan(100);
    expect(writes.length).toBeGreaterThan(50);
  });

  it("no token: every operation but the tokenless ones is 401", async () => {
    const before = snapshot();
    const open: string[] = [];
    for (const op of OPS) {
      if (op.open) continue;
      const r = await send(op, null);
      if (r.status !== 401) open.push(`${op.method} ${op.path} -> ${r.status}`);
    }
    expect(open).toEqual([]);
    expect(snapshot()).toBe(before);
  }, 60_000);

  for (const caller of ["read", "readOnly", "scoped"] as const) {
    it(`${caller}: every state-changing operation is refused by the gate, and the database is unchanged`, async () => {
      const before = snapshot();
      // Refused by the AUTHORISATION gate (403), not merely failed: the body is "{}", so
      // a route whose own check is missing would still answer 400/422 (or a 409 from an
      // unrelated guard) and a "no 2xx" assertion would pass with the hole open.
      const notRefused: string[] = [];
      for (const op of writes) {
        const r = await send(op, tokens[caller]!);
        if (r.status !== 403)
          notRefused.push(`${op.method} ${op.path} -> ${r.status} ${r.text.slice(0, 120)}`);
      }
      expect(notRefused).toEqual([]);
      expect(firstChange(before, snapshot())).toBe("");
    }, 60_000);
  }

  for (const caller of ["read", "readOnly", "scoped", "full"] as const) {
    it(`${caller}: no read changes the database`, async () => {
      const before = snapshot();
      const token = caller === "full" ? FULL : tokens[caller]!;
      for (const op of OPS.filter((o) => o.method === "GET")) {
        for (const query of queryVariants(op.path)) {
          if (op.path === "/api/events/stream") await readStream(token);
          else await send(op, token, query);
        }
      }
      expect(firstChange(before, snapshot())).toBe("");
    }, 60_000);
  }

  it("scoped: no read returns data of an object outside its scope", async () => {
    const leaked: string[] = [];
    const markers = [...Object.values(SECRET), ids.ticket!, ids.repo!, ids.decision!];
    for (const op of OPS.filter((o) => o.method === "GET")) {
      for (const query of op.path === "/api/events/stream" ? [""] : queryVariants(op.path)) {
        const r =
          op.path === "/api/events/stream"
            ? await readStream(tokens.scoped!)
            : await send(op, tokens.scoped!, query);
        if (!ok(r.status)) continue;
        // The batched detail read names a ticket it will not show under `missing`: that
        // is the caller's own input echoed back, not the ticket's data.
        let text = r.text;
        if (query.startsWith("?ids=")) {
          const body = JSON.parse(text) as { missing?: unknown };
          delete body.missing;
          text = JSON.stringify(body);
        }
        const hit = markers.filter((m) => text.includes(m));
        if (hit.length > 0)
          leaked.push(`${op.path}${query} -> ${r.status} carries ${hit.join(", ")}`);
      }
    }
    expect(leaked).toEqual([]);
  }, 60_000);

  it("the sweep is meaningful: the shared token does read the out-of-scope objects", async () => {
    const r = await send(
      { method: "GET", path: "/tickets/{id}", open: false, hasBody: false },
      FULL,
    );
    expect(r.status).toBe(200);
    expect(r.text).toContain(SECRET.ticket);
    const repos = await send(
      { method: "GET", path: "/repositories", open: false, hasBody: false },
      FULL,
    );
    expect(repos.text).toContain(SECRET.path);
  });
});
