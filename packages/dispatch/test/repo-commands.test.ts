/**
 * Per-repo Definition-of-Done gate commands are editable after registration
 * (facade + CLI + POST /repos/:id/commands). Omitted keys are unchanged; null / ""
 * clears a gate; a multi-line value is refused; an event records the change.
 */
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApiServer } from "../src/api/server.js";
import { Dispatch } from "../src/core.js";
import type { Actor } from "../src/domain/types.js";
import { DispatchError } from "../src/util/errors.js";

const human: Actor = { type: "human", id: "tom" };

describe("setRepoCommands (facade)", () => {
  let d: Dispatch;
  beforeEach(() => {
    d = Dispatch.open(":memory:");
  });
  afterEach(() => d.db.close());

  it("sets, partially updates, and clears gate commands; records an event", () => {
    const repo = d.registerRepository({ name: "svc", default_branch: "main" }, human);
    const r1 = d.setRepoCommands(
      repo.id,
      { test_command: "npm test", lint_command: "npm run lint" },
      human,
    );
    expect(r1.test_command).toBe("npm test");
    expect(r1.lint_command).toBe("npm run lint");
    expect(r1.coverage_command).toBeNull();
    // Omitted keys keep their value; "" clears.
    const r2 = d.setRepoCommands("svc", { lint_command: "" }, human);
    expect(r2.test_command).toBe("npm test");
    expect(r2.lint_command).toBeNull();
    expect(d.repos.findById(repo.id)?.test_command).toBe("npm test");
    const events = d.db
      .prepare("SELECT event_type FROM work_events WHERE entity_id = ? ORDER BY rowid")
      .all(repo.id) as Array<{ event_type: string }>;
    expect(events.filter((e) => e.event_type === "repository.commands_changed")).toHaveLength(2);
  });

  it("is idempotent (no event when nothing changes) and refuses multi-line commands", () => {
    const repo = d.registerRepository(
      { name: "svc", default_branch: "main", test_command: "npm test" },
      human,
    );
    d.setRepoCommands(repo.id, { test_command: "npm test" }, human);
    const events = d.db
      .prepare(
        "SELECT event_type FROM work_events WHERE entity_id = ? AND event_type = 'repository.commands_changed'",
      )
      .all(repo.id);
    expect(events).toHaveLength(0);
    expect(() =>
      d.setRepoCommands(repo.id, { test_command: "npm test\nrm -rf /" }, human),
    ).toThrow();
    expect(() => d.setRepoCommands("nope", { test_command: "x" }, human)).toThrowError(
      DispatchError,
    );
  });
});

describe("POST /repos/:id/commands", () => {
  let d: Dispatch;
  let baseUrl: string;
  let close: () => Promise<void>;
  beforeEach(async () => {
    process.env.DISPATCH_AUDIT_OFF = "1";
    d = Dispatch.open(":memory:");
    const server = createApiServer(d);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => new Promise<void>((r) => server.close(() => r()));
  });
  afterEach(async () => {
    await close();
    d.db.close();
  });

  it("updates the commands and returns the repository", async () => {
    const repo = d.registerRepository({ name: "svc", default_branch: "main" }, human);
    const res = await fetch(`${baseUrl}/repos/${repo.id}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        test_command: "npm test",
        lint_command: "",
        coverage_command: "npm run cov",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repository: {
        test_command: string | null;
        lint_command: string | null;
        coverage_command: string | null;
      };
    };
    expect(body.repository).toMatchObject({
      test_command: "npm test",
      lint_command: null,
      coverage_command: "npm run cov",
    });
    const get = await fetch(`${baseUrl}/repos/${repo.id}/commands`);
    expect(get.status).toBe(405);
  });
});
