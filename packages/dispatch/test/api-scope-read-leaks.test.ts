/**
 * Scoped-principal READ leaks (sec-authz-2 F2, F3). A principal scoped to repo "app"
 * must not read rows of a repository outside its scope: not through
 * `GET /scope/repos?all=1&node=` / `&repo=` (the gate admitted any request carrying
 * all=1 while the route answered node / repo first, unfiltered), and not through
 * `GET /repositories` or `/agents`. The shared token and unscoped principals see
 * everything as before.
 */
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { setPrincipalResolver } from "../src/api/auth.js";
import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { TestClock } from "../src/util/clock.js";

const FULL = "shared-full-token-for-read-leak-tests-0123456789";
const human: Actor = { type: "human", id: "tom" };

const saved = process.env.DISPATCH_API_TOKEN;
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  setPrincipalResolver(null);
  if (saved === undefined) delete process.env.DISPATCH_API_TOKEN;
  else process.env.DISPATCH_API_TOKEN = saved;
});

async function start() {
  process.env.DISPATCH_AUDIT_OFF = "1";
  process.env.DISPATCH_API_TOKEN = FULL;
  const wg = Dispatch.open(":memory:", new TestClock());
  const app = wg.registerRepository(
    { name: "app", default_branch: "main", local_path: "/srv/secret/app" },
    human,
  );
  const priv = wg.registerRepository(
    { name: "payments-private", default_branch: "main", local_path: "/srv/secret/payments" },
    human,
  );
  const hidden = wg.registerRepository(
    { name: "hidden-private", default_branch: "main", local_path: "/srv/secret/hidden" },
    human,
  );
  wg.setRepoHidden(hidden.id, true, human);
  const node = wg.createScopeNode({ name: "Payments", type: "product" }, human);
  wg.linkScopeRepo({ scope_node_id: node.id, repo_id: priv.id }, human);
  wg.linkScopeRepo({ scope_node_id: node.id, repo_id: app.id }, human);
  const scoped = wg.createPrincipal(
    { name: "scoped", capability: "read", actorType: "human", repos: ["app"] },
    human,
  ).token;
  const unscoped = wg.createPrincipal(
    { name: "unscoped", capability: "read", actorType: "human" },
    human,
  ).token;
  const server = createApiServer(wg);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        wg.db.close();
        resolve();
      }),
    );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string, token: string) => {
    const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: text ? (JSON.parse(text) as Record<string, any>) : {},
    };
  };
  const post = async (path: string, token: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: text ? (JSON.parse(text) as Record<string, any>) : {},
    };
  };
  return { wg, app, priv, hidden, node, scoped, unscoped, get, post };
}

describe("F2: GET /scope/repos never answers node / repo to a scoped principal", () => {
  it("all=1 with node or repo is refused; all=1 alone stays filtered", async () => {
    const { priv, node, app, scoped, get } = await start();
    for (const q of [
      `?all=1&node=${node.id}`,
      `?all=1&repo=${priv.id}`,
      `?all=1&repo=payments-private`,
      `?node=${node.id}&all=1`,
      `?all=1&node=`,
      `?node=${node.id}`,
      `?repo=${priv.id}`,
    ]) {
      const r = await get(`/scope/repos${q}`, scoped);
      expect(r.status, q).toBe(403);
      expect(r.body.error?.code, q).toBe("SCOPE_DENIED");
      expect(r.text, q).not.toContain("/srv/secret/payments");
    }
    const all = await get("/scope/repos?all=1", scoped);
    expect(all.status).toBe(200);
    expect(Object.keys(all.body.by_repo)).toEqual([app.id]);
  });

  it("the shared token and an unscoped principal read every branch as before", async () => {
    const { priv, node, unscoped, get } = await start();
    for (const token of [FULL, unscoped]) {
      const byNode = await get(`/scope/repos?all=1&node=${node.id}`, token);
      expect(byNode.status).toBe(200);
      expect(byNode.text).toContain("/srv/secret/payments");
      const byRepo = await get(`/scope/repos?repo=${priv.id}`, token);
      expect(byRepo.status).toBe(200);
      expect(byRepo.body.scopes).toHaveLength(1);
    }
  });
});

describe("F2 sweep: a repo ref the gate and the route could resolve differently", () => {
  it("POST /tickets naming a string that is one repo's id and another's name is refused", async () => {
    const { wg, app, post } = await start();
    // A repository NAMED after the in-scope repo's id (the route links by name first).
    wg.registerRepository(
      { name: app.id, default_branch: "main", local_path: "/srv/secret/twin" },
      human,
    );
    const writer = wg.createPrincipal(
      { name: "writer", capability: "full", actorType: "human", repos: ["app"] },
      human,
    ).token;
    const res = await post("/tickets", writer, { title: "twin", repo: app.id });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe("SCOPE_DENIED");
    // The plain in-scope name still works.
    const ok = await post("/tickets", writer, { title: "fine", repo: "app" });
    expect(ok.status).toBe(201);
  });
});
