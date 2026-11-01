import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";

import { errorCode, runCli } from "./helpers/cli.js";

/**
 * Exploratory finding cli-wg/F-05: the runner's bookkeeping writes through the CLI
 * (`ticket repo-delivery record` on every delivery, the tokenless-resume submit and
 * the self-op un-ready `ticket move`, the bootstrap `repo link`, its own `agent
 * register`) were recorded as `human:cli` (cliActor with no $USER), so the audit trail
 * read the runner's work as a person's. Each command now takes `--as human|system`
 * (default human: unchanged for a person) and the runner passes `--as system`.
 */
const human: Actor = { type: "human", id: "tom" };
const RUNNER = join(__dirname, "../../../runner");

function lastActor(db: string, type: string): string {
  const wg = Dispatch.open(db);
  try {
    const row = wg.db
      .prepare(
        "SELECT actor_type, actor_id FROM work_events WHERE event_type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(type) as { actor_type: string; actor_id: string | null };
    return `${row.actor_type}:${row.actor_id ?? ""}`;
  } finally {
    wg.db.close();
  }
}

describe("cli-wg F-05: runner-owned CLI writes are recorded as system", () => {
  let dir: string;
  let db: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wg-runner-actor-"));
    db = join(dir, "d.sqlite");
    const wg = Dispatch.open(db);
    wg.registerRepository({ name: "svc", default_branch: "main" }, human);
    const t = wg.createTicket({ title: "x" }, human);
    wg.addAcceptanceCriterion({ ticket_id: t.id, text: "a" }, human);
    wg.db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("repo-delivery record, repo link, ticket move and agent register take --as system", () => {
    const env = { USER: "alice" };
    expect(runCli(db, ["repo", "link", "1", "svc", "--as", "system"], env).error).toBeUndefined();
    expect(lastActor(db, "ticket.repo_linked")).toBe("system:");
    expect(
      runCli(
        db,
        ["ticket", "repo-delivery", "record", "1", "svc", "--branch", "b", "--as", "system"],
        env,
      ).error,
    ).toBeUndefined();
    expect(lastActor(db, "ticket.repo_delivery_recorded")).toBe("system:");
    expect(
      runCli(db, ["ticket", "move", "1", "refining", "--as", "system"], env).error,
    ).toBeUndefined();
    expect(lastActor(db, "ticket.transitioned")).toBe("system:");
    expect(
      runCli(db, ["agent", "register", "-n", "bot", "--as", "system"], env).error,
    ).toBeUndefined();
    expect(lastActor(db, "agent.registered")).toBe("system:");
  });

  it("without --as they still act as the person ($USER), and a typo is refused", () => {
    const env = { USER: "alice" };
    runCli(db, ["repo", "link", "1", "svc"], env);
    expect(lastActor(db, "ticket.repo_linked")).toBe("human:alice");
    runCli(db, ["ticket", "repo-delivery", "record", "1", "svc", "--branch", "b"], env);
    expect(lastActor(db, "ticket.repo_delivery_recorded")).toBe("human:alice");
    expect(errorCode(runCli(db, ["repo", "link", "1", "svc", "--as", "sytem"]).error)).toBe(
      "VALIDATION_ERROR",
    );
    expect(
      errorCode(runCli(db, ["ticket", "move", "1", "refining", "--as", "system", "--admin"]).error),
    ).toBe("VALIDATION_ERROR");
  });

  it("the runner passes --as system on each of its bookkeeping writes", () => {
    const tick = readFileSync(join(RUNNER, "tick.sh"), "utf8").split("\n");
    const writes = tick.filter(
      (l) =>
        !/^\s*#/.test(l) &&
        /\bwg (ticket repo-delivery record|repo link|ticket move|agent register)\b/.test(l),
    );
    expect(writes.length).toBeGreaterThanOrEqual(8);
    for (const line of writes) expect(line, line.trim()).toMatch(/--as system\b/);
  });
});
