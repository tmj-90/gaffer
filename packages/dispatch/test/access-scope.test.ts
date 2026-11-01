import { describe, expect, it } from "vitest";

import {
  type Access,
  type AccessAction,
  type AccessScope,
  OPERATOR_ACCESS,
  authorizeAccess,
  evaluateRepoScope,
  evaluateTicketScope,
} from "../src/services/accessScope.js";

/**
 * ACCESS SCOPES — the one evaluation REST, the CLI and the factory MCP mount share.
 * Every combination of read-only, admin, repo scope and ticket scope against every
 * kind of action (README Security: per-repo and per-ticket principals).
 */

const inA = { id: "t-in-a", number: 1, repos: ["repo-a"] };
const inB = { id: "t-in-b", number: 2, repos: ["repo-b"] };
const both = { id: "t-both", number: 3, repos: ["repo-a", "repo-b"] };
const bare = { id: "t-bare", number: 4, repos: [] as string[] };

const scopes: Record<string, AccessScope | null> = {
  none: null,
  empty: {},
  repoA: { repos: ["repo-a"] },
  ticketB: { tickets: ["t-in-b"] },
  repoAticketB: { repos: ["repo-a"], tickets: ["t-in-b"] },
  ticketBare: { tickets: ["t-bare"] },
};

describe("evaluateTicketScope", () => {
  it("an unscoped holder reaches every ticket", () => {
    for (const t of [inA, inB, both, bare]) {
      expect(evaluateTicketScope(null, t)).toEqual({ allowed: true, via: "unscoped" });
      expect(evaluateTicketScope({}, t)).toEqual({ allowed: true, via: "unscoped" });
    }
  });
  it("a repo scope covers a ticket only when ALL its repos are inside", () => {
    expect(evaluateTicketScope(scopes.repoA, inA)).toEqual({ allowed: true, via: "repo" });
    expect(evaluateTicketScope(scopes.repoA, inB)).toMatchObject({
      allowed: false,
      reason: "outside_repo_scope",
      outsideRepos: ["repo-b"],
    });
    expect(evaluateTicketScope(scopes.repoA, both)).toMatchObject({
      allowed: false,
      reason: "outside_repo_scope",
      outsideRepos: ["repo-b"],
    });
    expect(evaluateTicketScope(scopes.repoA, bare)).toMatchObject({
      allowed: false,
      reason: "no_repos",
    });
  });
  it("a ticket scope covers exactly its tickets, whatever their repos", () => {
    expect(evaluateTicketScope(scopes.ticketB, inB)).toEqual({ allowed: true, via: "ticket" });
    expect(evaluateTicketScope(scopes.ticketB, inA)).toMatchObject({
      allowed: false,
      reason: "outside_ticket_scope",
    });
    expect(evaluateTicketScope(scopes.ticketBare, bare)).toEqual({
      allowed: true,
      via: "ticket",
    });
  });
  it("both axes are a union", () => {
    expect(evaluateTicketScope(scopes.repoAticketB, inA).allowed).toBe(true);
    expect(evaluateTicketScope(scopes.repoAticketB, inB).allowed).toBe(true);
    expect(evaluateTicketScope(scopes.repoAticketB, both).allowed).toBe(false);
    expect(evaluateTicketScope(scopes.repoAticketB, bare).allowed).toBe(false);
  });
  it("evaluateRepoScope refuses an empty repo list for a scoped holder", () => {
    expect(evaluateRepoScope(scopes.repoA, []).allowed).toBe(false);
    expect(evaluateRepoScope(null, []).allowed).toBe(true);
    expect(evaluateRepoScope(scopes.ticketB, ["repo-a"])).toMatchObject({
      allowed: false,
      outsideRepos: ["repo-a"],
    });
  });
});

describe("authorizeAccess: every combination", () => {
  const actions: Record<string, AccessAction> = {
    readInA: { kind: "read_ticket", ticket: inA },
    readInB: { kind: "read_ticket", ticket: inB },
    writeInA: { kind: "write_ticket", ticket: inA },
    writeInB: { kind: "write_ticket", ticket: inB },
    writeBoth: { kind: "write_ticket", ticket: both },
    createA: { kind: "create_ticket", repos: ["repo-a"] },
    createB: { kind: "create_ticket", repos: ["repo-b"] },
    createNone: { kind: "create_ticket", repos: [] },
    repoWriteA: { kind: "write_repo", repos: ["repo-a"] },
    repoWriteB: { kind: "write_repo", repos: ["repo-b"] },
    settings: { kind: "write_repo" },
    factoryWrite: { kind: "write_factory" },
    factoryRead: { kind: "read_factory" },
  };

  /**
   * The expected outcome, written out as a rule rather than a table so a reader can
   * check it against the README: "ok", "RO" (READ_ONLY_TOKEN) or "SCOPE" (SCOPE_DENIED).
   */
  function expected(access: Access, name: string): "ok" | "RO" | "SCOPE" {
    const a = actions[name] as AccessAction;
    const write = a.kind !== "read_ticket" && a.kind !== "read_factory";
    if (access.readOnly && write) return "RO";
    const s = access.scope;
    const scoped = Boolean(s && (s.repos !== undefined || s.tickets !== undefined));
    const covers = (repos: readonly string[]) =>
      !scoped || (repos.length > 0 && repos.every((r) => (s?.repos ?? []).includes(r)));
    switch (a.kind) {
      case "read_ticket":
      case "write_ticket":
        return !scoped || s?.tickets?.includes(a.ticket.id) || covers(a.ticket.repos)
          ? "ok"
          : "SCOPE";
      case "create_ticket":
        return covers(a.repos) ? "ok" : "SCOPE";
      case "write_repo":
        if (!access.admin) return "SCOPE";
        if (!scoped) return "ok";
        return a.repos !== undefined && covers(a.repos) ? "ok" : "SCOPE";
      case "write_factory":
      case "read_factory":
        return scoped ? "SCOPE" : "ok";
    }
  }

  for (const readOnly of [false, true]) {
    for (const admin of [false, true]) {
      for (const [scopeName, scope] of Object.entries(scopes)) {
        const access: Access = { readOnly, admin, scope };
        const label = `${readOnly ? "read-only" : "full"} ${admin ? "admin" : "human"} scope=${scopeName}`;
        it(label, () => {
          for (const name of Object.keys(actions)) {
            const d = authorizeAccess(access, actions[name] as AccessAction);
            const want = expected(access, name);
            const got = d.allowed ? "ok" : d.code === "READ_ONLY_TOKEN" ? "RO" : "SCOPE";
            expect(`${name}: ${got}`).toBe(`${name}: ${want}`);
          }
        });
      }
    }
  }

  it("spot checks the rule names it gives", () => {
    const repoA: Access = { readOnly: false, admin: false, scope: scopes.repoA ?? null };
    expect(authorizeAccess(repoA, actions.writeBoth as AccessAction)).toMatchObject({
      code: "SCOPE_DENIED",
      reason: "outside_repo_scope",
      outsideRepos: ["repo-b"],
    });
    expect(authorizeAccess(repoA, actions.settings as AccessAction)).toMatchObject({
      reason: "admin_required",
    });
    const adminA: Access = { readOnly: false, admin: true, scope: scopes.repoA ?? null };
    expect(authorizeAccess(adminA, actions.settings as AccessAction)).toMatchObject({
      reason: "factory_wide",
    });
    expect(authorizeAccess(adminA, actions.repoWriteA as AccessAction).allowed).toBe(true);
    expect(authorizeAccess(OPERATOR_ACCESS, actions.settings as AccessAction).allowed).toBe(true);
    const ro: Access = { readOnly: true, admin: false, scope: scopes.repoA ?? null };
    expect(authorizeAccess(ro, actions.writeInA as AccessAction)).toMatchObject({
      code: "READ_ONLY_TOKEN",
    });
    expect(authorizeAccess(ro, actions.readInA as AccessAction).allowed).toBe(true);
    expect(authorizeAccess(ro, actions.readInB as AccessAction).allowed).toBe(false);
  });
});
