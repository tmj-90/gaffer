/**
 * CLI IDENTITY. Without a token the CLI is the operator and records writes as $USER
 * (`whoami` says that identity is asserted, not authenticated). With
 * GAFFER_PRINCIPAL_TOKEN (or --as-principal) it acts as that principal: resolved from
 * the same table the API uses, every write recorded under its identity, and its
 * read-only flag, admin flag and repo/ticket scope enforced as on the API.
 *
 * Runs the built CLI (dist), the way `gaffer wg` does.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { listEvents } from "../src/events/eventWriter.js";
import { nonEmptyDiffRunner } from "./helpers/realDiff.js";

// Each case spawns the built CLI several times (about half a second a call, more on a
// loaded machine), so the default 5 s is too tight.
vi.setConfig({ testTimeout: 60_000 });

const human: Actor = { type: "human", id: "tom" };
const agentActor: Actor = { type: "agent", id: "agent-1" };

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

function seed() {
  dir = mkdtempSync(join(tmpdir(), "cli-principal-"));
  const db = join(dir, "d.sqlite");
  const wg = Dispatch.open(db, undefined, nonEmptyDiffRunner, { testingEnabled: false });
  const app = wg.registerRepository({ name: "app", default_branch: "main" }, human);
  const svc = wg.registerRepository({ name: "svc", default_branch: "main" }, human);
  const mk = (title: string, repo: string) => {
    const t = wg.createTicketWithLinks(
      { title, description: "", policy_pack: "solo_loose", risk_level: "low" },
      { repoAccess: [{ repo_id: repo, access: "write" }] },
      human,
    );
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "AC" }, human);
    return t;
  };
  const onApp = mk("on app", app.id);
  const onSvc = mk("on svc", svc.id);
  const scoped = wg.createPrincipal({ name: "app-bot", repos: ["app"] }, human);
  const reader = wg.createPrincipal(
    { name: "app-reader", capability: "read", repos: ["app"] },
    human,
  );
  const admin = wg.createPrincipal({ name: "ops", actorType: "admin" }, human);
  wg.db.close();
  return { db, app, svc, onApp, onSvc, scoped, reader, admin };
}

function cli(db: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(
    process.execPath,
    [join(__dirname, "../dist/cli/index.js"), "--db", db, ...args],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DISPATCH_AUDIT_OFF: "1",
        USER: "cli-user",
        GAFFER_PRINCIPAL_TOKEN: "",
        ...env,
      },
    },
  );
  const parse = (s: string): Record<string, unknown> | null => {
    for (const text of [s.trim(), s.trim().split("\n").pop() ?? ""]) {
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        // try the last line (stderr carries one JSON error line after any notes)
      }
    }
    return null;
  };
  return { status: r.status, out: parse(r.stdout), err: parse(r.stderr), stderr: r.stderr };
}

describe("wg whoami", () => {
  it("without a token says the identity is asserted, not authenticated", () => {
    const w = seed();
    const r = cli(w.db, ["whoami"]);
    expect(r.status).toBe(0);
    expect(r.out).toMatchObject({
      actor: { type: "human", id: "cli-user" },
      authenticated: false,
      principal: null,
    });
    expect(String(r.out?.note)).toMatch(/asserted, not authenticated/i);
  });

  it("with a principal token names the principal and its scope", () => {
    const w = seed();
    const r = cli(w.db, ["whoami"], { GAFFER_PRINCIPAL_TOKEN: w.scoped.token });
    expect(r.status).toBe(0);
    expect(r.out).toMatchObject({
      actor: { type: "human", id: "app-bot" },
      authenticated: true,
      principal: { name: "app-bot" },
      scope: { repos: [{ name: "app" }], tickets: null },
    });
    // --as-principal is the same thing as a flag.
    const f = cli(w.db, ["--as-principal", w.admin.token, "whoami"]);
    expect(f.out).toMatchObject({ actor: { type: "admin", id: "ops" }, authenticated: true });
  });

  it("refuses an unknown or revoked token before doing anything", () => {
    const w = seed();
    const r = cli(w.db, ["ticket", "ready", String(w.onApp.number)], {
      GAFFER_PRINCIPAL_TOKEN: "gfp_not-a-real-token-000000000000000000",
    });
    expect(r.status).toBe(1);
    expect(r.err).toMatchObject({ code: "UNAUTHORIZED" });
    const wg = Dispatch.open(w.db);
    expect(wg.resolveTicket(w.onApp.id).status).toBe("draft");
    wg.db.close();
  });
});

describe("wg acting as a scoped principal", () => {
  it("lists and changes only its tickets, records writes as itself", () => {
    const w = seed();
    const env = { GAFFER_PRINCIPAL_TOKEN: w.scoped.token };

    const list = spawnSync(
      process.execPath,
      [join(__dirname, "../dist/cli/index.js"), "--db", w.db, "ticket", "list"],
      { encoding: "utf8", env: { ...process.env, DISPATCH_AUDIT_OFF: "1", ...env } },
    );
    expect(list.status, list.stderr).toBe(0);
    const ids = (JSON.parse(list.stdout) as Array<{ id: string }>).map((t) => t.id);
    expect(ids).toEqual([w.onApp.id]);

    expect(cli(w.db, ["ticket", "show", String(w.onApp.number)], env).status).toBe(0);
    const show = cli(w.db, ["ticket", "show", String(w.onSvc.number)], env);
    expect(show.status).toBe(1);
    expect(show.err).toMatchObject({
      code: "SCOPE_DENIED",
      details: { reason: "outside_repo_scope", outside_repos: ["svc"] },
    });

    const ok = cli(w.db, ["ticket", "ready", String(w.onApp.number)], env);
    expect(ok.status, ok.stderr).toBe(0);
    const out = cli(w.db, ["ticket", "ready", String(w.onSvc.number)], env);
    expect(out.status).toBe(1);
    expect(out.err).toMatchObject({ code: "SCOPE_DENIED" });

    // Repo-level and factory-wide commands are outside a human scoped principal.
    const hide = cli(w.db, ["repo", "hide", "app"], env);
    expect(hide.err).toMatchObject({ code: "SCOPE_DENIED", details: { reason: "admin_required" } });
    const stats = cli(w.db, ["stats"], env);
    expect(stats.err).toMatchObject({ code: "SCOPE_DENIED", details: { reason: "factory_wide" } });
    // A principal never mints principals, and never records another identity.
    expect(cli(w.db, ["principal", "create", "x"], env).err).toMatchObject({
      code: "ACTOR_NOT_PERMITTED",
    });
    expect(
      cli(w.db, ["ticket", "move", String(w.onApp.number), "ready", "--as", "system"], env).err,
    ).toMatchObject({ code: "ACTOR_NOT_PERMITTED" });

    const wg = Dispatch.open(w.db);
    expect(wg.resolveTicket(w.onApp.id).status).toBe("ready");
    expect(wg.resolveTicket(w.onSvc.id).status).toBe("draft");
    expect(
      (
        wg.db.prepare("SELECT hidden FROM repositories WHERE name = 'app'").get() as {
          hidden: number;
        }
      ).hidden,
    ).toBe(0);
    const ready = listEvents(wg.db, "ticket", w.onApp.id).filter(
      (e) => e.event_type === "ticket.transitioned",
    );
    expect(ready[ready.length - 1]).toMatchObject({ actor_type: "human", actor_id: "app-bot" });
    wg.db.close();
  });

  it("approves in scope as itself and is refused out of scope", () => {
    const w = seed();
    const wg = Dispatch.open(w.db, undefined, undefined, { testingEnabled: false });
    const heads: Record<string, string> = {};
    for (const [t, name] of [
      [w.onApp, "app"],
      [w.onSvc, "svc"],
    ] as const) {
      // A real checkout with a delivery branch one commit past main.
      const repoDir = join(dir, name);
      const git = (...a: string[]) =>
        spawnSync("git", ["-C", repoDir, ...a], { encoding: "utf8" }).stdout.trim();
      spawnSync("git", ["init", "-q", "-b", "main", repoDir]);
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      git("commit", "-q", "--allow-empty", "-m", "init");
      git("checkout", "-q", "-b", "feat/x");
      writeFileSync(join(repoDir, "x.txt"), "a change\n");
      git("add", "x.txt");
      git("commit", "-q", "-m", "change");
      heads[name] = git("rev-parse", "HEAD");
      const repo = wg.repos.findByName(name);
      wg.db.prepare("UPDATE repositories SET local_path = ? WHERE id = ?").run(repoDir, repo?.id);
      wg.recordRepoDelivery(
        { ticket_id: t.id, repo_id: repo?.id ?? "", branch_name: "feat/x" },
        human,
      );
      wg.markReady(t.id, human);
      const agent = wg.registerAgent({ display_name: `a-${t.number}` }, human);
      const claim = wg.claimTicket(
        { ticket_id: t.id, agent_id: agent.id, ttl_seconds: 300 },
        agentActor,
      );
      wg.recordDeliveryArtifact(
        { claim_token: claim.claimToken, ticket_id: t.id, branch_name: "feat/x" },
        agentActor,
      );
      wg.submitForReview({ claimToken: claim.claimToken, ticket_id: t.id }, agentActor);
    }
    wg.db.close();
    const env = { GAFFER_PRINCIPAL_TOKEN: w.scoped.token };
    const out = cli(
      w.db,
      ["review", "approve", String(w.onSvc.number), "--commit", `svc=${heads.svc}`],
      env,
    );
    expect(out.err).toMatchObject({ code: "SCOPE_DENIED" });
    const ok = cli(
      w.db,
      ["review", "approve", String(w.onApp.number), "--commit", `app=${heads.app}`],
      env,
    );
    expect(ok.status, ok.stderr).toBe(0);
    const after = Dispatch.open(w.db);
    expect(after.resolveTicket(w.onApp.id).status).toBe("ready_for_merge");
    expect(after.resolveTicket(w.onSvc.id).status).toBe("in_review");
    const ev = listEvents(after.db, "ticket", w.onApp.id).filter(
      (e) => e.event_type === "ticket.transitioned",
    );
    expect(ev[ev.length - 1]).toMatchObject({ actor_type: "human", actor_id: "app-bot" });
    after.db.close();
  });

  it("read-only + scope: reads its tickets, writes nothing", () => {
    const w = seed();
    const env = { GAFFER_PRINCIPAL_TOKEN: w.reader.token };
    expect(cli(w.db, ["ticket", "show", String(w.onApp.number)], env).status).toBe(0);
    expect(cli(w.db, ["ticket", "show", String(w.onSvc.number)], env).err).toMatchObject({
      code: "SCOPE_DENIED",
    });
    expect(cli(w.db, ["ticket", "ready", String(w.onApp.number)], env).err).toMatchObject({
      code: "READ_ONLY_TOKEN",
    });
  });

  it("an admin principal acts as admin and may change repositories", () => {
    const w = seed();
    const r = cli(w.db, ["repo", "hide", "svc"], { GAFFER_PRINCIPAL_TOKEN: w.admin.token });
    expect(r.status, r.stderr).toBe(0);
    const wg = Dispatch.open(w.db);
    const row = wg.db.prepare("SELECT hidden FROM repositories WHERE name = 'svc'").get() as {
      hidden: number;
    };
    expect(row.hidden).toBe(1);
    const ev = wg.db
      .prepare(
        "SELECT actor_type, actor_id FROM work_events WHERE event_type = 'repository.hidden'",
      )
      .get() as { actor_type: string; actor_id: string } | undefined;
    expect(ev).toEqual({ actor_type: "admin", actor_id: "ops" });
    wg.db.close();
  });
});

/**
 * Adversarial review (exploratory finding rough-scopes-review/cli-*): a principal acts
 * only as itself, and the ticket commands reach no ticket outside its scope.
 */
describe("wg acting as a principal: the runner's and agents' commands", () => {
  it("refuses every command that records the system or an agent, for any principal", () => {
    const w = seed();
    const wg = Dispatch.open(w.db);
    const agent = wg.registerAgent({ display_name: "bot-1" }, human);
    wg.markReady(w.onApp.id, human);
    wg.db.close();
    const n = String(w.onApp.number);
    // Every one of these is runner or agent bookkeeping, recorded as system or agent.
    const machine: string[][] = [
      ["attach-evidence", n, "--type", "diff_summary", "--summary", "forged"],
      ["claim-ticket", n, "--agent", agent.id],
      ["claim", "--agent", agent.id],
      ["runner-release", n, "--to", "ready"],
      ["runner-rework", n, "--attempt", "1", "--max", "3"],
      ["expire-claims"],
      ["ticket", "pause", n, "--reason", "cap_hit"],
      ["ticket", "resume-begin", n],
      ["ac", "check-result", "x", "--ticket", n, "--exit", "0", "--command", "true"],
      ["block", n, "--reason", "x", "--token", "not-a-claim"],
      ["evidence", n, "--token", "t", "--type", "diff_summary", "--summary", "s"],
      ["submit", n, "--token", "t"],
    ];
    for (const token of [w.scoped.token, w.admin.token]) {
      for (const args of machine) {
        const r = cli(w.db, args, { GAFFER_PRINCIPAL_TOKEN: token });
        expect(r.status, `${args.join(" ")}: ${r.stderr}`).toBe(1);
        expect(r.err, args.join(" ")).toMatchObject({ code: "ACTOR_NOT_PERMITTED" });
      }
    }
    const after = Dispatch.open(w.db);
    const forged = after.db
      .prepare("SELECT COUNT(*) AS n FROM work_events WHERE event_type = 'evidence.recorded'")
      .get() as { n: number };
    expect(forged.n).toBe(0);
    expect(after.resolveTicket(w.onApp.id).status).toBe("ready");
    after.db.close();
    // A person blocking (no --token) is still the principal's own act.
    const own = cli(w.db, ["block", n, "--reason", "waiting"], {
      GAFFER_PRINCIPAL_TOKEN: w.scoped.token,
    });
    expect(own.status, own.stderr).toBe(0);
  });

  it("an admin principal's --admin acts are recorded under its own id, not $USER", () => {
    const w = seed();
    const wg = Dispatch.open(w.db);
    wg.markReady(w.onApp.id, human);
    wg.humanClaimTicket(w.onApp.id, { type: "human", id: "someone" });
    wg.db.close();
    const r = cli(w.db, ["human-release", String(w.onApp.number), "--admin"], {
      GAFFER_PRINCIPAL_TOKEN: w.admin.token,
    });
    expect(r.status, r.stderr).toBe(0);
    const after = Dispatch.open(w.db);
    const ev = listEvents(after.db, "ticket", w.onApp.id).pop();
    expect(ev).toMatchObject({ actor_type: "admin", actor_id: "ops" });
    after.db.close();
  });

  it("a ticket's epic and map links are the operator's for a scoped principal", () => {
    const w = seed();
    const wg = Dispatch.open(w.db);
    const epic = wg.createScopeNode({ name: "Launch", type: "epic" }, human);
    wg.db.close();
    const env = { GAFFER_PRINCIPAL_TOKEN: w.scoped.token };
    const r = cli(w.db, ["ticket", "scope", "link", String(w.onApp.number), epic.id], env);
    expect(r.err).toMatchObject({ code: "SCOPE_DENIED", details: { reason: "factory_wide" } });
    // An unscoped admin principal may.
    const ok = cli(w.db, ["ticket", "scope", "link", String(w.onApp.number), epic.id], {
      GAFFER_PRINCIPAL_TOKEN: w.admin.token,
    });
    expect(ok.status, ok.stderr).toBe(0);
  });

  it("ticket show names a dependency outside the scope by number only", () => {
    const w = seed();
    const wg = Dispatch.open(w.db);
    wg.addDependency({ ticket: w.onApp.id, depends_on: w.onSvc.id }, human);
    wg.db.close();
    const env = { GAFFER_PRINCIPAL_TOKEN: w.scoped.token };
    const show = cli(w.db, ["ticket", "show", String(w.onApp.number)], env);
    expect(show.status, show.stderr).toBe(0);
    expect(show.out?.dependencies).toEqual([
      expect.objectContaining({ number: w.onSvc.number, title: null, outside_scope: true }),
    ]);
    const list = cli(w.db, ["ticket", "dep", "list", String(w.onApp.number)], env);
    expect(JSON.stringify(list.out)).not.toContain("on svc");
  });
});

describe("wg ticket create --repo", () => {
  it("creates a ticket delivering to the named repos, and a scoped principal only on its own", () => {
    const w = seed();
    const op = cli(w.db, ["ticket", "create", "-t", "op on svc", "--repo", "svc"]);
    expect(op.status, op.stderr).toBe(0);
    const env = { GAFFER_PRINCIPAL_TOKEN: w.scoped.token };
    const mine = cli(w.db, ["ticket", "create", "-t", "mine", "--repo", "app"], env);
    expect(mine.status, mine.stderr).toBe(0);
    const out = cli(
      w.db,
      ["ticket", "create", "-t", "theirs", "--repo", "app", "--repo", "svc"],
      env,
    );
    expect(out.err).toMatchObject({
      code: "SCOPE_DENIED",
      details: { reason: "outside_repo_scope", outside_repos: ["svc"] },
    });
    const none = cli(w.db, ["ticket", "create", "-t", "nowhere"], env);
    expect(none.err).toMatchObject({ code: "SCOPE_DENIED", details: { reason: "no_repos" } });
    const bad = cli(w.db, ["ticket", "create", "-t", "x", "--repo", "nope"]);
    expect(bad.err).toMatchObject({ code: "NOT_FOUND" });
    const wg = Dispatch.open(w.db);
    const titles = wg.list().map((t) => t.title);
    expect(titles).toContain("op on svc");
    expect(titles).toContain("mine");
    expect(titles).not.toContain("theirs");
    expect(titles).not.toContain("x");
    const t = wg.list().find((x) => x.title === "mine");
    const links = wg.repos.listForTicket(t?.id ?? "");
    expect(links.map((l) => [l.name, l.access, l.relation])).toEqual([
      ["app", "write", "confirmed"],
    ]);
    // The new ticket is in the principal's scope: it can show it.
    expect(cli(w.db, ["ticket", "show", String(t?.number)], env).status).toBe(0);
    wg.db.close();
  });
});
