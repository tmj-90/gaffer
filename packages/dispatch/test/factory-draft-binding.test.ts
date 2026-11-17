/**
 * FACTORY DRAFT BINDING (sec-authz-2 F4). SECURITY.md says the factory MCP mount's
 * writes stay bound to its tickets; before this, create_ticket took any repo,
 * create_epic any per-ticket repo, access and policy pack, freeze_spec froze any spec
 * (irreversible) and add_dependency checked only the dependent side. Now, in factory
 * context: a ticket-bound mount drafts only on the repos its ticket writes and never
 * under a looser pack than its ticket's; the product-owner mount drafts on its repo; a
 * planning mount (no ticket, no repo) keeps drafting as before; an agent never freezes a
 * spec; add_dependency checks both ends.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor, Ticket } from "../src/domain/types.js";
import { makeHandlers, type ToolResult } from "../src/mcp/tools.js";
import { TestClock } from "../src/util/clock.js";

const human: Actor = { type: "human", id: "alice" };
const system: Actor = { type: "system", id: "runner" };
const agent: Actor = { type: "agent", id: "mcp-agent" };

const ENV_KEYS = [
  "GAFFER_FACTORY",
  "GAFFER_CLAIM_TOKEN",
  "GAFFER_SCOPE_TICKET",
  "GAFFER_REVIEW_TICKET",
  "GAFFER_DEFAULT_TICKET_REPO",
] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function code(r: ToolResult): string | undefined {
  return (r.structuredContent.error as { code?: string } | undefined)?.code;
}

function ticketOn(wg: Dispatch, repo: string): Ticket {
  const t = wg.createTicket(
    { title: `on ${repo}`, description: "", policy_pack: "solo_loose" },
    human,
  );
  wg.addAcceptanceCriterion({ ticket_id: t.id, text: "works" }, human);
  wg.setTicketRepoAccess(
    { ticket_id: t.id, repo_id: repo, access: "write", relation: "confirmed" },
    human,
  );
  wg.markReady(t.id, human);
  return wg.resolveTicket(t.id);
}

/** Own ticket on repo "mine" (claimed), a victim on "theirs". */
function seed(pack = "solo_loose") {
  const wg = Dispatch.open(":memory:", new TestClock());
  wg.registerRepository({ name: "mine", path: "/tmp/mine" }, human);
  wg.registerRepository({ name: "theirs", path: "/tmp/theirs" }, human);
  const own = ticketOn(wg, "mine");
  const victim = ticketOn(wg, "theirs");
  const a = wg.registerAgent({ display_name: "c" }, human);
  const claim = wg.claimTicket({ ticket_id: own.id, agent_id: a.id, ttl_seconds: 600 }, system);
  // The bound ticket's pack (set directly: the strict packs need more to go ready).
  wg.db.prepare("UPDATE tickets SET policy_pack = ? WHERE id = ?").run(pack, own.id);
  return { wg, own, victim, token: claim.claimToken };
}

const ticketCount = (wg: Dispatch): number =>
  (wg.db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n;

describe("F4: a ticket-bound factory mount drafts only on its ticket's write repos", () => {
  for (const mount of ["delivery", "reviewer"] as const) {
    it(`${mount}: create_ticket / create_epic on a foreign repo are refused, own repo passes`, () => {
      const { wg, own, token } = seed();
      process.env.GAFFER_FACTORY = "1";
      if (mount === "delivery") process.env.GAFFER_CLAIM_TOKEN = token;
      else process.env.GAFFER_REVIEW_TICKET = String(own.number);
      const h = makeHandlers(wg, agent);
      const before = ticketCount(wg);
      expect(code(h.create_ticket({ title: "x", repo: "theirs" }))).toBe("FACTORY_RUNNER_OWNED");
      for (const access of ["write", "read"] as const) {
        expect(
          code(
            h.create_epic({
              epic: { name: "E" },
              tickets: [
                { title: "ok", repo: "mine" },
                { title: "pwn", repo: "theirs", access },
              ],
            }),
          ),
        ).toBe("FACTORY_RUNNER_OWNED");
      }
      expect(ticketCount(wg)).toBe(before);
      expect(h.create_ticket({ title: "fine", repo: "mine" }).isError).toBeUndefined();
      expect(h.create_ticket({ title: "no repo" }).isError).toBeUndefined();
      expect(
        h.create_epic({ epic: { name: "E2" }, tickets: [{ title: "e", repo: "mine" }] }).isError,
      ).toBeUndefined();
    });
  }

  it("never under a looser policy pack than its ticket's; an omitted pack takes that floor", () => {
    const { wg, token } = seed("factory_strict");
    process.env.GAFFER_FACTORY = "1";
    process.env.GAFFER_CLAIM_TOKEN = token;
    const h = makeHandlers(wg, agent);
    for (const pack of ["solo_loose", "team_light"] as const) {
      expect(code(h.create_ticket({ title: "x", repo: "mine", policy_pack: pack }))).toBe(
        "FACTORY_RUNNER_OWNED",
      );
      expect(
        code(
          h.create_epic({
            epic: { name: "E" },
            tickets: [{ title: "x", repo: "mine", policy_pack: pack }],
          }),
        ),
      ).toBe("FACTORY_RUNNER_OWNED");
    }
    const omitted = h.create_ticket({ title: "floor", repo: "mine" });
    expect(wg.resolveTicket(omitted.structuredContent.ticket_id as string).policy_pack).toBe(
      "factory_strict",
    );
    const stricter = h.create_ticket({ title: "s", repo: "mine", policy_pack: "regulated" });
    expect(wg.resolveTicket(stricter.structuredContent.ticket_id as string).policy_pack).toBe(
      "regulated",
    );
    const epic = h.create_epic({ epic: { name: "E" }, tickets: [{ title: "e", repo: "mine" }] });
    const n = (epic.structuredContent.ticket_numbers as number[])[0]!;
    expect(wg.resolveTicket(String(n)).policy_pack).toBe("factory_strict");
  });

  it("add_dependency checks both ends", () => {
    const { wg, own, victim, token } = seed();
    process.env.GAFFER_FACTORY = "1";
    process.env.GAFFER_CLAIM_TOKEN = token;
    const h = makeHandlers(wg, agent);
    expect(code(h.add_dependency({ ticket: own.id, depends_on: victim.id }))).toBe(
      "FACTORY_RUNNER_OWNED",
    );
    expect(wg.view(own.id).dependencies).toHaveLength(0);
    // Its own draft may wait on its own ticket.
    const draft = h.create_ticket({ title: "follow-up", repo: "mine" });
    expect(
      h.add_dependency({ ticket: draft.structuredContent.ticket_id as string, depends_on: own.id })
        .isError,
    ).toBeUndefined();
  });
});

describe("F4: product-owner and planning mounts keep drafting", () => {
  it("product owner: drafts land on its repo (named or defaulted); another repo is refused", () => {
    const { wg } = seed();
    process.env.GAFFER_FACTORY = "1";
    process.env.GAFFER_DEFAULT_TICKET_REPO = "mine";
    const po = makeHandlers(wg, agent);
    const d = po.create_ticket({ title: "PO draft" });
    expect(d.isError).toBeUndefined();
    expect(wg.view(d.structuredContent.ticket_id as string).repositories[0]?.name).toBe("mine");
    expect(po.create_ticket({ title: "named", repo: "mine" }).isError).toBeUndefined();
    expect(code(po.create_ticket({ title: "x", repo: "theirs" }))).toBe("FACTORY_RUNNER_OWNED");
    expect(
      po.create_epic({
        epic: { name: "E" },
        tickets: [{ title: "a" }, { title: "b", repo: "mine" }],
      }).isError,
    ).toBeUndefined();
    expect(
      code(po.create_epic({ epic: { name: "E" }, tickets: [{ title: "a", repo: "theirs" }] })),
    ).toBe("FACTORY_RUNNER_OWNED");
  });

  it("planning (no ticket, no repo): drafts on any registered repo, as before", () => {
    const { wg } = seed();
    process.env.GAFFER_FACTORY = "1";
    const plan = makeHandlers(wg, agent);
    expect(plan.create_ticket({ title: "a", repo: "theirs" }).isError).toBeUndefined();
    expect(
      plan.create_epic({ epic: { name: "E" }, tickets: [{ title: "b", repo: "theirs" }] }).isError,
    ).toBeUndefined();
  });

  it("outside the factory, and for a person, nothing changes", () => {
    const { wg } = seed("factory_strict");
    const out = makeHandlers(wg, agent);
    expect(
      out.create_ticket({ title: "a", repo: "theirs", policy_pack: "solo_loose" }).isError,
    ).toBeUndefined();
    process.env.GAFFER_FACTORY = "1";
    expect(
      makeHandlers(wg, human).create_ticket({ title: "b", repo: "theirs" }).isError,
    ).toBeUndefined();
  });
});

describe("F4: freezing a spec is a person's act", () => {
  const clauses = [{ kind: "requirement" as const, text: "Support passkeys" }];
  it("an agent creates a draft spec but never freezes one, in or out of the factory", () => {
    const wg = Dispatch.open(":memory:", new TestClock());
    for (const factory of [false, true]) {
      if (factory) process.env.GAFFER_FACTORY = "1";
      const h = makeHandlers(wg, agent);
      const spec = h.create_spec({ title: "S", clauses });
      expect(spec.isError).toBeUndefined();
      const id = spec.structuredContent.spec_id as string;
      expect(code(h.freeze_spec({ spec_id: id }))).toBe("ACTOR_NOT_PERMITTED");
      expect(wg.getSpec(id).status).toBe("draft");
      // A person freezes it.
      expect(wg.freezeSpec(id, human).status).toBe("frozen");
    }
  });
});
