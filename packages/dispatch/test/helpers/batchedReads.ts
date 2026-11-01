/**
 * The dashboard reads many tickets' detail with ONE GET /tickets/details and every
 * repo's grounds with ONE GET /scope/repos?all=1 (exploratory finding
 * api-robustness/F9). The DOM tests' fetch stubs answer the per-ticket and per-repo
 * routes; this wraps such a stub so the batched routes are composed from them, the way
 * the server composes them from the same reads.
 */
type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const json = (obj: unknown): Response =>
  new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

export function batchedReads(inner: FetchImpl): FetchImpl {
  return async (input, init) => {
    const raw = String(input);
    const url = new URL(raw, "http://dashboard.test");
    if (url.pathname === "/tickets/details") {
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
      const include = (url.searchParams.get("include") ?? "repositories,scopes,dependencies")
        .split(",")
        .filter(Boolean);
      const details: unknown[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const res = await inner(`/tickets/${decodeURIComponent(id)}`, init);
        const body = res.ok ? ((await res.json()) as Record<string, unknown>) : null;
        if (!body || typeof body !== "object") {
          missing.push(id);
          continue;
        }
        const item: Record<string, unknown> = { ticket: body.ticket ?? { id } };
        for (const k of include) if (k in body) item[k] = body[k];
        details.push(item);
      }
      return json({ details, missing, total: details.length });
    }
    if (url.pathname === "/scope/repos" && url.searchParams.get("all") === "1") {
      const reposRes = await inner("/repositories", init);
      const repos = reposRes.ok
        ? (((await reposRes.json()) as { repositories?: Array<{ id: string }> }).repositories ?? [])
        : [];
      const byRepo: Record<string, unknown> = {};
      for (const r of repos) {
        const res = await inner(`/scope/repos?repo=${encodeURIComponent(r.id)}`, init);
        byRepo[r.id] = res.ok ? (((await res.json()) as { scopes?: unknown[] }).scopes ?? []) : [];
      }
      return json({ by_repo: byRepo });
    }
    return inner(input, init);
  };
}
